import { useMemo, useRef, useState } from 'react';
import { Hourglass, BarChart3, Coins } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, ReferenceDot, Legend } from 'recharts';
import { SavedModel } from '../../core/types/models';
import { solveQueue, QueueInput, QueueResult } from '../../core/solvers/queuing/queuing';
import { libraryFor } from '../../data/library';
import { QueueSpec } from '../../data/specs';
import { plainNum } from '../../lib/numbers';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { Card, Callout, StatusBanner, Field, ResultStat, Badge } from '../ui/ui';
import { Katex } from '../ui/Katex';
import { useInitial, useSaved } from './common';

const DEFAULT: QueueSpec = libraryFor('queuing')[0]!.spec as QueueSpec;
const MODELS: { value: QueueSpec['model']; label: string; title: string }[] = [
  { value: 'mm1', label: 'M/M/1', title: 'One server, unlimited queue' }, { value: 'mmc', label: 'M/M/c', title: 'c servers' }, { value: 'mm1n', label: 'M/M/1/N', title: 'Limited system capacity' },
  { value: 'mmcn', label: 'M/M/c/N', title: 'c servers, capacity N' }, { value: 'mmcnn', label: 'Machines', title: 'Finite source (M/M/c/K/K)' }, { value: 'mg1', label: 'M/G/1', title: 'General service time' },
];
const f4 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(4)).toString() : '∞');

function toInput(s: QueueSpec): { input: QueueInput | null; error: string | null } {
  const lambda = plainNum(s.lambda), mu = plainNum(s.mu);
  if (lambda === null) return { input: null, error: 'Enter the arrival rate λ as a number.' };
  if (mu === null) return { input: null, error: 'Enter the service rate μ as a number.' };
  const servers = s.model === 'mm1' || s.model === 'mm1n' || s.model === 'mg1' ? 1 : Math.max(1, Math.floor(plainNum(s.servers) ?? 1));
  const cap = s.capacity.trim() === '' ? undefined : plainNum(s.capacity) ?? undefined;
  if ((s.model === 'mm1n' || s.model === 'mmcn' || s.model === 'mmcnn') && cap === undefined) return { input: null, error: s.model === 'mmcnn' ? 'Enter the number of machines K.' : 'Enter the system capacity N.' };
  const sigma = s.sigma.trim() === '' ? undefined : plainNum(s.sigma) ?? undefined;
  return { input: { model: s.model, lambda, mu, servers, capacity: s.model === 'mm1' || s.model === 'mmc' || s.model === 'mg1' ? undefined : cap, serviceStdDev: sigma, costPerServer: plainNum(s.Cs) ?? undefined, costPerWait: plainNum(s.Cw) ?? undefined, costBasis: s.basis }, error: null };
}

export default function QueuingModule() {
  const init = useInitial<QueueSpec>('queuing', DEFAULT);
  const [spec, setSpec] = useState<QueueSpec>(init.spec);
  const pngRef = useRef<HTMLElement | null>(null);
  const { input, error } = useMemo(() => toInput(spec), [spec]);
  const res: QueueResult | null = useMemo(() => (input ? solveQueue(input) : null), [input]);
  const m = res?.metrics;
  const saved = useSaved('queuing', spec);
  const set = (p: Partial<QueueSpec>) => setSpec(s => ({ ...s, ...p }));
  const multi = spec.model === 'mmc' || spec.model === 'mmcn' || spec.model === 'mmcnn';
  const finite = spec.model === 'mm1n' || spec.model === 'mmcn' || spec.model === 'mmcnn';

  const sweep = useMemo(() => {
    if (!input) return [];
    const mu = input.mu, c = input.servers ?? 1;
    const top = spec.model === 'mmcnn' ? input.lambda * 8 : Math.max(input.lambda * 1.6, c * mu * 1.15);
    return Array.from({ length: 40 }, (_, k) => { const lam = (top * (k + 1)) / 40; const r = solveQueue({ ...input, lambda: lam, costPerServer: undefined, costPerWait: undefined }); return r.metrics ? { lambda: Number(lam.toFixed(3)), Ls: Math.min(r.metrics.Ls, 60), Lq: Math.min(r.metrics.Lq, 60), Ws: Math.min(r.metrics.Ws, 60), rho: Number(r.metrics.rho.toFixed(3)) } : { lambda: Number(lam.toFixed(3)), Ls: NaN, Lq: NaN, Ws: NaN, rho: NaN }; });
  }, [input, spec.model]);
  const serverSweep = useMemo(() => {
    if (!input || !multi) return [];
    const out: { c: number; Ls: number; Wq: number; rho: number }[] = [];
    for (let c = 1; c <= 12; c++) { const r = solveQueue({ ...input, servers: c, costPerServer: undefined, costPerWait: undefined }); if (r.metrics) out.push({ c, Ls: Number(r.metrics.Ls.toFixed(3)), Wq: Number(r.metrics.Wq.toFixed(3)), rho: Number(r.metrics.rho.toFixed(3)) }); }
    return out;
  }, [input, multi]);

  const slider = (label: string, key: 'lambda' | 'mu' | 'servers' | 'capacity', min: number, max: number, step: number) => {
    const v = plainNum(spec[key]) ?? min;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex justify-between text-[0.9rem]"><label htmlFor={`sl-${key}`} className="font-semibold">{label}</label><span className="mono font-bold">{spec[key]}</span></div>
        <input id={`sl-${key}`} className="range" type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, v))} onChange={e => set({ [key]: String(Number(e.target.value)) } as Partial<QueueSpec>)} />
      </div>
    );
  };

  const buildReport = () => (!res?.metrics || !m ? null : { title: 'Queuing analysis', module: 'Queuing analysis', method: MODELS.find(x => x.value === spec.model)!.label, problem: `Model ${spec.model}: λ = ${spec.lambda}, μ = ${spec.mu}${multi ? `, c = ${spec.servers}` : ''}${finite ? `, N/K = ${spec.capacity}` : ''}`, steps: res.steps.map(s => ({ title: s.title, short: s.explanation })), result: { heading: 'Performance measures', lines: res.interpretation, tables: [{ caption: 'Measures', headers: ['Measure', 'Value'], rows: [['ρ', f4(m.rho)], ['P0', f4(m.P0)], ['Ls', f4(m.Ls)], ['Lq', f4(m.Lq)], ['Ws', f4(m.Ws)], ['Wq', f4(m.Wq)], ['λ_eff', f4(m.effectiveLambda)]] }, ...(res.costOptimization ? [{ caption: 'Cost model', headers: ['c', 'Server cost', 'Waiting cost', 'Total'], rows: res.costOptimization.candidates.map(c => [String(c.c), f4(c.serverCost), f4(c.waitingCost), f4(c.totalCost)]) }] : [])] }, diagnostics: [] });

  const tabs = [
    { id: 'metrics', label: <><Hourglass size={14} /> Measures</>, node: <>
      {error && <Callout kind="bad">{error}</Callout>}
      {res?.error && <Callout kind="bad" title="Cannot compute">{res.error}</Callout>}
      {m && <>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px border" style={{ background: 'var(--border)', borderColor: 'var(--border)' }}>
          {[['Lₛ', f4(m.Ls), 'in system'], ['Lq', f4(m.Lq), 'in queue'], ['Wₛ', f4(m.Ws), 'time in system'], ['Wq', f4(m.Wq), 'time waiting']].map(([k, v, d]) => <div key={k} className="p-4" style={{ background: 'var(--surface)' }}><div className="display text-3xl font-semibold" style={{ color: 'var(--text)' }}>{v}</div><div className="mono text-sm font-bold mt-1">{k}</div><div className="eyebrow">{d}</div></div>)}
        </div>
        <Card title="Utilisation & probabilities"><div className="grid grid-cols-2 md:grid-cols-4 gap-4"><ResultStat label="ρ (traffic)">{f4(m.rho)}</ResultStat><ResultStat label="P₀ (empty)">{f4(m.P0)}</ResultStat><ResultStat label="Server busy">{f4(m.serverUtilisation * 100)} %</ResultStat><ResultStat label="λ effective">{f4(m.effectiveLambda)}</ResultStat>{m.probWait !== undefined && <ResultStat label="P(wait)">{f4(m.probWait * 100)} %</ResultStat>}{m.probBlocked !== undefined && <ResultStat label="P(turned away)">{f4(m.probBlocked * 100)} %</ResultStat>}</div>
          <div className="mt-4 h-1.5 w-full" style={{ background: 'var(--surface-3)' }} role="img" aria-label={`Utilisation ${f4(m.rho * 100)} percent`}><div style={{ width: `${Math.min(100, m.rho * 100)}%`, height: '100%', background: m.rho > 0.85 ? 'var(--bad)' : m.rho > 0.7 ? 'var(--leaving)' : 'var(--ok)' }} /></div></Card>
        <Card title="In plain words"><ul className="list-disc pl-5 flex flex-col gap-1.5 text-[0.98rem]">{res!.interpretation.map((t, i) => <li key={i}>{t}</li>)}</ul></Card>
        <Card title="Steps"><ol className="flex flex-col gap-3">{res!.steps.map(s => <li key={s.stepNumber}><div className="font-bold">{s.stepNumber}. {s.title}</div><p className="text-[0.95rem]" style={{ color: 'var(--text-2)' }}>{s.explanation}</p>{s.formula && <div className="overflow-x-auto"><Katex tex={s.formula} display /></div>}</li>)}</ol></Card>
        <Card title="Probability of n customers in the system">
          <div style={{ height: 220 }}><ResponsiveContainer><BarChart data={m.Pk.slice(0, 21).map((p, n) => ({ n, p: Number(p.toFixed(5)) }))}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="n" tick={{ fontSize: 12, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={48} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Bar dataKey="p" fill="var(--series)" /></BarChart></ResponsiveContainer></div>
        </Card>
      </>}
    </> },
    { id: 'charts', label: <><BarChart3 size={14} /> Sensitivity</>, node: <>
      <Card title="Queue length vs arrival rate" bodyClass="p-3"><div style={{ height: 280 }}><ResponsiveContainer><LineChart data={sweep} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="lambda" tick={{ fontSize: 12, fill: 'var(--text-3)' }} label={{ value: 'λ', position: 'insideBottomRight', fontSize: 12, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={44} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Legend /><Line dataKey="Ls" name="Lₛ" stroke="var(--series)" strokeWidth={2.5} dot={false} /><Line dataKey="Lq" name="Lq" stroke="var(--entering)" strokeWidth={2} dot={false} />{input && m && <ReferenceDot x={Number(sweep.reduce((b, p) => (Math.abs(p.lambda - input.lambda) < Math.abs(b.lambda - input.lambda) ? p : b), sweep[0]!).lambda)} y={Math.min(m.Ls, 60)} r={6} fill="var(--leaving)" stroke="var(--surface)" />}</LineChart></ResponsiveContainer></div><p className="text-sm muted px-2">The curve climbs steeply as ρ → 1: a small rise in demand near capacity multiplies waiting. The orange dot is your current λ.</p></Card>
      {multi && serverSweep.length > 0 && <Card title="Effect of the number of servers" bodyClass="p-3"><div style={{ height: 260 }}><ResponsiveContainer><LineChart data={serverSweep} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="c" tick={{ fontSize: 12, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={44} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Legend /><Line dataKey="Wq" name="Wq" stroke="var(--series)" strokeWidth={2.5} /><Line dataKey="Ls" name="Lₛ" stroke="var(--entering)" strokeWidth={2} /></LineChart></ResponsiveContainer></div></Card>}
    </> },
    { id: 'cost', label: <><Coins size={14} /> Cost model</>, node: res?.costOptimization ? (
      <Card title="Total cost vs number of servers" right={<Badge kind="ok">optimum c* = {res.costOptimization.optimalServers}</Badge>} bodyClass="p-3">
        <div style={{ height: 300 }}><ResponsiveContainer><LineChart data={res.costOptimization.candidates.map(c => ({ c: c.c, server: Number(c.serverCost.toFixed(2)), waiting: Number(c.waitingCost.toFixed(2)), total: Number(c.totalCost.toFixed(2)) }))} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="c" tick={{ fontSize: 12, fill: 'var(--text-3)' }} label={{ value: 'servers c', position: 'insideBottomRight', fontSize: 12, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={50} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Legend /><Line dataKey="server" name="server cost" stroke="var(--entering)" strokeWidth={2} /><Line dataKey="waiting" name="waiting cost" stroke="var(--leaving)" strokeWidth={2} /><Line dataKey="total" name="total" stroke="var(--series)" strokeWidth={3} dot={{ r: 4 }} /><ReferenceDot x={res.costOptimization.optimalServers} y={Number(res.costOptimization.minTotalCost.toFixed(2))} r={8} fill="var(--ok)" stroke="var(--surface)" strokeWidth={2} /></LineChart></ResponsiveContainer></div>
        <div className="overflow-x-auto mt-3"><table className="tbl"><thead><tr><th scope="col">c</th><th scope="col">Lₛ</th><th scope="col">Server cost</th><th scope="col">Waiting cost</th><th scope="col">Total</th></tr></thead><tbody>{res.costOptimization.candidates.map(c => <tr key={c.c} className={c.c === res.costOptimization!.optimalServers ? 'zrow' : ''}><th scope="row">{c.c}</th><td>{f4(c.Ls)}</td><td>{f4(c.serverCost)}</td><td>{f4(c.waitingCost)}</td><td className="font-bold">{f4(c.totalCost)}</td></tr>)}</tbody></table></div>
      </Card>
    ) : <Callout kind="info">Enter a cost per server (Cₛ) and a waiting cost per customer-hour (Cw) in the input panel to find the cost-minimising number of servers.</Callout> },
  ];

  return (
    <WorkspaceFrame
      moduleId="queuing" title="Queuing analysis" accent="#2563eb" subtitle="Live λ / μ / c sliders · performance measures · cost-optimal servers"
      variants={MODELS} variant={spec.model} onVariant={v => set({ model: v })}
      input={<>
        <Card title="Parameters"><div className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-[0.9rem]">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('queuing')[Number(e.target.value)]; if (x) setSpec(structuredClone(x.spec) as QueueSpec); }}><option value="" disabled>Choose…</option>{libraryFor('queuing').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
          <div className="grid grid-cols-2 gap-3"><Field label="Arrival rate λ">{id => <input id={id} className="input mono" inputMode="decimal" value={spec.lambda} onChange={e => set({ lambda: e.target.value })} />}</Field><Field label="Service rate μ (per server)">{id => <input id={id} className="input mono" inputMode="decimal" value={spec.mu} onChange={e => set({ mu: e.target.value })} />}</Field></div>
          {multi && <Field label="Servers c">{id => <input id={id} className="input mono" inputMode="numeric" value={spec.servers} onChange={e => set({ servers: e.target.value })} />}</Field>}
          {finite && <Field label={spec.model === 'mmcnn' ? 'Machines K' : 'System capacity N'}>{id => <input id={id} className="input mono" inputMode="numeric" value={spec.capacity} onChange={e => set({ capacity: e.target.value })} />}</Field>}
          {spec.model === 'mg1' && <Field label="Service-time std. deviation σ" hint="σ = 1/μ is M/M/1; σ = 0 is M/D/1.">{id => <input id={id} className="input mono" inputMode="decimal" value={spec.sigma} onChange={e => set({ sigma: e.target.value })} />}</Field>}
          <div className="grid grid-cols-2 gap-3"><Field label="Cost per server Cₛ">{id => <input id={id} className="input mono" inputMode="decimal" value={spec.Cs} onChange={e => set({ Cs: e.target.value })} />}</Field><Field label="Waiting cost Cw">{id => <input id={id} className="input mono" inputMode="decimal" value={spec.Cw} onChange={e => set({ Cw: e.target.value })} />}</Field></div>
        </div></Card>
        <Card title="Live sliders"><div className="flex flex-col gap-4">{slider('λ', 'lambda', 0.1, Math.max(20, (plainNum(spec.lambda) ?? 2) * 2), 0.1)}{slider('μ', 'mu', 0.1, Math.max(20, (plainNum(spec.mu) ?? 3) * 2), 0.1)}{multi && slider('c', 'servers', 1, 15, 1)}{finite && slider(spec.model === 'mmcnn' ? 'K' : 'N', 'capacity', 1, 40, 1)}</div></Card>
      </>}
      tabs={tabs}
      side={res?.metrics ? <Card title="Reading the numbers"><p className="text-[0.95rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>{res.interpretation[0]}</p></Card> : <Card><p className="text-[0.95rem] muted">{res?.error ?? error ?? 'Enter the parameters.'}</p></Card>}
      status={res ? (res.error ? <StatusBanner kind="bad" label="Unstable or invalid">{res.error.length > 140 ? res.error.slice(0, 140) + '…' : res.error}</StatusBanner> : m ? <StatusBanner kind="ok" label="Stable"><span className="mono font-bold text-base">ρ = {f4(m.rho)}</span><span className="text-[0.85rem]">Lₛ = {f4(m.Ls)} · Wₛ = {f4(m.Ws)}</span></StatusBanner> : null) : null}
      saved={saved} onLoad={(mm: SavedModel) => setSpec(mm.model as QueueSpec)} buildReport={buildReport} pngRef={pngRef}
    />
  );
}
