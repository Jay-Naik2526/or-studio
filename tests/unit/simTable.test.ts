import { describe, it, expect } from 'vitest';
import { buildIntervals, mapRn, parseRandomNumbers, generateRandomNumbers, simulateDemand, demandSteps } from '../../src/core/solvers/simulation/demandTable';
import { simulateInventory, policySearch, generateInventoryRns, inventorySteps, InventoryInput } from '../../src/core/solvers/simulation/inventorySim';
import { midSquareRun, lcgRun, chiSquareUniform, chiSquareCdf, chiSquareSf, hullDobell, consecutivePairs, formatP } from '../../src/core/solvers/simulation/rngLab';
import { makeRng } from '../../src/core/solvers/simulation/random';

const VALUES = [0, 10, 20, 30, 40, 50];
const PROBS = [0.01, 0.20, 0.15, 0.50, 0.12, 0.02];
const RNS = [40, 19, 87, 83, 73, 84, 29, 9, 2, 20];

describe('demand table: intervals', () => {
  it('stationery example, convention 00-99', () => {
    const t = buildIntervals(VALUES, PROBS, 2, 'zero');
    expect(t.error).toBeUndefined();
    expect(t.intervals.map(r => r.cum)).toEqual([0.01, 0.21, 0.36, 0.86, 0.98, 1]);
    expect(t.intervals.map(r => r.label)).toEqual(['00', '01–20', '21–35', '36–85', '86–97', '98–99']);
    expect(t.intervals.map(r => r.count)).toEqual([1, 20, 15, 50, 12, 2]);
    expect(t.warnings).toEqual([]);
    expect(t.expected).toBeCloseTo(25.8, 12);
  });
  it('stationery example, convention 01-100', () => {
    const t = buildIntervals(VALUES, PROBS, 2, 'one');
    expect(t.intervals.map(r => r.label)).toEqual(['01', '02–21', '22–36', '37–86', '87–98', '99–100']);
    expect(mapRn(t, 0)).toBe(5); // 00 is read as 100
    expect(mapRn(t, 100)).toBe(5);
    expect(mapRn(t, 1)).toBe(0);
    expect(mapRn(t, 99)).toBe(5);
  });
  it('every random number maps to exactly one value and interval sizes follow the probabilities', () => {
    const cases: [number[], number[], number, 'zero' | 'one'][] = [
      [VALUES, PROBS, 2, 'zero'], [VALUES, PROBS, 2, 'one'], [[1, 2, 3], [1 / 3, 1 / 3, 1 / 3], 2, 'zero'], [[1, 2, 3], [0.333, 0.333, 0.334], 3, 'one'],
      [[5, 6, 7, 8], [0.0004, 0.4996, 0.25, 0.25], 4, 'zero'], [[1, 2], [0.5, 0.5], 1, 'zero'], [[1, 2, 3], [0.25, 0.5, 0.25], 1, 'one'],
    ];
    for (const [v, p, d, c] of cases) {
      const t = buildIntervals(v, p, d, c);
      expect(t.error).toBeUndefined();
      const M = 10 ** d;
      const hit = new Array<number>(v.length).fill(0);
      const from = c === 'zero' ? 0 : 1, to = c === 'zero' ? M - 1 : M;
      for (let r = from; r <= to; r++) { const k = mapRn(t, r); expect(k).toBeGreaterThanOrEqual(0); hit[k]!++; }
      expect(hit.reduce((a, b) => a + b, 0)).toBe(M);
      hit.forEach((h, k) => { expect(h).toBe(t.intervals[k]!.count); expect(Math.abs(h - p[k]! * M)).toBeLessThan(1 + 1e-9); });
    }
  });
  it('mapping is monotone in the random number', () => {
    const t = buildIntervals(VALUES, PROBS, 2, 'zero');
    let prev = -1;
    for (let r = 0; r < 100; r++) { const k = mapRn(t, r); expect(k).toBeGreaterThanOrEqual(prev); prev = k; }
    expect(mapRn(t, -1)).toBe(-1);
    expect(mapRn(t, 100)).toBe(-1);
    expect(mapRn(t, 1.5)).toBe(-1);
  });
  it('probabilities off the digit grid are rounded and warned about', () => {
    const t = buildIntervals([1, 2, 3], [0.125, 0.375, 0.5], 2, 'zero');
    expect(t.error).toBeUndefined();
    expect(t.intervals.map(r => r.count)).toEqual([13, 37, 50]); // 12.5 -> 13 (half up), 50 -> 50
    expect(t.warnings.join(' ')).toMatch(/grid/);
    const tiny = buildIntervals([1, 2], [0.004, 0.996], 2, 'zero');
    expect(tiny.intervals[0]!.count).toBe(0);
    expect(tiny.warnings.join(' ')).toMatch(/never be drawn/);
  });
});

describe('demand table: simulation', () => {
  const sim = simulateDemand({ values: VALUES, probs: PROBS, digits: 2, convention: 'zero', rns: RNS });
  it('reproduces the stationery experiment', () => {
    expect(sim.error).toBeUndefined();
    expect(sim.days.map(d => d.demand)).toEqual([30, 10, 40, 30, 30, 30, 20, 10, 10, 10]);
    expect(sim.days.map(d => d.interval)).toEqual(['36–85', '01–20', '86–97', '36–85', '36–85', '36–85', '21–35', '01–20', '01–20', '01–20']);
    expect(sim.total).toBe(220);
    expect(sim.mean).toBe(22);
    expect(sim.expected).toBeCloseTo(25.8, 12);
    expect(sim.days[9]!.cumDemand).toBe(220);
    expect(sim.days[9]!.runningAvg).toBe(22);
    expect(sim.days[2]!.cumDemand).toBe(80);
    expect(sim.counts).toEqual([0, 4, 1, 4, 1, 0]);
  });
  it('the player has setup, one step per day and a summary', () => {
    const steps = demandSteps(sim);
    expect(steps.length).toBe(2 + 10 + 1);
    expect(steps[steps.length - 1]!.explanation.short).toMatch(/220/);
  });
  it('is deterministic for a seed and differs between seeds', () => {
    const a = generateRandomNumbers(50, 2, 'mt', 7, 'zero'), b = generateRandomNumbers(50, 2, 'mt', 7, 'zero'), c = generateRandomNumbers(50, 2, 'mt', 8, 'zero');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.every(x => Number.isInteger(x) && x >= 0 && x <= 99)).toBe(true);
    expect(generateRandomNumbers(500, 1, 'lcg', 3, 'one').every(x => x >= 1 && x <= 10)).toBe(true);
  });
  it('the long-run mean approaches E[D]', () => {
    const rns = generateRandomNumbers(20000, 2, 'mt', 123, 'zero');
    const s = simulateDemand({ values: VALUES, probs: PROBS, digits: 2, convention: 'zero', rns });
    // sd of D is 10.31, so the standard error is 0.073; allow 4 standard errors
    expect(Math.abs(s.mean - 25.8)).toBeLessThan(0.3);
    s.observed.forEach((o, k) => expect(Math.abs(o - PROBS[k]!)).toBeLessThan(0.02));
  });
  it('validates hostile input without throwing', () => {
    expect(buildIntervals(VALUES, [0.5, 0.2, 0.1, 0.1, 0.05, 0.02], 2, 'zero').error).toMatch(/not 1/);
    expect(buildIntervals([1, 2], [-0.5, 1.5], 2, 'zero').error).toMatch(/negative/);
    expect(buildIntervals([1, 1], [0.5, 0.5], 2, 'zero').error).toMatch(/twice/);
    expect(buildIntervals([], [], 2, 'zero').error).toMatch(/at least one/);
    expect(buildIntervals([1], [1], 5, 'zero').error).toMatch(/1 to 4/);
    expect(buildIntervals([NaN], [1], 2, 'zero').error).toMatch(/finite/);
    expect(parseRandomNumbers('', 2, 'zero')).toHaveProperty('error');
    expect(parseRandomNumbers('12, 100', 2, 'zero')).toHaveProperty('error');
    expect((parseRandomNumbers('12, 100', 2, 'one') as { rns: number[] }).rns).toEqual([12, 100]);
    expect((parseRandomNumbers('1.5', 2, 'zero') as { error: string }).error).toMatch(/whole number/);
    expect((parseRandomNumbers('-3 4', 2, 'zero') as { error: string }).error).toMatch(/whole number/);
    expect((parseRandomNumbers('12 abc', 2, 'zero') as { error: string }).error).toMatch(/abc/);
    expect((parseRandomNumbers('99999999999999999999', 2, 'zero') as { error: string }).error).toMatch(/outside/);
    expect((parseRandomNumbers('1 2 3 4', 2, 'zero', 3) as { error: string }).error).toMatch(/At most/);
    expect((parseRandomNumbers('00\n05;07  99', 2, 'zero') as { rns: number[] }).rns).toEqual([0, 5, 7, 99]);
    expect(simulateDemand({ values: VALUES, probs: PROBS, digits: 2, convention: 'zero', rns: [] }).error).toMatch(/at least one/);
    expect(simulateDemand({ values: VALUES, probs: PROBS, digits: 2, convention: 'zero', rns: [150] }).error).toMatch(/outside/);
    expect(simulateDemand({ values: VALUES, probs: PROBS, digits: 2, convention: 'zero', rns: new Array<number>(100001).fill(1) }).error).toMatch(/100,000|100000/);
  });
});

describe('random-number generators', () => {
  it('mid-square, hand-computed (1234 → 5227 → 3215 → 3362)', () => {
    const r = midSquareRun(1234, 4, 5);
    expect(r.error).toBeUndefined();
    expect(r.states.slice(0, 3)).toEqual([5227, 3215, 3362]);
    expect(r.rows[0]!.working).toBe('1234² = 01522756 → middle 4 digits = 5227');
    expect(r.rows[1]!.working).toBe('5227² = 27321529 → middle 4 digits = 3215');
    const two = midSquareRun(42, 2, 6);
    expect(two.states).toEqual([76, 77, 92, 46, 11, 12]);
  });
  it('mid-square gets stuck and the cycle is reported', () => {
    const r = midSquareRun(10, 2, 20); // 10² = 0100 → 10 forever
    expect(r.cycle).toMatchObject({ found: true, tail: 0, length: 1, start: 10 });
    expect(r.warnings.join(' ')).toMatch(/stuck/);
    expect(midSquareRun(5, 3, 5).error).toMatch(/even/);
    expect(midSquareRun(100, 2, 5).error).toMatch(/seed/);
  });
  it('LCG X0=27, a=17, c=43, m=100 gives 2, 77, 52, 27 and period 4', () => {
    const r = lcgRun(17, 43, 100, 27, 8);
    expect(r.error).toBeUndefined();
    expect(r.states.slice(0, 5)).toEqual([2, 77, 52, 27, 2]);
    expect(r.rows[0]!.working).toBe('(17·27 + 43) mod 100 = 502 mod 100 = 2');
    expect(r.cycle).toMatchObject({ found: true, tail: 0, length: 4 });
    expect(r.hullDobell!.full).toBe(false);
  });
  it('LCG a=5, c=3, m=16 has the full period 16 (Hull–Dobell)', () => {
    const r = lcgRun(5, 3, 16, 7, 16);
    expect(r.states.slice(0, 4)).toEqual([6, 1, 8, 11]);
    expect(r.cycle.length).toBe(16);
    expect(r.hullDobell!.full).toBe(true);
    expect(hullDobell(1103515245, 12345, 2 ** 31).full).toBe(true);
    expect(new Set(r.states).size).toBe(16);
  });
  it('LCG with big modulus stays exact (BigInt) and validates input', () => {
    const r = lcgRun(16807, 0, 2147483647, 1, 3);
    expect(r.states).toEqual([16807, 282475249, 1622650073]);
    expect(lcgRun(1, 1, 1, 0, 5).error).toMatch(/at least 2/);
    expect(lcgRun(1.5, 1, 10, 0, 5).error).toBeDefined();
    expect(lcgRun(1, 1, 10, 10, 5).error).toMatch(/smaller/);
    expect(lcgRun(-1, 1, 10, 0, 5).error).toBeDefined();
    expect(lcgRun(1, 1, 10, 0, 0).error).toBeDefined();
  });
  it('chi-square distribution function is exact', () => {
    expect(chiSquareCdf(2, 2)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(chiSquareSf(3.841458820694124, 1)).toBeCloseTo(0.05, 8);
    expect(chiSquareSf(16.918977604620448, 9)).toBeCloseTo(0.05, 8);
    expect(chiSquareSf(21.665994333461924, 9)).toBeCloseTo(0.01, 8);
    expect(chiSquareCdf(0, 5)).toBe(0);
    expect(chiSquareSf(1e4, 9)).toBeLessThan(1e-12);
  });
  it('p-values are formatted without showing a misleading zero', () => {
    expect(formatP(0)).toBe('< 1e-15');
    expect(formatP(0.17474)).toBe('0.1747');
    expect(formatP(2.5e-7)).toBe('2.50e-7');
  });
  it('uniformity test: a good generator passes, obviously bad ones fail', () => {
    const rng = makeRng('mt', 2024);
    const good = Array.from({ length: 5000 }, () => rng.next());
    const g = chiSquareUniform(good);
    expect(g.df).toBe(9);
    expect(g.counts.reduce((a, b) => a + b, 0)).toBe(5000);
    expect(g.pass).toBe(true);
    expect(g.p).toBeGreaterThan(0.05);
    const stuck = midSquareRun(10, 2, 1000);
    const b1 = chiSquareUniform(stuck.uniform);
    expect(b1.pass).toBe(false);
    expect(b1.p).toBeLessThan(1e-6);
    const skew = chiSquareUniform(Array.from({ length: 1000 }, (_, i) => (i % 1000) / 2000));
    expect(skew.pass).toBe(false);
    expect(chiSquareUniform([0.5]).error).toBeDefined();
    expect(chiSquareUniform(new Array<number>(20).fill(2)).error).toBeDefined();
    // a perfect staircase is "too uniform" but never rejected by this test
    expect(chiSquareUniform(Array.from({ length: 100 }, (_, i) => i / 100)).chi2).toBe(0);
    expect(consecutivePairs([0.1, 0.2, 0.3])).toEqual([{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }]);
    expect(consecutivePairs(Array.from({ length: 10000 }, (_, i) => i / 10000)).length).toBeLessThanOrEqual(1000);
  });
});

describe('inventory simulation', () => {
  // demand 1, 2, 3 with probabilities 0.2, 0.5, 0.3 -> intervals 00-19, 20-69, 70-99
  const base: InventoryInput = {
    demandValues: [1, 2, 3], demandProbs: [0.2, 0.5, 0.3], leadValues: [], leadProbs: [], leadFixed: 0,
    digits: 2, convention: 'zero', demandRns: [12, 45, 83, 67, 21, 90, 33, 5, 74, 58], leadRns: [],
    days: 10, S: 8, R: 5, initial: 5, orderCost: 20, holdCost: 1, shortCost: 5, backorders: false,
  };
  it('hand-checked example: demands, sales, order and total cost 76', () => {
    const s = simulateInventory(base);
    expect(s.error).toBeUndefined();
    expect(s.days.map(d => d.demand)).toEqual([1, 2, 3, 2, 2, 3, 2, 1, 3, 2]);
    expect(s.days.map(d => d.end)).toEqual([4, 2, 0, 0, 0, 5, 3, 2, 0, 0]);
    expect(s.days.map(d => d.shortage)).toEqual([0, 0, 1, 2, 2, 0, 0, 0, 1, 2]);
    expect(s.days[4]!.ordered).toBe(8);
    expect(s.days[4]!.arrivesDay).toBe(6);
    expect(s.days[5]!.arrival).toBe(8);
    expect(s.days[9]!.ordered).toBe(0);
    expect(s.totals).toMatchObject({ orders: 1, orderCost: 20, holdCost: 16, shortCost: 40, total: 76, demand: 21, sales: 13, shortUnits: 8 });
    expect(s.totals.avgPerDay).toBeCloseTo(7.6, 12);
    const steps = inventorySteps(s);
    expect(steps.length).toBe(1 + 10 + 1);
  });
  it('conservation identities hold exactly, with lost sales and with backorders, fixed and random lead times', () => {
    for (const backorders of [false, true]) for (const table of [false, true]) for (const seed of [1, 2, 3]) {
      const days = 300;
      const rn = generateInventoryRns(days, 4, 2, 'mt', seed, 'zero');
      const inp: InventoryInput = { ...base, days, R: 4, S: 9, initial: 3, backorders, demandRns: rn.demandRns, leadRns: rn.leadRns, ...(table ? { leadValues: [0, 1, 2], leadProbs: [0.3, 0.5, 0.2] } : { leadFixed: 2 }) };
      const s = simulateInventory(inp);
      expect(s.error).toBeUndefined();
      let prevEnd = inp.initial, prevShort = 0, cost = 0, orders = 0;
      for (const d of s.days) {
        expect(d.begin).toBe(prevEnd);
        expect(d.end).toBe(d.begin + d.arrival - d.sales);
        expect(d.shortage).toBe(d.backlogIn + d.demand - d.sales);
        expect(d.backlogIn).toBe(backorders ? prevShort : 0);
        expect(d.end).toBeGreaterThanOrEqual(0);
        expect(d.sales).toBeGreaterThanOrEqual(0);
        expect(d.costDay).toBeCloseTo(d.orderCostDay + d.holdCostDay + d.shortCostDay, 9);
        if (d.ordered > 0) { orders++; expect(d.day % 4).toBe(0); expect(d.position + d.ordered).toBe(9); }
        prevEnd = d.end; prevShort = d.shortage; cost += d.costDay;
      }
      const t = s.totals;
      expect(t.total).toBeCloseTo(cost, 6);
      expect(t.total).toBeCloseTo(t.orderCost + t.holdCost + t.shortCost, 9);
      expect(t.orders).toBe(orders);
      expect(t.avgPerDay).toBeCloseTo(t.total / days, 12);
      const received = s.days.reduce((a, d) => a + d.arrival, 0), orderedSum = s.days.reduce((a, d) => a + d.ordered, 0);
      expect(received + t.outstanding).toBe(orderedSum);
      expect(t.endStock).toBe(inp.initial + received - t.sales);
      if (!backorders) expect(t.sales + t.shortUnits).toBe(t.demand);
      else expect(t.sales + t.shortUnits).toBe(t.demand);
    }
  });
  it('policy search equals brute force over S and highlights the cheapest', () => {
    const rn = generateInventoryRns(200, 3, 2, 'mt', 42, 'zero');
    const inp: InventoryInput = { ...base, days: 200, R: 3, initial: 4, demandRns: rn.demandRns, leadRns: rn.leadRns, leadFixed: 1 };
    const ps = policySearch(inp, 2, 20, 1);
    expect(ps.error).toBeUndefined();
    expect(ps.rows.length).toBe(19);
    let bestS = -1, bestCost = Infinity;
    for (let S = 2; S <= 20; S++) { const c = simulateInventory({ ...inp, S }).totals.total; if (c < bestCost - 1e-12) { bestCost = c; bestS = S; } }
    expect(ps.bestS).toBe(bestS);
    expect(ps.rows[ps.best]!.total).toBeCloseTo(bestCost, 9);
    ps.rows.forEach(r => expect(r.total).toBeGreaterThanOrEqual(bestCost - 1e-9));
    expect(ps.rows.every(r => Math.abs(r.total - (r.orderCost + r.holdCost + r.shortCost)) < 1e-9)).toBe(true);
  });
  it('validates inputs', () => {
    expect(simulateInventory({ ...base, days: 0 }).error).toMatch(/Days/);
    expect(simulateInventory({ ...base, R: 0 }).error).toMatch(/Review/);
    expect(simulateInventory({ ...base, S: -1 }).error).toMatch(/S/);
    expect(simulateInventory({ ...base, holdCost: -2 }).error).toMatch(/Holding/);
    expect(simulateInventory({ ...base, demandRns: [1, 2] }).error).toMatch(/random numbers/);
    expect(simulateInventory({ ...base, demandProbs: [0.5, 0.5, 0.5] }).error).toMatch(/Demand table/);
    expect(simulateInventory({ ...base, leadValues: [0, 1], leadProbs: [0.5, 0.5], leadRns: [] }).error).toMatch(/lead-time/i);
    expect(simulateInventory({ ...base, demandValues: [1.5, 2, 3] }).error).toMatch(/whole/);
    expect(policySearch(base, 5, 2, 1).error).toBeDefined();
    expect(policySearch(base, 0, 100000, 1).error).toMatch(/at most 400/);
  });
});
