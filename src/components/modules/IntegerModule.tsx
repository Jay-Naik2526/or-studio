import { useEffect, useMemo, useRef, useState } from 'react';
import { Network, Scissors, Target } from 'lucide-react';
import { LPModel, SavedModel, Tableau, BBState } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { BranchBoundSolver, NodeSelection, BranchRule } from '../../core/solvers/integer/branchBound';
import { solveGomory } from '../../core/solvers/integer/gomory';
import { formatLP } from '../../core/parse/algebraic';
import { libraryFor } from '../../data/library';
import { LPSpec } from '../../data/specs';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { TutorPanel, TutorQuestion, useTutorStats } from '../workspace/TutorPanel';
import { LPInput, parseLPText } from '../input/LPInput';
import { BBTree } from '../viz/BBTree';
import { IncumbentChart } from '../viz/IncumbentChart';
import { TableauView } from '../viz/TableauView';
import { FeasibleRegion } from '../viz/FeasibleRegion';
import { GridDiff } from '../workspace/GridDiff';
import { TableauDiff } from './LPModule';
import { Card, Callout, StatusBanner, statusKind, statusLabel, DiagnosticsList, Badge, Field } from '../ui/ui';
import { Q } from '../ui/Q';
import { useInitial, useSaved, tableauTable, stepsToReport, diagText, clampStep } from './common';
import { Step } from '../../core/types/step';

const DEFAULT: LPSpec = { text: 'max 5x1 + 4x2\nsubject to\n  6x1 + 4x2 <= 24\n  x1 + 2x2 <= 6\n  int x1, x2' };
type Variant = 'bb' | 'gomory';

export default function IntegerModule() {
  const init = useInitial<LPSpec>('integer', DEFAULT);
  const [text, setText] = useState(init.spec.text);
  const [variant, setVariant] = useState<Variant>((init.variant === 'gomory' ? 'gomory' : 'bb'));
  const [mode, setMode] = useState<'auto' | 'tutor'>('auto');
  const [strategy, setStrategy] = useState<NodeSelection>('bestBound');
  const [rule, setRule] = useState<BranchRule>('firstFractional');
  const [maxNodes, setMaxNodes] = useState(200);
  const [step, setStep] = useState(init.step);
  const pngRef = useRef<HTMLElement | null>(null);

  const parsed = useMemo(() => parseLPText(text), [text]);
  const model = useMemo<LPModel | null>(() => {
    const m = parsed.model;
    if (!m) return null;
    return m.integrality ? m : { ...m, integrality: m.varNames.map(() => 'integer' as const) };
  }, [parsed.model]);

  const bb = useMemo(() => (model && variant === 'bb' ? new BranchBoundSolver().solve(model, { variant: strategy, branchRule: rule, maxNodes }) : null), [model, variant, strategy, rule, maxNodes]);
  const gm = useMemo(() => (model && variant === 'gomory' ? solveGomory(model, { maxCuts: 40 }) : null), [model, variant]);
  const sol = (variant === 'bb' ? bb : gm) as { steps: Step<unknown>[]; status: string; diagnostics: never[]; metrics: { iterations: number; elapsedMs: number }; result: unknown } | null;
  const steps = sol?.steps ?? [];
  const idx = clampStep(step, steps.length);

  const saved = useSaved('integer', { text } satisfies LPSpec, variant);
  const onLoad = (m: SavedModel) => { setText((m.model as LPSpec).text); if (m.variant === 'gomory' || m.variant === 'bb') setVariant(m.variant); setStep(0); };
  useEffect(() => { setStep(0); setTutorIdx(0); tstats.reset(); }, [text, variant, strategy, rule]); // eslint-disable-line react-hooks/exhaustive-deps

  // tutor: "what happens at this node?"
  const [tutorIdx, setTutorIdx] = useState(0);
  const tstats = useTutorStats();
  const tutorQ = useMemo<TutorQuestion | null>(() => {
    if (variant !== 'bb' || !bb || mode !== 'tutor') return null;
    const st = bb.steps[tutorIdx + 1];
    if (!st || !model) return null;
    const state = st.state as BBState;
    const node = state.nodes.find(n => n.id === state.activeNodeId);
    if (!node) return null;
    const kind = st.action?.kind;
    const rel = node.relaxation;
    const fractional = rel ? rel.values.map((v, j) => (!v.isInteger() && model.integrality?.[j] !== 'continuous' ? j : -1)).filter(j => j >= 0) : [];
    const opts = [
      { id: 'branch', label: 'Branch on a fractional variable', correct: kind === 'branch', feedback: kind === 'branch' ? `Yes — ${fractional.map(j => model.varNames[j]).join(', ')} is fractional and the node cannot be pruned.` : kind === 'incumbent' ? 'Every integer variable is already integral here, so there is nothing to branch on.' : 'Branching only makes sense for a feasible node that could still beat the incumbent.', misconception: 'Branch only when the relaxation is feasible, not dominated by the incumbent, and has a fractional integer variable.' },
      { id: 'incumbent', label: 'Record an integer solution', correct: kind === 'incumbent', feedback: kind === 'incumbent' ? 'Right — all integer variables are integral: this is an integer-feasible point.' : 'Not every integer variable is integral here (or the node was cut off), so this is not a new integer solution.', misconception: 'A node yields an incumbent only if every integer-restricted variable is integral.' },
      { id: 'prune-bound', label: 'Prune: bound not better than incumbent', correct: kind === 'prune' && !!node.pruneReason?.startsWith('Bound'), feedback: 'Correct — the relaxation value cannot beat the incumbent, so the subtree is cut off.', misconception: 'Bounding: compare the node\'s LP value with the best integer solution found so far.' },
      { id: 'prune-inf', label: 'Prune: infeasible', correct: kind === 'prune' && !node.relaxation, feedback: 'Correct — the added bound leaves no feasible LP point.', misconception: 'Infeasible subproblems have no LP solution at all.' },
    ];
    return { id: `bb-${tutorIdx}`, prompt: `Node ${node.id}${node.branchLabel ? ` (${node.branchLabel})` : ''}: ${rel ? `LP relaxation z = ${rel.objective.toString()}, ${rel.values.map((v, j) => `${model.varNames[j]} = ${v.toString()}`).join(', ')}` : 'the LP relaxation has no solution'}. What happens next?`, options: opts, reveal: st.explanation.short };
  }, [bb, tutorIdx, mode, variant, model]);

  const bbState = (steps[idx]?.state as BBState | undefined) ?? undefined;
  const states = (bb?.steps ?? []).map(s => s.state as BBState);
  const rootBound = bb?.result ? Number(bb.result.rootBound?.toDecimal(6) ?? NaN) : null;
  const cutsShown = gm?.result ? gm.result.cuts.slice(0, steps.slice(0, idx + 1).filter(s => s.action?.kind === 'cut').length) : [];
  const gModel = model && cutsShown.length ? { ...model, constraints: [...model.constraints, ...cutsShown.filter(c => c.inX).map(c => ({ coeffs: c.inX!.coeffs, relation: '<=' as const, rhs: c.inX!.rhs, name: `Cut ${c.index}` }))] } : model;

  const buildReport = () => {
    if (!sol || !model) return null;
    const r = (variant === 'bb' ? bb!.result : gm!.result) as { variableValues: Rational[]; objectiveValue: Rational } | null;
    return {
      title: variant === 'bb' ? 'Integer programme — branch and bound' : 'Integer programme — Gomory cuts', module: 'Integer programming', method: variant === 'bb' ? `Branch & bound (${strategy})` : 'Gomory cutting planes', problem: formatLP(model),
      steps: stepsToReport(steps as Step<unknown>[], s => ((s as Tableau).matrix ? tableauTable(s as Tableau) : undefined)),
      result: { heading: `Result: ${statusLabel(sol.status)}`, lines: r ? [`z = ${r.objectiveValue.toString()}`, ...model.varNames.map((n, j) => `${n} = ${r.variableValues[j]!.toString()}`)] : [statusLabel(sol.status)] },
      diagnostics: diagText(sol.diagnostics),
    };
  };

  const status = sol && (
    <StatusBanner kind={statusKind(sol.status)} label={statusLabel(sol.status)}>
      {(sol.result as { objectiveValue?: Rational } | null)?.objectiveValue && <span className="mono font-bold text-base">z = <Q v={(sol.result as { objectiveValue: Rational }).objectiveValue} /></span>}
      {bb?.result && bb.result.rootBound && <span className="text-[0.82rem]">LP bound <span className="mono"><Q v={bb.result.rootBound} /></span> · {bb.result.treeState.nodes.length} nodes · {bb.result.treeState.prunedCount} pruned</span>}
      {gm?.result && <span className="text-[0.82rem]">LP bound <span className="mono"><Q v={gm.result.lpBound} /></span> · {gm.result.cuts.length} cut{gm.result.cuts.length === 1 ? '' : 's'}</span>}
    </StatusBanner>
  );

  const tabs = [
    variant === 'bb'
      ? { id: 'tree', label: <><Network size={13} /> Tree</>, node: <>
          {mode === 'tutor' ? (
            <>
              {states[tutorIdx] && model && <BBTree state={states[tutorIdx]!} varNames={model.varNames} />}
              <TutorPanel question={tutorQ} stats={tstats.stats} onResult={tstats.record} onAdvance={() => setTutorIdx(i => i + 1)} finishedText={`Tree complete: ${statusLabel(sol?.status ?? '')}.`} />
            </>
          ) : (
            bbState && model && <><BBTree state={bbState} varNames={model.varNames} focus={bbState.activeNodeId} /><IncumbentChart states={states} upTo={idx} rootBound={rootBound !== null && Number.isFinite(rootBound) ? rootBound : null} /></>
          )}
        </> }
      : { id: 'tab', label: <><Scissors size={13} /> Cuts</>, node: <>
          {steps[idx] && <Card title={`Tableau — ${steps[idx]!.phase ?? ''}`} bodyClass="p-2"><TableauView tableau={steps[idx]!.state as Tableau} highlights={steps[idx]!.highlights} /></Card>}
          {gm?.result && gm.result.cuts.length > 0 && (
            <Card title="Cuts generated">
              <ol className="flex flex-col gap-2 text-xs">{gm.result.cuts.map(c => <li key={c.index} className="mono"><Badge kind="accent">cut {c.index}</Badge> from {c.sourceVariable}: {c.text} <span className="muted">({c.kind})</span>{c.inX && <div className="muted">in x: {c.inX.coeffs.map((a, j) => (a.isZero() ? '' : `${a.toString()}·${model!.varNames[j]}`)).filter(Boolean).join(' + ')} ≤ {c.inX.rhs.toString()}</div>}</li>)}</ol>
            </Card>
          )}
        </> },
    { id: 'diff', label: <>Diff mode</>, node: variant === 'gomory' ? <TableauDiff steps={steps as never} /> : <GridDiff title="Compare your node bounds" blankLabel="blank = not solved yet" steps={steps as Step<BBState>[]} extract={(s: BBState) => ({ rowLabels: s.nodes.map(n => `Node ${n.id}`), colLabels: ['z'], cells: s.nodes.map(n => [n.relaxation ? n.relaxation.objective.toString() : null]) })} /> },
    { id: 'graph', hidden: !model || model.objective.length !== 2, label: <><Target size={13} /> Plane</>, node: gModel && model && model.objective.length === 2 ? <FeasibleRegion model={gModel} lattice title="Integer points and LP region" /> : null },
  ];

  const side = variant === 'bb' && mode === 'tutor' ? (steps[tutorIdx] ? <ExplanationPanel explanation={steps[tutorIdx]!.explanation} phase={steps[tutorIdx]!.phase} /> : null) : steps[idx] ? <ExplanationPanel explanation={steps[idx]!.explanation} phase={steps[idx]!.phase} /> : <Card><p className="text-sm muted">Fix the model to see the reasoning.</p></Card>;

  return (
    <WorkspaceFrame
      moduleId="integer" title="Integer programming" accent="#7c3aed" subtitle="Branch & bound tree · Gomory fractional and mixed-integer cuts"
      variants={[{ value: 'bb', label: 'Branch & bound' }, { value: 'gomory', label: 'Gomory cuts' }]} variant={variant} onVariant={setVariant}
      mode={variant === 'bb' ? mode : undefined} onMode={setMode}
      input={<>
        <LPInput text={text} onText={setText} model={model} error={parsed.error} warnings={parsed.warnings} integerControls title="Integer model" examples={libraryFor('integer').map(e => ({ label: e.title, text: (e.spec as LPSpec).text }))} />
        {variant === 'bb' && (
          <Card title="Search settings"><div className="flex flex-col gap-3">
            <Field label="Node selection">{id => <select id={id} className="select" value={strategy} onChange={e => setStrategy(e.target.value as NodeSelection)}><option value="bestBound">Best bound first</option><option value="depthFirst">Depth first</option><option value="breadthFirst">Breadth first</option></select>}</Field>
            <Field label="Branching variable">{id => <select id={id} className="select" value={rule} onChange={e => setRule(e.target.value as BranchRule)}><option value="firstFractional">First fractional</option><option value="mostFractional">Most fractional</option></select>}</Field>
            <Field label="Node limit" hint="Searching stops with a warning when reached.">{id => <input id={id} className="input mono" type="number" min={3} max={5000} value={maxNodes} onChange={e => setMaxNodes(Math.min(5000, Math.max(3, Math.floor(Number(e.target.value)) || 200)))} />}</Field>
          </div></Card>
        )}
        {sol && <DiagnosticsList items={sol.diagnostics} />}
      </>}
      tabs={tabs} side={side}
      player={(variant === 'gomory' || mode === 'auto') && steps.length > 0 ? <StepPlayer count={steps.length} index={idx} onChange={setStep} labels={steps.map(s => s.phase ?? '')} summary={steps[idx]?.explanation.short} /> : undefined}
      status={status} saved={saved} onLoad={onLoad} buildReport={buildReport} pngRef={pngRef} step={idx}
    />
  );
}

export { Callout };
