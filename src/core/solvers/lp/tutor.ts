/**
 * Tutorial mode for simplex tableaux (spec §6.3, §9.2).
 *
 * `candidates()` returns every column with a negative reduced cost as an entering candidate and every row
 * with a positive pivot-column entry as a leaving candidate. `verify*()` diagnoses the specific
 * misconception behind a wrong choice instead of just saying "wrong".
 */

import { Rational } from '../../math/rational';
import { MNum } from '../../math/bigm';
import { Tableau } from '../../types/models';
import { Candidate, TutorFeedback } from '../../types/tutor';
import { joinList } from '../../format';

/** z-row entry as an a + bM number. */
export function zEntry(t: Tableau, j: number): MNum {
  return new MNum(t.objectiveRow[j]!, t.bigMRow ? t.bigMRow[j]! : Rational.ZERO);
}

export type TutorStage = 'entering' | 'leaving' | 'done' | 'dual-leaving' | 'dual-entering' | 'unbounded' | 'infeasible';

export function isDualTableau(t: Tableau): boolean {
  return t.method === 'dual';
}

/** What decision is the student being asked to make from this tableau? */
export function currentStage(t: Tableau): TutorStage {
  if (isDualTableau(t)) {
    return t.rhs.some(v => v.isNegative()) ? 'dual-leaving' : 'done';
  }
  const anyNeg = t.objectiveRow.some((_, j) => t.columnTypes[j] !== 'artificial' && zEntry(t, j).isNegative());
  return anyNeg ? 'entering' : 'done';
}

/** Names with an inline sign for explanations. */
const nm = (t: Tableau, j: number) => t.columnNames[j]!;

export function enteringCandidates(t: Tableau): Candidate[] {
  let best: MNum | null = null;
  for (let j = 0; j < t.columnNames.length; j++) {
    if (t.columnTypes[j] === 'artificial') continue;
    const v = zEntry(t, j);
    if (v.isNegative() && (best === null || v.lt(best))) best = v;
  }
  const out: Candidate[] = [];
  for (let j = 0; j < t.columnNames.length; j++) {
    if (t.columnTypes[j] === 'artificial') continue;
    const v = zEntry(t, j);
    if (!v.isNegative()) continue;
    const isBest = best !== null && v.eq(best);
    out.push({
      id: `enter:${j}`,
      label: `Enter ${nm(t, j)}`,
      target: `col:${j}`,
      isCorrect: isBest,
      rationale: isBest
        ? `${nm(t, j)} has the most negative reduced cost (${v.toString()}), so it is the Dantzig choice.`
        : `${nm(t, j)} has a negative reduced cost (${v.toString()}) so it would improve the objective, but another column is more negative.`,
    });
  }
  return out;
}

export function ratiosFor(t: Tableau, col: number): (Rational | null)[] {
  return t.matrix.map((row, i) => {
    const a = row[col]!;
    return a.isPositive() ? t.rhs[i]!.div(a) : null;
  });
}

export function leavingCandidates(t: Tableau, enteringCol: number): Candidate[] {
  const ratios = ratiosFor(t, enteringCol);
  let min: Rational | null = null;
  ratios.forEach(r => { if (r && (min === null || r.lt(min))) min = r; });
  const out: Candidate[] = [];
  ratios.forEach((r, i) => {
    if (!r) return;
    const isMin = min !== null && r.eq(min);
    const basicName = nm(t, t.basis[i]!);
    out.push({
      id: `leave:${i}`,
      label: `Leave ${basicName}`,
      target: `row:${i}`,
      isCorrect: isMin,
      rationale: isMin
        ? `${basicName}: ratio ${t.rhs[i]!.toString()} ÷ ${t.matrix[i]![enteringCol]!.toString()} = ${r.toString()} is the minimum.`
        : `${basicName}: ratio ${r.toString()} is larger than the minimum ${min!.toString()}; stepping that far would make another basic variable negative.`,
    });
  });
  return out;
}

export function verifyEntering(t: Tableau, col: number): TutorFeedback {
  const correct = enteringCandidates(t).filter(c => c.isCorrect).map(c => Number(c.id.split(':')[1]));
  const name = nm(t, col);
  if (t.basis.includes(col)) {
    return {
      correct: false,
      message: `${name} is already basic (it labels a row of the tableau), so it cannot enter again.`,
      misconception: 'Only non-basic variables are candidates to enter the basis.',
      reveal: `Look for a negative number in the z-row among the non-basic columns — ${joinList(correct.map(j => `${nm(t, j)} (${zEntry(t, j).toString()})`))}.`,
    };
  }
  if (t.columnTypes[col] === 'artificial') {
    return {
      correct: false,
      message: `${name} is an artificial variable. Artificial variables are only a starting device and never re-enter the basis once they have left.`,
      misconception: 'Artificial columns are excluded from the entering-variable choice.',
    };
  }
  const v = zEntry(t, col);
  if (!v.isNegative()) {
    const kind = v.isZero() ? 'zero' : 'positive';
    return {
      correct: false,
      message: `You selected ${name}, whose reduced cost is ${v.toString()}. A ${kind} reduced cost means bringing ${name} into the basis would ${v.isZero() ? 'not change' : '*decrease*'} the objective. Look for the most negative value in the z-row.`,
      misconception: t.objectiveSense === 'min'
        ? 'In this tableau the z-row holds the maximisation form (−z), so only NEGATIVE entries are improving, even though the original problem is a minimisation.'
        : 'Only negative z-row entries are improving in a maximisation tableau (z_j − c_j < 0).',
      reveal: `Correct choice: ${joinList(correct.map(j => nm(t, j)))}.`,
    };
  }
  if (!correct.includes(col)) {
    return {
      correct: false,
      message: `${name} (${v.toString()}) does improve the objective, but Dantzig's rule picks the MOST negative reduced cost: ${joinList(correct.map(j => `${nm(t, j)} (${zEntry(t, j).toString()})`))}.`,
      misconception: 'Any negative reduced cost leads eventually to the optimum, but this tool follows the most-negative (steepest coefficient) rule.',
      reveal: `Correct choice: ${joinList(correct.map(j => nm(t, j)))}.`,
    };
  }
  return { correct: true, message: `Correct — ${name} has the most negative reduced cost (${v.toString()}).` };
}

export function verifyLeaving(t: Tableau, enteringCol: number, row: number): TutorFeedback {
  const ratios = ratiosFor(t, enteringCol);
  const cand = leavingCandidates(t, enteringCol);
  const correctRows = cand.filter(c => c.isCorrect).map(c => Number(c.id.split(':')[1]));
  const basicName = nm(t, t.basis[row]!);
  const a = t.matrix[row]![enteringCol]!;
  if (!a.isPositive()) {
    return {
      correct: false,
      message: `You chose the row of ${basicName}, but its entry in the ${nm(t, enteringCol)} column is ${a.toString()} (${a.isZero() ? 'zero' : 'negative'}). A ratio is only computed for POSITIVE entries; a ${a.isZero() ? 'zero' : 'negative'} entry never limits how far ${nm(t, enteringCol)} can grow.`,
      misconception: 'The ratio test ignores rows whose pivot-column entry is zero or negative.',
      reveal: `Eligible rows: ${joinList(cand.map(c => c.label.replace('Leave ', '')))}; the minimum ratio is in ${joinList(correctRows.map(i => nm(t, t.basis[i]!)))}.`,
    };
  }
  if (!correctRows.includes(row)) {
    const min = ratios[correctRows[0]!]!;
    return {
      correct: false,
      message: `The ratio for ${basicName} is ${ratios[row]!.toString()}, but the smallest ratio is ${min.toString()} (${joinList(correctRows.map(i => nm(t, t.basis[i]!)))}). If ${nm(t, enteringCol)} grew to ${ratios[row]!.toString()}, the variable with the smaller ratio would become negative and the solution infeasible.`,
      misconception: 'The leaving variable is the one with the MINIMUM ratio, not the maximum or the first positive entry.',
      reveal: `Correct choice: ${joinList(correctRows.map(i => nm(t, t.basis[i]!)))}.`,
    };
  }
  return { correct: true, message: `Correct — ${basicName} has the minimum ratio ${ratios[row]!.toString()}.` };
}

/* ---------------- dual simplex tutoring ---------------- */

export function dualLeavingCandidates(t: Tableau): Candidate[] {
  let worst: Rational | null = null;
  t.rhs.forEach(v => { if (v.isNegative() && (worst === null || v.lt(worst))) worst = v; });
  const out: Candidate[] = [];
  t.rhs.forEach((v, i) => {
    if (!v.isNegative()) return;
    const isBest = worst !== null && v.eq(worst);
    out.push({
      id: `leave:${i}`,
      label: `Leave ${nm(t, t.basis[i]!)}`,
      target: `row:${i}`,
      isCorrect: isBest,
      rationale: isBest ? `Most negative RHS (${v.toString()}).` : `RHS ${v.toString()} is negative but not the most negative.`,
    });
  });
  return out;
}

export function dualEnteringCandidates(t: Tableau, row: number): Candidate[] {
  let min: Rational | null = null;
  const ratios: (Rational | null)[] = t.columnNames.map((_, j) => {
    const a = t.matrix[row]![j]!;
    if (!a.isNegative() || t.columnTypes[j] === 'artificial' || t.basis.includes(j)) return null;
    return t.objectiveRow[j]!.abs().div(a.abs());
  });
  ratios.forEach(r => { if (r && (min === null || r.lt(min))) min = r; });
  const out: Candidate[] = [];
  ratios.forEach((r, j) => {
    if (!r) return;
    const best = min !== null && r.eq(min);
    out.push({
      id: `enter:${j}`,
      label: `Enter ${nm(t, j)}`,
      target: `col:${j}`,
      isCorrect: best,
      rationale: `|zⱼ ÷ aᵣⱼ| = ${r.toString()}${best ? ' (minimum)' : ''}.`,
    });
  });
  return out;
}

export function verifyDualLeaving(t: Tableau, row: number): TutorFeedback {
  const c = dualLeavingCandidates(t);
  const good = c.filter(x => x.isCorrect).map(x => Number(x.id.split(':')[1]));
  const v = t.rhs[row]!;
  if (!v.isNegative()) {
    return {
      correct: false,
      message: `${nm(t, t.basis[row]!)} has RHS ${v.toString()} ≥ 0 and is already feasible. The dual simplex method removes a variable whose value is NEGATIVE.`,
      misconception: 'In the dual simplex the leaving variable is chosen first, from the most negative right-hand side.',
      reveal: `Correct row: ${joinList(good.map(i => nm(t, t.basis[i]!)))}.`,
    };
  }
  if (!good.includes(row)) {
    return {
      correct: false,
      message: `RHS ${v.toString()} is negative, but the most negative RHS is in the row of ${joinList(good.map(i => nm(t, t.basis[i]!)))}.`,
      misconception: 'Pick the MOST negative right-hand side to leave first.',
      reveal: `Correct row: ${joinList(good.map(i => nm(t, t.basis[i]!)))}.`,
    };
  }
  return { correct: true, message: `Correct — ${nm(t, t.basis[row]!)} = ${v.toString()} is the most negative RHS.` };
}

export function verifyDualEntering(t: Tableau, row: number, col: number): TutorFeedback {
  const c = dualEnteringCandidates(t, row);
  const good = c.filter(x => x.isCorrect).map(x => Number(x.id.split(':')[1]));
  const a = t.matrix[row]![col]!;
  if (!a.isNegative()) {
    return {
      correct: false,
      message: `${nm(t, col)} has entry ${a.toString()} in the pivot row. In the dual simplex only columns with a NEGATIVE entry in the leaving row can enter — otherwise the row stays infeasible.`,
      misconception: 'Dual ratio test uses negative entries only (opposite of the primal ratio test).',
      reveal: `Correct column: ${joinList(good.map(j => nm(t, j)))}.`,
    };
  }
  if (!good.includes(col)) {
    return {
      correct: false,
      message: `${nm(t, col)} is eligible but does not minimise |zⱼ ÷ aᵣⱼ|; choosing it would make some z-row entry negative (losing dual feasibility).`,
      misconception: 'Choose the minimum ratio of |z-row entry| to |pivot-row entry|.',
      reveal: `Correct column: ${joinList(good.map(j => nm(t, j)))}.`,
    };
  }
  return { correct: true, message: `Correct — ${nm(t, col)} gives the minimum dual ratio.` };
}
