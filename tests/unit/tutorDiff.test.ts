import { describe, it, expect } from 'vitest';
import { solveLP } from '../../src/core/solvers/lp/engine';
import { AlgebraicParser } from '../../src/core/parse/algebraic';
import { enteringCandidates, leavingCandidates, verifyEntering, verifyLeaving, currentStage } from '../../src/core/solvers/lp/tutor';
import { DiffComparator } from '../../src/core/diff/comparator';
import { Rational } from '../../src/core/math/rational';
import { Tableau } from '../../src/core/types/models';

const m = AlgebraicParser.parse('max 3x1 + 5x2\nst\n x1 <= 4\n 2x2 <= 12\n 3x1 + 2x2 <= 18').model!;
const sol = solveLP(m);

describe('tutor', () => {
  const t0 = sol.steps[0]!.state;
  it('enumerates negative reduced costs and flags the most negative', () => {
    const c = enteringCandidates(t0);
    expect(c.map(x => x.label)).toEqual(['Enter x₁', 'Enter x₂']);
    expect(c.find(x => x.isCorrect)!.label).toBe('Enter x₂');
    expect(currentStage(t0)).toBe('entering');
  });
  it('diagnoses a positive reduced cost, a non-minimum ratio and a non-positive entry', () => {
    expect(verifyEntering(t0, 2).message).toMatch(/already basic/);
    expect(verifyEntering(t0, 0).correct).toBe(false);
    expect(verifyEntering(t0, 1).correct).toBe(true);
    expect(leavingCandidates(t0, 1).filter(c => c.isCorrect)).toHaveLength(1);
    expect(verifyLeaving(t0, 1, 0).message).toMatch(/POSITIVE|zero/i);
    expect(verifyLeaving(t0, 1, 2).correct).toBe(false);
    expect(verifyLeaving(t0, 1, 1).correct).toBe(true);
  });
});

describe('diff mode', () => {
  const clone = (t: Tableau): Tableau => ({ ...t, matrix: t.matrix.map(r => [...r]), objectiveRow: [...t.objectiveRow], rhs: [...t.rhs] });
  it('matches an exact copy', () => {
    expect(DiffComparator.compareTableau(clone(sol.steps[1]!.state), sol.steps, { iteration: 1 }).matches).toBe(true);
  });
  it('spots a wrong leaving variable', () => {
    // pivot on x2 in row 3 instead of row 2
    const t = clone(sol.steps[0]!.state);
    const p = t.matrix[2]![1]!;
    t.matrix[2] = t.matrix[2]!.map(v => v.div(p)); t.rhs[2] = t.rhs[2]!.div(p);
    for (let i = 0; i < 2; i++) { const f = t.matrix[i]![1]!; t.matrix[i] = t.matrix[i]!.map((v, k) => v.sub(f.mul(t.matrix[2]![k]!))); t.rhs[i] = t.rhs[i]!.sub(f.mul(t.rhs[2]!)); }
    const f = t.objectiveRow[1]!; t.objectiveRow = t.objectiveRow.map((v, k) => v.sub(f.mul(t.matrix[2]![k]!))); t.objectiveValue = t.objectiveValue.sub(f.mul(t.rhs[2]!));
    const d = DiffComparator.compareTableau(t, sol.steps, { iteration: 1 });
    expect(d.matches).toBe(false);
    expect(d.summary).toMatch(/wrong leaving variable/);
  });
  it('spots an un-normalised pivot row, inverted z-row sign and single slips', () => {
    const t = clone(sol.steps[1]!.state);
    t.matrix[1] = t.matrix[1]!.map(v => v.mul(Rational.of(2))); t.rhs[1] = t.rhs[1]!.mul(Rational.of(2));
    expect(DiffComparator.compareTableau(t, sol.steps, { iteration: 1 }).summary).toMatch(/2×|scal|normali/i);
    const z = clone(sol.steps[1]!.state); z.objectiveRow = z.objectiveRow.map(v => v.neg()); z.objectiveValue = z.objectiveValue.neg();
    expect(DiffComparator.compareTableau(z, sol.steps, { iteration: 1 }).summary).toMatch(/opposite sign/);
    const s = clone(sol.steps[1]!.state); s.matrix[0]![0] = s.matrix[0]![0]!.add(Rational.ONE);
    expect(DiffComparator.compareTableau(s, sol.steps, { iteration: 1 }).summary).toMatch(/single entry/);
  });
});
