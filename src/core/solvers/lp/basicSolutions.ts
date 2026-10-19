/**
 * Enumeration of all basic solutions of an LP in standard form (slack / surplus columns added).
 *
 * For m independent equations in n unknowns every choice of m columns is a candidate basis. Each one is solved
 * exactly (rational arithmetic) and classified:
 *   singular   – the chosen columns are linearly dependent, so they are not a basis
 *   infeasible – a basic variable is negative (a basic solution, but outside the feasible region)
 *   feasible   – a basic feasible solution = an extreme point of the feasible region
 *   degenerate – feasible and at least one basic variable equals 0
 */

import { Rational } from '../../math/rational';
import { LPModel } from '../../types/models';
import { genName } from '../../format';
import { buildStandardForm, recoverVariables } from './standardForm';
import { validateLP } from './engine';
import { isFeasiblePoint, objectiveAt } from './duality';

export const MAX_BASES = 5000;

export type BasisStatus = 'singular' | 'infeasible' | 'feasible';

export interface BasicSolution {
  id: number;
  basisCols: number[];
  basisNames: string[];
  status: BasisStatus;
  degenerate: boolean;
  /** Value of every column (basic ones solved, non-basic 0); null when singular. */
  values: Rational[] | null;
  /** Values of the ORIGINAL decision variables; null when singular. */
  point: Rational[] | null;
  objective: Rational | null;
  optimal: boolean;
  /** Basic variables that equal zero. */
  zeroBasics: string[];
}

export interface BasicSolutionsOk {
  ok: true;
  colNames: string[];
  /** Number of independent equations used. */
  m: number;
  n: number;
  total: number;
  bases: BasicSolution[];
  counts: { singular: number; infeasible: number; feasible: number; degenerate: number };
  /** Distinct feasible points in the original variables (corner points when there are two variables). */
  vertices: { point: Rational[]; basisIds: number[]; degenerate: boolean; objective: Rational; optimal: boolean }[];
  best: Rational | null;
  sense: 'max' | 'min';
  varNames: string[];
  twoVar: boolean;
  notes: string[];
}
export interface BasicSolutionsFail {
  ok: false;
  reason: string;
  tooMany?: boolean;
  count?: string;
}

export function binomial(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  const kk = Math.min(k, n - k);
  let r = 1n;
  for (let i = 1; i <= kk; i++) r = (r * BigInt(n - kk + i)) / BigInt(i);
  return r;
}

/** Solve B v = rhs for a square matrix; null when singular. */
function solveSquare(B: Rational[][], rhs: Rational[]): Rational[] | null {
  const k = B.length;
  const M = B.map((r, i) => [...r, rhs[i]!]);
  for (let c = 0; c < k; c++) {
    let p = c;
    while (p < k && M[p]![c]!.isZero()) p++;
    if (p === k) return null;
    if (p !== c) { const t = M[c]!; M[c] = M[p]!; M[p] = t; }
    const inv = M[c]![c]!.inv();
    M[c] = M[c]!.map(v => v.mul(inv));
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = M[r]![c]!;
      if (f.isZero()) continue;
      const pr = M[c]!;
      M[r] = M[r]!.map((v, q) => v.sub(f.mul(pr[q]!)));
    }
  }
  return M.map(r => r[k]!);
}

/** Pick a maximal set of independent rows of [A | b]; report inconsistency. */
function independentRows(A: Rational[][], b: Rational[]): { keep: number[]; inconsistent: boolean } {
  const N = A[0]?.length ?? 0;
  const piv: { row: Rational[]; col: number }[] = [];
  const keep: number[] = [];
  let inconsistent = false;
  A.forEach((ar, i) => {
    let row = [...ar, b[i]!];
    for (const p of piv) {
      const f = row[p.col]!;
      if (f.isZero()) continue;
      row = row.map((v, q) => v.sub(f.mul(p.row[q]!)));
    }
    const col = row.slice(0, N).findIndex(v => !v.isZero());
    if (col === -1) {
      if (!row[N]!.isZero()) inconsistent = true;
      return;
    }
    const inv = row[col]!.inv();
    row = row.map(v => v.mul(inv));
    // keep earlier pivot rows reduced in this column
    for (const p of piv) {
      const f = p.row[col]!;
      if (!f.isZero()) p.row = p.row.map((v, q) => v.sub(f.mul(row[q]!)));
    }
    piv.push({ row, col });
    keep.push(i);
  });
  return { keep, inconsistent };
}

export function enumerateBasicSolutions(model: LPModel): BasicSolutionsOk | BasicSolutionsFail {
  const v = validateLP(model);
  if (!v.valid) return { ok: false, reason: v.errors[0]?.message ?? 'The model is not valid.' };
  const sf = buildStandardForm(model);
  const ny = sf.yNames.length;
  const rowsAll = sf.rows;
  const colNames = [...sf.yNames];
  const slackOf: (number | null)[] = rowsAll.map(() => null);
  rowsAll.forEach((r, i) => {
    if (r.relation === '<=') { slackOf[i] = colNames.length; colNames.push(genName('s', i + 1)); }
    else if (r.relation === '>=') { slackOf[i] = colNames.length; colNames.push(genName('e', i + 1)); }
  });
  const n = colNames.length;
  const A: Rational[][] = rowsAll.map((r, i) => {
    const row: Rational[] = Array(n).fill(Rational.ZERO);
    r.coeffs.forEach((c, j) => { row[j] = c; });
    const sc = slackOf[i];
    if (sc !== null && sc !== undefined) row[sc] = r.relation === '<=' ? Rational.ONE : Rational.MINUS_ONE;
    return row;
  });
  const b = rowsAll.map(r => r.rhs);

  const notes: string[] = [...sf.notes];
  notes.push(`Standard form has ${rowsAll.length} equation${rowsAll.length === 1 ? '' : 's'} and ${n} variable${n === 1 ? '' : 's'} (${ny} structural, ${n - ny} slack/surplus). Each slack variable s turns a ≤ row into an equation; each surplus variable e turns a ≥ row into an equation.`);

  const { keep, inconsistent } = independentRows(A, b);
  if (inconsistent) return { ok: false, reason: 'The equations of the standard form contradict each other (the system has no solution at all), so there are no basic solutions.' };
  const m = keep.length;
  if (m < rowsAll.length) notes.push(`${rowsAll.length - m} equation(s) are linear combinations of the others (redundant), so only ${m} independent equation(s) are used. A basis therefore has ${m} column(s).`);
  const Ak = keep.map(i => A[i]!);
  const bk = keep.map(i => b[i]!);

  const total = binomial(n, m);
  if (total === 0n) return { ok: false, reason: `There are fewer variables (${n}) than independent equations (${m}); the system has no basic solutions.` };
  if (total > BigInt(MAX_BASES)) {
    return { ok: false, tooMany: true, count: total.toString(), reason: `C(${n}, ${m}) = ${total.toString()} candidate bases is more than the ${MAX_BASES} this page enumerates. Use the Simplex tab, which visits only a handful of them.` };
  }

  const bases: BasicSolution[] = [];
  const counts = { singular: 0, infeasible: 0, feasible: 0, degenerate: 0 };
  const cur: number[] = [];
  const emit = () => {
    const cols = [...cur];
    const id = bases.length + 1;
    const B = Ak.map(r => cols.map(c => r[c]!));
    const sol = m === 0 ? [] : solveSquare(B, bk);
    if (!sol) {
      counts.singular++;
      bases.push({ id, basisCols: cols, basisNames: cols.map(c => colNames[c]!), status: 'singular', degenerate: false, values: null, point: null, objective: null, optimal: false, zeroBasics: [] });
      return;
    }
    const values: Rational[] = Array(n).fill(Rational.ZERO);
    cols.forEach((c, k) => { values[c] = sol[k]!; });
    const feasible = values.every(x => !x.isNegative());
    const zero = cols.filter(c => values[c]!.isZero()).map(c => colNames[c]!);
    const point = recoverVariables(sf, values.slice(0, ny));
    const degenerate = feasible && zero.length > 0;
    if (feasible) counts.feasible++; else counts.infeasible++;
    if (degenerate) counts.degenerate++;
    bases.push({ id, basisCols: cols, basisNames: cols.map(c => colNames[c]!), status: feasible ? 'feasible' : 'infeasible', degenerate, values, point, objective: objectiveAt(model, point), optimal: false, zeroBasics: zero });
  };
  const rec = (start: number) => {
    if (cur.length === m) { emit(); return; }
    for (let c = start; c <= n - (m - cur.length); c++) { cur.push(c); rec(c + 1); cur.pop(); }
  };
  rec(0);

  let best: Rational | null = null;
  for (const bs of bases) {
    if (bs.status !== 'feasible' || bs.objective === null) continue;
    if (best === null || (model.sense === 'max' ? bs.objective.gt(best) : bs.objective.lt(best))) best = bs.objective;
  }
  if (best !== null) for (const bs of bases) bs.optimal = bs.status === 'feasible' && bs.objective !== null && bs.objective.eq(best);

  const vertices: BasicSolutionsOk['vertices'] = [];
  for (const bs of bases) {
    if (bs.status !== 'feasible' || !bs.point) continue;
    const hit = vertices.find(vx => vx.point.every((q, k) => q.eq(bs.point![k]!)));
    if (hit) { hit.basisIds.push(bs.id); hit.degenerate = true; }
    else vertices.push({ point: bs.point, basisIds: [bs.id], degenerate: bs.degenerate, objective: bs.objective!, optimal: bs.optimal });
  }
  // A point reached by several bases, or by one basis with a zero basic variable, is degenerate.
  for (const vx of vertices) if (vx.basisIds.length > 1) vx.degenerate = true;

  return {
    ok: true, colNames, m, n, total: Number(total), bases, counts, vertices, best, sense: model.sense, varNames: model.varNames,
    twoVar: model.objective.length === 2, notes,
  };
}

/* ------------------------------------------------------------------ */
/* Definitions with the user's own numbers                             */
/* ------------------------------------------------------------------ */

export interface Definition { term: string; meaning: string; example: string }

const fmtPoint = (p: Rational[]) => `(${p.map(q => q.toString()).join(', ')})`;
const termStr = (c: Rational[], names: string[]) => {
  const parts: string[] = [];
  c.forEach((a, j) => { if (!a.isZero()) parts.push(`${a.eq(Rational.ONE) ? '' : a.eq(Rational.MINUS_ONE) ? '−' : a.toString()}${names[j]}`); });
  return parts.length ? parts.join(' + ').replace(/\+ −/g, '− ') : '0';
};

export function definitionsFor(model: LPModel, res: BasicSolutionsOk | BasicSolutionsFail | null): Definition[] {
  const names = model.varNames;
  const n = names.length;
  const c0 = model.constraints[0];
  const hyper = c0 ? `${termStr(c0.coeffs, names)} = ${c0.rhs.toString()}` : `${names[0] ?? 'x'} = 0`;
  const half = c0 ? `${termStr(c0.coeffs, names)} ${c0.relation === '>=' ? '≥' : '≤'} ${c0.rhs.toString()}` : `${names[0] ?? 'x'} ≥ 0`;
  const nonneg = model.objective.filter((_, j) => { const b = model.varBounds?.[j]; return !b || (b.lower !== null && b.lower.isZero()); }).length;
  const halfSpaces = model.constraints.length * (1) + nonneg;
  let convexEx = 'Take any two feasible points; every point on the segment between them satisfies all the constraints too.';
  let extremeEx = 'Each corner of the feasible region is a basic feasible solution.';
  if (res && res.ok) {
    const f = res.vertices;
    if (f.length >= 2) {
      const P = f[0]!.point, Q = f[1]!.point;
      const mid = P.map((p, k) => p.add(Q[k]!).div(Rational.of(2)));
      const ok = isFeasiblePoint(model, mid);
      convexEx = `${fmtPoint(P)} and ${fmtPoint(Q)} are both feasible; their midpoint ${fmtPoint(mid)} is ${ok ? 'feasible too' : 'not feasible, which can only happen if the region is not convex — check the model'}.`;
    }
    extremeEx = `This model has ${res.counts.feasible} basic feasible solution${res.counts.feasible === 1 ? '' : 's'} among ${res.total} candidate bases, giving ${f.length} distinct extreme point${f.length === 1 ? '' : 's'}${f.length ? `, e.g. ${fmtPoint(f[0]!.point)}` : ''}.`;
  }
  return [
    { term: 'Hyperplane', meaning: 'The set {x : a·x = b}. In two variables it is a line, in three a plane. The boundary of one constraint is a hyperplane.', example: `Your first constraint's boundary: ${hyper}.` },
    { term: 'Half-space', meaning: 'One side of a hyperplane, {x : a·x ≤ b} or {x : a·x ≥ b}. Every inequality constraint defines one.', example: `${half} is a half-space${n === 2 ? ' (the shaded side of the line)' : ''}.` },
    { term: 'Convex set', meaning: 'A set that contains the whole line segment between any two of its points. Half-spaces and intersections of half-spaces are convex.', example: convexEx },
    { term: 'Convex polyhedron', meaning: 'The intersection of finitely many half-spaces — exactly the shape of an LP feasible region (a polygon when n = 2). It may be bounded or unbounded.', example: `Your region is the intersection of about ${halfSpaces} half-space${halfSpaces === 1 ? '' : 's'}: ${model.constraints.length} constraint${model.constraints.length === 1 ? '' : 's'} plus the sign restrictions.` },
    { term: 'Extreme point (vertex)', meaning: 'A point of the convex set that is not strictly between two other points of the set — a corner.', example: extremeEx },
    { term: 'Basic feasible solution (BFS)', meaning: 'Set n − m variables to 0, solve the m equations for the other m (the basis); if all values are ≥ 0 it is a BFS. BFS and extreme point are the same thing seen algebraically and geometrically.', example: res && res.ok ? `With ${res.m} equation${res.m === 1 ? '' : 's'} and ${res.n} variables, ${res.n - res.m} variable${res.n - res.m === 1 ? ' is' : 's are'} set to 0 in each basic solution.` : 'The standard form turns every inequality into an equation with a slack or surplus variable.' },
    { term: 'Fundamental theorem of LP', meaning: 'If an LP has an optimal solution, at least one extreme point is optimal. That is why the simplex method only walks from vertex to vertex.', example: res && res.ok && res.best !== null ? `Among your feasible bases the best objective is ${res.best.toString()}.` : 'No feasible basic solution to compare here.' },
  ];
}
