/**
 * Markov chains (spec §9.4, §10.6) — exact rational arithmetic.
 * n-step transitions, communicating classes, periodicity, steady state / stationary distribution,
 * absorbing-chain analysis (fundamental matrix, absorption probabilities, expected steps) and mean first-passage times.
 * Non-stochastic matrices are REJECTED with the offending row and its sum.
 */

import { Rational } from '../../math/rational';
import { Matrix } from '../../math/matrix';

export interface MarkovModel {
  transitionMatrix: Rational[][];
  stateNames?: string[];
  initialDistribution?: Rational[];
}

export interface MarkovStep { stepNumber: number; title: string; explanation: string; matrixData?: Rational[][]; vectorData?: Rational[] }

export interface ChainClass { states: number[]; closed: boolean; period: number }

export interface MarkovResult {
  error?: string;
  size: number;
  names: string[];
  /** the validated transition matrix */
  matrix: Rational[][];
  nStep?: { n: number; matrix: Rational[][]; distribution?: Rational[] };
  /** distribution after 0..n steps (for the convergence animation) */
  trajectory?: Rational[][];
  classes: ChainClass[];
  irreducible: boolean;
  periodic: boolean;
  period: number;
  steadyState?: { distribution: Rational[]; unique: boolean; limiting: boolean; note: string };
  absorbing?: {
    absorbingStates: number[];
    transientStates: number[];
    fundamental?: Rational[][];
    absorptionProbabilities?: Rational[][];
    expectedSteps?: Rational[];
  };
  firstPassage?: Rational[][]; // m_ij: mean first passage time i → j (i≠j), m_ii = mean recurrence time
  steps: MarkovStep[];
  diagnostics: { severity: 'info' | 'warning' | 'error'; code: string; message: string }[];
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

function solveLinear(A: Rational[][], b: Rational[]): Rational[] | null {
  const n = A.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    while (p < n && M[p]![c]!.isZero()) p++;
    if (p === n) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const inv = M[c]![c]!.inv();
    M[c] = M[c]!.map(v => v.mul(inv));
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f.isZero()) continue;
      M[r] = M[r]!.map((v, k) => v.sub(f.mul(M[c]![k]!)));
    }
  }
  return M.map(r => r[n]!);
}

export function validateTransitionMatrix(P: Rational[][]): string | null {
  const n = P.length;
  if (n === 0) return 'The transition matrix is empty.';
  for (let i = 0; i < n; i++) {
    if (P[i]!.length !== n) return `The matrix must be square: row ${i + 1} has ${P[i]!.length} entries but there are ${n} states.`;
    let sum = Rational.ZERO;
    for (let j = 0; j < n; j++) {
      if (P[i]![j]!.isNegative()) return `Probability in row ${i + 1}, column ${j + 1} is negative (${P[i]![j]!.toString()}).`;
      sum = sum.add(P[i]![j]!);
    }
    if (!sum.eq(Rational.ONE)) return `Row ${i + 1} sums to ${sum.toString()}${sum.d !== 1n ? ` (≈ ${sum.toDecimal(4)})` : ''}, not 1: a transition matrix must be row-stochastic.`;
  }
  return null;
}

/** Largest numerator/denominator size (in bits) accepted per probability; keeps the exact analysis fast. */
export const MAX_ENTRY_BITS = 600;
/** Budget for (bits of the common denominator) × (number of steps): bounds the size of the exact n-step numbers. */
export const MAX_POWER_BITS = 40000;
/** Largest (bits² · states · steps) for which the whole exact trajectory is computed (about two seconds). */
const MAX_EXACT_TRAJECTORY_COST = 2e11;

const bitLength = (x: bigint) => (x < 0n ? -x : x).toString(2).length;
const lcm = (a: bigint, b: bigint) => { let x = a, y = b; while (y) [x, y] = [y, x % y]; return (a / x) * b; };
const commonDenominator = (xs: Rational[]) => xs.reduce((acc, e) => lcm(acc, e.d), 1n);

/** Distributions v₀…v_k (v_{j+1} = v_j P) in exact arithmetic without a gcd per step: integers over D_v·D^j, reduced once per output. */
function exactTrajectory(v0: Rational[], P: Rational[][], k: number): Rational[][] {
  const n = P.length;
  const D = commonDenominator(P.flat());
  const M = P.map(r => r.map(e => e.n * (D / e.d)));
  const Dv = commonDenominator(v0);
  let v = v0.map(e => e.n * (Dv / e.d));
  let den = Dv;
  const out: Rational[][] = [v0];
  for (let step = 1; step <= k; step++) {
    v = Array.from({ length: n }, (_, j) => v.reduce((acc, x, i) => acc + x * M[i]![j]!, 0n));
    den *= D;
    out.push(v.map(x => Rational.of(x, den)));
  }
  return out;
}

/** Pᵏ in exact arithmetic: integer matrix power (square-and-multiply) over D^k, reduced once at the end (k ≥ 0). */
function exactPower(P: Rational[][], k: number): Rational[][] {
  const n = P.length;
  if (k === 0) return P.map((r, i) => r.map((_, j) => (i === j ? Rational.ONE : Rational.ZERO)));
  const D = commonDenominator(P.flat());
  const mul = (X: bigint[][], Y: bigint[][]) => X.map(row => Array.from({ length: n }, (_, j) => row.reduce((acc, x, i) => acc + x * Y[i]![j]!, 0n)));
  let base = P.map(r => r.map(e => e.n * (D / e.d)));
  let R: bigint[][] | null = null;
  for (let e = k; e > 0; e >>= 1) {
    if (e & 1) R = R ? mul(R, base) : base;
    if (e > 1) base = mul(base, base);
  }
  const den = D ** BigInt(k);
  return R!.map(row => row.map(x => Rational.of(x, den)));
}

export function solveMarkovChain(model: MarkovModel, targetSteps = 5): MarkovResult {
  const P = model.transitionMatrix;
  const n = P.length;
  const names = Array.from({ length: n }, (_, i) => model.stateNames?.[i] ?? `State ${i + 1}`);
  const base: MarkovResult = { size: n, names, matrix: P, classes: [], irreducible: false, periodic: false, period: 1, steps: [], diagnostics: [] };
  const bad = validateTransitionMatrix(P);
  if (bad) return { ...base, error: bad };
  const steps = base.steps;

  // n-step (exact rational powers: the digit count grows with every multiplication, so the horizon is bounded)
  if (!Number.isInteger(targetSteps) || targetSteps < 0 || targetSteps > 500) return { ...base, error: 'The number of steps n must be a whole number between 0 and 500.' };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const e = P[i]![j]!; if (bitLength(e.n) > MAX_ENTRY_BITS || bitLength(e.d) > MAX_ENTRY_BITS) return { ...base, error: `The probability in row ${i + 1}, column ${j + 1} has too many digits (limit about ${Math.floor(MAX_ENTRY_BITS * 0.30103)} digits in numerator or denominator): use a simpler decimal or fraction.` }; }
  if (bitLength(commonDenominator(P.flat())) * Math.max(1, targetSteps) > MAX_POWER_BITS) return { ...base, error: 'The exact n-step probabilities would need numbers with thousands of digits (the probabilities have too many digits for this many steps). Use fewer steps or simpler probabilities.' };
  const traj: Rational[][] = [];
  const init = model.initialDistribution && model.initialDistribution.length === n ? model.initialDistribution : null;
  if (init) {
    const sum = init.reduce((a, b) => a.add(b), Rational.ZERO);
    if (!sum.eq(Rational.ONE) || init.some(x => x.isNegative())) return { ...base, error: `The initial distribution must be non-negative and sum to 1 (it sums to ${sum.toString()}).` };
  }
  const Pn = exactPower(P, targetSteps);
  let finalDistribution: Rational[] | undefined;
  if (init) {
    finalDistribution = init.map((_, j) => init.reduce((acc, x, i) => acc.add(x.mul(Pn[i]![j]!)), Rational.ZERO));
    // the exact distributions v₀…v_n cost about (digits)²·n² to reduce; beyond that budget the chart uses 15-digit decimal values instead
    const horizon = Math.max(targetSteps, 1);
    const bits = bitLength(commonDenominator(init)) + bitLength(commonDenominator(P.flat())) * horizon;
    if (bits * bits * n * horizon <= MAX_EXACT_TRAJECTORY_COST) traj.push(...exactTrajectory(init, P, horizon));
    else {
      const Pf = P.map(r => r.map(e => Number(e.n) / Number(e.d)));
      let v = init.map(e => Number(e.n) / Number(e.d));
      traj.push(init);
      for (let k = 1; k <= horizon; k++) {
        v = v.map((_, j) => Pf.reduce((acc, row, i) => acc + v[i]! * row[j]!, 0));
        traj.push(v.map(x => Rational.parse((Number.isFinite(x) && x > 0 ? x : 0).toPrecision(15))));
      }
      base.diagnostics.push({ severity: 'info', code: 'TRAJECTORY_APPROXIMATE', message: 'The probabilities have so many digits that the step-by-step distributions in the chart are shown as 15-digit decimals; the n-step matrix, the final distribution and every other result are exact.' });
    }
  }
  base.nStep = { n: targetSteps, matrix: Pn, distribution: finalDistribution };
  base.trajectory = init ? traj : undefined;
  steps.push({ stepNumber: 1, title: `P^${targetSteps}`, explanation: `Entry (i,j) of Pⁿ is the probability of being in state j after n = ${targetSteps} steps starting from state i, computed by repeated matrix multiplication.`, matrixData: Pn, vectorData: finalDistribution });

  // reachability & classes
  const reach: boolean[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j || !P[i]![j]!.isZero()));
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (reach[i]![k] && reach[k]![j]) reach[i]![j] = true;
  const seen = Array(n).fill(false);
  const classes: ChainClass[] = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    const comp = [i];
    seen[i] = true;
    for (let j = i + 1; j < n; j++) if (reach[i]![j] && reach[j]![i]) { comp.push(j); seen[j] = true; }
    const closed = comp.every(a => P[a]!.every((p, b) => p.isZero() || comp.includes(b)));
    // period via BFS levels
    let period = 0;
    if (comp.length > 1 || !P[comp[0]!]![comp[0]!]!.isZero()) {
      const level = new Map<number, number>([[comp[0]!, 0]]);
      const q = [comp[0]!];
      while (q.length) {
        const u = q.shift()!;
        for (const v of comp) {
          if (P[u]![v]!.isZero()) continue;
          if (!level.has(v)) { level.set(v, level.get(u)! + 1); q.push(v); }
          else period = gcd(period, level.get(u)! + 1 - level.get(v)!);
        }
      }
    }
    classes.push({ states: comp, closed, period: period || 1 });
  }
  base.classes = classes;
  base.irreducible = classes.length === 1;
  const closedClasses = classes.filter(c => c.closed);
  const per = closedClasses.length ? closedClasses.map(c => c.period).reduce(gcd) : 1;
  base.period = per;
  base.periodic = closedClasses.some(c => c.period > 1);
  steps.push({ stepNumber: steps.length + 1, title: 'Communicating classes', explanation: `Classes: ${classes.map(c => `{${c.states.map(s => names[s]).join(', ')}} (${c.closed ? 'closed/recurrent' : 'open/transient'}${c.closed ? `, period ${c.period}` : ''})`).join('; ')}.` });
  if (!base.irreducible) base.diagnostics.push({ severity: 'info', code: 'REDUCIBLE', message: `The chain is reducible: ${closedClasses.length} closed class(es) ${closedClasses.map(c => `{${c.states.map(s => names[s]).join(', ')}}`).join(' and ')}.${closedClasses.length > 1 ? ' The limiting distribution depends on the starting state.' : ''}` });
  if (base.periodic) base.diagnostics.push({ severity: 'warning', code: 'PERIODIC', message: `A recurrent class has period > 1 (period ${per}). Pⁿ does not converge, so no limiting distribution exists — but the stationary distribution πP = π still describes the long-run fraction of time in each state.` });

  // absorbing analysis
  const absorbing = P.map((_, i) => i).filter(i => P[i]![i]!.eq(Rational.ONE));
  const transient = P.map((_, i) => i).filter(i => !absorbing.includes(i));
  if (absorbing.length && transient.length) {
    const Q = transient.map(r => transient.map(c => P[r]![c]!));
    const Rm = transient.map(r => absorbing.map(c => P[r]![c]!));
    const IQ = Q.map((row, i) => row.map((v, j) => (i === j ? Rational.ONE : Rational.ZERO).sub(v)));
    try {
      const N = Matrix.inverse(IQ);
      const B = Matrix.multiply(N, Rm);
      const t = N.map(row => row.reduce((a, b) => a.add(b), Rational.ZERO));
      base.absorbing = { absorbingStates: absorbing, transientStates: transient, fundamental: N, absorptionProbabilities: B, expectedSteps: t };
      steps.push({ stepNumber: steps.length + 1, title: 'Fundamental matrix N = (I − Q)⁻¹', explanation: `Reorder states as transient ${transient.map(s => names[s]).join(', ')} and absorbing ${absorbing.map(s => names[s]).join(', ')}. Nᵢⱼ is the expected number of visits to transient state j starting from i; row sums give the expected steps to absorption; B = N·R gives absorption probabilities.`, matrixData: N });
    } catch {
      base.absorbing = { absorbingStates: absorbing, transientStates: transient };
      base.diagnostics.push({ severity: 'warning', code: 'ABSORPTION_NOT_CERTAIN', message: 'I − Q is singular: some transient states cannot reach an absorbing state, so absorption is not certain.' });
    }
  } else base.absorbing = { absorbingStates: absorbing, transientStates: transient };

  // stationary distribution
  const stat = stationary(P);
  if (stat) {
    base.steadyState = {
      distribution: stat.pi,
      unique: stat.unique,
      limiting: !base.periodic && classes.filter(c => c.closed).length === 1,
      note: !stat.unique ? 'Several stationary distributions exist (reducible chain): this is one of them.' : base.periodic ? 'This is the long-run fraction of time spent in each state (the chain is periodic, so Pⁿ itself does not converge).' : 'Unique steady-state distribution: the rows of Pⁿ converge to it.',
    };
    steps.push({ stepNumber: steps.length + 1, title: 'Steady state πP = π, Σπ = 1', explanation: `Solve the linear system (Pᵀ − I)π = 0 together with Σπᵢ = 1 exactly: π = (${stat.pi.map(x => x.toString()).join(', ')}).`, vectorData: stat.pi });
  }

  // mean first-passage times (irreducible only)
  if (base.irreducible) {
    const m: Rational[][] = Array.from({ length: n }, () => Array(n).fill(Rational.ZERO));
    for (let j = 0; j < n; j++) {
      // m_ij = 1 + Σ_{k≠j} p_ik m_kj  for i≠j
      const others = P.map((_, i) => i).filter(i => i !== j);
      if (others.length) {
        const A = others.map((i, r) => others.map((k, c) => (r === c ? Rational.ONE : Rational.ZERO).sub(P[i]![k]!)));
        const sol = solveLinear(A, others.map(() => Rational.ONE));
        if (sol) others.forEach((i, r) => (m[i]![j] = sol[r]!));
      }
      m[j]![j] = Rational.ONE.add(others.reduce((s, k) => s.add(P[j]![k]!.mul(m[k]![j]!)), Rational.ZERO));
    }
    base.firstPassage = m;
    steps.push({ stepNumber: steps.length + 1, title: 'Mean first-passage times', explanation: 'mᵢⱼ = 1 + Σₖ≠ⱼ pᵢₖ mₖⱼ gives the expected number of steps to first reach j from i; the diagonal is the mean recurrence time 1/πⱼ.', matrixData: m });
  }
  return base;
}

/** Stationary distribution; unique flag indicates a single closed class. */
function stationary(P: Rational[][]): { pi: Rational[]; unique: boolean } | null {
  const n = P.length;
  // equations: for j in 0..n-2: Σ_i π_i (P_ij − δ_ij) = 0 ; plus Σπ = 1.  If singular, drop to least-squares via search of free params
  const A: Rational[][] = [];
  const b: Rational[] = [];
  for (let j = 0; j < n - 1; j++) { A.push(P.map((row, i) => row[j]!.sub(i === j ? Rational.ONE : Rational.ZERO))); b.push(Rational.ZERO); }
  A.push(Array(n).fill(Rational.ONE)); b.push(Rational.ONE);
  const sol = solveLinear(A, b);
  if (sol) return { pi: sol, unique: true };
  // reducible: solve restricted to the first closed class (gauss with free variables set to 0)
  const M = A.map((r, i) => [...r, b[i]!]);
  let row = 0;
  const pivCol: number[] = [];
  for (let c = 0; c < n && row < n; c++) {
    let p = row;
    while (p < n && M[p]![c]!.isZero()) p++;
    if (p === n) continue;
    [M[row], M[p]] = [M[p]!, M[row]!];
    const inv = M[row]![c]!.inv();
    M[row] = M[row]!.map(v => v.mul(inv));
    for (let r = 0; r < n; r++) if (r !== row) { const f = M[r]![c]!; if (!f.isZero()) M[r] = M[r]!.map((v, k) => v.sub(f.mul(M[row]![k]!))); }
    pivCol.push(c);
    row++;
  }
  const pi: Rational[] = Array(n).fill(Rational.ZERO);
  pivCol.forEach((c, r) => (pi[c] = M[r]![n]!));
  if (pi.some(x => x.isNegative())) return null;
  return { pi, unique: false };
}
