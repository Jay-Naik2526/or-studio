import { describe, it, expect } from 'vitest';
import { TransportSolver, compareInitialMethods } from '../../src/core/solvers/transport/transport';
import { solveLP } from '../../src/core/solvers/lp/engine';
import { Rational } from '../../src/core/math/rational';
import { LPModel, TransportModel } from '../../src/core/types/models';
import { randInt, rng } from '../helpers/bruteLP';

const R = (n: number) => Rational.of(n);

function asLP(model: TransportModel): LPModel {
  const m = model.supply.length, n = model.demand.length;
  const ts = model.supply.reduce((a, b) => a.add(b), Rational.ZERO);
  const td = model.demand.reduce((a, b) => a.add(b), Rational.ZERO);
  const nv = m * n;
  const cons: LPModel['constraints'] = [];
  const unit = (idx: number[]) => Array.from({ length: nv }, (_, k) => (idx.includes(k) ? Rational.ONE : Rational.ZERO));
  for (let i = 0; i < m; i++) cons.push({ coeffs: unit(Array.from({ length: n }, (_, j) => i * n + j)), relation: ts.gt(td) ? '<=' : '=', rhs: model.supply[i]! });
  for (let j = 0; j < n; j++) cons.push({ coeffs: unit(Array.from({ length: m }, (_, i) => i * n + j)), relation: td.gt(ts) ? '<=' : '=', rhs: model.demand[j]! });
  // ts>td: supplies ≤, demands = ; td>ts: supplies =, demands ≤
  if (ts.gt(td)) cons.slice(m).forEach(c => (c.relation = '='));
  if (td.gt(ts)) cons.slice(0, m).forEach(c => (c.relation = '='));
  return { sense: 'min', objective: model.costs.flat(), constraints: cons, varNames: Array.from({ length: nv }, (_, k) => `x${k + 1}`) };
}

describe('Transportation', () => {
  const taha: TransportModel = {
    supply: [R(15), R(25), R(10)],
    demand: [R(5), R(15), R(15), R(15)],
    costs: [[R(10), R(2), R(20), R(11)], [R(12), R(7), R(9), R(20)], [R(4), R(14), R(16), R(18)]],
  };
  it('all three starts reach the same optimum', () => {
    const rows = compareInitialMethods(taha);
    expect(new Set(rows.map(r => r.finalCost.toString())).size).toBe(1);
    expect(rows.find(r => r.method === 'vam')!.initialCost.lte(rows.find(r => r.method === 'nwc')!.initialCost)).toBe(true);
  });

  it('matches LP optimum on 300 random balanced/unbalanced problems, any method', () => {
    const r = rng(555);
    for (let t = 0; t < 300; t++) {
      const m = randInt(r, 1, 4), n = randInt(r, 1, 4);
      const model: TransportModel = {
        supply: Array.from({ length: m }, () => R(randInt(r, 1, 20))),
        demand: Array.from({ length: n }, () => R(randInt(r, 1, 20))),
        costs: Array.from({ length: m }, () => Array.from({ length: n }, () => R(randInt(r, 1, 15)))),
      };
      if (r() < 0.5) { // balance exactly half the time
        const ts = model.supply.reduce((a, b) => a.add(b), Rational.ZERO);
        const td = model.demand.reduce((a, b) => a.add(b), Rational.ZERO);
        model.demand[n - 1] = model.demand[n - 1]!.add(ts.sub(td).isNegative() ? Rational.ZERO : ts.sub(td));
        if (td.gt(ts)) model.supply[m - 1] = model.supply[m - 1]!.add(td.sub(ts));
      }
      const lp = solveLP(asLP(model), { emitSteps: false });
      // dummy has zero cost: LP with ≤ for the surplus side gives the same optimum
      for (const method of ['nwc', 'lcm', 'vam'] as const) {
        const sol = new TransportSolver().solve(model, { variant: method, emitSteps: false });
        expect(sol.status).toBe('optimal');
        expect(sol.result!.state.totalCost.toString(), `${method} ${JSON.stringify(model, (_k, v) => (v instanceof Rational ? v.toString() : v))}`).toBe(lp.result!.objectiveValue.toString());
        // basis = spanning tree size m'+n'-1 and flows balance
        const st = sol.result!.state;
        const basicCount = st.allocations.flat().filter(a => a !== null).length;
        expect(basicCount).toBe(st.allocations.length + st.allocations[0]!.length - 1);
      }
    }
  });

  it('labels the dummy and reports balancing', () => {
    const sol = new TransportSolver().solve({ supply: [R(10), R(10)], demand: [R(5), R(5)], costs: [[R(1), R(2)], [R(3), R(1)]] });
    expect(sol.result!.colLabels).toContain('Dummy');
    expect(sol.diagnostics.some(d => d.code === 'BALANCING')).toBe(true);
  });

  it('prohibited route uses symbolic M and is avoided when possible', () => {
    const model: TransportModel = { supply: [R(10), R(10)], demand: [R(10), R(10)], costs: [[R(1), R(2)], [R(3), R(1)]], blocked: [[false, false], [true, false]] };
    const sol = new TransportSolver().solve(model);
    expect(sol.status).toBe('optimal');
    expect(sol.result!.state.totalCost.hasM()).toBe(false);
    expect(sol.result!.state.totalCost.toString()).toBe('20');
  });

  it('prohibited route that cannot be avoided makes the problem infeasible', () => {
    const model: TransportModel = { supply: [R(10)], demand: [R(10)], costs: [[R(1)]], blocked: [[true]] };
    expect(new TransportSolver().solve(model).status).toBe('infeasible');
  });

  it('maximisation converts profits', () => {
    const model: TransportModel = { supply: [R(10), R(10)], demand: [R(10), R(10)], costs: [[R(5), R(1)], [R(2), R(6)]], objective: 'max' };
    const sol = new TransportSolver().solve(model);
    expect(sol.result!.reportedObjective.toString()).toBe('110');
  });

  it('reports alternate optima', () => {
    const model: TransportModel = { supply: [R(10), R(10)], demand: [R(10), R(10)], costs: [[R(1), R(1)], [R(1), R(1)]] };
    expect(new TransportSolver().solve(model).diagnostics.some(d => d.code === 'ALTERNATE_OPTIMA')).toBe(true);
  });
});
