/**
 * CPM / PERT project planning (spec §8.6, §9.1 module 8, §10.4).
 * Activity-on-node network. Arithmetic is done with exact rationals internally (decimals like 2.5 are exact),
 * and exposed as numbers.
 */

import { Rational } from '../../math/rational';
import { Solver, Solution, ValidationResult, SolveOptions, Diagnostic } from '../../types/solver';
import { Step } from '../../types/step';
import { ProjectModel, ProjectState } from '../../types/models';
import { joinList } from '../../format';

export interface ProjectResult {
  schedule: ProjectState['schedule'];
  criticalPath: string[];
  /** every distinct critical path, each as an ordered list of activity ids */
  criticalPaths: string[][];
  projectDuration: number;
  projectVariance?: number;
  projectStdDev?: number;
  order: string[];
  /** deadline − projectDuration (negative ⇒ cannot meet the deadline without crashing) */
  slackToDeadline?: number;
}

/** Φ(z) via the complementary error function (Numerical Recipes erfc, |error| < 1.2e-7). */
export function normalCDF(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * x);
  const tau = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  const erfc = tau;
  return z >= 0 ? 1 - 0.5 * erfc : 0.5 * erfc;
}

/** Inverse normal CDF (Acklam). */
export function normalInv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  const q = p - 0.5; const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** P(project finishes within `target`) under the PERT normal approximation. */
export function probabilityWithin(result: ProjectResult, target: number): number | null {
  if (result.projectVariance === undefined) return null;
  if (result.projectVariance === 0) return target >= result.projectDuration ? 1 : 0;
  return normalCDF((target - result.projectDuration) / Math.sqrt(result.projectVariance));
}

const R = (x: number | undefined) => Rational.parse(String(x ?? 0));
const num = (r: Rational) => Number(r.toDecimal(6));

export class ProjectSolver implements Solver<ProjectModel, ProjectState, ProjectResult> {
  readonly id = 'project.cpm';

  readonly meta = {
    name: 'CPM / PERT',
    category: 'project' as const,
    variants: [
      { id: 'cpm', name: 'CPM', description: 'Deterministic durations: ES/EF/LS/LF, floats, critical path.' },
      { id: 'pert', name: 'PERT', description: 'Three-point estimates, variance and completion probability.' },
    ],
    visualizerId: 'GanttChart',
    sizeLimit: { rows: 200, cols: 0 },
    supportsTutorial: true,
    reference: 'Taha, Operations Research: An Introduction, Ch. 6',
  };

  validate(model: ProjectModel): ValidationResult {
    const errors: { field?: string; message: string }[] = [];
    if (!model.activities.length) errors.push({ field: 'activities', message: 'Add at least one activity.' });
    const ids = new Set<string>();
    for (const a of model.activities) {
      if (!a.id.trim()) errors.push({ message: 'An activity has an empty name.' });
      if (ids.has(a.id)) errors.push({ message: `Duplicate activity id "${a.id}".` });
      ids.add(a.id);
    }
    for (const a of model.activities) {
      for (const p of a.predecessors) {
        if (p === a.id) errors.push({ message: `Activity ${a.id} lists itself as a predecessor.` });
        else if (!ids.has(p)) errors.push({ message: `Activity ${a.id} has unknown predecessor "${p}".` });
      }
    }
    return { valid: errors.length === 0, errors };
  }

  normalize(model: ProjectModel): ProjectModel {
    return model;
  }

  solve(model: ProjectModel, options: SolveOptions = {}): Solution<ProjectState, ProjectResult> {
    const t0 = performance.now();
    const diagnostics: Diagnostic[] = [];
    const fail = (message: string, code: string): Solution<ProjectState, ProjectResult> => ({ steps: [], result: null, status: 'invalid-input', diagnostics: [...diagnostics, { severity: 'error', code, message }], metrics: { iterations: 0, elapsedMs: 0, degradedToFloat: false } });
    const v = this.validate(model);
    if (!v.valid) return fail(v.errors.map(e => e.message).join(' '), 'INVALID_MODEL');
    const isPERT = options.variant === 'pert';
    const acts = model.activities;
    const byId = new Map(acts.map(a => [a.id, a]));

    // durations / variances
    const dur = new Map<string, Rational>();
    const variance = new Map<string, Rational>();
    for (const a of acts) {
      if (isPERT && a.optimistic !== undefined && a.mostLikely !== undefined && a.pessimistic !== undefined) {
        if (a.optimistic > a.mostLikely || a.mostLikely > a.pessimistic) return fail(`Activity ${a.id}: estimates must satisfy optimistic ≤ most likely ≤ pessimistic.`, 'BAD_ESTIMATES');
        const o = R(a.optimistic), m = R(a.mostLikely), p = R(a.pessimistic);
        dur.set(a.id, o.add(m.mul(Rational.of(4))).add(p).div(Rational.of(6)));
        const sd = p.sub(o).div(Rational.of(6));
        variance.set(a.id, sd.mul(sd));
        if (a.optimistic === a.pessimistic) diagnostics.push({ severity: 'info', code: 'ZERO_VARIANCE', message: `Activity ${a.id} has optimistic = pessimistic: it is deterministic (variance 0).` });
      } else {
        if (a.duration === undefined || a.duration < 0) return fail(`Activity ${a.id} needs a non-negative duration${isPERT ? ' (or the three PERT estimates)' : ''}.`, 'NO_DURATION');
        dur.set(a.id, R(a.duration));
        variance.set(a.id, Rational.ZERO);
      }
    }

    // topological order, cycle detection
    const succ = new Map<string, string[]>(acts.map(a => [a.id, []]));
    const indeg = new Map<string, number>(acts.map(a => [a.id, a.predecessors.length]));
    acts.forEach(a => a.predecessors.forEach(p => succ.get(p)!.push(a.id)));
    const order: string[] = [];
    const q = acts.filter(a => indeg.get(a.id) === 0).map(a => a.id);
    while (q.length) {
      const u = q.shift()!;
      order.push(u);
      for (const w of succ.get(u)!) { indeg.set(w, indeg.get(w)! - 1); if (indeg.get(w) === 0) q.push(w); }
    }
    if (order.length < acts.length) {
      const stuck = acts.filter(a => !order.includes(a.id)).map(a => a.id);
      // find one cycle among stuck
      const cyc: string[] = [];
      let cur = stuck[0]!;
      const seen = new Map<string, number>();
      while (!seen.has(cur)) { seen.set(cur, cyc.length); cyc.push(cur); cur = byId.get(cur)!.predecessors.find(p => stuck.includes(p)) ?? cur; }
      const cycle = cyc.slice(seen.get(cur)!).reverse();
      return fail(`Cyclic dependency: ${cycle.join(' → ')} → ${cycle[0]}. A project network must be acyclic — remove one of these precedence links.`, 'CYCLIC_DEPENDENCY');
    }
    if (acts.length > 1) {
      const iso = acts.filter(a => a.predecessors.length === 0 && succ.get(a.id)!.length === 0).map(a => a.id);
      if (iso.length) diagnostics.push({ severity: 'warning', code: 'DISCONNECTED_ACTIVITY', message: `Activity ${joinList(iso)} has no predecessor and no successor; it is treated as a parallel activity that starts at time 0.` });
    }

    // passes
    const ES = new Map<string, Rational>(), EF = new Map<string, Rational>(), LS = new Map<string, Rational>(), LF = new Map<string, Rational>();
    const steps: Step<ProjectState>[] = [];
    const emit = options.emitSteps !== false;
    const partial = (pass: ProjectState['pass'], just: string[]): ProjectState => {
      const sched: ProjectState['schedule'] = {};
      for (const a of acts) {
        const es = ES.get(a.id), ef = EF.get(a.id), ls = LS.get(a.id), lf = LF.get(a.id);
        sched[a.id] = {
          earlyStart: es ? num(es) : NaN, earlyFinish: ef ? num(ef) : NaN, lateStart: ls ? num(ls) : NaN, lateFinish: lf ? num(lf) : NaN,
          totalFloat: es && ls ? num(ls.sub(es)) : NaN, freeFloat: NaN, isCritical: !!(es && ls && ls.sub(es).isZero()),
          expectedDuration: num(dur.get(a.id)!), variance: num(variance.get(a.id)!),
        };
      }
      return { schedule: sched, criticalPath: [], projectDuration: NaN, pass, justComputed: just };
    };
    const push = (phase: string, short: string, detailed: string, rule: string, state: ProjectState, hl: Step<ProjectState>['highlights'] = [], status: Step<ProjectState>['status'] = 'continue') => {
      if (emit) steps.push({ index: steps.length, phase, state, action: null, explanation: { short, detailed, rule }, highlights: hl, status });
    };
    push('Initialisation', `${acts.length} activities, ${isPERT ? 'PERT expected durations' : 'CPM durations'}.`, `${isPERT ? 'PERT replaces each three-point estimate by its expected value te = (a + 4m + b)/6 and variance ((b − a)/6)². ' : ''}The forward pass computes earliest start/finish, the backward pass latest start/finish.`, 'Initialisation', partial('forward', []), [], 'initial');

    for (const id of order) {
      const a = byId.get(id)!;
      const es = a.predecessors.reduce((m, p) => (EF.get(p)!.gt(m) ? EF.get(p)! : m), Rational.ZERO);
      ES.set(id, es);
      EF.set(id, es.add(dur.get(id)!));
      push('Forward pass', `${id}: ES = ${es.toString()}, EF = ${EF.get(id)!.toString()}.`, `ES(${id}) = ${a.predecessors.length ? `max of predecessors' EF (${a.predecessors.map(p => `${p}: ${EF.get(p)!.toString()}`).join(', ')})` : '0 (no predecessors)'} = ${es.toString()}; EF = ES + duration ${dur.get(id)!.toString()} = ${EF.get(id)!.toString()}.`, 'Forward pass', partial('forward', [id]), [{ target: `act:${id}`, intent: 'changed' }]);
    }
    const T = [...EF.values()].reduce((m, x) => (x.gt(m) ? x : m), Rational.ZERO);
    for (const id of [...order].reverse()) {
      const ss = succ.get(id)!;
      const lf = ss.length ? ss.reduce((m, s) => (LS.get(s)!.lt(m) ? LS.get(s)! : m), LS.get(ss[0]!)!) : T;
      LF.set(id, lf);
      LS.set(id, lf.sub(dur.get(id)!));
      push('Backward pass', `${id}: LF = ${lf.toString()}, LS = ${LS.get(id)!.toString()}.`, `LF(${id}) = ${ss.length ? `min of successors' LS (${ss.map(s => `${s}: ${LS.get(s)!.toString()}`).join(', ')})` : `project duration ${T.toString()} (no successors)`} = ${lf.toString()}; LS = LF − duration = ${LS.get(id)!.toString()}.`, 'Backward pass', partial('backward', [id]), [{ target: `act:${id}`, intent: 'changed' }]);
    }

    const schedule: ProjectState['schedule'] = {};
    let projVar = Rational.ZERO;
    for (const a of acts) {
      const tf = LS.get(a.id)!.sub(ES.get(a.id)!);
      const ss = succ.get(a.id)!;
      const ff = (ss.length ? ss.reduce((m, s) => (ES.get(s)!.lt(m) ? ES.get(s)! : m), ES.get(ss[0]!)!) : T).sub(EF.get(a.id)!);
      schedule[a.id] = {
        earlyStart: num(ES.get(a.id)!), earlyFinish: num(EF.get(a.id)!), lateStart: num(LS.get(a.id)!), lateFinish: num(LF.get(a.id)!),
        totalFloat: num(tf), freeFloat: num(ff), isCritical: tf.isZero(), expectedDuration: num(dur.get(a.id)!), variance: num(variance.get(a.id)!),
      };
    }
    const critical = order.filter(id => schedule[id]!.isCritical);

    // enumerate every critical path (start → … → end through zero-float activities with tight links)
    const criticalPaths: string[][] = [];
    const starts = critical.filter(id => byId.get(id)!.predecessors.every(p => !schedule[p]!.isCritical || !EF.get(p)!.eq(ES.get(id)!)));
    const walk = (id: string, path: string[]) => {
      const nxt = succ.get(id)!.filter(s => schedule[s]!.isCritical && ES.get(s)!.eq(EF.get(id)!));
      if (!nxt.length) { if (EF.get(id)!.eq(T)) criticalPaths.push([...path]); return; }
      nxt.forEach(s => walk(s, [...path, s]));
    };
    starts.filter(id => ES.get(id)!.isZero()).forEach(id => walk(id, [id]));
    if (criticalPaths.length > 1) diagnostics.push({ severity: 'info', code: 'MULTIPLE_CRITICAL_PATHS', message: `${criticalPaths.length} critical paths: ${criticalPaths.map(p => p.join('→')).join(' and ')}. Shortening the project requires shortening every one of them.` });

    if (isPERT) critical.forEach(id => { projVar = projVar.add(variance.get(id)!); });
    // use the longest critical path for the variance (variances add along a path)
    if (isPERT && criticalPaths.length) {
      projVar = criticalPaths.map(p => p.reduce((s, id) => s.add(variance.get(id)!), Rational.ZERO)).reduce((m, x) => (x.gt(m) ? x : m));
      if (criticalPaths.length > 1) diagnostics.push({ severity: 'info', code: 'PERT_PATH_CHOICE', message: 'With several critical paths the largest path variance is used (a standard conservative approximation).' });
    }

    let slackToDeadline: number | undefined;
    if (model.deadline !== undefined) {
      const sl = R(model.deadline).sub(T);
      slackToDeadline = num(sl);
      if (sl.isNegative()) {
        diagnostics.push({ severity: 'error', code: 'NEGATIVE_FLOAT', message: `The imposed deadline ${model.deadline} is earlier than the earliest completion ${num(T)}: every critical activity has float ${num(sl)}. The project cannot meet it without crashing activities.` });
        for (const id of Object.keys(schedule)) { const s = schedule[id]!; s.totalFloat = Math.round((s.totalFloat + num(sl)) * 1e6) / 1e6; }
      }
    }

    push('Float analysis', 'Total and free float computed.', `Total float TF = LS − ES (delay tolerated without delaying the project); free float FF = min successor ES − EF. Critical activities (TF = 0): ${critical.join(', ')}.`, 'Float analysis', { schedule, criticalPath: critical, projectDuration: num(T), pass: 'float' });
    push('Critical path', `Project duration = ${num(T)}; critical path ${criticalPaths[0]?.join(' → ') ?? critical.join(' → ')}.`, `The critical path is the chain of activities with zero total float; its length ${num(T)} is the shortest possible project duration.${isPERT ? ` Project variance = sum of variances along the critical path = ${num(projVar)} (σ = ${Math.sqrt(num(projVar)).toFixed(3)}).` : ''}`, 'Critical path', { schedule, criticalPath: critical, projectDuration: num(T), projectVariance: isPERT ? num(projVar) : undefined, pass: 'done' }, critical.map(id => ({ target: `act:${id}`, intent: 'critical' as const })), 'optimal');

    return {
      steps,
      result: {
        schedule, criticalPath: critical, criticalPaths, projectDuration: num(T),
        projectVariance: isPERT ? num(projVar) : undefined, projectStdDev: isPERT ? Math.sqrt(num(projVar)) : undefined, order, slackToDeadline,
      },
      status: 'optimal',
      diagnostics,
      metrics: { iterations: acts.length * 2, elapsedMs: Math.round((performance.now() - t0) * 100) / 100, degradedToFloat: false },
    };
  }
}
