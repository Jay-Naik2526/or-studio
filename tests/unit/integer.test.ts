import { describe, it, expect } from 'vitest';
import { BranchBoundSolver } from '../../src/core/solvers/integer/branchBound';
import { solveGomory } from '../../src/core/solvers/integer/gomory';
import { AlgebraicParser } from '../../src/core/parse/algebraic';
import { Rational } from '../../src/core/math/rational';
import { LPModel } from '../../src/core/types/models';
import { feasible, objective, randInt, rng } from '../helpers/bruteLP';

const parse = (t: string) => AlgebraicParser.parse(t).model!;

function bruteInteger(model: LPModel, U: number): { best: Rational | null } {
  const n = model.objective.length;
  let best: Rational | null = null;
  const x: number[] = Array(n).fill(0);
  const rec = (k: number) => {
    if (k === n) {
      const xr = x.map(v => Rational.of(v));
      if (!feasible(model, xr)) return;
      const z = objective(model, xr);
      if (best === null || (model.sense === 'max' ? z.gt(best) : z.lt(best))) best = z;
      return;
    }
    for (let v = 0; v <= U; v++) { x[k] = v; rec(k + 1); }
  };
  rec(0);
  return { best };
}

describe('Branch & bound', () => {
  it('Taha example 5x1+4x2: LP 21, integer optimum 20', () => {
    const m = parse('max 5x1 + 4x2\nst\n 6x1 + 4x2 <= 24\n x1 + 2x2 <= 6\n int x1, x2');
    const sol = new BranchBoundSolver().solve(m);
    expect(sol.status).toBe('optimal');
    expect(sol.result!.objectiveValue.toString()).toBe('20');
    expect(sol.result!.rootBound!.toString()).toBe('21');
  });

  it('relaxation already integral stops at the root', () => {
    const m = parse('max x1 + x2\nst\n x1 <= 3\n x2 <= 4\n int x1, x2');
    const sol = new BranchBoundSolver().solve(m);
    expect(sol.result!.treeState.nodes).toHaveLength(1);
    expect(sol.diagnostics.some(d => d.code === 'RELAXATION_INTEGRAL')).toBe(true);
  });

  it('integer-infeasible problem is reported', () => {
    const m = parse('max x1\nst\n 2x1 = 3\n int x1');
    const sol = new BranchBoundSolver().solve(m);
    expect(sol.status).toBe('infeasible');
    expect(sol.diagnostics.some(d => d.code === 'INTEGER_INFEASIBLE')).toBe(true);
  });

  it('unbounded relaxation is flagged', () => {
    const m = parse('max x1 + x2\nst\n x1 - x2 <= 2\n int x1, x2');
    expect(new BranchBoundSolver().solve(m).status).toBe('unbounded');
  });

  it('agrees with brute force on random ILPs under all node-selection strategies', () => {
    const r = rng(31337);
    for (let t = 0; t < 120; t++) {
      const n = randInt(r, 1, 3);
      const m = randInt(r, 1, 3);
      const model: LPModel = {
        sense: r() < 0.7 ? 'max' : 'min',
        objective: Array.from({ length: n }, () => Rational.of(randInt(r, -3, 6))),
        constraints: Array.from({ length: m }, () => ({
          coeffs: Array.from({ length: n }, () => Rational.of(randInt(r, 0, 5))),
          relation: (['<=', '<=', '>='] as const)[randInt(r, 0, 2)]!,
          rhs: Rational.of(randInt(r, 1, 18)),
        })),
        varNames: Array.from({ length: n }, (_, j) => `x${j + 1}`),
        varBounds: Array.from({ length: n }, () => ({ lower: Rational.ZERO, upper: Rational.of(6) })),
        integrality: Array(n).fill('integer') as LPModel['integrality'],
      };
      const brute = bruteInteger(model, 6);
      for (const strat of ['bestBound', 'depthFirst', 'breadthFirst'] as const) {
        const sol = new BranchBoundSolver().solve(model, { variant: strat, maxNodes: 5000 });
        if (brute.best === null) expect(sol.status).toBe('infeasible');
        else {
          expect(sol.status, JSON.stringify(model.constraints.map(c => c.coeffs.map(String)))).toBe('optimal');
          expect(sol.result!.objectiveValue.eq(brute.best)).toBe(true);
        }
      }
    }
  });

  it('mixed-integer and binary variables', () => {
    const m = parse('max 3x + 2y + 4z\nst\n 2x + y + 3z <= 6\n x + 2y + z <= 5\n int x\n bin z');
    const sol = new BranchBoundSolver().solve(m);
    expect(sol.status).toBe('optimal');
    const [x, , z] = sol.result!.variableValues;
    expect(x!.isInteger()).toBe(true);
    expect(z!.eq(Rational.ZERO) || z!.eq(Rational.ONE)).toBe(true);
  });

  it('node limit yields a warning and an incomplete (not optimal) status', () => {
    const m = parse('max 5x1 + 4x2\nst\n 6x1 + 4x2 <= 24\n x1 + 2x2 <= 6\n int x1, x2');
    const sol = new BranchBoundSolver().solve(m, { maxNodes: 3 });
    expect(sol.status).toBe('iteration-limit');
    expect(sol.diagnostics.some(d => d.code === 'NODE_LIMIT')).toBe(true);
  });
});

describe('Gomory cuts', () => {
  it('pure integer example converges to the integer optimum', () => {
    const m = parse('max 5x1 + 4x2\nst\n 6x1 + 4x2 <= 24\n x1 + 2x2 <= 6\n int x1, x2');
    const sol = solveGomory(m);
    expect(sol.status).toBe('optimal');
    expect(sol.result!.objectiveValue.toString()).toBe('20');
    expect(sol.result!.cuts.length).toBeGreaterThan(0);
    expect(sol.result!.cuts[0]!.kind).toBe('fractional');
  });

  it('agrees with brute force on random pure-integer problems (or reports non-convergence honestly)', () => {
    const r = rng(2718);
    let converged = 0;
    for (let t = 0; t < 80; t++) {
      const n = randInt(r, 1, 3);
      const m = randInt(r, 1, 3);
      const model: LPModel = {
        sense: 'max',
        objective: Array.from({ length: n }, () => Rational.of(randInt(r, 1, 6))),
        constraints: Array.from({ length: m }, () => ({
          coeffs: Array.from({ length: n }, () => Rational.of(randInt(r, 1, 5))),
          relation: '<=' as const,
          rhs: Rational.of(randInt(r, 3, 18)),
        })),
        varNames: Array.from({ length: n }, (_, j) => `x${j + 1}`),
        varBounds: Array.from({ length: n }, () => ({ lower: Rational.ZERO, upper: Rational.of(8) })),
        integrality: Array(n).fill('integer') as LPModel['integrality'],
      };
      const brute = bruteInteger(model, 8);
      const sol = solveGomory(model, { maxCuts: 60 });
      // every generated cut must be satisfied by every integer-feasible point (validity)
      const pts: Rational[][] = [];
      const xs: number[] = Array(n).fill(0);
      const rec = (k: number) => {
        if (k === n) { const xr = xs.map(v => Rational.of(v)); if (feasible(model, xr)) pts.push(xr); return; }
        for (let v = 0; v <= 8; v++) { xs[k] = v; rec(k + 1); }
      };
      rec(0);
      let invalid = '';
      for (const cut of sol.result?.cuts ?? []) {
        for (const p of pts) {
          let lhs = Rational.ZERO;
          cut.inX!.coeffs.forEach((c, j) => { lhs = lhs.add(c.mul(p[j]!)); });
          if (lhs.gt(cut.inX!.rhs)) invalid = `cut ${cut.index} violated at ${p.map(String)}`;
        }
      }
      expect(invalid).toBe('');
      if (sol.status === 'optimal') {
        converged++;
        expect(sol.result!.objectiveValue.eq(brute.best!), 'gomory value').toBe(true);
      } else {
        expect(sol.status).toBe('iteration-limit');
      }
    }
    expect(converged).toBeGreaterThan(40);
  });

  it('mixed-integer cut handles continuous variables', () => {
    const m = parse('max 2x + 3y\nst\n 2x + 4y <= 9\n 3x + y <= 7\n int x');
    const sol = solveGomory(m);
    expect(sol.status).toBe('optimal');
    expect(sol.result!.variableValues[0]!.isInteger()).toBe(true);
    const bb = new BranchBoundSolver().solve(m);
    expect(sol.result!.objectiveValue.eq(bb.result!.objectiveValue)).toBe(true);
  });
});
