import { describe, it, expect } from 'vitest';
import { MersenneTwister, LcgRng, compileExpression } from '../../src/core/solvers/simulation/random';
import { runMonteCarlo, runQueueSimulation } from '../../src/core/solvers/simulation/simulation';
import { solveQueue } from '../../src/core/solvers/queuing/queuing';

describe('random + simulation', () => {
  it('MT19937 reproduces the reference sequence for seed 5489', () => {
    const mt = new MersenneTwister(5489);
    expect(mt.nextUint32()).toBe(3499211612);
    expect(mt.nextUint32()).toBe(581869302);
  });
  it('LCG reference: seed 1 → 16807/2147483647', () => {
    expect(new LcgRng(1).next()).toBeCloseTo(16807 / 2147483647, 12);
  });
  it('same seed ⇒ identical results; different seed ⇒ different', () => {
    const base = { variables: [{ name: 'x', dist: { type: 'uniform' as const, a: 0, b: 1 } }, { name: 'y', dist: { type: 'uniform' as const, a: 0, b: 1 } }], expression: '4*step(1 - x*x - y*y)', trials: 20000, seed: 7, generator: 'mt' as const };
    const a = runMonteCarlo(base), b = runMonteCarlo(base), c = runMonteCarlo({ ...base, seed: 8 });
    expect(a.mean).toBe(b.mean);
    expect(a.mean).not.toBe(c.mean);
    expect(a.mean).toBeCloseTo(Math.PI, 1);
    expect(a.ci95[0]).toBeLessThan(Math.PI);
    expect(a.ci95[1]).toBeGreaterThan(Math.PI);
  });
  it('expression errors are reported, not thrown', () => {
    expect(runMonteCarlo({ variables: [], expression: '1 +', trials: 10, seed: 1, generator: 'lcg' }).error).toMatch(/Expression/);
    expect(() => compileExpression('foo(1)', [])).toThrow(/Unknown function/);
  });
  it('M/M/1 simulation approaches theory', () => {
    const sim = runQueueSimulation({ interarrival: { type: 'exponential', rate: 2 }, service: { type: 'exponential', rate: 3 }, servers: 1, customers: 60000, seed: 11, generator: 'mt', warmup: 2000 });
    const th = solveQueue({ lambda: 2, mu: 3 }).metrics!;
    expect(sim.avgWait).toBeGreaterThan(th.Wq * 0.85);
    expect(sim.avgWait).toBeLessThan(th.Wq * 1.15);
    expect(sim.utilisation).toBeCloseTo(2 / 3, 1);
    expect(sim.maxQueueLength).toBeGreaterThan(0);
  });
  it('unstable configuration is warned about', () => {
    const sim = runQueueSimulation({ interarrival: { type: 'exponential', rate: 3 }, service: { type: 'exponential', rate: 2 }, servers: 1, customers: 500, seed: 1, generator: 'lcg' });
    expect(sim.warnings.join(' ')).toMatch(/unstable/);
  });
});
