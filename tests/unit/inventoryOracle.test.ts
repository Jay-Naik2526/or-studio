import { describe, it, expect } from 'vitest';
import { solveInventory } from '../../src/core/solvers/inventory/inventory';
import { rng } from '../helpers/bruteLP';

const rnd = (r: () => number, a: number, b: number) => a + (b - a) * r();

describe('inventory vs brute-force minimisation', () => {
  it('EOQ / EPQ / planned shortages: reported Q minimises total cost on a fine grid', () => {
    const r = rng(11);
    for (let t = 0; t < 120; t++) {
      const D = rnd(r, 50, 5000), K = rnd(r, 5, 500), h = rnd(r, 0.2, 10), k = D * rnd(r, 1.2, 6), p = rnd(r, 0.5, 20);
      const eoq = solveInventory({ model: 'eoq', demand: D, setupCost: K, holdingCost: h });
      const epq = solveInventory({ model: 'epq', demand: D, setupCost: K, holdingCost: h, productionRate: k });
      const sh = solveInventory({ model: 'shortage', demand: D, setupCost: K, holdingCost: h, shortageCost: p });
      const costEOQ = (q: number) => (K * D) / q + (h * q) / 2;
      const costEPQ = (q: number) => (K * D) / q + (h * q * (1 - D / k)) / 2;
      const costSH = (q: number, s: number) => (K * D) / q + (h * (q - s) ** 2) / (2 * q) + (p * s * s) / (2 * q);
      for (const [res, f] of [[eoq, costEOQ], [epq, costEPQ]] as const) {
        const Q = res.Q!;
        let best = Infinity;
        for (let i = 1; i <= 4000; i++) best = Math.min(best, f(Q * (0.2 + i / 2500)));
        expect(f(Q)).toBeLessThanOrEqual(best + 1e-6 * best);
      }
      // shortage model: Q* = sqrt(2KD(h+p)/(hp)); the largest shortage is s* = Q* h/(h+p)
      const Qs = sh.Q!, S = Qs * h / (h + p);
      let best = Infinity;
      for (let i = 1; i <= 120; i++) for (let j = 0; j <= 60; j++) { const q = Qs * (0.3 + i / 80), s = q * j / 60; best = Math.min(best, costSH(q, s)); }
      expect(costSH(Qs, S)).toBeLessThanOrEqual(best + 1e-6 * best);
      expect(sh.annualCosts!.total).toBeCloseTo(costSH(Qs, S), 4);
    }
  });

  it('all-units discounts: the chosen policy is the cheapest over every order quantity', () => {
    const r = rng(5);
    for (let t = 0; t < 60; t++) {
      const D = rnd(r, 500, 20000), K = rnd(r, 20, 400), I = rnd(r, 0.1, 0.4);
      const breaks = [{ minQty: 0, price: rnd(r, 8, 12) }, { minQty: Math.round(rnd(r, 100, 800)), price: 0 }, { minQty: Math.round(rnd(r, 1000, 4000)), price: 0 }];
      breaks[1]!.price = breaks[0]!.price * rnd(r, 0.93, 0.99); breaks[2]!.price = breaks[1]!.price * rnd(r, 0.93, 0.99);
      const res = solveInventory({ model: 'discount', demand: D, setupCost: K, holdingCost: I, holdingIsRate: true, breaks, discountType: 'allUnits' });
      const priceAt = (q: number) => [...breaks].reverse().find(b => q >= b.minQty)!.price;
      const cost = (q: number) => { const c = priceAt(q); return (K * D) / q + (I * c * q) / 2 + c * D; };
      let best = Infinity;
      for (let q = 1; q <= 20000; q++) best = Math.min(best, cost(q));
      expect(res.annualCosts!.total).toBeLessThanOrEqual(best * (1 + 1e-6));
    }
  });

  it('newsvendor (normal): the stock level maximises expected profit', () => {
    const r = rng(9);
    for (let t = 0; t < 40; t++) {
      const c = rnd(r, 2, 8), price = c + rnd(r, 1, 8), salv = c * rnd(r, 0.1, 0.8), mean = rnd(r, 50, 300), sd = mean * rnd(r, 0.1, 0.4);
      const res = solveInventory({ model: 'newsvendor', sellingPrice: price, unitCost: c, salvageValue: salv, demandDist: 'normal', mean, stdDev: sd });
      const Cu = price - c, Co = c - salv;
      // expected profit by numerical integration over demand
      const profit = (Q: number) => {
        let e = 0; const n = 4000, lo = mean - 6 * sd, hi = mean + 6 * sd, dx = (hi - lo) / n;
        for (let i = 0; i < n; i++) { const d = lo + (i + 0.5) * dx; if (d < 0) continue; const pdf = Math.exp(-0.5 * ((d - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI)); e += (d >= Q ? Cu * Q : Cu * d - Co * (Q - d)) * pdf * dx; }
        return e;
      };
      const Q = res.Q!;
      expect(Q).toBeGreaterThan(0);
      for (const m of [0.8, 0.9, 0.95, 1.05, 1.1, 1.2]) expect(profit(Q)).toBeGreaterThanOrEqual(profit(Q * m) - 1e-3);
    }
  });
});
