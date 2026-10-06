import { useMemo, useRef, useState, useEffect } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Network } from 'lucide-react';
import { BBState, BBNode } from '../../core/types/models';
import { Card, Btn, Badge } from '../ui/ui';
import { Q } from '../ui/Q';

interface Props { state: BBState; varNames: string[]; focus?: number | null }

interface Pos { id: number; x: number; y: number; node: BBNode }

const NW = 142, NH = 58, GX = 22, GY = 56;

function layout(nodes: BBNode[]): { pos: Map<number, Pos>; w: number; h: number } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const pos = new Map<number, Pos>();
  let leaf = 0;
  const visit = (id: number, depth: number): number => {
    const n = byId.get(id)!;
    const kids = n.children.filter(c => byId.has(c));
    let x: number;
    if (!kids.length) { x = leaf * (NW + GX); leaf++; }
    else { const xs = kids.map(c => visit(c, depth + 1)); x = (xs[0]! + xs[xs.length - 1]!) / 2; }
    pos.set(id, { id, x, y: depth * (NH + GY), node: n });
    return x;
  };
  if (byId.has(0)) visit(0, 0);
  const maxD = Math.max(0, ...nodes.map(n => n.depth));
  return { pos, w: Math.max(1, leaf) * (NW + GX), h: (maxD + 1) * (NH + GY) };
}

const statusStyle = (n: BBNode, isInc: boolean) => {
  if (isInc) return { fill: 'var(--ok-soft)', stroke: 'var(--ok)', icon: '★', label: 'incumbent' };
  switch (n.status) {
    case 'integer-feasible': return { fill: 'var(--ok-soft)', stroke: 'var(--ok)', icon: '✓', label: 'integer solution' };
    case 'pruned-bound': return { fill: 'var(--warn-soft)', stroke: 'var(--warn)', icon: '✂', label: 'pruned by bound' };
    case 'pruned-infeasible': return { fill: 'var(--bad-soft)', stroke: 'var(--bad)', icon: '⊘', label: 'infeasible' };
    case 'solved': return { fill: 'var(--accent-soft)', stroke: 'var(--series)', icon: '◆', label: 'branched' };
    default: return { fill: 'var(--surface-2)', stroke: 'var(--border-strong)', icon: '…', label: 'open' };
  }
};

export function BBTree({ state, varNames, focus }: Props) {
  const { pos, w, h } = useMemo(() => layout(state.nodes), [state.nodes]);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [sel, setSel] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const W = 760, H = Math.min(520, Math.max(260, h + 30));
  const fit = () => { const k = Math.min(1, (W - 20) / Math.max(w, 1), (H - 20) / Math.max(h, 1)); setView({ k, x: (W - w * k) / 2, y: 10 }); };
  useEffect(() => { fit(); }, [state.nodes.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = focus ?? state.activeNodeId;
  const selNode = sel !== null ? state.nodes.find(n => n.id === sel) : active !== null && active !== undefined ? state.nodes.find(n => n.id === active) : undefined;
  const incId = state.incumbent ? [...state.nodes].reverse().find(n => n.status === 'integer-feasible' && n.relaxation && n.relaxation.objective.eq(state.incumbent!.objective))?.id : undefined;

  return (
    <Card title="Branch & bound tree" icon={<Network size={14} />} right={
      <span className="flex items-center gap-1">
        <Btn size="icon" aria-label="Zoom in" onClick={() => setView(v => ({ ...v, k: Math.min(3, v.k * 1.25) }))}><ZoomIn size={13} /></Btn>
        <Btn size="icon" aria-label="Zoom out" onClick={() => setView(v => ({ ...v, k: Math.max(0.2, v.k / 1.25) }))}><ZoomOut size={13} /></Btn>
        <Btn size="icon" aria-label="Fit tree" onClick={fit}><Maximize2 size={13} /></Btn>
      </span>
    } bodyClass="p-0">
      <div ref={wrap} className="overflow-hidden rounded-b-[10px] touch-none" style={{ background: 'var(--bg)' }}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto cursor-grab select-none" role="img" aria-label={`Branch and bound tree with ${state.nodes.length} nodes`}
          onWheel={e => { e.preventDefault(); const f = e.deltaY < 0 ? 1.1 : 1 / 1.1; setView(v => ({ ...v, k: Math.max(0.2, Math.min(3, v.k * f)) })); }}
          onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; (e.currentTarget as SVGElement).setPointerCapture(e.pointerId); }}
          onPointerMove={e => { if (!drag.current) return; const r = (e.currentTarget as SVGElement).getBoundingClientRect(); const s = W / r.width; setView(v => ({ ...v, x: drag.current!.vx + (e.clientX - drag.current!.x) * s, y: drag.current!.vy + (e.clientY - drag.current!.y) * s })); }}
          onPointerUp={() => (drag.current = null)}>
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {[...pos.values()].flatMap(p => p.node.children.filter(c => pos.has(c)).map(c => {
              const q = pos.get(c)!;
              return (
                <g key={`${p.id}-${c}`}>
                  <path d={`M ${p.x + NW / 2} ${p.y + NH} C ${p.x + NW / 2} ${p.y + NH + GY / 2}, ${q.x + NW / 2} ${q.y - GY / 2}, ${q.x + NW / 2} ${q.y}`} fill="none" stroke="var(--border-strong)" strokeWidth="1.5" />
                  <text x={(p.x + q.x) / 2 + NW / 2} y={(p.y + NH + q.y) / 2 + 3} textAnchor="middle" fontSize="12" fill="var(--text-2)" className="mono" stroke="var(--bg)" strokeWidth="3" paintOrder="stroke">{q.node.branchLabel}</text>
                </g>
              );
            }))}
            {[...pos.values()].map(p => {
              const st = statusStyle(p.node, p.id === incId && state.activeNodeId === null ? true : p.node.isIncumbent === true);
              const isActive = p.id === active;
              const rel = p.node.relaxation;
              return (
                <g key={p.id} transform={`translate(${p.x} ${p.y})`} onClick={e => { e.stopPropagation(); setSel(p.id); }} style={{ cursor: 'pointer' }} tabIndex={0} role="button" aria-label={`Node ${p.id}: ${st.label}${rel ? `, bound ${rel.objective.toString()}` : ''}`} onKeyDown={e => { if (e.key === 'Enter') setSel(p.id); }}>
                  <rect width={NW} height={NH} rx="9" fill={st.fill} stroke={isActive ? 'var(--leaving)' : st.stroke} strokeWidth={isActive ? 3 : 1.5} />
                  <text x="9" y="18" fontSize="13" fontWeight="800" fill="var(--text)">{st.icon} Node {p.id}</text><title>{st.label}</title>
                  <text x="9" y="36" fontSize="13" fill="var(--text)" className="mono">{rel ? `z = ${rel.objective.toDecimal(3)}` : '—'}</text>
                  <text x="9" y="51" fontSize="11" fill="var(--text-2)" className="mono">{rel ? rel.values.map((v, j) => `${varNames[j]}=${v.isInteger() ? v.toString() : v.toDecimal(2)}`).join(' ').slice(0, 24) : ''}</text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div className="p-3 flex flex-col gap-2 text-xs">
        <div className="flex flex-wrap gap-3 items-center">
          <span><span className="legend-dot" style={{ background: 'var(--accent-soft)', border: '1px solid var(--series)' }} />◆ branched</span>
          <span><span className="legend-dot" style={{ background: 'var(--ok-soft)', border: '1px solid var(--ok)' }} />✓ integer / ★ incumbent</span>
          <span><span className="legend-dot" style={{ background: 'var(--warn-soft)', border: '1px solid var(--warn)' }} />✂ pruned by bound</span>
          <span><span className="legend-dot" style={{ background: 'var(--bad-soft)', border: '1px solid var(--bad)' }} />⊘ infeasible</span>
          <span className="muted">Drag to pan · scroll to zoom · click a node</span>
        </div>
        {selNode && (
          <div className="callout callout-info">
            <div>
              <b>Node {selNode.id}</b>{selNode.branchLabel && <> ({selNode.branchLabel})</>} · depth {selNode.depth} {selNode.processedOrder !== undefined && <Badge>processed #{selNode.processedOrder + 1}</Badge>}
              {selNode.relaxation ? <div className="mono mt-1">z = <Q v={selNode.relaxation.objective} /> · {selNode.relaxation.values.map((v, j) => <span key={j} className="mr-2">{varNames[j]} = <Q v={v} /></span>)}</div> : <div className="mt-1 muted">Not solved yet (open node).</div>}
              {selNode.branchVariable !== undefined && <div className="mt-1">Branched on {varNames[selNode.branchVariable]} = <Q v={selNode.branchValue!} /></div>}
              {selNode.pruneReason && <div className="mt-1">{selNode.pruneReason}</div>}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
