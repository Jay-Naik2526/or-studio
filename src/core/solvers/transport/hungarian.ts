/**
 * Hungarian method for the assignment problem (spec §9.1 module 5, §10.2).
 *
 * Row reduction → column reduction → minimum line cover (Kőnig: maximum zero matching + alternating
 * search, so the cover is genuinely minimal) → adjust by the smallest uncovered entry → repeat.
 * Handles maximisation (profit → cost), non-square matrices (zero-cost dummies) and prohibited
 * assignments (symbolic M).
 */

import { Rational } from '../../math/rational';
import { MNum } from '../../math/bigm';
import { Solver, Solution, ValidationResult, SolveOptions, Diagnostic } from '../../types/solver';
import { Step } from '../../types/step';
import { joinList } from '../../format';

export interface AssignModel {
  costs: Rational[][];
  rowNames?: string[];
  colNames?: string[];
  objective?: 'min' | 'max';
  /** prohibited assignments (cost = symbolic M) */
  blocked?: boolean[][];
}

export interface AssignState {
  matrix: MNum[][];
  coveredRows: boolean[];
  coveredCols: boolean[];
  /** the zero entries chosen as the (possibly partial) matching at this stage */
  matching?: { row: number; col: number }[];
  assignment?: { row: number; col: number }[];
  totalCost: Rational;
  rowLabels: string[];
  colLabels: string[];
  stage: string;
  /** smallest uncovered entry used in the adjustment step */
  adjustment?: MNum;
  dummyRows: number[];
  dummyCols: number[];
}

export interface AssignResult {
  state: AssignState;
  assignment: { row: number; col: number; cost: Rational; real: boolean }[];
  /** objective in the user's sense (profit for max) */
  objective: Rational;
  feasible: boolean;
  alternateOptimum: boolean;
}

/** Maximum matching on zero cells; returns matchRow[i] = col | -1. */
function maxZeroMatching(zero: boolean[][]): number[] {
  const n = zero.length;
  const matchCol: number[] = Array(n).fill(-1);
  const matchRow: number[] = Array(n).fill(-1);
  const tryRow = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < n; j++) {
      if (!zero[i]![j] || seen[j]) continue;
      seen[j] = true;
      if (matchCol[j] === -1 || tryRow(matchCol[j]!, seen)) {
        matchCol[j] = i;
        matchRow[i] = j;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < n; i++) tryRow(i, Array(n).fill(false));
  return matchRow;
}

/** Kőnig minimum vertex cover of the zero-cell bipartite graph. */
function minCover(zero: boolean[][], matchRow: number[]): { rows: boolean[]; cols: boolean[]; size: number } {
  const n = zero.length;
  const matchCol: number[] = Array(n).fill(-1);
  matchRow.forEach((j, i) => { if (j >= 0) matchCol[j] = i; });
  const visRow: boolean[] = Array(n).fill(false);
  const visCol: boolean[] = Array(n).fill(false);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (matchRow[i] === -1) { visRow[i] = true; queue.push(i); }
  while (queue.length) {
    const i = queue.shift()!;
    for (let j = 0; j < n; j++) {
      if (!zero[i]![j] || visCol[j]) continue;
      visCol[j] = true;
      const i2 = matchCol[j]!;
      if (i2 >= 0 && !visRow[i2]) { visRow[i2] = true; queue.push(i2); }
    }
  }
  const rows = visRow.map(v => !v);
  const cols = visCol;
  return { rows, cols, size: rows.filter(Boolean).length + cols.filter(Boolean).length };
}

export class HungarianSolver implements Solver<AssignModel, AssignState, AssignResult> {
  readonly id = 'assign.hungarian';

  readonly meta = {
    name: 'Hungarian method',
    category: 'transportation' as const,
    variants: [{ id: 'hungarian', name: 'Hungarian algorithm', description: 'Reduction + minimum line cover.' }],
    visualizerId: 'AssignMatrix',
    sizeLimit: { rows: 30, cols: 30 },
    supportsTutorial: true,
    reference: 'Taha, Operations Research: An Introduction, §5.4',
  };

  validate(model: AssignModel): ValidationResult {
    const errors: { field?: string; message: string }[] = [];
    if (!model.costs.length || !model.costs[0]!.length) errors.push({ field: 'costs', message: 'The cost matrix cannot be empty.' });
    const w = model.costs[0]?.length ?? 0;
    if (model.costs.some(r => r.length !== w)) errors.push({ field: 'costs', message: 'All rows of the cost matrix must have the same length.' });
    return { valid: errors.length === 0, errors };
  }

  normalize(model: AssignModel): AssignModel {
    return model;
  }

  solve(model: AssignModel, options: SolveOptions = {}): Solution<AssignState, AssignResult> {
    const t0 = performance.now();
    const v = this.validate(model);
    if (!v.valid) return { steps: [], result: null, status: 'invalid-input', diagnostics: v.errors.map(e => ({ severity: 'error', code: 'INVALID_MODEL', message: e.message })), metrics: { iterations: 0, elapsedMs: 0, degradedToFloat: false } };
    const diagnostics: Diagnostic[] = [];
    const steps: Step<AssignState>[] = [];
    const emit = options.emitSteps !== false;

    const r0 = model.costs.length;
    const c0 = model.costs[0]!.length;
    const n = Math.max(r0, c0);
    const rowLabels = Array.from({ length: n }, (_, i) => (i < r0 ? model.rowNames?.[i] ?? `Worker ${i + 1}` : `Dummy worker ${i - r0 + 1}`));
    const colLabels = Array.from({ length: n }, (_, j) => (j < c0 ? model.colNames?.[j] ?? `Job ${j + 1}` : `Dummy job ${j - c0 + 1}`));
    const dummyRows = Array.from({ length: n - r0 }, (_, k) => r0 + k);
    const dummyCols = Array.from({ length: n - c0 }, (_, k) => c0 + k);
    const blocked = (i: number, j: number) => !!model.blocked?.[i]?.[j];
    if (n !== r0 || n !== c0) diagnostics.push({ severity: 'info', code: 'PADDED', message: `The ${r0} × ${c0} matrix is not square: ${dummyRows.length ? `${dummyRows.length} dummy row(s)` : `${dummyCols.length} dummy column(s)`} with zero cost were added. Whoever is assigned to a dummy is left unassigned.` });

    // cost matrix (original sense) and working matrix
    let mx: Rational | null = null;
    if (model.objective === 'max') {
      model.costs.forEach((row, i) => row.forEach((c, j) => { if (!blocked(i, j) && (mx === null || c.gt(mx))) mx = c; }));
    }
    const orig = (i: number, j: number): Rational => (i < r0 && j < c0 ? model.costs[i]![j]! : Rational.ZERO);
    let mat: MNum[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => {
        if (i < r0 && j < c0 && blocked(i, j)) return MNum.M;
        const c = orig(i, j);
        return MNum.of(model.objective === 'max' && i < r0 && j < c0 ? (mx ?? Rational.ZERO).sub(c) : c);
      })
    );
    if (model.objective === 'max') diagnostics.push({ severity: 'info', code: 'MAX_CONVERSION', message: `Maximisation: each profit is subtracted from the largest profit (${(mx ?? Rational.ZERO).toString()}) to give an equivalent minimisation matrix.` });
    if (model.blocked?.some(r => r.some(Boolean))) diagnostics.push({ severity: 'info', code: 'PROHIBITED', message: 'Prohibited assignments carry the symbolic cost M.' });

    const clone = () => mat.map(r => [...r]);
    const emptyState = (stage: string, extra: Partial<AssignState> = {}): AssignState => ({
      matrix: clone(), coveredRows: Array(n).fill(false), coveredCols: Array(n).fill(false), totalCost: Rational.ZERO,
      rowLabels, colLabels, stage, dummyRows, dummyCols, ...extra,
    });
    const push = (state: AssignState, phase: string, short: string, detailed: string, rule: string, status: Step<AssignState>['status'], action: Step<AssignState>['action'] = null, note?: string) => {
      if (emit) steps.push({ index: steps.length, phase, state, action, explanation: { short, detailed, rule, note }, highlights: [], status });
    };

    push(
      emptyState('Initial'), 'Initialisation',
      `${n} × ${n} assignment matrix ready.`,
      `Each ${model.objective === 'max' ? 'profit is first converted to an opportunity cost (largest profit minus entry), then' : ''} worker is assigned to exactly one job. ${n !== r0 || n !== c0 ? 'Dummy rows/columns of zeros make the matrix square. ' : ''}The Hungarian method creates zeros by subtracting row and column minima, then looks for n independent zeros.`,
      'Hungarian initialisation', 'initial'
    );

    // Row reduction
    const rowMin = mat.map(row => row.reduce((a, b) => (b.lt(a) ? b : a)));
    mat = mat.map((row, i) => row.map(x => x.sub(rowMin[i]!)));
    push(
      emptyState('Row reduction'), 'Row reduction',
      'Subtract each row\'s minimum from the row.',
      `Row minima: ${rowMin.map((x, i) => `${rowLabels[i]}: ${x.toString()}`).join(', ')}. Subtracting them gives every row at least one zero without changing which assignment is optimal (every complete assignment uses exactly one entry per row, so its total drops by the same constant).`,
      'Row reduction', 'continue', { kind: 'reduce', payload: { type: 'row', minima: rowMin.map(String) } }
    );
    // Column reduction
    const colMin = Array.from({ length: n }, (_, j) => mat.reduce((a, row) => (row[j]!.lt(a) ? row[j]! : a), mat[0]![j]!));
    mat = mat.map(row => row.map((x, j) => x.sub(colMin[j]!)));
    push(
      emptyState('Column reduction'), 'Column reduction',
      'Subtract each column\'s minimum from the column.',
      `Column minima: ${colMin.map((x, j) => `${colLabels[j]}: ${x.toString()}`).join(', ')}. Now every row and every column contains a zero.`,
      'Column reduction', 'continue', { kind: 'reduce', payload: { type: 'column', minima: colMin.map(String) } }
    );

    let iter = 0;
    let matching: number[] = [];
    const maxIter = options.maxIterations ?? 1000;
    while (iter < maxIter) {
      const zero = mat.map(r => r.map(x => x.isZero()));
      matching = maxZeroMatching(zero);
      const cover = minCover(zero, matching);
      const matchCells = matching.map((j, i) => (j >= 0 ? { row: i, col: j } : null)).filter(Boolean) as { row: number; col: number }[];
      const done = cover.size === n;
      push(
        emptyState('Line cover', { coveredRows: cover.rows, coveredCols: cover.cols, matching: matchCells }),
        `Line cover ${iter + 1}`,
        done ? `The zeros need ${cover.size} = n lines: an optimal assignment exists among them.` : `Minimum cover uses ${cover.size} < ${n} lines: not yet optimal.`,
        `All zeros are covered by the fewest possible horizontal/vertical lines — found exactly (maximum matching of zeros has size ${cover.size}, and by König's theorem the minimum cover has the same size). ` +
          (done ? `Since ${cover.size} = n, ${n} independent zeros exist, i.e. a complete assignment at zero reduced cost.` : `Fewer than n lines means no complete zero assignment exists yet, so new zeros must be created.`),
        'Minimum line cover (König)', done ? 'optimal' : 'continue', { kind: 'cover', payload: { lines: cover.size } }
      );
      if (done) break;
      // adjust
      let k: MNum | null = null;
      for (let i = 0; i < n; i++) {
        if (cover.rows[i]) continue;
        for (let j = 0; j < n; j++) {
          if (cover.cols[j]) continue;
          if (k === null || mat[i]![j]!.lt(k)) k = mat[i]![j]!;
        }
      }
      if (k === null || !k.isPositive()) {
        diagnostics.push({ severity: 'error', code: 'NO_PROGRESS', message: 'The adjustment step found no positive uncovered entry; the problem may be infeasible.' });
        break;
      }
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        if (!cover.rows[i] && !cover.cols[j]) mat[i]![j] = mat[i]![j]!.sub(k);
        else if (cover.rows[i] && cover.cols[j]) mat[i]![j] = mat[i]![j]!.add(k);
      }
      iter++;
      push(
        emptyState('Adjustment', { coveredRows: cover.rows, coveredCols: cover.cols, adjustment: k }),
        `Adjustment ${iter}`,
        `Smallest uncovered entry k = ${k.toString()}: subtract it from uncovered cells, add it to doubly-covered cells.`,
        `The smallest uncovered entry is k = ${k.toString()}. Subtracting k from every uncovered cell creates at least one new zero; adding k to cells covered twice keeps all entries non-negative and leaves singly-covered cells unchanged.`,
        'Matrix adjustment', 'continue', { kind: 'adjust', payload: { k: k.toString() } }
      );
    }

    const assignment = matching.map((j, i) => ({ row: i, col: j })).filter(a => a.col >= 0);
    const complete = assignment.length === n;
    const detail = assignment.map(a => ({ row: a.row, col: a.col, cost: orig(a.row, a.col), real: a.row < r0 && a.col < c0 }));
    let total = Rational.ZERO;
    let usesM = false;
    assignment.forEach(a => { if (a.row < r0 && a.col < c0) { if (blocked(a.row, a.col)) usesM = true; else total = total.add(orig(a.row, a.col)); } });
    if (usesM) diagnostics.push({ severity: 'error', code: 'PROHIBITED_USED', message: 'Every complete assignment uses a prohibited pair: the problem is infeasible.' });

    // alternate optimum: any zero (not in the matching) lying in a different perfect matching? cheap test — more zeros than n
    const zeros = mat.flat().filter(x => x.isZero()).length;
    const alt = complete && zeros > n && (() => {
      // check by forcing each matched cell out and seeing if a perfect matching still exists
      for (const a of assignment) {
        const z = mat.map((r, i) => r.map((x, j) => x.isZero() && !(i === a.row && j === a.col)));
        const m2 = maxZeroMatching(z);
        if (m2.every(j => j >= 0)) return true;
      }
      return false;
    })();
    if (alt) diagnostics.push({ severity: 'info', code: 'ALTERNATE_OPTIMA', message: 'Alternate optimal assignments exist (another set of n independent zeros).' });

    const finalState = emptyState('Optimal', { matching: assignment, assignment, totalCost: total, coveredRows: Array(n).fill(false), coveredCols: Array(n).fill(false) });
    push(
      finalState, 'Optimal assignment',
      `Optimal assignment found: total ${model.objective === 'max' ? 'profit' : 'cost'} = ${total.toString()}.`,
      `Choose n independent zeros: ${joinList(detail.map(d => `${rowLabels[d.row]} → ${colLabels[d.col]}${d.real ? ` (${d.cost.toString()})` : ' (dummy)'}`))}. The total is taken from the ORIGINAL matrix: ${total.toString()}.`,
      'Complete zero assignment', complete ? 'optimal' : 'infeasible', { kind: 'assign', payload: {} }
    );

    return {
      steps,
      result: { state: finalState, assignment: detail, objective: total, feasible: complete && !usesM, alternateOptimum: !!alt },
      status: !complete || usesM ? 'infeasible' : 'optimal',
      diagnostics,
      metrics: { iterations: iter, elapsedMs: Math.round((performance.now() - t0) * 100) / 100, degradedToFloat: false },
    };
  }
}
