import { ReactNode, useMemo, useRef, useState } from 'react';
import { Dices, BarChart3, ListOrdered, TrendingUp, Footprints, Table2, Search, FlaskConical } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Area, ComposedChart, ReferenceLine, AreaChart, Legend, ScatterChart, Scatter, Cell } from 'recharts';
import { SavedModel } from '../../core/types/models';
import { Distribution, validateDistribution, describeDistribution, makeRng } from '../../core/solvers/simulation/random';
import { runMonteCarlo, runQueueSimulation, describeMean } from '../../core/solvers/simulation/simulation';
import { DayRow, DemandSim, DemandStepState, IntervalTable, demandSteps, fmt, simulateDemand } from '../../core/solvers/simulation/demandTable';
import { InvDay, InvStepState, InventorySim, PolicySearch, inventorySteps, policySearch, simulateInventory } from '../../core/solvers/simulation/inventorySim';
import { ChiSquare, GenRun, chiSquareUniform, consecutivePairs, formatP } from '../../core/solvers/simulation/rngLab';
import { demandInputFromSpec, inventoryInputFromSpec, readInt, rngRunFromSpec } from '../../core/solvers/simulation/specInputs';
import { Step } from '../../core/types/step';
import { solveQueue } from '../../core/solvers/queuing/queuing';
import { libraryFor } from '../../data/library';
import { SimSpec, DistSpec, SimDemandSpec, SimInventorySpec, SimRngSpec, SimTableRow } from '../../data/specs';
import { parseNum, plainNum } from '../../lib/numbers';
import { ReportTable } from '../../lib/report';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { Card, Callout, StatusBanner, Field, Btn, ResultStat, Badge, Segmented } from '../ui/ui';
import { useInitial, useSaved, stepsToReport, clampStep, conforms } from './common';

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

/* ------------------------------------------------------------------ */
/* Demand table / Inventory / RNG lab pieces                           */
/* ------------------------------------------------------------------ */

const TT = { background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 } as const;
const AX = { fontSize: 12, fill: 'var(--text-3)' } as const;
const entry = (id: string) => libraryFor('simulation').find(x => x.id === id)!.spec as SimSpec;
const DEMAND_DEFAULT: SimDemandSpec = entry('sim-exp10-demand').demand!;
const INV_DEFAULT: SimInventorySpec = entry('sim-inv-sS').inventory!;
const RNG_DEFAULT: SimRngSpec = entry('sim-rng-lcg').rng!;
const SHOW_ROWS = 500;

function Tbl({ head, rows, hl, caption, maxH }: { head: string[]; rows: (string | number)[][]; hl?: number; caption: string; maxH?: string }) {
  return (
    <div className={`overflow-auto ${maxH ?? ''}`}>
      <table className="tbl" aria-label={caption}>
        <thead><tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} aria-current={hl === i ? 'true' : undefined}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row" style={hl === i ? { background: 'var(--accent-soft)', color: 'var(--text)' } : undefined}>{c}</th> : <td key={j} className={hl === i ? 'pivot' : ''}>{c}</td>))}</tr>)}</tbody>
      </table>
    </div>
  );
}

function StatGrid({ items }: { items: [string, string, string?][] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-px border" style={{ background: 'var(--border)', borderColor: 'var(--border)' }}>
      {items.map(([k, v, t]) => <div key={k} className="p-4 min-w-0" style={{ background: 'var(--surface)' }}><div className="display text-3xl font-semibold break-words" style={{ color: 'var(--text)' }}>{v}</div><div className="eyebrow mt-1">{k}</div>{t && <div className="text-[0.82rem] muted mt-1">{t}</div>}</div>)}
    </div>
  );
}

/** value / probability rows with a live total, used by the demand and lead-time tables */
function TableEditor({ label, valueHead, rows, onChange }: { label: string; valueHead: string; rows: SimTableRow[]; onChange: (r: SimTableRow[]) => void }) {
  const parsed = rows.map(r => parseNum(r.prob));
  const ok = parsed.every(p => p.ok);
  const sum = ok ? parsed.reduce((a, p) => a + (p.ok ? Number(p.value.toDecimal(15)) : 0), 0) : NaN;
  const off = Math.abs(sum - 1);
  const good = ok && off <= 1e-9;
  const setRow = (i: number, p: Partial<SimTableRow>) => onChange(rows.map((r, k) => (k === i ? { ...r, ...p } : r)));
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-[0.9rem]" aria-label={label}>
        <thead><tr><th scope="col" className="eyebrow text-left pb-1">{valueHead}</th><th scope="col" className="eyebrow text-left pb-1">Probability</th><th className="w-8"><span className="sr-only">Remove</span></th></tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={i}>
            <td className="pr-2 pb-1"><input className="input mono" aria-label={`${label} value ${i + 1}`} value={r.value} onChange={e => setRow(i, { value: e.target.value })} /></td>
            <td className="pr-2 pb-1"><input className="input mono" aria-label={`${label} probability ${i + 1}`} value={r.prob} onChange={e => setRow(i, { prob: e.target.value })} /></td>
            <td className="pb-1"><Btn size="sm" variant="ghost" aria-label={`Remove ${label} row ${i + 1}`} disabled={rows.length <= 1} onClick={() => onChange(rows.filter((_, k) => k !== i))}>×</Btn></td>
          </tr>
        ))}</tbody>
      </table>
      <div className="flex items-center gap-2 flex-wrap">
        <Btn size="sm" disabled={rows.length >= 50} onClick={() => onChange([...rows, { value: '', prob: '' }])}>+ row</Btn>
        <Badge kind={good ? 'ok' : 'bad'}>{ok ? `total ${Number(sum.toFixed(10))}` : 'total unknown'}{good ? '' : ' (must be 1)'}</Badge>
        {ok && off > 1e-12 && off <= 1e-9 && <Btn size="sm" onClick={() => onChange(rows.map((r, i) => { const p = parsed[i]; return p && p.ok ? { ...r, prob: String(Number((Number(p.value.toDecimal(15)) / sum).toFixed(12))) } : r; }))}>Normalise to 1</Btn>}
      </div>
    </div>
  );
}

function RnSource({ source, onSource, rns, onRns, label, count, convention, onConvention, digits, onDigits, days, onDays, extra }: {
  source: 'given' | 'generate'; onSource: (s: 'given' | 'generate') => void; rns: string; onRns: (s: string) => void; label: string; count: number | null;
  convention: 'zero' | 'one'; onConvention: (c: 'zero' | 'one') => void; digits: string; onDigits: (s: string) => void; days: string; onDays: (s: string) => void; extra?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Segmented label="Random number source" value={source} onChange={onSource} options={[{ value: 'given', label: 'Given list' }, { value: 'generate', label: 'Generate' }]} />
      {source === 'given'
        ? <Field label={label} hint={count !== null ? `${count.toLocaleString()} number${count === 1 ? '' : 's'} read: the simulation runs one day per number. Separate with commas, spaces or new lines.` : 'Separate with commas, spaces or new lines.'}>{id => <textarea id={id} className="textarea mono" rows={3} maxLength={90000} spellCheck={false} value={rns} onChange={e => onRns(e.target.value)} />}</Field>
        : <Field label="Number of days" hint="Drawn with the generator and seed above. At most 100 000.">{id => <input id={id} className="input mono" inputMode="numeric" value={days} onChange={e => onDays(e.target.value)} />}</Field>}
      {extra}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Digits per random number" hint="1 to 4 (2 digits: 00 to 99)">{id => <input id={id} className="input mono" inputMode="numeric" value={digits} onChange={e => onDigits(e.target.value)} />}</Field>
        <Field label="Interval convention" hint={convention === 'zero' ? 'Numbers 00 … 99' : 'Numbers 01 … 100, 00 means 100'}>{id => <select id={id} className="select" value={convention} onChange={e => onConvention(e.target.value === 'one' ? 'one' : 'zero')}><option value="zero">00–99</option><option value="one">01–100</option></select>}</Field>
      </div>
    </div>
  );
}

function IntervalView({ t, hl, withCum = true, withInterval = true }: { t: IntervalTable; hl?: number; withCum?: boolean; withInterval?: boolean }) {
  const off = t.intervals.some(r => Math.abs(r.count - r.prob * t.modulus) > 1e-6);
  const head = ['Demand', 'Probability', ...(withCum ? ['Cumulative'] : []), ...(withInterval ? [`Random numbers (${t.convention === 'zero' ? '00–99' : '01–100'})`, 'Count'] : []), ...(withInterval && off ? ['Implied p'] : [])];
  const rows = t.intervals.map(r => [fmt(r.value), fmt(r.prob), ...(withCum ? [fmt(r.cum, 6)] : []), ...(withInterval ? [r.label, r.count] : []), ...(withInterval && off ? [fmt(r.impliedProb, 6)] : [])]);
  return <Tbl caption="Demand distribution" head={head} rows={rows} hl={hl} />;
}

const dayRows = (days: DayRow[]) => days.map(d => [d.day, d.rnLabel, d.interval, fmt(d.demand), fmt(d.cumDemand), fmt(d.runningAvg, 4)]);
const DAY_HEAD = ['Day', 'Random no.', 'Interval hit', 'Demand', 'Cumulative demand', 'Running average'];

function DemandSummary({ sim }: { sim: DemandSim }) {
  const data = sim.table.intervals.map((r, k) => ({ x: fmt(r.value), simulated: Number((sim.observed[k] ?? 0).toFixed(4)), theoretical: r.prob }));
  const gap = sim.mean - sim.expected;
  return (
    <>
      <StatGrid items={[['Simulated total', fmt(sim.total)], ['Simulated mean', fmt(sim.mean, 4), `${sim.days.length.toLocaleString()} day${sim.days.length === 1 ? '' : 's'}`], ['Theoretical E[D]', fmt(sim.expected, 6), 'Σ demand × probability'], ['Difference', fmt(gap, 4), gap === 0 ? 'exact agreement' : 'sampling noise shrinks like 1/√n']]} />
      <Card title="Simulated vs theoretical distribution" icon={<BarChart3 size={14} />} bodyClass="p-3">
        <div style={{ height: 280 }}><ResponsiveContainer><BarChart data={data} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="x" tick={AX} /><YAxis tick={AX} width={48} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} /><Tooltip contentStyle={TT} formatter={(v: unknown) => `${(Number(v) * 100).toFixed(1)} %`} /><Legend /><Bar dataKey="simulated" name="simulated" fill="var(--entering)" /><Bar dataKey="theoretical" name="theoretical" fill="var(--series)" /></BarChart></ResponsiveContainer></div>
      </Card>
    </>
  );
}

function DayTable({ days, title, limit = SHOW_ROWS }: { days: DayRow[]; title: string; limit?: number }) {
  const shown = days.slice(0, limit);
  return (
    <Card title={title} right={<Badge>{days.length.toLocaleString()} day{days.length === 1 ? '' : 's'}</Badge>} bodyClass="p-2">
      <Tbl caption="Simulation table" head={DAY_HEAD} rows={dayRows(shown)} maxH="max-h-[30rem]" />
      {days.length > limit && <p className="text-[0.85rem] muted px-2 pt-2">Showing the first {limit.toLocaleString()} of {days.length.toLocaleString()} days; the export contains the rest.</p>}
      <p className="text-[0.9rem] px-2 pt-2 mono">Total demand {fmt(days[days.length - 1]?.cumDemand ?? 0)} · mean {fmt(days[days.length - 1]?.runningAvg ?? 0, 4)} per day</p>
    </Card>
  );
}

const INV_HEAD = ['Day', 'Begin', 'Arrival', 'Random no.', 'Demand', 'Sales', 'End', 'Shortage', 'Order placed', 'Order arrives', 'Cost'];
const invRows = (days: InvDay[]) => days.map(d => [d.day, d.begin, d.arrival || '–', d.rnLabel, d.demand, d.sales, d.end, d.shortage || '–', d.ordered || '–', d.ordered ? `day ${d.arrivesDay}${d.leadRn !== undefined ? ` (L=${d.leadTime}, rn ${d.leadRn})` : ''}` : '–', fmt(d.costDay, 2)]);

function InventoryDayTable({ days, title, hl, limit = SHOW_ROWS, maxH = 'max-h-[30rem]' }: { days: InvDay[]; title: string; hl?: number; limit?: number; maxH?: string }) {
  return (
    <Card title={title} bodyClass="p-2">
      <Tbl caption="Inventory simulation table" head={INV_HEAD} rows={invRows(days.slice(0, limit))} hl={hl} maxH={maxH} />
      {days.length > limit && <p className="text-[0.85rem] muted px-2 pt-2">Showing the first {limit.toLocaleString()} of {days.length.toLocaleString()} days; the export contains the rest.</p>}
    </Card>
  );
}

function ChiCard({ chi, title = 'Chi-square uniformity test' }: { chi: ChiSquare; title?: string }) {
  if (chi.error) return <Callout kind="warn" title={title}>{chi.error}</Callout>;
  const data = chi.counts.map((c, i) => ({ bin: `${(i / chi.bins).toFixed(1)}–${((i + 1) / chi.bins).toFixed(1)}`, count: c }));
  return (
    <Card title={title} right={<Badge kind={chi.pass ? 'ok' : 'bad'}>{chi.pass ? 'uniformity not rejected' : 'not uniform'}</Badge>} bodyClass="p-3">
      <div style={{ height: 220 }}><ResponsiveContainer><BarChart data={data} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="bin" tick={{ fontSize: 10, fill: 'var(--text-3)' }} interval={0} angle={-30} textAnchor="end" height={46} /><YAxis tick={AX} width={44} /><Tooltip contentStyle={TT} /><Bar dataKey="count" fill="var(--entering)" /><ReferenceLine y={chi.expected} stroke="var(--ok)" strokeDasharray="5 4" /></BarChart></ResponsiveContainer></div>
      <p className="text-[0.95rem] mt-2 leading-relaxed">Ten equal bins, {chi.n.toLocaleString()} numbers, expected <b className="mono">{fmt(chi.expected, 2)}</b> per bin (dashed line). χ² = <b className="mono">{fmt(chi.chi2, 3)}</b> with {chi.df} degrees of freedom, p-value = <b className="mono">{formatP(chi.p)}</b>. {chi.pass ? 'A p-value of 0.05 or more means the bin counts are consistent with a uniform generator (this does not prove independence).' : 'A p-value below 0.05 rejects uniformity: the bin counts are too uneven for a good generator.'}{chi.lowExpected ? ' Fewer than 5 expected per bin, so the chi-square approximation is rough; use a larger sample.' : ''}</p>
    </Card>
  );
}

function PairsCard({ u }: { u: number[] }) {
  const pts = consecutivePairs(u, 1000);
  return (
    <Card title="Consecutive pairs (uᵢ, uᵢ₊₁)" bodyClass="p-3">
      <div style={{ height: 300 }}><ResponsiveContainer><ScatterChart margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis type="number" dataKey="x" name="uᵢ" domain={[0, 1]} tick={AX} /><YAxis type="number" dataKey="y" name="uᵢ₊₁" domain={[0, 1]} tick={AX} width={40} /><Tooltip contentStyle={TT} cursor={{ strokeDasharray: '3 3' }} /><Scatter data={pts} fill="var(--entering)" isAnimationActive={false} /></ScatterChart></ResponsiveContainer></div>
      <p className="text-[0.85rem] muted mt-1">A good generator fills the square evenly. Lines, lattices or a few repeated points reveal correlation between consecutive numbers.</p>
    </Card>
  );
}

const REFS: [string, string, string][] = [
  ['https://en.wikipedia.org/wiki/Random_number_generation', 'Random number generation', 'overview of true and pseudo-random methods'],
  ['https://en.wikipedia.org/wiki/Linear_congruential_generator', 'Linear congruential generator', 'the formula, parameter choices and Hull–Dobell theorem'],
  ['https://en.wikipedia.org/wiki/Middle-square_method', 'Middle-square method', 'von Neumann’s method and why it degenerates'],
  ['https://en.wikipedia.org/wiki/Mersenne_Twister', 'Mersenne Twister', 'the MT19937 generator and its period of 2^19937 − 1'],
  ['https://en.wikipedia.org/wiki/Inverse_transform_sampling', 'Inverse transform sampling', 'turning uniform numbers into any distribution'],
  ['https://en.wikipedia.org/wiki/Monte_Carlo_method', 'Monte Carlo method', 'simulation with random sampling'],
  ['https://en.wikipedia.org/wiki/Discrete-event_simulation', 'Discrete-event simulation', 'clock, event list and state changes'],
  ['https://en.wikipedia.org/wiki/Pearson%27s_chi-squared_test', 'Pearson’s chi-squared test', 'the goodness-of-fit test used for uniformity'],
  ['https://www.random.org/randomness/', 'RANDOM.ORG: randomness', 'true random numbers from atmospheric noise'],
  ['https://csrc.nist.gov/projects/random-bit-generation', 'NIST: random bit generation', 'standards and tests for random number generators'],
  ['https://docs.python.org/3/library/random.html', 'Python documentation: random', 'a Mersenne Twister in everyday use'],
];

function References() {
  return (
    <Card title="References">
      <ul className="flex flex-col gap-2 text-[0.95rem]">
        {REFS.map(([href, name, why]) => <li key={href} className="min-w-0"><a href={href} target="_blank" rel="noopener noreferrer" className="underline font-semibold break-words" style={{ color: 'var(--accent)' }}>{name}</a><span className="muted"> - {why}</span><div className="text-[0.78rem] muted mono break-all">{href}</div></li>)}
      </ul>
    </Card>
  );
}

const METHODS: { id: SimRngSpec['method']; label: string }[] = [
  { id: 'overview', label: 'Ways to generate' }, { id: 'midsquare', label: 'Mid-square' }, { id: 'lcg', label: 'Linear congruential' }, { id: 'mt', label: 'Mersenne Twister' }, { id: 'inverse', label: 'Inverse transform' },
];

const reportTable = (caption: string, headers: string[], rows: (string | number)[][], limit = 20000): ReportTable => ({ caption: rows.length > limit ? `${caption} (first ${limit.toLocaleString()} of ${rows.length.toLocaleString()} rows)` : caption, headers, rows: rows.slice(0, limit).map(r => r.map(String)) });

const KINDS: SimSpec['kind'][] = ['montecarlo', 'queue', 'demand', 'inventory', 'rng'];
/** a saved or shared model with an unknown kind falls back to Monte Carlo */
const cleanKind = (s: SimSpec): SimSpec => (KINDS.includes(s.kind) ? s : { ...s, kind: 'montecarlo' });

export default function SimulationModule() {
  const init = useInitial<SimSpec>('simulation', DEFAULT);
  const [spec, setSpec] = useState<SimSpec>(() => cleanKind(init.spec));
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

  /* ---------- Demand table / Inventory / RNG lab ---------- */
  const gen: 'lcg' | 'mt' = spec.generator === 'lcg' ? 'lcg' : 'mt';
  const dem: SimDemandSpec = conforms(DEMAND_DEFAULT, spec.demand) ? spec.demand! : DEMAND_DEFAULT;
  const inv: SimInventorySpec = conforms(INV_DEFAULT, spec.inventory) ? spec.inventory! : INV_DEFAULT;
  const rg: SimRngSpec = conforms(RNG_DEFAULT, spec.rng) ? spec.rng! : RNG_DEFAULT;
  const setDem = (p: Partial<SimDemandSpec>) => setSpec(s => ({ ...s, demand: { ...(conforms(DEMAND_DEFAULT, s.demand) ? s.demand! : DEMAND_DEFAULT), ...p } }));
  const setInv = (p: Partial<SimInventorySpec>) => setSpec(s => ({ ...s, inventory: { ...(conforms(INV_DEFAULT, s.inventory) ? s.inventory! : INV_DEFAULT), ...p } }));
  const setRg = (p: Partial<SimRngSpec>) => setSpec(s => ({ ...s, rng: { ...(conforms(RNG_DEFAULT, s.rng) ? s.rng! : RNG_DEFAULT), ...p } }));
  const [step, setStep] = useState(init.step);
  const needSeed = (spec.kind === 'demand' && dem.source === 'generate') || (spec.kind === 'inventory' && inv.source === 'generate') || (spec.kind === 'rng' && (rg.method === 'mt' || rg.method === 'inverse'));
  const seedBad = needSeed && 'error' in seedField ? seedField.error : null;

  const dm = useMemo<{ error?: string; sim?: DemandSim; steps: Step<DemandStepState>[] } | null>(() => {
    if (spec.kind !== 'demand') return null;
    if (seedBad) return { error: seedBad, steps: [] };
    const inp = demandInputFromSpec(dem, gen, seed);
    if ('error' in inp) return { error: inp.error, steps: [] };
    const sim = simulateDemand(inp.input);
    return sim.error ? { error: sim.error, steps: [] } : { sim, steps: demandSteps(sim) };
  }, [spec.kind, dem, gen, seed, seedBad]);

  const iv = useMemo<{ error?: string; sim?: InventorySim; steps: Step<InvStepState>[]; ps?: PolicySearch } | null>(() => {
    if (spec.kind !== 'inventory') return null;
    if (seedBad) return { error: seedBad, steps: [] };
    const inp = inventoryInputFromSpec(inv, gen, seed);
    if ('error' in inp) return { error: inp.error, steps: [] };
    const sim = simulateInventory(inp.input);
    if (sim.error) return { error: sim.error, steps: [] };
    const a = readInt('S from', inv.sFrom, 0, 1e9), b = readInt('S to', inv.sTo, 0, 1e9), c = readInt('S step', inv.sStep, 1, 1e9);
    const bad = 'error' in a ? a.error : 'error' in b ? b.error : 'error' in c ? c.error : null;
    const ps = bad ? ({ error: bad, rows: [], best: -1, bestS: NaN } as PolicySearch) : policySearch(inp.input, (a as { v: number }).v, (b as { v: number }).v, (c as { v: number }).v);
    return { sim, steps: inventorySteps(sim), ps };
  }, [spec.kind, inv, gen, seed, seedBad]);

  type Lab = { error?: string; run?: GenRun; u: number[]; chi?: ChiSquare; demo?: { sim: DemandSim; u: number[] } };
  const rl = useMemo<Lab | null>(() => {
    if (spec.kind !== 'rng') return null;
    if (rg.method === 'overview') return { u: [] };
    if (rg.method === 'midsquare' || rg.method === 'lcg') {
      const run = rngRunFromSpec(rg, rg.method);
      return run.error ? { error: run.error, u: [] } : { run, u: run.uniform, chi: chiSquareUniform(run.uniform) };
    }
    if (seedBad) return { error: seedBad, u: [] };
    const n = readInt('Sample size', rg.sample, 10, 100000);
    if ('error' in n) return { error: n.error, u: [] };
    const r = makeRng('mt', seed), u: number[] = [];
    for (let i = 0; i < n.v; i++) u.push(r.next());
    const out: Lab = { u, chi: chiSquareUniform(u) };
    if (rg.method === 'inverse') {
      const inp = demandInputFromSpec({ ...dem, source: 'generate', days: '10' }, 'mt', seed);
      if ('error' in inp) out.error = inp.error;
      else { const sim = simulateDemand(inp.input); if (sim.error) out.error = sim.error; else out.demo = { sim, u: u.slice(0, 10) }; }
    }
    return out;
  }, [spec.kind, rg, dem, seed, seedBad]);

  const walkSteps: Step<DemandStepState | InvStepState>[] = spec.kind === 'demand' ? dm?.steps ?? [] : spec.kind === 'inventory' ? iv?.steps ?? [] : [];
  const idx = clampStep(step, walkSteps.length);
  const curStep = walkSteps[idx];
  const newErr = spec.kind === 'demand' ? dm?.error : spec.kind === 'inventory' ? iv?.error : spec.kind === 'rng' ? rl?.error : undefined;
  type TabDef = { id: string; label: ReactNode; node: ReactNode; hidden?: boolean };
  const walkLabel = <><Footprints size={14} /> Walkthrough</>;

  const demandTabs = (): TabDef[] => {
    const sim = dm?.sim;
    if (!sim) return [{ id: 'walk', label: walkLabel, node: dm?.error ? <Callout kind="bad" title="Check the inputs">{dm.error}</Callout> : null }];
    const st = curStep?.state as DemandStepState | undefined;
    const warn = sim.warnings.map((w, i) => <Callout key={i} kind="warn">{w}</Callout>);
    const day = st?.phase === 'day' ? sim.days[st.day - 1] : undefined;
    const slice = st ? sim.days.slice(Math.max(0, st.day - 12), st.day) : [];
    return [
      { id: 'walk', label: walkLabel, node: <>
        {warn}
        {st?.phase === 'cum' && <Card title="(a) Cumulative probability table" bodyClass="p-2"><IntervalView t={sim.table} withInterval={false} /><p className="text-[0.9rem] muted px-2 pt-2">E[D] = Σ demand × probability = <b className="mono">{fmt(sim.expected, 6)}</b></p></Card>}
        {st?.phase === 'intervals' && <Card title="(b) Random-number intervals" right={<Badge>{sim.table.convention === 'zero' ? `00–${String(sim.table.modulus - 1).padStart(sim.table.digits, '0')}` : `01–${sim.table.modulus}`}</Badge>} bodyClass="p-2"><IntervalView t={sim.table} /></Card>}
        {st?.phase === 'day' && day && <>
          <Card title={`(c) Day ${day.day}: random number ${day.rnLabel} → ${day.interval} → demand ${fmt(day.demand)}`} bodyClass="p-2"><IntervalView t={sim.table} hl={day.row} /></Card>
          <Card title="Simulation table so far" bodyClass="p-2"><Tbl caption="Simulation table so far" head={DAY_HEAD} rows={dayRows(slice)} hl={slice.length - 1} /></Card>
        </>}
        {st?.phase === 'summary' && <><DayTable days={sim.days} title="(d) Simulation table" /><DemandSummary sim={sim} /></>}
      </> },
      { id: 'table', label: <><Table2 size={14} /> Simulation table</>, node: <>{warn}<DayTable days={sim.days} title="Simulation table" /></> },
      { id: 'summary', label: <><BarChart3 size={14} /> Summary</>, node: <><Card title="Interval table" bodyClass="p-2"><IntervalView t={sim.table} /></Card><DemandSummary sim={sim} /></> },
    ];
  };

  const inventoryTabs = (): TabDef[] => {
    const sim = iv?.sim, ps = iv?.ps;
    if (!sim || !sim.input) return [{ id: 'walk', label: walkLabel, node: iv?.error ? <Callout kind="bad" title="Check the inputs">{iv.error}</Callout> : null }];
    const inp = sim.input;
    const st = curStep?.state as InvStepState | undefined;
    const warn = sim.warnings.map((w, i) => <Callout key={i} kind="warn">{w}</Callout>);
    const t = sim.totals;
    const totals = <StatGrid items={[['Total cost', fmt(t.total, 2)], ['Average per day', fmt(t.avgPerDay, 4)], ['Orders placed', String(t.orders), `ordering ${fmt(t.orderCost, 2)}`], ['Holding cost', fmt(t.holdCost, 2), `average stock ${fmt(t.avgInventory, 2)}`], ['Shortage cost', fmt(t.shortCost, 2), `${t.shortUnits} unit${t.shortUnits === 1 ? '' : 's'} ${inp.backorders ? 'still backordered' : 'lost'}`], ['Demand / sales', `${t.demand} / ${t.sales}`], ['Fill rate', `${fmt(t.fillRate * 100, 1)} %`], ['Ending stock', String(t.endStock), t.outstanding ? `${t.outstanding} still on order` : undefined]]} />;
    const slice = st?.phase === 'day' ? sim.days.slice(Math.max(0, st.day - 12), st.day) : [];
    return [
      { id: 'walk', label: walkLabel, node: <>
        {warn}
        {st?.phase === 'setup' && <>
          <StatGrid items={[['Order up to S', String(inp.S)], ['Review every R', `${inp.R} day${inp.R === 1 ? '' : 's'}`], ['Initial stock', String(inp.initial)], ['Unmet demand', inp.backorders ? 'backordered' : 'lost']]} />
          <Card title="Demand: random-number intervals" bodyClass="p-2"><IntervalView t={sim.demandTable!} /></Card>
          {sim.leadTable ? <Card title="Lead time (days): random-number intervals" bodyClass="p-2"><IntervalView t={sim.leadTable} /></Card> : <Callout kind="info">Every order arrives after a fixed lead time of {inp.leadFixed} day{inp.leadFixed === 1 ? '' : 's'} (received at the start of day t + {inp.leadFixed + 1} when ordered at the end of day t).</Callout>}
        </>}
        {st?.phase === 'day' && <InventoryDayTable days={slice} title={`Day ${st.day} of ${sim.days.length}`} hl={slice.length - 1} maxH="" />}
        {st?.phase === 'summary' && <>{totals}<InventoryDayTable days={sim.days} title="Day-by-day table" /></>}
      </> },
      { id: 'days', label: <><Table2 size={14} /> Day table</>, node: <>{warn}<InventoryDayTable days={sim.days} title="Day-by-day table" /></> },
      { id: 'policy', label: <><Search size={14} /> Policy search</>, node: ps?.error
        ? <Callout kind="warn" title="Policy search">{ps.error}</Callout>
        : ps && ps.rows.length ? <>
          <Callout kind="ok" title={`Cheapest: S = ${ps.bestS}`}>With the same random numbers, ordering up to {ps.bestS} costs {fmt(ps.rows[ps.best]!.total, 2)} in total ({fmt(ps.rows[ps.best]!.avgPerDay, 4)} per day). A single short run is noisy: try more days for a dependable choice.</Callout>
          <Card title="Average cost per day for each S" bodyClass="p-3"><div style={{ height: 260 }}><ResponsiveContainer><BarChart data={ps.rows.map(r => ({ S: String(r.S), avg: Number(r.avgPerDay.toFixed(4)) }))} margin={{ left: 4, right: 14, top: 8, bottom: 4 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="S" tick={AX} /><YAxis tick={AX} width={52} /><Tooltip contentStyle={TT} /><Bar dataKey="avg" name="cost per day">{ps.rows.map((_, k) => <Cell key={k} fill={k === ps.best ? 'var(--ok)' : 'var(--entering)'} />)}</Bar></BarChart></ResponsiveContainer></div></Card>
          <Card title="Policy table" bodyClass="p-2"><Tbl caption="Policy search" head={['S', 'Orders', 'Ordering', 'Holding', 'Shortage', 'Total', 'Per day', 'Fill rate']} rows={ps.rows.map(r => [r.S, r.orders, fmt(r.orderCost, 2), fmt(r.holdCost, 2), fmt(r.shortCost, 2), fmt(r.total, 2), fmt(r.avgPerDay, 4), `${fmt(r.fillRate * 100, 1)} %`])} hl={ps.best} maxH="max-h-[26rem]" /></Card>
        </> : null },
      { id: 'totals', label: <><BarChart3 size={14} /> Totals</>, node: <>{totals}<Card title="Cost identity" bodyClass="p-3"><p className="mono text-[0.95rem] break-words">{fmt(t.orderCost, 2)} ordering + {fmt(t.holdCost, 2)} holding + {fmt(t.shortCost, 2)} shortage = <b>{fmt(t.total, 2)}</b></p></Card></> },
    ];
  };

  const mtFacts = 'The Mersenne Twister MT19937 keeps 624 words of state and has a period of 2^19937 − 1. It passes the standard statistical batteries and is the default generator in Python, R and many simulation tools. It is not suitable for cryptography, because the state can be recovered from its output.';
  const rngTabs = (): TabDef[] => {
    const m = rg.method;
    const bad = rl?.error ? <Callout kind="bad" title="Check the inputs">{rl.error}</Callout> : null;
    const go = (method: SimRngSpec['method']) => <Btn size="sm" onClick={() => setRg({ method })}>Open the lab</Btn>;
    const way = (n: string, title: string, body: ReactNode, action?: ReactNode) => <Card key={n} title={<><span className="mono muted">{n}</span> {title}</>} right={action}><p className="text-[0.95rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>{body}</p></Card>;
    let lab: ReactNode = null;
    if (m === 'overview') {
      lab = <>
        {way('(i)', 'Physical (true) random sources', 'Measure something unpredictable: radioactive decay, thermal or atmospheric noise (the service at random.org does this), dice, coins, a spinning wheel. The numbers are genuinely random, but slow to collect, impossible to repeat and awkward to feed into a computer, so they are rarely used inside simulations directly.')}
        {way('(ii)', 'Random-number tables', 'Printed pages of digits produced once from a physical source, such as the RAND Corporation table of a million random digits (1955). Read them in a fixed order, for example two digits at a time along each row, and the experiment can be repeated exactly. This is the method used by hand in Experiment 10; a table is too short for long runs.', <Btn size="sm" onClick={() => setSpec(s => ({ ...s, kind: 'demand' }))}>Open demand table</Btn>)}
        {way('(iii)', 'Mid-square method (von Neumann, 1946)', 'Square the current number, write the square with twice as many digits (padding with zeros) and keep the middle digits as the next number. It is easy to do by hand but degenerates quickly: it often falls into a short cycle or sticks at 0 or at a fixed point.', go('midsquare'))}
        {way('(iv)', 'Linear congruential generator', <>X<sub>n+1</sub> = (a·X<sub>n</sub> + c) mod m, and the random number is u = X<sub>n+1</sub>/m. The period is at most m and equals m exactly when the Hull–Dobell conditions hold. The quality depends entirely on the choice of a, c and m.</>, go('lcg'))}
        {way('(v)', 'Mersenne Twister', mtFacts, go('mt'))}
        {way('(vi)', 'Inverse-transform sampling', 'Every method above produces uniform numbers. To get demand with a given distribution, find the smallest x whose cumulative probability F(x) is at least u. For a discrete table this is exactly the random-number-interval lookup of the Demand table variant.', go('inverse'))}
      </>;
    } else if (m === 'midsquare' || m === 'lcg') {
      const run = rl?.run;
      lab = <>
        {bad}
        {run && <>
          {run.warnings.map((w, i) => <Callout key={i} kind="warn">{w}</Callout>)}
          <Card title="First 10 steps of working" bodyClass="p-2"><Tbl caption="Steps of working" head={m === 'midsquare' ? ['n', 'Xₙ', 'Working', 'Xₙ₊₁', 'uₙ₊₁'] : ['n', 'Xₙ', 'Formula evaluated', 'Xₙ₊₁', 'uₙ₊₁']} rows={run.rows.map(r => [r.i - 1, r.x, r.working, r.next, fmt(r.next / run.modulus, 4)])} /></Card>
          <Card title="Cycle and period" right={<Badge kind={run.cycle.found ? 'info' : 'ok'}>{run.cycle.found ? `period ${run.cycle.length.toLocaleString()}` : `no repeat in ${run.cycle.scanned.toLocaleString()}`}</Badge>}>
            <p className="text-[0.95rem] leading-relaxed">{run.cycle.found
              ? <>Starting from X₀, the sequence {run.cycle.tail === 0 ? 'returns to the seed' : `runs for ${run.cycle.tail.toLocaleString()} number${run.cycle.tail === 1 ? '' : 's'} and then enters a cycle`} and repeats every <b className="mono">{run.cycle.length.toLocaleString()}</b> number{run.cycle.length === 1 ? '' : 's'}, out of {run.modulus.toLocaleString()} possible values{run.cycle.length === run.modulus ? ' (full period)' : ''}. After the cycle closes, the "random" numbers simply repeat.</>
              : <>No repeated value was found in the first {run.cycle.scanned.toLocaleString()} states, so the period is longer than that.</>}</p>
            {run.hullDobell && <div className="mt-3"><div className="eyebrow mb-1">Hull–Dobell full-period conditions {run.hullDobell.checked ? (run.hullDobell.full ? '(all met)' : '(not all met)') : '(not fully checked)'}</div><ul className="text-[0.92rem] flex flex-col gap-1">{run.hullDobell.items.map((it, i) => <li key={i} className="flex gap-2"><span aria-hidden="true" style={{ color: it.ok ? 'var(--ok)' : 'var(--bad)' }}>{it.ok ? '✓' : '✗'}</span><span>{it.text}</span></li>)}</ul></div>}
          </Card>
          {rl?.chi && <ChiCard chi={rl.chi} />}
          <PairsCard u={rl?.u ?? []} />
        </>}
      </>;
    } else if (m === 'mt') {
      lab = <>
        {bad}
        <Card title="Mersenne Twister (MT19937)"><p className="text-[0.95rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>{mtFacts} The seed in the Random numbers card makes the run repeatable.</p></Card>
        {rl?.u.length ? <Card title="First 10 numbers" bodyClass="p-2"><Tbl caption="First Mersenne Twister numbers" head={['n', 'u', 'two-digit random number']} rows={rl.u.slice(0, 10).map((u, i) => [i + 1, fmt(u, 6), String(Math.floor(u * 100)).padStart(2, '0')])} /></Card> : null}
        {rl?.chi && <ChiCard chi={rl.chi} />}
        {rl?.u.length ? <PairsCard u={rl.u} /> : null}
      </>;
    } else {
      const d = rl?.demo;
      lab = <>
        {bad}
        <Card title="Inverse-transform sampling" right={<Btn size="sm" onClick={() => setSpec(s => ({ ...s, kind: 'demand', demand: { ...dem, source: 'generate' } }))}>Open in Demand table</Btn>}><p className="text-[0.95rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>A uniform number u is turned into a demand by finding the interval of the cumulative table that contains it: the smallest x with F(x) ≥ u. Below, ten Mersenne Twister numbers drive the demand table of the Demand table variant (edit it there).</p></Card>
        {d && <>
          <Card title="Random-number intervals" bodyClass="p-2"><IntervalView t={d.sim.table} /></Card>
          <Card title="Ten draws" bodyClass="p-2"><Tbl caption="Inverse transform draws" head={['n', 'u', 'Random no.', 'Interval hit', 'Demand']} rows={d.sim.days.map((x, i) => [x.day, fmt(d.u[i] ?? 0, 6), x.rnLabel, x.interval, fmt(x.demand)])} /></Card>
        </>}
        {rl?.chi && <ChiCard chi={rl.chi} title="Chi-square test of the underlying uniform numbers" />}
      </>;
    }
    return [{ id: 'lab', label: <><FlaskConical size={14} /> Lab</>, node: <>{lab}<References /></> }];
  };

  const exampleSelect = (kind: SimSpec['kind'], load: (s: SimSpec) => Partial<SimSpec>) => (
    <label className="flex items-center gap-2 text-[0.9rem]">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('simulation').filter(y => (y.spec as SimSpec).kind === kind)[Number(e.target.value)]; if (x) setSpec(s => ({ ...s, ...load(structuredClone(x.spec) as SimSpec) })); }}><option value="" disabled>Choose…</option>{libraryFor('simulation').filter(y => (y.spec as SimSpec).kind === kind).map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
  );
  const textField = (label: string, value: string, onChange: (v: string) => void, hint?: string, numeric = false) => <Field label={label} hint={hint}>{id => <input id={id} className="input mono" inputMode={numeric ? 'numeric' : undefined} value={value} onChange={e => onChange(e.target.value)} />}</Field>;

  const demandInput = (
    <>
      <Card title="Demand table"><div className="flex flex-col gap-3">
        {exampleSelect('demand', x => ({ demand: x.demand }))}
        <TableEditor label="Demand" valueHead="Demand" rows={dem.rows} onChange={rows => setDem({ rows })} />
      </div></Card>
      <Card title="Random numbers and intervals">
        <RnSource source={dem.source} onSource={source => setDem({ source })} rns={dem.rns} onRns={rns => setDem({ rns })} label="Random numbers" count={dm?.sim ? dm.sim.days.length : null}
          convention={dem.convention} onConvention={convention => setDem({ convention })} digits={dem.digits} onDigits={digits => setDem({ digits })} days={dem.days} onDays={days => setDem({ days })} />
      </Card>
    </>
  );

  const inventoryInput = (
    <>
      <Card title="Policy"><div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          {textField('Order-up-to level S', inv.S, S => setInv({ S }), undefined, true)}
          {textField('Review every R days', inv.R, R => setInv({ R }), undefined, true)}
          {textField('Initial stock', inv.initial, initial => setInv({ initial }), undefined, true)}
          {textField('Ordering cost per order', inv.orderCost, orderCost => setInv({ orderCost }))}
          {textField('Holding cost / unit / day', inv.holdCost, holdCost => setInv({ holdCost }))}
          {textField('Shortage cost / unit short', inv.shortCost, shortCost => setInv({ shortCost }))}
        </div>
        <Segmented label="Unmet demand" value={inv.backorders ? 'back' : 'lost'} onChange={v => setInv({ backorders: v === 'back' })} options={[{ value: 'lost', label: 'Lost sales' }, { value: 'back', label: 'Backorders' }]} />
      </div></Card>
      <Card title="Demand table"><div className="flex flex-col gap-3">
        {exampleSelect('inventory', x => ({ inventory: x.inventory }))}
        <TableEditor label="Demand" valueHead="Demand" rows={inv.demand} onChange={demand => setInv({ demand })} />
      </div></Card>
      <Card title="Lead time (days)"><div className="flex flex-col gap-3">
        <Segmented label="Lead time" value={inv.leadMode} onChange={leadMode => setInv({ leadMode })} options={[{ value: 'fixed', label: 'Fixed' }, { value: 'table', label: 'Random (table)' }]} />
        {inv.leadMode === 'fixed'
          ? textField('Lead time', inv.leadFixed, leadFixed => setInv({ leadFixed }), '0 = the order arrives the next morning', true)
          : <TableEditor label="Lead time" valueHead="Days" rows={inv.lead} onChange={lead => setInv({ lead })} />}
      </div></Card>
      <Card title="Random numbers and intervals">
        <RnSource source={inv.source} onSource={source => setInv({ source })} rns={inv.rns} onRns={rns => setInv({ rns })} label="Demand random numbers" count={iv?.sim ? iv.sim.days.length : null}
          convention={inv.convention} onConvention={convention => setInv({ convention })} digits={inv.digits} onDigits={digits => setInv({ digits })} days={inv.days} onDays={days => setInv({ days })}
          extra={inv.source === 'given' && inv.leadMode === 'table' ? <Field label="Lead-time random numbers" hint="One per order placed, in order.">{id => <textarea id={id} className="textarea mono" rows={2} maxLength={90000} spellCheck={false} value={inv.leadRns} onChange={e => setInv({ leadRns: e.target.value })} />}</Field> : undefined} />
      </Card>
      <Card title="Policy search"><div className="grid grid-cols-3 gap-3">
        {textField('S from', inv.sFrom, sFrom => setInv({ sFrom }), undefined, true)}
        {textField('S to', inv.sTo, sTo => setInv({ sTo }), undefined, true)}
        {textField('Step', inv.sStep, sStep => setInv({ sStep }), undefined, true)}
      </div></Card>
    </>
  );

  const rngInput = (
    <Card title="Generator"><div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-[0.9rem]">Method<select className="select" aria-label="Generator method" value={rg.method} onChange={e => setRg({ method: e.target.value as SimRngSpec['method'] })}>{METHODS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
      {exampleSelect('rng', x => ({ rng: x.rng }))}
      {rg.method === 'midsquare' && <div className="grid grid-cols-2 gap-3">
        {textField('Seed X₀', rg.msSeed, msSeed => setRg({ msSeed }), undefined, true)}
        {textField('Digits', rg.msDigits, msDigits => setRg({ msDigits }), 'even: 2, 4, 6 or 8', true)}
      </div>}
      {rg.method === 'lcg' && <>
        <div className="grid grid-cols-2 gap-3">
          {textField('Multiplier a', rg.lcgA, lcgA => setRg({ lcgA }), undefined, true)}
          {textField('Increment c', rg.lcgC, lcgC => setRg({ lcgC }), undefined, true)}
          {textField('Modulus m', rg.lcgM, lcgM => setRg({ lcgM }), undefined, true)}
          {textField('Seed X₀', rg.lcgSeed, lcgSeed => setRg({ lcgSeed }), undefined, true)}
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn size="sm" onClick={() => setRg({ lcgA: '17', lcgC: '43', lcgM: '100', lcgSeed: '27' })}>Short cycle (17, 43, 100)</Btn>
          <Btn size="sm" onClick={() => setRg({ lcgA: '5', lcgC: '3', lcgM: '16', lcgSeed: '7' })}>Full period (5, 3, 16)</Btn>
          <Btn size="sm" onClick={() => setRg({ lcgA: '16807', lcgC: '0', lcgM: '2147483647', lcgSeed: '1' })}>Park–Miller</Btn>
        </div>
      </>}
      {rg.method !== 'overview' && textField('Sample size', rg.sample, sample => setRg({ sample }), 'numbers used for the uniformity test and the scatter plot', true)}
    </div></Card>
  );

  const newReport = () => {
    if (spec.kind === 'demand' && dm?.sim) {
      const sim = dm.sim, t = sim.table;
      return { title: 'Demand simulation (random-number intervals)', module: 'Simulation', method: 'Random-number interval table', problem: `Demand distribution: ${t.intervals.map(r => `${fmt(r.value)} with p = ${fmt(r.prob)}`).join('; ')}\nRandom numbers (${t.digits} digit${t.digits > 1 ? 's' : ''}, ${t.convention === 'zero' ? '00–' + String(t.modulus - 1).padStart(t.digits, '0') : '01–' + t.modulus}): ${sim.days.slice(0, 40).map(d => d.rnLabel).join(', ')}${sim.days.length > 40 ? ', …' : ''}`, steps: stepsToReport(dm.steps), result: { heading: 'Simulated demand', lines: [`Total demand = ${fmt(sim.total)} over ${sim.days.length} days`, `Mean demand = ${fmt(sim.mean, 4)}`, `Expected demand E[D] = ${fmt(sim.expected, 6)}`], tables: [reportTable('Cumulative table and random-number intervals', ['Demand', 'Probability', 'Cumulative', 'Random numbers', 'Count'], t.intervals.map(r => [fmt(r.value), fmt(r.prob), fmt(r.cum, 6), r.label, r.count])), reportTable('Simulation table', DAY_HEAD, dayRows(sim.days))] }, diagnostics: sim.warnings };
    }
    if (spec.kind === 'inventory' && iv?.sim && iv.sim.input) {
      const sim = iv.sim, i = sim.input!, t = sim.totals;
      const tables = [reportTable('Day-by-day table', INV_HEAD, invRows(sim.days))];
      if (iv.ps && !iv.ps.error) tables.push(reportTable('Policy search (same random numbers)', ['S', 'Orders', 'Ordering', 'Holding', 'Shortage', 'Total', 'Per day', 'Fill rate'], iv.ps.rows.map(r => [r.S, r.orders, fmt(r.orderCost, 2), fmt(r.holdCost, 2), fmt(r.shortCost, 2), fmt(r.total, 2), fmt(r.avgPerDay, 4), fmt(r.fillRate, 4)])));
      return { title: 'Inventory simulation', module: 'Simulation', method: 'Periodic review (R, S) policy', problem: `Order up to S = ${i.S} every R = ${i.R} days, initial stock ${i.initial}, ${i.days} days.\nCosts: ${fmt(i.orderCost)} per order, ${fmt(i.holdCost)} per unit per day held, ${fmt(i.shortCost)} per unit short; unmet demand is ${i.backorders ? 'backordered' : 'lost'}.\nDemand: ${sim.demandTable!.intervals.map(r => `${fmt(r.value)} (${r.label})`).join('; ')}\nLead time: ${sim.leadTable ? sim.leadTable.intervals.map(r => `${fmt(r.value)} (${r.label})`).join('; ') : `${i.leadFixed} day(s)`}`, steps: stepsToReport(iv.steps), result: { heading: 'Simulated cost', lines: [`Total cost = ${fmt(t.total, 2)} (ordering ${fmt(t.orderCost, 2)}, holding ${fmt(t.holdCost, 2)}, shortage ${fmt(t.shortCost, 2)})`, `Average cost per day = ${fmt(t.avgPerDay, 4)}`, `Demand ${t.demand}, sales ${t.sales}, fill rate ${fmt(t.fillRate * 100, 1)} %`, ...(iv.ps && !iv.ps.error ? [`Cheapest S in the search: ${iv.ps.bestS}`] : [])], tables }, diagnostics: sim.warnings };
    }
    if (spec.kind === 'rng' && rl && !rl.error && rg.method !== 'overview') {
      const lines: string[] = [];
      if (rl.run) lines.push(rl.run.cycle.found ? `Period ${rl.run.cycle.length} (cycle starts after ${rl.run.cycle.tail} numbers)` : `No repeat within ${rl.run.cycle.scanned} states`);
      if (rl.chi && !rl.chi.error) lines.push(`Chi-square (10 bins) = ${fmt(rl.chi.chi2, 3)}, ${rl.chi.df} df, p = ${formatP(rl.chi.p)}: ${rl.chi.pass ? 'uniformity not rejected' : 'uniformity rejected'}`);
      return { title: 'Random number generator lab', module: 'Simulation', method: METHODS.find(x => x.id === rg.method)?.label, problem: rg.method === 'midsquare' ? `Mid-square, seed ${rg.msSeed}, ${rg.msDigits} digits` : rg.method === 'lcg' ? `X(n+1) = (${rg.lcgA}·X(n) + ${rg.lcgC}) mod ${rg.lcgM}, X0 = ${rg.lcgSeed}` : `Mersenne Twister, seed ${spec.seed}`, steps: [], result: { heading: 'Findings', lines, tables: rl.run ? [reportTable('First steps of working', ['n', 'X(n)', 'Working', 'X(n+1)'], rl.run.rows.map(r => [r.i - 1, r.x, r.working, r.next]))] : [] }, diagnostics: rl.run?.warnings ?? [] };
    }
    return null;
  };

  const err = mc?.error ?? qs?.error ?? newErr;
  const buildReport = () => {
    const nr = newReport();
    if (nr) return nr;
    if (spec.kind === 'montecarlo' && mc && !mc.error) return { title: 'Monte Carlo simulation', module: 'Simulation', problem: `Variables: ${spec.vars.map(v => `${v.name} ~ ${describeDistribution(toDist(v.dist) as Distribution)}`).join('; ')}\nExpression: ${spec.expression}\nTrials: ${mc.n}, seed ${mc.seed}, generator ${mc.generator}`, steps: [], result: { heading: 'Estimate', lines: [`Mean = ${f(mc.mean, 5)} (95 % CI ${f(mc.ci95[0], 5)} … ${f(mc.ci95[1], 5)})`, `Std dev = ${f(mc.stdDev, 5)}, min ${f(mc.min)}, max ${f(mc.max)}`], tables: [{ caption: 'Percentiles', headers: ['Percentile', 'Value'], rows: mc.percentiles.map(p => [`${p.p}%`, f(p.value)]) }] }, diagnostics: [] };
    if (spec.kind === 'queue' && qs && !qs.error) return { title: 'Queue simulation', module: 'Simulation', problem: `Interarrival ${describeDistribution(toDist(spec.interarrival) as Distribution)}, service ${describeDistribution(toDist(spec.service) as Distribution)}, ${spec.servers} server(s), ${spec.customers} customers, seed ${qs.seed}`, steps: [], result: { heading: 'Estimates', lines: [`Average wait Wq = ${f(qs.avgWait)}`, `Average time in system = ${f(qs.avgSystemTime)}`, `Utilisation = ${f(qs.utilisation)}`, `Average queue length = ${f(qs.avgQueueLength)}`, `P(wait) = ${f(qs.probWait)}`], tables: [{ caption: 'Event trace (first 40)', headers: ['Time', 'Event', 'Customer', 'Queue', 'In system'], rows: qs.events.slice(0, 40).map(e => [f(e.time, 3), e.type, String(e.customer), String(e.queueLength), String(e.inSystem)]) }] }, diagnostics: qs.warnings };
    return null;
  };

  const classicTabs = [
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

  const tabs = spec.kind === 'demand' ? demandTabs() : spec.kind === 'inventory' ? inventoryTabs() : spec.kind === 'rng' ? rngTabs() : classicTabs;
  const mcMean = describeMean;
  void mcMean;
  return (
    <WorkspaceFrame
      moduleId="simulation" title="Simulation" accent="#ea580c" subtitle="Random-number tables · generators and tests · Monte Carlo · queue and inventory simulation"
      variants={[{ value: 'montecarlo', label: 'Monte Carlo' }, { value: 'queue', label: 'Queue sim' }, { value: 'demand', label: 'Demand table' }, { value: 'inventory', label: 'Inventory' }, { value: 'rng', label: 'RNG lab' }]} variant={spec.kind} onVariant={k => set({ kind: k })}
      input={<>
        {(spec.kind === 'montecarlo' || spec.kind === 'queue' || needSeed) && <Card title="Random numbers"><div className="grid grid-cols-2 gap-3">
          <Field label="Seed" hint="Same seed → identical results">{id => <input id={id} className="input mono" value={spec.seed} onChange={e => set({ seed: e.target.value })} />}</Field>
          {spec.kind !== 'rng' && <Field label="Generator">{id => <select id={id} className="select" value={spec.generator} onChange={e => set({ generator: e.target.value as 'lcg' | 'mt' })}><option value="mt">Mersenne Twister</option><option value="lcg">LCG (16807)</option></select>}</Field>}
          <div className="col-span-2 flex gap-2"><Btn onClick={() => set({ seed: String(Math.floor(Math.random() * 1e6)) })}>New random seed</Btn><Btn onClick={() => setRunKey(k => k + 1)}>Re-run</Btn></div>
        </div></Card>}
        {spec.kind === 'montecarlo' ? (
          <Card title="Experiment"><div className="flex flex-col gap-4">
            <label className="flex items-center gap-2 text-[0.9rem]">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('simulation').filter(y => (y.spec as SimSpec).kind === 'montecarlo')[Number(e.target.value)]; if (x) setSpec(structuredClone(x.spec) as SimSpec); }}><option value="" disabled>Choose…</option>{libraryFor('simulation').filter(y => (y.spec as SimSpec).kind === 'montecarlo').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
            {spec.vars.map((v, i) => <div key={i} className="flex flex-col gap-1 pb-3 border-b" style={{ borderColor: 'var(--border)' }}><div className="flex gap-2 items-center"><input className="input mono !w-20" aria-label={`Variable ${i + 1} name`} value={v.name} onChange={e => { const nv = e.target.value; upd(s => ({ vars: s.vars.map((x, k) => (k === i ? { ...x, name: nv } : x)) })); }} /><span className="muted">~</span><Btn size="sm" variant="ghost" onClick={() => upd(s => ({ vars: s.vars.filter((_, k) => k !== i) }))} aria-label={`Remove variable ${v.name}`}>remove</Btn></div><DistEditor label="" d={v.dist} onChange={d => upd(s => ({ vars: s.vars.map((x, k) => (k === i ? { ...x, dist: d } : x)) }))} /></div>)}
            <Btn size="sm" onClick={() => upd(s => ({ vars: [...s.vars, { name: `v${s.vars.length + 1}`, dist: { type: 'uniform', p1: '0', p2: '1', p3: '', values: '' } }] }))}>+ random variable</Btn>
            <Field label="Expression" hint="+ − * / ^, ( ), sqrt, exp, ln, sin, cos, abs, min, max, step(x) = 1 if x ≥ 0">{id => <input id={id} className="input mono" value={spec.expression} onChange={e => set({ expression: e.target.value })} />}</Field>
            <div className="grid grid-cols-2 gap-3"><Field label="Trials">{id => <input id={id} className="input mono" value={spec.trials} onChange={e => set({ trials: e.target.value })} />}</Field><Field label="Threshold (optional)" hint="estimate P(result ≥ t)">{id => <input id={id} className="input mono" value={spec.threshold} onChange={e => set({ threshold: e.target.value })} />}</Field></div>
          </div></Card>
        ) : spec.kind === 'queue' ? (
          <Card title="Queue"><div className="flex flex-col gap-4">
            <DistEditor label="Interarrival" d={spec.interarrival} onChange={d => set({ interarrival: d })} />
            <DistEditor label="Service" d={spec.service} onChange={d => set({ service: d })} />
            <div className="grid grid-cols-3 gap-3"><Field label="Servers">{id => <input id={id} className="input mono" value={spec.servers} onChange={e => set({ servers: e.target.value })} />}</Field><Field label="Customers">{id => <input id={id} className="input mono" value={spec.customers} onChange={e => set({ customers: e.target.value })} />}</Field><Field label="Warm-up">{id => <input id={id} className="input mono" value={spec.warmup} onChange={e => set({ warmup: e.target.value })} />}</Field></div>
          </div></Card>
        ) : spec.kind === 'demand' ? demandInput : spec.kind === 'inventory' ? inventoryInput : rngInput}
      </>}
      tabs={tabs}
      side={curStep && (spec.kind === 'demand' || spec.kind === 'inventory') ? <ExplanationPanel explanation={curStep.explanation} phase={curStep.phase} /> : <Card title="How to read this"><p className="text-[0.95rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>{spec.kind === 'demand' ? 'Each demand value gets a block of random numbers as large as its probability (the cumulative probability times 10^digits, rounded). A random number is looked up in the blocks and the demand of its block is that day\'s demand. Averaged over many days, the simulated demand approaches the expected demand.' : spec.kind === 'inventory' ? 'Each day starts with the stock carried over plus any delivery. Demand is drawn from the random-number table, sales are limited by the stock, and every review period an order brings the inventory position back up to S. Ordering, holding and shortage costs add up to the total; the policy search repeats the run with the same random numbers for other values of S.' : spec.kind === 'rng' ? 'A simulation is only as good as its random numbers. Mid-square and congruential generators are deterministic formulas: the same seed always gives the same sequence, which eventually repeats. The chi-square test checks that the numbers spread evenly over ten bins, and the scatter of consecutive pairs reveals hidden patterns.' : spec.kind === 'montecarlo' ? 'Each trial draws every random variable by inverse-transform sampling, evaluates your expression, and the average of all trials estimates its expected value. The shaded band is the 95 % confidence interval; it shrinks like 1/√n.' : 'Customers arrive after random interarrival times and are served first-come-first-served by the first free server. Statistics ignore the warm-up customers so the empty start does not bias them. With exponential times the result approaches the exact M/M/c formulas.'}</p></Card>}
      player={(spec.kind === 'demand' || spec.kind === 'inventory') && walkSteps.length > 0 ? <StepPlayer count={walkSteps.length} index={idx} onChange={setStep} labels={walkSteps.map(w => w.phase ?? '')} summary={curStep?.explanation.short} /> : undefined}
      step={idx}
      status={err ? <StatusBanner kind="bad" label="Check inputs">{err}</StatusBanner> : mc && !mc.error ? <StatusBanner kind="ok" label="Simulated"><span className="mono font-bold text-base">mean ≈ {f(mc.mean, 4)}</span><span className="text-[0.85rem]">{mc.n.toLocaleString()} trials · seed {mc.seed}</span></StatusBanner> : qs && !qs.error ? <StatusBanner kind={qs.warnings.some(w => /unstable/.test(w)) ? 'warn' : 'ok'} label="Simulated"><span className="mono font-bold text-base">Wq ≈ {f(qs.avgWait, 4)}</span><span className="text-[0.85rem]">{qs.customers.length.toLocaleString()} customers · seed {qs.seed}</span></StatusBanner> : dm?.sim ? <StatusBanner kind={dm.sim.warnings.length ? 'warn' : 'ok'} label="Simulated"><span className="mono font-bold text-base">total {fmt(dm.sim.total)} · mean {fmt(dm.sim.mean, 4)}</span><span className="text-[0.85rem]">E[D] = {fmt(dm.sim.expected, 4)} · {dm.sim.days.length.toLocaleString()} days</span></StatusBanner> : iv?.sim ? <StatusBanner kind={iv.sim.warnings.length ? 'warn' : 'ok'} label="Simulated"><span className="mono font-bold text-base">total cost {fmt(iv.sim.totals.total, 2)}</span><span className="text-[0.85rem]">{fmt(iv.sim.totals.avgPerDay, 3)} per day{iv.ps && !iv.ps.error ? ` · cheapest S = ${iv.ps.bestS}` : ''}</span></StatusBanner> : rl && !rl.error && rl.run ? <StatusBanner kind={rl.chi?.pass ? 'ok' : 'warn'} label="Generated"><span className="mono font-bold text-base">{rl.run.cycle.found ? `period ${rl.run.cycle.length.toLocaleString()}` : 'no repeat found'}</span><span className="text-[0.85rem]">{rl.chi && !rl.chi.error ? `χ² p = ${formatP(rl.chi.p)}` : ''}</span></StatusBanner> : null}
      saved={saved} onLoad={(m: SavedModel) => { setSpec(cleanKind(m.model as SimSpec)); setStep(0); }} buildReport={buildReport} pngRef={pngRef}
    />
  );
}
