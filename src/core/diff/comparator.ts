/**
 * Diff Mode engine (novel feature F11, spec §6.4 & §11.7).
 *
 * Given the student's hand-worked state, find the FIRST step at which it diverges from the correct
 * trajectory, list the differing cells, and infer the likely cause from the pattern of the error:
 *
 *  - wrong entering variable / wrong leaving variable (ratio test mistakes) — by replaying every alternative pivot
 *  - pivot row not normalised, or scaled by a constant factor
 *  - wrong elimination multiplier in a row
 *  - signs inverted in the z-row (max/min sense mixed up)
 *  - a single arithmetic slip
 *
 * Also provides a generic grid comparator for the allocation / assignment / label modules.
 */

import { Rational } from '../math/rational';
import { Tableau } from '../types/models';
import { Step } from '../types/step';
import { StateDiff } from '../types/solver';
import { joinList } from '../format';

type Grid = Rational[][];

function tableauRows(t: Tableau): { rows: Grid; z: Rational[][] } {
  const rows: Grid = t.matrix.map((r, i) => [...r, t.rhs[i] ?? Rational.ZERO]);
  const z: Rational[][] = [[...t.objectiveRow, t.objectiveValue]];
  if (t.bigMRow) z.push([...t.bigMRow, t.objectiveValueM ?? Rational.ZERO]);
  return { rows, z };
}

function applyPivot(rows: Grid, z: Rational[][], r: number, c: number): { rows: Grid; z: Rational[][] } | null {
  const p = rows[r]?.[c];
  if (!p || p.isZero()) return null;
  const inv = p.inv();
  const pr = rows[r]!.map(v => v.mul(inv));
  const nr = rows.map((row, i) => {
    if (i === r) return pr;
    const f = row[c]!;
    return f.isZero() ? row : row.map((v, k) => v.sub(f.mul(pr[k]!)));
  });
  const nz = z.map(row => {
    const f = row[c]!;
    return f.isZero() ? row : row.map((v, k) => v.sub(f.mul(pr[k]!)));
  });
  return { rows: nr, z: nz };
}

function gridEq(a: Grid, b: Grid): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => row.length === b[i]!.length && row.every((v, k) => v.eq(b[i]![k]!)));
}

function stateEq(a: { rows: Grid; z: Rational[][] }, b: { rows: Grid; z: Rational[][] }): boolean {
  return gridEq(a.rows, b.rows) && gridEq(a.z, b.z);
}

function countDiffs(a: { rows: Grid; z: Rational[][] }, b: { rows: Grid; z: Rational[][] }): number {
  let n = 0;
  const cmp = (x: Grid, y: Grid) => {
    for (let i = 0; i < Math.max(x.length, y.length); i++)
      for (let k = 0; k < Math.max(x[i]?.length ?? 0, y[i]?.length ?? 0); k++)
        if (!(x[i]?.[k] ?? Rational.ZERO).eq(y[i]?.[k] ?? Rational.ZERO)) n++;
  };
  cmp(a.rows, b.rows);
  cmp(a.z, b.z);
  return n;
}

export class DiffComparator {
  /**
   * Compare ONE hand-worked tableau against the solver trajectory.
   * @param opts.iteration if given, compare against exactly that step; otherwise search for the closest step.
   */
  static compareTableau(user: Tableau, steps: Step<Tableau>[], opts: { iteration?: number } = {}): StateDiff {
    if (steps.length === 0) return { matches: false, differences: [], summary: 'There is no solver trajectory to compare against.' };
    const u = tableauRows(user);

    let idx = opts.iteration;
    if (idx === undefined || idx < 0 || idx >= steps.length) {
      // locate exact match first, otherwise the closest by number of differing cells
      let best = 0;
      let bestN = Infinity;
      for (let k = 0; k < steps.length; k++) {
        const c = tableauRows(steps[k]!.state);
        if (c.rows.length !== u.rows.length || (c.rows[0]?.length ?? 0) !== (u.rows[0]?.length ?? 0)) continue;
        const n = countDiffs(u, c);
        if (n === 0) {
          return { matches: true, differences: [], divergenceStep: undefined, summary: `Your tableau matches the solver exactly at step ${k}. Well done.` };
        }
        if (n < bestN) { bestN = n; best = k; }
      }
      idx = best;
    }

    const correctStep = steps[idx]!;
    const correct = tableauRows(correctStep.state);
    if (correct.rows.length !== u.rows.length || (correct.rows[0]?.length ?? 0) !== (u.rows[0]?.length ?? 0)) {
      return {
        matches: false,
        divergenceStep: idx,
        differences: [{ target: 'shape', expected: `${correct.rows.length} rows × ${(correct.rows[0]?.length ?? 1) - 1} columns`, actual: `${u.rows.length} rows × ${(u.rows[0]?.length ?? 1) - 1} columns`, likelyCause: 'The tableau has a different number of rows/columns than the solver\'s (check slack, surplus and artificial columns).' }],
        summary: `The shape of your tableau does not match step ${idx}.`,
      };
    }
    if (stateEq(u, correct)) {
      return { matches: true, differences: [], summary: `Your tableau matches the solver exactly at step ${idx}. Well done.` };
    }

    const names = correctStep.state.columnNames;
    const basisNames = correctStep.state.basis.map(b => names[b] ?? '?');
    const diffs: StateDiff['differences'] = [];
    const label = (i: number, k: number) => {
      const col = k < names.length ? names[k]! : 'RHS';
      return i < 0 ? `z-row, column ${col}` : `row of ${basisNames[i] ?? i + 1}, column ${col}`;
    };
    for (let k = 0; k < correct.z[0]!.length; k++) {
      const a = u.z[0]?.[k] ?? Rational.ZERO;
      const b = correct.z[0]![k]!;
      if (!a.eq(b)) diffs.push({ target: label(-1, k), expected: b.toString(), actual: a.toString() });
    }
    if (correct.z[1]) {
      for (let k = 0; k < correct.z[1].length; k++) {
        const a = u.z[1]?.[k] ?? Rational.ZERO;
        if (!a.eq(correct.z[1][k]!)) diffs.push({ target: `${label(-1, k)} (M-coefficient)`, expected: correct.z[1][k]!.toString(), actual: a.toString() });
      }
    }
    for (let i = 0; i < correct.rows.length; i++) {
      for (let k = 0; k < correct.rows[i]!.length; k++) {
        const a = u.rows[i]![k]!;
        const b = correct.rows[i]![k]!;
        if (!a.eq(b)) diffs.push({ target: label(i, k), expected: b.toString(), actual: a.toString() });
      }
    }

    const cause = idx > 0 ? this.inferCause(steps[idx - 1]!.state, steps[idx]!.state, u, correct) : 'The initial tableau is built directly from the model — check the coefficients, slack/surplus signs and the z-row (entries are −cⱼ for a maximisation).';
    if (diffs.length) diffs[0]!.likelyCause = cause;

    return {
      matches: false,
      divergenceStep: idx,
      differences: diffs,
      summary: `Your working diverges at step ${idx}: ${diffs.length} cell${diffs.length === 1 ? '' : 's'} differ. Likely cause — ${cause}`,
    };
  }

  /** Compare a SEQUENCE of hand-worked tableaux (iteration 0, 1, 2 …) and report the first divergence. */
  static compareSequence(userTableaux: Tableau[], steps: Step<Tableau>[]): StateDiff {
    for (let k = 0; k < userTableaux.length; k++) {
      if (k >= steps.length) {
        return { matches: false, divergenceStep: k, differences: [], summary: `The solver finished after step ${steps.length - 1}; your step ${k} has no counterpart.` };
      }
      const d = this.compareTableau(userTableaux[k]!, steps, { iteration: k });
      if (!d.matches) return d;
    }
    return { matches: true, differences: [], summary: `All ${userTableaux.length} of your tableaux agree with the solver.` };
  }

  private static inferCause(prev: Tableau, correctState: Tableau, user: { rows: Grid; z: Rational[][] }, correct: { rows: Grid; z: Rational[][] }): string {
    const p = tableauRows(prev);
    const names = prev.columnNames;
    const rowName = (i: number) => names[prev.basis[i]!] ?? `row ${i + 1}`;
    const np = prev.nextPivot;
    void correctState;

    // (0) Nothing was done.
    if (stateEq(user, p)) return 'Your tableau is unchanged from the previous step — the pivot was not carried out.';

    // (1) Replay every alternative pivot: does the student's tableau equal the result of a DIFFERENT pivot?
    for (let r = 0; r < p.rows.length; r++) {
      for (let c = 0; c < names.length; c++) {
        const res = applyPivot(p.rows, p.z, r, c);
        if (!res || !stateEq(res, user)) continue;
        const cr = np?.leavingRow;
        const cc = np?.enteringCol;
        if (cc !== undefined && c !== cc) {
          const zc = prev.objectiveRow[c]!;
          return `You pivoted on column ${names[c]} (z-row entry ${zc.toString()}) instead of ${names[cc]} (z-row entry ${prev.objectiveRow[cc]!.toString()}). ${zc.isNegative() ? 'It is an improving column, but not the most negative one.' : 'A non-negative z-row entry never improves a maximisation tableau.'} Re-read the entering-variable rule.`;
        }
        if (cr !== undefined && r !== cr) {
          const entry = p.rows[r]![c]!;
          if (!entry.isPositive()) {
            return `You chose the right entering variable ${names[c]} but used row ${rowName(r)} as pivot row, whose entry ${entry.toString()} is not positive — the ratio test must skip zero and negative entries.`;
          }
          const myRatio = p.rows[r]![p.rows[r]!.length - 1]!.div(entry);
          return `You chose the right entering variable ${names[c]} but the wrong leaving variable (${rowName(r)}, ratio ${myRatio.toString()}). The minimum ratio is in row ${rowName(cr)} (${np!.ratios[cr]?.toString() ?? '—'}).`;
        }
      }
    }

    // (2) z-row sign inversion
    const zNeg = user.z[0]!.every((v, k) => v.eq(correct.z[0]![k]!.neg()));
    if (zNeg && !user.z[0]!.every(v => v.isZero())) {
      return 'Every z-row entry has the opposite sign of the correct one — the maximisation/minimisation sense was misapplied (for a max problem the z-row holds −cⱼ; for a min problem the tableau is built for max(−z)).';
    }

    // (3) Row-by-row patterns
    const reasons: string[] = [];
    let pivotRowIdx = np?.leavingRow ?? -1;
    if (pivotRowIdx < 0) pivotRowIdx = correct.rows.findIndex((row, i) => row[(np?.enteringCol ?? -1)]?.eq(Rational.ONE) && correct.rows.every((r2, i2) => i2 === i || (r2[np?.enteringCol ?? 0] ?? Rational.ZERO).isZero()));
    for (let i = 0; i < correct.rows.length; i++) {
      const ur = user.rows[i]!;
      const cr = correct.rows[i]!;
      if (ur.every((v, k) => v.eq(cr[k]!))) continue;
      // constant factor?
      let lambda: Rational | null = null;
      let constant = true;
      for (let k = 0; k < cr.length; k++) {
        if (cr[k]!.isZero()) { if (!ur[k]!.isZero()) constant = false; continue; }
        const q = ur[k]!.div(cr[k]!);
        if (lambda === null) lambda = q; else if (!q.eq(lambda)) constant = false;
      }
      if (constant && lambda && !lambda.eq(Rational.ONE) && !lambda.isZero()) {
        if (i === pivotRowIdx) reasons.push(`the pivot row (${rowName(i)}) was not normalised correctly: every entry is ${lambda.toString()}× the correct value — divide the whole row by the pivot element ${p.rows[i]![np?.enteringCol ?? 0]?.toString() ?? ''}`);
        else reasons.push(`row ${rowName(i)} is exactly ${lambda.toString()}× the correct row — a scaling error`);
        continue;
      }
      // elimination multiplier error: user_i = prev_i − f'·pivotRow
      if (np && pivotRowIdx >= 0 && i !== pivotRowIdx) {
        const pr = correct.rows[pivotRowIdx]!;
        const c = np.enteringCol;
        const fCorrect = p.rows[i]![c]!;
        const fUser = p.rows[i]![c]!.sub(ur[c]!);
        const consistent = ur.every((v, k) => v.eq(p.rows[i]![k]!.sub(fUser.mul(pr[k]!))));
        if (consistent && !fUser.eq(fCorrect)) {
          reasons.push(`in row ${rowName(i)} you subtracted ${fUser.toString()}× the pivot row instead of ${fCorrect.toString()}× (the multiplier must equal the entry in the pivot column, so that entry becomes 0)`);
          continue;
        }
      }
    }
    // z-row multiplier
    {
      const np2 = np;
      if (np2 && pivotRowIdx >= 0) {
        const pr = correct.rows[pivotRowIdx]!;
        const c = np2.enteringCol;
        const fCorrect = p.z[0]![c]!;
        const fUser = p.z[0]![c]!.sub(user.z[0]![c]!);
        const consistent = user.z[0]!.every((v, k) => v.eq(p.z[0]![k]!.sub(fUser.mul(pr[k]!))));
        if (consistent && !fUser.eq(fCorrect) && !user.z[0]!.every((v, k) => v.eq(correct.z[0]![k]!))) {
          reasons.push(`in the z-row you subtracted ${fUser.toString()}× the pivot row instead of ${fCorrect.toString()}×`);
        }
      }
    }
    if (reasons.length) return reasons.join('; ') + '.';

    // (4) one arithmetic slip
    const total = countDiffs(user, correct);
    if (total === 1) return 'A single entry is off — most likely an arithmetic slip in one multiplication or subtraction; all other entries are right.';
    if (total <= 3) return 'A few neighbouring entries differ — recheck the arithmetic of the row operations (row_i ← row_i − (pivot-column entry) × pivot row).';
    return `Many entries differ (${total}) without a recognisable pattern — recompute from the previous tableau, starting with the pivot row, then each remaining row in turn, and finally the z-row${names.length ? ` (${joinList(names.slice(0, 3))}…)` : ''}.`;
  }

  /**
   * Generic grid comparison for allocation grids, reduced matrices, label tables, etc.
   * `userGrids[k]` is the student's state after k steps (any subset of steps may be supplied by index).
   */
  static compareGrids(
    user: (string | null)[][],
    correct: (string | null)[][],
    rowNames: string[],
    colNames: string[]
  ): StateDiff['differences'] {
    const out: StateDiff['differences'] = [];
    for (let i = 0; i < correct.length; i++) {
      for (let j = 0; j < (correct[i]?.length ?? 0); j++) {
        const a = (user[i]?.[j] ?? '') || '–';
        const b = correct[i]![j] ?? '–';
        const bb = b === null ? '–' : b;
        if (a !== bb) out.push({ target: `${rowNames[i] ?? `row ${i + 1}`} → ${colNames[j] ?? `col ${j + 1}`}`, expected: bb, actual: a });
      }
    }
    return out;
  }
}
