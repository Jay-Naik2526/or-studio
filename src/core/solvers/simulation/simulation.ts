/**
 * Simulation (spec §9.4): Monte-Carlo estimation with convergence tracking and a discrete-event
 * multi-server queue simulation with a full event trace. Fully reproducible via a user-set seed.
 */

import { Distribution, Rng, compileExpression, makeRng, sample, validateDistribution, describeDistribution } from './random';

export interface MonteCarloInput {
  variables: { name: string; dist: Distribution }[];
  expression: string;
  trials: number;
  seed: number;
  generator: 'lcg' | 'mt';
  bins?: number;
  /** estimate P(expression ≥ threshold) as well */
  threshold?: number;
}

export interface MonteCarloResult {
  error?: string;
  generator: string;
  seed: number;
  n: number;
  mean: number;
  stdDev: number;
  stdError: number;
  ci95: [number, number];
  min: number;
  max: number;
  median: number;
  percentiles: { p: number; value: number }[];
  histogram: { from: number; to: number; count: number }[];
  /** running mean at ~100 checkpoints */
  convergence: { n: number; mean: number; lo: number; hi: number }[];
  probAtLeast?: number;
  samples: number[];
}

export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const empty = { generator: '', seed: input.seed, n: 0, mean: 0, stdDev: 0, stdError: 0, ci95: [0, 0] as [number, number], min: 0, max: 0, median: 0, percentiles: [], histogram: [], convergence: [], samples: [] };
  if (!(input.trials >= 1) || input.trials > 2_000_000) return { ...empty, error: 'The number of trials must be between 1 and 2,000,000.' };
  for (const v of input.variables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)) return { ...empty, error: `"${v.name}" is not a valid variable name.` };
    const e = validateDistribution(v.dist);
    if (e) return { ...empty, error: `${v.name}: ${e}` };
  }
  let fn: (env: Record<string, number>) => number;
  try { fn = compileExpression(input.expression, input.variables.map(v => v.name)); } catch (e) { return { ...empty, error: `Expression error: ${(e as Error).message}` }; }
  const rng = makeRng(input.generator, input.seed);
  const n = Math.floor(input.trials);
  const xs: number[] = new Array(n);
  let sum = 0, sumSq = 0;
  const conv: MonteCarloResult['convergence'] = [];
  const every = Math.max(1, Math.floor(n / 100));
  const env: Record<string, number> = {};
  let atLeast = 0;
  for (let i = 0; i < n; i++) {
    for (const v of input.variables) env[v.name] = sample(v.dist, rng);
    const y = fn(env);
    if (!Number.isFinite(y)) return { ...empty, error: `The expression produced a non-finite value on trial ${i + 1} (check for division by zero or ln of a non-positive number).` };
    xs[i] = y;
    sum += y; sumSq += y * y;
    if (input.threshold !== undefined && y >= input.threshold) atLeast++;
    if ((i + 1) % every === 0 || i === n - 1) {
      const k = i + 1, mu = sum / k, sd = Math.sqrt(Math.max(0, (sumSq - k * mu * mu) / Math.max(1, k - 1)));
      const se = sd / Math.sqrt(k);
      conv.push({ n: k, mean: mu, lo: mu - 1.96 * se, hi: mu + 1.96 * se });
    }
  }
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, (sumSq - n * mean * mean) / Math.max(1, n - 1)));
  const se = sd / Math.sqrt(n);
  const sorted = [...xs].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor((p / 100) * n)))]!;
  const lo = sorted[0]!, hi = sorted[n - 1]!;
  const bins = Math.max(2, Math.min(60, input.bins ?? 20));
  const w = (hi - lo) / bins || 1;
  const hist = Array.from({ length: bins }, (_, b) => ({ from: lo + b * w, to: lo + (b + 1) * w, count: 0 }));
  for (const x of xs) hist[Math.min(bins - 1, Math.floor((x - lo) / w))]!.count++;
  return {
    generator: rng.name, seed: input.seed, n, mean, stdDev: sd, stdError: se, ci95: [mean - 1.96 * se, mean + 1.96 * se],
    min: lo, max: hi, median: pct(50), percentiles: [5, 25, 50, 75, 95].map(p => ({ p, value: pct(p) })), histogram: hist, convergence: conv,
    probAtLeast: input.threshold !== undefined ? atLeast / n : undefined, samples: n <= 20000 ? xs : xs.slice(0, 20000),
  };
}

/* ---------------- discrete-event queue simulation ---------------- */

export interface QueueSimInput {
  interarrival: Distribution;
  service: Distribution;
  servers: number;
  customers: number;
  seed: number;
  generator: 'lcg' | 'mt';
  warmup?: number;
}

export interface QueueEvent { time: number; type: 'arrival' | 'start' | 'departure'; customer: number; server?: number; queueLength: number; inSystem: number }
export interface CustomerRecord { id: number; arrival: number; start: number; end: number; wait: number; service: number; server: number }

export interface QueueSimResult {
  error?: string;
  generator: string;
  seed: number;
  customers: CustomerRecord[];
  events: QueueEvent[];
  avgWait: number;
  avgSystemTime: number;
  utilisation: number;
  avgQueueLength: number;
  avgInSystem: number;
  maxQueueLength: number;
  probWait: number;
  duration: number;
  /** time-weighted number in system sampled at event times, for the chart */
  occupancy: { time: number; inSystem: number; queue: number }[];
  /** waiting-time running average */
  waitConvergence: { n: number; avg: number }[];
  warnings: string[];
}

export function runQueueSimulation(input: QueueSimInput): QueueSimResult {
  const blank: QueueSimResult = { generator: '', seed: input.seed, customers: [], events: [], avgWait: 0, avgSystemTime: 0, utilisation: 0, avgQueueLength: 0, avgInSystem: 0, maxQueueLength: 0, probWait: 0, duration: 0, occupancy: [], waitConvergence: [], warnings: [] };
  const c = Math.floor(input.servers);
  if (!(c >= 1)) return { ...blank, error: 'There must be at least one server.' };
  if (c > 1000) return { ...blank, error: 'At most 1,000 servers are supported.' };
  if (!(input.customers >= 1) || input.customers > 500000) return { ...blank, error: 'The number of customers must be between 1 and 500,000.' };
  for (const [nm, d] of [['Interarrival', input.interarrival], ['Service', input.service]] as const) { const e = validateDistribution(d); if (e) return { ...blank, error: `${nm} time — ${e}` }; }
  const rng: Rng = makeRng(input.generator, input.seed);
  const N = Math.floor(input.customers);
  const free = Array(c).fill(0);
  const recs: CustomerRecord[] = [];
  let t = 0;
  for (let i = 1; i <= N; i++) {
    t += Math.max(0, sample(input.interarrival, rng));
    const s = Math.max(0, sample(input.service, rng));
    let k = 0;
    for (let j = 1; j < c; j++) if (free[j]! < free[k]!) k = j;
    const start = Math.max(t, free[k]!);
    free[k] = start + s;
    recs.push({ id: i, arrival: t, start, end: start + s, wait: start - t, service: s, server: k + 1 });
  }
  // events + occupancy via sweep
  type Ev = { time: number; type: 'arrival' | 'start' | 'departure'; customer: number; server?: number; order: number };
  const evs: Ev[] = [];
  recs.forEach(r => { evs.push({ time: r.arrival, type: 'arrival', customer: r.id, order: 0 }, { time: r.start, type: 'start', customer: r.id, server: r.server, order: 1 }, { time: r.end, type: 'departure', customer: r.id, server: r.server, order: 2 }); });
  evs.sort((a, b) => a.time - b.time || a.order - b.order || a.customer - b.customer);
  let inSys = 0, q = 0, maxQ = 0, lastT = 0, areaSys = 0, areaQ = 0;
  const events: QueueEvent[] = [];
  const occ: QueueSimResult['occupancy'] = [];
  for (const e of evs) {
    areaSys += inSys * (e.time - lastT); areaQ += q * (e.time - lastT); lastT = e.time;
    if (e.type === 'arrival') { inSys++; q++; } else if (e.type === 'start') { q--; } else { inSys--; }
    maxQ = Math.max(maxQ, q);
    if (events.length < 400) events.push({ time: e.time, type: e.type, customer: e.customer, server: e.server, queueLength: q, inSystem: inSys });
    if (occ.length < 2000 || e.time === evs[evs.length - 1]!.time) occ.push({ time: e.time, inSystem: inSys, queue: q });
  }
  const warm = Math.min(N - 1, Math.max(0, Math.floor(input.warmup ?? 0)));
  const use = recs.slice(warm);
  const dur = lastT;
  const busy = recs.reduce((s, r) => s + r.service, 0);
  const conv: QueueSimResult['waitConvergence'] = [];
  let acc = 0;
  const every = Math.max(1, Math.floor(use.length / 100));
  use.forEach((r, i) => { acc += r.wait; if ((i + 1) % every === 0) conv.push({ n: i + 1, avg: acc / (i + 1) }); });
  const warnings: string[] = [];
  const meanIA = describeMean(input.interarrival), meanS = describeMean(input.service);
  if (meanIA !== null && meanS !== null && meanS / c >= meanIA) warnings.push(`The mean service time per server (${(meanS / c).toFixed(3)}) is not below the mean interarrival time (${meanIA.toFixed(3)}): the queue is unstable and waiting times will keep growing with the run length.`);
  if (warm === 0) warnings.push('No warm-up period was discarded; early customers see an empty system, which biases averages downward.');
  return {
    generator: rng.name, seed: input.seed, customers: recs, events,
    avgWait: use.reduce((s, r) => s + r.wait, 0) / use.length,
    avgSystemTime: use.reduce((s, r) => s + r.wait + r.service, 0) / use.length,
    utilisation: busy / (c * dur),
    avgQueueLength: areaQ / dur, avgInSystem: areaSys / dur, maxQueueLength: maxQ,
    probWait: use.filter(r => r.wait > 1e-12).length / use.length,
    duration: dur, occupancy: occ, waitConvergence: conv, warnings,
  };
}

export function describeMean(d: Distribution): number | null {
  switch (d.type) {
    case 'uniform': return (d.a + d.b) / 2;
    case 'exponential': return 1 / d.rate;
    case 'normal': return d.mean;
    case 'triangular': return (d.a + d.m + d.b) / 3;
    case 'poisson': return d.mean;
    case 'discrete': return d.values.reduce((s, v, i) => s + v * d.probs[i]!, 0);
    case 'constant': return d.value;
  }
}

export { describeDistribution };
