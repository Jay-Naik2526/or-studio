import { useMemo, useRef, useState } from 'react';
import { Dices, BarChart3, ListOrdered, TrendingUp } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Area, ComposedChart, ReferenceLine, AreaChart, Legend } from 'recharts';
import { SavedModel } from '../../core/types/models';
import { Distribution, validateDistribution, describeDistribution } from '../../core/solvers/simulation/random';
import { runMonteCarlo, runQueueSimulation, describeMean } from '../../core/solvers/simulation/simulation';
import { solveQueue } from '../../core/solvers/queuing/queuing';
import { libraryFor } from '../../data/library';
import { SimSpec, DistSpec } from '../../data/specs';
import { plainNum } from '../../lib/numbers';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { Card, Callout, StatusBanner, Field, Btn, ResultStat, Badge } from '../ui/ui';
import { useInitial, useSaved } from './common';

const DEFAULT = libraryFor('simulation')[0]!.spec as SimSpec;
const f = (x: number, d = 4) => Number(x.toFixed(d)).toString();

export function toDist(d: DistSpec): Distribution | string {
  const n = (s: string) => plainNum(s);
  const need = (...v: (number | null)[]): number[] | null => (v.every(x => x !== null) ? (v as number[]) : null);
  switch (d.type) {
    case 'uniform': { const v = need(n(d.p1), n(d.p2)); return v ? { type: 'uniform', a: v[0]!, b: v[1]! } : 'Uniform needs a and b'; }
    case 'exponential': { const v = need(n(d.p1)); return v ? { type: 'exponential', rate: v[0]! } : 'Exponential needs a rate'; }
    case 'normal': { const v = need(n(d.p1), n(d.p2)); return v ? { type: 'normal', mean: v[0]!, sd: v[1]! } : 'Normal needs mean and σ'; }
    case 'triangular': { const v = need(n(d.p1), n(d.p2), n(d.p3)); return v ? { type: 'triangular', a: v[0]!, m: v[1]!, b: v[2]! } : 'Triangular needs a, m, b'; }
    case 'poisson': { const v = need(n(d.p1)); return v ? { type: 'poisson', mean: v[0]! } : 'Poisson needs a mean'; }
    case 'constant': { const v = need(n(d.p1)); return v ? { type: 'constant', value: v[0]! } : 'Constant needs a value'; }
    case 'discrete': {
      const parts = d.values.split(',').map(x => x.trim()).filter(Boolean).map(x => x.split(':').map(y => y.trim()));
      if (!parts.length || parts.some(p => p.length !== 2)) return 'Discrete: write value:probability pairs, e.g. 1:0.5, 2:0.5';
      const values = parts.map(p => plainNum(p[0]!)), probs = parts.map(p => plainNum(p[1]!));
      if (values.some(v => v === null) || probs.some(v => v === null)) return 'Discrete: every value and probability must be a number';
      return { type: 'discrete', values: values as number[], probs: probs as number[] };
    }
  }
}

/** Parse a numeric field; an empty or unreadable entry is reported instead of silently replaced by a default (blankIs = value used for an empty field). */
function field(label: string, text: string, blankIs?: number): { v: number } | { error: string } {
  if (text.trim() === '') return blankIs === undefined ? { error: `${label}: enter a number.` } : { v: blankIs };
  const v = plainNum(text);
  return v === null ? { error: `${label}: "${text.length > 24 ? text.slice(0, 24) + '…' : text}" is not a number.` } : { v };
}
const failed = (...r: ({ v: number } | { error: string })[]): string | null => { for (const x of r) if ('error' in x) return x.error; return null; };

function DistEditor({ label, d, onChange }: { label: string; d: DistSpec; onChange: (d: DistSpec) => void }) {
  const names: Record<DistSpec['type'], string[]> = { uniform: ['a', 'b'], exponential: ['rate'], normal: ['mean', 'σ'], triangular: ['a', 'm', 'b'], poisson: ['mean'], constant: ['value'], discrete: [] };
  const keys = ['p1', 'p2', 'p3'] as const;
  const conv = toDist(d);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap"><span className="font-semibold text-[0.95rem] w-24">{label}</span>
        <select className="select !w-auto" aria-label={`${label} distribution`} value={d.type} onChange={e => onChange({ ...d, type: e.target.value as DistSpec['type'] })}>{(['uniform', 'exponential', 'normal', 'triangular', 'poisson', 'discrete', 'constant'] as const).map(t => <option key={t} value={t}>{t}</option>)}</select>
        {names[d.type].map((nm, i) => <label key={nm} className="flex items-center gap-1 text-[0.85rem] muted">{nm}<input className="input num !w-20" value={d[keys[i]!]} onChange={e => onChange({ ...d, [keys[i]!]: e.target.value })} /></label>)}
        {d.type === 'discrete' && <input className="input mono flex-1 min-w-[12rem]" aria-label="Discrete values" placeholder="1:0.5, 2:0.5" value={d.values} onChange={e => onChange({ ...d, values: e.target.value })} />}
      </div>
      {typeof conv === 'string' ? <span className="text-[0.85rem]" style={{ color: 'var(--bad)' }}>{conv}</span> : (() => { const e = validateDistribution(conv); return e ? <span className="text-[0.85rem]" style={{ color: 'var(--bad)' }}>{e}</span> : null; })()}
    </div>
  );
}

export default function SimulationModule() {
  const init = useInitial<SimSpec>('simulation', DEFAULT);
  const [spec, setSpec] = useState<SimSpec>(init.spec);
  const [runKey, setRunKey] = useState(0);
  const pngRef = useRef<HTMLElement | null>(null);
  const set = (p: Partial<SimSpec>) => setSpec(s => ({ ...s, ...p }));
  const upd = (f: (s: SimSpec) => Partial<SimSpec>) => setSpec(s => ({ ...s, ...f(s) }));
  const saved = useSaved('simulation', spec);
  const seedField = field('Seed', spec.seed);
  const seed = 'v' in seedField ? seedField.v : 1;

  const mc = useMemo(() => {
    if (spec.kind !== 'montecarlo') return null;
    const trials = field('Trials', spec.trials), threshold = field('Threshold', spec.threshold, NaN);
    const bad = failed(seedField, trials, threshold);
    if (bad) return { error: bad } as ReturnType<typeof runMonteCarlo>;
    const vars = []; for (const v of spec.vars) { const d = toDist(v.dist); if (typeof d === 'string') return { error: `${v.name}: ${d}` } as ReturnType<typeof runMonteCarlo>; vars.push({ name: v.name, dist: d }); }
    return runMonteCarlo({ variables: vars, expression: spec.expression, trials: (trials as { v: number }).v, seed, generator: spec.generator, threshold: Number.isNaN((threshold as { v: number }).v) ? undefined : (threshold as { v: number }).v });
  }, [spec, seed, runKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = useMemo(() => {
    if (spec.kind !== 'queue') return null;
    const ia = toDist(spec.interarrival), sv = toDist(spec.service);
    if (typeof ia === 'string' || typeof sv === 'string') return { error: typeof ia === 'string' ? `Interarrival: ${ia}` : `Service: ${sv}` } as ReturnType<typeof runQueueSimulation>;
    const servers = field('Servers', spec.servers), customers = field('Customers', spec.customers), warmup = field('Warm-up', spec.warmup, 0);
    const bad = failed(seedField, servers, customers, warmup);
    if (bad) return { error: bad } as ReturnType<typeof runQueueSimulation>;
    return runQueueSimulation({ interarrival: ia, service: sv, servers: (servers as { v: number }).v, customers: (customers as { v: number }).v, seed, generator: spec.generator, warmup: (warmup as { v: number }).v });
  }, [spec, seed, runKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const theory = useMemo(() => {
    if (spec.kind !== 'queue') return null;
    const ia = toDist(spec.interarrival), sv = toDist(spec.service);
    if (typeof ia === 'string' || typeof sv === 'string' || ia.type !== 'exponential' || sv.type !== 'exponential') return null;
    const c = Math.max(1, Math.floor(plainNum(spec.servers) ?? 1));
    return solveQueue({ model: c > 1 ? 'mmc' : 'mm1', lambda: ia.rate, mu: sv.rate, servers: c }).metrics ?? null;
  }, [spec]);

  const err = mc?.error ?? qs?.error;
  const buildReport = () => {
    if (spec.kind === 'montecarlo' && mc && !mc.error) return { title: 'Monte Carlo simulation', module: 'Simulation', problem: `Variables: ${spec.vars.map(v => `${v.name} ~ ${describeDistribution(toDist(v.dist) as Distribution)}`).join('; ')}\nExpression: ${spec.expression}\nTrials: ${mc.n}, seed ${mc.seed}, generator ${mc.generator}`, steps: [], result: { heading: 'Estimate', lines: [`Mean = ${f(mc.mean, 5)} (95 % CI ${f(mc.ci95[0], 5)} … ${f(mc.ci95[1], 5)})`, `Std dev = ${f(mc.stdDev, 5)}, min ${f(mc.min)}, max ${f(mc.max)}`], tables: [{ caption: 'Percentiles', headers: ['Percentile', 'Value'], rows: mc.percentiles.map(p => [`${p.p}%`, f(p.value)]) }] }, diagnostics: [] };
    if (spec.kind === 'queue' && qs && !qs.error) return { title: 'Queue simulation', module: 'Simulation', problem: `Interarrival ${describeDistribution(toDist(spec.interarrival) as Distribution)}, service ${describeDistribution(toDist(spec.service) as Distribution)}, ${spec.servers} server(s), ${spec.customers} customers, seed ${qs.seed}`, steps: [], result: { heading: 'Estimates', lines: [`Average wait Wq = ${f(qs.avgWait)}`, `Average time in system = ${f(qs.avgSystemTime)}`, `Utilisation = ${f(qs.utilisation)}`, `Average queue length = ${f(qs.avgQueueLength)}`, `P(wait) = ${f(qs.probWait)}`], tables: [{ caption: 'Event trace (first 40)', headers: ['Time', 'Event', 'Customer', 'Queue', 'In system'], rows: qs.events.slice(0, 40).map(e => [f(e.time, 3), e.type, String(e.customer), String(e.queueLength), String(e.inSystem)]) }] }, diagnostics: qs.warnings };
    return null;
  };

  const tabs = [
    { id: 'res', label: <><Dices size={14} /> Results</>, node: <>
      {err && <Callout kind="bad" title="Check the inputs">{err}</Callout>}
      {mc && !mc.error && <>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px border" style={{ background: 'var(--border)', borderColor: 'var(--border)' }}>{[['Mean', f(mc.mean, 5)], ['Std dev', f(mc.stdDev, 5)], ['Std error', f(mc.stdError, 5)], ...(mc.probAtLeast !== undefined ? [[`P(≥ ${spec.threshold})`, f(mc.probAtLeast * 100, 2) + ' %']] : [['Median', f(mc.median)]])].map(([k, v]) => <div key={k} className="p-4" style={{ background: 'var(--surface)' }}><div className="display text-3xl font-semibold" style={{ color: 'var(--text)' }}>{v}</div><div className="eyebrow mt-1">{k}</div></div>)}</div>
        <Card title="Estimate" right={<Badge>{mc.generator} · seed {mc.seed}</Badge>}><p className="text-[1rem]">After <b>{mc.n.toLocaleString()}</b> trials the mean is <b className="mono">{f(mc.mean, 5)}</b> with a 95 % confidence interval <b className="mono">[{f(mc.ci95[0], 5)}, {f(mc.ci95[1], 5)}]</b>. Quadruple the trials to halve the interval width.</p><div className="grid grid-cols-5 gap-3 mt-3">{mc.percentiles.map(p => <ResultStat key={p.p} label={`${p.p}th pct`}>{f(p.value, 3)}</ResultStat>)}</div></Card>
        <Card title="Histogram" icon={<BarChart3 size={14} />} bodyClass="p-3"><div style={{ height: 280 }}><ResponsiveContainer><BarChart data={mc.histogram.map(h => ({ x: Number(((h.from + h.to) / 2).toFixed(3)), count: h.count }))} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="x" tick={{ fontSize: 12, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={48} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Bar dataKey="count" fill="var(--entering)" /></BarChart></ResponsiveContainer></div></Card>
        <Card title="Convergence of the estimate" icon={<TrendingUp size={14} />} bodyClass="p-3"><div style={{ height: 280 }}><ResponsiveContainer><ComposedChart data={mc.convergence.map(c => ({ n: c.n, mean: c.mean, band: [c.lo, c.hi] }))} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="n" tick={{ fontSize: 12, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 12, fill: 'var(--text-3)' }} domain={['auto', 'auto']} width={56} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Area dataKey="band" stroke="none" fill="var(--accent-soft)" name="95 % CI" /><Line dataKey="mean" stroke="var(--series)" strokeWidth={2.5} dot={false} name="running mean" /><ReferenceLine y={mc.mean} stroke="var(--text-3)" strokeDasharray="4 4" /></ComposedChart></ResponsiveContainer></div></Card>
      </>}
      {qs && !qs.error && <>
        {qs.warnings.map((w, i) => <Callout key={i} kind="warn">{w}</Callout>)}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px border" style={{ background: 'var(--border)', borderColor: 'var(--border)' }}>{[['Avg wait Wq', f(qs.avgWait), theory ? f(theory.Wq) : null], ['Time in system', f(qs.avgSystemTime), theory ? f(theory.Ws) : null], ['Avg queue Lq', f(qs.avgQueueLength), theory ? f(theory.Lq) : null], ['Utilisation', f(qs.utilisation), theory ? f(theory.rho) : null]].map(([k, v, t]) => <div key={k as string} className="p-4" style={{ background: 'var(--surface)' }}><div className="display text-3xl font-semibold" style={{ color: 'var(--text)' }}>{v}</div><div className="eyebrow mt-1">{k}</div>{t && <div className="text-[0.82rem] muted mt-1">theory {t}</div>}</div>)}</div>
        <Card title="Waiting time converges" bodyClass="p-3"><div style={{ height: 260 }}><ResponsiveContainer><LineChart data={qs.waitConvergence} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="n" tick={{ fontSize: 12, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={50} domain={['auto', 'auto']} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Line dataKey="avg" stroke="var(--series)" strokeWidth={2.5} dot={false} name="running average wait" />{theory && <ReferenceLine y={theory.Wq} stroke="var(--ok)" strokeDasharray="5 4" label={{ value: 'theory', fill: 'var(--ok)', fontSize: 12 }} />}</LineChart></ResponsiveContainer></div></Card>
        <Card title="Customers in system over time" bodyClass="p-3"><div style={{ height: 220 }}><ResponsiveContainer><AreaChart data={qs.occupancy.filter((_, i) => i % Math.ceil(qs.occupancy.length / 400) === 0)} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="time" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => String(Math.round(v))} tick={{ fontSize: 12, fill: 'var(--text-3)' }} /><YAxis allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={34} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Legend /><Area type="stepAfter" dataKey="inSystem" name="in system" stroke="var(--entering)" fill="var(--entering-soft)" /><Area type="stepAfter" dataKey="queue" name="waiting" stroke="var(--series)" fill="var(--accent-soft)" /></AreaChart></ResponsiveContainer></div></Card>
      </>}
    </> },
    { id: 'trace', hidden: !qs || !!qs.error, label: <><ListOrdered size={14} /> Event trace</>, node: qs && !qs.error ? <Card title="First 400 events" bodyClass="p-2"><div className="overflow-auto max-h-[28rem]"><table className="tbl"><thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Customer</th><th scope="col">Server</th><th scope="col">Waiting</th><th scope="col">In system</th></tr></thead><tbody>{qs.events.map((e, i) => <tr key={i}><th scope="row">{f(e.time, 3)}</th><td className="!text-left">{e.type === 'arrival' ? '→ arrives' : e.type === 'start' ? '▶ starts service' : '■ departs'}</td><td>{e.customer}</td><td>{e.server ?? '—'}</td><td>{e.queueLength}</td><td>{e.inSystem}</td></tr>)}</tbody></table></div></Card> : null },
  ];

  const mcMean = describeMean;
  void mcMean;
  return (
    <WorkspaceFrame
      moduleId="simulation" title="Simulation" accent="#ea580c" subtitle="Seedable generators · Monte Carlo with confidence intervals · discrete-event queue simulation"
      variants={[{ value: 'montecarlo', label: 'Monte Carlo' }, { value: 'queue', label: 'Queue sim' }]} variant={spec.kind} onVariant={k => set({ kind: k })}
      input={<>
        <Card title="Random numbers"><div className="grid grid-cols-2 gap-3">
          <Field label="Seed" hint="Same seed → identical results">{id => <input id={id} className="input mono" value={spec.seed} onChange={e => set({ seed: e.target.value })} />}</Field>
          <Field label="Generator">{id => <select id={id} className="select" value={spec.generator} onChange={e => set({ generator: e.target.value as 'lcg' | 'mt' })}><option value="mt">Mersenne Twister</option><option value="lcg">LCG (16807)</option></select>}</Field>
          <div className="col-span-2 flex gap-2"><Btn onClick={() => set({ seed: String(Math.floor(Math.random() * 1e6)) })}>New random seed</Btn><Btn onClick={() => setRunKey(k => k + 1)}>Re-run</Btn></div>
        </div></Card>
        {spec.kind === 'montecarlo' ? (
          <Card title="Experiment"><div className="flex flex-col gap-4">
            <label className="flex items-center gap-2 text-[0.9rem]">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('simulation').filter(y => (y.spec as SimSpec).kind === 'montecarlo')[Number(e.target.value)]; if (x) setSpec(structuredClone(x.spec) as SimSpec); }}><option value="" disabled>Choose…</option>{libraryFor('simulation').filter(y => (y.spec as SimSpec).kind === 'montecarlo').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
            {spec.vars.map((v, i) => <div key={i} className="flex flex-col gap-1 pb-3 border-b" style={{ borderColor: 'var(--border)' }}><div className="flex gap-2 items-center"><input className="input mono !w-20" aria-label={`Variable ${i + 1} name`} value={v.name} onChange={e => { const nv = e.target.value; upd(s => ({ vars: s.vars.map((x, k) => (k === i ? { ...x, name: nv } : x)) })); }} /><span className="muted">~</span><Btn size="sm" variant="ghost" onClick={() => upd(s => ({ vars: s.vars.filter((_, k) => k !== i) }))} aria-label={`Remove variable ${v.name}`}>remove</Btn></div><DistEditor label="" d={v.dist} onChange={d => upd(s => ({ vars: s.vars.map((x, k) => (k === i ? { ...x, dist: d } : x)) }))} /></div>)}
            <Btn size="sm" onClick={() => upd(s => ({ vars: [...s.vars, { name: `v${s.vars.length + 1}`, dist: { type: 'uniform', p1: '0', p2: '1', p3: '', values: '' } }] }))}>+ random variable</Btn>
            <Field label="Expression" hint="+ − * / ^, ( ), sqrt, exp, ln, sin, cos, abs, min, max, step(x) = 1 if x ≥ 0">{id => <input id={id} className="input mono" value={spec.expression} onChange={e => set({ expression: e.target.value })} />}</Field>
            <div className="grid grid-cols-2 gap-3"><Field label="Trials">{id => <input id={id} className="input mono" value={spec.trials} onChange={e => set({ trials: e.target.value })} />}</Field><Field label="Threshold (optional)" hint="estimate P(result ≥ t)">{id => <input id={id} className="input mono" value={spec.threshold} onChange={e => set({ threshold: e.target.value })} />}</Field></div>
          </div></Card>
        ) : (
          <Card title="Queue"><div className="flex flex-col gap-4">
            <DistEditor label="Interarrival" d={spec.interarrival} onChange={d => set({ interarrival: d })} />
            <DistEditor label="Service" d={spec.service} onChange={d => set({ service: d })} />
            <div className="grid grid-cols-3 gap-3"><Field label="Servers">{id => <input id={id} className="input mono" value={spec.servers} onChange={e => set({ servers: e.target.value })} />}</Field><Field label="Customers">{id => <input id={id} className="input mono" value={spec.customers} onChange={e => set({ customers: e.target.value })} />}</Field><Field label="Warm-up">{id => <input id={id} className="input mono" value={spec.warmup} onChange={e => set({ warmup: e.target.value })} />}</Field></div>
          </div></Card>
        )}
      </>}
      tabs={tabs}
      side={<Card title="How to read this"><p className="text-[0.95rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>{spec.kind === 'montecarlo' ? 'Each trial draws every random variable by inverse-transform sampling, evaluates your expression, and the average of all trials estimates its expected value. The shaded band is the 95 % confidence interval; it shrinks like 1/√n.' : 'Customers arrive after random interarrival times and are served first-come-first-served by the first free server. Statistics ignore the warm-up customers so the empty start does not bias them. With exponential times the result approaches the exact M/M/c formulas.'}</p></Card>}
      status={err ? <StatusBanner kind="bad" label="Check inputs">{err}</StatusBanner> : mc && !mc.error ? <StatusBanner kind="ok" label="Simulated"><span className="mono font-bold text-base">mean ≈ {f(mc.mean, 4)}</span><span className="text-[0.85rem]">{mc.n.toLocaleString()} trials · seed {mc.seed}</span></StatusBanner> : qs && !qs.error ? <StatusBanner kind={qs.warnings.some(w => /unstable/.test(w)) ? 'warn' : 'ok'} label="Simulated"><span className="mono font-bold text-base">Wq ≈ {f(qs.avgWait, 4)}</span><span className="text-[0.85rem]">{qs.customers.length.toLocaleString()} customers · seed {qs.seed}</span></StatusBanner> : null}
      saved={saved} onLoad={(m: SavedModel) => setSpec(m.model as SimSpec)} buildReport={buildReport} pngRef={pngRef}
    />
  );
}
