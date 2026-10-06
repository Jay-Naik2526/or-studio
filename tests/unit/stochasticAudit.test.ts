/**
 * Independent-oracle audit of the queuing, inventory, game-theory, Markov, simulation and NLP solvers.
 * Every random draw is seeded so a failure is reproducible.
 */
import { describe, it, expect } from 'vitest';
import { solveQueue, optimiseServers, MAX_SERVERS, MAX_CAPACITY, type QueueInput } from '../../src/core/solvers/queuing/queuing';
import { solveInventory, type InventoryInput } from '../../src/core/solvers/inventory/inventory';
import { solveZeroSumGame } from '../../src/core/solvers/games/zeroSum';
import { solveMarkovChain } from '../../src/core/solvers/markov/markov';
import { Rational } from '../../src/core/math/rational';
import { LcgRng, MersenneTwister, makeRng, sample, validateDistribution, compileExpression, type Distribution } from '../../src/core/solvers/simulation/random';
import { runMonteCarlo, runQueueSimulation } from '../../src/core/solvers/simulation/simulation';
import { minimiseUnconstrained, checkKKT, solveQP, parseExpression, diff, evalExpr } from '../../src/core/solvers/nlp/nlp';

/** mulberry32: small seeded generator for test data. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const rf = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);
const close = (a: number, b: number, rel = 1e-8, abs = 1e-10) => Math.abs(a - b) <= abs + rel * Math.max(Math.abs(a), Math.abs(b));

/* ======================================================================= */
/* 1. QUEUING                                                              */
/* ======================================================================= */

/** Solve the global-balance equations of a birth–death chain on 0..N by dense Gaussian elimination. */
function birthDeath(N: number, birth: (n: number) => number, death: (n: number) => number): number[] {
  const n = N + 1;
  // columns of the generator transposed: (Qᵀ π = 0) with the last row replaced by Σπ = 1
  const A: number[][] = Array.from({ length: n }, () => Array(n + 1).fill(0));
  for (let i = 0; i < n; i++) {
    if (i < N) { A[i]![i]! -= birth(i); A[i + 1]![i]! += birth(i); }
    if (i > 0) { A[i]![i]! -= death(i); A[i - 1]![i]! += death(i); }
  }
  for (let j = 0; j < n; j++) A[n - 1]![j] = 1;
  A[n - 1]![n] = 1;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) A[r]![k]! -= f * A[c]![k]!;
    }
  }
  return A.map((row, i) => row[n]! / row[i]!);
}

function chainMetrics(pi: number[], c: number, birth: (n: number) => number) {
  const Ls = pi.reduce((s, p, n) => s + n * p, 0);
  const Lq = pi.reduce((s, p, n) => s + Math.max(0, n - c) * p, 0);
  const lamEff = pi.reduce((s, p, n) => s + birth(n) * p, 0);
  return { Ls, Lq, lamEff };
}

/** Erlang-B recursion (numerically stable for any c) and the Erlang-C quantities derived from it. */
function erlang(c: number, a: number) {
  let B = 1;
  for (let k = 1; k <= c; k++) B = (a * B) / (k + a * B);
  const rho = a / c;
  const C = B / (1 - rho * (1 - B));
  const Lq = (C * rho) / (1 - rho);
  return { B, C, Lq, Ls: Lq + a };
}

describe('queuing audit', () => {
  it('M/M/c matches Erlang C and a brute-force birth–death chain', () => {
    const r = seeded(11);
    for (let t = 0; t < 40; t++) {
      const c = ri(r, 1, 8), mu = rf(r, 0.5, 5), rho = rf(r, 0.1, 0.92), lambda = rho * c * mu;
      const res = solveQueue({ model: 'mmc', lambda, mu, servers: c });
      expect(res.error).toBeUndefined();
      const m = res.metrics!;
      const e = erlang(c, lambda / mu);
      expect(close(m.Lq, e.Lq, 1e-9)).toBe(true);
      expect(close(m.probWait!, e.C, 1e-9)).toBe(true);
      const pi = birthDeath(300, () => lambda, n => Math.min(n, c) * mu);
      const bd = chainMetrics(pi, c, () => lambda);
      expect(close(m.Ls, bd.Ls, 1e-5), `Ls ${m.Ls} vs ${bd.Ls}`).toBe(true);
      expect(close(m.Lq, bd.Lq, 1e-5)).toBe(true);
      expect(close(m.P0, pi[0]!, 1e-7)).toBe(true);
      // Little's law
      expect(close(m.Ls, m.effectiveLambda * m.Ws, 1e-9)).toBe(true);
      expect(close(m.Lq, m.effectiveLambda * m.Wq, 1e-9)).toBe(true);
      expect(close(m.Ws - m.Wq, 1 / mu, 1e-9)).toBe(true);
      // utilisation of one server = rho
      expect(close(m.serverUtilisation, rho, 1e-9)).toBe(true);
    }
  });

  it('M/M/1/N and M/M/c/N match the birth–death chain, including rho >= 1', () => {
    const r = seeded(12);
    for (let t = 0; t < 60; t++) {
      const c = ri(r, 1, 6), N = c + ri(r, 0, 25), mu = rf(r, 0.5, 4), lambda = rf(r, 0.2, 2.5) * c * mu;
      const res = solveQueue({ model: c === 1 ? 'mm1n' : 'mmcn', lambda, mu, servers: c, capacity: N });
      expect(res.error, `c=${c} N=${N}`).toBeUndefined();
      const m = res.metrics!;
      const pi = birthDeath(N, n => (n < N ? lambda : 0), n => Math.min(n, c) * mu);
      const bd = chainMetrics(pi, c, n => (n < N ? lambda : 0));
      expect(close(m.Ls, bd.Ls, 1e-7)).toBe(true);
      expect(close(m.Lq, bd.Lq, 1e-7, 1e-9)).toBe(true);
      expect(close(m.probBlocked!, pi[N]!, 1e-7, 1e-12)).toBe(true);
      expect(close(m.effectiveLambda, bd.lamEff, 1e-8)).toBe(true);
      expect(close(m.Ls, m.effectiveLambda * m.Ws, 1e-9)).toBe(true);
      expect(close(m.Lq, m.effectiveLambda * m.Wq, 1e-9, 1e-12)).toBe(true);
      expect(close(m.Ws - m.Wq, 1 / mu, 1e-7)).toBe(true);
      expect(m.serverUtilisation).toBeLessThanOrEqual(1 + 1e-9);
      expect(close(m.Pk.reduce((a, b) => a + b, 0), 1, 1e-9)).toBe(true);
    }
  });

  it('machine servicing M/M/c/K/K matches the finite-source birth–death chain', () => {
    const r = seeded(13);
    for (let t = 0; t < 50; t++) {
      const c = ri(r, 1, 4), K = c + ri(r, 0, 20), mu = rf(r, 0.5, 4), lambda = rf(r, 0.02, 1.5);
      const res = solveQueue({ model: 'mmcnn', lambda, mu, servers: c, capacity: K });
      expect(res.error).toBeUndefined();
      const m = res.metrics!;
      const pi = birthDeath(K, n => (K - n) * lambda, n => Math.min(n, c) * mu);
      const bd = chainMetrics(pi, c, n => (K - n) * lambda);
      expect(close(m.Ls, bd.Ls, 1e-7)).toBe(true);
      expect(close(m.Lq, bd.Lq, 1e-7, 1e-10)).toBe(true);
      expect(close(m.effectiveLambda, bd.lamEff, 1e-7)).toBe(true);
      expect(close(m.Ls, m.effectiveLambda * m.Ws, 1e-9)).toBe(true);
      expect(close(m.serverUtilisation, bd.lamEff / mu / c, 1e-7)).toBe(true);
      expect(m.serverUtilisation).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('M/G/1 follows Pollaczek–Khinchine and reduces to M/M/1 (sigma = 1/mu) and M/D/1 (sigma = 0)', () => {
    const r = seeded(14);
    for (let t = 0; t < 30; t++) {
      const mu = rf(r, 0.5, 4), rho = rf(r, 0.05, 0.95), lambda = rho * mu, sigma = rf(r, 0, 3);
      const m = solveQueue({ model: 'mg1', lambda, mu, serviceStdDev: sigma }).metrics!;
      const Es = 1 / mu;
      const Wq = (lambda * (sigma * sigma + Es * Es)) / (2 * (1 - rho));
      expect(close(m.Wq, Wq, 1e-9)).toBe(true);
      expect(close(m.Ls, lambda * (Wq + Es), 1e-9)).toBe(true);
      const mm1 = solveQueue({ model: 'mm1', lambda, mu }).metrics!;
      const mg1 = solveQueue({ model: 'mg1', lambda, mu, serviceStdDev: 1 / mu }).metrics!;
      expect(close(mg1.Lq, mm1.Lq, 1e-9)).toBe(true);
      const md1 = solveQueue({ model: 'mg1', lambda, mu, serviceStdDev: 0 }).metrics!;
      expect(close(md1.Lq, mm1.Lq / 2, 1e-9)).toBe(true);
    }
  });

  it('c = 1 gives the same answer in every model that allows it', () => {
    const lambda = 0.7, mu = 1;
    const a = solveQueue({ model: 'mm1', lambda, mu }).metrics!;
    const b = solveQueue({ model: 'mmc', lambda, mu, servers: 1 }).metrics!;
    const g = solveQueue({ model: 'mg1', lambda, mu, serviceStdDev: 1 }).metrics!;
    const big = solveQueue({ model: 'mm1n', lambda, mu, capacity: 4000 }).metrics!;
    const bigC = solveQueue({ model: 'mmcn', lambda, mu, servers: 1, capacity: 4000 }).metrics!;
    for (const x of [b, g, big, bigC]) { expect(close(x.Ls, a.Ls, 1e-6)).toBe(true); expect(close(x.Wq, a.Wq, 1e-6)).toBe(true); }
    // a single machine with a huge population behaves like M/M/1 with lambda*K
    const K = 4000;
    const fs = solveQueue({ model: 'mmcnn', lambda: lambda / K, mu, servers: 1, capacity: K }).metrics!;
    expect(close(fs.Ls, a.Ls, 1e-2)).toBe(true);
  });

  it('rho >= 1 is reported as unstable for infinite-capacity models and handled for finite ones', () => {
    for (const model of ['mm1', 'mmc', 'mg1'] as const) {
      const res = solveQueue({ model, lambda: 6, mu: 2, servers: 3 });
      expect(res.error).toMatch(/Unstable/);
      expect(res.metrics).toBeUndefined();
    }
    expect(solveQueue({ model: 'mm1', lambda: 1, mu: 1 }).error).toMatch(/Unstable/);
    expect(solveQueue({ model: 'mm1n', lambda: 5, mu: 1, capacity: 3 }).metrics!.probBlocked).toBeGreaterThan(0.5);
    // exactly rho = 1 finite: uniform distribution
    const eq = solveQueue({ model: 'mm1n', lambda: 2, mu: 2, capacity: 9 }).metrics!;
    expect(close(eq.probBlocked!, 0.1, 1e-12)).toBe(true);
  });

  it('is numerically stable for large c and large N', () => {
    for (const [c, a] of [[500, 480], [1500, 1400], [2000, 1990]] as const) {
      const res = solveQueue({ model: 'mmc', lambda: a, mu: 1, servers: c });
      expect(res.error).toBeUndefined();
      const e = erlang(c, a);
      expect(Number.isFinite(res.metrics!.Lq)).toBe(true);
      expect(close(res.metrics!.Lq, e.Lq, 1e-6)).toBe(true);
      expect(close(res.metrics!.probWait!, e.C, 1e-6)).toBe(true);
    }
    // M/M/1/N with N at the limit, rho slightly above 1: closed form P_N = (1−ρ)ρ^N/(1−ρ^(N+1))
    const rho = 1.01, N = 5000;
    const m = solveQueue({ model: 'mm1n', lambda: rho, mu: 1, capacity: N }).metrics!;
    const PN = ((1 - rho) * Math.pow(rho, N)) / (1 - Math.pow(rho, N + 1));
    expect(close(m.probBlocked!, PN, 1e-9)).toBe(true);
    const lg = solveQueue({ model: 'mmcn', lambda: 3000, mu: 1, servers: 1500, capacity: 5000 });
    expect(lg.error).toBeUndefined();
    for (const k of [lg.metrics!.Ls, lg.metrics!.Lq, lg.metrics!.Ws, lg.metrics!.Wq, lg.metrics!.P0]) expect(Number.isFinite(k)).toBe(true);
    const ms = solveQueue({ model: 'mmcnn', lambda: 0.3, mu: 1, servers: 40, capacity: 5000 });
    expect(ms.error).toBeUndefined();
    expect(Number.isFinite(ms.metrics!.Ls)).toBe(true);
    expect(ms.metrics!.Pk.every(p => p >= 0 && Number.isFinite(p))).toBe(true);
  });

  it('enforces its input limits with a clear message and never throws on hostile numbers', () => {
    expect(solveQueue({ model: 'mmc', lambda: 1, mu: 1, servers: MAX_SERVERS + 1 }).error).toMatch(/at most/i);
    expect(solveQueue({ model: 'mmcn', lambda: 1, mu: 1, servers: 2, capacity: MAX_CAPACITY + 1 }).error).toMatch(/at most/i);
    for (const bad of [NaN, -1, 0, Infinity, 1e308, -1e308]) {
      for (const model of ['mm1', 'mmc', 'mm1n', 'mmcn', 'mmcnn', 'mg1'] as const) {
        const inputs: QueueInput[] = [{ model, lambda: bad, mu: 1, servers: 2, capacity: 5 }, { model, lambda: 1, mu: bad, servers: 2, capacity: 5 }, { model, lambda: 1, mu: 2, servers: bad, capacity: 5 }, { model, lambda: 1, mu: 2, servers: 2, capacity: bad }, { model, lambda: 1, mu: 2, servers: 2, capacity: 5, serviceStdDev: bad }];
        for (const input of inputs) {
          const res = solveQueue(input);
          if (res.metrics) {
            const mm = res.metrics;
            for (const v of [mm.Ls, mm.Lq, mm.Ws, mm.Wq, mm.P0, mm.effectiveLambda, mm.serverUtilisation]) expect(Number.isFinite(v), JSON.stringify(input)).toBe(true);
          } else expect(res.error, JSON.stringify(input)).toBeTruthy();
        }
      }
    }
  });

  it('cost-optimal server count equals an exhaustive search (Erlang-C oracle), also for large offered load', () => {
    const r = seeded(15);
    const cases: [number, number, number, number][] = [];
    for (let t = 0; t < 25; t++) cases.push([rf(r, 1, 30), rf(r, 1, 100), rf(r, 1, 1000), 1]);
    cases.push([480, 1, 1, 1e6], [1000, 1, 5, 1e5], [90, 1, 3, 1e9]);
    for (const [lambda, mu, Cs, Cw] of cases) {
      const a = lambda / mu;
      const cMin = Math.floor(a) + 1;
      let best = Infinity, bestC = cMin;
      for (let c = cMin; c <= 2000; c++) {
        const total = c * Cs + erlang(c, a).Ls * Cw;
        if (bestC === cMin && best === Infinity || total < best - 1e-12 * Math.abs(best)) { best = total; bestC = c; }
      }
      const res = solveQueue({ model: 'mmc', lambda, mu, servers: cMin, costPerServer: Cs, costPerWait: Cw });
      expect(res.error).toBeUndefined();
      const chosen = res.costOptimization!.optimalServers;
      const chosenCost = chosen * Cs + erlang(chosen, a).Ls * Cw;
      expect(chosenCost, `λ=${lambda} Cs=${Cs} Cw=${Cw} chose ${chosen}, best ${bestC}`).toBeLessThanOrEqual(best * (1 + 1e-9));
      expect(close(res.costOptimization!.minTotalCost, best, 1e-6)).toBe(true);
    }
    // Lq-based cost
    const o = optimiseServers({ model: 'mmc', lambda: 20, mu: 1, costPerServer: 5, costPerWait: 50, costBasis: 'queue' })!;
    let bc = 0, bv = Infinity;
    for (let c = 21; c < 200; c++) { const v = 5 * c + 50 * erlang(c, 20).Lq; if (v < bv) { bv = v; bc = c; } }
    expect(o.optimalServers).toBe(bc);
  });

  it('cost optimisation never reports an error-free result with a negative or non-finite cost input', () => {
    const res = solveQueue({ model: 'mmc', lambda: 4, mu: 1, servers: 5, costPerServer: -3, costPerWait: 10 });
    expect(res.costOptimization).toBeUndefined();
    const res2 = solveQueue({ model: 'mm1', lambda: 0.5, mu: 1, costPerServer: NaN, costPerWait: 10 });
    expect(res2.costOptimization).toBeUndefined();
  });
});

/* ======================================================================= */
/* 2. INVENTORY                                                            */
/* ======================================================================= */

/** Phi via the complementary error function series (independent of the solver's implementation). */
function phi(z: number) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
function Phi(z: number) {
  // Simpson integration of the density, exact to ~1e-12 on [-9, z]
  const a = -9, n = 4000, h = (Math.min(z, 9) - a) / n;
  let s = phi(a) + phi(Math.min(z, 9));
  for (let i = 1; i < n; i++) s += phi(a + i * h) * (i % 2 ? 4 : 2);
  return (s * h) / 3;
}

describe('inventory audit', () => {
  const grid = (lo: number, hi: number, n: number, f: (q: number) => number) => {
    let best = Infinity, arg = lo;
    for (let i = 0; i <= n; i++) { const q = lo + ((hi - lo) * i) / n; const v = f(q); if (v < best) { best = v; arg = q; } }
    return { best, arg };
  };

  it('EOQ / EPQ / planned shortage minimise their cost curves (brute-force scan)', () => {
    const r = seeded(21);
    for (let t = 0; t < 30; t++) {
      const D = rf(r, 50, 5000), K = rf(r, 5, 500), h = rf(r, 0.1, 10), c = rf(r, 0, 20);
      const eoq = solveInventory({ model: 'eoq', demand: D, setupCost: K, holdingCost: h, unitCost: c });
      const tc = (q: number) => (K * D) / q + (h * q) / 2 + c * D;
      const g = grid(eoq.Q! * 0.2, eoq.Q! * 3, 20000, tc);
      expect(close(eoq.annualCosts!.total, tc(eoq.Q!), 1e-12)).toBe(true);
      expect(eoq.annualCosts!.total).toBeLessThanOrEqual(g.best + 1e-9);
      expect(close(eoq.annualCosts!.total, g.best, 1e-6)).toBe(true);

      const k = D * rf(r, 1.2, 6);
      const epq = solveInventory({ model: 'epq', demand: D, setupCost: K, holdingCost: h, unitCost: c, productionRate: k });
      const tce = (q: number) => (K * D) / q + (h * q * (1 - D / k)) / 2 + c * D;
      const ge = grid(epq.Q! * 0.2, epq.Q! * 3, 20000, tce);
      expect(close(epq.annualCosts!.total, tce(epq.Q!), 1e-12)).toBe(true);
      expect(close(epq.annualCosts!.total, ge.best, 1e-6)).toBe(true);
      expect(close(epq.maxInventory!, epq.Q! * (1 - D / k), 1e-12)).toBe(true);

      const p = rf(r, 0.2, 30);
      const sh = solveInventory({ model: 'shortage', demand: D, setupCost: K, holdingCost: h, unitCost: c, shortageCost: p });
      // two-variable brute force over (Q, S): TC = KD/Q + h(Q-S)²/(2Q) + pS²/(2Q)
      const tcs = (q: number, s: number) => (K * D) / q + (h * (q - s) ** 2) / (2 * q) + (p * s * s) / (2 * q) + c * D;
      let best = Infinity;
      const Q0 = sh.Q!, S0 = sh.maxShortage!;
      for (let i = -40; i <= 40; i++) for (let j = -40; j <= 40; j++) { const q = Q0 * (1 + i / 400), s = S0 * (1 + j / 400); if (s >= 0 && q >= s) best = Math.min(best, tcs(q, s)); }
      expect(sh.annualCosts!.total).toBeLessThanOrEqual(best + 1e-9);
      expect(close(sh.annualCosts!.total, tcs(Q0, S0), 1e-10)).toBe(true);
      expect(close(sh.annualCosts!.total, sh.annualCosts!.ordering + sh.annualCosts!.holding + sh.annualCosts!.shortage + sh.annualCosts!.purchase, 1e-12)).toBe(true);
    }
  });

  it('reorder point with a lead time longer than the cycle matches the explicit sawtooth', () => {
    const r = seeded(22);
    for (let t = 0; t < 40; t++) {
      const D = rf(r, 100, 1000), K = rf(r, 5, 100), h = rf(r, 0.5, 5);
      const base = solveInventory({ model: 'eoq', demand: D, setupCost: K, holdingCost: h });
      const T = base.cycleTime!, Q = base.Q!;
      const L = T * rf(r, 0.05, 6.5);
      const R = solveInventory({ model: 'eoq', demand: D, setupCost: K, holdingCost: h, leadTime: L }).reorderPoint!;
      // deliveries land at k·T and stock is Q − D·(t mod T) in between; an order placed at kT − L must find exactly R on hand
      const mod = (x: number) => x - Math.floor(x / T) * T;
      const onHandAt = (tt: number) => Q - D * mod(tt);
      const orderTime = 10 * T - L;
      expect(R).toBeGreaterThanOrEqual(0);
      expect(R).toBeLessThanOrEqual(Q + 1e-9);
      expect(close(R, onHandAt(orderTime), 1e-7, 1e-6), `T=${T} L=${L}`).toBe(true);
    }
    // whole number of cycles: the order is triggered when stock reaches zero, not when it is full
    const exact = solveInventory({ model: 'eoq', demand: 100, setupCost: 2, holdingCost: 1, leadTime: 0.6 });
    expect(exact.Q).toBeCloseTo(20, 9);
    expect(exact.reorderPoint!).toBeLessThan(1e-6);
  });

  it('rejects zero, negative, NaN and infinite parameters with a specific message', () => {
    const base: InventoryInput = { model: 'eoq', demand: 100, setupCost: 10, holdingCost: 1 };
    for (const field of ['demand', 'setupCost', 'holdingCost'] as const) {
      for (const bad of [0, -5, NaN, Infinity]) {
        const res = solveInventory({ ...base, [field]: bad });
        expect(res.error, `${field}=${bad}`).toBeTruthy();
        expect(res.Q).toBeUndefined();
      }
    }
    for (const bad of [-1, NaN, Infinity]) expect(solveInventory({ ...base, unitCost: bad }).error, `unitCost=${bad}`).toBeTruthy();
    for (const bad of [-1, NaN, Infinity]) expect(solveInventory({ ...base, leadTime: bad }).error, `leadTime=${bad}`).toBeTruthy();
    expect(solveInventory({ model: 'epq', demand: 100, setupCost: 10, holdingCost: 1, productionRate: 100 }).error).toMatch(/exceed/);
    expect(solveInventory({ model: 'epq', demand: 100, setupCost: 10, holdingCost: 1, productionRate: 50 }).error).toBeTruthy();
    expect(solveInventory({ model: 'epq', demand: 100, setupCost: 10, holdingCost: 1 }).error).toBeTruthy();
    expect(solveInventory({ model: 'shortage', demand: 100, setupCost: 10, holdingCost: 1, shortageCost: 0 }).error).toBeTruthy();
    expect(solveInventory({ ...base, demand: 1e308 }).error ?? '').not.toMatch(/NaN|Infinity/);
    const huge = solveInventory({ ...base, demand: 1e300, setupCost: 1e300 });
    if (!huge.error) for (const v of [huge.Q!, huge.annualCosts!.total]) expect(Number.isFinite(v)).toBe(true);
  });

  /* ------- discounts: brute force over a fine grid of Q with the true tiered pricing ------- */
  const schedule = (breaks: { minQty: number; price: number }[], type: 'allUnits' | 'incremental', q: number) => {
    if (type === 'allUnits') { let p = breaks[0]!.price; for (const b of breaks) if (q >= b.minQty) p = b.price; return p * q; }
    let total = 0;
    breaks.forEach((b, i) => { const hi = i + 1 < breaks.length ? breaks[i + 1]!.minQty : Infinity; if (q > b.minQty) total += b.price * (Math.min(q, hi) - b.minQty); });
    return total;
  };

  it('all-units and incremental discounts reach the brute-force minimum (fixed holding cost)', () => {
    const r = seeded(23);
    for (const type of ['allUnits', 'incremental'] as const) {
      for (let t = 0; t < 40; t++) {
        const nb = ri(r, 1, 4);
        const breaks: { minQty: number; price: number }[] = [];
        let q = 0, price = rf(r, 5, 30);
        for (let i = 0; i < nb; i++) { breaks.push({ minQty: q, price: Number(price.toFixed(2)) }); q += ri(r, 20, 400); price *= rf(r, 0.7, 0.98); }
        const D = rf(r, 200, 5000), K = rf(r, 10, 300), h = rf(r, 0.5, 6);
        const res = solveInventory({ model: 'discount', demand: D, setupCost: K, holdingCost: h, breaks, discountType: type });
        expect(res.error, JSON.stringify(breaks)).toBeUndefined();
        // total annual cost for order size q: purchase of one cycle's quantity + order cost + holding
        const tc = (qq: number) => (D / qq) * (schedule(breaks, type, qq) + K) + (h * qq) / 2;
        const qmax = (breaks[breaks.length - 1]!.minQty + 1) * 3 + 4 * Math.sqrt((2 * D * K) / h) + 500;
        let best = Infinity;
        for (let i = 1; i <= 60000; i++) best = Math.min(best, tc((qmax * i) / 60000));
        for (const b of breaks) for (const e of [0, 1e-9]) if (b.minQty + e > 0) best = Math.min(best, tc(b.minQty + e));
        expect(res.annualCosts!.total, `${type} ${JSON.stringify(breaks)} D=${D} K=${K} h=${h}`).toBeLessThanOrEqual(best * (1 + 1e-6) + 1e-6);
        expect(res.annualCosts!.total).toBeGreaterThanOrEqual(best * (1 - 1e-3) - 1e-6);
        expect(close(tc(res.Q!), res.annualCosts!.total, 1e-6), `cost at reported Q ${tc(res.Q!)} vs ${res.annualCosts!.total}`).toBe(true);
      }
    }
  });

  it('holding as a fraction of price (all-units) reaches the brute-force minimum', () => {
    const r = seeded(24);
    for (let t = 0; t < 40; t++) {
      const nb = ri(r, 2, 4);
      const breaks: { minQty: number; price: number }[] = [];
      let q = 0, price = rf(r, 5, 30);
      for (let i = 0; i < nb; i++) { breaks.push({ minQty: q, price: Number(price.toFixed(2)) }); q += ri(r, 20, 400); price *= rf(r, 0.7, 0.98); }
      const D = rf(r, 200, 5000), K = rf(r, 10, 300), I = rf(r, 0.05, 0.4);
      const res = solveInventory({ model: 'discount', demand: D, setupCost: K, holdingCost: I, holdingIsRate: true, breaks, discountType: 'allUnits' });
      expect(res.error).toBeUndefined();
      const tc = (qq: number) => { let p = breaks[0]!.price; for (const b of breaks) if (qq >= b.minQty) p = b.price; return D * p + (K * D) / qq + (I * p * qq) / 2; };
      let best = Infinity;
      const qmax = (breaks[breaks.length - 1]!.minQty + 1) * 3 + 4 * Math.sqrt((2 * D * K) / (I * 5)) + 500;
      for (let i = 1; i <= 60000; i++) best = Math.min(best, tc((qmax * i) / 60000));
      for (const b of breaks) if (b.minQty > 0) best = Math.min(best, tc(b.minQty));
      expect(res.annualCosts!.total).toBeLessThanOrEqual(best * (1 + 1e-6));
      expect(close(tc(res.Q!), res.annualCosts!.total, 1e-6)).toBe(true);
    }
  });

  it('validates price breaks: duplicates, first break above 0, non-positive prices, prices that rise with quantity', () => {
    const base = { model: 'discount' as const, demand: 1000, setupCost: 50, holdingCost: 2 };
    expect(solveInventory({ ...base, breaks: [] }).error).toBeTruthy();
    expect(solveInventory({ ...base, breaks: [{ minQty: 0, price: 10 }, { minQty: 100, price: 9 }, { minQty: 100, price: 8 }] }).error).toMatch(/same|duplicate/i);
    expect(solveInventory({ ...base, breaks: [{ minQty: 0, price: 10 }, { minQty: 100, price: 0 }] }).error).toBeTruthy();
    expect(solveInventory({ ...base, breaks: [{ minQty: 0, price: 10 }, { minQty: -5, price: 9 }] }).error).toBeTruthy();
    expect(solveInventory({ ...base, breaks: [{ minQty: 0, price: NaN }] }).error).toBeTruthy();
    expect(solveInventory({ ...base, breaks: [{ minQty: Infinity, price: 5 }, { minQty: 0, price: 5 }] }).error).toBeTruthy();
    // the first break must start at 0 (or 1): otherwise the price of small orders is undefined
    expect(solveInventory({ ...base, breaks: [{ minQty: 50, price: 10 }, { minQty: 200, price: 9 }] }).error).toMatch(/first|start|0/i);
    // prices must not rise with quantity (that is not a discount schedule)
    expect(solveInventory({ ...base, breaks: [{ minQty: 0, price: 10 }, { minQty: 100, price: 12 }] }).error).toMatch(/price/i);
    // unsorted input is accepted and treated as sorted
    const a = solveInventory({ ...base, breaks: [{ minQty: 500, price: 8 }, { minQty: 0, price: 10 }, { minQty: 100, price: 9 }] });
    const b = solveInventory({ ...base, breaks: [{ minQty: 0, price: 10 }, { minQty: 100, price: 9 }, { minQty: 500, price: 8 }] });
    expect(a.error).toBeUndefined();
    expect(a.Q).toBe(b.Q);
    // a first break of 1 is allowed
    expect(solveInventory({ ...base, breaks: [{ minQty: 1, price: 10 }, { minQty: 100, price: 9 }] }).error).toBeUndefined();
  });

  /* ------- newsvendor ------- */
  it('newsvendor (discrete) picks the profit-maximising stock level by brute force', () => {
    const r = seeded(25);
    for (let t = 0; t < 40; t++) {
      const n = ri(r, 2, 7);
      const demands = Array.from({ length: n }, (_, i) => i * ri(r, 1, 5) + ri(r, 0, 3) + i).sort((a, b) => a - b).filter((v, i, a) => a.indexOf(v) === i);
      const raw = demands.map(() => rf(r, 0.1, 1));
      const tot = raw.reduce((a, b) => a + b, 0);
      const probs = raw.map(x => x / tot);
      const c = rf(r, 1, 10), p = c + rf(r, 0.5, 15), s = rf(r, 0, c * 0.9), g = r() < 0.4 ? rf(r, 0, 3) : 0;
      const res = solveInventory({ model: 'newsvendor', sellingPrice: p, unitCost: c, salvageValue: s, goodwill: g, demandDist: 'discrete', discrete: demands.map((d, i) => ({ demand: d, prob: probs[i]! })) });
      expect(res.error).toBeUndefined();
      const profit = (Q: number) => demands.reduce((acc, d, i) => acc + probs[i]! * (p * Math.min(Q, d) + s * Math.max(0, Q - d) - c * Q - g * Math.max(0, d - Q)), 0);
      let best = -Infinity;
      for (const Q of demands) best = Math.max(best, profit(Q));
      expect(close(profit(res.Q!), best, 1e-9), `profit(${res.Q})=${profit(res.Q!)} vs best ${best}`).toBe(true);
      expect(close(res.newsvendor!.expectedProfit, profit(res.Q!), 1e-9)).toBe(true);
    }
  });

  it('newsvendor (uniform and normal) matches numerical integration', () => {
    const r = seeded(26);
    for (let t = 0; t < 25; t++) {
      const c = rf(r, 1, 10), p = c + rf(r, 0.5, 15), s = rf(r, 0, c * 0.9), g = r() < 0.4 ? rf(r, 0, 3) : 0;
      const a = rf(r, 0, 50), b = a + rf(r, 5, 200);
      const u = solveInventory({ model: 'newsvendor', sellingPrice: p, unitCost: c, salvageValue: s, goodwill: g, demandDist: 'uniform', uniformMin: a, uniformMax: b });
      expect(u.error).toBeUndefined();
      const profitU = (Q: number) => { let acc = 0; const n = 4000; for (let i = 0; i < n; i++) { const d = a + ((b - a) * (i + 0.5)) / n; acc += p * Math.min(Q, d) + s * Math.max(0, Q - d) - c * Q - g * Math.max(0, d - Q); } return acc / n; };
      let best = -Infinity; for (let i = 0; i <= 2000; i++) best = Math.max(best, profitU(a + ((b - a) * i) / 2000));
      expect(close(profitU(u.Q!), best, 1e-4, 1e-4)).toBe(true);
      expect(close(u.newsvendor!.expectedProfit, profitU(u.Q!), 1e-4, 1e-4), `uniform profit ${u.newsvendor!.expectedProfit} vs ${profitU(u.Q!)}`).toBe(true);

      const mean = rf(r, 20, 300), sd = rf(r, 1, mean / 3);
      const nr = solveInventory({ model: 'newsvendor', sellingPrice: p, unitCost: c, salvageValue: s, goodwill: g, demandDist: 'normal', mean, stdDev: sd });
      expect(nr.error).toBeUndefined();
      const profitN = (Q: number) => { let acc = 0; const n = 6000, lo = mean - 8 * sd, w = (16 * sd) / n; for (let i = 0; i < n; i++) { const d = lo + (i + 0.5) * w; const dens = phi((d - mean) / sd) / sd; acc += dens * w * (p * Math.min(Q, d) + s * Math.max(0, Q - d) - c * Q - g * Math.max(0, d - Q)); } return acc; };
      let bestN = -Infinity; for (let i = -60; i <= 60; i++) bestN = Math.max(bestN, profitN(nr.Q! + (i * sd) / 60));
      expect(close(profitN(nr.Q!), bestN, 1e-6, 1e-4)).toBe(true);
      expect(close(nr.newsvendor!.expectedProfit, profitN(nr.Q!), 1e-4, 1e-3), `normal profit ${nr.newsvendor!.expectedProfit} vs ${profitN(nr.Q!)}`).toBe(true);
      expect(close(nr.newsvendor!.serviceLevel, Phi(nr.newsvendor!.z!), 1e-6, 1e-6)).toBe(true);
    }
  });

  it('newsvendor rejects bad probabilities and parameters', () => {
    const base: InventoryInput = { model: 'newsvendor', sellingPrice: 10, unitCost: 4, salvageValue: 1, demandDist: 'discrete', discrete: [{ demand: 10, prob: 0.5 }, { demand: 20, prob: 0.5 }] };
    expect(solveInventory(base).error).toBeUndefined();
    expect(solveInventory({ ...base, discrete: [{ demand: 10, prob: 0.5 }, { demand: 20, prob: 0.4 }] }).error).toMatch(/sum/);
    expect(solveInventory({ ...base, discrete: [{ demand: 10, prob: 1.5 }, { demand: 20, prob: -0.5 }] }).error).toBeTruthy();
    expect(solveInventory({ ...base, discrete: [{ demand: 10, prob: NaN }, { demand: 20, prob: 0.5 }] }).error).toBeTruthy();
    expect(solveInventory({ ...base, discrete: [{ demand: -10, prob: 0.5 }, { demand: 20, prob: 0.5 }] }).error).toBeTruthy();
    expect(solveInventory({ ...base, discrete: [{ demand: NaN, prob: 0.5 }, { demand: 20, prob: 0.5 }] }).error).toBeTruthy();
    expect(solveInventory({ ...base, goodwill: -3 }).error).toBeTruthy();
    expect(solveInventory({ ...base, sellingPrice: 4 }).error).toBeTruthy();
    expect(solveInventory({ ...base, salvageValue: 4 }).error).toBeTruthy();
    expect(solveInventory({ ...base, salvageValue: -1 }).error).toBeTruthy();
    expect(solveInventory({ model: 'newsvendor', sellingPrice: 10, unitCost: 4, demandDist: 'normal', mean: 100, stdDev: -1 }).error).toBeTruthy();
    expect(solveInventory({ model: 'newsvendor', sellingPrice: 10, unitCost: 4, demandDist: 'normal', mean: 100, stdDev: NaN }).error).toBeTruthy();
    expect(solveInventory({ model: 'newsvendor', sellingPrice: 10, unitCost: 4, demandDist: 'uniform', uniformMin: -5, uniformMax: 20 }).error).toBeTruthy();
    expect(solveInventory({ model: 'newsvendor', sellingPrice: 10, unitCost: 4, demandDist: 'uniform', uniformMin: 20, uniformMax: 20 }).error).toBeTruthy();
    expect(solveInventory({ model: 'newsvendor', sellingPrice: Infinity, unitCost: 4, demandDist: 'normal', mean: 100, stdDev: 5 }).error).toBeTruthy();
    // zero standard deviation is a legitimate deterministic demand
    const det = solveInventory({ model: 'newsvendor', sellingPrice: 10, unitCost: 4, demandDist: 'normal', mean: 100, stdDev: 0 });
    expect(det.error).toBeUndefined();
    expect(close(det.Q!, 100, 1e-9)).toBe(true);
  });
});

/* ======================================================================= */
/* 3. ZERO-SUM GAMES                                                       */
/* ======================================================================= */

const RM = (rows: number[][]) => rows.map(r => r.map(x => Rational.of(x)));

/** Value of a zero-sum game by vertex (support) enumeration: max over basic feasible strategies of min_j (xA)_j. */
function gameValueOracle(A: number[][]): number {
  const m = A.length, n = A[0]!.length;
  let best = -Infinity;
  const subsets = (len: number, k: number): number[][] => {
    const out: number[][] = [];
    const rec = (start: number, cur: number[]) => { if (cur.length === k) { out.push([...cur]); return; } for (let i = start; i < len; i++) { cur.push(i); rec(i + 1, cur); cur.pop(); } };
    rec(0, []);
    return out;
  };
  for (let k = 1; k <= Math.min(m, n); k++) {
    for (const I of subsets(m, k)) for (const J of subsets(n, k)) {
      // unknowns x_I (k) and v: Σ_i x_i A_ij − v = 0 (j in J), Σ x_i = 1
      const M: number[][] = [];
      for (const j of J) M.push([...I.map(i => A[i]![j]!), -1, 0]);
      M.push([...I.map(() => 1), 0, 1]);
      const d = k + 1;
      let ok = true;
      for (let c = 0; c < d && ok; c++) {
        let p = c;
        for (let r = c + 1; r < d; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
        if (Math.abs(M[p]![c]!) < 1e-12) { ok = false; break; }
        [M[c], M[p]] = [M[p]!, M[c]!];
        for (let r = 0; r < d; r++) { if (r === c) continue; const f = M[r]![c]! / M[c]![c]!; for (let q = c; q <= d; q++) M[r]![q]! -= f * M[c]![q]!; }
      }
      if (!ok) continue;
      const sol = M.map((row, i) => row[d]! / row[i]!);
      const x = sol.slice(0, k);
      if (x.some(v => v < -1e-12)) continue;
      const full = Array(m).fill(0); I.forEach((i, a) => (full[i] = Math.max(0, x[a]!)));
      let worst = Infinity;
      for (let j = 0; j < n; j++) worst = Math.min(worst, full.reduce((s, xi, i) => s + xi * A[i]![j]!, 0));
      best = Math.max(best, worst);
    }
  }
  return best;
}

describe('zero-sum game audit', () => {
  const check = (A: number[][]) => {
    const res = solveZeroSumGame({ payoff: RM(A) });
    expect(res.error).toBeUndefined();
    const v = res.gameValue.toNumber();
    expect(close(v, gameValueOracle(A), 1e-9, 1e-9), `${JSON.stringify(A)} value ${v} vs ${gameValueOracle(A)}`).toBe(true);
    // strategies are probability vectors that guarantee the value against every pure counter-strategy (exact)
    for (const x of res.playerAStrategy) expect(x.isNegative()).toBe(false);
    for (const y of res.playerBStrategy) expect(y.isNegative()).toBe(false);
    expect(res.playerAStrategy.reduce((a, b) => a.add(b), Rational.ZERO).eq(Rational.ONE)).toBe(true);
    expect(res.playerBStrategy.reduce((a, b) => a.add(b), Rational.ZERO).eq(Rational.ONE)).toBe(true);
    const n = A[0]!.length, m = A.length;
    for (let j = 0; j < n; j++) expect(res.playerAStrategy.reduce((s, x, i) => s.add(x.mul(Rational.of(A[i]![j]!))), Rational.ZERO).gte(res.gameValue), `row strategy vs column ${j}`).toBe(true);
    for (let i = 0; i < m; i++) expect(res.playerBStrategy.reduce((s, y, j) => s.add(y.mul(Rational.of(A[i]![j]!))), Rational.ZERO).lte(res.gameValue), `column strategy vs row ${i}`).toBe(true);
    expect(res.verified).toBe(true);
    // dominance reduction preserves the value
    const sub = res.reducedRows.map(i => res.reducedCols.map(j => A[i]![j]!));
    expect(close(gameValueOracle(sub), v, 1e-9, 1e-9), `reduced game value`).toBe(true);
    // graphical method (when used) agrees with the oracle
    if (res.graphical) expect(res.graphical.value.toNumber()).toBeCloseTo(gameValueOracle(sub), 9);
    return res;
  };

  it('random games with integer payoffs (including negative and heavy ties)', () => {
    const r = seeded(31);
    for (let t = 0; t < 250; t++) {
      const m = ri(r, 1, 5), n = ri(r, 1, 5);
      const range = t % 3 === 0 ? [-1, 1] : t % 3 === 1 ? [-9, 9] : [-30, -2];
      check(Array.from({ length: m }, () => Array.from({ length: n }, () => ri(r, range[0]!, range[1]!))));
    }
  });

  it('degenerate shapes: 1x1, 1xn, mx1, constant matrices, duplicate rows and columns', () => {
    check([[7]]);
    check([[-3]]);
    check([[0]]);
    check([[3, -1, 4, 1, 5]]);
    check([[3], [-1], [4]]);
    check([[2, 2, 2], [2, 2, 2]]);
    check([[-5, -5], [-5, -5], [-5, -5]]);
    check([[1, 2], [1, 2], [1, 2]]);
    check([[3, 3, 1], [3, 3, 1]]);
    check([[0, 0], [0, 0]]);
    const r = check([[4, 4, 5], [3, 4, 4], [4, 4, 4]]);
    expect(r.hasSaddlePoint).toBe(true);
    expect(r.saddlePoints.length).toBeGreaterThan(1);
  });

  it('saddle points: every reported saddle is a row minimum and a column maximum, and none is missed', () => {
    const r = seeded(32);
    for (let t = 0; t < 100; t++) {
      const m = ri(r, 1, 5), n = ri(r, 1, 5);
      const A = Array.from({ length: m }, () => Array.from({ length: n }, () => ri(r, -3, 3)));
      const res = solveZeroSumGame({ payoff: RM(A) });
      const expected: string[] = [];
      for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) if (A[i]![j] === Math.min(...A[i]!) && A[i]![j] === Math.max(...A.map(row => row[j]!))) expected.push(`${i},${j}`);
      expect(res.saddlePoints.map(s => `${s.row},${s.col}`).sort()).toEqual(expected.sort());
      expect(res.hasSaddlePoint).toBe(expected.length > 0);
      if (expected.length) expect(res.gameValue.toNumber()).toBe(A[Number(expected[0]!.split(',')[0])]![Number(expected[0]!.split(',')[1])]);
    }
  });

  it('2×n and m×2 games use the graphical method and agree with the oracle', () => {
    const r = seeded(33);
    let usedGraphical = 0;
    for (let t = 0; t < 120; t++) {
      const wide = t % 2 === 0, k = ri(r, 2, 6);
      const A = wide ? Array.from({ length: 2 }, () => Array.from({ length: k }, () => ri(r, -9, 9))) : Array.from({ length: k }, () => Array.from({ length: 2 }, () => ri(r, -9, 9)));
      const res = check(A);
      if (res.graphical) usedGraphical++;
    }
    expect(usedGraphical).toBeGreaterThan(20);
  });

  it('rejects empty and ragged matrices without throwing', () => {
    expect(solveZeroSumGame({ payoff: [] }).error).toBeTruthy();
    expect(solveZeroSumGame({ payoff: [[]] }).error).toBeTruthy();
    expect(solveZeroSumGame({ payoff: [[Rational.ONE], [Rational.ONE, Rational.ZERO]] }).error).toBeTruthy();
  });
});

/* ======================================================================= */
/* 4. MARKOV CHAINS                                                        */
/* ======================================================================= */

function randomChain(r: () => number, n: number, density: number, den = 12): number[][] {
  // rows are integer weights / den with each row summing to den
  return Array.from({ length: n }, () => {
    const w = Array(n).fill(0);
    let left = den;
    const targets = Array.from({ length: n }, (_, j) => j).filter(() => r() < density);
    if (!targets.length) targets.push(ri(r, 0, n - 1));
    for (const j of targets.slice(0, -1)) { const x = ri(r, 0, left); w[j] += x; left -= x; }
    w[targets[targets.length - 1]!] += left;
    return w;
  });
}
const toR = (W: number[][], den: number) => W.map(row => row.map(x => Rational.of(x, den)));

function reachability(W: number[][]): boolean[][] {
  const n = W.length;
  const R = W.map((row, i) => row.map((x, j) => i === j || x > 0));
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (R[i]![k] && R[k]![j]) R[i]![j] = true;
  return R;
}
function gcdN(a: number, b: number): number { return b === 0 ? a : gcdN(b, a % b); }

describe('markov audit', () => {
  const DEN = 12;
  it('n-step transition matrix equals repeated multiplication (n = 0 is the identity)', () => {
    const r = seeded(41);
    for (let t = 0; t < 40; t++) {
      const n = ri(r, 1, 5), W = randomChain(r, n, 0.6, DEN), steps = ri(r, 0, 9);
      const res = solveMarkovChain({ transitionMatrix: toR(W, DEN) }, steps);
      expect(res.error).toBeUndefined();
      let M: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
      for (let s = 0; s < steps; s++) M = M.map((row, i) => row.map((_, j) => row.reduce((acc: number, _x, k) => acc + M[i]![k]! * (W[k]![j]! / DEN), 0)));
      res.nStep!.matrix.forEach((row, i) => row.forEach((v, j) => expect(v.toNumber(), `P^${steps}[${i}][${j}]`).toBeCloseTo(M[i]![j]!, 9)));
      // distribution after n steps from a start distribution
      const init = Array.from({ length: n }, (_, i) => Rational.of(i === 0 ? 1 : 0));
      const withInit = solveMarkovChain({ transitionMatrix: toR(W, DEN), initialDistribution: init }, steps);
      withInit.nStep!.distribution!.forEach((v, j) => expect(v.toNumber()).toBeCloseTo(M[0]![j]!, 9));
    }
  });

  it('steady state solves pi P = pi, sums to 1, is non-negative (irreducible and reducible chains)', () => {
    const r = seeded(42);
    for (let t = 0; t < 200; t++) {
      const n = ri(r, 1, 6), W = randomChain(r, n, 0.2 + 0.6 * r(), DEN);
      const P = toR(W, DEN);
      const res = solveMarkovChain({ transitionMatrix: P });
      expect(res.error).toBeUndefined();
      const pi = res.steadyState?.distribution;
      expect(pi, JSON.stringify(W)).toBeDefined();
      expect(pi!.reduce((a, b) => a.add(b), Rational.ZERO).eq(Rational.ONE)).toBe(true);
      pi!.forEach(x => expect(x.isNegative()).toBe(false));
      for (let j = 0; j < n; j++) expect(pi!.reduce((s, x, i) => s.add(x.mul(P[i]![j]!)), Rational.ZERO).eq(pi![j]!), `column ${j} of ${JSON.stringify(W)}`).toBe(true);
    }
  });

  it('classification of classes, closedness and period matches a brute-force oracle', () => {
    const r = seeded(43);
    for (let t = 0; t < 200; t++) {
      const n = ri(r, 1, 6), W = randomChain(r, n, 0.1 + 0.4 * r(), DEN);
      const res = solveMarkovChain({ transitionMatrix: toR(W, DEN) });
      const R = reachability(W);
      const seen = new Set<number>();
      const classes: { states: number[]; closed: boolean; period: number }[] = [];
      for (let i = 0; i < n; i++) {
        if (seen.has(i)) continue;
        const states = Array.from({ length: n }, (_, j) => j).filter(j => R[i]![j] && R[j]![i]);
        states.forEach(s => seen.add(s));
        const closed = states.every(a => W[a]!.every((x, b) => x === 0 || states.includes(b)));
        // period: gcd of the lengths ℓ ≤ 3n² with (P^ℓ)_ii > 0 for some i in the class
        let g = 0;
        let Pk = W.map(row => row.map(x => x > 0));
        for (let len = 1; len <= 3 * n * n && g !== 1; len++) {
          if (states.some(s => Pk[s]![s])) g = gcdN(g, len);
          Pk = Pk.map((row, a) => row.map((_, b) => W.some((_, k) => Pk[a]![k]! && W[k]![b]! > 0)));
        }
        classes.push({ states, closed, period: g || 1 });
      }
      const key = (c: { states: number[] }) => c.states.join(',');
      expect(res.classes.map(c => ({ states: [...c.states].sort((a, b) => a - b), closed: c.closed })).sort((a, b) => key(a).localeCompare(key(b)))).toEqual(classes.map(c => ({ states: c.states, closed: c.closed })).sort((a, b) => key(a).localeCompare(key(b))));
      for (const c of classes) if (c.closed) expect(res.classes.find(x => x.states.includes(c.states[0]!))!.period, `period of ${JSON.stringify(W)}`).toBe(c.period);
      expect(res.irreducible).toBe(classes.length === 1);
      expect(res.periodic).toBe(classes.some(c => c.closed && c.period > 1));
    }
  });

  it('known chains: periodic, absorbing, reducible, 1-state', () => {
    const cyc = solveMarkovChain({ transitionMatrix: RM([[0, 1, 0], [0, 0, 1], [1, 0, 0]]) });
    expect(cyc.period).toBe(3);
    expect(cyc.periodic).toBe(true);
    expect(cyc.steadyState!.limiting).toBe(false);
    const one = solveMarkovChain({ transitionMatrix: RM([[1]]) });
    expect(one.error).toBeUndefined();
    expect(one.steadyState!.distribution.map(String)).toEqual(['1']);
    expect(one.irreducible).toBe(true);
    expect(one.period).toBe(1);
    expect(one.firstPassage![0]![0]!.toString()).toBe('1');
    const lazy = solveMarkovChain({ transitionMatrix: RM([[1, 0], [1, 0]]) });
    expect(lazy.classes.filter(c => c.closed)).toHaveLength(1);
    expect(lazy.steadyState!.distribution.map(String)).toEqual(['1', '0']);
    expect(lazy.steadyState!.limiting).toBe(true);
  });

  it('absorbing analysis: N(I−Q) = I, absorption probabilities sum to 1, expected steps = row sums of N', () => {
    const r = seeded(44);
    let seenAbsorbing = 0;
    for (let t = 0; t < 150; t++) {
      const n = ri(r, 2, 6), W = randomChain(r, n, 0.5, DEN);
      // force at least one absorbing state and make state 0 absorbing
      W[0] = Array(n).fill(0); W[0]![0] = DEN;
      const P = toR(W, DEN);
      const res = solveMarkovChain({ transitionMatrix: P });
      const ab = res.absorbing!;
      expect(ab.absorbingStates).toContain(0);
      if (!ab.fundamental) continue; // some transient state cannot reach absorption: reported, not asserted here
      seenAbsorbing++;
      const T = ab.transientStates, A = ab.absorbingStates;
      const N = ab.fundamental, B = ab.absorptionProbabilities!, steps = ab.expectedSteps!;
      T.forEach((ti, a) => {
        T.forEach((tj, b) => {
          // (N (I − Q))_ab = δ_ab
          let acc = Rational.ZERO;
          T.forEach((tk, k) => { acc = acc.add(N[a]![k]!.mul((k === b ? Rational.ONE : Rational.ZERO).sub(P[tk]![tj]!))); });
          expect(acc.eq(a === b ? Rational.ONE : Rational.ZERO), `N(I−Q) at ${ti},${tj}`).toBe(true);
        });
        expect(B[a]!.reduce((x, y) => x.add(y), Rational.ZERO).eq(Rational.ONE), 'absorption probabilities sum to 1').toBe(true);
        B[a]!.forEach(x => expect(x.isNegative()).toBe(false));
        expect(steps[a]!.eq(N[a]!.reduce((x, y) => x.add(y), Rational.ZERO))).toBe(true);
        // first-step recurrence for the absorption probability: B_i,j = P_ij + Σ_k∈T P_ik B_k,j
        A.forEach((aj, jj) => {
          let rhs = P[ti]![aj]!;
          T.forEach((tk, k) => { rhs = rhs.add(P[ti]![tk]!.mul(B[k]![jj]!)); });
          expect(rhs.eq(B[a]![jj]!)).toBe(true);
        });
        // first-step recurrence for the expected time: t_i = 1 + Σ_k∈T P_ik t_k
        let tt = Rational.ONE;
        T.forEach((tk, k) => { tt = tt.add(P[ti]![tk]!.mul(steps[k]!)); });
        expect(tt.eq(steps[a]!)).toBe(true);
      });
    }
    expect(seenAbsorbing).toBeGreaterThan(30);
  });

  it('mean first-passage times satisfy m_ij = 1 + Σ_k≠j p_ik m_kj and m_jj = 1/pi_j', () => {
    const r = seeded(45);
    let irreducibleSeen = 0;
    for (let t = 0; t < 150; t++) {
      const n = ri(r, 1, 6), W = randomChain(r, n, 0.8, DEN);
      const P = toR(W, DEN);
      const res = solveMarkovChain({ transitionMatrix: P });
      if (!res.irreducible) { expect(res.firstPassage).toBeUndefined(); continue; }
      irreducibleSeen++;
      const m = res.firstPassage!, pi = res.steadyState!.distribution;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        let rhs = Rational.ONE;
        for (let k = 0; k < n; k++) if (k !== j) rhs = rhs.add(P[i]![k]!.mul(m[k]![j]!));
        expect(rhs.eq(m[i]![j]!), `m[${i}][${j}] of ${JSON.stringify(W)}`).toBe(true);
      }
      for (let j = 0; j < n; j++) expect(m[j]![j]!.mul(pi[j]!).eq(Rational.ONE)).toBe(true);
    }
    expect(irreducibleSeen).toBeGreaterThan(40);
  });

  it('rejects non-stochastic input with a clear message and never throws', () => {
    const R1 = (rows: string[][]) => rows.map(r => r.map(x => Rational.parse(x)));
    expect(solveMarkovChain({ transitionMatrix: [] }).error).toMatch(/empty/);
    expect(solveMarkovChain({ transitionMatrix: R1([['0.5', '0.5'], ['1']]) }).error).toMatch(/square/);
    expect(solveMarkovChain({ transitionMatrix: R1([['0.5', '0.5', '0'], ['0.5', '0.5', '0']]) }).error).toMatch(/square/);
    expect(solveMarkovChain({ transitionMatrix: R1([['1.5', '-0.5'], ['0.5', '0.5']]) }).error).toMatch(/negative/);
    expect(solveMarkovChain({ transitionMatrix: R1([['0.5', '0.6'], ['0.5', '0.5']]) }).error).toMatch(/Row 1 sums to 11\/10/);
    expect(solveMarkovChain({ transitionMatrix: R1([['0', '0'], ['0.5', '0.5']]) }).error).toMatch(/Row 1 sums to 0/);
    expect(solveMarkovChain({ transitionMatrix: R1([['0.5', '0.5'], ['0.5', '0.5']]), initialDistribution: R1([['0.5', '0.6']])[0]! }).error).toMatch(/initial/);
    for (const bad of [-1, 1.5, NaN, 501, Infinity]) expect(solveMarkovChain({ transitionMatrix: R1([['0.5', '0.5'], ['0.5', '0.5']]) }, bad).error).toBeTruthy();
  });
});

/* ======================================================================= */
/* 5. SIMULATION                                                           */
/* ======================================================================= */

function moments(d: Distribution, n: number, seed: number, kind: 'lcg' | 'mt' = 'mt') {
  const rng = makeRng(kind, seed);
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const x = sample(d, rng); s += x; s2 += x * x; }
  const mean = s / n;
  return { mean, variance: s2 / n - mean * mean };
}

describe('simulation audit', () => {
  it('Mersenne Twister reproduces the reference sequence for seed 5489', () => {
    const mt = new MersenneTwister(5489);
    expect([mt.nextUint32(), mt.nextUint32(), mt.nextUint32()]).toEqual([3499211612, 581869302, 3890346734]);
  });

  it('Park–Miller LCG reproduces the reference value (seed 1, 10000th draw = 1043618065)', () => {
    const g = new LcgRng(1);
    let x = 0;
    for (let i = 0; i < 10000; i++) x = Math.round(g.next() * 2147483647);
    expect(x).toBe(1043618065);
  });

  it('generators stay strictly inside (0,1) for any seed, including NaN, Infinity, negative and huge', () => {
    for (const seed of [0, 1, -7, 3.9, NaN, Infinity, -Infinity, 1e308, 2147483647, 4294967296, 2 ** 53]) {
      for (const kind of ['lcg', 'mt'] as const) {
        const g = makeRng(kind, seed);
        for (let i = 0; i < 2000; i++) { const u = g.next(); expect(u > 0 && u < 1, `${kind} seed ${seed} draw ${i} = ${u}`).toBe(true); }
      }
    }
  });

  it('is reproducible: the same seed gives identical results, a different seed does not', () => {
    const input = { variables: [{ name: 'x', dist: { type: 'normal', mean: 5, sd: 2 } as Distribution }], expression: 'x*x', trials: 5000, seed: 77, generator: 'mt' as const };
    for (const generator of ['mt', 'lcg'] as const) {
      const a = runMonteCarlo({ ...input, generator }), b = runMonteCarlo({ ...input, generator }), c = runMonteCarlo({ ...input, generator, seed: 78 });
      expect(a.samples).toEqual(b.samples);
      expect(a.mean).toBe(b.mean);
      expect(a.samples).not.toEqual(c.samples);
    }
    const q = { interarrival: { type: 'exponential', rate: 1 } as Distribution, service: { type: 'exponential', rate: 1.5 } as Distribution, servers: 1, customers: 2000, seed: 5, generator: 'mt' as const };
    expect(runQueueSimulation(q).customers).toEqual(runQueueSimulation(q).customers);
  });

  it('sample means and variances match theory within statistical tolerance', () => {
    const n = 200000;
    const cases: [Distribution, number, number][] = [
      [{ type: 'uniform', a: -2, b: 6 }, 2, 64 / 12],
      [{ type: 'exponential', rate: 2.5 }, 0.4, 0.16],
      [{ type: 'normal', mean: 3, sd: 1.7 }, 3, 1.7 * 1.7],
      [{ type: 'triangular', a: 0, m: 2, b: 10 }, 4, (0 + 4 + 100 - 0 - 0 - 20) / 18],
      [{ type: 'triangular', a: 1, m: 1, b: 5 }, 7 / 3, (1 + 1 + 25 - 1 - 5 - 5) / 18],
      [{ type: 'poisson', mean: 0.7 }, 0.7, 0.7],
      [{ type: 'poisson', mean: 6 }, 6, 6],
      [{ type: 'poisson', mean: 45 }, 45, 45],
      [{ type: 'poisson', mean: 1500 }, 1500, 1500],
      [{ type: 'poisson', mean: 1e6 }, 1e6, 1e6],
      [{ type: 'discrete', values: [1, 4, 10], probs: [0.2, 0.5, 0.3] }, 5.2, 0.2 * 1 + 0.5 * 16 + 0.3 * 100 - 5.2 * 5.2],
      [{ type: 'constant', value: 3.5 }, 3.5, 0],
    ];
    for (const kind of ['mt', 'lcg'] as const) {
      for (const [d, mean, variance] of cases) {
        const m = moments(d, n, 123, kind);
        const seMean = Math.sqrt(variance / n) || 1e-12;
        expect(Math.abs(m.mean - mean), `${kind} ${JSON.stringify(d)} mean ${m.mean} vs ${mean}`).toBeLessThanOrEqual(5 * seMean + 1e-12);
        expect(Math.abs(m.variance - variance), `${kind} ${JSON.stringify(d)} variance ${m.variance} vs ${variance}`).toBeLessThanOrEqual(0.04 * variance + 1e-9);
      }
    }
  });

  it('Poisson counts are integers, non-negative, and the zero-class frequency matches exp(-mean)', () => {
    const rng = makeRng('mt', 9);
    for (const mean of [0.3, 3, 25, 800]) {
      let zeros = 0;
      for (let i = 0; i < 40000; i++) { const k = sample({ type: 'poisson', mean }, rng); expect(Number.isInteger(k) && k >= 0).toBe(true); if (k === 0) zeros++; }
      const p = Math.exp(-mean);
      expect(Math.abs(zeros / 40000 - p)).toBeLessThan(4 * Math.sqrt((p * (1 - p)) / 40000) + 1e-9);
    }
  });

  it('distribution validation rejects non-finite and impossible parameters', () => {
    const bad: Distribution[] = [
      { type: 'uniform', a: 3, b: 3 }, { type: 'uniform', a: NaN, b: 3 }, { type: 'uniform', a: 0, b: Infinity },
      { type: 'exponential', rate: 0 }, { type: 'exponential', rate: -1 }, { type: 'exponential', rate: NaN }, { type: 'exponential', rate: Infinity },
      { type: 'normal', mean: NaN, sd: 1 }, { type: 'normal', mean: 0, sd: -1 }, { type: 'normal', mean: 0, sd: Infinity }, { type: 'normal', mean: Infinity, sd: 1 },
      { type: 'triangular', a: 0, m: 5, b: 3 }, { type: 'triangular', a: 2, m: 2, b: 2 }, { type: 'triangular', a: NaN, m: 1, b: 2 },
      { type: 'poisson', mean: 0 }, { type: 'poisson', mean: -2 }, { type: 'poisson', mean: NaN }, { type: 'poisson', mean: Infinity },
      { type: 'discrete', values: [], probs: [] }, { type: 'discrete', values: [1, 2], probs: [0.5] }, { type: 'discrete', values: [1, 2], probs: [0.5, 0.4] },
      { type: 'discrete', values: [1, 2], probs: [1.5, -0.5] }, { type: 'discrete', values: [1, NaN], probs: [0.5, 0.5] }, { type: 'discrete', values: [1, 2], probs: [NaN, 0.5] },
      { type: 'constant', value: NaN }, { type: 'constant', value: Infinity },
    ];
    for (const d of bad) expect(validateDistribution(d), JSON.stringify(d)).toBeTruthy();
    for (const d of [{ type: 'normal', mean: 0, sd: 0 }, { type: 'constant', value: -4 }, { type: 'uniform', a: -1, b: 1 }] as Distribution[]) expect(validateDistribution(d)).toBeNull();
  });

  /* ---------------- expression evaluator ---------------- */
  const ev = (src: string, env: Record<string, number> = {}) => compileExpression(src, Object.keys(env))(env);

  it('expression parser: precedence, associativity, unary minus, functions, comparisons', () => {
    const table: [string, number][] = [
      ['1 + 2 * 3', 7], ['(1 + 2) * 3', 9], ['2 * 3 + 4', 10], ['10 - 4 - 3', 3], ['100 / 10 / 5', 2], ['2 ^ 3 ^ 2', 512], ['-2 ^ 2', -4], ['2 ^ -1', 0.5],
      ['--3', 3], ['3 - -2', 5], ['-(1 + 2)', -3], ['+4', 4], ['2 * -3', -6], ['-2 * -3', 6], ['1 - 2 + 3', 2], ['8 / 2 * 4', 16], ['2 * 3 ^ 2', 18],
      ['sqrt(16) + abs(-3)', 7], ['max(1, 5, 3)', 5], ['min(4, 2)', 2], ['floor(2.7) + ceil(2.1)', 5], ['round(2.5)', 3], ['pow(2, 10)', 1024], ['exp(0) + ln(1)', 1],
      ['step(-1) + step(0) + step(2)', 2], ['pi', Math.PI], ['1e3 + 2.5e-1', 1000.25], ['.5 + 0.5', 1],
      ['2 < 3', 1], ['3 < 2', 0], ['3 <= 3', 1], ['3 >= 4', 0], ['4 > 3', 1], ['1 + 1 > 1', 1], ['(2 > 1) + (3 > 2)', 2], ['max(1, 2 > 1)', 1],
    ];
    for (const [src, want] of table) expect(ev(src), src).toBeCloseTo(want, 10);
    expect(ev('x * y - z / 2', { x: 3, y: 4, z: 6 })).toBe(9);
    expect(ev('pi * pi', { pi: 5 }), 'a variable may shadow a constant').toBe(25);
    expect(ev('e1 + e2', { e1: 1, e2: 2 })).toBe(3);
  });

  it('expression parser: errors are Error objects with a message, never silent wrong answers', () => {
    for (const src of ['', '   ', '1 +', '* 2', '(1 + 2', '1 + 2)', '1 2', 'foo', 'foo(1)', 'sqrt(', 'sqrt(1,', '1..2', '2 $ 3', '1 = 2', '1 ? 2 : 3', 'x y', '3 3', '1 + * 2', 'sin 3', '((', '1e', '1e+', '5 >', '< 5', ',', 'max(,)', 'constructor(1)', 'toString()', '__proto__(1)']) {
      let threw: unknown = null;
      try { compileExpression(src, ['x']); } catch (e) { threw = e; }
      expect(threw, `"${src}" should be rejected`).toBeInstanceOf(Error);
      expect((threw as Error).message.length).toBeGreaterThan(0);
    }
  });

  it('expression parser: variables named like object internals are ordinary variables', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const res = runMonteCarlo({ variables: [{ name, dist: { type: 'uniform', a: 1, b: 2 } }], expression: `${name} + 1`, trials: 200, seed: 1, generator: 'mt' });
      expect(res.error, name).toBeUndefined();
      expect(res.mean, name).toBeGreaterThan(2);
      expect(res.mean, name).toBeLessThan(3);
    }
  });

  it('runMonteCarlo never throws on hostile expressions, trial counts, bins or variable names', () => {
    const u: Distribution = { type: 'uniform', a: 0, b: 1 };
    const base = { variables: [{ name: 'x', dist: u }], expression: 'x', trials: 50, seed: 1, generator: 'mt' as const };
    const exprs = ['', '1/0', '0/0', 'ln(0)', 'ln(-1)', 'sqrt(-1)', 'x^1000000', '(((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((((x)))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))', '-'.repeat(5000) + 'x', 'x+'.repeat(1500) + 'x', 'a'.repeat(100000), '1e308*10', 'exp(1000)', '\u0000', '😀', 'x ; 1', 'x\n+\n1', `x${'*1'.repeat(900)}`];
    for (const expression of exprs) {
      let res: ReturnType<typeof runMonteCarlo> | undefined;
      expect(() => { res = runMonteCarlo({ ...base, expression }); }, expression.slice(0, 40)).not.toThrow();
      if (res!.error) expect(res!.error.length).toBeGreaterThan(5);
      else expect(Number.isFinite(res!.mean)).toBe(true);
    }
    for (const trials of [0, -1, NaN, Infinity, 2_000_001, 0.5]) {
      let res: ReturnType<typeof runMonteCarlo> | undefined;
      expect(() => { res = runMonteCarlo({ ...base, trials }); }).not.toThrow();
      expect(res!.error ?? '', `trials=${trials}`).toBeTruthy();
    }
    for (const bins of [NaN, -5, 0, 1, 1e9, Infinity]) {
      const res = runMonteCarlo({ ...base, bins });
      expect(res.error).toBeUndefined();
      expect(res.histogram.reduce((a, b) => a + b.count, 0)).toBe(50);
    }
    for (const name of ['', '1x', 'a b', 'a-b', 'é', 'x'.repeat(10)]) {
      const res = runMonteCarlo({ ...base, variables: [{ name, dist: u }], expression: 'x' });
      if (name === 'x'.repeat(10)) expect(res.error).toContain('Unknown variable'); else expect(res.error).toBeTruthy();
    }
    const dup = runMonteCarlo({ ...base, variables: [{ name: 'x', dist: u }, { name: 'x', dist: { type: 'uniform', a: 5, b: 6 } }] });
    expect(dup.error).toMatch(/duplicate|twice|more than once/i);
    const res = runMonteCarlo({ ...base, variables: [{ name: 'x', dist: { type: 'normal', mean: NaN, sd: 1 } }] });
    expect(res.error).toBeTruthy();
    expect(runMonteCarlo({ ...base, seed: NaN }).error).toBeUndefined();
    expect(Number.isFinite(runMonteCarlo({ ...base, seed: NaN, generator: 'lcg' }).mean)).toBe(true);
  });

  it('the 95% confidence interval covers the true mean in at least 93% of 200 seeded runs', () => {
    // E[a*b + c] = 2 * 3 + 5 = 11 for independent a ~ U(1,3), b ~ Exp(1/ (3/2)) with mean 1.5 … keep it simple and exact:
    // a ~ U(1,3) mean 2, b ~ triangular(0,3,6) mean 3, c ~ Poisson(5) mean 5  => 2*3 + 5 = 11
    let covered = 0;
    const runs = 200;
    for (let i = 0; i < runs; i++) {
      const res = runMonteCarlo({
        variables: [{ name: 'a', dist: { type: 'uniform', a: 1, b: 3 } }, { name: 'b', dist: { type: 'triangular', a: 0, m: 3, b: 6 } }, { name: 'c', dist: { type: 'poisson', mean: 5 } }],
        expression: 'a * b + c', trials: 400, seed: 1000 + i, generator: i % 2 ? 'mt' : 'lcg',
      });
      expect(res.error).toBeUndefined();
      if (res.ci95[0] <= 11 && 11 <= res.ci95[1]) covered++;
      expect(res.ci95[0]).toBeLessThanOrEqual(res.mean);
      expect(res.ci95[1]).toBeGreaterThanOrEqual(res.mean);
    }
    expect(covered / runs).toBeGreaterThanOrEqual(0.93);
  });

  it('Monte Carlo summary statistics are consistent (min ≤ percentiles ≤ max, histogram counts, threshold probability)', () => {
    const res = runMonteCarlo({ variables: [{ name: 'x', dist: { type: 'normal', mean: 10, sd: 3 } }], expression: 'x', trials: 20000, seed: 3, generator: 'mt', threshold: 10, bins: 25 });
    expect(res.histogram).toHaveLength(25);
    expect(res.histogram.reduce((a, b) => a + b.count, 0)).toBe(20000);
    const ps = res.percentiles.map(p => p.value);
    expect([...ps].sort((a, b) => a - b)).toEqual(ps);
    expect(res.min).toBeLessThanOrEqual(ps[0]!); expect(ps[ps.length - 1]!).toBeLessThanOrEqual(res.max);
    expect(res.probAtLeast!).toBeGreaterThan(0.48); expect(res.probAtLeast!).toBeLessThan(0.52);
    const sorted = [...res.samples].sort((a, b) => a - b);
    expect(res.median).toBe(sorted[10000]);
    const mean = res.samples.reduce((a, b) => a + b, 0) / res.samples.length;
    expect(res.mean).toBeCloseTo(mean, 9);
    const sd = Math.sqrt(res.samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (res.samples.length - 1));
    expect(res.stdDev).toBeCloseTo(sd, 7);
    // constant expression: zero variance, single-bin histogram
    const k = runMonteCarlo({ variables: [{ name: 'x', dist: { type: 'constant', value: 2 } }], expression: 'x * 3', trials: 100, seed: 3, generator: 'lcg' });
    expect(k.mean).toBe(6); expect(k.stdDev).toBe(0); expect(k.histogram.reduce((a, b) => a + b.count, 0)).toBe(100);
    expect(runMonteCarlo({ variables: [{ name: 'x', dist: { type: 'constant', value: 2 } }], expression: 'x', trials: 1, seed: 3, generator: 'lcg' }).error).toBeUndefined();
  });

  /* ---------------- queue discrete-event simulation ---------------- */
  it('queue DES: FIFO, one customer per server at a time, utilisation <= 1, consistent accounting', () => {
    const r = seeded(51);
    for (let t = 0; t < 25; t++) {
      const c = ri(r, 1, 6), rho = rf(r, 0.2, 1.4);
      const mu = rf(r, 0.5, 3), lambda = rho * c * mu;
      const kinds: Distribution[] = [{ type: 'exponential', rate: mu }, { type: 'uniform', a: 0, b: 2 / mu }, { type: 'constant', value: 1 / mu }, { type: 'triangular', a: 0.2 / mu, m: 0.5 / mu, b: 2.3 / mu }];
      const res = runQueueSimulation({ interarrival: { type: 'exponential', rate: lambda }, service: kinds[t % 4]!, servers: c, customers: 800, seed: 100 + t, generator: t % 2 ? 'mt' : 'lcg' });
      expect(res.error).toBeUndefined();
      const cs = res.customers;
      for (let i = 1; i < cs.length; i++) {
        expect(cs[i]!.arrival).toBeGreaterThanOrEqual(cs[i - 1]!.arrival);
        expect(cs[i]!.start, 'FIFO: service starts in arrival order').toBeGreaterThanOrEqual(cs[i - 1]!.start - 1e-12);
      }
      for (const x of cs) {
        expect(x.start).toBeGreaterThanOrEqual(x.arrival - 1e-12);
        expect(x.end).toBeCloseTo(x.start + x.service, 9);
        expect(x.wait).toBeCloseTo(x.start - x.arrival, 9);
        expect(x.server >= 1 && x.server <= c).toBe(true);
      }
      for (let s = 1; s <= c; s++) {
        const mine = cs.filter(x => x.server === s).sort((a, b) => a.start - b.start);
        for (let i = 1; i < mine.length; i++) expect(mine[i]!.start, `server ${s} double-booked`).toBeGreaterThanOrEqual(mine[i - 1]!.end - 1e-9);
      }
      // work conserving: nobody waits while a server is idle
      for (const x of cs) if (x.wait > 1e-9) for (let s = 1; s <= c; s++) {
        const busy = cs.some(y => y.server === s && y.start < x.arrival + 1e-9 && y.end > x.arrival - 1e-9 && y.id !== x.id);
        expect(busy, `customer ${x.id} waited ${x.wait} while server ${s} idle`).toBe(true);
      }
      expect(res.utilisation).toBeGreaterThanOrEqual(0);
      expect(res.utilisation).toBeLessThanOrEqual(1 + 1e-12);
      expect(res.probWait).toBeGreaterThanOrEqual(0); expect(res.probWait).toBeLessThanOrEqual(1);
      // Little's law over the whole run: time-average number in system = total sojourn / duration
      const sojourn = cs.reduce((a, x) => a + (x.end - x.arrival), 0);
      expect(res.avgInSystem).toBeCloseTo(sojourn / res.duration, 6);
      const waitTotal = cs.reduce((a, x) => a + x.wait, 0);
      expect(res.avgQueueLength).toBeCloseTo(waitTotal / res.duration, 6);
      // event trace is time-ordered, and the queue length never goes negative
      for (let i = 1; i < res.events.length; i++) expect(res.events[i]!.time).toBeGreaterThanOrEqual(res.events[i - 1]!.time);
      for (const e of res.events) { expect(e.queueLength).toBeGreaterThanOrEqual(0); expect(e.inSystem).toBeGreaterThanOrEqual(e.queueLength); }
    }
  });

  it('queue DES: long M/M/c run converges to the analytic Wq, Ws and utilisation', () => {
    for (const [c, lambda, mu, seed] of [[1, 0.7, 1, 11], [2, 1.5, 1, 12], [3, 2.4, 1, 13], [5, 4, 1, 14]] as const) {
      const analytic = solveQueue({ model: 'mmc', lambda, mu, servers: c }).metrics!;
      const sim = runQueueSimulation({ interarrival: { type: 'exponential', rate: lambda }, service: { type: 'exponential', rate: mu }, servers: c, customers: 300000, seed, generator: 'mt', warmup: 5000 });
      expect(sim.error).toBeUndefined();
      expect(Math.abs(sim.avgWait - analytic.Wq), `c=${c} Wq sim ${sim.avgWait} vs ${analytic.Wq}`).toBeLessThan(0.06 * analytic.Wq + 0.01);
      expect(Math.abs(sim.avgSystemTime - analytic.Ws)).toBeLessThan(0.05 * analytic.Ws);
      expect(Math.abs(sim.utilisation - analytic.rho)).toBeLessThan(0.02);
    }
  });

  it('queue DES: hostile inputs return an error or a finite result, never throw or produce NaN', () => {
    const e: Distribution = { type: 'exponential', rate: 1 };
    const base = { interarrival: e, service: e, servers: 1, customers: 100, seed: 1, generator: 'mt' as const };
    for (const servers of [0, -1, NaN, 1001, Infinity]) expect(runQueueSimulation({ ...base, servers }).error).toBeTruthy();
    for (const customers of [0, -5, NaN, 500001, Infinity]) expect(runQueueSimulation({ ...base, customers }).error).toBeTruthy();
    expect(runQueueSimulation({ ...base, service: { type: 'normal', mean: NaN, sd: 1 } }).error).toBeTruthy();
    expect(runQueueSimulation({ ...base, interarrival: { type: 'exponential', rate: 0 } }).error).toBeTruthy();
    for (const warmup of [NaN, -5, 1e9, Infinity]) {
      const res = runQueueSimulation({ ...base, warmup });
      expect(res.error).toBeUndefined();
      expect(Number.isFinite(res.avgWait)).toBe(true);
    }
    // zero interarrival time (all customers arrive together): finite statistics
    const z = runQueueSimulation({ ...base, interarrival: { type: 'constant', value: 0 }, service: { type: 'constant', value: 0 } });
    for (const v of [z.avgWait, z.avgSystemTime, z.utilisation, z.avgQueueLength, z.avgInSystem, z.probWait]) expect(Number.isFinite(v)).toBe(true);
    const z2 = runQueueSimulation({ ...base, interarrival: { type: 'constant', value: 0 }, service: { type: 'constant', value: 1 }, servers: 2 });
    for (const v of [z2.avgWait, z2.utilisation, z2.avgQueueLength, z2.avgInSystem]) expect(Number.isFinite(v)).toBe(true);
    expect(z2.utilisation).toBeLessThanOrEqual(1 + 1e-12);
  });
});

/* ---------- exact QP against a face-enumeration float oracle ---------- */
/** Minimise ½xᵀQx + cᵀx over {x ≥ 0, Ax ≤ b} by minimising over every affine face and keeping the best feasible candidate. */
function qpOracle(Q: number[][], c: number[], A: number[][], b: number[]): { obj: number; x: number[] } | null {
  const n = c.length, m = A.length;
  const rows: { a: number[]; r: number }[] = [...A.map((a, i) => ({ a, r: b[i]! })), ...c.map((_, j) => ({ a: Array.from({ length: n }, (_, k) => (k === j ? -1 : 0)), r: 0 }))];
  let best: { obj: number; x: number[] } | null = null;
  for (let mask = 0; mask < 1 << (m + n); mask++) {
    const S = rows.filter((_, i) => mask & (1 << i));
    // RREF of the augmented [A_S | b_S]
    const M = S.map(s => [...s.a, s.r]);
    const piv: number[] = [];
    let row = 0, consistent = true;
    for (let col = 0; col < n && row < M.length; col++) {
      let p = row; for (let i = row + 1; i < M.length; i++) if (Math.abs(M[i]![col]!) > Math.abs(M[p]![col]!)) p = i;
      if (Math.abs(M[p]![col]!) < 1e-10) continue;
      [M[row], M[p]] = [M[p]!, M[row]!];
      const d = M[row]![col]!; for (let k = 0; k <= n; k++) M[row]![k]! /= d;
      for (let i = 0; i < M.length; i++) if (i !== row) { const f = M[i]![col]!; for (let k = 0; k <= n; k++) M[i]![k]! -= f * M[row]![k]!; }
      piv.push(col); row++;
    }
    for (let i = row; i < M.length; i++) if (Math.abs(M[i]![n]!) > 1e-9) consistent = false;
    if (!consistent) continue;
    const free = Array.from({ length: n }, (_, j) => j).filter(j => !piv.includes(j));
    const x0 = Array(n).fill(0); piv.forEach((pc, i) => (x0[pc] = M[i]![n]!));
    const N = free.map(f => { const v = Array(n).fill(0); v[f] = 1; piv.forEach((pc, i) => (v[pc] = -M[i]![f]!)); return v; });
    const g0 = Q.map((qr, i) => qr.reduce((s, q, j) => s + q * x0[j]!, 0) + c[i]!);
    const k = N.length;
    let x = x0;
    if (k > 0) {
      const H = N.map(u => N.map(v => u.reduce((s, ui, i) => s + ui * Q[i]!.reduce((t, q, j) => t + q * v[j]!, 0), 0)));
      const gr = N.map(u => -u.reduce((s, ui, i) => s + ui * g0[i]!, 0));
      for (let i = 0; i < k; i++) H[i]![i]! += 1e-11;
      const aug = H.map((hr, i) => [...hr, gr[i]!]);
      let ok = true;
      for (let col = 0; col < k && ok; col++) {
        let p = col; for (let i = col + 1; i < k; i++) if (Math.abs(aug[i]![col]!) > Math.abs(aug[p]![col]!)) p = i;
        if (Math.abs(aug[p]![col]!) < 1e-14) { ok = false; break; }
        [aug[col], aug[p]] = [aug[p]!, aug[col]!];
        for (let i = 0; i < k; i++) if (i !== col) { const f = aug[i]![col]! / aug[col]![col]!; for (let q = col; q <= k; q++) aug[i]![q]! -= f * aug[col]![q]!; }
      }
      if (!ok) continue;
      const z = aug.map((rw, i) => rw[k]! / rw[i]!);
      x = x0.map((v, i) => v + N.reduce((s, nv, q) => s + z[q]! * nv[i]!, 0));
    }
    if (x.some(v => v < -1e-7) || A.some((a, i) => a.reduce((s, v, j) => s + v * x[j]!, 0) > b[i]! + 1e-7)) continue;
    if (x.some(v => Math.abs(v) > 1e5)) return { obj: -Infinity, x }; // a feasible face minimiser that runs off to infinity: unbounded
    const obj = x.reduce((s, xi, i) => s + c[i]! * xi + 0.5 * xi * Q[i]!.reduce((t, q, j) => t + q * x[j]!, 0), 0);
    if (!best || obj < best.obj) best = { obj, x };
  }
  return best;
}


/* ======================================================================= */
/* 6. NONLINEAR PROGRAMMING                                                */
/* ======================================================================= */

const NR = (x: string | number) => Rational.parse(String(x));

/** Random expression in x1, x2 over a grammar that stays inside every function's domain on the sampled points. */
function randomExpr(r: () => number, depth: number): string {
  if (depth <= 0 || r() < 0.2) {
    const leaves = ['x1', 'x2', String(ri(r, 1, 5)), (rf(r, 0.1, 3)).toFixed(2)];
    return leaves[ri(r, 0, leaves.length - 1)]!;
  }
  const a = randomExpr(r, depth - 1), b = randomExpr(r, depth - 1);
  switch (ri(r, 0, 12)) {
    case 0: return `(${a} + ${b})`;
    case 1: return `(${a} - ${b})`;
    case 2: return `(${a} * ${b})`;
    case 3: return `(${a}) / (1 + (${b})^2)`;
    case 4: return `(${a})^2`;
    case 5: return `(${a})^3`;
    case 6: return `exp(0.3 * (${a}))`;
    case 7: return `ln(1 + (${a})^2)`;
    case 8: return `sin(${a}) + cos(${b})`;
    case 9: return `sqrt(1 + (${a})^2)`;
    case 10: return `-(${a})`;
    case 11: return `(1 + (${a})^2)^-2`;
    default: return `(${a}) * (${b})^(1 + 1)`;
  }
}

describe('nonlinear programming audit', () => {
  it('symbolic derivatives agree with central finite differences on random expressions (incl. negative points)', () => {
    const r = seeded(61);
    let checked = 0;
    for (let t = 0; t < 250; t++) {
      const src = randomExpr(r, 3);
      let e;
      try { e = parseExpression(src, ['x1', 'x2']); } catch (err) { throw new Error(`parse failed for ${src}: ${(err as Error).message}`); }
      for (let k = 0; k < 4; k++) {
        const x = [rf(r, -2, 2), rf(r, -2, 2)];
        const f0 = evalExpr(e, x);
        if (!Number.isFinite(f0) || Math.abs(f0) > 1e6) continue;
        for (let i = 0; i < 2; i++) {
          const h = 1e-5, xp = [...x], xm = [...x]; xp[i]! += h; xm[i]! -= h;
          const fd = (evalExpr(e, xp) - evalExpr(e, xm)) / (2 * h);
          const an = evalExpr(diff(e, i), x);
          if (!Number.isFinite(fd)) continue;
          expect(Number.isFinite(an), `${src} d/dx${i + 1} at ${x} is ${an}`).toBe(true);
          expect(Math.abs(an - fd), `${src} d/dx${i + 1} at ${x}: ${an} vs ${fd}`).toBeLessThanOrEqual(1e-4 * (1 + Math.abs(fd)));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('derivatives of negative and compound integer powers stay finite for negative bases', () => {
    for (const src of ['x1^-2', 'x1^(-1)', 'x1^(1+1)', 'x1^(2*2)', 'x1^(4/2)', '(x1-1)^-3', '1/x1^2', '2^x1', 'x1^x2']) {
      const e = parseExpression(src, ['x1', 'x2']);
      const g = evalExpr(diff(e, 0), [-1.5, 2]);
      if (src === 'x1^x2') continue; // x^y with a fractional/negative base is genuinely undefined for general y
      expect(Number.isFinite(g), `${src}: ${g}`).toBe(true);
    }
    expect(evalExpr(diff(parseExpression('x1^-2', ['x1']), 0), [-2])).toBeCloseTo(0.25, 10);
    expect(evalExpr(diff(parseExpression('x1^(1+1)', ['x1']), 0), [-3])).toBeCloseTo(-6, 10);
  });

  it('expression parsing: precedence matches arithmetic and malformed input is an error, not an exception or NaN', () => {
    const val = (s: string, x = [0.5]) => evalExpr(parseExpression(s, ['x1']), x);
    expect(val('-x1^2')).toBeCloseTo(-0.25, 12);
    expect(val('2x1^2')).toBeCloseTo(0.5, 12);
    expect(val('x1^2^2', [2])).toBe(16);
    expect(val('1 - 2 - 3')).toBe(-4);
    expect(val('8/2/2')).toBe(2);
    expect(val('2*3^2')).toBe(18);
    expect(val('3 - -x1')).toBeCloseTo(3.5, 12);
    expect(val('x1² + x1³', [2])).toBe(12);
    for (const bad of ['', ' ', '1 +', '(', ')', '1 2 +', 'foo', 'x2', 'x1 x1 +', '1..2', '1.2.3', '.', '*3', 'sin()', 'exp(', '1/', 'x1^', '$', 'x1 = 2', '1e', 'ln(x1', 'x1)']) {
      let out: unknown = null;
      try { parseExpression(bad, ['x1']); } catch (e) { out = e; }
      expect(out, `"${bad}" must be rejected`).toBeInstanceOf(Error);
    }
    for (const bad of ['', '1 +', 'foo', '1.2.3', '(((', 'x1^^2', 'a'.repeat(5000), '('.repeat(500) + 'x1' + ')'.repeat(500), '-'.repeat(3000) + 'x1']) {
      const m = minimiseUnconstrained({ expression: bad, start: [1], method: 'newton' });
      expect(m.error, bad.slice(0, 20)).toBeTruthy();
      const k = checkKKT({ objective: bad, constraints: [], point: [1] });
      expect(k.error, bad.slice(0, 20)).toBeTruthy();
      const k2 = checkKKT({ objective: 'x1', constraints: [{ expr: bad, kind: 'le' }], point: [1] });
      expect(k2.error, bad.slice(0, 20)).toBeTruthy();
    }
  });

  it('Newton and gradient descent converge on random convex quadratics to the analytic minimiser', () => {
    const r = seeded(62);
    for (let t = 0; t < 30; t++) {
      const n = ri(r, 1, 4);
      // SPD Q = BᵀB + I (small integers), minimise ½xᵀQx + cᵀx  →  x* = −Q⁻¹c
      const B = Array.from({ length: n }, () => Array.from({ length: n }, () => ri(r, -2, 2)));
      const Q = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => B.reduce((s, row) => s + row[i]! * row[j]!, 0) + (i === j ? 1 : 0)));
      const c = Array.from({ length: n }, () => ri(r, -6, 6));
      const names = Array.from({ length: n }, (_, i) => `x${i + 1}`);
      const terms: string[] = [];
      for (let i = 0; i < n; i++) { terms.push(`${c[i]}*x${i + 1}`); for (let j = 0; j < n; j++) terms.push(`0.5*${Q[i]![j]}*x${i + 1}*x${j + 1}`); }
      const expression = terms.join(' + ').replace(/\+ -/g, '- ');
      // exact solution by Gaussian elimination
      const M = Q.map((row, i) => [...row, -c[i]!]);
      for (let k = 0; k < n; k++) { let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(M[i]![k]!) > Math.abs(M[p]![k]!)) p = i; [M[k], M[p]] = [M[p]!, M[k]!]; for (let i = 0; i < n; i++) if (i !== k) { const f = M[i]![k]! / M[k]![k]!; for (let j = k; j <= n; j++) M[i]![j]! -= f * M[k]![j]!; } }
      const xs = M.map((row, i) => row[n]! / row[i]!);
      const start = names.map(() => rf(r, -5, 5));
      const nw = minimiseUnconstrained({ expression, start, method: 'newton' });
      expect(nw.error).toBeUndefined();
      expect(nw.converged, expression).toBe(true);
      expect(nw.classification).toBe('minimum');
      nw.x.forEach((v, i) => expect(v).toBeCloseTo(xs[i]!, 6));
      expect(nw.iterations).toBeLessThanOrEqual(3);
      // eigenvalues: sum = trace, ascending, all positive
      expect(nw.eigenvalues!.reduce((a, b) => a + b, 0)).toBeCloseTo(Q.reduce((s, row, i) => s + row[i]!, 0), 6);
      for (let i = 1; i < nw.eigenvalues!.length; i++) expect(nw.eigenvalues![i]!).toBeGreaterThanOrEqual(nw.eigenvalues![i - 1]! - 1e-9);
      expect(nw.eigenvalues![0]!).toBeGreaterThan(0);
      const gd = minimiseUnconstrained({ expression, start, method: 'gradient', maxIterations: 5000, tolerance: 1e-6 });
      if (gd.converged) gd.x.forEach((v, i) => expect(v).toBeCloseTo(xs[i]!, 3));
      else expect(gd.diagnostics.some(d => d.code === 'NOT_CONVERGED')).toBe(true);
    }
  });

  it('Hessian eigenvalues of a 3×3 and 4×4 quadratic match trace and determinant', () => {
    const e3 = minimiseUnconstrained({ expression: '2*x1^2 + 3*x2^2 + 4*x3^2 + x1*x2 + x2*x3', start: [1, 1, 1], method: 'newton' });
    const H = [[4, 1, 0], [1, 6, 1], [0, 1, 8]];
    const ev3 = e3.eigenvalues!;
    expect(ev3.reduce((a, b) => a + b, 0)).toBeCloseTo(18, 8);
    expect(ev3.reduce((a, b) => a * b, 1)).toBeCloseTo(H[0]![0]! * (H[1]![1]! * H[2]![2]! - 1) - 1 * (H[2]![2]!), 6);
    const e4 = minimiseUnconstrained({ expression: 'x1^2 + 2*x2^2 + 3*x3^2 + 4*x4^2', start: [1, 1, 1, 1], method: 'newton' });
    expect(e4.eigenvalues!.map(v => Number(v.toFixed(8)))).toEqual([2, 4, 6, 8]);
  });

  it('non-convex, unbounded, saddle and flat problems are reported honestly and never produce NaN', () => {
    const peak = minimiseUnconstrained({ expression: '-x1^2', start: [1], method: 'newton' });
    expect(peak.converged === false || peak.classification !== 'minimum').toBe(true);
    expect(peak.x.every(Number.isFinite)).toBe(true);
    const down = minimiseUnconstrained({ expression: 'exp(x1)', start: [0], method: 'gradient', maxIterations: 100 });
    expect(down.converged).toBe(false);
    expect(down.classification).toBe('inconclusive');
    expect(down.x.every(Number.isFinite)).toBe(true);
    const flat = minimiseUnconstrained({ expression: 'x1^2', start: [3, 4], method: 'newton', varNames: ['x1', 'x2'] });
    expect(flat.converged).toBe(true);
    expect(flat.x[0]!).toBeCloseTo(0, 6);
    expect(flat.x[1]!).toBe(4);
    expect(flat.classification).not.toBe('minimum'); // singular Hessian: only a weak minimum
    const quartic = minimiseUnconstrained({ expression: 'x1^4 + x2^2', start: [1, 1], method: 'newton', maxIterations: 500 });
    expect(quartic.converged).toBe(true);
    expect(quartic.f).toBeLessThan(1e-9);
    const cubic = minimiseUnconstrained({ expression: 'x1^3 - 3*x1', start: [0.5], method: 'newton' });
    expect(cubic.x[0]!).toBeCloseTo(1, 6);
    const maxRes = minimiseUnconstrained({ expression: '-(x1-1)^2 - (x2+2)^2', start: [1, -2], method: 'newton' });
    expect(maxRes.classification).toBe('maximum');
    // a concave function has no minimiser: from any other start the descent is reported as unbounded, not as a result
    const runaway = minimiseUnconstrained({ expression: '-(x1-1)^2 - (x2+2)^2', start: [0, 0], method: 'newton' });
    expect(runaway.converged).toBe(false);
    expect(runaway.diagnostics.some(d => d.code === 'UNBOUNDED')).toBe(true);
    expect(maxRes.steps[maxRes.steps.length - 1]!.explanation.detailed).toMatch(/maximum/);
    // starting where the function is undefined
    expect(minimiseUnconstrained({ expression: 'ln(x1)', start: [-1], method: 'newton' }).error).toMatch(/not finite/);
    expect(minimiseUnconstrained({ expression: 'x1^2', start: [NaN], method: 'newton' }).error).toBeTruthy();
    expect(minimiseUnconstrained({ expression: 'x1^2', start: [1e308], method: 'newton' }).error ?? 'ok').not.toMatch(/NaN/);
    expect(minimiseUnconstrained({ expression: 'x1^2', start: [], method: 'newton' }).error).toBeTruthy();
    // too many iterations / variables are refused with a message
    expect(minimiseUnconstrained({ expression: 'x1^2', start: [1], method: 'gradient', maxIterations: 1e9 }).error).toMatch(/iteration/i);
    expect(minimiseUnconstrained({ expression: 'x1^2', start: Array(60).fill(1), method: 'newton' }).error).toMatch(/variables/i);
  });

  it('KKT: the true constrained optimum passes, perturbed points fail, duplicated constraints do not break it', () => {
    const r = seeded(63);
    for (let t = 0; t < 40; t++) {
      // min (x1-a)² + (x2-b)²  s.t. x1 + x2 <= s  with the target outside the half-plane: optimum = projection
      const a = ri(r, 2, 8), b = ri(r, 2, 8), s = ri(r, 1, a + b - 1);
      const d = (a + b - s) / 2;
      const opt = [a - d, b - d];
      const base = { objective: `(x1-${a})^2 + (x2-${b})^2`, constraints: [{ expr: `x1 + x2 - ${s}`, kind: 'le' as const }] };
      const ok = checkKKT({ ...base, point: opt });
      expect(ok.satisfied, ok.messages.join(' | ')).toBe(true);
      expect(ok.multipliers![0]!).toBeCloseTo(2 * d, 6);
      // the same constraint written twice and scaled: multipliers are not unique but KKT still holds
      const dup = checkKKT({ ...base, constraints: [...base.constraints, { expr: `2*x1 + 2*x2 - ${2 * s}`, kind: 'le' }, { expr: `x1 + x2 - ${s}`, kind: 'le' }], point: opt });
      expect(dup.satisfied, dup.messages.join(' | ')).toBe(true);
      for (const delta of [[0.05, 0], [0, -0.05], [0.05, -0.05], [-0.2, -0.2]]) {
        const p = [opt[0]! + delta[0]!, opt[1]! + delta[1]!];
        // moving along the constraint keeps feasibility but breaks stationarity; moving inside breaks stationarity
        expect(checkKKT({ ...base, point: p }).satisfied, `perturbed ${p}`).toBe(false);
      }
      // equality-constrained version: sign of the multiplier is unrestricted
      const eq = checkKKT({ objective: base.objective, constraints: [{ expr: `x1 + x2 - ${s}`, kind: 'eq' }], point: opt });
      expect(eq.satisfied).toBe(true);
    }
    // wrong sign multiplier: maximisation point is not a KKT point of the minimisation
    const wrong = checkKKT({ objective: '-(x1-3)^2', constraints: [{ expr: 'x1 - 3', kind: 'le' }], point: [3] });
    expect(wrong.dualFeasible || wrong.stationarityResidual < 1e-9).toBe(true);
    const interior = checkKKT({ objective: '(x1-1)^2', constraints: [{ expr: 'x1 - 5', kind: 'le' }], point: [1] });
    expect(interior.satisfied).toBe(true);
    expect(interior.active).toEqual([]);
    const negMult = checkKKT({ objective: '(x1-1)^2', constraints: [{ expr: '-x1 + 2', kind: 'le' }], point: [2] }); // x1 >= 2 with minimiser 1: multiplier 2 > 0 -> OK
    expect(negMult.satisfied).toBe(true);
    const badMult = checkKKT({ objective: '(x1-1)^2', constraints: [{ expr: 'x1 - 2', kind: 'le' }], point: [2] }); // gradient 2 pushes outwards: λ = −2 < 0
    expect(badMult.satisfied).toBe(false);
    // hostile points
    for (const p of [[NaN, 1], [Infinity, 1], [1e308, 1e308]]) {
      const k = checkKKT({ objective: '(x1-1)^2 + x2^2', constraints: [{ expr: 'x1 + x2 - 1', kind: 'le' }], point: p });
      expect(k.satisfied).toBe(false);
      expect(JSON.stringify(k.messages)).not.toMatch(/undefined|\[object/);
    }
    expect(checkKKT({ objective: 'x1', constraints: [], point: [] }).error).toBeTruthy();
  });

  it('exact convex QP equals the face-enumeration oracle (positive definite and positive semidefinite) and its duals satisfy KKT', () => {
    const r = seeded(64);
    let singularSeen = 0;
    for (let t = 0; t < 120; t++) {
      const n = ri(r, 1, 3), m = ri(r, 1, 3);
      const rank = t % 3 === 0 ? Math.max(0, n - 1) : n; // some semidefinite objectives
      const Bm = Array.from({ length: rank }, () => Array.from({ length: n }, () => ri(r, -2, 2)));
      const Q = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => 2 * Bm.reduce((s, row) => s + row[i]! * row[j]!, 0) + (rank === n && i === j ? 1 : 0)));
      if (rank < n) singularSeen++;
      const c = Array.from({ length: n }, () => ri(r, -8, 4));
      const A = Array.from({ length: m }, () => Array.from({ length: n }, () => ri(r, -2, 3)));
      const b = Array.from({ length: m }, () => ri(r, 1, 9));
      const oracle = qpOracle(Q, c, A, b);
      const res = solveQP({ Q: Q.map(row => row.map(NR)), c: c.map(NR), A: A.map(row => row.map(NR)), b: b.map(NR) });
      const tag = JSON.stringify({ Q, c, A, b });
      if (!oracle || oracle.obj === -Infinity) { expect(res.error, `infeasible/unbounded ${tag}`).toBeTruthy(); continue; }
      expect(res.error, tag).toBeUndefined();
      expect(res.convex).toBe(true);
      expect(close(res.objective.toNumber(), oracle.obj, 1e-6, 1e-6), `objective ${res.objective.toNumber()} vs ${oracle.obj} for ${tag}`).toBe(true);
      const x = res.x.map(v => v.toNumber());
      expect(x.every(v => v >= 0)).toBe(true);
      A.forEach((a, i) => expect(a.reduce((s, v, j) => s + v * x[j]!, 0)).toBeLessThanOrEqual(b[i]! + 1e-9));
      // reported multipliers: stationarity Qx + c + Aᵀλ − μ = 0, λ, μ ≥ 0, complementary slackness
      const lam = res.multipliers.map(v => v.toNumber()), mu = res.boundMultipliers.map(v => v.toNumber());
      expect(lam).toHaveLength(m); expect(mu).toHaveLength(n);
      lam.forEach(v => expect(v).toBeGreaterThanOrEqual(-1e-9)); mu.forEach(v => expect(v).toBeGreaterThanOrEqual(-1e-9));
      for (let j = 0; j < n; j++) {
        const g = Q[j]!.reduce((s, q, k) => s + q * x[k]!, 0) + c[j]! + A.reduce((s, a, i) => s + a[j]! * lam[i]!, 0) - mu[j]!;
        expect(Math.abs(g), `stationarity row ${j} of ${tag}`).toBeLessThan(1e-7);
      }
      A.forEach((a, i) => expect(Math.abs(lam[i]! * (a.reduce((s, v, j) => s + v * x[j]!, 0) - b[i]!))).toBeLessThan(1e-7));
      x.forEach((xj, j) => expect(Math.abs(mu[j]! * xj)).toBeLessThan(1e-7));
    }
    expect(singularSeen).toBeGreaterThan(20);
  });

  it('QP: infeasible, unbounded and non-convex cases are told apart honestly', () => {
    // infeasible: x1 ≥ 5 (−x1 ≤ −5) and x1 ≤ 3
    const inf = solveQP({ Q: [[NR(2)]], c: [NR(0)], A: [[NR(-1)], [NR(1)]], b: [NR(-5), NR(3)] });
    expect(inf.error).toMatch(/infeasible/i);
    expect(inf.error).not.toMatch(/unbounded/i);
    // unbounded: min −x1 with only x2 bounded
    const unb = solveQP({ Q: [[NR(0), NR(0)], [NR(0), NR(0)]], c: [NR(-1), NR(0)], A: [[NR(0), NR(1)]], b: [NR(3)] });
    expect(unb.error).toMatch(/unbounded/i);
    expect(unb.error).not.toMatch(/infeasible/i);
    // non-convex over a box: the best KKT point is reported with a clear warning
    const nc = solveQP({ Q: [[NR(-2), NR(0)], [NR(0), NR(-2)]], c: [NR(0), NR(0)], A: [[NR(1), NR(0)], [NR(0), NR(1)]], b: [NR(2), NR(2)] });
    expect(nc.error).toBeUndefined();
    expect(nc.convex).toBe(false);
    expect(nc.x.map(String)).toEqual(['2', '2']);
    expect(nc.objective.toString()).toBe('-8');
    expect(nc.explanation).toMatch(/NOT convex/);
    // trivial: no constraints at all except x ≥ 0
    const triv = solveQP({ Q: [[NR(2)]], c: [NR(-6)], A: [], b: [] });
    expect(triv.x.map(String)).toEqual(['3']);
  });

  it('QP input validation never throws', () => {
    expect(solveQP({ Q: [[NR(1)]], c: [NR(1), NR(1)], A: [], b: [] }).error).toBeTruthy();
    expect(solveQP({ Q: [[NR(1), NR(0)], [NR(0), NR(1)]], c: [NR(1), NR(1)], A: [[NR(1)]], b: [NR(1)] }).error).toBeTruthy();
    expect(solveQP({ Q: [[NR(1), NR(0)], [NR(0), NR(1)]], c: [NR(1), NR(1)], A: [[NR(1), NR(1)]], b: [] }).error).toBeTruthy();
    expect(solveQP({ Q: [], c: [], A: [], b: [] }).error).toBeTruthy();
    expect(solveQP({ Q: Array.from({ length: 7 }, (_, i) => Array.from({ length: 7 }, (_, j) => NR(i === j ? 1 : 0))), c: Array(7).fill(NR(1)), A: [], b: [] }).error).toMatch(/up to/);
    // an asymmetric Q is treated through its symmetric part (xᵀQx only sees (Q+Qᵀ)/2)
    const asym = solveQP({ Q: [[NR(2), NR(2)], [NR(0), NR(2)]], c: [NR(-4), NR(-4)], A: [], b: [] });
    const sym = solveQP({ Q: [[NR(2), NR(1)], [NR(1), NR(2)]], c: [NR(-4), NR(-4)], A: [], b: [] });
    expect(asym.x.map(String)).toEqual(sym.x.map(String));
    expect(asym.objective.toString()).toBe(sym.objective.toString());
  });
});

/* ======================================================================= */
/* 7. SECOND-ROUND AUDIT                                                   */
/* ======================================================================= */

describe('queuing audit (round 2)', () => {
  it('M/M/c/c (no waiting room) blocks with exactly the Erlang-B probability', () => {
    const r = seeded(71);
    for (let t = 0; t < 30; t++) {
      const c = ri(r, 1, 60), a = rf(r, 0.5, 1.5) * c, mu = rf(r, 0.5, 3);
      const res = solveQueue({ model: 'mmcn', lambda: a * mu, mu, servers: c, capacity: c });
      expect(res.error).toBeUndefined();
      expect(close(res.metrics!.probBlocked!, erlang(c, a).B, 1e-9, 1e-14)).toBe(true);
      expect(res.metrics!.Lq).toBeCloseTo(0, 12);
    }
  });

  it('cost optimisation for finite-capacity and machine-servicing models equals an exhaustive search', () => {
    const r = seeded(72);
    for (let t = 0; t < 30; t++) {
      const finiteSource = t % 2 === 0;
      const mu = rf(r, 0.5, 3);
      const cap = ri(r, 4, 60);
      const lambda = finiteSource ? rf(r, 0.05, 1) : rf(r, 0.5, 8) * mu;
      const Cs = rf(r, 1, 50), Cw = rf(r, 1, 400);
      const model = finiteSource ? 'mmcnn' : 'mmcn';
      const opt = optimiseServers({ model, lambda, mu, capacity: cap, costPerServer: Cs, costPerWait: Cw })!;
      let best = Infinity, bestC = 1;
      for (let c = 1; c <= cap; c++) {
        const m = solveQueue({ model, lambda, mu, servers: c, capacity: cap }).metrics!;
        const total = c * Cs + m.Ls * Cw;
        if (total < best) { best = total; bestC = c; }
      }
      expect(opt.optimalServers, `${model} λ=${lambda} μ=${mu} cap=${cap} Cs=${Cs} Cw=${Cw}`).toBe(bestC);
      expect(close(opt.minTotalCost, best, 1e-9)).toBe(true);
    }
  });
});

describe('inventory audit (round 2)', () => {
  it('discrete newsvendor ignores the order of the rows and tolerates tied demand levels', () => {
    const base = { model: 'newsvendor' as const, sellingPrice: 10, unitCost: 4, salvageValue: 1, demandDist: 'discrete' as const };
    const a = solveInventory({ ...base, discrete: [{ demand: 30, prob: 0.2 }, { demand: 10, prob: 0.3 }, { demand: 20, prob: 0.5 }] });
    const b = solveInventory({ ...base, discrete: [{ demand: 10, prob: 0.3 }, { demand: 20, prob: 0.5 }, { demand: 30, prob: 0.2 }] });
    expect(a.error).toBeUndefined();
    expect(a.Q).toBe(b.Q);
    expect(a.newsvendor!.expectedProfit).toBeCloseTo(b.newsvendor!.expectedProfit, 12);
    const tied = solveInventory({ ...base, discrete: [{ demand: 10, prob: 0.3 }, { demand: 10, prob: 0.2 }, { demand: 20, prob: 0.5 }] });
    const merged = solveInventory({ ...base, discrete: [{ demand: 10, prob: 0.5 }, { demand: 20, prob: 0.5 }] });
    expect(tied.Q).toBe(merged.Q);
    expect(tied.newsvendor!.expectedProfit).toBeCloseTo(merged.newsvendor!.expectedProfit, 12);
  });
});

describe('zero-sum game audit (round 2)', () => {
  const val = (A: number[][]) => solveZeroSumGame({ payoff: RM(A) }).gameValue.toNumber();
  it('larger random games match the support-enumeration oracle and are exactly verified', () => {
    const r = seeded(81);
    for (let t = 0; t < 60; t++) {
      const m = ri(r, 3, 6), n = ri(r, 3, 6);
      const A = Array.from({ length: m }, () => Array.from({ length: n }, () => ri(r, -12, 12)));
      const res = solveZeroSumGame({ payoff: RM(A) });
      expect(res.error).toBeUndefined();
      expect(res.verified).toBe(true);
      expect(close(res.gameValue.toNumber(), gameValueOracle(A), 1e-9, 1e-9), JSON.stringify(A)).toBe(true);
    }
  });

  it('value is invariant under positive affine maps, negates under transpose-negation, and a skew-symmetric game is fair', () => {
    const r = seeded(82);
    for (let t = 0; t < 80; t++) {
      const m = ri(r, 1, 5), n = ri(r, 1, 5);
      const A = Array.from({ length: m }, () => Array.from({ length: n }, () => ri(r, -9, 9)));
      const v = val(A);
      const k = ri(r, 1, 5), s = ri(r, -20, 20);
      expect(val(A.map(row => row.map(x => k * x + s)))).toBeCloseTo(k * v + s, 9);
      expect(val(A[0]!.map((_, j) => A.map(row => -row[j]!)))).toBeCloseTo(-v, 9);
      const S = ri(r, 1, 5);
      const K = Array.from({ length: S }, () => Array<number>(S).fill(0));
      for (let i = 0; i < S; i++) for (let j = i + 1; j < S; j++) { const x = ri(r, -6, 6); K[i]![j] = x; K[j]![i] = -x; }
      const sk = solveZeroSumGame({ payoff: RM(K) });
      expect(sk.gameValue.isZero()).toBe(true);
      expect(sk.fair).toBe(true);
    }
  });

  it('fractional and decimal payoffs give exact rational values', () => {
    const P = (rows: string[][]) => rows.map(r => r.map(x => Rational.parse(x)));
    const res = solveZeroSumGame({ payoff: P([['1/2', '-1/3'], ['-2/5', '0.25']]) });
    expect(res.error).toBeUndefined();
    expect(res.verified).toBe(true);
    // 2x2 closed form: (ad - bc)/(a + d - b - c)
    const a = 1 / 2, b = -1 / 3, c = -2 / 5, d = 0.25;
    expect(res.gameValue.toNumber()).toBeCloseTo((a * d - b * c) / (a + d - b - c), 12);
  });
});

describe('markov audit (round 2)', () => {
  it('doubly stochastic irreducible chains have the uniform stationary distribution; Pⁿ converges to it when aperiodic', () => {
    const r = seeded(91);
    for (let t = 0; t < 40; t++) {
      const n = ri(r, 2, 5);
      // convex combination of random permutation matrices (plus the identity, so the chain is aperiodic)
      const perms: number[][] = [Array.from({ length: n }, (_, i) => i)];
      for (let k = 0; k < 3; k++) { const p = Array.from({ length: n }, (_, i) => i); for (let i = n - 1; i > 0; i--) { const j = ri(r, 0, i); [p[i], p[j]] = [p[j]!, p[i]!]; } perms.push(p); }
      const wts = perms.map(() => ri(r, 1, 4)); const tot = wts.reduce((a, b) => a + b, 0);
      const W = Array.from({ length: n }, () => Array<number>(n).fill(0));
      perms.forEach((p, k) => p.forEach((j, i) => { W[i]![j]! += wts[k]!; }));
      const res = solveMarkovChain({ transitionMatrix: toR(W, tot) }, 400);
      expect(res.error).toBeUndefined();
      if (!res.irreducible) continue;
      res.steadyState!.distribution.forEach(x => expect(x.eq(Rational.of(1, n))).toBe(true));
      res.nStep!.matrix.forEach(row => row.forEach(v => expect(Math.abs(Number(v.toDecimal(12)) - 1 / n)).toBeLessThan(1e-6)));
    }
  });

  it('a closed recurrent class that is not a single absorbing state is reported without throwing', () => {
    // 0 absorbing, {1,2} a closed 2-cycle, 3 transient leaking into both
    const P = RM([[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0]]).map(x => x);
    const full = [...P, [Rational.of(1, 4), Rational.of(1, 4), Rational.of(1, 4), Rational.of(1, 4)]];
    const res = solveMarkovChain({ transitionMatrix: full });
    expect(res.error).toBeUndefined();
    expect(res.absorbing!.absorbingStates).toEqual([0]);
    expect(res.absorbing!.fundamental).toBeUndefined();
    expect(res.periodic).toBe(true);
    expect(res.diagnostics.some(d => d.code === 'ABSORPTION_NOT_CERTAIN')).toBe(true);
  });

  it('a 500-step run on an 8-state chain with awkward fractions finishes quickly and its final distribution is exactly init × Pⁿ', () => {
    const primes = [101, 103, 107, 109, 113, 127, 131, 137];
    const n = 8;
    const P = Array.from({ length: n }, (_, i) => { const row: Rational[] = []; let left = Rational.ONE; for (let j = 0; j < n - 1; j++) { const v = Rational.of(1, primes[(i + j) % 8]! * (j + 2)); row.push(v); left = left.sub(v); } row.push(left); return row; });
    const init = Array.from({ length: n }, (_, i) => Rational.of(i === 0 ? 1 : 0));
    const t0 = Date.now();
    const res = solveMarkovChain({ transitionMatrix: P, initialDistribution: init }, 500);
    expect(Date.now() - t0).toBeLessThan(20000);
    expect(res.error).toBeUndefined();
    expect(res.trajectory).toHaveLength(501);
    res.nStep!.distribution!.forEach((v, j) => expect(v.eq(res.nStep!.matrix[0]![j]!)).toBe(true));
    for (const v of res.trajectory![500]!) expect(Math.abs(Number(v.toDecimal(8)) - Number(res.nStep!.distribution![res.trajectory![500]!.indexOf(v)]!.toDecimal(8)))).toBeLessThan(1e-7);
  });

  it('accepts n = 500 and rejects 501', () => {
    const P = toR([[1, 1], [1, 2]], 2).map((r, i) => (i === 0 ? r : [Rational.of(1, 3), Rational.of(2, 3)]));
    expect(solveMarkovChain({ transitionMatrix: [[Rational.of(1, 2), Rational.of(1, 2)], P[1]!] }, 500).error).toBeUndefined();
    expect(solveMarkovChain({ transitionMatrix: [[Rational.of(1, 2), Rational.of(1, 2)], P[1]!] }, 501).error).toBeTruthy();
  });
});

describe('simulation audit (round 2)', () => {
  const allFinite = (res: ReturnType<typeof runMonteCarlo>) => [res.mean, res.stdDev, res.stdError, res.ci95[0], res.ci95[1], res.min, res.max, res.median].every(Number.isFinite);

  it('the sample standard deviation is accurate when the mean is huge compared with the spread', () => {
    for (const generator of ['mt', 'lcg'] as const) {
      const res = runMonteCarlo({ variables: [{ name: 'x', dist: { type: 'normal', mean: 1e9, sd: 1 } }], expression: 'x', trials: 20000, seed: 7, generator });
      expect(res.error).toBeUndefined();
      expect(res.stdDev, `${generator} stdDev`).toBeGreaterThan(0.97);
      expect(res.stdDev).toBeLessThan(1.03);
      expect(res.ci95[1] - res.ci95[0]).toBeGreaterThan(0.01);
    }
    const shifted = runMonteCarlo({ variables: [{ name: 'x', dist: { type: 'uniform', a: 0, b: 1 } }], expression: 'x + 1e12', trials: 5000, seed: 3, generator: 'mt' });
    expect(Math.abs(shifted.stdDev - Math.sqrt(1 / 12))).toBeLessThan(0.01);
  });

  it('extreme magnitudes give either a clear error or fully finite statistics, never NaN or a crash', () => {
    const big = 1e308;
    const cases: Distribution[] = [
      { type: 'discrete', values: [-big, big], probs: [0.5, 0.5] },
      { type: 'poisson', mean: big },
      { type: 'normal', mean: big, sd: big },
      { type: 'constant', value: big },
      { type: 'triangular', a: -big, m: 0, b: big },
    ];
    for (const dist of cases) {
      let res: ReturnType<typeof runMonteCarlo> | undefined;
      expect(() => { res = runMonteCarlo({ variables: [{ name: 'x', dist }], expression: 'x', trials: 200, seed: 5, generator: 'mt' }); }, JSON.stringify(dist)).not.toThrow();
      if (res!.error) expect(res!.error.length).toBeGreaterThan(5); else expect(allFinite(res!), JSON.stringify(dist)).toBe(true);
    }
  });

  it('a non-finite threshold is rejected instead of silently reporting probability 0', () => {
    const base = { variables: [{ name: 'x', dist: { type: 'normal', mean: 0, sd: 1 } as Distribution }], expression: 'x', trials: 100, seed: 1, generator: 'mt' as const };
    expect(runMonteCarlo({ ...base, threshold: NaN }).error).toMatch(/threshold/i);
    expect(runMonteCarlo({ ...base, threshold: 0 }).error).toBeUndefined();
  });

  it('queue DES with astronomically large times gives an error or finite statistics', () => {
    const base = { servers: 2, customers: 100, seed: 1, generator: 'mt' as const };
    for (const [ia, sv] of [[1e308, 1], [1, 1e308], [1e308, 1e308]] as const) {
      const res = runQueueSimulation({ ...base, interarrival: { type: 'constant', value: ia }, service: { type: 'constant', value: sv } });
      if (res.error) expect(res.error.length).toBeGreaterThan(5);
      else for (const v of [res.avgWait, res.avgSystemTime, res.utilisation, res.avgQueueLength, res.avgInSystem, res.probWait, res.duration]) expect(Number.isFinite(v), `ia=${ia} sv=${sv}`).toBe(true);
    }
  });

  it('expression functions check their argument count', () => {
    for (const src of ['sqrt(1, 2)', 'pow(2)', 'pow(1, 2, 3)', 'min()', 'max()', 'abs()', 'exp(1, 2)', 'step()']) {
      expect(() => compileExpression(src, []), src).toThrow(/argument/i);
    }
    expect(ev1('min(3, 1, 2)')).toBe(1);
    expect(ev1('pow(2, 3)')).toBe(8);
  });
  function ev1(src: string) { return compileExpression(src, [])({}); }
});

describe('nonlinear programming audit (round 2)', () => {
  it('QP: non-convex problems unbounded along a recession direction are reported as unbounded', () => {
    // min -x1²  (x ≥ 0): descends forever
    const a = solveQP({ Q: [[NR(-2)]], c: [NR(0)], A: [], b: [] });
    expect(a.error).toMatch(/unbounded/i);
    // min -x1·x2 with x ≥ 0 and x1 + x2 ≤ ∞ : only the interior of the cone is a descent direction
    const b = solveQP({ Q: [[NR(0), NR(-1)], [NR(-1), NR(0)]], c: [NR(0), NR(0)], A: [[NR(-1), NR(1)]], b: [NR(5)] });
    expect(b.error).toMatch(/unbounded/i);
    // with an upper bound it is bounded and the corner is reported
    const c = solveQP({ Q: [[NR(0), NR(-1)], [NR(-1), NR(0)]], c: [NR(0), NR(0)], A: [[NR(1), NR(1)]], b: [NR(4)] });
    expect(c.error).toBeUndefined();
    expect(c.objective.toString()).toBe('-4');
  });

  it('QP: indefinite objectives over a box equal the face-enumeration oracle', () => {
    const r = seeded(101);
    let indefinite = 0;
    for (let t = 0; t < 80; t++) {
      const n = ri(r, 1, 3);
      const Q = Array.from({ length: n }, () => Array<number>(n).fill(0));
      for (let i = 0; i < n; i++) for (let j = i; j < n; j++) { const v = ri(r, -4, 4); Q[i]![j] = v; Q[j]![i] = v; }
      const c = Array.from({ length: n }, () => ri(r, -8, 8));
      const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
      const b = Array.from({ length: n }, () => ri(r, 1, 6));
      const res = solveQP({ Q: Q.map(row => row.map(NR)), c: c.map(NR), A: A.map(row => row.map(NR)), b: b.map(NR) });
      const oracle = qpOracle(Q, c, A, b)!;
      expect(res.error, JSON.stringify({ Q, c, b })).toBeUndefined();
      if (!res.convex) indefinite++;
      expect(close(res.objective.toNumber(), oracle.obj, 1e-9, 1e-9), `objective ${res.objective.toNumber()} vs ${oracle.obj} ${JSON.stringify({ Q, c, b })}`).toBe(true);
    }
    expect(indefinite).toBeGreaterThan(20);
  });
});
