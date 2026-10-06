import { describe, it, expect } from 'vitest';
import { solveLP } from '../../src/core/solvers/lp/engine';
import { AlgebraicParser } from '../../src/core/parse/algebraic';
import { Rational } from '../../src/core/math/rational';
import { bruteVertices, feasible, objective, randomLP, rng } from '../helpers/bruteLP';

const parse = (t: string) => {
  const r = AlgebraicParser.parse(t);
  if (!r.success) throw new Error(JSON.stringify(r.error));
  return r.model!;
};

describe('LP engine — textbook cases', () => {
  it('Reddy Mikks style max, standard simplex', () => {
    const sol = solveLP(parse('max 3x1 + 5x2\nst\n x1 <= 4\n 2x2 <= 12\n 3x1 + 2x2 <= 18'), { method: 'standard' });
    expect(sol.status).toBe('optimal');
    expect(sol.methodUsed).toBe('standard');
    expect(sol.result!.objectiveValue.toString()).toBe('36');
    expect(sol.result!.variableValues.map(String)).toEqual(['2', '6']);
    // shadow prices 0, 3/2, 1
    expect(sol.result!.dualValues.map(String)).toEqual(['0', '3/2', '1']);
  });

  it('Two-phase min with ≥ and =', () => {
    const m = parse('min 0.4x1 + 0.5x2\nst\n 0.3x1 + 0.1x2 <= 2.7\n 0.5x1 + 0.5x2 = 6\n 0.6x1 + 0.4x2 >= 6');
    for (const method of ['twoPhase', 'bigM'] as const) {
      const sol = solveLP(m, { method });
      expect(sol.status).toBe('optimal');
      expect(sol.result!.objectiveValue.toString()).toBe('21/4');
      expect(sol.result!.variableValues.map(String)).toEqual(['15/2', '9/2']);
    }
  });

  it('detects unbounded with a ray', () => {
    const sol = solveLP(parse('max 2x1 + x2\nst\n x1 - x2 <= 10'));
    expect(sol.status).toBe('unbounded');
    expect(sol.result!.unboundedRay).toBeDefined();
  });

  it('detects infeasible and names the conflict', () => {
    const sol = solveLP(parse('max x1 + x2\nst\n x1 + x2 <= 2\n x1 + x2 >= 5'));
    expect(sol.status).toBe('infeasible');
    expect(sol.diagnostics.some(d => d.code === 'INFEASIBLE')).toBe(true);
  });

  it('negative RHS on ≤ is normalised, not mis-solved', () => {
    const m = parse('max x1 + x2\nst\n -x1 - x2 <= -2\n x1 <= 5\n x2 <= 5');
    const sol = solveLP(m);
    expect(sol.status).toBe('optimal');
    expect(sol.result!.objectiveValue.toString()).toBe('10');
  });

  it('degenerate cycling example (Beale) terminates optimally', () => {
    const m = parse(`max 0.75x1 - 20x2 + 0.5x3 - 6x4
st
 0.25x1 - 8x2 - x3 + 9x4 <= 0
 0.5x1 - 12x2 - 0.5x3 + 3x4 <= 0
 x3 <= 1`);
    const sol = solveLP(m, { method: 'standard' });
    expect(sol.status).toBe('optimal');
    expect(sol.result!.objectiveValue.toString()).toBe('5/4');
  });

  it('alternate optima are reported with a second vertex', () => {
    const sol = solveLP(parse('max 2x1 + 4x2\nst\n x1 + 2x2 <= 5\n x1 + x2 <= 4'));
    expect(sol.status).toBe('optimal-alternate-exists');
    expect(sol.result!.alternateOptimum).toBeDefined();
  });

  it('dual simplex solves a min problem with ≥ rows', () => {
    const m = parse('min 3x1 + 2x2\nst\n 3x1 + x2 >= 3\n 4x1 + 3x2 >= 6\n x1 + x2 <= 3');
    const sol = solveLP(m, { method: 'dual' });
    expect(sol.methodUsed).toBe('dual');
    expect(sol.status).toBe('optimal');
    expect(sol.result!.objectiveValue.toString()).toBe('21/5');
  });
});

describe('LP engine — randomised cross-check against vertex enumeration', () => {
  it('agrees on status, optimum, feasibility, duality across 400 random LPs and all methods', () => {
    const r = rng(20260922);
    let optimal = 0, infeasible = 0, unbounded = 0;
    for (let t = 0; t < 400; t++) {
      const model = randomLP(r);
      const brute = bruteVertices(model);
      const methods = ['auto', 'twoPhase', 'bigM'] as const;
      let ref: string | null = null;
      for (const method of methods) {
        const sol = solveLP(model, { method });
        const tag = JSON.stringify(model, (_k, v) => (v instanceof Rational ? v.toString() : v));
        if (brute.feasibleVertices.length === 0) {
          expect(sol.status, `infeasible expected ${tag}`).toBe('infeasible');
        } else if (sol.status === 'unbounded') {
          const ray = sol.result!.unboundedRay!;
          // Moving far along the ray stays feasible and improves the objective.
          const x0 = sol.result!.variableValues;
          const far = x0.map((v, j) => v.add(ray.direction[j]!.mul(Rational.of(1000))));
          expect(feasible(model, far), `ray feasible ${tag}`).toBe(true);
          const better = model.sense === 'max'
            ? objective(model, far).gt(objective(model, x0))
            : objective(model, far).lt(objective(model, x0));
          expect(better, `ray improves ${tag}`).toBe(true);
          // no vertex attains the value far along the ray
          if (brute.best) {
            const farZ = objective(model, far);
            expect(model.sense === 'max' ? farZ.gt(brute.best) : farZ.lt(brute.best)).toBe(true);
          }
        } else {
          expect(['optimal', 'optimal-alternate-exists'], `optimal expected ${tag} got ${sol.status}`).toContain(sol.status);
          const res = sol.result!;
          expect(feasible(model, res.variableValues), `feasible ${tag}`).toBe(true);
          expect(objective(model, res.variableValues).eq(res.objectiveValue)).toBe(true);
          expect(res.objectiveValue.eq(brute.best!), `opt ${tag}: ${res.objectiveValue} vs ${brute.best}`).toBe(true);
          // Strong duality: Σ y_i b_i = z (no constant / bounds in these models)
          let dualObj = Rational.ZERO;
          model.constraints.forEach((c, i) => { dualObj = dualObj.add(res.dualValues[i]!.mul(c.rhs)); });
          expect(dualObj.eq(res.objectiveValue), `duality ${tag}: ${dualObj} vs ${res.objectiveValue} (${method})`).toBe(true);
        }
        const key = sol.status === 'optimal-alternate-exists' ? 'optimal' : sol.status;
        const key2 = key + (sol.result && key === 'optimal' ? ':' + sol.result.objectiveValue.toString() : '');
        if (ref === null) ref = key2; else expect(key2, `methods agree ${tag}`).toBe(ref);
        if (method === 'auto') {
          if (key === 'optimal') optimal++; else if (key === 'infeasible') infeasible++; else unbounded++;
        }
      }
    }
    expect(optimal).toBeGreaterThan(50);
    expect(infeasible).toBeGreaterThan(10);
    expect(unbounded).toBeGreaterThan(5);
  });
});

describe('LP engine — dual simplex & variable bounds', () => {
  it('dual simplex agrees with two-phase on dual-feasible random models', () => {
    const r = rng(777);
    let used = 0;
    for (let t = 0; t < 500; t++) {
      const model = randomLP(r);
      model.sense = 'min';
      model.objective = model.objective.map(c => c.abs());
      const a = solveLP(model, { method: 'dual' });
      const b = solveLP(model, { method: 'twoPhase' });
      if (a.methodUsed === 'dual') used++;
      expect(a.status).toBe(b.status);
      if (b.result && b.status !== 'unbounded') expect(a.result!.objectiveValue.eq(b.result.objectiveValue)).toBe(true);
    }
    expect(used).toBeGreaterThan(300);
  });

  it('free, shifted and bounded variables match an explicit-constraint formulation', () => {
    const r = rng(4242);
    for (let t = 0; t < 200; t++) {
      const base = randomLP(r);
      const n = base.objective.length;
      const lo = Array.from({ length: n }, () => Rational.of(Math.floor(r() * 4) - 1));
      const up = Array.from({ length: n }, () => (r() < 0.5 ? null : Rational.of(Math.floor(r() * 5) + 3)));
      const withBounds = { ...base, varBounds: lo.map((l, j) => ({ lower: l, upper: up[j]! })) };
      // Explicit formulation in shifted variables y = x − lo
      const cons = base.constraints.map(c => {
        let rhs = c.rhs;
        c.coeffs.forEach((a, j) => { rhs = rhs.sub(a.mul(lo[j]!)); });
        return { ...c, rhs };
      });
      up.forEach((u, j) => {
        if (u) cons.push({ coeffs: Array.from({ length: n }, (_, k) => (k === j ? Rational.ONE : Rational.ZERO)), relation: '<=', rhs: u.sub(lo[j]!) });
      });
      let constant = Rational.ZERO;
      base.objective.forEach((c, j) => { constant = constant.add(c.mul(lo[j]!)); });
      const explicit = { ...base, constraints: cons, objectiveConstant: constant };
      const a = solveLP(withBounds);
      const b = solveLP(explicit);
      expect(a.status).toBe(b.status);
      if (a.result && a.status !== 'unbounded') {
        expect(a.result.objectiveValue.eq(b.result!.objectiveValue)).toBe(true);
        a.result.variableValues.forEach((v, j) => {
          expect(v.gte(lo[j]!)).toBe(true);
          if (up[j]) expect(v.lte(up[j]!)).toBe(true);
        });
      }
    }
  });

  it('truly free variables', () => {
    const m = parse('min x1\nst\n x1 + x2 >= -3\n x2 <= 5');
    m.varBounds = [{ lower: null, upper: null }, { lower: Rational.ZERO, upper: null }];
    const sol = solveLP(m);
    expect(sol.status).toBe('optimal');
    expect(sol.result!.objectiveValue.toString()).toBe('-8');
    expect(sol.standardForm!.notes.join(' ')).toContain('unrestricted');
  });
});
