/**
 * The primal–dual algorithm (Dantzig–Ford–Fulkerson) for
 *
 *      min c·x   s.t.   A·x = b,  x ≥ 0,   b ≥ 0
 *
 * obtained from the app's standardisation (free/shifted variables substituted, slack and surplus columns added,
 * rows with a negative right-hand side multiplied by −1; a maximisation is turned into a minimisation).
 *
 * Dual:  max b·y  s.t.  Aᵀy ≤ c,  y unrestricted.
 *
 * Start from a dual-feasible y. Repeat:
 *   1. reduced costs d_j = c_j − y·A_j ≥ 0; the ADMISSIBLE set J = { j : d_j = 0 }
 *   2. restricted primal (RP):  min ξ = Σ a_i  s.t.  Σ_{j∈J} A_j x_j + a = b,  x_J, a ≥ 0   (solved exactly with the engine)
 *   3. ξ* = 0  ⇒  x_J is feasible and complementary to y, hence optimal: stop.
 *   4. else take the optimal dual w of RP (so Σ w_i b_i = ξ* > 0, w·A_j ≤ 0 on J, w_i ≤ 1)
 *      – if w·A_j ≤ 0 for every column, y + θw stays dual feasible for all θ ≥ 0 and the dual objective is unbounded
 *        ⇒ the primal is infeasible: stop.
 *      – else θ = min { d_j / (w·A_j) : w·A_j > 0 } and y ← y + θ w.
 *
 * Termination guard: each update raises the dual objective b·y by θ·ξ* > 0 (θ > 0 because every column outside J
 * has d_j > 0), so no y can repeat; the loop is still capped at an iteration limit and a repeated y is reported as
 * cycling instead of looping.
 */

import { Rational } from '../../math/rational';
import { LPModel } from '../../types/models';
import { Step, Highlight, StepStatus } from '../../types/step';
import { genName } from '../../format';
import { buildStandardForm, flipNegativeRhs, recoverVariables } from './standardForm';
import { solveLP, validateLP } from './engine';
import { lhsOf, objectiveAt } from './duality';

export interface PDProblem {
  colNames: string[];
  rowLabels: string[];
  A: Rational[][];
  b: Rational[];
  /** Cost row in MINIMISATION form (slack and surplus columns cost 0). */
  c: Rational[];
  /** Number of structural columns (the rest are slack / surplus). */
  nStruct: number;
}

export interface PDState {
  problem: PDProblem;
  stage: 'setup' | 'start' | 'restricted' | 'update' | 'done';
  iteration: number;
  y: Rational[] | null;
  dualObjective: Rational | null;
  reduced: Rational[] | null;
  admissible: boolean[] | null;
  rp: { xi: Rational; x: Rational[]; art: Rational[]; w: Rational[] } | null;
  direction: { wA: Rational[]; theta: Rational | null; blocking: number[]; newY: Rational[] | null; unbounded: boolean } | null;
  primalX: Rational[] | null;
}

export type PDStatus = 'optimal' | 'infeasible' | 'no-dual-start' | 'iteration-limit' | 'cycling' | 'invalid';

export interface PDResult {
  status: PDStatus;
  steps: Step<PDState>[];
  problem: PDProblem | null;
  /** Solution in the ORIGINAL variables (null unless optimal). */
  x: Rational[] | null;
  /** Objective in the original sense, including any constant. */
  objective: Rational | null;
  y: Rational[] | null;
  iterations: number;
  message: string;
}

const Z = Rational.ZERO;

export function buildPDProblem(model: LPModel): { problem: PDProblem; notes: string[]; sfNotes: string[]; sf: ReturnType<typeof buildStandardForm> } {
  const sf = buildStandardForm(model);
  const { rows, notes } = flipNegativeRhs(sf.rows);
  const ny = sf.yNames.length;
  const colNames = [...sf.yNames];
  const slackCol: (number | null)[] = rows.map(() => null);
  rows.forEach((r, i) => {
    if (r.relation === '<=') { slackCol[i] = colNames.length; colNames.push(genName('s', i + 1)); }
    else if (r.relation === '>=') { slackCol[i] = colNames.length; colNames.push(genName('e', i + 1)); }
  });
  const N = colNames.length;
  const A = rows.map((r, i) => {
    const row: Rational[] = Array(N).fill(Z);
    r.coeffs.forEach((v, j) => { row[j] = v; });
    const sc = slackCol[i];
    if (sc !== null && sc !== undefined) row[sc] = r.relation === '<=' ? Rational.ONE : Rational.MINUS_ONE;
    return row;
  });
  const c: Rational[] = Array(N).fill(Z);
  for (let j = 0; j < ny; j++) c[j] = sf.costMax[j]!.neg();
  return {
    problem: { colNames, rowLabels: rows.map(r => r.label), A, b: rows.map(r => r.rhs), c, nStruct: ny },
    notes,
    sfNotes: sf.notes,
    sf,
  };
}

const q = (v: Rational) => v.toString();
const vec = (v: Rational[]) => `(${v.map(q).join(', ')})`;
const col = (p: PDProblem, j: number) => p.A.map(r => r[j]!);
const dot = (a: Rational[], b: Rational[]) => lhsOf(a, b);

function findDualStart(p: PDProblem): Rational[] | null {
  const m = p.A.length;
  const N = p.c.length;
  const model: LPModel = {
    sense: 'max',
    objective: Array(m).fill(Z),
    constraints: Array.from({ length: N }, (_, j) => ({ coeffs: col(p, j), relation: '<=' as const, rhs: p.c[j]!, name: p.colNames[j] })),
    varNames: Array.from({ length: m }, (_, i) => `y${i + 1}`),
    varBounds: Array.from({ length: m }, () => ({ lower: null, upper: null })),
  };
  const s = solveLP(model, { method: 'auto', emitSteps: false });
  if ((s.status === 'optimal' || s.status === 'optimal-alternate-exists') && s.result) return s.result.variableValues;
  return null;
}

export function solvePrimalDual(model: LPModel, opts: { maxIterations?: number } = {}): PDResult {
  const v = validateLP(model);
  if (!v.valid) {
    return { status: 'invalid', steps: [], problem: null, x: null, objective: null, y: null, iterations: 0, message: v.errors[0]?.message ?? 'The model is not valid.' };
  }
  const { problem: P, notes, sfNotes, sf } = buildPDProblem(model);
  const m = P.A.length;
  const N = P.c.length;
  const maxIt = opts.maxIterations ?? Math.max(60, 6 * (m + N));
  const steps: Step<PDState>[] = [];
  const empty = (stage: PDState['stage'], iteration: number): PDState => ({ problem: P, stage, iteration, y: null, dualObjective: null, reduced: null, admissible: null, rp: null, direction: null, primalX: null });
  const push = (phase: string, state: PDState, short: string, detailed: string, rule: string, status: StepStatus, highlights: Highlight[] = [], formula?: string, note?: string) => {
    steps.push({ index: steps.length, phase, state, action: { kind: state.stage, payload: null }, explanation: { short, detailed, rule, formula, note }, highlights, status });
  };
  const fail = (status: PDStatus, message: string, y: Rational[] | null = null, it = 0): PDResult => ({ status, steps, problem: P, x: null, objective: null, y, iterations: it, message });

  const normNote = [...sfNotes, ...notes].join(' ');
  push(
    'Set-up',
    empty('setup', 0),
    `Write the problem as min c·x subject to A·x = b, x ≥ 0 with b ≥ 0 (${m} equation${m === 1 ? '' : 's'}, ${N} variable${N === 1 ? '' : 's'}).`,
    `The primal–dual method works on the equality form. Slack variables s turn ≤ rows into equations, surplus variables e turn ≥ rows into equations, rows with a negative right-hand side are multiplied by −1, and a maximisation is turned into a minimisation of −z. Its dual is: maximise b·y subject to Aᵀy ≤ c with y unrestricted in sign.${normNote ? ' ' + normNote : ''}`,
    'Equality form with b ≥ 0',
    'initial',
    [],
    '\\min\\; c^{T}x \\;\\; \\text{s.t.}\\;\\; Ax=b,\\; x\\ge 0 \\qquad\\qquad \\max\\; b^{T}y \\;\\; \\text{s.t.}\\;\\; A^{T}y\\le c',
  );

  if (m === 0) {
    const neg = P.c.some(c => c.isNegative());
    if (neg) return fail('no-dual-start', 'There are no constraints and some cost is negative, so the minimisation is unbounded.');
    const x = recoverVariables(sf, P.c.slice(0, P.nStruct).map(() => Z));
    return { status: 'optimal', steps, problem: P, x, objective: objectiveAt(model, x), y: [], iterations: 0, message: 'No constraints and all costs are non-negative: x = 0 is optimal.' };
  }

  // ---- dual-feasible start ----
  let y: Rational[];
  const allNonNeg = P.c.every(c => !c.isNegative());
  if (allNonNeg) {
    y = Array(m).fill(Z);
  } else {
    const ys = findDualStart(P);
    if (!ys) {
      push('Dual-feasible start', { ...empty('start', 0) }, 'No dual-feasible starting point exists.',
        'Some cost is negative, so y = 0 is not dual feasible, and the helper problem "find y with Aᵀy ≤ c" has no solution. The dual is infeasible, so the primal is either infeasible or unbounded; the primal–dual method cannot start. The ordinary simplex family (Two-Phase or Big-M) decides which of the two it is. If you can find any dual-feasible y by hand the algorithm applies; with an all-≥ minimisation (c ≥ 0) the dual simplex also applies directly.',
        'Need a dual-feasible y', 'infeasible');
      return fail('no-dual-start', 'No dual-feasible starting point exists (the dual is infeasible), so the primal–dual algorithm cannot start. Use Two-Phase or Big-M to decide between infeasible and unbounded.');
    }
    y = ys;
  }
  const dualObj = (yy: Rational[]) => dot(P.b, yy);
  const reducedOf = (yy: Rational[]) => P.c.map((cj, j) => cj.sub(dot(col(P, j), yy)));

  {
    const d = reducedOf(y);
    const st = { ...empty('start', 0), y, dualObjective: dualObj(y), reduced: d, admissible: d.map(x => x.isZero()) };
    push('Dual-feasible start', st,
      allNonNeg ? `All costs are ≥ 0, so y = 0 is dual feasible. Dual objective b·y = ${q(st.dualObjective)}.` : `Start from the dual-feasible point y = ${vec(y)} found by a feasibility helper LP. Dual objective b·y = ${q(st.dualObjective)}.`,
      allNonNeg
        ? 'Dual feasibility means every reduced cost c_j − y·A_j is ≥ 0. With y = 0 the reduced costs are just the costs c_j, which are all non-negative here (slack and surplus columns cost 0). The columns whose reduced cost is exactly 0 are "admissible".'
        : 'Because some cost is negative, y = 0 is not dual feasible. A small helper LP (maximise 0 subject to Aᵀy ≤ c, y free) supplies a dual-feasible y. The columns whose reduced cost is exactly 0 are "admissible".',
      'Dual feasibility: Aᵀy ≤ c', 'continue',
      st.admissible.map((a, j) => ({ target: `col:${j}`, intent: a ? 'candidate' : 'blocked' }) as Highlight),
      'd_j = c_j - y^{T}A_j \\ge 0');
  }

  const seen = new Set<string>();
  for (let it = 1; it <= maxIt; it++) {
    const key = y.map(q).join('|');
    if (seen.has(key)) return fail('cycling', 'The dual vector repeated, which the strictly increasing dual objective rules out; stopped to be safe.', y, it - 1);
    seen.add(key);

    const d = reducedOf(y);
    const adm = d.map(x => x.isZero());
    const J = adm.map((a, j) => (a ? j : -1)).filter(j => j >= 0);
    const cheapDual = dualObj(y);

    // ---- restricted primal ----
    const rpModel: LPModel = {
      sense: 'min',
      objective: [...J.map(() => Z), ...Array.from({ length: m }, () => Rational.ONE)],
      constraints: P.A.map((row, i) => ({
        coeffs: [...J.map(j => row[j]!), ...Array.from({ length: m }, (_, k) => (k === i ? Rational.ONE : Z))],
        relation: '=' as const,
        rhs: P.b[i]!,
        name: P.rowLabels[i],
      })),
      varNames: [...J.map(j => P.colNames[j]!), ...Array.from({ length: m }, (_, i) => genName('a', i + 1))],
    };
    const rs = solveLP(rpModel, { method: 'auto', emitSteps: false });
    if (!(rs.status === 'optimal' || rs.status === 'optimal-alternate-exists') || !rs.result) {
      return fail('invalid', 'The restricted primal could not be solved to optimality (internal error).', y, it - 1);
    }
    const xi = rs.result.objectiveValue;
    const xJ: Rational[] = Array(N).fill(Z);
    J.forEach((j, k) => { xJ[j] = rs.result!.variableValues[k]!; });
    const art = rs.result.variableValues.slice(J.length);
    const w = rs.result.dualValues;

    // sanity: w must be an optimal dual of RP
    const okW = w.length === m && dot(P.b, w).eq(xi) && w.every(wi => wi.lte(Rational.ONE)) && J.every(j => dot(col(P, j), w).lte(Z));
    if (!okW) return fail('invalid', 'The restricted-primal dual vector failed its optimality check (internal error).', y, it - 1);

    const base: PDState = { ...empty('restricted', it), y: [...y], dualObjective: cheapDual, reduced: d, admissible: adm, rp: { xi, x: xJ, art, w } };
    const colHl: Highlight[] = adm.map((a, j) => ({ target: `col:${j}`, intent: a ? 'candidate' : 'blocked' }) as Highlight);
    const admNames = J.length ? J.map(j => P.colNames[j]).join(', ') : 'none';

    if (xi.isZero()) {
      const state: PDState = { ...base, stage: 'done', primalX: xJ };
      push(`Iteration ${it} · restricted primal`, state,
        `Admissible columns {${admNames}}; restricted primal gives ξ* = 0. Optimal: x = ${vec(xJ)}.`,
        `With y = ${vec(y)} the reduced costs are ${vec(d)}, so the admissible columns are {${admNames}}. The restricted primal minimises the sum of artificial variables using only those columns; its optimum is ξ* = 0, so the artificials vanish and x = ${vec(xJ)} satisfies A·x = b, x ≥ 0 using only columns whose dual constraint is tight. That is complementary slackness: x is primal feasible, y is dual feasible, and they are complementary, so both are optimal.`,
        'ξ* = 0 ⇒ optimal (complementary slackness)', 'optimal', colHl, '\\xi^{*}=0 \\Rightarrow x \\text{ and } y \\text{ optimal}');
      const x = recoverVariables(sf, xJ.slice(0, P.nStruct));
      return { status: 'optimal', steps, problem: P, x, objective: objectiveAt(model, x), y: [...y], iterations: it, message: 'Optimal: the restricted primal reached ξ* = 0.' };
    }

    const wA = P.colNames.map((_, j) => dot(col(P, j), w));
    const outside = wA.map((v2, j) => (!adm[j] && v2.isPositive() ? j : -1)).filter(j => j >= 0);
    const unbounded = outside.length === 0;
    push(`Iteration ${it} · restricted primal`, { ...base, direction: { wA, theta: null, blocking: [], newY: null, unbounded } },
      `Admissible columns {${admNames}}; restricted primal has ξ* = ${q(xi)} > 0, so y is not yet optimal. Dual direction w = ${vec(w)}.`,
      `With y = ${vec(y)} the reduced costs are ${vec(d)}; admissible columns (reduced cost 0): {${admNames}}. Using only those columns the artificial variables cannot be driven to 0: ξ* = ${q(xi)}. The optimal dual solution of this restricted problem, w = ${vec(w)}, is an improving direction for the dual: b·w = ${q(dot(P.b, w))} = ξ* > 0, and w·A_j ≤ 0 on every admissible column, so moving y along w keeps those constraints tight or slack.`,
      'Restricted primal: minimise artificials over admissible columns', 'continue', colHl, '\\xi^{*}=\\min \\textstyle\\sum a_i > 0');

    if (unbounded) {
      const state: PDState = { ...base, stage: 'done', direction: { wA, theta: null, blocking: [], newY: null, unbounded: true } };
      push(`Iteration ${it} · dual update`, state,
        'Every column has w·A_j ≤ 0, so the dual is unbounded and the primal is infeasible.',
        `No column outside the admissible set has w·A_j > 0, so y + θw satisfies Aᵀy ≤ c for every θ ≥ 0 while the dual objective b·y grows without limit (b·w = ${q(xi)} > 0). An unbounded dual means the primal has no feasible point (by weak duality any primal-feasible x would bound b·y above).`,
        'Dual unbounded ⇒ primal infeasible', 'infeasible', colHl);
      return { status: 'infeasible', steps, problem: P, x: null, objective: null, y: [...y], iterations: it, message: 'Primal infeasible: the dual objective is unbounded along w.' };
    }

    let theta: Rational | null = null;
    outside.forEach(j => { const r = d[j]!.div(wA[j]!); if (theta === null || r.lt(theta)) theta = r; });
    const th = theta as unknown as Rational;
    const blocking = outside.filter(j => d[j]!.div(wA[j]!).eq(th));
    const newY = y.map((yi, i) => yi.add(th.mul(w[i]!)));
    const state: PDState = { ...base, stage: 'update', direction: { wA, theta: th, blocking, newY, unbounded: false } };
    const ratios = outside.map(j => `${P.colNames[j]}: ${q(d[j]!)}/${q(wA[j]!)} = ${q(d[j]!.div(wA[j]!))}`).join('; ');
    push(`Iteration ${it} · dual update`, state,
      `θ = ${q(th)} (set by ${blocking.map(j => P.colNames[j]).join(', ')}); new y = ${vec(newY)}, dual objective ${q(cheapDual)} → ${q(dualObj(newY))}.`,
      `Only columns outside the admissible set with w·A_j > 0 can lose dual feasibility, so the step is θ = min d_j/(w·A_j) over them: ${ratios}. The minimum θ = ${q(th)} is reached by ${blocking.map(j => P.colNames[j]).join(', ')}, whose reduced cost drops to 0, so ${blocking.length === 1 ? 'it becomes' : 'they become'} admissible. New y = y + θw = ${vec(newY)}. The dual objective rises by θ·ξ* = ${q(th.mul(xi))}.`,
      'Step θ = min d_j / (w·A_j), w·A_j > 0', 'continue',
      [...blocking.map(j => ({ target: `col:${j}`, intent: 'entering' }) as Highlight), ...colHl.filter(h => h.intent === 'candidate')],
      '\\theta=\\min_{w^{T}A_j>0}\\dfrac{d_j}{w^{T}A_j},\\quad y\\leftarrow y+\\theta w');
    y = newY;
  }
  push('Stopped', { ...empty('done', maxIt), y }, `Stopped after ${maxIt} iterations.`, 'The iteration limit was reached before the restricted primal reached zero.', 'Iteration guard', 'iteration-limit');
  return fail('iteration-limit', `Stopped after ${maxIt} iterations without reaching ξ* = 0.`, y, maxIt);
}
