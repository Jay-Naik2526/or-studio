/**
 * Two-person zero-sum games (spec §9.4, §10.6).
 * Saddle points (all of them), iterative dominance elimination (each shown), graphical solution for
 * 2×n and m×2, and the exact LP method (both players' LPs solved with the simplex engine and cross-checked).
 * Payoffs are to the ROW player (maximiser); the column player minimises.
 */

import { Rational } from '../../math/rational';
import { LPModel } from '../../types/models';
import { Step } from '../../types/step';
import { Diagnostic } from '../../types/solver';
import { solveLP } from '../lp/engine';
import { joinList } from '../../format';

export interface GameMatrix {
  payoff: Rational[][];
  rowNames?: string[];
  colNames?: string[];
}

export interface GameState {
  matrix: Rational[][];
  activeRows: number[];
  activeCols: number[];
  rowLabels: string[];
  colLabels: string[];
  rowMinima?: Rational[];
  colMaxima?: Rational[];
  saddlePoints?: { row: number; col: number }[];
  eliminated?: { kind: 'row' | 'col'; index: number; by: number; weak: boolean };
  strategyRow?: Rational[];
  strategyCol?: Rational[];
  value?: Rational;
}

export interface GraphicalGame {
  kind: '2xn' | 'mx2';
  /** each line: payoff as a function of the mixing probability t ∈ [0,1] : value = intercept + slope·t */
  lines: { label: string; index: number; intercept: Rational; slope: Rational }[];
  optimalT: Rational;
  value: Rational;
  /** indices (into lines) active at the optimum */
  activeLines: number[];
}

export interface ZeroSumResult {
  error?: string;
  hasSaddlePoint: boolean;
  gameValue: Rational;
  playerAStrategy: Rational[];
  playerBStrategy: Rational[];
  methodUsed: 'saddle_point' | 'dominance' | 'graphical' | 'lp';
  maximin: Rational;
  minimax: Rational;
  rowMinima: Rational[];
  colMaxima: Rational[];
  saddlePoints: { row: number; col: number }[];
  reducedRows: number[];
  reducedCols: number[];
  graphical?: GraphicalGame;
  verified: boolean;
  steps: Step<GameState>[];
  diagnostics: Diagnostic[];
  /** set when solved by LP: the LP model for the row player */
  lpModel?: LPModel;
  fair: boolean;
}

function minOf(xs: Rational[]) { return xs.reduce((a, b) => (b.lt(a) ? b : a)); }
function maxOf(xs: Rational[]) { return xs.reduce((a, b) => (b.gt(a) ? b : a)); }

export function solveZeroSumGame(game: GameMatrix): ZeroSumResult {
  const A = game.payoff;
  const m = A.length;
  const n = A[0]?.length ?? 0;
  const empty: ZeroSumResult = { hasSaddlePoint: false, gameValue: Rational.ZERO, playerAStrategy: [], playerBStrategy: [], methodUsed: 'lp', maximin: Rational.ZERO, minimax: Rational.ZERO, rowMinima: [], colMaxima: [], saddlePoints: [], reducedRows: [], reducedCols: [], verified: false, steps: [], diagnostics: [], fair: false };
  if (m === 0 || n === 0 || A.some(r => r.length !== n)) return { ...empty, error: 'The payoff matrix must be a non-empty rectangle.' };
  const rowLabels = Array.from({ length: m }, (_, i) => game.rowNames?.[i] ?? `A${i + 1}`);
  const colLabels = Array.from({ length: n }, (_, j) => game.colNames?.[j] ?? `B${j + 1}`);
  const steps: Step<GameState>[] = [];
  const diagnostics: Diagnostic[] = [];
  const push = (phase: string, short: string, detailed: string, rule: string, state: Partial<GameState>, status: Step<GameState>['status'] = 'continue') => {
    steps.push({ index: steps.length, phase, state: { matrix: A, activeRows: [...activeRows], activeCols: [...activeCols], rowLabels, colLabels, ...state }, action: null, explanation: { short, detailed, rule }, highlights: [], status });
  };
  let activeRows = A.map((_, i) => i);
  let activeCols = A[0]!.map((_, j) => j);

  // saddle points
  const rowMinima = A.map(r => minOf(r));
  const colMaxima = A[0]!.map((_, j) => maxOf(A.map(r => r[j]!)));
  const maximin = maxOf(rowMinima);
  const minimax = minOf(colMaxima);
  const saddles: { row: number; col: number }[] = [];
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) if (A[i]![j]!.eq(rowMinima[i]!) && A[i]![j]!.eq(colMaxima[j]!)) saddles.push({ row: i, col: j });
  push('Payoff matrix', `${m} × ${n} game; payoffs go to the row player ${m > 0 ? '(maximiser)' : ''}.`, 'The row player picks a row to maximise the payoff, the column player a column to minimise it. First test whether a pure-strategy equilibrium (saddle point) exists.', 'Initialisation', {}, 'initial');
  push('Maximin / minimax', `Maximin = ${maximin.toString()}, minimax = ${minimax.toString()}.`,
    `Row minima: ${rowMinima.map((v, i) => `${rowLabels[i]}: ${v.toString()}`).join(', ')} → maximin (the best the row player can guarantee) = ${maximin.toString()}. Column maxima: ${colMaxima.map((v, j) => `${colLabels[j]}: ${v.toString()}`).join(', ')} → minimax (the least the column player can hold the row player to) = ${minimax.toString()}. ` +
    (maximin.eq(minimax) ? 'They are equal, so a saddle point exists.' : `Since maximin ${maximin.toString()} < minimax ${minimax.toString()}, there is no saddle point: neither player can do better with a pure strategy without being exploited, so mixed strategies are required.`),
    'Maximin–minimax test', { rowMinima, colMaxima, saddlePoints: saddles });

  const finish = (r: Omit<ZeroSumResult, 'steps' | 'diagnostics' | 'maximin' | 'minimax' | 'rowMinima' | 'colMaxima' | 'saddlePoints' | 'fair' | 'verified'>): ZeroSumResult => {
    // verify: row strategy guarantees ≥ v against every column; column strategy holds ≤ v against every row
    const rowOk = A[0]!.every((_, j) => A.reduce((s, row, i) => s.add(r.playerAStrategy[i]!.mul(row[j]!)), Rational.ZERO).gte(r.gameValue));
    const colOk = A.every(row => row.reduce((s, v, j) => s.add(r.playerBStrategy[j]!.mul(v)), Rational.ZERO).lte(r.gameValue));
    const sums = r.playerAStrategy.reduce((a, b) => a.add(b), Rational.ZERO).eq(Rational.ONE) && r.playerBStrategy.reduce((a, b) => a.add(b), Rational.ZERO).eq(Rational.ONE);
    return { ...r, maximin, minimax, rowMinima, colMaxima, saddlePoints: saddles, steps, diagnostics, verified: rowOk && colOk && sums, fair: r.gameValue.isZero() };
  };

  if (maximin.eq(minimax)) {
    const s = saddles[0]!;
    const a = Array(m).fill(Rational.ZERO); a[s.row] = Rational.ONE;
    const b = Array(n).fill(Rational.ZERO); b[s.col] = Rational.ONE;
    push('Saddle point', `Saddle point at (${rowLabels[s.row]}, ${colLabels[s.col]}): game value ${maximin.toString()}.`, `${saddles.length > 1 ? `${saddles.length} saddle points: ${joinList(saddles.map(x => `(${rowLabels[x.row]}, ${colLabels[x.col]})`))}. ` : ''}At (${rowLabels[s.row]}, ${colLabels[s.col]}) the entry is both the smallest in its row and the largest in its column, so neither player gains by deviating: both play pure strategies and the value of the game is ${maximin.toString()}.`, 'Saddle-point equilibrium', { saddlePoints: saddles, strategyRow: a, strategyCol: b, value: maximin }, 'optimal');
    return finish({ hasSaddlePoint: true, gameValue: maximin, playerAStrategy: a, playerBStrategy: b, methodUsed: 'saddle_point', reducedRows: [s.row], reducedCols: [s.col] });
  }
  diagnostics.push({ severity: 'info', code: 'NO_SADDLE', message: `No saddle point (maximin ${maximin.toString()} ≠ minimax ${minimax.toString()}): the solution uses mixed strategies.` });

  // dominance elimination
  const cur = (i: number, j: number) => A[i]![j]!;
  let changed = true;
  let eliminatedAny = false;
  while (changed && (activeRows.length > 1 || activeCols.length > 1)) {
    changed = false;
    outer: for (const i of activeRows) {
      for (const k of activeRows) {
        if (i === k) continue;
        const ge = activeCols.every(j => cur(k, j).gte(cur(i, j)));
        if (!ge) continue;
        const strict = activeCols.some(j => cur(k, j).gt(cur(i, j)));
        if (!strict && k > i) continue; // identical rows: keep the lower index
        if (activeRows.length <= 1) break outer;
        activeRows = activeRows.filter(x => x !== i);
        push('Dominance', `${rowLabels[i]} is dominated by ${rowLabels[k]} and removed.`, `Whatever the column player does, ${rowLabels[k]} pays at least as much as ${rowLabels[i]} (${activeCols.map(j => `${cur(k, j).toString()} ≥ ${cur(i, j).toString()}`).join(', ')}), so a rational maximiser never needs ${rowLabels[i]}.${strict ? '' : ' (The two rows are identical.)'}`, 'Row dominance', { eliminated: { kind: 'row', index: i, by: k, weak: !strict } });
        changed = eliminatedAny = true;
        break outer;
      }
    }
    if (changed) continue;
    outer2: for (const j of activeCols) {
      for (const l of activeCols) {
        if (j === l) continue;
        const le = activeRows.every(i => cur(i, l).lte(cur(i, j)));
        if (!le) continue;
        const strict = activeRows.some(i => cur(i, l).lt(cur(i, j)));
        if (!strict && l > j) continue;
        if (activeCols.length <= 1) break outer2;
        activeCols = activeCols.filter(x => x !== j);
        push('Dominance', `${colLabels[j]} is dominated by ${colLabels[l]} and removed.`, `Against every remaining row, ${colLabels[l]} costs the column player no more than ${colLabels[j]} (${activeRows.map(i => `${cur(i, l).toString()} ≤ ${cur(i, j).toString()}`).join(', ')}), so the minimiser never needs ${colLabels[j]}.${strict ? '' : ' (The two columns are identical.)'}`, 'Column dominance', { eliminated: { kind: 'col', index: j, by: l, weak: !strict } });
        changed = eliminatedAny = true;
        break outer2;
      }
    }
  }
  const rr = [...activeRows];
  const rc = [...activeCols];
  const sub = rr.map(i => rc.map(j => A[i]![j]!));
  if (eliminatedAny) push('Reduced game', `Reduced to a ${rr.length} × ${rc.length} game.`, `After removing dominated strategies, the remaining game (rows ${rr.map(i => rowLabels[i]).join(', ')}; columns ${rc.map(j => colLabels[j]).join(', ')}) has the same value as the original.`, 'Dominance reduction complete', {});

  // graphical for 2×n or m×2 (on the reduced game)
  let graphical: GraphicalGame | undefined;
  if (rr.length === 2 && rc.length >= 2) {
    const lines = rc.map((j, jj) => ({ label: colLabels[j]!, index: j, intercept: sub[1]![jj]!, slope: sub[0]![jj]!.sub(sub[1]![jj]!) }));
    const cand = new Set<string>(['0', '1']);
    const cands: Rational[] = [Rational.ZERO, Rational.ONE];
    for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++) {
      const ds = lines[a]!.slope.sub(lines[b]!.slope);
      if (ds.isZero()) continue;
      const t = lines[b]!.intercept.sub(lines[a]!.intercept).div(ds);
      if (t.gte(Rational.ZERO) && t.lte(Rational.ONE) && !cand.has(t.toString())) { cand.add(t.toString()); cands.push(t); }
    }
    const env = (t: Rational) => minOf(lines.map(l => l.intercept.add(l.slope.mul(t))));
    let bt = cands[0]!;
    for (const t of cands) if (env(t).gt(env(bt))) bt = t;
    graphical = { kind: '2xn', lines, optimalT: bt, value: env(bt), activeLines: lines.map((l, k) => (l.intercept.add(l.slope.mul(bt)).eq(env(bt)) ? k : -1)).filter(k => k >= 0) };
    push('Graphical solution', `Row player mixes ${rowLabels[rr[0]!]} with probability p = ${bt.toString()}: value ${graphical.value.toString()}.`, `Plot the expected payoff against each column as a function of p = P(${rowLabels[rr[0]!]}). The row player maximises the LOWER envelope of these lines; its highest point is at p = ${bt.toString()} with value ${graphical.value.toString()}, where the lines of ${joinList(graphical.activeLines.map(k => lines[k]!.label))} cross.`, 'Graphical method (2 × n)', {});
  } else if (rc.length === 2 && rr.length >= 2) {
    const lines = rr.map((i, ii) => ({ label: rowLabels[i]!, index: i, intercept: sub[ii]![1]!, slope: sub[ii]![0]!.sub(sub[ii]![1]!) }));
    const cands: Rational[] = [Rational.ZERO, Rational.ONE];
    const seen = new Set<string>(['0', '1']);
    for (let a = 0; a < lines.length; a++) for (let b = a + 1; b < lines.length; b++) {
      const ds = lines[a]!.slope.sub(lines[b]!.slope);
      if (ds.isZero()) continue;
      const t = lines[b]!.intercept.sub(lines[a]!.intercept).div(ds);
      if (t.gte(Rational.ZERO) && t.lte(Rational.ONE) && !seen.has(t.toString())) { seen.add(t.toString()); cands.push(t); }
    }
    const env = (t: Rational) => maxOf(lines.map(l => l.intercept.add(l.slope.mul(t))));
    let bt = cands[0]!;
    for (const t of cands) if (env(t).lt(env(bt))) bt = t;
    graphical = { kind: 'mx2', lines, optimalT: bt, value: env(bt), activeLines: lines.map((l, k) => (l.intercept.add(l.slope.mul(bt)).eq(env(bt)) ? k : -1)).filter(k => k >= 0) };
    push('Graphical solution', `Column player mixes ${colLabels[rc[0]!]} with probability q = ${bt.toString()}: value ${graphical.value.toString()}.`, `Plot the expected payoff of each row against q = P(${colLabels[rc[0]!]}). The column player minimises the UPPER envelope; its lowest point is at q = ${bt.toString()} with value ${graphical.value.toString()}.`, 'Graphical method (m × 2)', {});
  }

  // LP on the reduced game (exact, both players)
  const mm = rr.length, nn = rc.length;
  if (mm === 1 || nn === 1) {
    // degenerate reduced game: a single row or column – pure strategies
    const j = nn === 1 ? 0 : sub[0]!.reduce((bi, v, jj) => (v.lt(sub[0]![bi]!) ? jj : bi), 0);
    const i = mm === 1 ? 0 : sub.reduce((bi, row, ii) => (row[j]!.gt(sub[bi]![j]!) ? ii : bi), 0);
    const a = Array(m).fill(Rational.ZERO); a[rr[i]!] = Rational.ONE;
    const b = Array(n).fill(Rational.ZERO); b[rc[j]!] = Rational.ONE;
    const v = sub[i]![j]!;
    push('Solution', `Pure strategies after dominance: value ${v.toString()}.`, 'Dominance reduced the game to a single row or column, so both players play pure strategies.', 'Dominance solution', { strategyRow: a, strategyCol: b, value: v }, 'optimal');
    return finish({ hasSaddlePoint: false, gameValue: v, playerAStrategy: a, playerBStrategy: b, methodUsed: 'dominance', reducedRows: rr, reducedCols: rc, graphical });
  }
  const minV = minOf(sub.flat());
  const K = minV.isPositive() ? Rational.ZERO : Rational.ONE.sub(minV); // make every entry ≥ 1 > 0
  const Ap = sub.map(r => r.map(v => v.add(K)));
  // Row player: min Σx' s.t. A'ᵀ x' ≥ 1
  const rowLP: LPModel = {
    sense: 'min',
    objective: Array(mm).fill(Rational.ONE),
    constraints: rc.map((j, jj) => ({ coeffs: Ap.map(r => r[jj]!), relation: '>=' as const, rhs: Rational.ONE, name: `vs ${colLabels[j]}` })),
    varNames: rr.map(i => `x_${rowLabels[i]}`),
  };
  const sol = solveLP(rowLP, { method: 'auto' });
  if (!sol.result) return { ...empty, error: 'The LP for the game could not be solved.', steps, diagnostics };
  const sumX = sol.result.objectiveValue;
  const vPrime = Rational.ONE.div(sumX);
  const value = vPrime.sub(K);
  const a = Array(m).fill(Rational.ZERO);
  rr.forEach((i, ii) => (a[i] = sol.result!.variableValues[ii]!.mul(vPrime)));
  // Column player's strategy from the LP duals (shadow prices of the ≥ constraints)
  const b = Array(n).fill(Rational.ZERO);
  rc.forEach((j, jj) => (b[j] = sol.result!.dualValues[jj]!.mul(vPrime)));
  push('LP formulation', `Shift payoffs by ${K.toString()} so all are positive, then solve the LP: minimise Σxᵢ subject to A'ᵀx ≥ 1.`, `With v' = value of the shifted game > 0 and xᵢ = pᵢ/v', the row player's problem "maximise v" becomes: minimise Σ xᵢ s.t. Σᵢ a'ᵢⱼ xᵢ ≥ 1 for every column j. The simplex optimum gives Σxᵢ = ${sumX.toString()}, so v' = 1/Σxᵢ = ${vPrime.toString()} and the value of the original game is ${vPrime.toString()} − ${K.toString()} = ${value.toString()}. The column player's optimal mix is read from the LP's dual values (shadow prices) times v'.`, 'LP method (simplex)', { strategyRow: a, strategyCol: b, value }, 'optimal');
  return { ...finish({ hasSaddlePoint: false, gameValue: value, playerAStrategy: a, playerBStrategy: b, methodUsed: 'lp', reducedRows: rr, reducedCols: rc, graphical }), lpModel: rowLP };
}
