/**
 * Independent brute-force LP oracle: enumerate every vertex of {A x (≤,≥,=) b, x ≥ 0} exactly.
 * Used only by tests (never by the application).
 */
import { Rational } from '../../src/core/math/rational';
import { LPModel } from '../../src/core/types/models';

type Row = { a: Rational[]; rel: '<=' | '>=' | '='; b: Rational };

function solveSquare(A: Rational[][], b: Rational[]): Rational[] | null {
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

function combos(n: number, k: number): number[][] {
  const out: number[][] = [];
  const rec = (start: number, cur: number[]) => {
    if (cur.length === k) { out.push([...cur]); return; }
    for (let i = start; i < n; i++) { cur.push(i); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}

export function feasible(model: LPModel, x: Rational[]): boolean {
  if (x.some(v => v.isNegative())) return false;
  for (const c of model.constraints) {
    let lhs = Rational.ZERO;
    c.coeffs.forEach((a, j) => { lhs = lhs.add(a.mul(x[j]!)); });
    if (c.relation === '<=' && lhs.gt(c.rhs)) return false;
    if (c.relation === '>=' && lhs.lt(c.rhs)) return false;
    if (c.relation === '=' && !lhs.eq(c.rhs)) return false;
  }
  return true;
}

export function objective(model: LPModel, x: Rational[]): Rational {
  let z = model.objectiveConstant ?? Rational.ZERO;
  model.objective.forEach((c, j) => { z = z.add(c.mul(x[j]!)); });
  return z;
}

export interface BruteResult {
  feasibleVertices: Rational[][];
  best: Rational | null;
}

export function bruteVertices(model: LPModel): BruteResult {
  const n = model.objective.length;
  const rows: Row[] = model.constraints.map(c => ({ a: c.coeffs, rel: c.relation, b: c.rhs }));
  for (let j = 0; j < n; j++) {
    rows.push({ a: Array.from({ length: n }, (_, k) => (k === j ? Rational.ONE : Rational.ZERO)), rel: '=', b: Rational.ZERO });
  }
  const verts: Rational[][] = [];
  for (const idx of combos(rows.length, n)) {
    const x = solveSquare(idx.map(i => rows[i]!.a), idx.map(i => rows[i]!.b));
    if (!x) continue;
    if (!feasible(model, x)) continue;
    if (!verts.some(v => v.every((q, k) => q.eq(x[k]!)))) verts.push(x);
  }
  let best: Rational | null = null;
  for (const v of verts) {
    const z = objective(model, v);
    if (best === null || (model.sense === 'max' ? z.gt(best) : z.lt(best))) best = z;
  }
  return { feasibleVertices: verts, best };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

export function randomLP(r: () => number, opts: { allLeq?: boolean; nonNegRhs?: boolean } = {}): LPModel {
  const n = randInt(r, 1, 4);
  const m = randInt(r, 1, 4);
  const objective = Array.from({ length: n }, () => Rational.of(randInt(r, -5, 8)));
  const constraints = Array.from({ length: m }, () => {
    const rel = opts.allLeq ? '<=' : (['<=', '<=', '>=', '='] as const)[randInt(r, 0, 3)]!;
    return {
      coeffs: Array.from({ length: n }, () => Rational.of(randInt(r, -2, 6))),
      relation: rel,
      rhs: Rational.of(opts.nonNegRhs ? randInt(r, 0, 20) : randInt(r, -4, 20)),
    };
  });
  return {
    sense: r() < 0.6 ? 'max' : 'min',
    objective,
    constraints,
    varNames: Array.from({ length: n }, (_, j) => `x${j + 1}`),
  };
}
