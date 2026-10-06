/**
 * Transportation problem: NWC / Least-cost / VAM initial solutions + MODI (u–v) optimality
 * with closed-loop (stepping-stone) reallocation (spec §9.3, §10.2).
 *
 * Costs are `MNum` (a + bM): prohibited routes carry the SYMBOLIC cost M, never a numeric large value.
 * The basis is always a spanning tree of m+n−1 cells; a basic cell may hold 0 (degenerate / ε).
 */

import { Rational } from '../../math/rational';
import { MNum } from '../../math/bigm';
import { Solver, Solution, ValidationResult, SolveOptions, Diagnostic } from '../../types/solver';
import { Step, Highlight } from '../../types/step';
import { TransportModel, TransportState } from '../../types/models';
import { joinList } from '../../format';

type Cell = { row: number; col: number };
type LoopCell = { row: number; col: number; sign: '+' | '-' };

export type InitialMethod = 'nwc' | 'lcm' | 'vam';

export interface TransportOptions extends SolveOptions {
  /** also list the stepping-stone loop and cost change of every non-basic cell in each MODI evaluation */
  stoneEval?: boolean;
  /** stop after the initial solution (no MODI) */
  initialOnly?: boolean;
}

export interface TransportResult {
  state: TransportState;
  initialCost: MNum;
  initialMethod: InitialMethod;
  modiIterations: number;
  /** unit cost matrix used (after max-conversion/balance/M) */
  costs: MNum[][];
  rowLabels: string[];
  colLabels: string[];
  feasible: boolean;
  /** objective in the user's sense (profit for max problems) */
  reportedObjective: MNum;
}


/** Prepare effective costs, labels and balanced supply/demand. */
export function prepareTransport(model: TransportModel) {
  const m0 = model.supply.length;
  const n0 = model.demand.length;
  const notes: string[] = [];
  let costs: MNum[][] = model.costs.map((row, i) =>
    row.map((c, j) => (model.blocked?.[i]?.[j] ? MNum.M : MNum.of(c)))
  );
  let converted = false;
  if (model.objective === 'max') {
    let mx: Rational | null = null;
    model.costs.forEach((row, i) => row.forEach((c, j) => { if (!model.blocked?.[i]?.[j] && (mx === null || c.gt(mx))) mx = c; }));
    const mxv = mx ?? Rational.ZERO;
    costs = costs.map((row, i) => row.map((_c, j) => (model.blocked?.[i]?.[j] ? MNum.M : MNum.of(mxv.sub(model.costs[i]![j]!)))));
    converted = true;
    notes.push(`Maximisation: every profit is subtracted from the largest profit (${mxv.toString()}), turning the problem into a minimisation of opportunity cost.`);
  }
  const rowLabels = Array.from({ length: m0 }, (_, i) => model.supplyNames?.[i] ?? `S${i + 1}`);
  const colLabels = Array.from({ length: n0 }, (_, j) => model.demandNames?.[j] ?? `D${j + 1}`);
  let supply = [...model.supply];
  let demand = [...model.demand];
  const ts = supply.reduce((a, b) => a.add(b), Rational.ZERO);
  const td = demand.reduce((a, b) => a.add(b), Rational.ZERO);
  let dummyRow: number | null = null;
  let dummyCol: number | null = null;
  if (ts.gt(td)) {
    demand.push(ts.sub(td));
    colLabels.push('Dummy');
    costs = costs.map(r => [...r, MNum.ZERO]);
    dummyCol = n0;
    notes.push(`Total supply ${ts.toString()} exceeds total demand ${td.toString()}: a dummy destination absorbing ${ts.sub(td).toString()} units with zero cost is added.`);
  } else if (td.gt(ts)) {
    supply.push(td.sub(ts));
    rowLabels.push('Dummy');
    costs.push(Array.from({ length: demand.length }, () => MNum.ZERO));
    dummyRow = m0;
    notes.push(`Total demand ${td.toString()} exceeds total supply ${ts.toString()}: a dummy source supplying ${td.sub(ts).toString()} units with zero cost is added.`);
  }
  return { costs, supply, demand, rowLabels, colLabels, dummyRow, dummyCol, notes, converted };
}

function sumCost(alloc: (Rational | null)[][], costs: MNum[][]): MNum {
  let t = MNum.ZERO;
  alloc.forEach((row, i) => row.forEach((a, j) => { if (a && !a.isZero()) t = t.add(costs[i]![j]!.scale(a)); }));
  return t;
}

/** Path in the basis tree from row i to column j (cells alternate). Returns the loop with signs, entering cell first. */
export function findLoop(basic: boolean[][], row: number, col: number): LoopCell[] | null {
  const m = basic.length;
  const n = basic[0]?.length ?? 0;
  // nodes: rows 0..m-1, cols m..m+n-1
  const prev = new Map<number, { node: number; cell: Cell }>();
  const start = row;
  const goal = m + col;
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length) {
    const u = queue.shift()!;
    if (u === goal) break;
    if (u < m) {
      for (let j = 0; j < n; j++) {
        if (!basic[u]![j]) continue;
        const v = m + j;
        if (seen.has(v)) continue;
        seen.add(v);
        prev.set(v, { node: u, cell: { row: u, col: j } });
        queue.push(v);
      }
    } else {
      const j = u - m;
      for (let i = 0; i < m; i++) {
        if (!basic[i]![j]) continue;
        if (seen.has(i)) continue;
        seen.add(i);
        prev.set(i, { node: u, cell: { row: i, col: j } });
        queue.push(i);
      }
    }
  }
  if (!prev.has(goal)) return null;
  const cells: Cell[] = [];
  let cur = goal;
  while (cur !== start) {
    const p = prev.get(cur)!;
    cells.push(p.cell); // from the goal back to the start
    cur = p.node;
  }
  // cells[0] is adjacent to column `col` ⇒ '−'; alternate going back toward the row
  const loop: LoopCell[] = [{ row, col, sign: '+' }];
  cells.forEach((c, k) => loop.push({ ...c, sign: k % 2 === 0 ? '-' : '+' }));
  return loop;
}

/** Solve u_i + v_j = c_ij over the basis spanning tree. */
function computeDuals(basic: boolean[][], costs: MNum[][]): { u: MNum[]; v: MNum[] } {
  const m = basic.length;
  const n = basic[0]!.length;
  const u: (MNum | null)[] = Array(m).fill(null);
  const v: (MNum | null)[] = Array(n).fill(null);
  u[0] = MNum.ZERO;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        if (!basic[i]![j]) continue;
        if (u[i] && !v[j]) { v[j] = costs[i]![j]!.sub(u[i]!); changed = true; }
        else if (v[j] && !u[i]) { u[i] = costs[i]![j]!.sub(v[j]!); changed = true; }
      }
    }
  }
  return { u: u.map(x => x ?? MNum.ZERO), v: v.map(x => x ?? MNum.ZERO) };
}

export class TransportSolver implements Solver<TransportModel, TransportState, TransportResult> {
  readonly id = 'transport.modi';

  readonly meta = {
    name: 'Transportation — initial solution + MODI',
    category: 'transportation' as const,
    variants: [
      { id: 'vam', name: "Vogel's approximation + MODI", description: 'Penalty-based start; usually closest to optimal.' },
      { id: 'lcm', name: 'Least-cost + MODI', description: 'Greedy on unit cost.' },
      { id: 'nwc', name: 'North-west corner + MODI', description: 'Ignores cost; mechanical.' },
    ],
    visualizerId: 'TransportGrid',
    sizeLimit: { rows: 30, cols: 30 },
    supportsTutorial: true,
    reference: 'Taha, Operations Research: An Introduction, Ch. 5',
  };

  validate(model: TransportModel): ValidationResult {
    const errors: { field?: string; message: string }[] = [];
    if (!model.supply.length) errors.push({ field: 'supply', message: 'At least one source is required.' });
    if (!model.demand.length) errors.push({ field: 'demand', message: 'At least one destination is required.' });
    model.supply.forEach((s, i) => { if (s.isNegative()) errors.push({ field: `supply[${i}]`, message: `Supply of source ${i + 1} is negative.` }); });
    model.demand.forEach((d, j) => { if (d.isNegative()) errors.push({ field: `demand[${j}]`, message: `Demand of destination ${j + 1} is negative.` }); });
    if (model.costs.length !== model.supply.length || model.costs.some(r => r.length !== model.demand.length)) {
      errors.push({ field: 'costs', message: `The cost matrix must be ${model.supply.length} × ${model.demand.length}.` });
    }
    return { valid: errors.length === 0, errors };
  }

  normalize(model: TransportModel): TransportModel {
    const p = prepareTransport(model);
    return { ...model, supply: p.supply, demand: p.demand, balanced: true, dummyAdded: p.dummyRow !== null ? 'row' : p.dummyCol !== null ? 'column' : null };
  }

  solve(model: TransportModel, options: TransportOptions = {}): Solution<TransportState, TransportResult> {
    const t0 = performance.now();
    const v = this.validate(model);
    if (!v.valid) {
      return { steps: [], result: null, status: 'invalid-input', diagnostics: v.errors.map(e => ({ severity: 'error', code: 'INVALID_MODEL', message: e.message })), metrics: { iterations: 0, elapsedMs: 0, degradedToFloat: false } };
    }
    const method = ((options.variant as InitialMethod) ?? 'vam') as InitialMethod;
    const prep = prepareTransport(model);
    const { costs, rowLabels, colLabels } = prep;
    const m = prep.supply.length;
    const n = prep.demand.length;
    const diagnostics: Diagnostic[] = [];
    const steps: Step<TransportState>[] = [];
    const maxIter = options.maxIterations ?? 500;

    const alloc: (Rational | null)[][] = Array.from({ length: m }, () => Array(n).fill(null));
    const basic: boolean[][] = Array.from({ length: m }, () => Array(n).fill(false));
    const supplyLeft = [...prep.supply];
    const demandLeft = [...prep.demand];
    const crossedRows: boolean[] = Array(m).fill(false);
    const crossedCols: boolean[] = Array(n).fill(false);

    for (const note of prep.notes) diagnostics.push({ severity: 'info', code: prep.converted && note.startsWith('Maximisation') ? 'MAX_CONVERSION' : 'BALANCING', message: note });
    if (costs.some(r => r.some(c => c.hasM()))) diagnostics.push({ severity: 'info', code: 'PROHIBITED_ROUTES', message: 'Prohibited routes carry the symbolic cost M (an arbitrarily large constant) so they are used only if there is no alternative.' });

    const snap = (extra: Partial<TransportState> = {}): TransportState => {
      const eps: Cell[] = [];
      alloc.forEach((r, i) => r.forEach((a, j) => { if (a && a.isZero() && basic[i]![j]) eps.push({ row: i, col: j }); }));
      return {
        allocations: alloc.map(r => [...r]),
        costs,
        rowLabels,
        colLabels,
        totalCost: sumCost(alloc, costs),
        isDegenerate: eps.length > 0,
        epsilonCells: eps,
        supplyLeft: [...supplyLeft],
        demandLeft: [...demandLeft],
        crossedRows: [...crossedRows],
        crossedCols: [...crossedCols],
        dummyRow: prep.dummyRow,
        dummyCol: prep.dummyCol,
        ...extra,
      };
    };
    const push = (state: TransportState, phase: string, action: Step<TransportState>['action'], short: string, detailed: string, rule: string, highlights: Highlight[], status: Step<TransportState>['status'], note?: string) => {
      if (options.emitSteps === false) return;
      steps.push({ index: steps.length, phase, state, action, explanation: { short, detailed, rule, note }, highlights, status });
    };
    const cl = (i: number, j: number) => `(${rowLabels[i]}, ${colLabels[j]})`;

    push(
      snap(),
      `${method.toUpperCase()} initialisation`,
      null,
      `Balanced ${m} × ${n} problem ready; building the starting solution with ${method === 'nwc' ? 'the north-west corner rule' : method === 'lcm' ? 'the least-cost method' : "Vogel's approximation"}.`,
      `Total supply = total demand = ${prep.supply.reduce((a, b) => a.add(b), Rational.ZERO).toString()}. ${prep.notes.join(' ')} ` +
        (method === 'nwc' ? 'The north-west corner rule starts at the top-left cell and ignores costs entirely — that is its pedagogical point and why it usually needs the most MODI iterations.' :
         method === 'lcm' ? 'The least-cost method repeatedly fills the cheapest remaining cell as much as possible.' :
         "Vogel's method computes a penalty (difference between the two smallest costs) for each row and column and fills the cheapest cell of the line with the largest penalty — it tries to avoid expensive 'regret'."),
      'Initial solution method',
      [],
      'initial'
    );

    /* ------------ initial basic feasible solution ------------ */
    const allocate = (i: number, j: number, why: string, rule: string, highlightsExtra: Highlight[] = [], extraState: Partial<TransportState> = {}, note?: string) => {
      const s = supplyLeft[i]!;
      const d = demandLeft[j]!;
      const q = s.lt(d) ? s : d;
      alloc[i]![j] = q;
      basic[i]![j] = true;
      supplyLeft[i] = s.sub(q);
      demandLeft[j] = d.sub(q);
      const rowDone = supplyLeft[i]!.isZero();
      const colDone = demandLeft[j]!.isZero();
      let deg: string | undefined;
      if (rowDone && colDone) {
        // cross out only one line so the other receives a 0 (basic, degenerate) allocation later
        const remainingRows = crossedRows.filter(x => !x).length;
        const remainingCols = crossedCols.filter(x => !x).length;
        if (remainingRows > 1 && remainingCols > 1) {
          crossedRows[i] = true;
          deg = `Row ${rowLabels[i]} and column ${colLabels[j]} are exhausted at the same time. Only the row is crossed out; the column stays open with 0 remaining so that a 0-valued (ε) basic cell is placed later and the basis keeps m+n−1 = ${m + n - 1} cells.`;
          diagnostics.push({ severity: 'info', code: 'DEGENERATE_INITIAL', message: deg });
        } else { crossedRows[i] = true; crossedCols[j] = true; }
      } else if (rowDone) crossedRows[i] = true;
      else crossedCols[j] = true;
      push(
        snap(extraState),
        `${method.toUpperCase()} allocation`,
        { kind: 'allocate', payload: { row: i, col: j, amount: q.toString() } },
        `Allocate ${q.toString()} to ${cl(i, j)} (unit cost ${costs[i]![j]!.toString()}).`,
        `${why} Allocation = min(remaining supply ${s.toString()}, remaining demand ${d.toString()}) = ${q.toString()}. ` +
          `${rowDone ? `${rowLabels[i]} is exhausted. ` : ''}${colDone ? `${colLabels[j]} is satisfied. ` : ''}` +
          `Running cost = ${snap().totalCost.toString()}.`,
        rule,
        [{ target: `cell:${i},${j}`, intent: 'optimal' }, ...highlightsExtra],
        'continue',
        [note, deg].filter(Boolean).join(' ') || undefined
      );
    };

    const openRows = () => crossedRows.map((c, i) => (c ? -1 : i)).filter(i => i >= 0);
    const openCols = () => crossedCols.map((c, j) => (c ? -1 : j)).filter(j => j >= 0);

    if (method === 'nwc') {
      let i = 0;
      let j = 0;
      while (i < m && j < n) {
        allocate(i, j, `The north-west cell of the remaining table is ${cl(i, j)}; costs are ignored.`, 'North-west corner rule');
        if (crossedRows[i] && crossedCols[j]) break;
        if (crossedRows[i]) i++;
        else j++;
      }
    } else if (method === 'lcm') {
      while (openRows().length && openCols().length) {
        let best: Cell | null = null;
        let tied: Cell[] = [];
        for (const i of openRows()) for (const j of openCols()) {
          const c = costs[i]![j]!;
          if (!best) { best = { row: i, col: j }; tied = [best]; continue; }
          const cmp = c.cmp(costs[best.row]![best.col]!);
          if (cmp < 0) { best = { row: i, col: j }; tied = [best]; }
          else if (cmp === 0) tied.push({ row: i, col: j });
        }
        const b = best!;
        const tieNote = tied.length > 1 ? `Tie: ${joinList(tied.map(t => cl(t.row, t.col)))} all cost ${costs[b.row]![b.col]!.toString()}; the lowest row, then lowest column is taken.` : undefined;
        allocate(b.row, b.col, `${cl(b.row, b.col)} has the lowest unit cost (${costs[b.row]![b.col]!.toString()}) among the cells still open.`, 'Least-cost rule', [], {}, tieNote);
      }
    } else {
      while (openRows().length && openCols().length) {
        const rows = openRows();
        const cols = openCols();
        const rowPen: (MNum | null)[] = Array(m).fill(null);
        const colPen: (MNum | null)[] = Array(n).fill(null);
        const pen = (vals: MNum[]): MNum => {
          const s = [...vals].sort((a, b) => a.cmp(b));
          return s.length > 1 ? s[1]!.sub(s[0]!) : s[0]!;
        };
        for (const i of rows) rowPen[i] = pen(cols.map(j => costs[i]![j]!));
        for (const j of cols) colPen[j] = pen(rows.map(i => costs[i]![j]!));
        // choose max penalty; ties → smaller cost cell, then lowest index
        type Cand = { line: 'row' | 'col'; idx: number; p: MNum; cell: Cell };
        const cands: Cand[] = [];
        for (const i of rows) {
          let bj = cols[0]!;
          for (const j of cols) if (costs[i]![j]!.lt(costs[i]![bj]!)) bj = j;
          cands.push({ line: 'row', idx: i, p: rowPen[i]!, cell: { row: i, col: bj } });
        }
        for (const j of cols) {
          let bi = rows[0]!;
          for (const i of rows) if (costs[i]![j]!.lt(costs[bi]![j]!)) bi = i;
          cands.push({ line: 'col', idx: j, p: colPen[j]!, cell: { row: bi, col: j } });
        }
        let top = cands[0]!;
        for (const c of cands) if (c.p.gt(top.p)) top = c;
        const tiedTop = cands.filter(c => c.p.eq(top.p));
        let pick = tiedTop[0]!;
        for (const c of tiedTop) if (costs[c.cell.row]![c.cell.col]!.lt(costs[pick.cell.row]![pick.cell.col]!)) pick = c;
        const tieNote = tiedTop.length > 1 ? `Tie for the largest penalty (${top.p.toString()}) among ${joinList(tiedTop.map(c => (c.line === 'row' ? rowLabels[c.idx]! : colLabels[c.idx]!)))}; the line containing the cheapest cell is used.` : undefined;
        const penText = `Row penalties: ${rows.map(i => `${rowLabels[i]}=${rowPen[i]!.toString()}`).join(', ')}; column penalties: ${cols.map(j => `${colLabels[j]}=${colPen[j]!.toString()}`).join(', ')}.`;
        allocate(
          pick.cell.row,
          pick.cell.col,
          `${penText} The largest penalty is ${top.p.toString()} on ${pick.line === 'row' ? 'row' : 'column'} ${pick.line === 'row' ? rowLabels[pick.idx] : colLabels[pick.idx]}, and its cheapest open cell is ${cl(pick.cell.row, pick.cell.col)}.`,
          "Vogel's penalty rule",
          [],
          { rowPenalty: rowPen, colPenalty: colPen },
          tieNote
        );
      }
    }

    // make the basis a full spanning tree (m+n−1 cells) – normally already true
    let nBasic = basic.flat().filter(Boolean).length;
    if (nBasic < m + n - 1) {
      // add ε cells that keep the set acyclic
      for (let i = 0; i < m && nBasic < m + n - 1; i++) {
        for (let j = 0; j < n && nBasic < m + n - 1; j++) {
          if (basic[i]![j]) continue;
          if (findLoop(basic, i, j) === null) {
            basic[i]![j] = true;
            alloc[i]![j] = Rational.ZERO;
            nBasic++;
            diagnostics.push({ severity: 'info', code: 'EPSILON_PLACED', message: `ε (0) placed in ${cl(i, j)}: an independent cell that closes no loop, restoring m+n−1 basic cells.` });
          }
        }
      }
    }

    const initialCost = sumCost(alloc, costs);
    push(
      snap(), 'Initial solution', { kind: 'initial-solution', payload: {} },
      `${method.toUpperCase()} solution complete: cost = ${initialCost.toString()}.`,
      `The starting basic feasible solution uses ${nBasic} basic cells (m+n−1 = ${m + n - 1}) and costs ${initialCost.toString()}. It need not be optimal; MODI tests this and improves it.`,
      'Initial solution complete', [], options.initialOnly ? 'optimal' : 'continue'
    );

    /* ------------ MODI ------------ */
    let iter = 0;
    let optimal = false;
    let finalState = snap();
    if (!options.initialOnly) {
      while (iter <= maxIter) {
        const { u, v } = computeDuals(basic, costs);
        const d: (MNum | null)[][] = Array.from({ length: m }, () => Array(n).fill(null));
        let best: Cell | null = null;
        let tied: Cell[] = [];
        const zeros: Cell[] = [];
        for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
          if (basic[i]![j]) continue;
          const idx = costs[i]![j]!.sub(u[i]!).sub(v[j]!);
          d[i]![j] = idx;
          if (idx.isNegative()) {
            if (!best || idx.lt(d[best.row]![best.col]!)) { best = { row: i, col: j }; tied = [best]; }
            else if (idx.eq(d[best.row]![best.col]!)) tied.push({ row: i, col: j });
          } else if (idx.isZero()) zeros.push({ row: i, col: j });
        }
        const stone = options.stoneEval
          ? (() => {
              const out: NonNullable<TransportState['stoneEvals']> = [];
              for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
                if (basic[i]![j]) continue;
                const lp = findLoop(basic, i, j);
                if (!lp) continue;
                let ch = MNum.ZERO;
                lp.forEach(c => { ch = c.sign === '+' ? ch.add(costs[c.row]![c.col]!) : ch.sub(costs[c.row]![c.col]!); });
                out.push({ row: i, col: j, loop: lp, change: ch });
              }
              return out;
            })()
          : undefined;
        const dualText = `u = (${u.map((x, i) => `${rowLabels[i]}: ${x.toString()}`).join(', ')}); v = (${v.map((x, j) => `${colLabels[j]}: ${x.toString()}`).join(', ')}).`;

        if (!best) {
          optimal = true;
          const alt = zeros.length > 0;
          const hasM = initialCostHasM(snap().totalCost);
          const altNote = alt ? `Alternate optimum: the non-basic cell(s) ${joinList(zeros.map(z => cl(z.row, z.col)))} have improvement index exactly 0, so shifting units through their loop gives a different allocation with the same cost.` : undefined;
          if (alt) diagnostics.push({ severity: 'info', code: 'ALTERNATE_OPTIMA', message: altNote! });
          if (hasM) diagnostics.push({ severity: 'error', code: 'PROHIBITED_ROUTE_USED', message: 'The best allocation still ships along a prohibited route (cost contains M): the problem is infeasible without it.' });
          finalState = snap({ u, v, improvementIndices: d, alternateCells: zeros, stoneEvals: stone });
          push(
            finalState, 'MODI optimality test', { kind: 'optimal', payload: {} },
            `Optimal: every improvement index is ≥ 0. Total cost = ${finalState.totalCost.toString()}.`,
            `With the dual values ${dualText} every non-basic cell has cᵢⱼ − uᵢ − vⱼ ≥ 0, so sending any unit along a non-basic route would not lower the cost. The solution is optimal with cost ${finalState.totalCost.toString()}.`,
            'MODI optimality condition', [], 'optimal', altNote
          );
          break;
        }

        const loop = findLoop(basic, best.row, best.col)!;
        const minus = loop.filter(c => c.sign === '-');
        let theta = alloc[minus[0]!.row]![minus[0]!.col]!;
        for (const c of minus) { const a = alloc[c.row]![c.col]!; if (a.lt(theta)) theta = a; }
        const leaversAll = minus.filter(c => alloc[c.row]![c.col]!.eq(theta));
        const leaver = leaversAll[0]!;
        const tieMsg = leaversAll.length > 1 ? `Several minus cells tie at ${theta.toString()} (${joinList(leaversAll.map(c => cl(c.row, c.col)))}); only ${cl(leaver.row, leaver.col)} leaves, the others stay basic with 0 (degenerate).` : undefined;
        const entTie = tied.length > 1 ? `Tie among ${joinList(tied.map(t => cl(t.row, t.col)))} with index ${d[best.row]![best.col]!.toString()}; the lowest row/column was taken.` : undefined;

        push(
          snap({ u, v, improvementIndices: d, loop, enteringCell: best, leavingCell: { row: leaver.row, col: leaver.col }, theta, stoneEvals: stone }),
          `MODI iteration ${iter + 1} – evaluate`,
          { kind: 'evaluate', payload: { entering: best } },
          `${cl(best.row, best.col)} enters (improvement index ${d[best.row]![best.col]!.toString()}).`,
          `Dual values (u₁ = 0): ${dualText} Improvement index cᵢⱼ − uᵢ − vⱼ for each non-basic cell; the most negative is ${cl(best.row, best.col)} = ${costs[best.row]![best.col]!.toString()} − ${u[best.row]!.toString()} − ${v[best.col]!.toString()} = ${d[best.row]![best.col]!.toString()}. ` +
            `Sending one unit through it lowers the cost by ${d[best.row]![best.col]!.neg().toString()}. The closed loop through basic cells alternates + and −: ${loop.map(c => `${c.sign}${cl(c.row, c.col)}`).join(' → ')}. ` +
            `θ = smallest allocation on a minus cell = ${theta.toString()}, so ${cl(leaver.row, leaver.col)} leaves the basis. ${tieMsg ?? ''}`,
          'Most negative improvement index; closed loop θ-rule',
          loop.map(c => ({ target: `cell:${c.row},${c.col}`, intent: 'loop' as const })),
          'continue',
          entTie
        );

        // reallocate
        for (const c of loop) {
          const cur = alloc[c.row]![c.col] ?? Rational.ZERO;
          alloc[c.row]![c.col] = c.sign === '+' ? cur.add(theta) : cur.sub(theta);
        }
        basic[best.row]![best.col] = true;
        basic[leaver.row]![leaver.col] = false;
        alloc[leaver.row]![leaver.col] = null;
        iter++;
        if (theta.isZero()) diagnostics.push({ severity: 'info', code: 'DEGENERATE_PIVOT', message: `MODI iteration ${iter} moved θ = 0: the basis changed but the allocation and cost did not (degenerate).` });
        const after = snap({ u, v, loop, enteringCell: best, leavingCell: { row: leaver.row, col: leaver.col }, theta });
        push(
          after,
          `MODI iteration ${iter} – reallocate`,
          { kind: 'pivot', payload: { entering: best, leaving: leaver, theta: theta.toString() } },
          `Shift θ = ${theta.toString()} around the loop; cost is now ${after.totalCost.toString()}.`,
          `Add θ = ${theta.toString()} to the plus cells and subtract it from the minus cells. ${cl(best.row, best.col)} becomes basic; ${cl(leaver.row, leaver.col)} drops out. The total cost changes from ${sumCostBefore(after, d, best, theta)} to ${after.totalCost.toString()}.`,
          'Stepping-stone reallocation',
          loop.map(c => ({ target: `cell:${c.row},${c.col}`, intent: 'changed' as const })),
          'continue'
        );
      }
      if (!optimal) diagnostics.push({ severity: 'error', code: 'ITERATION_LIMIT', message: `MODI stopped after ${maxIter} iterations without proving optimality.` });
    }

    const final = optimal ? finalState : snap();
    const hasM = initialCostHasM(final.totalCost);
    const reported = model.objective === 'max' ? maxObjective(model, final.allocations) : final.totalCost;
    return {
      steps,
      result: {
        state: final,
        initialCost,
        initialMethod: method,
        modiIterations: iter,
        costs,
        rowLabels,
        colLabels,
        feasible: !hasM,
        reportedObjective: reported,
      },
      status: hasM ? 'infeasible' : optimal || options.initialOnly ? 'optimal' : 'iteration-limit',
      diagnostics,
      metrics: { iterations: iter, elapsedMs: Math.round((performance.now() - t0) * 100) / 100, degradedToFloat: false },
    };
  }
}

function initialCostHasM(c: MNum): boolean { return c.hasM(); }

function sumCostBefore(after: TransportState, d: (MNum | null)[][], best: Cell, theta: Rational): string {
  const delta = d[best.row]![best.col]!.scale(theta);
  return after.totalCost.sub(delta).toString();
}

function maxObjective(model: TransportModel, alloc: (Rational | null)[][]): MNum {
  let t = Rational.ZERO;
  alloc.forEach((row, i) => row.forEach((a, j) => {
    if (a && i < model.costs.length && j < (model.costs[0]?.length ?? 0)) t = t.add(a.mul(model.costs[i]![j]!));
  }));
  return MNum.of(t);
}

/* ---------------- Method comparison (F12) ---------------- */

export interface MethodComparisonRow {
  method: InitialMethod;
  initialCost: MNum;
  iterations: number;
  finalCost: MNum;
  state: TransportState;
}

export function compareInitialMethods(model: TransportModel): MethodComparisonRow[] {
  const solver = new TransportSolver();
  const rows: MethodComparisonRow[] = [];
  for (const method of ['nwc', 'lcm', 'vam'] as InitialMethod[]) {
    const r = solver.solve(model, { variant: method, emitSteps: false }).result;
    if (r) rows.push({ method, initialCost: r.initialCost, iterations: r.modiIterations, finalCost: r.state.totalCost, state: r.state });
  }
  return rows;
}
