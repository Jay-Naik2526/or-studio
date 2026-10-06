import { useMemo, useRef, useState } from 'react';
import { Boxes, LineChart as LC, Table2 } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceDot, ReferenceLine, Legend, AreaChart, Area, BarChart, Bar } from 'recharts';
import { SavedModel } from '../../core/types/models';
import { solveInventory, InventoryInput, InventoryResult } from '../../core/solvers/inventory/inventory';
import { normalCDF } from '../../core/solvers/project/cpm';
import { libraryFor } from '../../data/library';
import { InventorySpec } from '../../data/specs';
import { plainNum } from '../../lib/numbers';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { Card, Callout, StatusBanner, ResultStat, Field, Btn, Badge, Segmented } from '../ui/ui';
import { Katex } from '../ui/Katex';
import { useInitial, useSaved } from './common';

const DEFAULT = libraryFor('inventory')[0]!.spec as InventorySpec;
const MODELS = [{ value: 'eoq', label: 'EOQ' }, { value: 'epq', label: 'EPQ' }, { value: 'shortage', label: 'Shortages' }, { value: 'discount', label: 'Discounts' }, { value: 'newsvendor', label: 'Newsvendor' }] as const;
const f = (x: number | undefined, d = 2) => (x === undefined || !Number.isFinite(x) ? '—' : Number(x.toFixed(d)).toLocaleString('en-US', { maximumFractionDigits: d }));

function toInput(s: InventorySpec): InventoryInput {
  const n = (v: string) => plainNum(v) ?? undefined;
  return {
    model: s.model, demand: n(s.D), setupCost: n(s.K), holdingCost: n(s.h), holdingIsRate: s.hRate, unitCost: n(s.c), leadTime: n(s.L), productionRate: n(s.k), shortageCost: n(s.p),
    breaks: s.breaks.map(b => ({ minQty: plainNum(b.minQty) ?? 0, price: plainNum(b.price) ?? 0 })), discountType: s.discountType,
    sellingPrice: n(s.price), salvageValue: n(s.salvage), goodwill: n(s.goodwill), demandDist: s.dist, mean: n(s.mean), stdDev: n(s.sd), uniformMin: n(s.umin), uniformMax: n(s.umax),
    discrete: s.discrete.map(d => ({ demand: plainNum(d.demand) ?? 0, prob: plainNum(d.prob) ?? 0 })),
  };
}

export default function InventoryModule() {
  const init = useInitial<InventorySpec>('inventory', DEFAULT);
  const [spec, setSpec] = useState<InventorySpec>(init.spec);
  const pngRef = useRef<HTMLElement | null>(null);
  const res: InventoryResult = useMemo(() => solveInventory(toInput(spec)), [spec]);
  const saved = useSaved('inventory', spec);
  const set = (p: Partial<InventorySpec>) => setSpec(s => ({ ...s, ...p }));
  const m = spec.model;
  const inp = (label: string, key: keyof InventorySpec, hint?: string) => <Field label={label} hint={hint}>{id => <input id={id} className="input mono" inputMode="decimal" value={spec[key] as string} onChange={e => set({ [key]: e.target.value } as Partial<InventorySpec>)} />}</Field>;
  const a = res.annualCosts;

  const buildReport = () => (res.error ? null : { title: 'Inventory decision', module: 'Inventory', method: MODELS.find(x => x.value === m)!.label, problem: JSON.stringify(toInput(spec), (_k, v) => (v === undefined ? undefined : v), 1), steps: res.steps.map(s => ({ title: s.title, short: s.text, formula: s.formula })), result: { heading: 'Optimal policy', lines: res.interpretation, tables: [{ headers: ['Measure', 'Value'], rows: [['Q*', f(res.Q, 4)], ...(res.reorderPoint !== undefined ? [['Reorder point', f(res.reorderPoint, 4)]] : []), ...(a ? [['Ordering cost', f(a.ordering)], ['Holding cost', f(a.holding)], ['Total cost', f(a.total)]] : [])] }] }, diagnostics: [] });

  const newsPdf = useMemo(() => {
    if (m !== 'newsvendor' || !res.newsvendor) return [];
    if (spec.dist === 'discrete') return spec.discrete.map(d => ({ x: plainNum(d.demand) ?? 0, p: plainNum(d.prob) ?? 0 }));
    const mu = spec.dist === 'normal' ? plainNum(spec.mean) ?? 0 : ((plainNum(spec.umin) ?? 0) + (plainNum(spec.umax) ?? 0)) / 2;
    const sd = spec.dist === 'normal' ? plainNum(spec.sd) ?? 1 : ((plainNum(spec.umax) ?? 1) - (plainNum(spec.umin) ?? 0)) / Math.sqrt(12);
    return Array.from({ length: 80 }, (_, k) => { const x = mu - 3.5 * sd + (7 * sd * k) / 79; const z = (x - mu) / (sd || 1); return { x: Number(x.toFixed(2)), p: spec.dist === 'normal' ? Math.exp(-0.5 * z * z) / ((sd || 1) * Math.sqrt(2 * Math.PI)) : x >= (plainNum(spec.umin) ?? 0) && x <= (plainNum(spec.umax) ?? 0) ? 1 / (((plainNum(spec.umax) ?? 1) - (plainNum(spec.umin) ?? 0)) || 1) : 0, below: x <= (res.Q ?? 0) }; });
  }, [m, res, spec]);
  void normalCDF;

  const tabs = [
    { id: 'result', label: <><Boxes size={14} /> Policy</>, node: <>
      {res.error ? <Callout kind="bad" title="Check the inputs">{res.error}</Callout> : <>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px border" style={{ background: 'var(--border)', borderColor: 'var(--border)' }}>
          {[[m === 'newsvendor' ? 'Stock level' : 'Order quantity', f(res.Q, 2)], ...(res.reorderPoint !== undefined ? [['Reorder point', f(res.reorderPoint, 2)]] : []), ...(res.cycleTime !== undefined && m !== 'newsvendor' ? [['Cycle length', f(res.cycleTime, 4)]] : []), ...(res.ordersPerYear !== undefined && m !== 'newsvendor' ? [['Orders / period', f(res.ordersPerYear, 2)]] : []), ...(res.maxInventory !== undefined && m !== 'eoq' && m !== 'newsvendor' ? [['Max inventory', f(res.maxInventory, 2)]] : []), ...(res.maxShortage !== undefined ? [['Max backorder', f(res.maxShortage, 2)]] : []), ...(res.newsvendor ? [['Critical ratio', f(res.newsvendor.criticalRatio, 4)], ['Expected profit', f(res.newsvendor.expectedProfit)]] : [])].map(([k, v]) => <div key={k} className="p-4" style={{ background: 'var(--surface)' }}><div className="display text-3xl font-semibold" style={{ color: 'var(--text)' }}>{v}</div><div className="eyebrow mt-1">{k}</div></div>)}
        </div>
        {a && <Card title="Cost per period"><div className="grid grid-cols-2 md:grid-cols-5 gap-4"><ResultStat label="Ordering">{f(a.ordering)}</ResultStat><ResultStat label="Holding">{f(a.holding)}</ResultStat>{a.shortage !== undefined && a.shortage > 0 && <ResultStat label="Shortage">{f(a.shortage)}</ResultStat>}<ResultStat label="Purchase">{f(a.purchase)}</ResultStat><ResultStat label="Total" big>{f(a.total)}</ResultStat></div></Card>}
        {res.newsvendor && <Card title="Newsvendor measures"><div className="grid grid-cols-2 md:grid-cols-4 gap-4"><ResultStat label="Underage Cu">{f(res.newsvendor.underage)}</ResultStat><ResultStat label="Overage Co">{f(res.newsvendor.overage)}</ResultStat><ResultStat label="Service level">{f(res.newsvendor.serviceLevel * 100, 1)} %</ResultStat><ResultStat label="Stock-out risk">{f(res.newsvendor.stockoutProb * 100, 1)} %</ResultStat><ResultStat label="Exp. shortage">{f(res.newsvendor.expectedShortage)}</ResultStat><ResultStat label="Exp. leftover">{f(res.newsvendor.expectedLeftover)}</ResultStat></div></Card>}
        <Card title="In plain words"><ul className="list-disc pl-5 flex flex-col gap-1.5 text-[0.98rem]">{res.interpretation.map((t, i) => <li key={i}>{t}</li>)}</ul></Card>
        <Card title="Derivation">{res.steps.map((s, i) => <div key={i} className="mb-3"><div className="font-bold">{s.title}</div><p className="text-[0.95rem]" style={{ color: 'var(--text-2)' }}>{s.text}</p>{s.formula && <div className="overflow-x-auto"><Katex tex={s.formula} display /></div>}</div>)}</Card>
      </>}
    </> },
    { id: 'curve', label: <><LC size={14} /> Cost curve</>, node: res.error ? <Callout kind="bad">{res.error}</Callout> : m === 'newsvendor' ? (
      <Card title="Demand distribution and stocking level" bodyClass="p-3"><div style={{ height: 300 }}><ResponsiveContainer>{spec.dist === 'discrete' ? <BarChart data={newsPdf}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="x" tick={{ fontSize: 12, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={44} /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Bar dataKey="p" fill="var(--entering)" /><ReferenceLine x={res.Q} stroke="var(--series)" strokeWidth={2} label={{ value: 'Q*', fill: 'var(--series)', fontSize: 13 }} /></BarChart> : <AreaChart data={newsPdf}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 12, fill: 'var(--text-3)' }} /><YAxis hide /><Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Area dataKey="p" stroke="var(--entering)" fill="var(--entering-soft)" /><ReferenceLine x={res.Q} stroke="var(--series)" strokeWidth={2} label={{ value: `Q* = ${f(res.Q, 1)}`, fill: 'var(--series)', fontSize: 13, position: 'top' }} /></AreaChart>}</ResponsiveContainer></div><p className="text-sm muted px-2">The area to the left of Q* equals the critical ratio {f(res.newsvendor?.criticalRatio, 3)}: the probability of NOT running out.</p></Card>
    ) : (
      <Card title="Total cost against order quantity" bodyClass="p-3">
        <div style={{ height: 340 }}><ResponsiveContainer><LineChart data={res.curve ?? []} margin={{ left: 4, right: 18, top: 12, bottom: 6 }}><CartesianGrid stroke="var(--border)" strokeDasharray="3 3" /><XAxis dataKey="q" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(v: number) => String(Math.round(v))} tick={{ fontSize: 12, fill: 'var(--text-3)' }} label={{ value: 'order quantity Q', position: 'insideBottomRight', offset: -4, fontSize: 12, fill: 'var(--text-3)' }} /><YAxis tick={{ fontSize: 12, fill: 'var(--text-3)' }} width={58} domain={['auto', 'auto']} /><Tooltip formatter={(v: number) => f(v)} labelFormatter={(v: number) => `Q = ${f(v, 1)}`} contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', fontSize: 13 }} /><Legend />
          <Line dataKey="ordering" name="ordering" stroke="var(--entering)" strokeWidth={2} dot={false} /><Line dataKey="holding" name="holding" stroke="var(--leaving)" strokeWidth={2} dot={false} />{m === 'shortage' && <Line dataKey="shortage" name="shortage" stroke="var(--bad)" strokeWidth={2} dot={false} />}<Line dataKey="total" name="total" stroke="var(--series)" strokeWidth={3.2} dot={false} />
          {res.Q !== undefined && a && <ReferenceDot x={res.Q} y={m === 'discount' ? a.total : (a.ordering + a.holding + (a.shortage ?? 0) + a.purchase)} r={8} fill="var(--ok)" stroke="var(--surface)" strokeWidth={2} label={{ value: `Q* = ${f(res.Q, 1)}`, position: 'top', fill: 'var(--ok)', fontSize: 13 }} />}</LineChart></ResponsiveContainer></div>
        <p className="text-sm muted px-2">{m === 'discount' ? 'The jumps are the price breaks; the green dot is the cheapest feasible order quantity.' : 'Ordering cost falls and holding cost rises with Q; their sum is lowest where the two curves cross.'}</p>
      </Card>
    ) },
    { id: 'tiers', hidden: m !== 'discount', label: <><Table2 size={14} /> Price breaks</>, node: res.tiers ? <Card title="Tier comparison" bodyClass="p-2"><div className="overflow-x-auto"><table className="tbl"><thead><tr><th scope="col">Tier</th><th scope="col">Range</th><th scope="col">Price</th><th scope="col">Q* in tier</th><th scope="col">Order</th><th scope="col">Total cost</th><th scope="col" /></tr></thead><tbody>{res.tiers.map(t => <tr key={t.tier} className={t.isOptimal ? 'zrow' : ''}><th scope="row">{t.tier}</th><td>{f(t.minQty, 0)}–{t.maxQty === null ? '∞' : f(t.maxQty, 0)}</td><td>{f(t.price)}</td><td>{f(t.unconstrainedQ, 1)}</td><td>{f(t.usedQ, 1)}</td><td className="font-bold">{f(t.totalCost)}</td><td>{t.isOptimal ? <Badge kind="ok">best</Badge> : t.feasibleQ === null ? <Badge>dominated</Badge> : ''}</td></tr>)}</tbody></table></div><ul className="text-sm mt-3 list-disc pl-5 flex flex-col gap-1" style={{ color: 'var(--text-2)' }}>{res.tiers.map(t => <li key={t.tier}><b>Tier {t.tier}:</b> {t.note}</li>)}</ul></Card> : null },
  ];

  return (
    <WorkspaceFrame
      moduleId="inventory" title="Inventory" accent="#65a30d" subtitle="EOQ · production lots · shortages · quantity discounts · newsvendor"
      variants={MODELS.map(x => ({ value: x.value, label: x.label }))} variant={m} onVariant={v => set({ model: v })}
      input={<Card title="Parameters"><div className="flex flex-col gap-4">
        <label className="flex items-center gap-2 text-[0.9rem]">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('inventory')[Number(e.target.value)]; if (x) setSpec(structuredClone(x.spec) as InventorySpec); }}><option value="" disabled>Choose…</option>{libraryFor('inventory').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
        {m !== 'newsvendor' && <div className="grid grid-cols-2 gap-3">{inp('Demand D', 'D', 'per period')}{inp('Setup / order cost K', 'K')}</div>}
        {(m === 'eoq' || m === 'epq' || m === 'shortage') && <div className="grid grid-cols-2 gap-3">{inp('Holding cost h', 'h', 'per unit per period')}{inp('Unit cost c', 'c')}</div>}
        {m === 'eoq' && inp('Lead time L (optional)', 'L', 'same time unit as D')}
        {m === 'epq' && inp('Production rate k', 'k', 'must exceed D')}
        {m === 'shortage' && inp('Shortage cost p', 'p', 'per unit short per period')}
        {m === 'discount' && <>
          <Segmented label="Discount type" value={spec.discountType} onChange={v => set({ discountType: v })} options={[{ value: 'allUnits', label: 'All units' }, { value: 'incremental', label: 'Incremental' }]} />
          <div className="grid grid-cols-2 gap-3">{inp(spec.hRate ? 'Holding rate I' : 'Holding cost h', 'h', spec.hRate ? 'fraction of price, e.g. 0.2' : 'per unit per period')}<label className="flex items-end gap-2 text-[0.9rem] pb-2"><input type="checkbox" checked={spec.hRate} onChange={e => set({ hRate: e.target.checked })} /> h is a % of price</label></div>
          <div className="overflow-x-auto"><table className="tbl" aria-label="Price breaks"><thead><tr><th scope="col">From qty</th><th scope="col">Unit price</th><th scope="col" /></tr></thead><tbody>{spec.breaks.map((b, i) => <tr key={i}><td className="!p-0.5"><input className="input num !w-24" aria-label={`Break ${i + 1} quantity`} value={b.minQty} onChange={e => set({ breaks: spec.breaks.map((x, k) => (k === i ? { ...x, minQty: e.target.value } : x)) })} /></td><td className="!p-0.5"><input className="input num !w-24" aria-label={`Break ${i + 1} price`} value={b.price} onChange={e => set({ breaks: spec.breaks.map((x, k) => (k === i ? { ...x, price: e.target.value } : x)) })} /></td><td className="!p-0.5"><Btn size="sm" variant="ghost" onClick={() => set({ breaks: spec.breaks.filter((_, k) => k !== i) })} aria-label={`Remove break ${i + 1}`}>✕</Btn></td></tr>)}</tbody></table></div>
          <Btn size="sm" onClick={() => set({ breaks: [...spec.breaks, { minQty: String((plainNum(spec.breaks[spec.breaks.length - 1]?.minQty ?? '0') ?? 0) + 500), price: '0' }] })}>+ price break</Btn>
        </>}
        {m === 'newsvendor' && <>
          <div className="grid grid-cols-2 gap-3">{inp('Selling price p', 'price')}{inp('Unit cost c', 'c')}{inp('Salvage value s', 'salvage')}{inp('Goodwill / unit short', 'goodwill')}</div>
          <Segmented label="Demand distribution" value={spec.dist} onChange={v => set({ dist: v })} options={[{ value: 'normal', label: 'Normal' }, { value: 'uniform', label: 'Uniform' }, { value: 'discrete', label: 'Discrete' }]} />
          {spec.dist === 'normal' && <div className="grid grid-cols-2 gap-3">{inp('Mean μ', 'mean')}{inp('Std. dev σ', 'sd')}</div>}
          {spec.dist === 'uniform' && <div className="grid grid-cols-2 gap-3">{inp('Minimum', 'umin')}{inp('Maximum', 'umax')}</div>}
          {spec.dist === 'discrete' && <><table className="tbl"><thead><tr><th scope="col">Demand</th><th scope="col">Prob.</th><th scope="col" /></tr></thead><tbody>{spec.discrete.map((d, i) => <tr key={i}><td className="!p-0.5"><input className="input num !w-20" aria-label={`Demand ${i + 1}`} value={d.demand} onChange={e => set({ discrete: spec.discrete.map((x, k) => (k === i ? { ...x, demand: e.target.value } : x)) })} /></td><td className="!p-0.5"><input className="input num !w-20" aria-label={`Probability ${i + 1}`} value={d.prob} onChange={e => set({ discrete: spec.discrete.map((x, k) => (k === i ? { ...x, prob: e.target.value } : x)) })} /></td><td className="!p-0.5"><Btn size="sm" variant="ghost" aria-label={`Remove row ${i + 1}`} onClick={() => set({ discrete: spec.discrete.filter((_, k) => k !== i) })}>✕</Btn></td></tr>)}</tbody></table><Btn size="sm" onClick={() => set({ discrete: [...spec.discrete, { demand: '0', prob: '0' }] })}>+ demand level</Btn></>}
        </>}
      </div></Card>}
      tabs={tabs}
      side={<Card title="Reading the result"><p className="text-[0.95rem] leading-relaxed" style={{ color: 'var(--text-2)' }}>{res.error ?? res.interpretation[0]}</p></Card>}
      status={res.error ? <StatusBanner kind="bad" label="Check inputs">{res.error}</StatusBanner> : <StatusBanner kind="ok" label="Optimal policy"><span className="mono font-bold text-base">{m === 'newsvendor' ? 'stock' : 'Q*'} = {f(res.Q, 2)}</span>{a && <span className="text-[0.85rem]">total cost {f(a.total)}</span>}</StatusBanner>}
      saved={saved} onLoad={(mm: SavedModel) => setSpec(mm.model as InventorySpec)} buildReport={buildReport} pngRef={pngRef}
    />
  );
}
