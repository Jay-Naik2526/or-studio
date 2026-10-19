import { useEffect, useMemo, useRef, useState } from 'react';
import { ListOrdered, BarChart3, Table2, Scale, Eraser } from 'lucide-react';
import { SavedModel } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { solveSequencing, buildSeqModel, SeqMethod, SeqState, SeqResult, SeqModel } from '../../core/solvers/sequencing/sequencing';
import { Step } from '../../core/types/step';
import { libraryFor } from '../../data/library';
import { SequencingSpec } from '../../data/specs';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { TutorPanel, TutorQuestion, TutorOption, useTutorStats } from '../workspace/TutorPanel';
import { MatrixEditor } from '../input/MatrixEditor';
import { GanttSequence, GanttLegend } from '../viz/GanttSequence';
import { Card, Callout, StatusBanner, DiagnosticsList, Btn, Badge } from '../ui/ui';
import { Q } from '../ui/Q';
import { useInitial, useSaved, stepsToReport, diagText, clampStep, conforms } from './common';

const DEFAULT: SequencingSpec = libraryFor('sequencing')[0]?.spec as SequencingSpec ?? { jobs: ['A', 'B', 'C'], machines: ['Machine I', 'Machine II'], times: [['2', '6'], ['5', '8'], ['4', '7']] };
const METHODS: SeqMethod[] = ['johnson', 'cds', 'exact'];
const isMethod = (v: unknown): v is SeqMethod => typeof v === 'string' && (METHODS as string[]).includes(v);
const METHOD_NAME: Record<SeqMethod, string> = { johnson: 'Johnson’s rule', cds: 'CDS heuristic', exact: 'Exact search' };

const seqText = (names: string[], max = 14) => (names.length > max ? `${names.slice(0, max - 2).join(' → ')} → … → ${names[names.length - 1]}` : names.join(' → '));
const pct = (gap: Rational, opt: Rational) => (opt.isZero() ? '0' : (gap.div(opt).toNumber() * 100).toFixed(1).replace(/\.0$/, ''));

/* ---------------------------------- views ---------------------------------- */

function Chips({ names, active }: { names: string[]; active?: number }) {
  return (
    <ol className="flex flex-wrap gap-1.5" aria-label="Sequence">
      {names.map((nm, i) => (
        <li key={i} className="mono px-2 py-1 border text-sm font-bold" style={{ borderColor: active === i ? 'var(--accent-edge)' : 'var(--border-strong)', background: active === i ? 'var(--hl)' : 'var(--surface)' }}>
          <span className="muted text-[11px] mr-1">{i + 1}</span>{nm}
        </li>
      ))}
    </ol>
  );
}

function SlotStrip({ s, chosen }: { s: SeqState; chosen?: number }) {
  const slots = s.slots ?? [];
  const firstFree = slots.findIndex(x => x === null);
  const lastFree = slots.length - 1 - [...slots].reverse().findIndex(x => x === null);
  const anyFree = firstFree >= 0;
  return (
    <ol className="flex flex-wrap gap-1.5" aria-label="Sequence slots">
      {slots.map((j, i) => {
        const fresh = j !== null && j === chosen;
        return (
          <li key={i} className="flex flex-col items-center gap-0.5">
            <span className="mono text-[11px] muted">{i + 1}</span>
            <span className="mono font-bold text-sm px-2 py-1.5 min-w-[2.4rem] text-center" style={{ border: j === null ? '1.5px dashed var(--border-strong)' : '1.5px solid var(--accent-edge)', background: fresh ? 'var(--hl)' : j === null ? 'transparent' : 'var(--surface-2)', color: j === null ? 'var(--text-3)' : 'var(--text)' }}>
              {j === null ? '·' : s.jobs[j]}
            </span>
            <span className="mono text-[10px] muted h-3" aria-hidden="true">{anyFree && i === firstFree ? 'front ▸' : anyFree && i === lastFree ? '◂ back' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

function PseudoTable({ s, rows, chosen }: { s: SeqState; rows: number[]; chosen?: { job: number; on: number } }) {
  const ps = s.pseudo;
  if (!ps) return null;
  const min = rows.length ? rows.reduce((acc, j) => { const v = ps.a[j]!.lt(ps.b[j]!) ? ps.a[j]! : ps.b[j]!; return acc === null || v.lt(acc) ? v : acc; }, null as Rational | null) : null;
  return (
    <div className="overflow-x-auto" style={{ maxHeight: 360, overflowY: 'auto' }}>
      <table className="tbl" aria-label="Processing times of the unscheduled jobs">
        <thead><tr><th scope="col" className="rowhead">Job</th><th scope="col">{ps.labels[0]}</th><th scope="col">{ps.labels[1]}</th></tr></thead>
        <tbody>
          {rows.map(j => (
            <tr key={j} style={chosen?.job === j ? { background: 'var(--accent-soft)' } : undefined}>
              <th scope="row">{s.jobs[j]}</th>
              {[ps.a[j]!, ps.b[j]!].map((v, c) => <td key={c} className={min && v.eq(min) ? 'basic' : ''} style={chosen?.job === j && chosen.on === c ? { background: 'var(--hl)' } : undefined}><Q v={v} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DataTable({ model }: { model: SeqModel }) {
  return (
    <div className="overflow-x-auto" style={{ maxHeight: 360, overflowY: 'auto' }}>
      <table className="tbl" aria-label="Processing times">
        <thead><tr><th scope="col" className="rowhead">Job</th>{model.machines.map((mn, k) => <th key={k} scope="col">{mn}</th>)}</tr></thead>
        <tbody>{model.times.map((r, i) => <tr key={i}><th scope="row">{model.jobs[i]}</th>{r.map((v, k) => <td key={k}><Q v={v} /></td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function TimingTable({ res }: { res: SeqResult }) {
  const t = res.timing;
  return (
    <div className="overflow-x-auto">
      <table className="tbl" aria-label="In and out times">
        <thead>
          <tr><th scope="col" rowSpan={2} className="rowhead">#</th><th scope="col" rowSpan={2} className="rowhead">Job</th>{res.machines.map((mn, k) => <th key={k} scope="colgroup" colSpan={3}>{mn}</th>)}</tr>
          <tr>{res.machines.map((_, k) => ['time', 'in', 'out'].map(h => <th key={`${k}${h}`} scope="col" className="!text-[0.78rem]">{h}</th>))}</tr>
        </thead>
        <tbody>
          {t.order.map((j, pos) => (
            <tr key={pos}>
              <td className="muted">{pos + 1}</td>
              <th scope="row">{res.jobs[j]}</th>
              {res.machines.map((_, k) => [res.times[j]![k]!, t.inT[pos]![k]!, t.outT[pos]![k]!].map((v, c) => <td key={`${k}${c}`} className={c === 0 ? 'muted' : ''}><Q v={v} /></td>))}
            </tr>
          ))}
        </tbody>
        <tfoot><tr className="zrow"><td colSpan={2} className="!text-left">Total elapsed time</td><td colSpan={res.machines.length * 3}><b><Q v={res.makespan} /></b></td></tr></tfoot>
      </table>
    </div>
  );
}

function IdleTable({ res }: { res: SeqResult }) {
  return (
    <div className="overflow-x-auto">
      <table className="tbl" aria-label="Idle time per machine">
        <thead><tr><th scope="col" className="rowhead">Machine</th><th scope="col">Busy</th><th scope="col" title="waiting for the first job">Initial wait</th><th scope="col" title="idle between jobs">Gaps</th><th scope="col" title="idle after its last job">End wait</th><th scope="col">Idle total</th><th scope="col">Utilisation</th></tr></thead>
        <tbody>
          {res.timing.idle.map(x => (
            <tr key={x.machine}>
              <th scope="row">{res.machines[x.machine]}</th>
              <td><Q v={x.busy} /></td><td><Q v={x.initial} /></td><td><Q v={x.gaps} /></td><td><Q v={x.tail} /></td><td className="basic"><Q v={x.total} /></td>
              <td>{res.makespan.isZero() ? '—' : `${(x.busy.div(res.makespan).toNumber() * 100).toFixed(1).replace(/\.0$/, '')} %`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------- module ---------------------------------- */

export default function SequencingModule() {
  const init = useInitial<SequencingSpec>('sequencing', DEFAULT);
  const [spec, setSpec] = useState<SequencingSpec>(init.spec);
  const [method, setMethod] = useState<SeqMethod>(isMethod(init.variant) ? init.variant : 'johnson');
  const [mode, setMode] = useState<'auto' | 'tutor'>('auto');
  const [step, setStep] = useState(init.step);
  const pngRef = useRef<HTMLElement | null>(null);

  const { model, error } = useMemo(() => buildSeqModel(spec), [spec]);
  const sol = useMemo(() => (model ? solveSequencing(model, method) : null), [model, method]);
  const steps: Step<SeqState>[] = sol?.steps ?? [];
  const res = sol?.result ?? null;
  const idx = clampStep(step, steps.length);
  const saved = useSaved('sequencing', spec, method);
  const onLoad = (m: SavedModel) => {
    if (!conforms(DEFAULT, m.model)) return;
    setSpec(m.model as SequencingSpec);
    if (isMethod(m.variant)) setMethod(m.variant);
    setStep(0);
  };

  /* ---- comparison of the methods (only the final numbers, no steps) ---- */
  const compare = useMemo(() => {
    if (!model) return null;
    const run = (mth: SeqMethod) => { const s = solveSequencing(model, mth, { emitSteps: false }); return { status: s.status, res: s.result, msg: s.diagnostics[0]?.message ?? '' }; };
    return { johnson: run('johnson'), cds: run('cds'), exact: run('exact') };
  }, [model]);

  /* ---- tutor (Johnson's rule) ---- */
  const [tIdx, setTIdx] = useState(0);
  const tstats = useTutorStats();
  useEffect(() => { setTIdx(0); tstats.reset(); }, [spec, mode, method]); // eslint-disable-line react-hooks/exhaustive-deps
  const tutorOn = mode === 'tutor' && method === 'johnson' && steps.length > 0;
  // first step at or after tIdx whose successor is a placement with at least two jobs still unscheduled before it
  const qi = useMemo(() => {
    if (!tutorOn) return -1;
    for (let t = tIdx; t < steps.length - 1; t++) {
      const nx = steps[t + 1]!;
      if (nx.action?.kind === 'place' && (nx.state.remaining?.length ?? 0) >= 1) return t;
    }
    return -1;
  }, [tutorOn, steps, tIdx]);

  const question = useMemo<TutorQuestion | null>(() => {
    if (!tutorOn || qi < 0) return null;
    const nxt = steps[qi + 1];
    if (!nxt || !nxt.state.pseudo) return null;
    const pl = nxt.action!.payload as { job: string; jobIndex: number; side: 'front' | 'back'; value: string; machine: number };
    const ps = nxt.state.pseudo, jobs = nxt.state.jobs;
    const remaining = [...(nxt.state.remaining ?? []), pl.jobIndex].sort((a, b) => a - b);
    const min = Rational.parse(pl.value);
    type Entry = { job: number; side: 'front' | 'back'; val: Rational };
    const entries: Entry[] = remaining.flatMap(j => [{ job: j, side: 'front' as const, val: ps.a[j]! }, { job: j, side: 'back' as const, val: ps.b[j]! }]);
    const id = (e: { job: number; side: string }) => `${e.job}|${e.side}`;
    const correct: Entry = { job: pl.jobIndex, side: pl.side, val: min };
    const strictly = entries.filter(e => e.val.gt(min));
    const picked = new Map<string, { e: Entry; fb: string; mis: string }>();
    const add = (e: Entry | undefined, fb: string, mis: string) => { if (e && id(e) !== id(correct) && !picked.has(id(e))) picked.set(id(e), { e, fb, mis }); };
    const opp = entries.find(e => e.job === correct.job && e.side !== correct.side);
    if (opp && opp.val.gt(min)) add(opp, `${pl.job} is the right job, but its smallest time is on ${pl.machine === 1 ? ps.labels[0] : ps.labels[1]}, so it goes to the ${pl.side}, not the ${opp.side}.`, 'A smallest time on machine 1 means “front”; on machine 2 means “back”.');
    const biggest = strictly.reduce<Entry | undefined>((a, e) => (!a || e.val.gt(a.val) ? e : a), undefined);
    add(biggest, `${jobs[biggest?.job ?? 0]} has the LARGEST time (${biggest?.val.toString()}); Johnson’s rule always starts from the smallest remaining time, ${min.toString()}.`, 'Johnson’s rule looks for the minimum over both machines, not the maximum.');
    const next = [...strictly].sort((a, b) => a.val.cmp(b.val)).find(e => !picked.has(id(e)));
    add(next, `The smallest remaining time is ${min.toString()}, not ${next?.val.toString()}.`, 'Scan every remaining job on both machines before choosing.');
    const others = strictly.filter(e => !picked.has(id(e)));
    others.forEach(e => { if (picked.size < 3) add(e, `The smallest remaining time is ${min.toString()}, not ${e.val.toString()}.`, 'Scan every remaining job on both machines before choosing.'); });
    const label = (e: { job: number; side: 'front' | 'back' }) => `${jobs[e.job]} → ${e.side}`;
    const opts: TutorOption[] = [
      { id: id(correct), label: label(correct), correct: true, feedback: nxt.explanation.short },
      ...[...picked.values()].map(({ e, fb, mis }) => ({ id: id(e), label: label(e), correct: false, feedback: fb, misconception: mis })),
    ].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    return {
      id: `p${qi}`,
      prompt: `Which job is chosen next, and does it go to the front or the back of the sequence?`,
      hint: `Find the smallest processing time among the ${remaining.length} unscheduled jobs on both machines. Machine 1 → front-most free slot, machine 2 → back-most free slot. Ties: machine 1 first, then the job listed first.`,
      options: opts,
      reveal: nxt.explanation.short,
    };
  }, [tutorOn, steps, qi]);
  const advance = () => setTIdx(qi + 1);
  const tIdxShown = qi >= 0 ? qi : steps.length - 1;
  const showSt = tutorOn ? steps[tIdxShown] : steps[idx];

  /* ---- views ---- */
  const stepView = (st: Step<SeqState>) => {
    const s = st.state;
    if (s.kind === 'place' && s.pseudo) {
      const pl = st.action?.payload as { jobIndex: number; machine: number } | undefined;
      const before = [...(s.remaining ?? []), ...(pl ? [pl.jobIndex] : [])].sort((a, b) => a - b);
      return <>
        <Card title="Sequence slots"><div className="flex flex-col gap-2"><SlotStrip s={s} chosen={pl?.jobIndex} /><p className="text-[13px] muted">Dashed boxes are free. Machine-1 minima fill from the front, machine-2 minima from the back.</p></div></Card>
        <Card title={`Unscheduled jobs before this placement (${before.length})`} bodyClass="p-2"><PseudoTable s={s} rows={before} chosen={pl ? { job: pl.jobIndex, on: pl.machine - 1 } : undefined} /></Card>
      </>;
    }
    if (tutorOn) return null;
    if (s.kind === 'check' && s.pseudo) {
      return <Card title="Pseudo machines" bodyClass="p-2"><PseudoTable s={s} rows={s.jobs.map((_, i) => i)} /></Card>;
    }
    if (s.kind === 'candidate' && s.pseudo) {
      return <>
        <Card title={`Pseudo machines ${s.pseudo.labels.join(' | ')}`} bodyClass="p-2"><PseudoTable s={s} rows={s.jobs.map((_, i) => i)} /></Card>
        <Card title="Sequence from Johnson’s rule"><Chips names={(s.sequence ?? []).map(j => s.jobs[j]!)} /></Card>
        <CandidateTable s={s} />
      </>;
    }
    if (s.kind === 'pick') return <><Card title="Selected sequence"><Chips names={(s.sequence ?? []).map(j => s.jobs[j]!)} /></Card><CandidateTable s={s} /></>;
    if (s.kind === 'enumerate' || s.kind === 'timing' || s.kind === 'result') {
      return <Card title="Sequence"><Chips names={(s.sequence ?? []).map(j => s.jobs[j]!)} /></Card>;
    }
    return model ? <Card title="Processing times" bodyClass="p-2"><DataTable model={model} /></Card> : null;
  };

  const bannerSeq = res ? seqText(res.sequenceNames) : '';
  const status = error
    ? <StatusBanner kind="bad" label="Input problem"><span className="text-[0.9rem]">{error}</span></StatusBanner>
    : sol && sol.status === 'invalid-input'
      ? <StatusBanner kind="bad" label="Input problem"><span className="text-[0.9rem]">{sol.diagnostics[0]?.message}</span></StatusBanner>
      : res && (
        <StatusBanner kind={res.guaranteedOptimal ? 'ok' : 'warn'} label={res.guaranteedOptimal ? 'Optimal sequence' : 'Heuristic sequence — not proven optimal'}>
          <span className="mono font-bold text-base break-words min-w-0">{bannerSeq}</span>
          <span className="mono font-bold text-base">total elapsed time = <Q v={res.makespan} /></span>
          <span className="text-[0.85rem] mono">idle: {res.timing.idle.map((x, k) => <span key={k} className="mr-2">{res.machines[k]} <b><Q v={x.total} /></b></span>)}</span>
          {res.exact && <span className="text-[0.82rem]">{res.exact.count.toLocaleString('en-US')} of {res.exact.total.toLocaleString('en-US')} sequences are optimal</span>}
        </StatusBanner>
      );

  const tabs = [
    { id: 'sequence', label: <><ListOrdered size={13} /> Sequence</>, node: <>
      {error && <Callout kind="bad">{error}</Callout>}
      {sol?.status === 'invalid-input' && (
        <Callout kind="bad">
          <div>{sol.diagnostics[0]?.message}</div>
          {sol.diagnostics[0]?.code === 'INPUT_LIMIT' && <div className="mt-2 flex gap-2">{method === 'johnson' && <Btn size="sm" onClick={() => setMethod('cds')}>Use CDS</Btn>}{method === 'exact' && <Btn size="sm" onClick={() => setMethod('cds')}>Use CDS</Btn>}</div>}
        </Callout>
      )}
      {mode === 'tutor' && method !== 'johnson' && <Callout kind="info">The tutor practises Johnson’s rule (choose the next job and its end of the sequence). Switch the method to Johnson to use it; Auto mode works for every method.</Callout>}
      {showSt && stepView(showSt)}
      {tutorOn && <TutorPanel question={question} stats={tstats.stats} onResult={tstats.record} onAdvance={advance} finishedText="The slots are filled — switch to Auto to see the timing, the Gantt chart and the idle times." />}
      {!tutorOn && res && idx === steps.length - 1 && (
        <Card title="Result"><div className="flex flex-col gap-2">
          <Chips names={res.sequenceNames} />
          <p className="text-sm">Total elapsed time <b className="mono"><Q v={res.makespan} /></b>. {res.guarantee}</p>
        </div></Card>
      )}
    </> },
    { id: 'gantt', label: <><BarChart3 size={13} /> Gantt</>, node: res ? (
      <Card title="Gantt chart" bodyClass="p-2">
        <div className="flex flex-col gap-2">
          <GanttSequence data={res.gantt} jobs={res.jobs} machines={res.machines} sequence={res.sequence} />
          <GanttLegend jobs={res.jobs} sequence={res.sequence} />
          <p className="text-[13px] muted px-1">One row per machine, time runs left to right. Hatched areas are idle time. Total elapsed time = <b className="mono"><Q v={res.makespan} /></b>.</p>
        </div>
      </Card>
    ) : <Callout kind="info">Fix the inputs to see the chart.</Callout> },
    { id: 'table', label: <><Table2 size={13} /> Table</>, node: res ? <>
      <Card title="Sequencing table — in and out times" bodyClass="p-2"><TimingTable res={res} /></Card>
      <Card title="Idle time per machine" bodyClass="p-2"><IdleTable res={res} /><p className="text-[13px] muted px-1 pt-2">Idle total = total elapsed time − busy time = initial wait + gaps between jobs + end wait.</p></Card>
    </> : <Callout kind="info">Fix the inputs to see the table.</Callout> },
    { id: 'compare', label: <><Scale size={13} /> Compare</>, node: compare ? <CompareView c={compare} model={model!} method={method} /> : <Callout kind="info">Fix the inputs to compare the methods.</Callout> },
  ];

  /* ---- report ---- */
  const buildReport = () => {
    if (!sol || !res || !model) return null;
    const stepTable = (s: SeqState) => {
      if (s.kind === 'place' && s.slots && s.slots.length <= 30) return { headers: ['Slot', ...s.slots.map((_, i) => String(i + 1))], rows: [['Job', ...s.slots.map(j => (j === null ? '·' : s.jobs[j]!))]] };
      if ((s.kind === 'candidate' || s.kind === 'check') && s.pseudo && s.jobs.length <= 40) return { caption: s.pseudo.labels.join(' | '), headers: ['Job', ...s.pseudo.labels], rows: s.jobs.map((j, i) => [j, s.pseudo!.a[i]!.toString(), s.pseudo!.b[i]!.toString()]) };
      return undefined;
    };
    const t = res.timing;
    return {
      title: 'Job sequencing', module: 'Job sequencing', method: METHOD_NAME[method],
      problem: `Minimise the total elapsed time of ${model.jobs.length} jobs processed on ${model.machines.join(' → ')} in that order\n\t${model.machines.join('\t')}\n${model.jobs.map((j, i) => `${j}\t${model.times[i]!.map(v => v.toString()).join('\t')}`).join('\n')}`,
      steps: stepsToReport(steps, stepTable),
      result: {
        heading: res.guaranteedOptimal ? 'Result: optimal sequence' : 'Result: heuristic sequence (not proven optimal)',
        lines: [`Sequence: ${res.sequenceNames.join(' → ')}`, `Total elapsed time = ${res.makespan.toString()}`, ...t.idle.map(x => `Idle time on ${res.machines[x.machine]} = ${x.total.toString()}`), res.guarantee],
        tables: [
          { caption: 'Sequencing table (in / out times)', headers: ['Position', 'Job', ...res.machines.flatMap(mn => [`${mn} in`, `${mn} out`])], rows: t.order.map((j, pos) => [String(pos + 1), res.jobs[j]!, ...res.machines.flatMap((_, k) => [t.inT[pos]![k]!.toString(), t.outT[pos]![k]!.toString()])]) },
          { caption: 'Idle time per machine', headers: ['Machine', 'Busy', 'Initial wait', 'Gaps', 'End wait', 'Idle total'], rows: t.idle.map(x => [res.machines[x.machine]!, x.busy.toString(), x.initial.toString(), x.gaps.toString(), x.tail.toString(), x.total.toString()]) },
        ],
      },
      diagnostics: diagText(sol.diagnostics),
    };
  };

  const loadExample = (i: number) => {
    const x = libraryFor('sequencing')[i];
    if (!x) return;
    setSpec(structuredClone(x.spec) as SequencingSpec);
    setMethod(isMethod(x.variant) ? x.variant : 'johnson');
    setStep(0);
  };
  const clearAll = () => { setSpec({ jobs: ['J1', 'J2', 'J3'], machines: ['M1', 'M2'], times: Array.from({ length: 3 }, () => ['', '']) }); setStep(0); };

  return (
    <WorkspaceFrame
      wide
      moduleId="sequencing" title="Job sequencing" accent="#0f766e" subtitle="Johnson’s rule · three machines · CDS heuristic · exact search · Gantt chart and idle times"
      variants={[{ value: 'johnson' as SeqMethod, label: 'Johnson', title: 'Two machines (three under a dominance condition)' }, { value: 'cds' as SeqMethod, label: 'CDS', title: 'Campbell–Dudek–Smith heuristic for m machines' }, { value: 'exact' as SeqMethod, label: 'Exact', title: 'All sequences, up to 9 jobs' }]}
      variant={method} onVariant={m => { setMethod(m); setStep(0); }}
      mode={mode} onMode={setMode}
      input={<>
        <Card title="Jobs and processing times"><div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs">Example
              <select className="select" value="" aria-label="Load an example" onChange={e => loadExample(Number(e.target.value))}>
                <option value="" disabled>Choose…</option>
                {libraryFor('sequencing').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}
              </select>
            </label>
            <Btn size="sm" onClick={clearAll}><Eraser size={13} /> Clear</Btn>
          </div>
          <MatrixEditor caption="Processing times" values={spec.times}
            onChange={times => setSpec(s => ({ ...s, times }))}
            rowLabels={spec.jobs} colLabels={spec.machines}
            onRowLabels={jobs => setSpec(s => ({ ...s, jobs }))} onColLabels={machines => setSpec(s => ({ ...s, machines }))}
            maxRows={200} maxCols={10} minRows={1} minCols={2} nonNegative cornerLabel="job \ machine" />
          <p className="text-[13px] muted">Rows are jobs, columns are machines in processing order (every job visits the machines left to right). Rename a job or machine in its header cell.</p>
        </div></Card>
        {error && <Callout kind="bad">{error}</Callout>}
        {sol && <DiagnosticsList items={sol.diagnostics.filter(d => d.severity !== 'error')} />}
      </>}
      tabs={tabs}
      side={showSt ? <ExplanationPanel explanation={showSt.explanation} phase={showSt.phase} /> : <Card><p className="text-sm muted">{error ?? 'Fix the inputs.'}</p></Card>}
      player={mode === 'auto' && steps.length > 0 ? <StepPlayer count={steps.length} index={idx} onChange={setStep} labels={steps.map(s => s.phase ?? '')} summary={steps[idx]?.explanation.short} /> : undefined}
      status={status} saved={saved} onLoad={onLoad} buildReport={buildReport} pngRef={pngRef} step={idx}
    />
  );
}

function CandidateTable({ s }: { s: SeqState }) {
  const c = s.candidates ?? [];
  if (!c.length) return null;
  const best = c.reduce((a, x) => (x.makespan.lt(a.makespan) ? x : a), c[0]!);
  return (
    <Card title="Candidates so far" bodyClass="p-2">
      <div className="overflow-x-auto">
        <table className="tbl" aria-label="CDS candidates">
          <thead><tr><th scope="col" className="rowhead">k</th><th scope="col">Pseudo machines</th><th scope="col">Sequence</th><th scope="col">Total elapsed</th></tr></thead>
          <tbody>{c.map(x => (
            <tr key={x.k} style={x === best ? { background: 'var(--accent-soft)' } : undefined}>
              <th scope="row">{x.k}</th><td>{x.pseudo.labels.join(' | ')}</td><td className="!text-left">{seqText(x.order.map(j => s.jobs[j]!), 10)}</td><td className="basic"><Q v={x.makespan} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Card>
  );
}

type Cmp = { status: string; res: SeqResult | null; msg: string };
function CompareView({ c, model, method }: { c: { johnson: Cmp; cds: Cmp; exact: Cmp }; model: SeqModel; method: SeqMethod }) {
  const opt = c.exact.res?.makespan ?? null;
  const known = [c.johnson.res, c.cds.res, c.exact.res].filter((x): x is SeqResult => !!x);
  const bestKnown = known.length ? known.reduce((a, x) => (x.makespan.lt(a) ? x.makespan : a), known[0]!.makespan) : null;
  const ref = opt ?? bestKnown;
  const rows: { key: SeqMethod; name: string; cmp: Cmp; note: string }[] = [
    { key: 'johnson', name: model.machines.length === 2 ? 'Johnson’s rule' : model.machines.length === 3 ? 'Johnson 3-machine reduction' : 'Johnson’s rule', cmp: c.johnson, note: model.machines.length > 3 ? 'needs at most 3 machines' : c.johnson.res ? (c.johnson.res.guaranteedOptimal ? 'optimal (proven)' : 'condition fails: not guaranteed') : '' },
    { key: 'cds', name: 'CDS heuristic', cmp: c.cds, note: c.cds.res ? (c.cds.res.guaranteedOptimal ? 'optimal (two machines)' : `best of ${c.cds.res.candidates?.length} candidates`) : '' },
    { key: 'exact', name: 'Exact search', cmp: c.exact, note: c.exact.res ? `${c.exact.res.exact!.count.toLocaleString('en-US')} optimal sequence${c.exact.res.exact!.count === 1 ? '' : 's'}` : model.jobs.length > 9 ? 'limited to 9 jobs' : '' },
  ];
  return (
    <Card title="Compare the methods" bodyClass="p-2">
      <div className="flex flex-col gap-3">
        <div className="overflow-x-auto">
          <table className="tbl" aria-label="Method comparison">
            <thead><tr><th scope="col" className="rowhead">Method</th><th scope="col">Total elapsed</th><th scope="col">{opt ? 'Gap to optimum' : 'Gap to best found'}</th><th scope="col">Sequence</th><th scope="col">Note</th></tr></thead>
            <tbody>
              {rows.map(r => {
                const x = r.cmp.res;
                const gap = x && ref ? x.makespan.sub(ref) : null;
                return (
                  <tr key={r.key} style={r.key === method ? { background: 'var(--accent-soft)' } : undefined}>
                    <th scope="row">{r.name}{r.key === method && <> <Badge kind="accent">selected</Badge></>}</th>
                    {x ? <>
                      <td className="basic"><Q v={x.makespan} /></td>
                      <td>{gap && ref ? (gap.isZero() ? <Badge kind="ok">0 — optimal</Badge> : <span>+<Q v={gap} /> ({pct(gap, ref)} %)</span>) : '—'}</td>
                      <td className="!text-left">{seqText(x.sequenceNames, 10)}</td>
                    </> : <><td>—</td><td>—</td><td className="!text-left muted">not available</td></>}
                    <td className="!text-left !whitespace-normal text-[0.82rem]">{r.note || (r.cmp.msg ? r.cmp.msg : '')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-[13px] muted px-1">{opt ? 'The exact search checks every sequence, so its total elapsed time is the true optimum; the gap shows how much a method loses.' : 'With more than 9 jobs the exact optimum is out of reach; the gap is measured against the best sequence found by the methods above.'}</p>
      </div>
    </Card>
  );
}
