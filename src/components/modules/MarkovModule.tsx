import { useEffect, useMemo, useRef, useState } from 'react';
import { Shuffle, Workflow, TrendingUp } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { SavedModel } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { solveMarkovChain, MarkovResult } from '../../core/solvers/markov/markov';
import { libraryFor } from '../../data/library';
import { MarkovSpec } from '../../data/specs';
import { parseNum } from '../../lib/numbers';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { MatrixEditor } from '../input/MatrixEditor';
import { Card, Callout, StatusBanner, Badge, Field } from '../ui/ui';
import { Q } from '../ui/Q';
import { useInitial, useSaved } from './common';

const DEFAULT = libraryFor('markov')[0]!.spec as MarkovSpec;
const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#9c36b5', '#e03131', '#0c8599', '#f08c00', '#5c7cfa'];

function Diagram({ r }: { r: MarkovResult }) {
  const n = r.size, W = 520, H = 360, cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 62;
  const pos = Array.from({ length: n }, (_, i) => ({ x: n === 1 ? cx : cx + R * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), y: n === 1 ? cy : cy + R * Math.sin((2 * Math.PI * i) / n - Math.PI / 2) }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="State transition diagram">
      <defs><marker id="mk" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="context-stroke" /></marker></defs>
      {r.matrix.flatMap((row, i) => row.map((p, j) => {
        if (p.isZero()) return null;
        const a = pos[i]!, b = pos[j]!;
        const w = 1 + Number(p.toDecimal(4)) * 4;
        if (i === j) return <g key={`${i}-${j}`}><path d={`M ${a.x - 8} ${a.y - 22} C ${a.x - 40} ${a.y - 70}, ${a.x + 40} ${a.y - 70}, ${a.x + 8} ${a.y - 22}`} fill="none" stroke={COLORS[i % 8]} strokeWidth={w} markerEnd="url(#mk)" /><text x={a.x} y={a.y - 62} fontSize="13" textAnchor="middle" className="mono" fontWeight="700" fill="var(--text)">{p.toString()}</text></g>;
        const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
        const bend = 22, mx = (a.x + b.x) / 2 - uy * bend, my = (a.y + b.y) / 2 + ux * bend;
        return <g key={`${i}-${j}`}><path d={`M ${a.x + ux * 24} ${a.y + uy * 24} Q ${mx} ${my} ${b.x - ux * 27} ${b.y - uy * 27}`} fill="none" stroke={COLORS[i % 8]} strokeWidth={w} markerEnd="url(#mk)" opacity=".9" /><text x={(a.x + 2 * mx + b.x) / 4} y={(a.y + 2 * my + b.y) / 4 - 3} fontSize="12" textAnchor="middle" className="mono" fontWeight="700" fill="var(--text)" stroke="var(--surface)" strokeWidth="3" paintOrder="stroke">{p.toString()}</text></g>;
      }))}
      {pos.map((p, i) => <g key={i} transform={`translate(${p.x} ${p.y})`}><circle r="23" fill="var(--surface)" stroke={COLORS[i % 8]} strokeWidth="3" /><text textAnchor="middle" y="5" fontSize="13" fontWeight="800" fill="var(--text)">{r.names[i]!.slice(0, 6)}</text>{r.absorbing?.absorbingStates.includes(i) && <circle r="28" fill="none" stroke={COLORS[i % 8]} strokeWidth="1.5" />}</g>)}
    </svg>
  );
}

export default function MarkovModule() {
  const init = useInitial<MarkovSpec>('markov', DEFAULT);
  const [spec, setSpec] = useState<MarkovSpec>(init.spec);
  const [frame, setFrame] = useState(0);
  const [play, setPlay] = useState(false);
  const pngRef = useRef<HTMLElement | null>(null);
  const { model, error, n } = useMemo(() => {
    const P: Rational[][] = [];
    for (const [i, r] of spec.P.entries()) { const row: Rational[] = []; for (const [j, c] of r.entries()) { const v = parseNum(c); if (!v.ok) return { model: null, error: `P(${spec.names[i]}→${spec.names[j]}): ${v.error === 'empty' ? 'missing' : v.error}`, n: 5 }; row.push(v.value); } P.push(row); }
    const init0 = spec.init.map(s => parseNum(s));
    const hasInit = init0.every(x => x.ok) && init0.length === spec.names.length && spec.init.some(s => s.trim() !== '');
    return { model: { transitionMatrix: P, stateNames: spec.names, initialDistribution: hasInit ? init0.map(x => (x as { ok: true; value: Rational }).value) : undefined }, error: null, n: Math.max(1, Math.min(60, Math.floor(Number(spec.n) || 5))) };
  }, [spec]);
  const res = useMemo(() => (model ? solveMarkovChain(model, n) : null), [model, n]);
  const saved = useSaved('markov', spec);
  const traj = res?.trajectory;
  useEffect(() => { if (!play) return; if (!traj || frame >= traj.length - 1) { setPlay(false); return; } const t = setTimeout(() => setFrame(f => f + 1), 600); return () => clearTimeout(t); }, [play, frame, traj]);
  const chart = useMemo(() => (traj ?? []).map((d, k) => ({ step: k, ...Object.fromEntries(d.map((v, i) => [res!.names[i]!, Number(v.toDecimal(5))])) })), [traj, res]);
  const set = (p: Partial<MarkovSpec>) => setSpec(s => ({ ...s, ...p }));
  const rowSum = (r: string[]) => { let s = Rational.ZERO; for (const c of r) { const v = parseNum(c); if (!v.ok) return null; s = s.add(v.value); } return s; };

  const buildReport = () => (!res || res.error ? null : { title: 'Markov chain', module: 'Markov chains', problem: `States: ${spec.names.join(', ')}\nP =\n${spec.P.map(r => '  ' + r.join('\t')).join('\n')}`, steps: res.steps.map(s => ({ title: s.title, short: s.explanation, table: s.matrixData ? { headers: ['', ...res.names], rows: s.matrixData.map((r, i) => [res.names[i] ?? String(i + 1), ...r.map(v => v.toString())]) } : undefined })), result: { heading: 'Results', lines: [res.steadyState ? `Steady state π = (${res.steadyState.distribution.map(String).join(', ')})` : 'No steady state computed', `Classes: ${res.classes.map(c => `{${c.states.map(s => res.names[s]).join(', ')}}${c.closed ? ' closed' : ' transient'}`).join('; ')}`] }, diagnostics: res.diagnostics.map(d => `[${d.code}] ${d.message}`) });

  const tabs = [
    { id: 'result', label: <><Shuffle size={14} /> Analysis</>, node: <>
      {error && <Callout kind="bad">{error}</Callout>}
      {res?.error && <Callout kind="bad" title="Not a valid transition matrix">{res.error}</Callout>}
      {res && !res.error && <>
        {res.diagnostics.map((d, i) => <Callout key={i} kind={d.severity === 'warning' ? 'warn' : 'info'}>{d.message}</Callout>)}
        <Card title="Classification" right={<><Badge kind={res.irreducible ? 'ok' : 'default'}>{res.irreducible ? 'irreducible' : 'reducible'}</Badge>{res.periodic && <Badge kind="warn">period {res.period}</Badge>}</>}>
          <ul className="flex flex-col gap-1.5 text-[0.98rem]">{res.classes.map((c, i) => <li key={i}><b>{'{'}{c.states.map(s => res.names[s]).join(', ')}{'}'}</b> — {c.closed ? (c.states.length === 1 && res.matrix[c.states[0]!]![c.states[0]!]!.isZero() === false && res.matrix[c.states[0]!]![c.states[0]!]!.eq(Rational.ONE) ? 'absorbing' : `closed (recurrent), period ${c.period}`) : 'transient (the chain eventually leaves)'}</li>)}</ul>
        </Card>
        {res.steadyState && <Card title="Steady state π" right={<Badge kind={res.steadyState.limiting ? 'ok' : 'warn'}>{res.steadyState.limiting ? 'limiting distribution' : 'stationary only'}</Badge>}>
          {res.steadyState.distribution.map((p, i) => <div key={i} className="flex items-center gap-3 mb-2"><span className="w-24 font-semibold truncate">{res.names[i]}</span><div className="flex-1 h-5" style={{ background: 'var(--surface-3)' }}><div style={{ width: `${Number(p.toDecimal(4)) * 100}%`, height: '100%', background: COLORS[i % 8] }} /></div><span className="mono w-28 text-right"><Q v={p} dec /></span></div>)}
          <p className="text-sm muted mt-2">{res.steadyState.note}</p>
        </Card>}
        {res.nStep && <Card title={`P^${res.nStep.n} — n-step transition probabilities`} bodyClass="p-2"><div className="overflow-x-auto"><table className="tbl"><thead><tr><th scope="col" className="rowhead">from \ to</th>{res.names.map(nm => <th key={nm} scope="col">{nm}</th>)}</tr></thead><tbody>{res.nStep.matrix.map((r, i) => <tr key={i}><th scope="row">{res.names[i]}</th>{r.map((v, j) => <td key={j} style={{ background: `color-mix(in srgb, var(--accent) ${Math.round(Number(v.toDecimal(4)) * 45)}%, transparent)` }}><Q v={v} /></td>)}</tr>)}</tbody></table></div>{res.nStep.distribution && <p className="px-2 pt-3 text-[0.95rem]">Distribution after {res.nStep.n} steps: {res.names.map((nm, i) => <span key={i} className="mr-3 mono">{nm} = <Q v={res.nStep!.distribution![i]!} dec /></span>)}</p>}</Card>}
        {res.absorbing && res.absorbing.fundamental && <Card title="Absorbing chain" bodyClass="p-2"><div className="grid md:grid-cols-2 gap-4"><div><div className="eyebrow mb-1">Fundamental matrix N = (I − Q)⁻¹</div><div className="overflow-x-auto"><table className="tbl"><thead><tr><th scope="col" />{res.absorbing.transientStates.map(s => <th key={s} scope="col">{res.names[s]}</th>)}<th scope="col">steps</th></tr></thead><tbody>{res.absorbing.fundamental.map((r, i) => <tr key={i}><th scope="row">{res.names[res.absorbing!.transientStates[i]!]}</th>{r.map((v, j) => <td key={j}><Q v={v} /></td>)}<td className="font-bold"><Q v={res.absorbing!.expectedSteps![i]!} /></td></tr>)}</tbody></table></div></div><div><div className="eyebrow mb-1">Absorption probabilities B = N·R</div><div className="overflow-x-auto"><table className="tbl"><thead><tr><th scope="col" />{res.absorbing.absorbingStates.map(s => <th key={s} scope="col">{res.names[s]}</th>)}</tr></thead><tbody>{res.absorbing.absorptionProbabilities!.map((r, i) => <tr key={i}><th scope="row">{res.names[res.absorbing!.transientStates[i]!]}</th>{r.map((v, j) => <td key={j}><Q v={v} dec /></td>)}</tr>)}</tbody></table></div></div></div></Card>}
        {res.firstPassage && <Card title="Mean first-passage times mᵢⱼ" bodyClass="p-2"><div className="overflow-x-auto"><table className="tbl"><thead><tr><th scope="col" className="rowhead">from \ to</th>{res.names.map(nm => <th key={nm} scope="col">{nm}</th>)}</tr></thead><tbody>{res.firstPassage.map((r, i) => <tr key={i}><th scope="row">{res.names[i]}</th>{r.map((v, j) => <td key={j} className={i === j ? 'zrow' : ''}><Q v={v} dec /></td>)}</tr>)}</tbody></table></div><p className="text-sm muted px-2 pt-2">Diagonal entries (shaded) are mean recurrence times 1/πⱼ.</p></Card>}
      </>}
    </> },
    { id: 'diagram', label: <><Workflow size={14} /> Diagram</>, node: res && !res.error ? <Card title="State transition diagram" bodyClass="p-2"><Diagram r={res} /></Card> : null },
    { id: 'conv', hidden: !traj, label: <><TrendingUp size={14} /> Convergence</>, node: traj && res ? <Card title="Distribution over time" right={<span className="flex gap-1"><button className="btn btn-sm" onClick={() => { setFrame(0); setPlay(true); }}>▶ Animate</button></span>} bodyClass="p-3">
      <div style={{ height: 280 }}><ResponsiveContainer><LineChart data={chart.slice(0, frame + 1)} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="step" type="number" domain={[0, chart.length - 1]} tick={{ fontSize: 12, fill: 'var(--text-3)' }} label={{ value: 'step n', position: 'insideBottomRight', fontSize: 12, fill: 'var(--text-3)' }} /><YAxis domain={[0, 1]} tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={40} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Legend />{res.names.map((nm, i) => <Line key={nm} dataKey={nm} stroke={COLORS[i % 8]} strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} />)}</LineChart></ResponsiveContainer></div>
      <div className="flex items-center gap-3 px-2"><input className="range" type="range" min={0} max={chart.length - 1} value={frame} onChange={e => setFrame(Number(e.target.value))} aria-label="Step" /><span className="mono text-sm w-16">n = {frame}</span></div>
      <p className="text-sm muted px-2 pt-2">{res.steadyState?.limiting ? 'The lines flatten onto the steady-state probabilities.' : res.periodic ? 'A periodic chain oscillates and never settles.' : ''}</p>
    </Card> : null },
  ];

  return (
    <WorkspaceFrame
      wide
      moduleId="markov" title="Markov chains" accent="#c026d3" subtitle="n-step transitions · exact steady state · classes & periodicity · absorption · first passage"
      input={<Card title="Transition matrix"><div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-[0.9rem]">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('markov')[Number(e.target.value)]; if (x) setSpec(structuredClone(x.spec) as MarkovSpec); }}><option value="" disabled>Choose…</option>{libraryFor('markov').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
        <MatrixEditor caption="Transition probabilities" values={spec.P} onChange={P => set({ P, init: P.map((_, i) => spec.init[i] ?? '0') })} rowLabels={spec.names} colLabels={spec.names} onRowLabels={names => set({ names })} onColLabels={names => set({ names })} square maxRows={8} maxCols={8} cornerLabel="from \ to" rowExtra={{ label: 'Σ', values: spec.P.map(r => { const s = rowSum(r); return s ? s.toString() : '?'; }), onChange: () => undefined }} />
        <div className="grid grid-cols-2 gap-3"><Field label="Steps n" hint="1 – 60">{id => <input id={id} className="input mono" inputMode="numeric" value={spec.n} onChange={e => set({ n: e.target.value })} />}</Field></div>
        <div><div className="text-[0.9rem] font-semibold mb-1">Initial distribution</div><div className="flex gap-1.5 flex-wrap">{spec.names.map((nm, i) => <label key={i} className="flex flex-col text-[12px] muted">{nm}<input className="input num !w-16" aria-label={`Initial probability of ${nm}`} value={spec.init[i] ?? ''} onChange={e => set({ init: spec.names.map((_, k) => (k === i ? e.target.value : spec.init[k] ?? '0')) })} /></label>)}</div></div>
      </div></Card>}
      tabs={tabs} side={res && !res.error ? <Card title="Reading the result"><p className="text-[0.95rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>{res.steps.map(s => s.explanation).join(' ')}</p></Card> : <Card><p className="text-[0.95rem] muted">{res?.error ?? error ?? ''}</p></Card>}
      status={res ? (res.error ? <StatusBanner kind="bad" label="Not stochastic">{res.error}</StatusBanner> : <StatusBanner kind="ok" label="Chain analysed"><span className="text-[0.95rem]">{res.irreducible ? 'irreducible' : `${res.classes.length} classes`}{res.periodic ? `, period ${res.period}` : ', aperiodic'}</span>{res.steadyState && <span className="mono text-[0.9rem]">π = ({res.steadyState.distribution.map(v => v.toString()).join(', ')})</span>}</StatusBanner>) : null}
      saved={saved} onLoad={(mm: SavedModel) => setSpec(mm.model as MarkovSpec)} buildReport={buildReport} pngRef={pngRef}
    />
  );
}
