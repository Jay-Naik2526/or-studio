import { describe, it, expect } from 'vitest';
import { solveLP } from '../../src/core/solvers/lp/engine';
import { SensitivityAnalyzer } from '../../src/core/solvers/lp/sensitivity';
import { AlgebraicParser } from '../../src/core/parse/algebraic';
import { Rational } from '../../src/core/math/rational';
import { randomLP, rng } from '../helpers/bruteLP';

const parse = (t: string) => AlgebraicParser.parse(t).model!;
const R = (s: string | number) => Rational.parse(String(s));

describe('Sensitivity analysis', () => {
  it('matches the textbook ranges for the Reddy-Mikks-style problem', () => {
    const m = parse('max 3x1 + 5x2\nst\n x1 <= 4\n 2x2 <= 12\n 3x1 + 2x2 <= 18');
    const sol = solveLP(m);
    const rep = SensitivityAnalyzer.analyze(m, sol.result!);
    expect(rep.valid).toBe(true);
    expect(rep.shadowPrices.map(s => s.shadowPrice.toString())).toEqual(['0', '3/2', '1']);
    // RHS ranges
    expect(rep.rhsRanging[0]!.range.min!.toString()).toBe('2');
    expect(rep.rhsRanging[0]!.range.max).toBeNull();
    expect(rep.rhsRanging[1]!.range.min!.toString()).toBe('6');
    expect(rep.rhsRanging[1]!.range.max!.toString()).toBe('18');
    expect(rep.rhsRanging[2]!.range.min!.toString()).toBe('12');
    expect(rep.rhsRanging[2]!.range.max!.toString()).toBe('24');
    // Cost ranges: c1 ∈ [0, 15/2], c2 ∈ [2, ∞)
    expect(rep.objectiveRanging[0]!.range.min!.toString()).toBe('0');
    expect(rep.objectiveRanging[0]!.range.max!.toString()).toBe('15/2');
    expect(rep.objectiveRanging[1]!.range.min!.toString()).toBe('2');
    expect(rep.objectiveRanging[1]!.range.max).toBeNull();
  });

  it('is self-consistent on random optimal LPs (RHS and cost ranging are exact)', () => {
    const r = rng(99);
    let checked = 0;
    for (let t = 0; t < 300; t++) {
      const model = randomLP(r);
      const sol = solveLP(model);
      if (!sol.result || sol.status === 'unbounded' || sol.status === 'infeasible') continue;
      const rep = SensitivityAnalyzer.analyze(model, sol.result);
      expect(rep.valid).toBe(true);
      const z = sol.result.objectiveValue;
      rep.rhsRanging.forEach((rr, k) => {
        const y = sol.result!.dualValues[k]!;
        for (const end of [rr.range.min, rr.range.max]) {
          if (end === null) continue;
          const delta = end.sub(rr.range.current);
          const w = SensitivityAnalyzer.whatIf(model, { rhs: { [k]: end } }, sol);
          expect(w.solution.status === 'optimal' || w.solution.status === 'optimal-alternate-exists', `rhs end feasible`).toBe(true);
          expect(w.solution.result!.objectiveValue.eq(z.add(y.mul(delta))), `z linear in rhs ${k}`).toBe(true);
          checked++;
        }
      });
      rep.objectiveRanging.forEach((cr, j) => {
        if (!cr.available) return;
        const x = sol.result!.variableValues[j]!;
        for (const end of [cr.range.min, cr.range.max]) {
          if (end === null) continue;
          const delta = end.sub(cr.range.current);
          const w = SensitivityAnalyzer.whatIf(model, { cost: { [j]: end } }, sol);
          expect(w.solution.result!.objectiveValue.eq(z.add(x.mul(delta))), `z at cost end var ${j}`).toBe(true);
          checked++;
        }
      });
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('100% rule', () => {
    const rep = SensitivityAnalyzer.hundredPercentRule([
      { range: { current: R(10), min: R(6), max: R(14) }, delta: R(2) },
      { range: { current: R(3), min: R(1), max: R(5) }, delta: R(-1) },
    ]);
    expect(rep.sum.toString()).toBe('1');
    expect(rep.withinRule).toBe(true);
  });
});
