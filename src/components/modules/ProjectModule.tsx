import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, BarChart3, Workflow, TrendingDown, Plus, Trash2 } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { ProjectModel, ProjectState, SavedModel } from '../../core/types/models';
import { ProjectSolver, ProjectResult, probabilityWithin, normalInv } from '../../core/solvers/project/cpm';
import { crashCurve } from '../../core/solvers/project/crashing';
import { libraryFor } from '../../data/library';
import { ProjectSpec } from '../../data/specs';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { TutorPanel, TutorQuestion, useTutorStats } from '../workspace/TutorPanel';
import { GridDiff } from '../workspace/GridDiff';
import { Card, Callout, StatusBanner, statusKind, statusLabel, DiagnosticsList, Btn, Badge, Field } from '../ui/ui';
import { useInitial, useSaved, stepsToReport, diagText, clampStep } from './common';

const DEFAULT: ProjectSpec = libraryFor('project')[0]!.spec as ProjectSpec;
type Variant = 'cpm' | 'pert' | 'crash';

const numOrU = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? undefined : Number(s));

export function toProjectModel(spec: ProjectSpec, pert: boolean): { model: ProjectModel | null; error: string | null } {
  for (const a of spec.activities) {
    for (const [k, v] of [['duration', a.duration], ['optimistic', a.a], ['most likely', a.m], ['pessimistic', a.b]] as const) if (v.trim() !== '' && Number.isNaN(Number(v))) return { model: null, error: `Activity ${a.id}: ${k} “${v}” is not a number.` };
  }
  return { model: { activities: spec.activities.map(a => ({ id: a.id.trim(), name: a.id.trim(), predecessors: a.pred.split(/[,\s;]+/).map(x => x.trim()).filter(Boolean), duration: numOrU(a.duration), optimistic: pert ? numOrU(a.a) : undefined, mostLikely: pert ? numOrU(a.m) : undefined, pessimistic: pert ? numOrU(a.b) : undefined, normalCost: numOrU(a.normalCost), crashDuration: numOrU(a.crashDuration), crashCost: numOrU(a.crashCost) })), deadline: numOrU(spec.deadline) }, error: null };
}

function Gantt({ res, order, upTo }: { res: ProjectResult; order: string[]; upTo?: number }) {
  const T = Math.max(res.projectDuration, 1);
  const W = 700, rowH = 26, L = 70, H = order.length * rowH + 34;
  const X = (t: number) => L + (t / T) * (W - L - 12);
  const ticks = Array.from({ length: Math.min(T, 20) + 1 }, (_, i) => Math.round((i * T) / Math.min(T, 20) * 100) / 100);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Gantt chart">
      {ticks.map(t => <g key={t}><line x1={X(t)} x2={X(t)} y1="22" y2={H} stroke="var(--border)" /><text x={X(t)} y="14" fontSize="10" textAnchor="middle" fill="var(--text-3)">{t}</text></g>)}
      {order.map((id, i) => {
        const s = res.schedule[id]!;
        const y = 28 + i * rowH;
        const visible = upTo === undefined || i <= upTo;
        return (
          <g key={id} opacity={visible ? 1 : 0.15}>
            <text x="6" y={y + 12} fontSize="12" fontWeight="700" fill="var(--text)">{id}</text>
            <rect x={X(s.earlyStart)} y={y} width={Math.max(2, X(s.earlyFinish) - X(s.earlyStart))} height="14" fill={s.isCritical ? 'var(--bad)' : 'var(--entering)'} />
            {s.totalFloat > 0 && <rect x={X(s.earlyFinish)} y={y + 4} width={X(s.earlyFinish + s.totalFloat) - X(s.earlyFinish)} height="6" fill="none" stroke="var(--text-3)" strokeDasharray="3 2" />}
            <text x={X(s.earlyFinish) + (s.totalFloat > 0 ? X(s.earlyFinish + s.totalFloat) - X(s.earlyFinish) : 0) + 5} y={y + 11} fontSize="9.5" fill="var(--text-3)" className="mono">{s.isCritical ? 'critical' : `float ${s.totalFloat}`}</text>
          </g>
        );
      })}
    </svg>
  );
}

function AON({ spec, res }: { spec: ProjectModel; res: ProjectResult }) {
  const layer = new Map<string, number>();
  const depth = (id: string): number => { if (layer.has(id)) return layer.get(id)!; const a = spec.activities.find(x => x.id === id)!; const d = a.predecessors.length ? 1 + Math.max(...a.predecessors.map(depth)) : 0; layer.set(id, d); return d; };
  res.order.forEach(depth);
  const cols = new Map<number, string[]>();
  res.order.forEach(id => cols.set(layer.get(id)!, [...(cols.get(layer.get(id)!) ?? []), id]));
  const nL = Math.max(...cols.keys()) + 1, maxRows = Math.max(...[...cols.values()].map(c => c.length));
  const NW = 96, NH = 52, gx = 52, gy = 22, W = nL * (NW + gx) + 10, H = maxRows * (NH + gy) + 10;
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((ids, l) => ids.forEach((id, k) => pos.set(id, { x: 5 + l * (NW + gx), y: 5 + k * (NH + gy) + ((maxRows - ids.length) * (NH + gy)) / 2 })));
  return (
    <div className="overflow-x-auto"><svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: Math.min(W, 900), width: '100%' }} role="img" aria-label="Activity-on-node network">
      <defs><marker id="aonA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="context-stroke" /></marker></defs>
      {spec.activities.flatMap(a => a.predecessors.map(p => { const s = pos.get(p), t = pos.get(a.id); if (!s || !t) return null; const crit = res.schedule[p]!.isCritical && res.schedule[a.id]!.isCritical && res.schedule[p]!.earlyFinish === res.schedule[a.id]!.earlyStart; return <path key={`${p}-${a.id}`} d={`M ${s.x + NW} ${s.y + NH / 2} C ${s.x + NW + gx / 2} ${s.y + NH / 2}, ${t.x - gx / 2} ${t.y + NH / 2}, ${t.x - 2} ${t.y + NH / 2}`} fill="none" stroke={crit ? 'var(--bad)' : 'var(--text-3)'} strokeWidth={crit ? 2.4 : 1.2} markerEnd="url(#aonA)" />; }))}
      {res.order.map(id => { const s = res.schedule[id]!, p = pos.get(id)!; return (
        <g key={id} transform={`translate(${p.x} ${p.y})`}>
          <rect width={NW} height={NH} fill="var(--surface)" stroke={s.isCritical ? 'var(--bad)' : 'var(--border-strong)'} strokeWidth={s.isCritical ? 2.4 : 1.2} />
          <line x1="0" x2={NW} y1="17" y2="17" stroke="var(--border)" /><line x1={NW / 2} x2={NW / 2} y1="0" y2="17" stroke="var(--border)" /><line x1={NW / 2} x2={NW / 2} y1={NH - 16} y2={NH} stroke="var(--border)" /><line x1="0" x2={NW} y1={NH - 16} y2={NH - 16} stroke="var(--border)" />
          <text x={NW / 4} y="12" fontSize="10" textAnchor="middle" className="mono" fill="var(--text-2)">{s.earlyStart}</text><text x={(3 * NW) / 4} y="12" fontSize="10" textAnchor="middle" className="mono" fill="var(--text-2)">{s.earlyFinish}</text>
          <text x={NW / 2} y="33" fontSize="12.5" fontWeight="800" textAnchor="middle" fill="var(--text)">{id} <tspan fontWeight="500" fontSize="10" fill="var(--text-3)">({s.expectedDuration})</tspan></text>
          <text x={NW / 4} y={NH - 5} fontSize="10" textAnchor="middle" className="mono" fill="var(--text-2)">{s.lateStart}</text><text x={(3 * NW) / 4} y={NH - 5} fontSize="10" textAnchor="middle" className="mono" fill="var(--text-2)">{s.lateFinish}</text>
        </g>); })}
    </svg><p className="text-[13px] muted mt-1">Each box: ES | EF on top, activity (duration) in the middle, LS | LF below. Critical path in the accent colour.</p></div>
  );
}

export default function ProjectModule() {
  const init = useInitial<ProjectSpec>('project', DEFAULT);
  const [spec, setSpec] = useState<ProjectSpec>(init.spec);
  const [variant, setVariant] = useState<Variant>((['cpm', 'pert', 'crash'].includes(init.variant ?? '') ? init.variant : 'cpm') as Variant);
  const [mode, setMode] = useState<'auto' | 'tutor'>('auto');
  const [step, setStep] = useState(init.step);
  const pngRef = useRef<HTMLElement | null>(null);
  const { model, error } = useMemo(() => toProjectModel(spec, variant === 'pert'), [spec, variant]);
  const sol = useMemo(() => (model ? new ProjectSolver().solve(model, { variant: variant === 'pert' ? 'pert' : 'cpm' }) : null), [model, variant]);
  const res = sol?.result;
  const crash = useMemo(() => (variant === 'crash' && model && res ? crashCurve(model, res.projectDuration) : null), [variant, model, res]);
  const steps = sol?.steps ?? [];
  const idx = clampStep(step, steps.length);
  const saved = useSaved('project', spec, variant);
  const onLoad = (m: SavedModel) => { setSpec(m.model as ProjectSpec); if (m.variant) setVariant(m.variant as Variant); setStep(0); };
  const upd = (i: number, patch: Partial<ProjectSpec['activities'][number]>) => setSpec(s => ({ ...s, activities: s.activities.map((a, k) => (k === i ? { ...a, ...patch } : a)) }));

  const [tIdx, setTIdx] = useState(0);
  const tstats = useTutorStats();
  useEffect(() => { setTIdx(0); tstats.reset(); }, [spec, variant, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const question = useMemo<TutorQuestion | null>(() => {
    if (mode !== 'tutor') return null;
    const nxt = steps[tIdx + 1];
    if (!nxt || !(nxt.phase === 'Forward pass' || nxt.phase === 'Backward pass')) return null;
    const st = nxt.state as ProjectState;
    const id = st.justComputed![0]!;
    const s = st.schedule[id]!;
    const fwd = nxt.phase === 'Forward pass';
    const correct = fwd ? s.earlyFinish : s.lateStart;
    const base = [correct, correct + 1, correct - 1, fwd ? s.earlyStart : s.lateFinish].filter((v, i, a) => a.indexOf(v) === i && v >= 0);
    return { id: `p${tIdx}`, prompt: fwd ? `Forward pass: what is the EARLY FINISH of ${id} (ES = ${s.earlyStart}, duration ${s.expectedDuration})?` : `Backward pass: what is the LATE START of ${id} (LF = ${s.lateFinish}, duration ${s.expectedDuration})?`, hint: fwd ? 'EF = ES + duration; ES = max EF of predecessors.' : 'LS = LF − duration; LF = min LS of successors.', options: base.map(v => ({ id: String(v), label: String(v), correct: v === correct, feedback: v === correct ? nxt.explanation.short : fwd ? `ES + duration = ${s.earlyStart} + ${s.expectedDuration} = ${correct}, not ${v}.` : `LF − duration = ${s.lateFinish} − ${s.expectedDuration} = ${correct}, not ${v}.`, misconception: fwd ? 'Early times use the LONGEST predecessor path (max).' : 'Late times use the SHORTEST successor path (min).' })).sort((a, b) => Number(a.id) - Number(b.id)), reveal: nxt.explanation.short };
  }, [mode, steps, tIdx]);
  const advance = () => { let k = tIdx + 1; while (k < steps.length - 1 && !(steps[k + 1]?.phase === 'Forward pass' || steps[k + 1]?.phase === 'Backward pass')) k++; setTIdx(Math.min(k, steps.length - 1)); };
  const showIdx = mode === 'tutor' ? tIdx : idx;
  const showSt = steps[showIdx];
  const finalState = steps[steps.length - 1]?.state as ProjectState | undefined;
  const target = Number(spec.target);
  const prob = res && variant === 'pert' && Number.isFinite(target) && spec.target !== '' ? probabilityWithin(res, target) : null;
  const gOrder = res?.order ?? [];

  const buildReport = () => {
    if (!sol || !model || !res) return null;
    return { title: 'Project plan', module: 'Project planning', method: variant.toUpperCase(), problem: model.activities.map(a => `${a.id}: pred [${a.predecessors.join(', ') || '—'}] ${variant === 'pert' ? `a=${a.optimistic} m=${a.mostLikely} b=${a.pessimistic}` : `duration ${a.duration}`}`).join('\n'), steps: stepsToReport(steps), result: { heading: `Result: ${statusLabel(sol.status)}`, lines: [`Project duration = ${res.projectDuration}`, `Critical path: ${res.criticalPaths.map(p => p.join(' → ')).join(' ; ')}`, ...(res.projectVariance !== undefined ? [`Variance = ${res.projectVariance}, σ = ${res.projectStdDev?.toFixed(3)}`] : []), ...(prob !== null ? [`P(finish ≤ ${target}) = ${(prob * 100).toFixed(1)} %`] : [])], tables: [{ caption: 'Schedule', headers: ['Activity', 'ES', 'EF', 'LS', 'LF', 'Total float', 'Free float', 'Critical'], rows: gOrder.map(id => { const s = res.schedule[id]!; return [id, s.earlyStart, s.earlyFinish, s.lateStart, s.lateFinish, s.totalFloat, s.freeFloat, s.isCritical ? 'yes' : ''].map(String); }) }] }, diagnostics: diagText(sol.diagnostics) };
  };

  const status = sol && <StatusBanner kind={statusKind(sol.status)} label={sol.status === 'invalid-input' ? 'Cannot schedule' : statusLabel(sol.status)}>{res && <><span className="mono font-bold text-base">duration = {res.projectDuration}</span><span className="text-[0.82rem]">critical: {res.criticalPaths.length ? res.criticalPaths.map(p => p.join('→')).join(' | ') : res.criticalPath.join(', ')}</span>{res.slackToDeadline !== undefined && <Badge kind={res.slackToDeadline < 0 ? 'bad' : 'ok'}>{res.slackToDeadline < 0 ? `${-res.slackToDeadline} over deadline` : `${res.slackToDeadline} slack to deadline`}</Badge>}</>}</StatusBanner>;

  const tabs = [
    { id: 'sched', label: <><CalendarClock size={13} /> Schedule</>, node: <>
      {error && <Callout kind="bad">{error}</Callout>}
      {mode === 'tutor' && <TutorPanel question={question} stats={tstats.stats} onResult={tstats.record} onAdvance={advance} finishedText="Schedule complete — switch to Auto for the float table." />}
      {res && (mode === 'auto' || tIdx >= steps.length - 2) && (
        <Card title="Schedule table" bodyClass="p-2"><div className="overflow-x-auto"><table className="tbl" aria-label="Schedule"><thead><tr><th scope="col">Activity</th><th scope="col" title="expected duration">te</th><th scope="col">ES</th><th scope="col">EF</th><th scope="col">LS</th><th scope="col">LF</th><th scope="col">Total float</th><th scope="col">Free float</th>{variant === 'pert' && <th scope="col">σ²</th>}</tr></thead><tbody>
          {gOrder.map(id => { const s = ((showSt?.state as ProjectState).pass === 'float' || (showSt?.state as ProjectState).pass === 'done' ? (showSt!.state as ProjectState) : (showSt!.state as ProjectState)).schedule[id]!; const f = (v: number) => (Number.isNaN(v) ? '·' : v); return <tr key={id} className={res.schedule[id]!.isCritical && Number.isFinite(s.totalFloat) && s.totalFloat === 0 ? 'zrow' : ''}><th scope="row">{id}{(showSt!.state as ProjectState).pass === 'float' || (showSt!.state as ProjectState).pass === 'done' ? (res.schedule[id]!.isCritical && <Badge kind="accent"> critical</Badge>) : null}</th><td>{s.expectedDuration}</td><td>{f(s.earlyStart)}</td><td>{f(s.earlyFinish)}</td><td>{f(s.lateStart)}</td><td>{f(s.lateFinish)}</td><td>{f(s.totalFloat)}</td><td>{(showSt!.state as ProjectState).pass === 'float' || (showSt!.state as ProjectState).pass === 'done' ? s.freeFloat : '·'}</td>{variant === 'pert' && <td>{s.variance}</td>}</tr>; })}
        </tbody></table></div></Card>
      )}
      {variant === 'pert' && res && res.projectVariance !== undefined && (
        <Card title="Probability of completion" right={<Badge kind="accent">PERT</Badge>}><div className="flex flex-col gap-2 text-sm">
          <p>Expected duration <b>{res.projectDuration}</b>, variance <b>{res.projectVariance}</b> (σ = {res.projectStdDev?.toFixed(3)}){res.projectVariance === 0 ? ' — all critical activities are deterministic.' : ''}</p>
          <div className="grid grid-cols-2 gap-3"><Field label="Target time T">{id => <input id={id} className="input mono" value={spec.target} onChange={e => setSpec({ ...spec, target: e.target.value })} />}</Field>
          <div className="flex flex-col justify-end text-lg font-bold mono">{prob !== null ? `P(T ≤ ${target}) = ${(prob * 100).toFixed(1)} %` : '—'}</div></div>
          {res.projectVariance > 0 && <p className="text-[0.82rem] muted">95 % of the time the project finishes within {(res.projectDuration + normalInv(0.95) * (res.projectStdDev ?? 0)).toFixed(2)}; 50 % within {res.projectDuration}.</p>}
        </div></Card>
      )}
    </> },
    { id: 'gantt', label: <><BarChart3 size={13} /> Gantt</>, node: res ? <Card title="Gantt chart (earliest-start schedule)" bodyClass="p-2"><Gantt res={res} order={gOrder} /><p className="text-[13px] muted px-1">Solid bars: early start to early finish. Dashed outline: total float (how far the activity can slip). Accent colour = critical.</p></Card> : null },
    { id: 'aon', label: <><Workflow size={13} /> Network</>, node: res && model ? <Card title="Activity-on-node diagram" bodyClass="p-2"><AON spec={model} res={res} /></Card> : null },
    { id: 'diff', hidden: variant === 'crash', label: <>Diff mode</>, node: <GridDiff title="Compare your ES / EF / LS / LF table" blankLabel="blank = not computed yet" steps={steps} extract={(s: ProjectState) => ({ rowLabels: Object.keys(s.schedule), colLabels: ['ES', 'EF', 'LS', 'LF', 'Float'], cells: Object.values(s.schedule).map(v => [v.earlyStart, v.earlyFinish, v.lateStart, v.lateFinish, v.totalFloat].map(x => (Number.isNaN(x) ? null : String(x)))) })} cellWidth="w-14" infer={(u, c) => (u.flat().some((x, k) => x !== null && c.flat()[k] !== null && Number(x) !== Number(c.flat()[k]) ) ? 'Forward pass takes the MAX of predecessor finishes; backward pass takes the MIN of successor starts — mixing these up is the usual error.' : undefined)} /> },
    { id: 'crash', hidden: variant !== 'crash', label: <><TrendingDown size={13} /> Crashing</>, node: crash ? (
      <>
        <Card title="Cost vs duration (exact LP)" right={<Badge kind="accent">crashing</Badge>} bodyClass="p-2">
          <div style={{ height: 260 }}><ResponsiveContainer><LineChart data={[...crash.curve].reverse().map(p => ({ T: p.duration, total: Math.round(p.totalCost * 100) / 100, crash: Math.round(p.crashCost * 100) / 100 }))} margin={{ left: 4, right: 12, top: 10, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="T" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 10, fill: 'var(--text-3)' }} label={{ value: 'project duration', position: 'insideBottom', offset: -2, fontSize: 10, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 10, fill: 'var(--text-3)' }} width={50} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 12 }} /><Line dataKey="total" name="total direct cost" stroke="var(--series)" strokeWidth={2.5} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></div>
          {crash.notes.map((n, i) => <Callout key={i} kind="info">{n}</Callout>)}
        </Card>
        <Card title="Crashing plan"><div className="overflow-x-auto"><table className="tbl"><thead><tr><th scope="col">Duration</th><th scope="col">Extra cost</th><th scope="col">Total cost</th><th scope="col">Crashed activities</th></tr></thead><tbody>{crash.curve.map(p => <tr key={p.duration}><th scope="row">{p.duration}</th><td>{Math.round(p.crashCost * 100) / 100}</td><td className="font-bold">{Math.round(p.totalCost * 100) / 100}</td><td className="!text-left">{Object.entries(p.reductions).map(([id, r]) => `${id} −${Math.round(r * 100) / 100}`).join(', ') || '—'}</td></tr>)}</tbody></table></div><p className="text-[0.82rem] muted mt-2">Each reduction never exceeds an activity's crash limit; with several critical paths, every one is shortened simultaneously at minimum cost.</p></Card>
      </>
    ) : <Callout kind="info">Enter normal cost, crash duration and crash cost for the activities to see the time–cost curve.</Callout> },
  ];

  const pert = variant === 'pert', cr = variant === 'crash';
  return (
    <WorkspaceFrame
      moduleId="project" title="Project planning" accent="#e11d48" subtitle="CPM · PERT · floats · Gantt · AON network · exact time–cost crashing"
      variants={[{ value: 'cpm', label: 'CPM' }, { value: 'pert', label: 'PERT' }, { value: 'crash', label: 'Crashing' }]} variant={variant} onVariant={v => { setVariant(v); setStep(0); }} mode={variant === 'crash' ? undefined : mode} onMode={setMode}
      input={<>
        <Card title="Activities"><div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-xs">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('project')[Number(e.target.value)]; if (x) { setSpec(structuredClone(x.spec) as ProjectSpec); if (x.variant) setVariant(x.variant as Variant); setStep(0); } }}><option value="" disabled>Choose…</option>{libraryFor('project').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
          <div className="overflow-x-auto"><table className="tbl" aria-label="Activity list"><thead><tr><th scope="col">Id</th><th scope="col">After</th>{pert ? <><th scope="col">a</th><th scope="col">m</th><th scope="col">b</th></> : <th scope="col">Time</th>}{cr && <><th scope="col" title="normal cost">Cn</th><th scope="col" title="crash duration">Dc</th><th scope="col" title="crash cost">Cc</th></>}<th scope="col"><span className="sr-only">Remove</span></th></tr></thead><tbody>
            {spec.activities.map((a, i) => <tr key={i}>
              <td className="!p-0.5"><input className="input num !w-12" aria-label={`Activity ${i + 1} id`} value={a.id} onChange={e => upd(i, { id: e.target.value })} /></td>
              <td className="!p-0.5"><input className="input !w-20 mono" aria-label={`Predecessors of ${a.id}`} placeholder="A, B" value={a.pred} onChange={e => upd(i, { pred: e.target.value })} /></td>
              {pert ? (['a', 'm', 'b'] as const).map(k => <td key={k} className="!p-0.5"><input className="input num !w-12" aria-label={`${k} of ${a.id}`} value={a[k]} onChange={e => upd(i, { [k]: e.target.value })} /></td>) : <td className="!p-0.5"><input className="input num !w-12" aria-label={`Duration of ${a.id}`} value={a.duration} onChange={e => upd(i, { duration: e.target.value })} /></td>}
              {cr && (['normalCost', 'crashDuration', 'crashCost'] as const).map(k => <td key={k} className="!p-0.5"><input className="input num !w-14" aria-label={`${k} of ${a.id}`} value={a[k]} onChange={e => upd(i, { [k]: e.target.value })} /></td>)}
              <td className="!p-0.5"><Btn size="icon" variant="ghost" aria-label={`Remove ${a.id}`} onClick={() => setSpec(s => ({ ...s, activities: s.activities.filter((_, k) => k !== i) }))}><Trash2 size={12} /></Btn></td>
            </tr>)}
          </tbody></table></div>
          <div className="flex gap-2 items-end"><Btn size="sm" onClick={() => setSpec(s => ({ ...s, activities: [...s.activities, { id: String.fromCharCode(65 + (s.activities.length % 26)) + (s.activities.length >= 26 ? Math.floor(s.activities.length / 26) : ''), pred: '', duration: '1', a: '', m: '', b: '', normalCost: '', crashDuration: '', crashCost: '' }] }))}><Plus size={12} /> Activity</Btn>
            <Field label="Deadline (optional)">{id => <input id={id} className="input num !w-20" value={spec.deadline} onChange={e => setSpec({ ...spec, deadline: e.target.value })} />}</Field></div>
        </div></Card>
        {error && <Callout kind="bad">{error}</Callout>}
        {sol && <DiagnosticsList items={sol.diagnostics} />}
      </>}
      tabs={tabs} side={showSt ? <ExplanationPanel explanation={showSt.explanation} phase={showSt.phase} /> : <Card><p className="text-sm muted">{sol?.diagnostics[0]?.message ?? 'Add activities.'}</p></Card>}
      player={mode === 'auto' && steps.length > 0 && variant !== 'crash' ? <StepPlayer count={steps.length} index={idx} onChange={setStep} labels={steps.map(s => s.phase ?? '')} summary={steps[idx]?.explanation.short} /> : undefined}
      status={status} saved={saved} onLoad={onLoad} buildReport={buildReport} pngRef={pngRef} step={idx}
    />
  );
  void finalState;
}
