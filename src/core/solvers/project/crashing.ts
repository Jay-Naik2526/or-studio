/**
 * Time–cost trade-off (project crashing), solved EXACTLY as a linear programme with the simplex engine:
 *   minimise Σ slopeᵢ·rᵢ   s.t.  start_j ≥ start_i + dᵢ − rᵢ  (i precedes j),  T ≥ start_i + dᵢ − rᵢ,
 *                                  0 ≤ rᵢ ≤ dᵢ − crashDurationᵢ,  T ≤ target.
 * Crash limits are respected (reductions are capped at the crashable amount).
 */

import { Rational } from '../../math/rational';
import { LPModel, ProjectModel, Constraint } from '../../types/models';
import { solveLP } from '../lp/engine';

export interface CrashPoint {
  duration: number;
  /** extra cost above normal cost */
  crashCost: number;
  totalCost: number;
  reductions: Record<string, number>;
}

export interface CrashResult {
  normalDuration: number;
  minDuration: number;
  normalCost: number;
  curve: CrashPoint[];
  /** per unit step of the curve, which activities changed */
  steps: { fromDuration: number; toDuration: number; addedCost: number; activities: { id: string; reducedBy: number }[] }[];
  notes: string[];
}

const R = (x: number) => Rational.parse(String(x));
const finite = (x: number | undefined) => x === undefined || (Number.isFinite(x) && Math.abs(x) <= 1e12);

/** True when every number the crash LP would read is a usable finite value. */
function usable(model: ProjectModel): boolean {
  return model.activities.every(a => finite(a.duration) && finite(a.crashDuration) && finite(a.normalCost) && finite(a.crashCost));
}

/** Shortest duration reachable when every activity is crashed to its limit (longest path with minimum durations). */
function minimumDuration(model: ProjectModel): number {
  const finish = new Map<string, number>();
  const byId = new Map(model.activities.map(a => [a.id, a]));
  const visit = (id: string, stack: Set<string>): number => {
    const known = finish.get(id);
    if (known !== undefined) return known;
    const a = byId.get(id);
    if (!a || stack.has(id)) return 0;
    stack.add(id);
    const d = a.duration ?? 0;
    const dur = Math.min(d, Math.max(0, a.crashDuration ?? d));
    const f = Math.max(0, ...a.predecessors.map(p => visit(p, stack))) + dur;
    stack.delete(id);
    finish.set(id, f);
    return f;
  };
  return Math.max(0, ...model.activities.map(a => visit(a.id, new Set())));
}
const num = (r: Rational) => Number(r.toDecimal(6));

export function crashAtTarget(model: ProjectModel, target: number): CrashPoint | null {
  if (!usable(model) || !Number.isFinite(target) || Math.abs(target) > 1e12) return null;
  const acts = model.activities;
  const n = acts.length;
  const idx = new Map(acts.map((a, i) => [a.id, i]));
  // variables: s_0..s_{n-1}, r_0..r_{n-1}, T
  const nv = 2 * n + 1;
  const unit = (pairs: [number, number][]): Rational[] => {
    const v: Rational[] = Array(nv).fill(Rational.ZERO);
    pairs.forEach(([k, c]) => { v[k] = v[k]!.add(Rational.of(c)); });
    return v;
  };
  const cons: Constraint[] = [];
  acts.forEach((a, j) => {
    const dj = R(a.duration ?? 0);
    void dj;
    a.predecessors.forEach(p => {
      const i = idx.get(p)!;
      const di = R(acts[i]!.duration ?? 0);
      // s_j − s_i + r_i ≥ d_i
      cons.push({ coeffs: unit([[j, 1], [i, -1], [n + i, 1]]), relation: '>=', rhs: di });
    });
    const d = R(a.duration ?? 0);
    // T − s_a + r_a ≥ d_a
    cons.push({ coeffs: unit([[2 * n, 1], [j, -1], [n + j, 1]]), relation: '>=', rhs: d });
    const maxRed = R(Math.min(Math.max(0, a.duration ?? 0), Math.max(0, (a.duration ?? 0) - (a.crashDuration ?? a.duration ?? 0))));
    cons.push({ coeffs: unit([[n + j, 1]]), relation: '<=', rhs: maxRed });
  });
  cons.push({ coeffs: unit([[2 * n, 1]]), relation: '<=', rhs: R(target) });
  const obj: Rational[] = Array(nv).fill(Rational.ZERO);
  acts.forEach((a, i) => {
    const dn = a.duration ?? 0;
    const dc = a.crashDuration ?? dn;
    // exact cost slope (extra cost per time unit saved); a crash cost below the normal cost is treated as no extra cost
    const slope = dn > dc ? R(a.crashCost ?? 0).sub(R(a.normalCost ?? 0)).div(R(dn).sub(R(dc))) : Rational.ZERO;
    obj[n + i] = slope.isNegative() ? Rational.ZERO : slope;
  });
  const lp: LPModel = { sense: 'min', objective: obj, constraints: cons, varNames: Array.from({ length: nv }, (_, i) => `v${i}`) };
  const sol = solveLP(lp, { emitSteps: false });
  if (!sol.result || sol.status === 'infeasible') return null;
  const reductions: Record<string, number> = {};
  acts.forEach((a, i) => { const r = num(sol.result!.variableValues[n + i]!); if (r > 1e-9) reductions[a.id] = r; });
  const normal = acts.reduce((s, a) => s + (a.normalCost ?? 0), 0);
  const extra = num(sol.result.objectiveValue);
  return { duration: num(sol.result.variableValues[2 * n]!), crashCost: extra, totalCost: normal + extra, reductions };
}

export function crashCurve(model: ProjectModel, normalDuration: number): CrashResult {
  const notes: string[] = [];
  const acts = model.activities;
  const normalCost = acts.reduce((s, a) => s + (Number.isFinite(a.normalCost) ? a.normalCost ?? 0 : 0), 0);
  if (acts.some(a => a.crashDuration === undefined)) notes.push('Activities without a crash duration cannot be shortened.');
  if (acts.some(a => (a.crashCost ?? 0) < (a.normalCost ?? 0) && a.crashDuration !== undefined && a.crashDuration < (a.duration ?? 0))) notes.push('An activity whose crash cost is below its normal cost is treated as having no extra crash cost.');
  const curve: CrashPoint[] = [];
  const first = crashAtTarget(model, normalDuration);
  if (!first) return { normalDuration, minDuration: normalDuration, normalCost, curve: [], steps: [], notes: ['No feasible schedule.'] };
  curve.push({ ...first, duration: normalDuration });
  const floor = minimumDuration(model);
  for (let T = Math.ceil(normalDuration) - 1; T >= 0 && T >= Math.floor(floor); T--) {
    if (T < floor - 1e-9) break;
    const p = crashAtTarget(model, T);
    if (!p) break;
    curve.push({ ...p, duration: T });
  }
  // the true minimum duration can be fractional: add it as the last vertex
  const last = curve[curve.length - 1]!;
  if (floor < last.duration - 1e-9) {
    const p = crashAtTarget(model, floor);
    if (p) curve.push({ ...p, duration: floor });
  }
  const bottom = curve[curve.length - 1]!.duration;
  if (curve.length > 1 || bottom <= normalDuration) notes.push(`The project cannot be shortened below ${bottom} even by crashing every activity to its limit.`);
  const steps: CrashResult['steps'] = [];
  for (let k = 1; k < curve.length; k++) {
    const a = curve[k - 1]!, b = curve[k]!;
    const ids = new Set([...Object.keys(a.reductions), ...Object.keys(b.reductions)]);
    steps.push({ fromDuration: a.duration, toDuration: b.duration, addedCost: Math.round((b.crashCost - a.crashCost) * 1e6) / 1e6, activities: [...ids].map(id => ({ id, reducedBy: Math.round(((b.reductions[id] ?? 0) - (a.reductions[id] ?? 0)) * 1e6) / 1e6 })).filter(x => Math.abs(x.reducedBy) > 1e-9) });
  }
  return { normalDuration, minDuration: bottom, normalCost, curve, steps, notes };
}
