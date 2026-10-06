import { useEffect, useRef, useState } from 'react';
import { GraphSpec } from '../../data/specs';
import { GraphState } from '../../core/types/models';
import { Highlight } from '../../core/types/step';
import { Rational } from '../../core/math/rational';

export type Tool = 'select' | 'node' | 'edge' | 'delete';

interface Props {
  spec: GraphSpec;
  onChange?: (g: GraphSpec) => void;
  tool?: Tool;
  state?: GraphState;
  highlights?: Highlight[];
  /** show capacities instead of weights, with flows overlaid */
  flowMode?: boolean;
  /** show "directed" arrows even for undirected edges */
  height?: number;
}

const W = 640, H = 380, R = 20;

export function GraphCanvas({ spec, onChange, tool = 'select', state, highlights = [], flowMode, height }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const editable = !!onChange;
  useEffect(() => { setFrom(null); }, [tool]);
  const pos = (id: string) => spec.nodes.find(n => n.id === id)!;
  const hl = (t: string) => highlights.find(h => h.target === t)?.intent;
  const pt = (e: React.PointerEvent) => { const r = svg.current!.getBoundingClientRect(); return { x: Math.max(R, Math.min(W - R, ((e.clientX - r.left) / r.width) * W)), y: Math.max(R, Math.min(H - R, ((e.clientY - r.top) / r.height) * H)) }; };
  const nextId = () => { let k = spec.nodes.length + 1; while (spec.nodes.some(n => n.id === String(k))) k++; return String(k); };

  // parallel-edge curvature
  const groups = new Map<string, string[]>();
  spec.edges.forEach(e => { const k = [e.from, e.to].sort().join('|'); groups.set(k, [...(groups.get(k) ?? []), e.id]); });

  const edgePath = (e: GraphSpec['edges'][number]) => {
    const a = pos(e.from), b = pos(e.to);
    if (!a || !b || e.from === e.to) return null;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const g = groups.get([e.from, e.to].sort().join('|'))!;
    const k = g.indexOf(e.id) - (g.length - 1) / 2;
    const bend = k * 34 * (e.from < e.to ? 1 : -1);
    const mx = (a.x + b.x) / 2 - uy * bend, my = (a.y + b.y) / 2 + ux * bend;
    // trim to node borders
    const sx = a.x + ux * R, sy = a.y + uy * R, ex = b.x - ux * (R + (e.directed ? 5 : 0)), ey = b.y - uy * (R + (e.directed ? 5 : 0));
    return { d: `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`, lx: (sx + 2 * mx + ex) / 4, ly: (sy + 2 * my + ey) / 4, ex, ey, ang: Math.atan2(ey - my, ex - mx) };
  };

  const onCanvas = (e: React.PointerEvent) => {
    if (!editable || tool !== 'node' || (e.target as Element).closest('[data-node]')) return;
    const p = pt(e);
    const id = nextId();
    onChange!({ ...spec, nodes: [...spec.nodes, { id, label: id, x: Math.round(p.x), y: Math.round(p.y) }] });
  };
  const nodeDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (!editable) return;
    if (tool === 'select') { setDrag(id); (e.currentTarget as Element).setPointerCapture(e.pointerId); }
    else if (tool === 'delete') onChange!({ ...spec, nodes: spec.nodes.filter(n => n.id !== id), edges: spec.edges.filter(x => x.from !== id && x.to !== id), source: spec.source === id ? '' : spec.source, sink: spec.sink === id ? '' : spec.sink, sources: spec.sources.filter(s => s !== id), sinks: spec.sinks.filter(s => s !== id) });
    else if (tool === 'edge') {
      if (!from) setFrom(id);
      else if (from !== id) {
        let k = spec.edges.length + 1; while (spec.edges.some(x => x.id === `e${k}`)) k++;
        onChange!({ ...spec, edges: [...spec.edges, { id: `e${k}`, from, to: id, weight: '1', capacity: '1', directed: false }] });
        setFrom(null);
      } else setFrom(null);
    }
  };
  const move = (e: React.PointerEvent) => { if (!drag || !editable) return; const p = pt(e); onChange!({ ...spec, nodes: spec.nodes.map(n => (n.id === drag ? { ...n, x: Math.round(p.x), y: Math.round(p.y) } : n)) }); };

  const sel = new Set(state?.selectedEdges ?? []);
  const rej = new Set(state?.rejectedEdges ?? []);
  const pathNodes = new Set(state?.currentPath ?? []);
  const cut = new Set(state?.cutEdges ?? []);
  const sides = new Set(state?.sourceSide ?? []);

  return (
    <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="w-full touch-none select-none" style={{ height: height ?? 'auto', background: 'var(--bg)', border: '1px solid var(--border)', cursor: tool === 'node' ? 'crosshair' : 'default' }} role="img" aria-label={`Network with ${spec.nodes.length} nodes and ${spec.edges.length} edges`} onPointerDown={onCanvas} onPointerMove={move} onPointerUp={() => setDrag(null)}>
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke" /></marker>
      </defs>
      {spec.edges.map(e => {
        const p = edgePath(e);
        if (!p) return null;
        const flow = state?.flows?.[e.id];
        const cap = parse(e.capacity);
        const isSel = sel.has(e.id) || hl(`edge:${e.id}`) === 'optimal';
        const isChanged = hl(`edge:${e.id}`) === 'changed' || hl(`edge:${e.id}`) === 'candidate';
        const isCut = cut.has(e.id);
        const isRej = rej.has(e.id) || hl(`edge:${e.id}`) === 'blocked';
        const saturated = flow && cap && flow.eq(cap);
        const color = isCut ? 'var(--bad)' : isChanged ? 'var(--leaving)' : isSel ? 'var(--ok)' : isRej ? 'var(--bad)' : flowMode && flow && !flow.isZero() ? (saturated ? 'var(--text)' : 'var(--entering)') : 'var(--text-3)';
        const w = isSel || isChanged || isCut ? 3.4 : 1.8;
        const label = flowMode ? `${flow ? flow.toString() : '0'}/${e.capacity}` : e.weight;
        return (
          <g key={e.id} onPointerDown={ev => { if (editable && tool === 'delete') { ev.stopPropagation(); onChange!({ ...spec, edges: spec.edges.filter(x => x.id !== e.id) }); } }} style={{ cursor: editable && tool === 'delete' ? 'pointer' : 'default' }}>
            <path d={p.d} fill="none" stroke="transparent" strokeWidth="14" />
            <path d={p.d} fill="none" stroke={color} strokeWidth={w} strokeDasharray={isRej || isCut ? '6 4' : undefined} markerEnd={e.directed ? 'url(#arr)' : undefined} />
            <g transform={`translate(${p.lx} ${p.ly})`}>
              <rect x={-Math.max(11, label.length * 4.3 + 5)} y="-10" width={Math.max(22, label.length * 8.6 + 10)} height="20" rx="2" fill="var(--surface)" stroke={color} strokeWidth="1" />
              <text textAnchor="middle" y="5" fontSize="13.5" className="mono" fontWeight="700" fill="var(--text)">{label}</text>
            </g>
          </g>
        );
      })}
      {spec.nodes.map(n => {
        const lab = state?.nodeLabels?.[n.id];
        const perm = lab?.permanent;
        const isSrc = spec.source === n.id || spec.sources.includes(n.id), isSnk = spec.sink === n.id || spec.sinks.includes(n.id);
        const intent = hl(`node:${n.id}`);
        const inPath = pathNodes.has(n.id);
        const fill = perm ? 'var(--ok-soft)' : intent === 'entering' ? 'var(--entering-soft)' : intent === 'blocked' ? 'var(--bad-soft)' : sides.has(n.id) ? 'var(--hl)' : 'var(--surface)';
        const stroke = from === n.id ? 'var(--focus)' : inPath ? 'var(--text)' : perm ? 'var(--ok)' : intent === 'entering' ? 'var(--entering)' : 'var(--text-2)';
        return (
          <g key={n.id} data-node transform={`translate(${n.x} ${n.y})`} onPointerDown={e => nodeDown(e, n.id)} style={{ cursor: editable ? (tool === 'select' ? 'grab' : 'pointer') : 'default' }} tabIndex={editable ? 0 : -1} role="img" aria-label={`Node ${n.label}${isSrc ? ' source' : ''}${isSnk ? ' sink' : ''}${lab?.value ? `, label ${lab.value.toString()}` : ''}`}>
            <circle r={R} fill={fill} stroke={stroke} strokeWidth={inPath || perm || from === n.id ? 3 : 1.8} />
            {isSnk && <circle r={R - 4} fill="none" stroke={stroke} strokeWidth="1.2" />}
            <text textAnchor="middle" y="5" fontSize="15" fontWeight="800" fill="var(--text)">{n.label}</text>
            {isSrc && <text y={-R - 5} textAnchor="middle" fontSize="11.5" fontWeight="800" fill="var(--entering)">SOURCE</text>}
            {isSnk && <text y={-R - 5} textAnchor="middle" fontSize="11.5" fontWeight="800" fill="var(--entering)">SINK</text>}
            {lab && lab.value !== undefined && (
              <g transform={`translate(0 ${R + 13})`}><rect x="-18" y="-11" width="36" height="17" rx="2" fill="var(--surface)" stroke={perm ? 'var(--ok)' : 'var(--border-strong)'} /><text textAnchor="middle" fontSize="12.5" className="mono" fontWeight="700" fill="var(--text)" y="2">{lab.value === null ? '∞' : lab.value.toString()}{perm ? '■' : ''}</text></g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function parse(s: string): Rational | null { try { return s.trim() === '' ? null : Rational.parse(s.trim()); } catch { return null; } }
