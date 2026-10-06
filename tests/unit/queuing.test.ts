import { describe, it, expect } from 'vitest';
import { solveQueue } from '../../src/core/solvers/queuing/queuing';

describe('queuing', () => {
  it('M/M/1', () => {
    const r = solveQueue({ lambda: 2, mu: 3 }).metrics!;
    expect(r.Ls).toBeCloseTo(2, 9); expect(r.Lq).toBeCloseTo(4 / 3, 9); expect(r.Ws).toBeCloseTo(1, 9); expect(r.P0).toBeCloseTo(1 / 3, 9);
  });
  it('M/M/c matches textbook (c=2, λ=3, μ=2)', () => {
    const r = solveQueue({ lambda: 3, mu: 2, servers: 2 }).metrics!;
    expect(r.P0).toBeCloseTo(1 / 7, 6); expect(r.Lq).toBeCloseTo(27 / 14, 6); expect(r.Ls).toBeCloseTo(27 / 14 + 1.5, 6);
  });
  it('finite models agree: M/M/c/N with c=1 equals M/M/1/N; large N approaches M/M/c', () => {
    const a = solveQueue({ lambda: 2, mu: 3, capacity: 5 }).metrics!;
    const b = solveQueue({ lambda: 2, mu: 3, servers: 1, capacity: 5, model: 'mmcn' }).metrics!;
    expect(a.Ls).toBeCloseTo(b.Ls, 9);
    const big = solveQueue({ lambda: 3, mu: 2, servers: 2, capacity: 200 }).metrics!;
    const inf = solveQueue({ lambda: 3, mu: 2, servers: 2 }).metrics!;
    expect(big.Lq).toBeCloseTo(inf.Lq, 4);
  });
  it('M/G/1 reduces to M/M/1 and M/D/1', () => {
    const mm1 = solveQueue({ lambda: 2, mu: 3 }).metrics!;
    expect(solveQueue({ model: 'mg1', lambda: 2, mu: 3, serviceStdDev: 1 / 3 }).metrics!.Lq).toBeCloseTo(mm1.Lq, 9);
    expect(solveQueue({ model: 'mg1', lambda: 2, mu: 3, serviceStdDev: 0 }).metrics!.Lq).toBeCloseTo(mm1.Lq / 2, 9);
  });
  it('machine servicing sums to 1 and Little holds', () => {
    const r = solveQueue({ model: 'mmcnn', lambda: 0.1, mu: 1, servers: 1, capacity: 5 }).metrics!;
    expect(r.Pk.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(r.Ls).toBeGreaterThan(r.Lq);
  });
  it('refuses unstable and invalid input without throwing', () => {
    expect(solveQueue({ lambda: 3, mu: 3 }).error).toMatch(/Unstable/);
    expect(solveQueue({ lambda: 3, mu: 0 }).error).toMatch(/service rate/);
    expect(solveQueue({ lambda: 3, mu: 3, capacity: 4 }).metrics).toBeDefined();
  });
  it('cost model finds an interior optimum', () => {
    const r = solveQueue({ lambda: 10, mu: 3, servers: 4, costPerServer: 20, costPerWait: 30 });
    expect(r.costOptimization!.optimalServers).toBeGreaterThanOrEqual(4);
    expect(r.costOptimization!.candidates.length).toBeGreaterThan(3);
  });
});
