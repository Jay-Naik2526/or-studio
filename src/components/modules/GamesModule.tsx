import { useEffect, useMemo, useRef, useState } from 'react';
import { Swords, LineChart as LC, GitCompare } from 'lucide-react';
import { SavedModel } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { solveZeroSumGame, GameState } from '../../core/solvers/games/zeroSum';
import { libraryFor } from '../../data/library';
import { GameSpec } from '../../data/specs';
import { parseNum } from '../../lib/numbers';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { TutorPanel, TutorQuestion, useTutorStats } from '../workspace/TutorPanel';
import { GridDiff } from '../workspace/GridDiff';
import { MatrixEditor } from '../input/MatrixEditor';
import { Card, Callout, StatusBanner, DiagnosticsList, Badge } from '../ui/ui';
import { Q } from '../ui/Q';
import { useInitial, useSaved, stepsToReport, diagText, clampStep } from './common';

const DEFAULT = libraryFor('games')[1]!.spec as GameSpec;

function Heatmap({ s, strategy }: { s: GameState; strategy?: boolean }) {
  const vals = s.matrix.flat().map(v => Number(v.toDecimal(6)));
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const act = (i: number, j: number) => s.activeRows.includes(i) && s.activeCols.includes(j);
  const saddle = new Set((s.saddlePoints ?? []).map(p => `${p.row},${p.col}`));
  const t = (v: Rational) => (Number(v.toDecimal(6)) - lo) / span;
  return (
    <div className="overflow-x-auto"><table className="tbl" aria-label="Payoff matrix">
      <thead><tr><th scope="col" className="rowhead">A \ B</th>{s.colLabels.map((c, j) => <th key={j} scope="col" style={{ opacity: s.activeCols.includes(j) ? 1 : 0.35, textDecoration: s.activeCols.includes(j) ? undefined : 'line-through' }}>{c}{strategy && s.strategyCol && <div className="text-[12px] font-normal">y = <Q v={s.strategyCol[j]!} /></div>}</th>)}{s.rowMinima && <th scope="col" title="row minimum">min</th>}</tr></thead>
      <tbody>
        {s.matrix.map((row, i) => (
          <tr key={i} style={{ opacity: s.activeRows.includes(i) ? 1 : 0.35 }}>
            <th scope="row" style={{ textDecoration: s.activeRows.includes(i) ? undefined : 'line-through' }}>{s.rowLabels[i]}{strategy && s.strategyRow && <span className="text-[12px] font-normal"> x = <Q v={s.strategyRow[i]!} /></span>}</th>
            {row.map((v, j) => <td key={j} className={saddle.has(`${i},${j}`) ? 'pivot' : ''} style={saddle.has(`${i},${j}`) ? undefined : { background: `color-mix(in srgb, var(--accent) ${Math.round(t(v) * 38)}%, transparent)`, opacity: act(i, j) ? 1 : 0.5 }}><Q v={v} /></td>)}
            {s.rowMinima && <td className="muted"><Q v={s.rowMinima[i]!} /></td>}
          </tr>
        ))}
        {s.colMaxima && <tr><th scope="row" title="column maximum">max</th>{s.colMaxima.map((v, j) => <td key={j} className="muted"><Q v={v} /></td>)}{s.rowMinima && <td />}</tr>}
      </tbody>
    </table></div>
  );
}

function GraphPlot({ g, labelsA }: { g: NonNullable<ReturnType<typeof solveZeroSumGame>['graphical']>; labelsA: string }) {
  const W = 560, H = 320, M = 44;
  const ys = g.lines.flatMap(l => [Number(l.intercept.toDecimal(6)), Number(l.intercept.add(l.slope).toDecimal(6))]);
  const lo = Math.min(...ys), hi = Math.max(...ys), pad = (hi - lo) * 0.1 || 1;
  const X = (t: number) => M + t * (W - 2 * M), Y = (v: number) => H - M - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 2 * M);
  const val = Number(g.value.toDecimal(6)), t = Number(g.optimalT.toDecimal(6));
  const colors = ['#2563eb', '#e11d48', '#059669', '#d97706', '#7c3aed', '#0891b2'];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Graphical solution, game value ${g.value.toString()}`}>
      <rect x={M} y={M / 2} width={W - 2 * M} height={H - 1.5 * M} fill="none" stroke="var(--border)" />
      {[0, 0.25, 0.5, 0.75, 1].map(x => <g key={x}><line x1={X(x)} x2={X(x)} y1={M / 2} y2={H - M} stroke="var(--border)" /><text x={X(x)} y={H - M + 16} fontSize="12" textAnchor="middle" fill="var(--text-3)">{x}</text></g>)}
      {[lo, (lo + hi) / 2, hi].map(v => <text key={v} x={M - 6} y={Y(v) + 4} fontSize="12" textAnchor="end" fill="var(--text-3)">{Number(v.toFixed(2))}</text>)}
      {g.lines.map((l, i) => { const a = Number(l.intercept.toDecimal(6)), b = Number(l.intercept.add(l.slope).toDecimal(6)); const act = g.activeLines.includes(i); return <g key={i}><line x1={X(0)} y1={Y(a)} x2={X(1)} y2={Y(b)} stroke={colors[i % colors.length]} strokeWidth={act ? 3 : 1.6} /><text x={X(1) + 4} y={Y(b) + 4} fontSize="12" fill={colors[i % colors.length]} fontWeight="700">{l.label}</text></g>; })}
      <line x1={X(t)} x2={X(t)} y1={M / 2} y2={H - M} stroke="var(--series)" strokeDasharray="5 4" /><circle cx={X(t)} cy={Y(val)} r="7" fill="var(--series)" stroke="var(--surface)" strokeWidth="2" />
      <text x={X(t) + 10} y={Y(val) - 10} fontSize="13" fontWeight="800" fill="var(--text)">v = {g.value.toString()} at {g.kind === '2xn' ? 'p' : 'q'} = {g.optimalT.toString()}</text>
      <text x={W / 2} y={H - 6} textAnchor="middle" fontSize="12" fill="var(--text-2)">{g.kind === '2xn' ? `probability of ${labelsA}` : `probability of ${labelsA}`}</text>
    </svg>
  );
}

export default function GamesModule() {
  const init = useInitial<GameSpec>('games', DEFAULT);
  const [spec, setSpec] = useState<GameSpec>(init.spec);
  const [mode, setMode] = useState<'auto' | 'tutor'>('auto');
  const [step, setStep] = useState(0);
  const pngRef = useRef<HTMLElement | null>(null);
  const { game, error } = useMemo(() => {
    const payoff: Rational[][] = [];
    for (const [i, r] of spec.payoff.entries()) { const row: Rational[] = []; for (const [j, c] of r.entries()) { const v = parseNum(c); if (!v.ok) return { game: null, error: `Payoff (${spec.rows[i]}, ${spec.cols[j]}): ${v.error === 'empty' ? 'missing' : v.error}` }; row.push(v.value); } payoff.push(row); }
    return { game: { payoff, rowNames: spec.rows, colNames: spec.cols }, error: null };
  }, [spec]);
  const res = useMemo(() => (game ? solveZeroSumGame(game) : null), [game]);
  const steps = res?.steps ?? [];
  const idx = clampStep(step, steps.length);
  const saved = useSaved('games', spec);
  useEffect(() => setStep(0), [spec]);

  const [tIdx, setTIdx] = useState(0);
  const tstats = useTutorStats();
  useEffect(() => { setTIdx(0); tstats.reset(); }, [spec, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  const question = useMemo<TutorQuestion | null>(() => {
    if (mode !== 'tutor' || !res) return null;
    const nxt = steps[tIdx + 1];
    if (!nxt) return null;
    const cur = steps[tIdx]!.state as GameState;
    const el = (nxt.state as GameState).eliminated;
    if (nxt.phase === 'Dominance' && el) {
      const opts = [...cur.activeRows.map(i => ({ kind: 'row' as const, i })), ...cur.activeCols.map(j => ({ kind: 'col' as const, i: j }))];
      return { id: `d${tIdx}`, prompt: 'Which strategy is DOMINATED and can be removed?', hint: 'A row is dominated if another row pays at least as much in every column; a column if another costs the minimiser no more in every row.', options: opts.map(o => ({ id: `${o.kind}${o.i}`, label: o.kind === 'row' ? cur.rowLabels[o.i]! : cur.colLabels[o.i]!, correct: o.kind === el.kind && o.i === el.index, feedback: o.kind === el.kind && o.i === el.index ? nxt.explanation.short : `${o.kind === 'row' ? cur.rowLabels[o.i] : cur.colLabels[o.i]} is not dominated by any single remaining ${o.kind}.`, misconception: 'Compare entry by entry — and remember the column player MINIMISES.' })), reveal: nxt.explanation.short };
    }
    if (nxt.phase === 'Maximin / minimax' || nxt.phase === 'Saddle point') {
      const sad = res.hasSaddlePoint;
      return { id: `s${tIdx}`, prompt: `Maximin = ${res.maximin.toString()}, minimax = ${res.minimax.toString()}. Is there a saddle point?`, options: [{ id: 'y', label: 'Yes — maximin = minimax', correct: sad, feedback: sad ? 'Yes: they are equal.' : 'The two values differ.', misconception: 'A pure equilibrium exists exactly when maximin equals minimax.' }, { id: 'n', label: 'No — mixed strategies needed', correct: !sad, feedback: !sad ? 'Right: maximin < minimax so neither player can commit to a pure strategy.' : 'They are equal, so a saddle point exists.', misconception: 'Compare the best row-minimum with the best column-maximum.' }] };
    }
    return null;
  }, [mode, res, steps, tIdx]);
  const advance = () => setTIdx(i => Math.min(steps.length - 1, i + 1));
  const showIdx = mode === 'tutor' ? tIdx : idx;
  const st = steps[showIdx];

  const buildReport = () => (!res || res.error ? null : { title: 'Zero-sum game', module: 'Zero-sum games', method: res.methodUsed, problem: `Payoffs to the row player:\n\t${spec.cols.join('\t')}\n${spec.payoff.map((r, i) => `${spec.rows[i]}\t${r.join('\t')}`).join('\n')}`, steps: stepsToReport(steps), result: { heading: 'Solution', lines: [`Value of the game = ${res.gameValue.toString()}`, `Row player: ${spec.rows.map((r, i) => `${r}=${res.playerAStrategy[i]!.toString()}`).join(', ')}`, `Column player: ${spec.cols.map((c, j) => `${c}=${res.playerBStrategy[j]!.toString()}`).join(', ')}`, res.verified ? 'Both strategies were verified against every opposing pure strategy.' : ''] }, diagnostics: diagText(res.diagnostics) });

  const tabs = [
    { id: 'solve', label: <><Swords size={14} /> Solution</>, node: <>
      {error && <Callout kind="bad">{error}</Callout>}
      {res?.error && <Callout kind="bad">{res.error}</Callout>}
      {st && <Card title={`Payoff matrix — ${st.phase ?? ''}`} bodyClass="p-2"><Heatmap s={st.state as GameState} strategy={(mode === 'auto' && idx === steps.length - 1)} /></Card>}
      {mode === 'tutor' && <TutorPanel question={question} stats={tstats.stats} onResult={tstats.record} onAdvance={advance} finishedText="Game solved — switch to Auto to see the strategies." />}
      {mode === 'auto' && res && !res.error && idx === steps.length - 1 && <>
        <Card title="Optimal mixed strategies" right={res.verified ? <Badge kind="ok">verified</Badge> : <Badge kind="bad">unverified</Badge>}>
          <div className="grid sm:grid-cols-2 gap-6">{[['Row player (maximiser)', spec.rows, res.playerAStrategy], ['Column player (minimiser)', spec.cols, res.playerBStrategy]].map(([t, names, p]) => <div key={t as string}><div className="eyebrow mb-2">{t as string}</div>{(names as string[]).map((nm, i) => { const v = (p as Rational[])[i]!; return <div key={i} className="flex items-center gap-3 mb-2"><span className="w-20 text-[0.95rem] font-semibold truncate">{nm}</span><div className="flex-1 h-5" style={{ background: 'var(--surface-3)' }}><div style={{ width: `${Number(v.toDecimal(4)) * 100}%`, height: '100%', background: 'var(--series)' }} /></div><span className="mono w-14 text-right"><Q v={v} /></span></div>; })}</div>)}</div>
          <p className="mt-3 text-[0.98rem]">Value of the game: <b className="mono text-lg"><Q v={res.gameValue} dec /></b> {res.fair ? '— a fair game.' : res.gameValue.isPositive() ? '— favours the row player.' : '— favours the column player.'}</p>
        </Card>
      </>}
    </> },
    { id: 'graph', hidden: !res?.graphical, label: <><LC size={14} /> Graphical</>, node: res?.graphical ? <Card title={res.graphical.kind === '2xn' ? 'Row player: lower envelope of the column lines' : 'Column player: upper envelope of the row lines'} bodyClass="p-2"><GraphPlot g={res.graphical} labelsA={res.graphical.kind === '2xn' ? spec.rows[res.reducedRows[0]!]! : spec.cols[res.reducedCols[0]!]!} /><p className="text-sm muted px-2">{res.graphical.kind === '2xn' ? 'Each line is the expected payoff against one column. The row player is guaranteed the LOWEST line, so picks the highest point of the lower envelope.' : 'Each line is the expected payoff of one row. The column player faces the HIGHEST line, so picks the lowest point of the upper envelope.'}</p></Card> : null },
    { id: 'diff', label: <><GitCompare size={14} /> Diff mode</>, node: <GridDiff title="Compare your matrix after each reduction" blankLabel="blank = struck out" steps={steps} extract={(s: GameState) => ({ rowLabels: s.rowLabels, colLabels: s.colLabels, cells: s.matrix.map((r, i) => r.map((v, j) => (s.activeRows.includes(i) && s.activeCols.includes(j) ? v.toString() : null))) })} cellWidth="w-14" /> },
  ];

  return (
    <WorkspaceFrame
      wide
      moduleId="games" title="Zero-sum games" accent="#0d9488" subtitle="Saddle points · dominance · graphical method · exact LP strategies"
      mode={mode} onMode={setMode}
      input={<>
        <Card title="Payoff matrix (to the row player)"><div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-[0.9rem]">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('games')[Number(e.target.value)]; if (x) setSpec(structuredClone(x.spec) as GameSpec); }}><option value="" disabled>Choose…</option>{libraryFor('games').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
          <MatrixEditor caption="Payoffs" values={spec.payoff} onChange={payoff => setSpec({ ...spec, payoff })} rowLabels={spec.rows} colLabels={spec.cols} onRowLabels={rows => setSpec({ ...spec, rows })} onColLabels={cols => setSpec({ ...spec, cols })} maxRows={8} maxCols={8} cornerLabel="A \ B" />
        </div></Card>
        {res && <DiagnosticsList items={res.diagnostics} />}
      </>}
      tabs={tabs} side={st ? <ExplanationPanel explanation={st.explanation} phase={st.phase} /> : <Card><p className="text-sm muted">Enter a payoff matrix.</p></Card>}
      player={mode === 'auto' && steps.length > 0 ? <StepPlayer count={steps.length} index={idx} onChange={setStep} labels={steps.map(s => s.phase ?? '')} summary={steps[idx]?.explanation.short} /> : undefined}
      status={res && !res.error ? <StatusBanner kind="ok" label={res.hasSaddlePoint ? 'Saddle point' : 'Mixed strategies'}><span className="mono font-bold text-base">value v = <Q v={res.gameValue} /></span><span className="text-[0.85rem]">maximin {res.maximin.toString()} · minimax {res.minimax.toString()}</span></StatusBanner> : error || res?.error ? <StatusBanner kind="bad" label="Input problem">{error ?? res?.error}</StatusBanner> : null}
      saved={saved} onLoad={(mm: SavedModel) => setSpec(mm.model as GameSpec)} buildReport={buildReport} pngRef={pngRef} step={idx}
    />
  );
}
