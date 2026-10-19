/**
 * Random-number-interval simulation of a discrete demand: cumulative probabilities, random-number intervals,
 * mapping each random number to a demand, and the day-by-day simulation table.
 *
 * Interval rule (stated in the explanations as well): with d digits the random numbers form a grid of M = 10^d values.
 * The upper boundary of row k is U_k = round(cum_k · M), rounding half up, and the last boundary is forced to M.
 *   convention "zero" (00…M−1):  row k owns the numbers  U_{k−1} … U_k − 1
 *   convention "one"  (01…M, with 00 read as M):  row k owns the numbers  U_{k−1}+1 … U_k
 * Every random number therefore belongs to exactly one row, and a row owns round-off-adjusted p·M numbers.
 */
import { Step } from '../../types/step';
import { makeRng } from './random';

export type Convention = 'zero' | 'one';
export const MAX_DAYS = 100000;
export const MAX_TABLE_ROWS = 200;
/** at most this many days are turned into separate player steps (the table always lists every day) */
export const STEP_DAYS = 400;

export const fmt = (x: number, d = 6): string => (Number.isFinite(x) ? Number(x.toFixed(d)).toString() : String(x));
export const padRn = (n: number, digits: number): string => String(n).padStart(digits, '0');

export interface IntervalRow {
  value: number; prob: number; cum: number;
  /** first and last random number of the interval, in the chosen convention; count = 0 means the interval is empty */
  lo: number; hi: number; count: number;
  label: string;
  /** count / M: the probability the interval really gives */
  impliedProb: number;
}

export interface IntervalTable {
  error?: string;
  warnings: string[];
  intervals: IntervalRow[];
  modulus: number;
  digits: number;
  convention: Convention;
  sum: number;
  /** upper boundaries U_k, used by the mapper */
  uppers: number[];
  expected: number;
  impliedExpected: number;
}

const emptyTable = (error: string, digits = 2, convention: Convention = 'zero'): IntervalTable => ({ error, warnings: [], intervals: [], modulus: 10 ** digits, digits, convention, sum: 0, uppers: [], expected: 0, impliedExpected: 0 });

export function intervalLabel(lo: number, hi: number, digits: number): string {
  if (hi < lo) return '— (empty)';
  return lo === hi ? padRn(lo, digits) : `${padRn(lo, digits)}–${padRn(hi, digits)}`;
}

/** Build the cumulative table and the random-number intervals. Never throws. */
export function buildIntervals(values: number[], probs: number[], digits: number, convention: Convention): IntervalTable {
  if (!Number.isInteger(digits) || digits < 1 || digits > 4) return emptyTable('Digits per random number must be a whole number from 1 to 4.');
  const M = 10 ** digits;
  if (convention !== 'zero' && convention !== 'one') return emptyTable('Unknown interval convention.', digits);
  if (values.length === 0) return emptyTable('Add at least one demand value with its probability.', digits, convention);
  if (values.length > MAX_TABLE_ROWS) return emptyTable(`At most ${MAX_TABLE_ROWS} table rows are supported.`, digits, convention);
  if (values.length !== probs.length) return emptyTable('Every demand value needs a probability.', digits, convention);
  for (const [i, v] of values.entries()) if (!Number.isFinite(v)) return emptyTable(`Row ${i + 1}: the demand value must be a finite number.`, digits, convention);
  for (const [i, p] of probs.entries()) {
    if (!Number.isFinite(p)) return emptyTable(`Row ${i + 1}: the probability must be a finite number.`, digits, convention);
    if (p < 0) return emptyTable(`Row ${i + 1}: the probability ${fmt(p)} is negative.`, digits, convention);
    if (p > 1 + 1e-9) return emptyTable(`Row ${i + 1}: the probability ${fmt(p)} exceeds 1.`, digits, convention);
  }
  const seen = new Set<number>();
  for (const v of values) { if (seen.has(v)) return emptyTable(`The demand value ${fmt(v)} appears twice; merge the rows by adding their probabilities.`, digits, convention); seen.add(v); }
  const sum = probs.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) return { ...emptyTable(`The probabilities add up to ${fmt(sum, 9)}, not 1. Adjust them until the total is exactly 1.`, digits, convention), sum };

  const warnings: string[] = [];
  const intervals: IntervalRow[] = [];
  const uppers: number[] = [];
  let cum = 0, prevU = 0;
  for (const [i, v] of values.entries()) {
    const p = probs[i]!;
    cum = Math.round((cum + p) * 1e12) / 1e12;
    let U = i === values.length - 1 ? M : Math.floor(cum * M + 0.5 + 1e-9);
    U = Math.min(M, Math.max(prevU, U));
    const count = U - prevU;
    const lo = convention === 'zero' ? prevU : prevU + 1;
    const hi = convention === 'zero' ? U - 1 : U;
    intervals.push({ value: v, prob: p, cum: i === values.length - 1 ? 1 : cum, lo, hi, count, label: count === 0 ? '— (empty)' : intervalLabel(lo, hi, digits), impliedProb: count / M });
    uppers.push(U);
    prevU = U;
  }
  const lost = intervals.filter(r => r.prob > 0 && r.count === 0);
  for (const r of lost) warnings.push(`Demand ${fmt(r.value)} (probability ${fmt(r.prob)}) is smaller than one step of the ${digits}-digit grid (1/${M}); its interval is empty so it can never be drawn. Use more digits.`);
  const off = intervals.filter(r => Math.abs(r.count - r.prob * M) > 1e-6 && !(r.prob > 0 && r.count === 0));
  if (off.length) warnings.push(`Probabilities ${off.map(r => fmt(r.prob)).join(', ')} do not fall exactly on the ${digits}-digit grid (multiples of 1/${M}). Each cumulative boundary is rounded to the nearest whole random number (halves round up), so the interval sizes differ slightly from p·${M}; more digits make the match closer.`);
  const expected = values.reduce((a, v, i) => a + v * probs[i]!, 0);
  const impliedExpected = intervals.reduce((a, r) => a + r.value * r.impliedProb, 0);
  return { warnings, intervals, modulus: M, digits, convention, sum, uppers, expected: Math.round(expected * 1e10) / 1e10, impliedExpected: Math.round(impliedExpected * 1e10) / 1e10 };
}

/** Index of the interval row owning random number `raw` (raw 0 means M under the "one" convention). -1 if out of range. */
export function mapRn(t: IntervalTable, raw: number): number {
  const M = t.modulus;
  const eff = t.convention === 'one' && raw === 0 ? M : raw;
  if (!Number.isInteger(eff) || eff < (t.convention === 'zero' ? 0 : 1) || eff > (t.convention === 'zero' ? M - 1 : M)) return -1;
  const x = t.convention === 'zero' ? eff + 1 : eff;
  let lo = 0, hi = t.uppers.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (x <= t.uppers[mid]!) hi = mid; else lo = mid + 1; }
  return t.uppers.length ? lo : -1;
}

/** Parse a typed or pasted list of random numbers (comma, space, semicolon or newline separated). */
export function parseRandomNumbers(text: string, digits: number, convention: Convention, max = MAX_DAYS): { rns: number[] } | { error: string } {
  if (!Number.isInteger(digits) || digits < 1 || digits > 4) return { error: 'Digits per random number must be a whole number from 1 to 4.' };
  const M = 10 ** digits;
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  if (tokens.length === 0) return { error: 'Enter at least one random number.' };
  if (tokens.length > max) return { error: `At most ${max.toLocaleString()} random numbers are supported (you entered ${tokens.length.toLocaleString()}).` };
  const lo = 0, hi = convention === 'zero' ? M - 1 : M;
  const range = convention === 'zero' ? `${padRn(0, digits)}–${padRn(M - 1, digits)}` : `${padRn(1, digits)}–${M} (00 stands for ${M})`;
  const out: number[] = [];
  for (const [i, t] of tokens.entries()) {
    const shown = t.length > 16 ? t.slice(0, 16) + '…' : t;
    if (!/^\d+$/.test(t)) return { error: `Random number ${i + 1} ("${shown}") is not a non-negative whole number.` };
    const v = t.length > 9 ? Infinity : Number(t);
    if (v < lo || v > hi) return { error: `Random number ${i + 1} ("${shown}") is outside the range ${range} for ${digits} digit${digits > 1 ? 's' : ''}.` };
    out.push(v);
  }
  return { rns: out };
}

/** Draw n random numbers of `digits` digits from a seedable generator. */
export function generateRandomNumbers(n: number, digits: number, generator: 'lcg' | 'mt', seed: number, convention: Convention): number[] {
  const M = 10 ** digits;
  const rng = makeRng(generator, seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const k = Math.min(M - 1, Math.floor(rng.next() * M)); out.push(convention === 'zero' ? k : k + 1); }
  return out;
}

export interface DayRow {
  day: number; rn: number; rnLabel: string; interval: string; row: number; demand: number; cumDemand: number; runningAvg: number;
}

export interface DemandInput { values: number[]; probs: number[]; digits: number; convention: Convention; rns: number[] }

export interface DemandSim {
  error?: string;
  warnings: string[];
  table: IntervalTable;
  days: DayRow[];
  total: number; mean: number; expected: number; impliedExpected: number;
  /** observed relative frequency and theoretical probability per table row */
  observed: number[]; counts: number[]; theoretical: number[];
}

const failSim = (error: string, table?: IntervalTable): DemandSim => ({ error, warnings: table?.warnings ?? [], table: table ?? emptyTable(error), days: [], total: 0, mean: 0, expected: 0, impliedExpected: 0, observed: [], counts: [], theoretical: [] });

export function simulateDemand(input: DemandInput): DemandSim {
  const table = buildIntervals(input.values, input.probs, input.digits, input.convention);
  if (table.error) return failSim(table.error, table);
  if (input.rns.length === 0) return failSim('Enter at least one random number.', table);
  if (input.rns.length > MAX_DAYS) return failSim(`At most ${MAX_DAYS.toLocaleString()} days can be simulated.`, table);
  const days: DayRow[] = [];
  const counts = table.intervals.map(() => 0);
  let total = 0;
  for (const [i, rn] of input.rns.entries()) {
    const k = mapRn(table, rn);
    if (k < 0) return failSim(`Random number ${i + 1} (${rn}) is outside the allowed range for ${input.digits} digit(s).`, table);
    const r = table.intervals[k]!;
    total += r.value; counts[k] = (counts[k] ?? 0) + 1;
    days.push({ day: i + 1, rn, rnLabel: padRn(rn, input.digits), interval: r.label, row: k, demand: r.value, cumDemand: total, runningAvg: total / (i + 1) });
  }
  const n = days.length;
  return { warnings: table.warnings, table, days, total, mean: total / n, expected: table.expected, impliedExpected: table.impliedExpected, counts, observed: counts.map(c => c / n), theoretical: table.intervals.map(r => r.prob) };
}

/* ------------------------------ step-by-step walkthrough ------------------------------ */

export interface DemandStepState { phase: 'cum' | 'intervals' | 'day' | 'summary'; day: number }

export function demandSteps(sim: DemandSim): Step<DemandStepState>[] {
  if (sim.error) return [];
  const t = sim.table, M = t.modulus, d = t.digits;
  const steps: Step<DemandStepState>[] = [];
  const push = (phase: string, state: DemandStepState, action: string, short: string, detailed: string, rule: string, formula?: string, note?: string) =>
    steps.push({ index: steps.length, phase, state, action: { kind: action, payload: state }, explanation: { short, detailed, rule, formula, note }, highlights: [], status: 'continue' });
  const rangeText = t.convention === 'zero' ? `00 to ${padRn(M - 1, d)}` : `01 to ${M} (a drawn 00 is read as ${M})`;
  push('Cumulative probabilities', { phase: 'cum', day: 0 }, 'cumulative',
    `Add the probabilities down the table: the last cumulative value is ${fmt(t.intervals[t.intervals.length - 1]?.cum ?? 1)}.`,
    `Each cumulative probability is the running total of the probabilities up to and including that demand: ${t.intervals.map(r => `P(D ≤ ${fmt(r.value)}) = ${fmt(r.cum)}`).join(', ')}. The probabilities add up to ${fmt(t.sum, 9)}, so the table is a valid distribution.`,
    'Cumulative distribution', 'F(x_k)=\\sum_{j\\le k} p_j');
  push('Random-number intervals', { phase: 'intervals', day: 0 }, 'intervals',
    `Give each demand a block of ${d}-digit random numbers (${rangeText}) as large as its probability.`,
    `With ${d} digit${d > 1 ? 's' : ''} there are ${M} equally likely random numbers, ${rangeText}. The boundary of each row is its cumulative probability × ${M}, rounded to the nearest whole number (halves round up): ${t.intervals.map(r => `${fmt(r.value)} → ${r.label}`).join('; ')}. A demand with probability p therefore receives about p × ${M} random numbers, and a uniformly drawn random number lands in a block with exactly that probability.`,
    t.convention === 'zero' ? 'Intervals 00…' + padRn(M - 1, d) : 'Intervals 01…' + M,
    undefined, t.warnings[0]);
  const shown = Math.min(sim.days.length, STEP_DAYS);
  for (let i = 0; i < shown; i++) {
    const r = sim.days[i]!;
    const row = t.intervals[r.row]!;
    const eff = t.convention === 'one' && r.rn === 0 ? ` (read as ${M})` : '';
    push(`Day ${r.day}`, { phase: 'day', day: r.day }, 'map',
      `Day ${r.day}: random number ${r.rnLabel} lies in ${row.label}, so the demand is ${fmt(r.demand)}.`,
      `Day ${r.day} uses random number ${r.rnLabel}${eff}. Looking it up in the interval column: ${row.label} belongs to demand ${fmt(r.demand)} (probability ${fmt(row.prob)}). Total demand so far is ${fmt(r.cumDemand)}, so the running average over ${r.day} day${r.day > 1 ? 's' : ''} is ${fmt(r.runningAvg, 4)}.`,
      'Map the random number to its interval');
  }
  push('Summary', { phase: 'summary', day: sim.days.length }, 'summary',
    `Simulated total ${fmt(sim.total)} over ${sim.days.length} day${sim.days.length > 1 ? 's' : ''}, mean ${fmt(sim.mean, 4)} per day; theoretical E[D] = ${fmt(sim.expected, 6)}.`,
    `The simulated demand totals ${fmt(sim.total)}, a mean of ${fmt(sim.mean, 4)} per day. The theoretical expected demand is E[D] = Σ x·p = ${fmt(sim.expected, 6)}. ${Math.abs(sim.mean - sim.expected) < 1e-9 ? 'They agree exactly.' : `The simulated mean differs by ${fmt(sim.mean - sim.expected, 4)}; with only ${sim.days.length} days sampling noise is expected, and the gap shrinks roughly like 1/√n.`}${sim.days.length > shown ? ` The player stepped through the first ${shown} days; the table lists all ${sim.days.length}.` : ''}`,
    'Compare simulation with expectation', 'E[D]=\\sum_k x_k\\,p_k');
  return steps;
}
