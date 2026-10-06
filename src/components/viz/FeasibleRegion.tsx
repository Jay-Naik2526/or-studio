import { useMemo, useRef, useState } from 'react';
import { Target } from 'lucide-react';
import { LPModel } from '../../core/types/models';
import { GraphicalLPSolver } from '../../core/solvers/lp/graphical';
import { Rational } from '../../core/math/rational';
import { Card, Callout, Badge } from '../ui/ui';
import { Q } from '../ui/Q';

interface Props { model: LPModel; onRhsChange?: (constraintIndex: number, rhs: number) => void; lattice?: boolean; title?: string }

type P = { x: number; y: number };
const num = (r: Rational) => Number(r.toDecimal(8));

function clip(poly: P[], a: number, b: number, c: number, rel: string): P[] {
  const inside = (p: P) => (rel === '<=' ? a * p.x + b * p.y <= c + 1e-9 : rel === '>=' ? a * p.x + b * p.y >= c - 1e-9 : Math.abs(a * p.x + b * p.y - c) < 1e-9);
  if (rel === '=') return poly;
  const out: P[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!, prev = poly[(i + poly.length - 1) % poly.length]!;
    const ci = inside(cur), pi = inside(prev);
    if (ci !== pi) {
      const dp = a * prev.x + b * prev.y - c, dc = a * cur.x + b * cur.y - c;
      const t = dp / (dp - dc);
      out.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
    }
    if (ci) out.push(cur);
  }
  return out;
}

function niceTicks(lo: number, hi: number, n = 6): number[] {
  const span = hi - lo;
  const raw = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map(m => m * mag).find(s => s >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function FeasibleRegion({ model, onRhsChange, lattice, title }: Props) {
  const sol = useMemo(() => GraphicalLPSolver.solve(model), [model]);
  const [iso, setIso] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const W = 560, H = 420, M = { l: 44, r: 16, t: 14, b: 34 };

  const verts = sol.vertices.map(v => ({ x: num(v.x), y: num(v.y), z: num(v.z), v }));
  const lines = sol.lines.map(l => ({ a: num(l.a), b: num(l.b), c: num(l.c), rel: l.relation, label: l.label, ci: l.constraintIndex }));
  let xmin = 0, ymin = 0, xmax = 10, ymax = 10;
  const pts: P[] = verts.map(v => ({ x: v.x, y: v.y }));
  lines.forEach(l => { if (l.a !== 0 && l.b === 0) pts.push({ x: l.c / l.a, y: 0 }); if (l.b !== 0 && l.a === 0) pts.push({ x: 0, y: l.c / l.b }); if (l.a !== 0 && l.b !== 0) { pts.push({ x: l.c / l.a, y: 0 }, { x: 0, y: l.c / l.b }); } });
  pts.forEach(p => { if (isFinite(p.x) && isFinite(p.y)) { xmax = Math.max(xmax, p.x); ymax = Math.max(ymax, p.y); xmin = Math.min(xmin, p.x); ymin = Math.min(ymin, p.y); } });
  const padX = (xmax - xmin) * 0.12, padY = (ymax - ymin) * 0.12;
  xmax += padX; ymax += padY; if (xmin < 0) xmin -= padX; if (ymin < 0) ymin -= padY;
  const X = (x: number) => M.l + ((x - xmin) / (xmax - xmin)) * (W - M.l - M.r);
  const Y = (y: number) => H - M.b - ((y - ymin) / (ymax - ymin)) * (H - M.t - M.b);
  const invX = (px: number) => xmin + ((px - M.l) / (W - M.l - M.r)) * (xmax - xmin);
  const invY = (py: number) => ymin + ((H - M.b - py) / (H - M.t - M.b)) * (ymax - ymin);

  let poly: P[] = [{ x: xmin, y: ymin }, { x: xmax, y: ymin }, { x: xmax, y: ymax }, { x: xmin, y: ymax }];
  lines.forEach(l => (poly = clip(poly, l.a, l.b, l.c, l.rel)));
  const polyPts = poly.map(p => `${X(p.x)},${Y(p.y)}`).join(' ');

  const segment = (l: (typeof lines)[number]): [P, P] | null => {
    const ends: P[] = [];
    if (l.b !== 0) { [xmin, xmax].forEach(x => { const y = (l.c - l.a * x) / l.b; if (y >= ymin - 1e-9 && y <= ymax + 1e-9) ends.push({ x, y }); }); }
    if (l.a !== 0) { [ymin, ymax].forEach(y => { const x = (l.c - l.b * y) / l.a; if (x >= xmin - 1e-9 && x <= xmax + 1e-9) ends.push({ x, y }); }); }
    const uniq = ends.filter((p, i) => ends.findIndex(q => Math.abs(q.x - p.x) < 1e-9 && Math.abs(q.y - p.y) < 1e-9) === i);
    return uniq.length >= 2 ? [uniq[0]!, uniq[1]!] : null;
  };

  const zs = verts.map(v => v.z);
  const zlo = zs.length ? Math.min(...zs) : 0, zhi = zs.length ? Math.max(...zs) : 1;
  const c1 = num(sol.objective.c1), c2 = num(sol.objective.c2);
  const isoVal = iso ?? (sol.optimalValue ? num(sol.optimalValue) : (zlo + zhi) / 2);
  const isoSeg = (c1 !== 0 || c2 !== 0) ? segment({ a: c1, b: c2, c: isoVal - num(model.objectiveConstant ?? Rational.ZERO), rel: '=', label: 'z', ci: null }) : null;
  const optPts = new Set(sol.optimalVertices.map(p => `${p.x.toString()},${p.y.toString()}`));

  const pointer = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: invX(((e.clientX - r.left) / r.width) * W), y: invY(((e.clientY - r.top) / r.height) * H) };
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current === null || !onRhsChange) return;
    const l = lines[drag.current]!;
    if (l.ci === null) return;
    const p = pointer(e);
    const raw = l.a * p.x + l.b * p.y;
    onRhsChange(l.ci, Math.round(raw * 2) / 2);
  };

  const latticePts: P[] = [];
  if (lattice) {
    const ok = (x: number, y: number) => lines.every(l => { const v = l.a * x + l.b * y; return l.rel === '<=' ? v <= l.c + 1e-9 : l.rel === '>=' ? v >= l.c - 1e-9 : Math.abs(v - l.c) < 1e-9; });
    for (let x = Math.ceil(xmin); x <= xmax && latticePts.length < 900; x++) for (let y = Math.ceil(ymin); y <= ymax && latticePts.length < 900; y++) if (ok(x, y)) latticePts.push({ x, y });
  }
  const colors = ['#3b82f6', '#e11d48', '#059669', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#65a30d'];
  const xt = niceTicks(xmin, xmax), yt = niceTicks(ymin, ymax);

  return (
    <Card title={title ?? "Graphical solution"} icon={<Target size={14} />} right={<Badge kind={sol.status === 'optimal' ? 'ok' : 'bad'}>{sol.status}</Badge>} bodyClass="p-2 sm:p-3">
      <div className="grid gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(200px,260px)]">
        <div className="flex flex-col gap-2 min-w-0">
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none touch-none" role="img" aria-label={`Feasible region with ${sol.vertices.length} corner points. ${sol.status === 'optimal' ? `Optimal value ${sol.optimalValue}.` : sol.status}`} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onPointerLeave={() => (drag.current = null)}>
            {xt.map(t => <g key={`x${t}`}><line x1={X(t)} x2={X(t)} y1={M.t} y2={H - M.b} stroke="var(--border)" strokeWidth=".6" /><text x={X(t)} y={H - M.b + 14} fontSize="10" textAnchor="middle" fill="var(--text-3)">{t}</text></g>)}
            {yt.map(t => <g key={`y${t}`}><line y1={Y(t)} y2={Y(t)} x1={M.l} x2={W - M.r} stroke="var(--border)" strokeWidth=".6" /><text y={Y(t) + 3} x={M.l - 6} fontSize="10" textAnchor="end" fill="var(--text-3)">{t}</text></g>)}
            <line x1={X(0)} x2={X(0)} y1={M.t} y2={H - M.b} stroke="var(--border-strong)" /><line y1={Y(0)} y2={Y(0)} x1={M.l} x2={W - M.r} stroke="var(--border-strong)" />
            <text x={W - M.r} y={Y(0) - 4} fontSize="11" textAnchor="end" fill="var(--text-2)" fontWeight="600">{model.varNames[0]}</text>
            <text x={X(0) + 5} y={M.t + 8} fontSize="11" fill="var(--text-2)" fontWeight="600">{model.varNames[1]}</text>
            {poly.length >= 3 && sol.status !== 'infeasible' && <polygon points={polyPts} fill="var(--accent-soft)" stroke="var(--series)" strokeWidth="1.6" fillOpacity=".85" />}
            {lines.map((l, i) => {
              const s = segment(l);
              if (!s) return null;
              const col = l.ci === null ? 'var(--text-3)' : colors[l.ci % colors.length]!;
              const mid = { x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 };
              return (
                <g key={i} opacity={hover === null || hover === i ? 1 : 0.4}>
                  <line x1={X(s[0].x)} y1={Y(s[0].y)} x2={X(s[1].x)} y2={Y(s[1].y)} stroke={col} strokeWidth={l.ci === null ? 1 : 2} strokeDasharray={l.ci === null ? '4 3' : l.rel === '=' ? '0' : '0'} />
                  {l.ci !== null && (
                    <g style={{ cursor: onRhsChange ? 'grab' : 'default' }} onPointerDown={e => { drag.current = i; (e.target as Element).setPointerCapture?.(e.pointerId); }} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                      <circle cx={X(mid.x)} cy={Y(mid.y)} r="6" fill={col} stroke="var(--surface)" strokeWidth="1.5" />
                      <title>{l.label} — drag to change its right-hand side</title>
                    </g>
                  )}
                </g>
              );
            })}
            {isoSeg && sol.status !== 'infeasible' && <line x1={X(isoSeg[0].x)} y1={Y(isoSeg[0].y)} x2={X(isoSeg[1].x)} y2={Y(isoSeg[1].y)} stroke="var(--leaving)" strokeWidth="2" strokeDasharray="7 4" />}
            {lattice && latticePts.map((p, i) => <circle key={`lp${i}`} cx={X(p.x)} cy={Y(p.y)} r="2.4" fill="var(--text-2)" opacity=".75" />)}
            {verts.map((v, i) => {
              const opt = optPts.has(`${v.v.x.toString()},${v.v.y.toString()}`);
              return (
                <g key={i}>
                  {opt ? <path d={`M ${X(v.x)} ${Y(v.y) - 8} l 2.4 5.6 l 6 .6 l -4.5 4 l 1.4 6 l -5.3 -3.2 l -5.3 3.2 l 1.4 -6 l -4.5 -4 l 6 -.6 z`} fill="var(--leaving)" stroke="var(--surface)" strokeWidth="1" /> : <circle cx={X(v.x)} cy={Y(v.y)} r="4" fill="var(--surface)" stroke="var(--series)" strokeWidth="2" />}
                  <text x={X(v.x) + 8} y={Y(v.y) - 6} fontSize="10" fill="var(--text)" className="mono">({Number(v.x.toFixed(2))}, {Number(v.y.toFixed(2))})</text>
                </g>
              );
            })}
          </svg>
          <div className="flex items-center gap-2 text-xs">
            <span className="legend-dot" style={{ background: 'var(--leaving)' }} /><span className="muted whitespace-nowrap">iso-profit z =</span>
            <input className="range" type="range" min={zlo - Math.abs(zhi - zlo) * 0.4 - 1} max={zhi + Math.abs(zhi - zlo) * 0.4 + 1} step={Math.max(0.01, (zhi - zlo) / 200)} value={isoVal} onChange={e => setIso(Number(e.target.value))} aria-label="Objective line level" />
            <span className="mono w-16 text-right">{Number(isoVal.toFixed(2))}</span>
          </div>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
            {lines.filter(l => l.ci !== null).map(l => <li key={l.ci}><span className="legend-dot" style={{ background: colors[l.ci! % colors.length] }} />{l.label}: {l.a}x₁ + {l.b}x₂ {l.rel === '<=' ? '≤' : l.rel === '>=' ? '≥' : '='} {l.c}</li>)}
          </ul>
          {onRhsChange && <p className="text-[13px] muted">Drag a coloured handle to move a constraint; the region, vertices and optimum update exactly.</p>}
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          {sol.messages.map((m, i) => <Callout key={i} kind={sol.status === 'optimal' ? 'info' : 'warn'}>{m}</Callout>)}
          <div className="overflow-x-auto">
            <table className="tbl text-xs" aria-label="Corner points">
              <thead><tr><th scope="col">Vertex</th><th scope="col">z</th><th scope="col">Binding</th></tr></thead>
              <tbody>
                {sol.vertices.map((v, i) => (
                  <tr key={i} className={v.isOptimal ? 'opt' : ''}>
                    <th scope="row">(<Q v={v.x} />, <Q v={v.y} />){v.isOptimal && ' ★'}</th>
                    <td className={v.isOptimal ? 'opt' : ''}><Q v={v.z} /></td>
                    <td className="text-[12px]">{v.binding.map(b => (sol.lines[b]!.constraintIndex !== null ? `C${sol.lines[b]!.constraintIndex! + 1}` : sol.lines[b]!.label.replace(/x/g, 'x'))).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sol.status === 'optimal' && <p className="text-[0.82rem]">Optimum ★ at (<Q v={sol.optimalVertex!.x} />, <Q v={sol.optimalVertex!.y} />) with z = <b><Q v={sol.optimalValue} /></b>. Binding: {sol.bindingConstraints.map(i => model.constraints[i]?.name ?? `C${i + 1}`).join(', ') || 'bounds only'}.</p>}
        </div>
      </div>
    </Card>
  );
}
