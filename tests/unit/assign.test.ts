import { describe, it, expect } from 'vitest';
import { HungarianSolver } from '../../src/core/solvers/transport/hungarian';
import { Rational } from '../../src/core/math/rational';
import { randInt, rng } from '../helpers/bruteLP';

const R = (n: number) => Rational.of(n);
function perms(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  for (const p of perms(n - 1)) for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}

describe('Hungarian', () => {
  it('library example costs 9', () => {
    const sol = new HungarianSolver().solve({ costs: [[R(9), R(2), R(7)], [R(6), R(4), R(3)], [R(5), R(8), R(1)]] });
    expect(sol.result!.objective.toString()).toBe('9');
  });
  it('matches brute force on random square, rectangular and max problems', () => {
    const r = rng(8080);
    for (let t = 0; t < 300; t++) {
      const rows = randInt(r, 1, 5), cols = randInt(r, 1, 5);
      const costs = Array.from({ length: rows }, () => Array.from({ length: cols }, () => R(randInt(r, 0, 20))));
      const max = r() < 0.3;
      const n = Math.max(rows, cols);
      let best: number | null = null;
      for (const p of perms(n)) {
        let s = 0;
        for (let i = 0; i < n; i++) if (i < rows && p[i]! < cols) s += Number(costs[i]![p[i]!]!.toString());
        if (best === null || (max ? s > best : s < best)) best = s;
      }
      const sol = new HungarianSolver().solve({ costs, objective: max ? 'max' : 'min' });
      expect(sol.status).toBe('optimal');
      expect(Number(sol.result!.objective.toString()), JSON.stringify(costs.map(x => x.map(String)))).toBe(best);
    }
  });
  it('prohibited cell avoided via symbolic M', () => {
    const sol = new HungarianSolver().solve({ costs: [[R(1), R(5)], [R(2), R(9)]], blocked: [[true, false], [false, false]] });
    expect(sol.result!.objective.toString()).toBe('7');
  });
});
