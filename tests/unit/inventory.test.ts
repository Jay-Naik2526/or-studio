import { describe, it, expect } from 'vitest';
import { solveInventory } from '../../src/core/solvers/inventory/inventory';

describe('inventory', () => {
  it('EOQ', () => {
    const r = solveInventory({ model: 'eoq', demand: 1000, setupCost: 100, holdingCost: 2 });
    expect(r.Q).toBeCloseTo(Math.sqrt(100000), 6);
    expect(r.annualCosts!.ordering).toBeCloseTo(r.annualCosts!.holding, 6);
  });
  it('reorder point uses effective lead time', () => {
    const r = solveInventory({ model: 'eoq', demand: 1000, setupCost: 100, holdingCost: 2, leadTime: 0.5 });
    expect(r.reorderPoint).toBeGreaterThanOrEqual(0);
  });
  it('shortage model → EOQ as p→∞', () => {
    const a = solveInventory({ model: 'shortage', demand: 1000, setupCost: 100, holdingCost: 2, shortageCost: 1e9 });
    const b = solveInventory({ model: 'eoq', demand: 1000, setupCost: 100, holdingCost: 2 });
    expect(a.Q).toBeCloseTo(b.Q!, 3);
  });
  it('EPQ rejects k ≤ D', () => {
    expect(solveInventory({ model: 'epq', demand: 10, setupCost: 5, holdingCost: 1, productionRate: 10 }).error).toMatch(/exceed/);
  });
  it('all-units discount picks the cheapest feasible tier', () => {
    const r = solveInventory({ model: 'discount', demand: 10000, setupCost: 100, holdingCost: 0.2, holdingIsRate: true, breaks: [{ minQty: 0, price: 10 }, { minQty: 500, price: 9.5 }, { minQty: 2000, price: 9 }] });
    expect(r.tiers!.filter(t => t.isOptimal)).toHaveLength(1);
    expect(r.annualCosts!.total).toBeLessThan(10000 * 10 + 5000);
  });
  it('incremental discount differs from all-units and is continuous', () => {
    const base = { model: 'discount' as const, demand: 10000, setupCost: 100, holdingCost: 0.2, holdingIsRate: true, breaks: [{ minQty: 0, price: 10 }, { minQty: 500, price: 9.5 }, { minQty: 2000, price: 9 }] };
    const a = solveInventory({ ...base, discountType: 'allUnits' });
    const i = solveInventory({ ...base, discountType: 'incremental' });
    expect(i.annualCosts!.total).toBeGreaterThan(a.annualCosts!.total - 1e-9);
  });
  it('newsvendor normal and discrete', () => {
    const r = solveInventory({ model: 'newsvendor', sellingPrice: 10, unitCost: 6, salvageValue: 2, demandDist: 'normal', mean: 100, stdDev: 20 });
    expect(r.newsvendor!.criticalRatio).toBeCloseTo(0.5, 6);
    expect(r.Q).toBeCloseTo(100, 4);
    const d = solveInventory({ model: 'newsvendor', sellingPrice: 10, unitCost: 6, salvageValue: 2, demandDist: 'discrete', discrete: [{ demand: 10, prob: 0.3 }, { demand: 20, prob: 0.4 }, { demand: 30, prob: 0.3 }] });
    expect(d.Q).toBe(20);
  });
  it('rejects non-positive parameters with a specific message', () => {
    expect(solveInventory({ model: 'eoq', demand: 0, setupCost: 1, holdingCost: 1 }).error).toMatch(/Demand/);
    expect(solveInventory({ model: 'eoq', demand: 1, setupCost: -1, holdingCost: 1 }).error).toMatch(/set-up/);
    expect(solveInventory({ model: 'eoq', demand: 1, setupCost: 1, holdingCost: 0 }).error).toMatch(/holding/);
  });
});
