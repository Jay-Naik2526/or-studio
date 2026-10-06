import { useMemo, useRef, useState, useEffect } from 'react';
import { Calculator, GitCompare, BarChart3, Target, Ban, ArrowRightLeft } from 'lucide-react';
import { LPModel, SavedModel, Tableau } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { solveLP, LPMethod, LPSolution } from '../../core/solvers/lp/engine';
import { formatLP } from '../../core/parse/algebraic';
import { verifyEntering, verifyLeaving, dualEnteringCandidates, verifyDualLeaving, verifyDualEntering } from '../../core/solvers/lp/tutor';
import { DiffComparator } from '../../core/diff/comparator';
import { StateDiff } from '../../core/types/solver';
import { LIBRARY, libraryFor } from '../../data/library';
import { LPSpec } from '../../data/specs';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { TutorPanel, TutorQuestion, useTutorStats } from '../workspace/TutorPanel';
import { LPInput, parseLPText } from '../input/LPInput';
import { TableauView } from '../viz/TableauView';
import { FeasibleRegion } from '../viz/FeasibleRegion';
import { SensitivityView } from '../viz/SensitivityView';
import { Card, Callout, StatusBanner, statusKind, statusLabel, DiagnosticsList, Badge, Btn, Field } from '../ui/ui';
import { Q } from '../ui/Q';
import { Katex } from '../ui/Katex';
import { useInitial, useSaved, tableauTable, stepsToReport, diagText, clampStep } from './common';
import { parseNum } from '../../lib/numbers';
import { setQuery } from '../../lib/router';

const DEFAULT: LPSpec = { text: 'max 3x1 + 5x2\nsubject to\n  x1 <= 4\n  2x2 <= 12\n  3x1 + 2x2 <= 18\n  x1, x2 >= 0' };

type Variant = LPMethod;
const VARIANTS: { value: Variant; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Standard simplex when every row is ≤ with RHS ≥ 0, otherwise Two-Phase' },
  { value: 'standard', label: 'Simplex', title: 'Standard tableau simplex (slack basis)' },
  { value: 'twoPhase', label: 'Two-Phase', title: 'Phase I minimises artificials, Phase II optimises' },
  { value: 'bigM', label: 'Big-M', title: 'Artificial variables with symbolic −M cost' },
  { value: 'dual', label: 'Dual', title: 'Dual simplex from an optimal-but-infeasible basis' },
];

export default function LPModule() {
  const init = useInitial<LPSpec>('lp', DEFAULT);
  const [text, setText] = useState(init.spec.text);
  const [variant, setVariant] = useState<Variant>((init.variant as Variant) ?? 'auto');
  const [mode, setMode] = useState<'auto' | 'tutor'>('auto');
  const [step, setStep] = useState(init.step);
  const pngRef = useRef<HTMLElement | null>(null);

  const parsed = useMemo(() => parseLPText(text), [text]);
  const model = parsed.model;
  const solution = useMemo<LPSolution | null>(() => (model ? solveLP(model, { method: variant }) : null), [model, variant]);
  const lastGood = useRef<LPSolution | null>(null);
  if (solution) lastGood.current = solution;
  const sol = solution ?? lastGood.current;
  const steps = sol?.steps ?? [];
  const idx = clampStep(step, steps.length);
  useEffect(() => { setQuery({ step: idx > 0 ? String(idx) : undefined }); }, [idx]);

  const saved = useSaved('lp', { text } satisfies LPSpec, variant);
  const onLoad = (m: SavedModel) => { setText((m.model as LPSpec).text); if (m.variant) setVariant(m.variant as Variant); setStep(0); setTutorIdx(0); };

  // ---------------- tutor ----------------
  const [tutorIdx, setTutorIdx] = useState(0);
  const [stage, setStage] = useState<'entering' | 'leaving' | 'dual-entering'>('entering');
  const [chosenEnter, setChosenEnter] = useState<number | null>(null);
  const [chosenRow, setChosenRow] = useState<number | null>(null);
  const tstats = useTutorStats();
  useEffect(() => { setTutorIdx(0); setStage('entering'); setChosenEnter(null); tstats.reset(); }, [text, variant, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const tStep = steps[Math.min(tutorIdx, Math.max(0, steps.length - 1))];
  const tTab = tStep?.state;
  const advanceTutor = () => {
    setStage('entering'); setChosenEnter(null); setChosenRow(null);
    setTutorIdx(i => Math.min(steps.length - 1, i + 1));
  };
  const question = useMemo<TutorQuestion | null>(() => {
    if (!tTab || !tTab.nextPivot) return null;
    const t = tTab;
    const np = tTab.nextPivot;
    const nameOf = (j: number) => t.columnNames[j]!;
    if (t.method === 'dual') {
      if (stage === 'entering') {
        const row = chosenRow ?? np.leavingRow;
        const cands = dualEnteringCandidates(t, row);
        const nonCand = t.columnNames.map((_, j) => j).filter(j => !cands.some(c => c.id === `enter:${j}`) && !t.basis.includes(j) && t.columnTypes[j] !== 'artificial');
        const mk = (j: number) => { const f = verifyDualEntering(t, row, j); return { id: `e${j}`, label: nameOf(j), correct: f.correct, feedback: f.message, misconception: f.misconception }; };
        return { id: `${tutorIdx}-de`, prompt: `Row of ${nameOf(t.basis[row]!)} leaves. Which variable enters (dual ratio test)?`, hint: 'Consider only negative entries in the pivot row; minimise |z-row ÷ entry|.', options: [...cands.map(c => mk(Number(c.id.split(':')[1]))), ...nonCand.map(mk)], reveal: `Enter ${nameOf(np.enteringCol)}.` };
      }
      const mk = (i: number) => { const f = verifyDualLeaving(t, i); return { id: `r${i}`, label: `${nameOf(t.basis[i]!)} (RHS ${t.rhs[i]!.toString()})`, correct: f.correct, feedback: f.message, misconception: f.misconception }; };
      return { id: `${tutorIdx}-dl`, prompt: 'Which basic variable leaves? (the dual simplex chooses the leaving variable first)', hint: 'Look for the most negative right-hand side.', options: t.rhs.map((_, i) => i).map(mk), reveal: `${nameOf(t.basis[np.leavingRow]!)} leaves.` };
    }
    if (stage === 'entering') {
      const nonbasic = t.columnNames.map((_, j) => j).filter(j => !t.basis.includes(j) && t.columnTypes[j] !== 'artificial');
      return {
        id: `${tutorIdx}-e`,
        prompt: `Which variable should ENTER the basis? (z-row of ${t.objectiveSense === 'min' ? 'the max-form tableau' : 'this tableau'})`,
        hint: 'Entering rule: the most negative entry in the z-row.',
        options: nonbasic.map(j => { const f = verifyEntering(t, j); return { id: `e${j}`, label: nameOf(j), correct: f.correct, feedback: f.message, misconception: f.misconception }; }),
        reveal: `${nameOf(np.enteringCol)} enters (reduced cost ${t.bigMRow ? '' : t.objectiveRow[np.enteringCol]!.toString()}).`,
      };
    }
    const col = chosenEnter ?? np.enteringCol;
    return {
      id: `${tutorIdx}-l`,
      prompt: `${nameOf(col)} enters. Do the ratio test — which basic variable LEAVES?`,
      hint: 'Divide the RHS by each POSITIVE entry of the entering column; pick the smallest ratio.',
      options: t.matrix.map((_, i) => { const f = verifyLeaving(t, col, i); return { id: `r${i}`, label: `${nameOf(t.basis[i]!)}  (${t.matrix[i]![col]!.toString()})`, correct: f.correct, feedback: f.message, misconception: f.misconception }; }),
      reveal: `${nameOf(t.basis[np.leavingRow]!)} leaves.`,
    };
  }, [tTab, stage, tutorIdx, chosenEnter, chosenRow]);

  const onTutorAdvance = () => {
    if (!tTab || !tTab.nextPivot) return advanceTutor();
    if (tTab.method === 'dual') {
      if (stage === 'entering') return advanceTutor();
      setChosenRow(tTab.nextPivot.leavingRow);
      setStage('entering');
      return;
    }
    if (stage === 'entering') { setChosenEnter(tTab.nextPivot.enteringCol); setStage('leaving'); return; }
    advanceTutor();
  };
  const tutorOver = mode === 'tutor' && (!tTab?.nextPivot);

  // ---------------- report ----------------
  const buildReport = () => {
    if (!sol || !model) return null;
    const res = sol.result;
    return {
      title: 'Linear programme',
      module: 'Linear programming',
      method: sol.methodUsed === 'standard' ? 'Standard simplex' : sol.methodUsed === 'twoPhase' ? 'Two-phase simplex' : sol.methodUsed === 'bigM' ? 'Big-M simplex' : 'Dual simplex',
      problem: formatLP(model),
      steps: stepsToReport(steps, s => tableauTable(s)),
      result: {
        heading: `Result: ${statusLabel(sol.status)}`,
        lines: res ? [`Objective value = ${res.objectiveValue.toString()}`, ...model.varNames.map((n, j) => `${n} = ${res.variableValues[j]!.toString()}`)] : [statusLabel(sol.status)],
        tables: res ? [{ caption: 'Optimal solution', headers: ['Variable', 'Value'], rows: [...model.varNames.map((n, j) => [n, res.variableValues[j]!.toString()]), ['z', res.objectiveValue.toString()]] }, { caption: 'Constraints', headers: ['Constraint', 'Slack / surplus', 'Shadow price'], rows: model.constraints.map((c, i) => [c.name ?? `(${i + 1})`, res.slackValues[i]!.toString(), res.dualValues[i]!.toString()]) }] : undefined,
      },
      diagnostics: sol ? diagText(sol.diagnostics) : [],
    };
  };

  const cur = steps[idx];
  const showStep = mode === 'tutor' ? tStep : cur;

  const status = sol && (
    <StatusBanner kind={statusKind(sol.status)} label={statusLabel(sol.status)}>
      {sol.result && (sol.status === 'optimal' || sol.status === 'optimal-alternate-exists' || sol.status === 'iteration-limit') && (
        <span className="mono font-bold text-base">{model && model.sense === 'max' ? 'max' : 'min'} z = <Q v={sol.result.objectiveValue} /></span>
      )}
      <span className="text-[0.82rem] opacity-90">{methodName(sol)} · {sol.metrics.iterations} pivot{sol.metrics.iterations === 1 ? '' : 's'} · {sol.metrics.elapsedMs} ms</span>
    </StatusBanner>
  );

  const resultCard = sol && model && <ResultCard sol={sol} model={model} />;

  const tabs = [
    {
      id: 'simplex',
      label: <span className="inline-flex items-center gap-1"><Calculator size={13} /> Simplex</span>,
      node: (
        <>
          {sol?.redirected && <Callout kind="info" title={`Switched to ${methodName(sol)}`}>{sol.redirectReason}</Callout>}
          {mode === 'tutor' ? (
            <>
              {tStep && <Card title={`Tableau — ${tStep.phase ?? ''}`} bodyClass="p-2"><TableauView tableau={tStep.state} highlights={tStep.highlights} hideNext caption="Tutor tableau" /></Card>}
              <TutorPanel question={tutorOver ? null : question} stats={tstats.stats} onResult={tstats.record} onAdvance={onTutorAdvance}
                finishedText={tTab && tutorIdx >= steps.length - 1 ? `Finished: ${statusLabel(sol?.status ?? '')}.` : 'No more pivot decisions here — continue to the next step.'} />
              {tutorOver && tutorIdx < steps.length - 1 && <div><Btn variant="primary" onClick={advanceTutor}>Continue →</Btn></div>}
            </>
          ) : (
            cur && <Card title={`Tableau — ${cur.phase ?? ''}`} bodyClass="p-2" right={cur.state.phase ? <Badge kind="accent">Phase {cur.state.phase}</Badge> : undefined}><TableauView tableau={cur.state} highlights={cur.highlights} /></Card>
          )}
          {(mode === 'auto' || (tutorOver && tutorIdx >= steps.length - 1)) && resultCard}
        </>
      ),
    },
    { id: 'graph', hidden: !model || model.objective.length !== 2, label: <span className="inline-flex items-center gap-1"><Target size={13} /> Graphical</span>, node: model && model.objective.length === 2 ? <FeasibleRegion model={model} onRhsChange={(i, v) => setText(formatLP({ ...model, constraints: model.constraints.map((c, k) => (k === i ? { ...c, rhs: Rational.parse(String(v)) } : c)) }))} /> : null },
    { id: 'sens', label: <span className="inline-flex items-center gap-1"><BarChart3 size={13} /> Sensitivity</span>, node: model && sol ? <SensitivityView model={model} solution={sol} /> : null },
    { id: 'diff', label: <span className="inline-flex items-center gap-1"><GitCompare size={13} /> Diff mode</span>, node: <TableauDiff steps={steps} /> },
  ];

  const libs = libraryFor('lp').map(e => ({ label: e.title, text: (e.spec as LPSpec).text }));

  return (
    <WorkspaceFrame
      moduleId="lp"
      title="Linear programming"
      subtitle="Simplex · Two-Phase · Big-M · Dual · Graphical · Sensitivity"
      variants={VARIANTS}
      variant={variant}
      onVariant={v => { setVariant(v); setStep(0); }}
      mode={mode}
      onMode={setMode}
      input={
        <>
          <LPInput text={text} onText={t => { setText(t); setStep(0); }} model={model} error={parsed.error} warnings={parsed.warnings} examples={libs} />
          {sol && <DiagnosticsList items={sol.diagnostics} />}
        </>
      }
      tabs={tabs}
      side={showStep ? <><ExplanationPanel explanation={showStep.explanation} phase={showStep.phase} />{sol?.standardForm && sol.standardForm.notes.length > 0 && idx === 0 && <Card title="Normalisation"><ul className="list-disc pl-4 text-[0.82rem] flex flex-col gap-1">{sol.standardForm.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></Card>}</> : <Card><p className="text-sm muted">Fix the model to see an explanation.</p></Card>}
      player={mode === 'auto' && steps.length > 0 ? <StepPlayer count={steps.length} index={idx} onChange={setStep} labels={steps.map(s => s.phase ?? '')} summary={cur?.explanation.short} /> : undefined}
      status={status}
      saved={saved}
      onLoad={onLoad}
      buildReport={buildReport}
      pngRef={pngRef}
      step={idx}
    />
  );
}

function methodName(s: LPSolution): string {
  return s.methodUsed === 'standard' ? 'Standard simplex' : s.methodUsed === 'twoPhase' ? 'Two-Phase simplex' : s.methodUsed === 'bigM' ? 'Big-M simplex' : 'Dual simplex';
}

function ResultCard({ sol, model }: { sol: LPSolution; model: LPModel }) {
  const res = sol.result;
  const [showAlt, setShowAlt] = useState(false);
  const infeas = sol.diagnostics.find(d => d.code === 'INFEASIBLE');
  if (sol.status === 'infeasible') {
    return (
      <Card title="Why it is infeasible" icon={<Ban size={14} />}>
        <div className="flex flex-col gap-2 text-sm">
          <p>{infeas?.message}</p>
          {infeas?.detail && <div className="callout callout-info"><div><div className="eyebrow">Contradictory combination (Farkas certificate)</div><div className="mono text-[0.82rem] mt-1">{infeas.detail}</div><div className="text-[0.82rem] mt-1 muted">Adding these multiples of the constraints gives a statement like 0 ≥ positive number, which no point can satisfy.</div></div></div>}
        </div>
      </Card>
    );
  }
  if (sol.status === 'unbounded' && res?.unboundedRay) {
    const dir = res.unboundedRay.direction.map((d, j) => ({ d, n: model.varNames[j]! })).filter(x => !x.d.isZero());
    return (
      <Card title="Unbounded direction" icon={<ArrowRightLeft size={14} />}>
        <p className="text-sm">From any feasible point, moving along <b className="mono">{dir.map(x => `${x.d.isPositive() ? '+' : '−'}${x.d.abs().toString()}·${x.n}`).join(', ')}</b> per unit step keeps every constraint satisfied while {model.sense === 'max' ? 'increasing' : 'decreasing'} the objective forever. A constraint limiting {res.unboundedRay.enteringVar} (or a linear combination involving {dir.map(x => x.n).join(', ')}) is missing from the model.</p>
      </Card>
    );
  }
  if (!res) return null;
  return (
    <Card title="Solution" icon={<Calculator size={14} />} right={res.degenerate ? <Badge kind="warn">degenerate</Badge> : undefined}>
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="overflow-x-auto">
          <table className="tbl" aria-label="Variable values">
            <thead><tr><th scope="col">Variable</th><th scope="col">Value</th></tr></thead>
            <tbody>
              {model.varNames.map((n, j) => <tr key={j}><th scope="row">{n}</th><td className="font-bold"><Q v={res.variableValues[j]!} dec /></td></tr>)}
              <tr className="zrow"><th scope="row">z</th><td className="zrow"><Q v={res.objectiveValue} dec /></td></tr>
            </tbody>
          </table>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl" aria-label="Constraint status">
            <thead><tr><th scope="col">Constraint</th><th scope="col">Slack</th><th scope="col" title="∂z/∂b">Shadow price</th></tr></thead>
            <tbody>
              {model.constraints.map((c, i) => (
                <tr key={i}><th scope="row">{c.name ?? `(${i + 1})`}{res.slackValues[i]!.isZero() && c.relation !== '=' && <Badge kind="warn" title="binding"> tight</Badge>}</th><td><Q v={res.slackValues[i]!} /></td><td><Q v={res.dualValues[i]!} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {res.alternateOptimum && (
        <div className="mt-3 flex flex-col gap-2">
          <Callout kind="info" title="Alternate optima">
            {res.alternateOptimum.unboundedFace ? 'The optimal face is unbounded: infinitely many optimal solutions along a ray.' : <>A second optimal vertex exists with the same objective value; every point on the edge between them is optimal.{' '}<button className="underline cursor-pointer" onClick={() => setShowAlt(!showAlt)}>{showAlt ? 'hide' : 'show second vertex'}</button></>}
          </Callout>
          {showAlt && !res.alternateOptimum.unboundedFace && <div className="mono text-sm">{model.varNames.map((n, j) => <span key={j} className="mr-4">{n} = <Q v={res.alternateOptimum!.variableValues[j]!} /></span>)}</div>}
        </div>
      )}
      {res.redundantConstraints && <div className="mt-3"><Callout kind="warn">Redundant constraint(s): {res.redundantConstraints.map(i => model.constraints[i]?.name ?? `(${i + 1})`).join(', ')} — implied by the others.</Callout></div>}
      {sol.status === 'optimal' && <div className="mt-3 text-[0.82rem] muted"><Katex tex={`z^* = ${res.objectiveValue.toLatex()}`} /></div>}
    </Card>
  );
}

/* ------------------------- Diff mode for tableaux ------------------------- */

export function TableauDiff({ steps }: { steps: { state: Tableau; phase?: string; index: number; explanation: { short: string }; action: unknown; highlights: unknown[]; status: unknown }[] }) {
  const [k, setK] = useState(Math.min(1, Math.max(0, steps.length - 1)));
  const base = steps[Math.min(k, steps.length - 1)]?.state;
  const blank = (t: Tableau | undefined) => ({ z: (t?.objectiveRow ?? []).map(() => ''), zv: '', m: (t?.matrix ?? []).map(r => r.map(() => '')), rhs: (t?.rhs ?? []).map(() => '') });
  const [grid, setGrid] = useState(() => blank(base));
  const [res, setRes] = useState<StateDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setGrid(blank(base)); setRes(null); setErr(null); }, [k, steps.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!base) return <Card title="Diff mode"><p className="text-sm muted">Solve a model first.</p></Card>;

  const fill = () => setGrid({ z: base.objectiveRow.map(v => v.toString()), zv: base.objectiveValue.toString(), m: base.matrix.map(r => r.map(v => v.toString())), rhs: base.rhs.map(v => v.toString()) });
  const run = (auto: boolean) => {
    const conv = (s: string) => { const r = parseNum(s); if (!r.ok) throw new Error(`Cell “${s}” is not a number`); return r.value; };
    try {
      const user: Tableau = { ...base, matrix: grid.m.map(r => r.map(conv)), objectiveRow: grid.z.map(conv), rhs: grid.rhs.map(conv), objectiveValue: grid.zv === '' ? Rational.ZERO : conv(grid.zv), bigMRow: undefined, objectiveValueM: undefined, nextPivot: undefined };
      setErr(null);
      setRes(DiffComparator.compareTableau(user, steps as never, auto ? {} : { iteration: k }));
    } catch (e) { setErr(e instanceof Error ? e.message : 'Invalid entry'); setRes(null); }
  };

  return (
    <Card title="Diff mode — where did my working diverge?" icon={<GitCompare size={14} />} right={<Badge kind="accent">F11</Badge>}>
      <div className="flex flex-col gap-3">
        <p className="text-[0.82rem] muted">Enter YOUR tableau for an iteration (z-row, constraint rows, right-hand sides). The solver compares it with the correct one, lists the differing cells and infers the likely mistake (wrong entering/leaving variable, un-normalised pivot row, bad elimination multiplier, sign error…).</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="My tableau is for iteration">{id => (
            <select id={id} className="select" value={k} onChange={e => setK(Number(e.target.value))}>
              {steps.map((s, i) => <option key={i} value={i}>{i + 1}. {s.phase ?? 'step'}</option>)}
            </select>
          )}</Field>
          <Btn onClick={fill}>Copy solver tableau to edit</Btn>
          <Btn onClick={() => setGrid(blank(base))}>Clear</Btn>
        </div>
        <div className="overflow-x-auto">
          <table className="tbl" aria-label="Your tableau">
            <thead><tr><th scope="col">Basis</th>{base.columnNames.map((n, j) => <th key={j} scope="col">{n}</th>)}<th scope="col">RHS</th></tr></thead>
            <tbody>
              <tr className="zrow"><th scope="row">{base.objectiveLabel ?? 'z'}</th>{grid.z.map((v, j) => <td key={j} className="!p-0.5"><input className="input num" aria-label={`z-row ${base.columnNames[j]}`} value={v} onChange={e => setGrid(g => ({ ...g, z: g.z.map((x, i) => (i === j ? e.target.value : x)) }))} /></td>)}<td className="!p-0.5"><input className="input num" aria-label="objective value" value={grid.zv} onChange={e => setGrid(g => ({ ...g, zv: e.target.value }))} /></td></tr>
              {grid.m.map((row, i) => (
                <tr key={i}><th scope="row">{base.columnNames[base.basis[i]!]}</th>{row.map((v, j) => <td key={j} className="!p-0.5"><input className="input num" aria-label={`row ${i + 1} ${base.columnNames[j]}`} value={v} onChange={e => setGrid(g => ({ ...g, m: g.m.map((r, a) => (a === i ? r.map((x, b) => (b === j ? e.target.value : x)) : r)) }))} /></td>)}<td className="!p-0.5"><input className="input num" aria-label={`row ${i + 1} RHS`} value={grid.rhs[i] ?? ''} onChange={e => setGrid(g => ({ ...g, rhs: g.rhs.map((x, a) => (a === i ? e.target.value : x)) }))} /></td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex gap-2 flex-wrap"><Btn variant="primary" onClick={() => run(false)}>Compare with iteration {k + 1}</Btn><Btn onClick={() => run(true)}>Find the closest iteration</Btn></div>
        {err && <Callout kind="bad">{err}</Callout>}
        {res && (res.matches ? <Callout kind="ok">{res.summary}</Callout> : (
          <div className="flex flex-col gap-2">
            <Callout kind="warn" title="First divergence">{res.summary}</Callout>
            <div className="overflow-x-auto max-h-56"><table className="tbl text-xs"><thead><tr><th scope="col">Cell</th><th scope="col">Expected</th><th scope="col">Yours</th></tr></thead><tbody>{res.differences.map((d, i) => <tr key={i}><th scope="row">{d.target}</th><td style={{ color: 'var(--ok)' }}>{d.expected}</td><td style={{ color: 'var(--bad)' }}>{d.actual}</td></tr>)}</tbody></table></div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export { LIBRARY };
