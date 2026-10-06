import { useEffect, useMemo, useRef, useState } from 'react';
import { Sigma, ShieldCheck, Square, Plus, Minus } from 'lucide-react';
import { SavedModel } from '../../core/types/models';
import { Rational } from '../../core/math/rational';
import { minimiseUnconstrained, checkKKT, solveQP, UnconstrainedResult, NLPState } from '../../core/solvers/nlp/nlp';
import { libraryFor } from '../../data/library';
import { NLPSpec } from '../../data/specs';
import { parseNum, plainNum } from '../../lib/numbers';
import { WorkspaceFrame } from '../workspace/WorkspaceFrame';
import { StepPlayer } from '../workspace/StepPlayer';
import { ExplanationPanel } from '../workspace/ExplanationPanel';
import { MatrixEditor } from '../input/MatrixEditor';
import { Card, Callout, StatusBanner, Field, Badge, Btn, DiagnosticsList } from '../ui/ui';
import { Q } from '../ui/Q';
import { useInitial, useSaved, clampStep, stepsToReport } from './common';

const DEFAULT = libraryFor('nlp')[0]!.spec as NLPSpec;
const list = (s: string) => s.split(/[,\s;]+/).filter(Boolean).map(Number);

function Contour({ r, upTo }: { r: UnconstrainedResult; upTo: number }) {
  const pts = r.steps.slice(0, upTo + 1).map(s => (s.state as NLPState).x);
  const W = 520, H = 400;
  const xs = r.steps.map(s => (s.state as NLPState).x[0]!), ys = r.steps.map(s => (s.state as NLPState).x[1]!);
  const cxm = (Math.min(...xs) + Math.max(...xs)) / 2, cym = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 2) * 0.75;
  const x0 = cxm - span * (W / H), x1 = cxm + span * (W / H), y0 = cym - span, y1 = cym + span;
  const N = 48;
  const grid = useMemo(() => { const g: number[][] = []; for (let j = 0; j < N; j++) { const row: number[] = []; for (let i = 0; i < N; i++) row.push(r.evaluate([x0 + ((x1 - x0) * (i + 0.5)) / N, y1 - ((y1 - y0) * (j + 0.5)) / N])); g.push(row); } return g; }, [r, x0, x1, y0, y1]);
  const flat = grid.flat().filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p: number) => flat[Math.floor(p * (flat.length - 1))] ?? 0;
  const lo = q(0.0), hi = q(0.9);
  const X = (x: number) => ((x - x0) / (x1 - x0)) * W, Y = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
  const levels = Array.from({ length: 14 }, (_, k) => lo + (hi - lo) * Math.pow((k + 0.5) / 14, 2));
  const cw = W / N, ch = H / N;
  const paths = levels.map(L => {
    let d = '';
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = grid[j]![i]!, b = grid[j]![i + 1]!, c = grid[j + 1]![i + 1]!, e = grid[j + 1]![i]!;
      if (![a, b, c, e].every(Number.isFinite)) continue;
      const px = (i + 0.5) * cw, py = (j + 0.5) * ch;
      const pts: [number, number][] = [];
      const edge = (v1: number, v2: number, ax: number, ay: number, bx: number, by: number) => { if ((v1 < L) !== (v2 < L)) { const t = (L - v1) / (v2 - v1); pts.push([ax + t * (bx - ax), ay + t * (by - ay)]); } };
      edge(a, b, px, py, px + cw, py); edge(b, c, px + cw, py, px + cw, py + ch); edge(e, c, px, py + ch, px + cw, py + ch); edge(a, e, px, py, px, py + ch);
      if (pts.length >= 2) d += `M${pts[0]![0].toFixed(1)} ${pts[0]![1].toFixed(1)}L${pts[1]![0].toFixed(1)} ${pts[1]![1].toFixed(1)}`;
      if (pts.length === 4) d += `M${pts[2]![0].toFixed(1)} ${pts[2]![1].toFixed(1)}L${pts[3]![0].toFixed(1)} ${pts[3]![1].toFixed(1)}`;
    }
    return d;
  });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Contour plot with the iteration path">
      <rect width={W} height={H} fill="var(--surface-2)" />
      {paths.map((d, k) => <path key={k} d={d} fill="none" stroke="var(--text-3)" strokeWidth={k % 4 === 0 ? 1.4 : 0.8} opacity={0.35 + 0.5 * (1 - k / paths.length)} />)}
      <line x1={X(0)} x2={X(0)} y1="0" y2={H} stroke="var(--border-strong)" /><line y1={Y(0)} y2={Y(0)} x1="0" x2={W} stroke="var(--border-strong)" />
      <polyline points={pts.map(p => `${X(p[0]!)},${Y(p[1]!)}`).join(' ')} fill="none" stroke="var(--series)" strokeWidth="2.5" />
      {pts.map((p, i) => <circle key={i} cx={X(p[0]!)} cy={Y(p[1]!)} r={i === pts.length - 1 ? 7 : 3.6} fill={i === pts.length - 1 ? 'var(--series)' : 'var(--surface)'} stroke="var(--series)" strokeWidth="2" />)}
    </svg>
  );
}

export default function NLPModule() {
  const init = useInitial<NLPSpec>('nlp', DEFAULT);
  const [spec, setSpec] = useState<NLPSpec>(init.spec);
  const [step, setStep] = useState(0);
  const pngRef = useRef<HTMLElement | null>(null);
  const set = (p: Partial<NLPSpec>) => setSpec(s => ({ ...s, ...p }));
  const upd = (f: (s: NLPSpec) => Partial<NLPSpec>) => setSpec(s => ({ ...s, ...f(s) }));
  const saved = useSaved('nlp', spec, spec.method);
  const unc = useMemo(() => (spec.tab === 'unconstrained' && spec.expression.trim() ? minimiseUnconstrained({ expression: spec.expression, start: list(spec.start), method: spec.method, maxIterations: 300 }) : null), [spec.tab, spec.expression, spec.start, spec.method]);
  useEffect(() => setStep(0), [spec.expression, spec.start, spec.method, spec.tab]);
  const kkt = useMemo(() => (spec.tab === 'kkt' ? checkKKT({ objective: spec.expression, constraints: spec.constraints, point: list(spec.point) }) : null), [spec.tab, spec.expression, spec.constraints, spec.point]);
  const qp = useMemo(() => {
    if (spec.tab !== 'qp') return null;
    const cv = (s: string[][]) => s.map(r => r.map(c => parseNum(c)));
    const Qm = cv(spec.Q), A = cv(spec.A), c = spec.c.map(x => parseNum(x)), b = spec.b.map(x => parseNum(x));
    if ([...Qm.flat(), ...A.flat(), ...c, ...b].some(x => !x.ok)) return { error: 'Every matrix and vector entry must be a number.' } as ReturnType<typeof solveQP>;
    const g = (m: ReturnType<typeof cv>) => m.map(r => r.map(x => (x as { ok: true; value: Rational }).value));
    return solveQP({ Q: g(Qm), c: c.map(x => (x as { ok: true; value: Rational }).value), A: g(A), b: b.map(x => (x as { ok: true; value: Rational }).value) });
  }, [spec.tab, spec.Q, spec.c, spec.A, spec.b]);
  // one atomic update: Q, c and the columns of A always keep the same size
  const resizeQP = (k: number) => upd(s => ({
    Q: Array.from({ length: k }, (_, i) => Array.from({ length: k }, (__, j) => s.Q[i]?.[j] ?? '0')),
    c: Array.from({ length: k }, (_, i) => s.c[i] ?? '0'),
    A: s.A.map(r => Array.from({ length: k }, (_, j) => r[j] ?? '0')),
  }));
  const steps = unc?.steps ?? [];
  const idx = clampStep(step, steps.length);
  const st = steps[idx];
  const n = spec.Q.length;
  const exprError = unc?.error ?? (kkt?.error ?? null);

  const buildReport = () => {
    if (spec.tab === 'unconstrained' && unc && !unc.error) return { title: 'Unconstrained minimisation', module: 'Nonlinear programming', method: spec.method, problem: `minimise f(x) = ${spec.expression}\nstart ${spec.start}`, steps: stepsToReport(steps), result: { heading: 'Result', lines: [`x* ≈ (${unc.x.map(v => Number(v.toFixed(6))).join(', ')})`, `f(x*) ≈ ${Number(unc.f.toFixed(8))}`, `Classification: ${unc.classification}`] }, diagnostics: unc.diagnostics.map(d => d.message) };
    if (spec.tab === 'kkt' && kkt && !kkt.error) return { title: 'KKT check', module: 'Nonlinear programming', problem: `minimise ${spec.expression}\nsubject to ${spec.constraints.map(c => `${c.expr} ${c.kind === 'le' ? '≤' : '='} 0`).join('; ')}\npoint (${spec.point})`, steps: [], result: { heading: kkt.satisfied ? 'KKT satisfied' : 'KKT not satisfied', lines: kkt.messages }, diagnostics: [] };
    if (spec.tab === 'qp' && qp && !qp.error) return { title: 'Quadratic programme', module: 'Nonlinear programming', problem: `Q=${JSON.stringify(spec.Q)} c=${JSON.stringify(spec.c)} A=${JSON.stringify(spec.A)} b=${JSON.stringify(spec.b)}`, steps: [], result: { heading: 'Optimum', lines: [`x* = (${qp.x.map(String).join(', ')})`, `objective = ${qp.objective.toString()}`, qp.explanation] }, diagnostics: [] };
    return null;
  };

  const tabs = [
    { id: 'unc', hidden: spec.tab !== 'unconstrained', label: <><Sigma size={14} /> Iterations</>, node: <>
      {unc?.error && <Callout kind="bad">{unc.error}</Callout>}
      {unc && !unc.error && <>
        <Card title="Contour plot and iterate path" bodyClass="p-2">{spec.start.split(/[,\s]+/).filter(Boolean).length === 2 ? <Contour r={unc} upTo={idx} /> : <p className="p-3 text-[0.95rem] muted">Contour plots need exactly two variables.</p>}</Card>
        {st && <Card title="Current iterate"><div className="grid grid-cols-2 md:grid-cols-4 gap-4"><div><div className="eyebrow">x</div><div className="mono font-bold">({(st.state as NLPState).x.map(v => Number(v.toFixed(5))).join(', ')})</div></div><div><div className="eyebrow">f(x)</div><div className="mono font-bold">{Number((st.state as NLPState).f.toFixed(8))}</div></div><div><div className="eyebrow">‖∇f‖</div><div className="mono font-bold">{Number((st.state as NLPState).gradNorm.toPrecision(4))}</div></div><div><div className="eyebrow">step length</div><div className="mono font-bold">{(st.state as NLPState).stepSize !== undefined ? Number((st.state as NLPState).stepSize!.toPrecision(4)) : '—'}</div></div></div></Card>}
        <Card title="Symbolic derivatives"><div className="mono text-[0.9rem] flex flex-col gap-1">{unc.gradientText.map((g, i) => <div key={i}>∂f/∂x{i + 1} = {g}</div>)}{unc.hessianText.map((r, i) => <div key={i} className="muted">H{i + 1}· = [{r.join('  |  ')}]</div>)}</div></Card>
      </>}
    </> },
    { id: 'kkt', hidden: spec.tab !== 'kkt', label: <><ShieldCheck size={14} /> KKT</>, node: kkt?.error ? <Callout kind="bad">{kkt.error}</Callout> : kkt ? <>
      <Card title="KKT conditions at the point" right={<Badge kind={kkt.satisfied ? 'ok' : 'bad'}>{kkt.satisfied ? 'satisfied' : 'not satisfied'}</Badge>}>
        <ul className="flex flex-col gap-2">{kkt.messages.map((m, i) => <li key={i}><Callout kind={/FAILS|NOT/.test(m) ? 'bad' : 'ok'}>{m}</Callout></li>)}</ul>
        {kkt.multipliers && <p className="mt-3 mono text-[0.95rem]">multipliers λ = ({kkt.multipliers.map(v => Number(v.toFixed(5))).join(', ')}) for active constraints {kkt.active.map(i => i + 1).join(', ')}</p>}
      </Card>
      <Card title="Gradient of the objective"><div className="mono text-[0.9rem]">{kkt.gradients.map((g, i) => <div key={i}>∂f/∂x{i + 1} = {g}</div>)}</div></Card>
    </> : null },
    { id: 'qp', hidden: spec.tab !== 'qp', label: <><Square size={14} /> Quadratic programme</>, node: qp?.error ? <Callout kind="bad">{qp.error}</Callout> : qp ? (
      <Card title="Exact optimum" right={<Badge kind={qp.convex ? 'ok' : 'warn'}>{qp.convex ? 'convex' : 'non-convex'}</Badge>}>
        <div className="grid sm:grid-cols-2 gap-4"><div><div className="eyebrow">x*</div><div className="display text-3xl" style={{ color: 'var(--text)' }}>({qp.x.map((v, i) => <span key={i}>{i ? ', ' : ''}<Q v={v} /></span>)})</div></div><div><div className="eyebrow">objective ½xᵀQx + cᵀx</div><div className="display text-3xl" style={{ color: 'var(--text)' }}><Q v={qp.objective} /></div></div></div>
        <p className="mt-3 text-[0.95rem]" style={{ color: 'var(--text-2)' }}>{qp.explanation}</p>
      </Card>
    ) : null },
  ];

  return (
    <WorkspaceFrame
      moduleId="nlp" title="Nonlinear programming" accent="#475569" subtitle="Gradient & Newton with symbolic derivatives · KKT verification · exact quadratic programming"
      variants={[{ value: 'unconstrained', label: 'Unconstrained' }, { value: 'kkt', label: 'KKT' }, { value: 'qp', label: 'Quadratic' }]} variant={spec.tab} onVariant={v => set({ tab: v })}
      input={<>
        <Card title="Problem"><div className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-[0.9rem]">Example<select className="select" value="" aria-label="Load an example" onChange={e => { const x = libraryFor('nlp')[Number(e.target.value)]; if (x) setSpec(structuredClone(x.spec) as NLPSpec); }}><option value="" disabled>Choose…</option>{libraryFor('nlp').map((x, i) => <option key={x.id} value={i}>{x.title}</option>)}</select></label>
          {spec.tab !== 'qp' && <Field label="Objective f(x₁, x₂, …)" hint="Use x1, x2, …, + − * / ^, exp, ln, sin, cos, sqrt">{id => <input id={id} className="input mono" value={spec.expression} onChange={e => set({ expression: e.target.value })} aria-invalid={!!exprError} />}</Field>}
          {spec.tab === 'unconstrained' && <>
            <Field label="Starting point">{id => <input id={id} className="input mono" value={spec.start} onChange={e => set({ start: e.target.value })} />}</Field>
            <div className="flex gap-2"><Btn aria-pressed={spec.method === 'newton'} onClick={() => set({ method: 'newton' })}>Newton</Btn><Btn aria-pressed={spec.method === 'gradient'} onClick={() => set({ method: 'gradient' })}>Gradient descent</Btn></div>
          </>}
          {spec.tab === 'kkt' && <>
            <div className="flex flex-col gap-2"><div className="text-[0.9rem] font-semibold">Constraints g(x) ≤ 0 or h(x) = 0</div>{spec.constraints.map((c, i) => <div key={i} className="flex gap-2"><input className="input mono" aria-label={`Constraint ${i + 1}`} value={c.expr} onChange={e => { const v = e.target.value; upd(s => ({ constraints: s.constraints.map((x, k) => (k === i ? { ...x, expr: v } : x)) })); }} /><select className="select !w-20" aria-label="Type" value={c.kind} onChange={e => { const v = e.target.value as 'le' | 'eq'; upd(s => ({ constraints: s.constraints.map((x, k) => (k === i ? { ...x, kind: v } : x)) })); }}><option value="le">≤ 0</option><option value="eq">= 0</option></select><Btn size="icon" variant="ghost" aria-label="Remove" onClick={() => upd(s => ({ constraints: s.constraints.filter((_, k) => k !== i) }))}>✕</Btn></div>)}<Btn size="sm" onClick={() => upd(s => ({ constraints: [...s.constraints, { expr: '', kind: 'le' }] }))}>+ constraint</Btn></div>
            <Field label="Candidate point">{id => <input id={id} className="input mono" value={spec.point} onChange={e => set({ point: e.target.value })} />}</Field>
          </>}
          {spec.tab === 'qp' && <div className="flex flex-col gap-3">
            <p className="text-[0.88rem] muted">Minimise ½ xᵀQx + cᵀx subject to Ax ≤ b, x ≥ 0.</p>
            <div className="eyebrow">Q (symmetric)</div><MatrixEditor caption="Q" values={spec.Q} onChange={Qm => upd(() => ({ Q: Qm }))} resizable={false} />
            <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="muted mr-1">Variables</span><Btn size="icon" aria-label="Remove a variable" disabled={n <= 1} onClick={() => resizeQP(n - 1)}><Minus size={12} /></Btn><span className="mono w-4 text-center">{n}</span><Btn size="icon" aria-label="Add a variable" disabled={n >= 5} onClick={() => resizeQP(n + 1)}><Plus size={12} /></Btn></div>
            <div className="eyebrow">c</div><div className="flex gap-1.5">{spec.c.map((v, i) => <input key={i} className="input num" aria-label={`c${i + 1}`} value={v} onChange={e => { const v = e.target.value; upd(s => ({ c: s.c.map((x, k) => (k === i ? v : x)) })); }} />)}</div>
            <div className="eyebrow">A | b</div><MatrixEditor caption="Constraints A" values={spec.A} onChange={A => upd(s => ({ A, b: A.map((_, i) => s.b[i] ?? '0') }))} resizable minRows={1} maxRows={6} minCols={n} maxCols={n} colExtra={undefined} rowExtra={{ label: 'b', values: spec.b, onChange: b => set({ b }) }} />
          </div>}
        </div></Card>
        {unc && <DiagnosticsList items={unc.diagnostics} />}
      </>}
      tabs={tabs} side={st ? <ExplanationPanel explanation={st.explanation} phase={st.phase} /> : <Card><p className="text-[0.95rem] muted">{spec.tab === 'qp' ? 'The QP is solved exactly by enumerating active sets of the KKT system in rational arithmetic.' : spec.tab === 'kkt' ? 'KKT conditions: feasibility, stationarity ∇f + Σλ∇g = 0, λ ≥ 0, complementary slackness.' : 'Enter a function.'}</p></Card>}
      player={spec.tab === 'unconstrained' && steps.length > 0 ? <StepPlayer count={steps.length} index={idx} onChange={setStep} labels={steps.map(s => s.phase ?? '')} summary={st?.explanation.short} /> : undefined}
      status={exprError ? <StatusBanner kind="bad" label="Expression error">{exprError}</StatusBanner> : spec.tab === 'unconstrained' && unc ? <StatusBanner kind={unc.converged ? 'ok' : 'warn'} label={unc.converged ? `Stationary point — ${unc.classification}` : 'Not converged'}><span className="mono font-bold text-base">f ≈ {Number(unc.f.toFixed(6))}</span><span className="text-[0.85rem]">{unc.iterations} iterations</span></StatusBanner> : spec.tab === 'kkt' && kkt && !kkt.error ? <StatusBanner kind={kkt.satisfied ? 'ok' : 'bad'} label={kkt.satisfied ? 'KKT satisfied' : 'KKT not satisfied'} /> : spec.tab === 'qp' && qp ? (qp.error ? <StatusBanner kind="bad" label="No optimum found">{qp.error}</StatusBanner> : <StatusBanner kind="ok" label="Exact optimum"><span className="mono font-bold text-base">obj = {qp.objective.toString()}</span></StatusBanner>) : null}
      saved={saved} onLoad={(m: SavedModel) => setSpec(m.model as NLPSpec)} buildReport={buildReport} pngRef={pngRef} step={idx}
    />
  );
  void n; void plainNum;
}
