/**
 * Queuing analysis (spec §9.4): M/M/1, M/M/c, M/M/1/N, M/M/c/N, M/M/c/N/N (machine servicing), M/G/1,
 * with stability checks, prose interpretation and a server-count cost model.
 * Float64 is acceptable here (spec §9.1). Errors are returned, never thrown.
 */

export type QueueModelType = 'mm1' | 'mmc' | 'mm1n' | 'mmcn' | 'mmcnn' | 'mg1';

export interface QueueInput {
  model?: QueueModelType;
  lambda: number;        // arrival rate (per customer for machine servicing)
  mu: number;            // service rate per server
  servers?: number;      // c
  capacity?: number;     // N (system capacity) — for machine servicing: K = number of machines
  serviceStdDev?: number; // σ of service time (M/G/1)
  costPerServer?: number;  // Cs per server per unit time
  costPerWait?: number;    // Cw per customer per unit time
  costBasis?: 'system' | 'queue';
}

export interface QueueMetrics {
  model: QueueModelType;
  rho: number;
  stable: boolean;
  P0: number;
  Ls: number;
  Lq: number;
  Ws: number;
  Wq: number;
  effectiveLambda: number;
  /** probability an arriving customer must wait (Erlang-C style) when defined */
  probWait?: number;
  /** probability an arriving customer is turned away (finite capacity) */
  probBlocked?: number;
  /** distribution P0..Pk */
  Pk: number[];
  /** expected number of idle servers / utilisation of each server */
  serverUtilisation: number;
}

export interface QueueStep { stepNumber: number; title: string; explanation: string; formula?: string; values?: Record<string, number | string> }

export interface CostPoint { c: number; Ls: number; Lq: number; serverCost: number; waitingCost: number; totalCost: number }

export interface QueueResult {
  error?: string;
  metrics?: QueueMetrics;
  steps: QueueStep[];
  interpretation: string[];
  costOptimization?: { optimalServers: number; minTotalCost: number; candidates: CostPoint[] };
}

/** ln(n!) table built once; log-space keeps large c, N and K free of overflow. */
const LF: number[] = [0];
const lfact = (n: number) => { while (LF.length <= n) LF.push(LF[LF.length - 1]! + Math.log(LF.length)); return LF[n]!; };
export const MAX_SERVERS = 2000;
export const MAX_CAPACITY = 5000;
const f4 = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(4)).toString() : '∞');

function fail(error: string): QueueResult { return { error, steps: [], interpretation: [] }; }

/** Normalise weights given as logarithms (subtracting the maximum avoids overflow and underflow). */
function logDistribution(lw: number[]): number[] {
  const m = Math.max(...lw);
  const w = lw.map(x => Math.exp(x - m));
  const s = w.reduce((a, b) => a + b, 0);
  return w.map(x => x / s);
}

export function solveQueue(input: QueueInput): QueueResult {
  const { lambda, mu } = input;
  const c = Math.max(1, Math.floor(input.servers ?? 1));
  const model: QueueModelType = input.model ?? (input.capacity ? (c > 1 ? 'mmcn' : 'mm1n') : c > 1 ? 'mmc' : 'mm1');
  if (!(lambda > 0) || !Number.isFinite(lambda)) return fail('The arrival rate λ must be a positive number.');
  if (!(mu > 0) || !Number.isFinite(mu)) return fail('The service rate μ must be positive (μ = 0 would mean customers are never served).');
  const steps: QueueStep[] = [];
  const interp: string[] = [];
  if (!Number.isFinite(c) || c > MAX_SERVERS) return fail(`At most ${MAX_SERVERS} servers are supported.`);
  if (input.capacity !== undefined && (!Number.isFinite(input.capacity) || input.capacity > MAX_CAPACITY)) return fail(`The capacity (or number of machines) can be at most ${MAX_CAPACITY}.`);
  if (input.capacity !== undefined && input.capacity < 0) return fail('The capacity cannot be negative.');
  const effC = model === 'mm1' || model === 'mm1n' || model === 'mg1' ? 1 : c;
  const r = lambda / mu;
  const rho = r / effC;
  let step = 0;
  const add = (title: string, explanation: string, formula?: string, values?: Record<string, number | string>) => steps.push({ stepNumber: ++step, title, explanation, formula, values });

  let P: number[] = [];
  let P0 = 0, Ls = 0, Lq = 0, effLambda = lambda;
  let probWait: number | undefined;
  let probBlocked: number | undefined;
  const N = input.capacity !== undefined ? Math.floor(input.capacity) : undefined;

  if (model === 'mm1' || model === 'mmc' || model === 'mg1') {
    if (rho >= 1) {
      return {
        error: `Unstable queue: ρ = λ/(c·μ) = ${lambda}/(${effC}·${mu}) = ${f4(rho)} ≥ 1. Customers arrive at least as fast as the servers can work, so the queue grows without limit and no steady state exists. Increase μ or the number of servers, or reduce λ.`,
        steps: [{ stepNumber: 1, title: 'Stability check failed', explanation: `ρ = ${f4(rho)} ≥ 1`, formula: '\\rho = \\lambda/(c\\mu) \\ge 1' }],
        interpretation: [],
      };
    }
    add('Traffic intensity', `ρ = λ / (c·μ) = ${lambda} / (${effC} × ${mu}) = ${f4(rho)} < 1, so the queue is stable.`, '\\rho = \\frac{\\lambda}{c\\mu}', { λ: lambda, μ: mu, c: effC, ρ: rho });
  }

  if (model === 'mm1') {
    P0 = 1 - rho; Ls = rho / (1 - rho); Lq = rho * rho / (1 - rho);
    add('M/M/1 formulas', `P₀ = 1 − ρ = ${f4(P0)}; Lₛ = ρ/(1−ρ) = ${f4(Ls)}; L_q = ρ²/(1−ρ) = ${f4(Lq)}. By Little's law Wₛ = Lₛ/λ and W_q = L_q/λ.`, 'L_s = \\frac{\\rho}{1-\\rho},\; L_q = \\frac{\\rho^2}{1-\\rho}');
    probWait = rho;
    P = Array.from({ length: 21 }, (_, n) => (1 - rho) * Math.pow(rho, n));
  } else if (model === 'mg1') {
    const sigma = input.serviceStdDev ?? 1 / mu;
    if (sigma < 0) return fail('The standard deviation of the service time cannot be negative.');
    Lq = (lambda * lambda * sigma * sigma + rho * rho) / (2 * (1 - rho));
    Ls = Lq + rho; P0 = 1 - rho;
    add('Pollaczek–Khinchine formula', `With service-time standard deviation σ = ${sigma}: L_q = (λ²σ² + ρ²) / (2(1−ρ)) = ${f4(Lq)}; Lₛ = L_q + ρ = ${f4(Ls)}. σ = 1/μ gives M/M/1 and σ = 0 gives M/D/1 (half the queue of M/M/1).`, 'L_q = \\frac{\\lambda^2\\sigma^2+\\rho^2}{2(1-\\rho)}');
    probWait = rho;
    P = [P0];
  } else if (model === 'mmc') {
    const lr = Math.log(r);
    let sum = 0;
    for (let n = 0; n < c; n++) sum += Math.exp(n * lr - lfact(n));
    const tail = Math.exp(c * lr - lfact(c)) / (1 - rho);
    P0 = 1 / (sum + tail);
    Lq = P0 * tail * rho / (1 - rho);
    Ls = Lq + r;
    probWait = tail * P0;
    add('M/M/c formulas', `P₀ = [Σₙ₌₀^{c−1} rⁿ/n! + r^c/(c!(1−ρ))]⁻¹ = ${f4(P0)} with r = λ/μ = ${f4(r)}. Probability an arrival must wait (Erlang C) = ${f4(probWait)}. L_q = P₀ r^c ρ / (c!(1−ρ)²) = ${f4(Lq)}, Lₛ = L_q + r = ${f4(Ls)}.`, 'P_0=\\Big[\\sum_{n=0}^{c-1}\\frac{r^n}{n!}+\\frac{r^c}{c!(1-\\rho)}\\Big]^{-1}');
    P = Array.from({ length: 21 }, (_, n) => Math.exp(n * lr - (n < c ? lfact(n) : lfact(c) + (n - c) * Math.log(c))) * P0);
  } else if (model === 'mm1n' || model === 'mmcn') {
    if (!N || N < effC) return fail(`The system capacity N (${input.capacity}) must be at least the number of servers (${effC}).`);
    const lr = Math.log(r);
    const lw: number[] = [];
    for (let n = 0; n <= N; n++) lw.push(n * lr - (n < effC ? lfact(n) : lfact(effC) + (n - effC) * Math.log(effC)));
    P = logDistribution(lw);
    P0 = P[0]!;
    probBlocked = P[N]!;
    effLambda = lambda * (1 - probBlocked);
    Ls = P.reduce((s, p, n) => s + n * p, 0);
    Lq = P.reduce((s, p, n) => s + Math.max(0, n - effC) * p, 0);
    add(`${effC === 1 ? 'M/M/1/N' : 'M/M/c/N'} distribution`, `The system holds at most N = ${N} customers, so it is always stable (even for ρ ≥ 1). P_n ∝ rⁿ/n! (n<c) and rⁿ/(c!·c^{n−c}) (n≥c), normalised: P₀ = ${f4(P0)}, P_N = ${f4(probBlocked)}. Arrivals finding the system full are lost, so λ_eff = λ(1 − P_N) = ${f4(effLambda)}. Lₛ = Σ n·Pₙ = ${f4(Ls)}, L_q = Σ (n−c)⁺Pₙ = ${f4(Lq)}.`, '\\lambda_{eff}=\\lambda(1-P_N)');
    probWait = P.slice(effC).reduce((a, b) => a + b, 0);
    if (rho >= 1) interp.push(`ρ = ${f4(rho)} ≥ 1, but the finite capacity keeps the system stable: the price is that ${f4(probBlocked * 100)}% of arrivals are turned away.`);
  } else if (model === 'mmcnn') {
    const K = N;
    if (!K || K < 1) return fail('Enter the number of machines (population size K ≥ 1).');
    if (effC > K) return fail(`The number of repairmen/servers (${effC}) cannot exceed the number of machines (${K}).`);
    const lr = Math.log(r);
    const lw: number[] = [];
    for (let n = 0; n <= K; n++) lw.push(n <= effC ? lfact(K) - lfact(n) - lfact(K - n) + n * lr : lfact(K) - lfact(K - n) - lfact(effC) - (n - effC) * Math.log(effC) + n * lr);
    P = logDistribution(lw);
    P0 = P[0]!;
    Ls = P.reduce((s, p, n) => s + n * p, 0);
    Lq = P.reduce((s, p, n) => s + Math.max(0, n - effC) * p, 0);
    effLambda = lambda * (K - Ls);
    add('Machine-servicing model (M/M/c/K/K)', `K = ${K} machines each fail at rate λ = ${lambda} when running; ${effC} server(s) repair at rate μ = ${mu}. Pₙ = C(K,n)rⁿP₀ for n ≤ c, and K!/((K−n)!c!c^{n−c})·rⁿP₀ beyond. P₀ = ${f4(P0)}. Mean machines down Lₛ = ${f4(Ls)}, waiting L_q = ${f4(Lq)}, effective failure rate λ_eff = λ(K − Lₛ) = ${f4(effLambda)}.`, '\\lambda_{eff}=\\lambda(K-L_s)');
    probWait = P.slice(effC).reduce((a, b) => a + b, 0);
  }

  const Ws = Ls / effLambda;
  const Wq = Lq / effLambda;
  const util = model === 'mmcnn' ? (effLambda / mu) / effC : model === 'mm1n' || model === 'mmcn' ? (effLambda / mu) / effC : rho;
  if (steps.length === 0 || model !== 'mm1') add('Waiting times (Little\'s law)', `Wₛ = Lₛ/λ_eff = ${f4(Ws)}, W_q = L_q/λ_eff = ${f4(Wq)}.`, 'W = L/\\lambda_{eff}');
  else add('Waiting times (Little\'s law)', `Wₛ = Lₛ/λ = ${f4(Ws)}, W_q = L_q/λ = ${f4(Wq)}.`, 'W = L/\\lambda');
  const unit = 'time units';
  interp.push(
    `On average ${f4(Ls)} customers are in the system (${f4(Lq)} waiting) and a customer spends ${f4(Ws)} ${unit} in the system, ${f4(Wq)} ${unit} of it in the queue.`,
    `Each server is busy ${f4(util * 100)}% of the time; the system is completely empty ${f4(P0 * 100)}% of the time.`
  );
  if (probBlocked !== undefined) interp.push(`${f4(probBlocked * 100)}% of arriving customers find the system full and are lost.`);
  else if (probWait !== undefined) interp.push(`${f4(probWait * 100)}% of arriving customers have to wait.`);

  const metrics: QueueMetrics = { model, rho, stable: true, P0, Ls, Lq, Ws, Wq, effectiveLambda: effLambda, probWait, probBlocked, Pk: P, serverUtilisation: util };
  const out: QueueResult = { metrics, steps, interpretation: interp };

  if (input.costPerServer !== undefined && input.costPerWait !== undefined && input.costPerServer >= 0 && input.costPerWait >= 0 && model !== 'mm1' && model !== 'mg1' && model !== 'mm1n' || (input.costPerServer !== undefined && input.costPerWait !== undefined && (model === 'mm1' || model === 'mg1'))) {
    out.costOptimization = optimiseServers({ ...input, model: model === 'mmcnn' ? 'mmcnn' : model === 'mmcn' ? 'mmcn' : 'mmc' });
    if (out.costOptimization) interp.push(`Cost-optimal number of servers: c* = ${out.costOptimization.optimalServers} (total cost ${f4(out.costOptimization.minTotalCost)} per unit time).`);
  }
  return out;
}

export function optimiseServers(input: QueueInput, maxExtra = 12): QueueResult['costOptimization'] | undefined {
  const Cs = input.costPerServer ?? 0;
  const Cw = input.costPerWait ?? 0;
  const basis = input.costBasis ?? 'system';
  const model = input.model ?? 'mmc';
  const cMin = model === 'mmcn' || model === 'mmcnn' ? 1 : Math.max(1, Math.floor(input.lambda / input.mu) + 1);
  const candidates: CostPoint[] = [];
  const cMax = model === 'mmcnn' ? Math.min(input.capacity ?? cMin + maxExtra, cMin + maxExtra) : cMin + maxExtra;
  for (let c = cMin; c <= cMax; c++) {
    const res = solveQueue({ ...input, model: c === 1 && (model === 'mmc') ? 'mm1' : model, servers: c, costPerServer: undefined, costPerWait: undefined });
    if (!res.metrics) continue;
    const L = basis === 'system' ? res.metrics.Ls : res.metrics.Lq;
    candidates.push({ c, Ls: res.metrics.Ls, Lq: res.metrics.Lq, serverCost: c * Cs, waitingCost: L * Cw, totalCost: c * Cs + L * Cw });
  }
  if (!candidates.length) return undefined;
  const best = candidates.reduce((a, b) => (b.totalCost < a.totalCost ? b : a));
  return { optimalServers: best.c, minTotalCost: best.totalCost, candidates };
}
