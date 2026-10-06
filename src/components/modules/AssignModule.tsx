import { useEffect, useMemo, useRef, useState } from 'react';
import { Link2, GitCompare } from 'lucide-react';
import { SavedModel } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { HungarianSolver, AssignModel, AssignState } from '../../core/solvers/transport/hungarian';
import { libraryFor } from '../../data/library';
import { AssignSpec } from '../../data/specs';
import { parseNum } from '../../lib/numbers';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { TutorPanel, TutorQuestion, useTutorStats } from '../workspace/TutorPanel';
import { GridDiff } from '../workspace/GridDiff';
import { MatrixEditor, isBlocked } from '../input/MatrixEditor';
import { Card, Callout, StatusBanner, statusKind, statusLabel, DiagnosticsList, Segmented } from '../ui/ui';
import { Q, QM } from '../ui/Q';
import { useInitial, useSaved, stepsToReport, diagText, clampStep } from './common';

const DEFAULT: AssignSpec = { rows: ['Worker 1', 'Worker 2', 'Worker 3'], cols: ['Job 1', 'Job 2', 'Job 3'], costs: [['9', '2', '7'], ['6', '4', '3'], ['5', '8', '1']], objective: 'min' };

export function toAssignModel(spec: AssignSpec): { model: AssignModel | null; error: string | null } {
  const blocked = spec.costs.map(r => r.map(isBlocked));
  const costs: Rational[][] = [];
  for (const [i, r] of spec.costs.entries()) { const row: Rational[] = []; for (const [j, c] of r.entries()) { if (blocked[i]![j]) { row.push(Rational.ZERO); continue; } const v = parseNum(c); if (!v.ok) return { model: null, error: `Cell (${spec.rows[i]}, ${spec.cols[j]}): ${v.error === 'empty' ? 'a value is missing' : v.error}` }; row.push(v.value); } costs.push(row); }
  return { model: { costs, rowNames: spec.rows, colNames: spec.cols, objective: spec.objective, blocked: blocked.some(r => r.some(Boolean)) ? blocked : undefined }, error: null };
}

function MatrixView({ s }: { s: AssignState }) {
  const n = s.matrix.length;
  const match = new Set((s.assignment ?? s.matching ?? []).map(a => `${a.row},${a.col}`));
  return (
    <div className="overflow-x-auto">
      <table className="tbl" aria-label="Hungarian matrix">
        <thead><tr><th scope="col" className="rowhead" />{Array.from({ length: n }, (_, j) => <th key={j} scope="col" className={s.coveredCols[j] ? 'col-enter' : ''}>{s.colLabels[j]}{s.coveredCols[j] && <div className="text-[13px]" style={{ color: 'var(--entering)' }}>│ covered</div>}</th>)}</tr></thead>
        <tbody>
          {s.matrix.map((row, i) => (
            <tr key={i}>
              <th scope="row" className={s.coveredRows[i] ? 'row-leave' : ''}>{s.rowLabels[i]}{s.coveredRows[i] && <span className="text-[13px] ml-1" style={{ color: 'var(--leaving)' }}>─ covered</span>}</th>
              {row.map((v, j) => {
                const zero = v.isZero(), dbl = s.coveredRows[i] && s.coveredCols[j];
                const cls = [match.has(`${i},${j}`) ? 'pivot' : '', !match.has(`${i},${j}`) && s.coveredCols[j] && !s.coveredRows[i] ? 'col-enter' : '', !match.has(`${i},${j}`) && s.coveredRows[i] && !s.coveredCols[j] ? 'row-leave' : '', dbl ? 'blocked' : '', zero && !match.has(`${i},${j}`) ? 'basic' : ''].join(' ');
                return <td key={j} className={cls} title={dbl ? 'covered twice: the adjustment adds k here' : undefined}>{v.hasM() ? <QM v={v} /> : <Q v={v.a} />}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AssignModule() {
  const init = useInitial<AssignSpec>('assign', DEFAULT);
  const [spec, setSpec] = useState<AssignSpec>(init.spec);
  const [mode, setMode] = useState<'auto' | 'tutor'>('auto');
  const [step, setStep] = useState(init.step);
  const pngRef = useRef<HTMLElement | null>(null);
  const { model, error } = useMemo(() => toAssignModel(spec), [spec]);
  const sol = useMemo(() => (model ? new HungarianSolver().solve(model) : null), [model]);
  const steps = sol?.steps ?? [];
  const idx = clampStep(step, steps.length);
  const saved = useSaved('assign', spec);
  const onLoad = (m: SavedModel) => { setSpec(m.model as AssignSpec); setStep(0); };
  const res = sol?.result;

  const [tIdx, setTIdx] = useState(0);
  const tstats = useTutorStats();
  useEffect(() => { setTIdx(0); tstats.reset(); }, [spec, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  // first step at or after tIdx whose successor is a cover / adjust decision (reductions are shown, not asked)
  const qi = useMemo(() => {
    if (mode !== 'tutor') return -1;
    for (let t = tIdx; t < steps.length - 1; t++) if (['cover', 'adjust'].includes(steps[t + 1]!.action?.kind ?? '')) return t;
    return -1;
  }, [mode, steps, tIdx]);
  const question = useMemo<TutorQuestion | null>(() => {
    if (mode !== 'tutor' || qi < 0) return null;
    const nxt = steps[qi + 1];
    if (!nxt) return null;
    if (nxt.action?.kind === 'cover') {
      const lines = Number((nxt.action.payload as { lines: number }).lines);
      const n = (nxt.state as AssignState).matrix.length;
      const opts = Array.from({ length: n }, (_, k) => k + 1);
      return { id: `c${qi}`, prompt: `What is the MINIMUM number of horizontal/vertical lines that cover every zero in this matrix?`, hint: `If the answer equals n = ${n}, an optimal assignment exists; otherwise the matrix must be adjusted.`, options: opts.map(k => ({ id: String(k), label: `${k} line${k > 1 ? 's' : ''}`, correct: k === lines, feedback: k === lines ? nxt.explanation.short : k < lines ? `${k} lines are too few — some zero would stay uncovered.` : `A cover with ${lines} lines exists, so ${k} is not the minimum.`, misconception: 'Look for rows/columns with many zeros first, but verify with a maximum set of independent zeros (König).' })), reveal: nxt.explanation.short };
    }
    if (nxt.action?.kind === 'adjust') {
      const k = (nxt.action.payload as { k: string }).k;
      return { id: `k${qi}`, prompt: 'What is the smallest UNCOVERED entry k used for the adjustment?', options: [...new Set([k, ...((steps[qi]!.state as AssignState).matrix.flat().filter((_, q) => q < 6).map(v => v.toString()))])].slice(0, 5).map(v => ({ id: v, label: v, correct: v === k, feedback: v === k ? nxt.explanation.short : `The smallest uncovered entry is ${k}, not ${v}.`, misconception: 'k must come from cells NOT covered by any line.' })), reveal: nxt.explanation.short };
    }
    return null;
  }, [steps, qi, mode]);
  const advance = () => setTIdx(qi + 1);
  const tIdxShown = qi >= 0 ? qi : steps.length - 1;
  const showSt = mode === 'tutor' ? steps[tIdxShown] : steps[idx];

  const buildReport = () => {
    if (!sol || !res) return null;
    return {
      title: 'Assignment problem', module: 'Assignment', method: 'Hungarian method', problem: `${spec.objective === 'max' ? 'Maximise' : 'Minimise'} total ${spec.objective === 'max' ? 'profit' : 'cost'}\n\t${spec.cols.join('\t')}\n${spec.costs.map((r, i) => `${spec.rows[i]}\t${r.join('\t')}`).join('\n')}`,
      steps: stepsToReport(steps, s => ({ headers: ['', ...s.colLabels], rows: s.matrix.map((r, i) => [s.rowLabels[i]!, ...r.map(v => v.toString())]) })),
      result: { heading: `Result: ${statusLabel(sol.status)}`, lines: [`Total ${spec.objective === 'max' ? 'profit' : 'cost'} = ${res.objective.toString()}`], tables: [{ caption: 'Assignment', headers: ['Worker', 'Job', 'Value'], rows: res.assignment.filter(a => a.real).map(a => [res.state.rowLabels[a.row]!, res.state.colLabels[a.col]!, a.cost.toString()]) }] },
      diagnostics: diagText(sol.diagnostics),
    };
  };

  const status = sol && <StatusBanner kind={statusKind(sol.status)} label={statusLabel(sol.status)}>{res && <span className="mono font-bold text-base">total {spec.objective === 'max' ? 'profit' : 'cost'} = <Q v={res.objective} /></span>}{res?.alternateOptimum && <span className="text-[0.82rem]">alternate optimal assignments exist</span>}</StatusBanner>;

  const tabs = [
    { id: 'matrix', label: <><Link2 size={13} /> Hungarian</>, node: <>
      {error && <Callout kind="bad">{error}</Callout>}
      {showSt && <Card title={`Matrix — ${showSt.phase ?? ''}`} bodyClass="p-2"><MatrixView s={mode === 'tutor' ? (steps[tIdxShown]!.state as AssignState) : (showSt.state as AssignState)} /></Card>}
      {mode === 'tutor' && <TutorPanel question={question} stats={tstats.stats} onResult={tstats.record} onAdvance={advance} finishedText="Matrix solved — switch to Auto to see the final assignment." />}
      {mode === 'auto' && res && idx === steps.length - 1 && (
        <Card title="Optimal assignment"><div className="grid sm:grid-cols-2 gap-2">{res.assignment.map((a, i) => <div key={i} className="flex justify-between px-3 py-2 border mono text-sm" style={{ borderColor: 'var(--border)' }}><span>{res.state.rowLabels[a.row]} → {res.state.colLabels[a.col]}{!a.real && <span className="muted"> (dummy)</span>}</span><b><Q v={a.cost} /></b></div>)}</div></Card>
      )}
    </> },
    { id: 'diff', label: <><GitCompare size={13} /> Diff mode</>, node: <GridDiff title="Compare your reduced matrix" blankLabel="enter the matrix entries" steps={steps} extract={(s: AssignState) => ({ rowLabels: s.rowLabels, colLabels: s.colLabels, cells: s.matrix.map(r => r.map(v => v.toString())) })} cellWidth="w-12" infer={(u, c) => { const diff = u.flat().map((x, k) => ({ x, y: c.flat()[k] })).filter(p => p.x !== p.y); return diff.length > 0 && diff.length <= 2 ? 'Only a couple of entries differ — recheck the row / column subtraction in those cells.' : undefined; }} /> },
  ];

  return (
    <WorkspaceFrame
      wide
      moduleId="assign" title="Assignment" accent="#d97706" subtitle="Hungarian method · exact minimum line cover · rectangular · maximisation"
      mode={mode} onMode={setMode}
      input={<>
        <Card title="Cost matrix"><div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-xs">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('assign')[Number(e.target.value)]; if (x) { setSpec(structuredClone(x.spec) as AssignSpec); setStep(0); } }}><option value="" disabled>Choose…</option>{libraryFor('assign').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
          <Segmented label="Objective" value={spec.objective} onChange={o => setSpec(s => ({ ...s, objective: o }))} options={[{ value: 'min', label: 'Minimise cost' }, { value: 'max', label: 'Maximise profit' }]} />
          <MatrixEditor caption="Assignment costs" values={spec.costs} onChange={costs => setSpec(s => ({ ...s, costs }))} rowLabels={spec.rows} colLabels={spec.cols} onRowLabels={rows => setSpec(s => ({ ...s, rows }))} onColLabels={cols => setSpec(s => ({ ...s, cols }))} allowBlocked maxRows={10} maxCols={10} cornerLabel="worker \ job" />
        </div></Card>
        {error && <Callout kind="bad">{error}</Callout>}
        {sol && <DiagnosticsList items={sol.diagnostics} />}
      </>}
      tabs={tabs} side={showSt ? <ExplanationPanel explanation={showSt.explanation} phase={showSt.phase} /> : <Card><p className="text-sm muted">Fix the inputs.</p></Card>}
      player={mode === 'auto' && steps.length > 0 ? <StepPlayer count={steps.length} index={idx} onChange={setStep} labels={steps.map(s => s.phase ?? '')} summary={steps[idx]?.explanation.short} /> : undefined}
      status={status} saved={saved} onLoad={onLoad} buildReport={buildReport} pngRef={pngRef} step={idx}
    />
  );
}
