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
  let Pn = P.map(r => [...r]);
  const traj: Rational[][] = [];
  const init = model.initialDistribution && model.initialDistribution.length === n ? model.initialDistribution : null;
  if (init) {
    const sum = init.reduce((a, b) => a.add(b), Rational.ZERO);
    if (!sum.eq(Rational.ONE) || init.some(x => x.isNegative())) return { ...base, error: `The initial distribution must be non-negative and sum to 1 (it sums to ${sum.toString()}).` };
  }
  const step = (d: Rational[]) => d.map((_, j) => d.reduce((s, x, i) => s.add(x.mul(P[i]![j]!)), Rational.ZERO));
  if (init) { let d = init; traj.push(d); for (let k = 1; k <= Math.max(targetSteps, 1); k++) { d = step(d); traj.push(d); } }
  for (let k = 2; k <= targetSteps; k++) Pn = Matrix.multiply(Pn, P);
  base.nStep = { n: targetSteps, matrix: Pn, distribution: init ? traj[targetSteps] : undefined };
  base.trajectory = init ? traj : undefined;
  steps.push({ stepNumber: 1, title: `P^${targetSteps}`, explanation: `Entry (i,j) of Pⁿ is the probability of being in state j after n = ${targetSteps} steps starting from state i, computed by repeated matrix multiplication.`, matrixData: Pn, vectorData: init ? traj[targetSteps] : undefined });

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
