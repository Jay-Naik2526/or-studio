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
const num = (r: Rational) => Number(r.toDecimal(6));

export function crashAtTarget(model: ProjectModel, target: number): CrashPoint | null {
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
    const maxRed = R(Math.max(0, (a.duration ?? 0) - (a.crashDuration ?? a.duration ?? 0)));
    cons.push({ coeffs: unit([[n + j, 1]]), relation: '<=', rhs: maxRed });
  });
  cons.push({ coeffs: unit([[2 * n, 1]]), relation: '<=', rhs: R(target) });
  const obj: Rational[] = Array(nv).fill(Rational.ZERO);
  acts.forEach((a, i) => {
    const dn = a.duration ?? 0;
    const dc = a.crashDuration ?? dn;
    const slope = dn > dc ? (( (a.crashCost ?? 0) - (a.normalCost ?? 0)) / (dn - dc)) : 0;
    obj[n + i] = R(Math.round(slope * 1e6) / 1e6);
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
  const normalCost = acts.reduce((s, a) => s + (a.normalCost ?? 0), 0);
  if (acts.some(a => a.crashDuration === undefined)) notes.push('Activities without a crash duration cannot be shortened.');
  const curve: CrashPoint[] = [];
  let T = Math.ceil(normalDuration);
  const first = crashAtTarget(model, normalDuration);
  if (!first) return { normalDuration, minDuration: normalDuration, normalCost, curve: [], steps: [], notes: ['No feasible schedule.'] };
  curve.push({ ...first, duration: normalDuration });
  for (T = Math.ceil(normalDuration) - (Number.isInteger(normalDuration) ? 1 : 0); T >= 0; T--) {
    const p = crashAtTarget(model, T);
    if (!p) { notes.push(`The project cannot be shortened below ${T + 1} even by crashing every activity to its limit.`); break; }
    curve.push({ ...p, duration: T });
  }
  const steps: CrashResult['steps'] = [];
  for (let k = 1; k < curve.length; k++) {
    const a = curve[k - 1]!, b = curve[k]!;
    const ids = new Set([...Object.keys(a.reductions), ...Object.keys(b.reductions)]);
    steps.push({ fromDuration: a.duration, toDuration: b.duration, addedCost: Math.round((b.crashCost - a.crashCost) * 1e6) / 1e6, activities: [...ids].map(id => ({ id, reducedBy: Math.round(((b.reductions[id] ?? 0) - (a.reductions[id] ?? 0)) * 1e6) / 1e6 })).filter(x => Math.abs(x.reducedBy) > 1e-9) });
  }
  return { normalDuration, minDuration: curve[curve.length - 1]!.duration, normalCost, curve, steps, notes };
}
