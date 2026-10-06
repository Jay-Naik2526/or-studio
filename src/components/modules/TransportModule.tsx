import { useEffect, useMemo, useRef, useState } from 'react';
import { Grid3x3, GitCompare, BarChart3, ListTree } from 'lucide-react';
import { SavedModel, TransportModel, TransportState } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { TransportSolver, InitialMethod, compareInitialMethods } from '../../core/solvers/transport/transport';
import { libraryFor } from '../../data/library';
import { TransportSpec } from '../../data/specs';
import { parseNum } from '../../lib/numbers';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { TutorPanel, TutorQuestion, useTutorStats } from '../workspace/TutorPanel';
import { GridDiff } from '../workspace/GridDiff';
import { MatrixEditor, isBlocked } from '../input/MatrixEditor';
import { TransportGrid } from '../viz/TransportGrid';
import { Card, Callout, StatusBanner, statusKind, statusLabel, DiagnosticsList, Segmented, Badge } from '../ui/ui';
import { Q, QM } from '../ui/Q';
import { useInitial, useSaved, stepsToReport, diagText, clampStep } from './common';

const DEFAULT: TransportSpec = { rows: ['S1', 'S2', 'S3'], cols: ['D1', 'D2', 'D3', 'D4'], costs: [['10', '2', '20', '11'], ['12', '7', '9', '20'], ['4', '14', '16', '18']], supply: ['15', '25', '10'], demand: ['5', '15', '15', '15'], objective: 'min' };

export function toTransportModel(spec: TransportSpec): { model: TransportModel | null; error: string | null } {
  const num = (s: string, what: string): Rational | string => { const r = parseNum(s); return r.ok ? r.value : `${what}: ${r.error === 'empty' ? 'a value is missing' : r.error}`; };
  const supply: Rational[] = [], demand: Rational[] = [];
  for (const [k, s] of spec.supply.entries()) { const v = num(s, `Supply of ${spec.rows[k]}`); if (typeof v === 'string') return { model: null, error: v }; if (v.isNegative()) return { model: null, error: `Supply of ${spec.rows[k]} cannot be negative.` }; supply.push(v); }
  for (const [k, s] of spec.demand.entries()) { const v = num(s, `Demand of ${spec.cols[k]}`); if (typeof v === 'string') return { model: null, error: v }; if (v.isNegative()) return { model: null, error: `Demand of ${spec.cols[k]} cannot be negative.` }; demand.push(v); }
  const blocked = spec.costs.map(r => r.map(c => isBlocked(c)));
  const costs: Rational[][] = [];
  for (const [i, r] of spec.costs.entries()) { const row: Rational[] = []; for (const [j, c] of r.entries()) { if (blocked[i]![j]) { row.push(Rational.ZERO); continue; } const v = num(c, `Cost (${spec.rows[i]}, ${spec.cols[j]})`); if (typeof v === 'string') return { model: null, error: v }; row.push(v); } costs.push(row); }
  return { model: { supply, demand, costs, supplyNames: spec.rows, demandNames: spec.cols, objective: spec.objective, blocked: blocked.some(r => r.some(Boolean)) ? blocked : undefined }, error: null };
}

export default function TransportModule() {
  const init = useInitial<TransportSpec>('transport', DEFAULT);
  const [spec, setSpec] = useState<TransportSpec>(init.spec);
  const [variant, setVariant] = useState<InitialMethod>((['nwc', 'lcm', 'vam'].includes(init.variant ?? '') ? init.variant : 'vam') as InitialMethod);
  const [mode, setMode] = useState<'auto' | 'tutor'>('auto');
  const [stone, setStone] = useState(false);
  const [step, setStep] = useState(init.step);
  const pngRef = useRef<HTMLElement | null>(null);

  const { model, error } = useMemo(() => toTransportModel(spec), [spec]);
  const sol = useMemo(() => (model ? new TransportSolver().solve(model, { variant, stoneEval: stone }) : null), [model, variant, stone]);
  const comparison = useMemo(() => (model ? compareInitialMethods(model) : null), [model]);
  const steps = sol?.steps ?? [];
  const idx = clampStep(step, steps.length);
  const saved = useSaved('transport', spec, variant);
  const onLoad = (m: SavedModel) => { setSpec(m.model as TransportSpec); if (m.variant) setVariant(m.variant as InitialMethod); setStep(0); };
  const res = sol?.result;

  // tutor
  const [tIdx, setTIdx] = useState(0);
  const tstats = useTutorStats();
  useEffect(() => { setTIdx(0); tstats.reset(); }, [spec, variant, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const question = useMemo<TutorQuestion | null>(() => {
    if (!res || mode !== 'tutor') return null;
    const cur = steps[tIdx], nxt = steps[tIdx + 1];
    if (!cur || !nxt || !nxt.action) return null;
    const st = cur.state as TransportState;
    const k = nxt.action.kind;
    const p = nxt.action.payload as { row?: number; col?: number; row2?: number; entering?: { row: number; col: number } };
    const lab = (i: number, j: number) => `${st.rowLabels?.[i]} → ${st.colLabels?.[j]}`;
    if (k === 'allocate') {
      const open: { i: number; j: number }[] = [];
      st.allocations.forEach((r, i) => r.forEach((a, j) => { if (!st.crossedRows?.[i] && !st.crossedCols?.[j] && a === null) open.push({ i, j }); }));
      const why = variant === 'nwc' ? 'North-west corner: the top-left cell of the remaining table, whatever its cost.' : variant === 'lcm' ? 'Least-cost: the cheapest remaining cell.' : "Vogel: the cheapest cell on the row/column with the largest penalty.";
      return { id: `a${tIdx}`, prompt: `Which cell receives the next allocation (${variant.toUpperCase()})?`, hint: why, options: open.map(c => ({ id: `${c.i},${c.j}`, label: lab(c.i, c.j), correct: c.i === p.row && c.j === p.col, feedback: c.i === p.row && c.j === p.col ? nxt.explanation.short : `${lab(c.i, c.j)} (cost ${st.costs?.[c.i]?.[c.j]?.toString()}) is not what the rule picks. ${why}`, misconception: why })), reveal: nxt.explanation.short };
    }
    if (k === 'evaluate' && p.entering) {
      const ev = nxt.state as TransportState;
      const cells: { i: number; j: number }[] = [];
      ev.improvementIndices?.forEach((r, i) => r.forEach((d, j) => { if (d) cells.push({ i, j }); }));
      return { id: `e${tIdx}`, prompt: 'Compute cᵢⱼ − uᵢ − vⱼ for the empty cells. Which cell ENTERS the basis?', hint: 'The most negative improvement index.', options: cells.map(c => ({ id: `${c.i},${c.j}`, label: `${lab(c.i, c.j)}`, correct: c.i === p.entering!.row && c.j === p.entering!.col, feedback: c.i === p.entering!.row && c.j === p.entering!.col ? nxt.explanation.short : `${lab(c.i, c.j)} has index ${ev.improvementIndices![c.i]![c.j]!.toString()} — ${ev.improvementIndices![c.i]![c.j]!.isNegative() ? 'negative, but not the most negative.' : 'not negative, so shipping there would not lower the cost.'}`, misconception: 'Entering cell = most negative cᵢⱼ − uᵢ − vⱼ among non-basic cells.' })), reveal: nxt.explanation.short };
    }
    return null;
  }, [res, steps, tIdx, mode, variant]);
  const advance = () => {
    let k = tIdx + 1;
    while (k < steps.length - 1) { const a = steps[k + 1]?.action?.kind; if (a === 'allocate' || a === 'evaluate') break; k++; }
    setTIdx(Math.min(k, steps.length - 1));
  };

  const cur = steps[idx];
  const showSt = mode === 'tutor' ? steps[tIdx] : cur;
  const supplyStr = model ? res?.state.allocations.map((_, i) => (i < spec.supply.length ? spec.supply[i]! : (res.state.supplyLeft ? '' : ''))) : [];
  const fullSupply = (st: TransportState) => st.allocations.map((_, i) => (i < spec.supply.length ? spec.supply[i]! : sumDiff(model, true)));
  const fullDemand = (st: TransportState) => (st.allocations[0] ?? []).map((_, j) => (j < spec.demand.length ? spec.demand[j]! : sumDiff(model, false)));
  void supplyStr;

  const buildReport = () => {
    if (!sol || !model || !res) return null;
    return {
      title: 'Transportation problem', module: 'Transportation', method: `${variant.toUpperCase()} + MODI`,
      problem: `Supply: ${spec.rows.map((r, i) => `${r}=${spec.supply[i]}`).join(', ')}\nDemand: ${spec.cols.map((c, j) => `${c}=${spec.demand[j]}`).join(', ')}\nUnit costs (${spec.objective}):\n${spec.costs.map(r => '  ' + r.join('\t')).join('\n')}`,
      steps: stepsToReport(steps, st => ({ headers: ['', ...res.colLabels], rows: st.allocations.map((r, i) => [res.rowLabels[i]!, ...r.map(a => (a === null ? '–' : a.isZero() ? 'ε' : a.toString()))]) })),
      result: { heading: `Result: ${statusLabel(sol.status)}`, lines: [`Minimum cost = ${res.reportedObjective.toString()}`, `Initial solution cost = ${res.initialCost.toString()}`, `MODI iterations = ${res.modiIterations}`], tables: [{ caption: 'Optimal shipments', headers: ['From', 'To', 'Units', 'Unit cost'], rows: res.state.allocations.flatMap((r, i) => r.map((a, j) => (a && !a.isZero() ? [res.rowLabels[i]!, res.colLabels[j]!, a.toString(), res.costs[i]![j]!.toString()] : null)).filter(Boolean) as string[][]) }] },
      diagnostics: diagText(sol.diagnostics),
    };
  };

  const status = sol && <StatusBanner kind={sol.status === 'optimal' ? 'ok' : statusKind(sol.status)} label={statusLabel(sol.status)}>
    {res && <><span className="mono font-bold text-base">{spec.objective === 'max' ? 'profit' : 'cost'} = <QM v={res.reportedObjective} /></span><span className="text-[0.82rem]">start {variant.toUpperCase()} <span className="mono"><QM v={res.initialCost} /></span> → {res.modiIterations} MODI iteration{res.modiIterations === 1 ? '' : 's'}</span></>}
  </StatusBanner>;

  const tabs = [
    { id: 'grid', label: <><Grid3x3 size={13} /> Allocation</>, node: <>
      {error && <Callout kind="bad">{error}</Callout>}
      {model && showSt && res && (mode === 'tutor' ? (
        <>
          <Card title={`Grid — ${showSt.phase ?? ''}`} bodyClass="p-2"><TransportGrid state={showSt.state as TransportState} highlights={showSt.highlights} supply={fullSupply(showSt.state as TransportState)} demand={fullDemand(showSt.state as TransportState)} hideEval /></Card>
          <TutorPanel question={question} stats={tstats.stats} onResult={tstats.record} onAdvance={advance} finishedText={`Done: ${statusLabel(sol?.status ?? '')}, cost ${res.state.totalCost.toString()}.`} />
        </>
      ) : (
        <Card title={`Grid — ${showSt.phase ?? ''}`} bodyClass="p-2" right={<label className="flex items-center gap-1 text-[13px] normal-case tracking-normal font-medium"><input type="checkbox" checked={stone} onChange={e => setStone(e.target.checked)} /> stepping-stone table</label>}><TransportGrid state={showSt.state as TransportState} highlights={showSt.highlights} supply={fullSupply(showSt.state as TransportState)} demand={fullDemand(showSt.state as TransportState)} /></Card>
      ))}
      {mode === 'auto' && cur && (cur.state as TransportState).stoneEvals && (
        <Card title="Stepping-stone evaluation" icon={<ListTree size={14} />}><div className="overflow-x-auto"><table className="tbl text-xs"><thead><tr><th scope="col">Empty cell</th><th scope="col">Closed loop</th><th scope="col">Δ cost / unit</th></tr></thead><tbody>{(cur.state as TransportState).stoneEvals!.map((e, i) => <tr key={i}><th scope="row">{res?.rowLabels[e.row]} → {res?.colLabels[e.col]}</th><td className="!text-left">{e.loop.map(c => `${c.sign}${res?.rowLabels[c.row]}/${res?.colLabels[c.col]}`).join('  ')}</td><td className={e.change.isNegative() ? 'neg' : ''}><QM v={e.change} /></td></tr>)}</tbody></table></div></Card>
      )}
    </> },
    { id: 'compare', label: <><BarChart3 size={13} /> Method comparison</>, node: comparison?.length ? (
      <Card title="NWC vs Least-cost vs Vogel — same problem" right={<Badge kind="accent">F12</Badge>}>
        <div className="overflow-x-auto"><table className="tbl" aria-label="Method comparison"><thead><tr><th scope="col">Method</th><th scope="col">Initial cost</th><th scope="col">MODI iterations</th><th scope="col">Final cost</th></tr></thead><tbody>
          {comparison.map(r => <tr key={r.method} className={r.method === variant ? 'zrow' : ''}><th scope="row">{r.method === 'nwc' ? 'North-west corner' : r.method === 'lcm' ? 'Least-cost' : 'Vogel (VAM)'}</th><td><QM v={r.initialCost} /></td><td>{r.iterations}</td><td className="font-bold"><QM v={r.finalCost} /></td></tr>)}
        </tbody></table></div>
        <div className="mt-3 flex flex-col gap-1.5">{comparison.map(r => { const mx = Math.max(...comparison.map(x => Number(x.initialCost.a.toDecimal(4)))) || 1; const w = (Number(r.initialCost.a.toDecimal(4)) / mx) * 100; return <div key={r.method} className="flex items-center gap-2 text-xs"><span className="w-12 mono">{r.method.toUpperCase()}</span><div className="flex-1 h-4" style={{ background: 'var(--surface-3)' }}><div style={{ width: `${w}%`, background: r.method === 'vam' ? 'var(--ok)' : 'var(--text-3)', height: '100%' }} /></div><span className="mono w-12 text-right">{r.initialCost.toString()}</span></div>; })}</div>
        <p className="text-[0.82rem] muted mt-3">All three reach the same optimum, but a better starting solution needs fewer MODI iterations. Vogel usually starts closest.</p>
      </Card>
    ) : null },
    { id: 'diff', label: <><GitCompare size={13} /> Diff mode</>, node: <GridDiff title="Compare your allocation grid" steps={steps} extract={(s: TransportState) => ({ rowLabels: s.rowLabels ?? [], colLabels: s.colLabels ?? [], cells: s.allocations.map(r => r.map(a => (a === null ? null : a.isZero() ? '0' : a.toString()))) })} infer={(u, c) => (u.flat().filter(x => x !== null).length < c.flat().filter(x => x !== null).length ? 'You have fewer allocated cells than the basis needs (m + n − 1) — a zero (ε) allocation may be missing in a degenerate case.' : undefined)} /> },
  ];

  return (
    <WorkspaceFrame
      wide
      moduleId="transport" title="Transportation" accent="#059669" subtitle="Starting solution · MODI optimality · closed loops · method comparison"
      variants={[{ value: 'vam', label: 'Vogel' }, { value: 'lcm', label: 'Least-cost' }, { value: 'nwc', label: 'NW corner' }]} variant={variant} onVariant={v => { setVariant(v); setStep(0); }}
      mode={mode} onMode={setMode}
      input={<>
        <Card title="Costs, supply & demand">
          <div className="flex flex-col gap-3">
            <label className="flex items-center gap-2 text-xs">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('transport')[Number(e.target.value)]; if (x) { setSpec(structuredClone(x.spec) as TransportSpec); if (x.variant) setVariant(x.variant as InitialMethod); setStep(0); } }}><option value="" disabled>Choose…</option>{libraryFor('transport').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
            <Segmented label="Objective" value={spec.objective} onChange={o => setSpec(s => ({ ...s, objective: o }))} options={[{ value: 'min', label: 'Minimise cost' }, { value: 'max', label: 'Maximise profit' }]} />
            <MatrixEditor caption="Unit costs" values={spec.costs} onChange={costs => setSpec(s => ({ ...s, costs }))} rowLabels={spec.rows} colLabels={spec.cols} onRowLabels={rows => setSpec(s => ({ ...s, rows }))} onColLabels={cols => setSpec(s => ({ ...s, cols }))}
              rowExtra={{ label: 'Supply', values: spec.supply, onChange: supply => setSpec(s => ({ ...s, supply })) }} colExtra={{ label: 'Demand', values: spec.demand, onChange: demand => setSpec(s => ({ ...s, demand })) }} allowBlocked maxRows={8} maxCols={8} cornerLabel="from \ to" />
          </div>
        </Card>
        {error && <Callout kind="bad">{error}</Callout>}
        {sol && <DiagnosticsList items={sol.diagnostics} />}
      </>}
      tabs={tabs} side={showSt ? <ExplanationPanel explanation={showSt.explanation} phase={showSt.phase} /> : <Card><p className="text-sm muted">Fix the inputs to see the reasoning.</p></Card>}
      player={mode === 'auto' && steps.length > 0 ? <StepPlayer count={steps.length} index={idx} onChange={setStep} labels={steps.map(s => s.phase ?? '')} summary={cur?.explanation.short} /> : undefined}
      status={status} saved={saved} onLoad={onLoad} buildReport={buildReport} pngRef={pngRef} step={idx}
    />
  );
}

function sumDiff(model: TransportModel | null, supplySide: boolean): string {
  if (!model) return '';
  const ts = model.supply.reduce((a, b) => a.add(b), Rational.ZERO), td = model.demand.reduce((a, b) => a.add(b), Rational.ZERO);
  return (supplySide ? td.sub(ts) : ts.sub(td)).toString();
}

export { Q };
