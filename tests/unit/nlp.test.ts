import { describe, it, expect } from 'vitest';
import { minimiseUnconstrained, checkKKT, solveQP, parseExpression, diff, evalExpr } from '../../src/core/solvers/nlp/nlp';
import { Rational } from '../../src/core/math/rational';

const R = (x: string) => Rational.parse(x);

describe('NLP', () => {
  it('symbolic derivatives are exact', () => {
    const e = parseExpression('x1^3 + 2*x1*x2 + exp(x2)', ['x1', 'x2']);
    expect(evalExpr(diff(e, 0), [2, 1])).toBeCloseTo(3 * 4 + 2, 10);
    expect(evalExpr(diff(e, 1), [2, 0])).toBeCloseTo(4 + 1, 10);
  });
  it('Newton solves a quadratic in one step', () => {
    const r = minimiseUnconstrained({ expression: '(x1-3)^2 + 2*(x2+1)^2', start: [0, 0], method: 'newton' });
    expect(r.converged).toBe(true);
    expect(r.x[0]).toBeCloseTo(3, 6); expect(r.x[1]).toBeCloseTo(-1, 6);
    expect(r.classification).toBe('minimum');
    expect(r.iterations).toBeLessThanOrEqual(2);
  });
  it('gradient descent converges on Rosenbrock-like bowl', () => {
    const r = minimiseUnconstrained({ expression: 'x1^2 + 5*x2^2 + x1*x2', start: [4, 3], method: 'gradient', maxIterations: 2000 });
    expect(r.converged).toBe(true);
    expect(r.f).toBeCloseTo(0, 6);
  });
  it('detects a saddle point', () => {
    const r = minimiseUnconstrained({ expression: 'x1^2 - x2^2', start: [0, 0], method: 'newton' });
    expect(r.classification).toBe('saddle');
  });
  it('KKT at the true optimum passes and at a wrong point fails', () => {
    const base = { objective: '(x1-2)^2 + (x2-2)^2', constraints: [{ expr: 'x1 + x2 - 2', kind: 'le' as const }] };
    expect(checkKKT({ ...base, point: [1, 1] }).satisfied).toBe(true);
    expect(checkKKT({ ...base, point: [0.5, 0.5] }).satisfied).toBe(false);
    expect(checkKKT({ ...base, point: [2, 2] }).feasible).toBe(false);
  });
  it('exact QP: min (x−2)²+(y−2)² s.t. x+y ≤ 2', () => {
    // ½xᵀQx + cᵀx with Q=2I, c=(−4,−4)
    const r = solveQP({ Q: [[R('2'), R('0')], [R('0'), R('2')]], c: [R('-4'), R('-4')], A: [[R('1'), R('1')]], b: [R('2')] });
    expect(r.x.map(String)).toEqual(['1', '1']);
    expect(r.objective.toString()).toBe('-6');
    expect(r.convex).toBe(true);
  });
});
