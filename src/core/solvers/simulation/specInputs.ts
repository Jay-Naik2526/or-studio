/** Turns the text fields of the Simulation variants (SimSpec) into validated solver inputs. Never throws. */
import { parseNum } from '../../../lib/numbers';
import type { SimDemandSpec, SimInventorySpec, SimRngSpec, SimTableRow } from '../../../data/specs';
import { Convention, DemandInput, MAX_DAYS, generateRandomNumbers, parseRandomNumbers } from './demandTable';
import { InventoryInput, generateInventoryRns } from './inventorySim';
import { GenRun, lcgRun, midSquareRun } from './rngLab';

const clip = (s: string) => (s.length > 24 ? s.slice(0, 24) + '…' : s);

/** exact parse of a number field (integers, decimals, fractions) */
export function readNumber(label: string, text: string): { v: number } | { error: string } {
  const r = parseNum(text);
  if (!r.ok) return { error: r.error === 'empty' ? `${label}: enter a number.` : `${label}: "${clip(text)}" is not a number.` };
  const v = Number(r.value.toDecimal(15));
  return Number.isFinite(v) ? { v } : { error: `${label}: the number is too large.` };
}

export function readInt(label: string, text: string, min: number, max: number): { v: number } | { error: string } {
  const r = readNumber(label, text);
  if ('error' in r) return r;
  if (!Number.isInteger(r.v) || r.v < min || r.v > max) return { error: `${label}: enter a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.` };
  return r;
}

export function readTable(label: string, rows: SimTableRow[]): { values: number[]; probs: number[] } | { error: string } {
  if (!rows.length) return { error: `${label}: add at least one row.` };
  const values: number[] = [], probs: number[] = [];
  for (const [i, r] of rows.entries()) {
    const v = readNumber(`${label}, row ${i + 1} value`, r.value);
    if ('error' in v) return v;
    const p = readNumber(`${label}, row ${i + 1} probability`, r.prob);
    if ('error' in p) return p;
    values.push(v.v); probs.push(p.v);
  }
  return { values, probs };
}

const firstError = (...r: ({ error: string } | object)[]): string | null => { for (const x of r) if ('error' in x) return (x as { error: string }).error; return null; };
const conv = (c: string): Convention => (c === 'one' ? 'one' : 'zero');

export function demandInputFromSpec(d: SimDemandSpec, generator: 'lcg' | 'mt', seed: number): { input: DemandInput } | { error: string } {
  const digits = readInt('Digits per random number', d.digits, 1, 4);
  const table = readTable('Demand table', d.rows);
  const bad = firstError(digits, table);
  if (bad) return { error: bad };
  const dg = (digits as { v: number }).v, tb = table as { values: number[]; probs: number[] };
  let rns: number[];
  if (d.source === 'given') {
    const p = parseRandomNumbers(d.rns, dg, conv(d.convention));
    if ('error' in p) return p;
    rns = p.rns;
  } else {
    const days = readInt('Number of days', d.days, 1, MAX_DAYS);
    if ('error' in days) return days;
    rns = generateRandomNumbers(days.v, dg, generator, seed, conv(d.convention));
  }
  return { input: { values: tb.values, probs: tb.probs, digits: dg, convention: conv(d.convention), rns } };
}

export function inventoryInputFromSpec(s: SimInventorySpec, generator: 'lcg' | 'mt', seed: number): { input: InventoryInput } | { error: string } {
  const digits = readInt('Digits per random number', s.digits, 1, 4);
  const demand = readTable('Demand table', s.demand);
  const S = readInt('Order-up-to level S', s.S, 0, 1e9), R = readInt('Review period R', s.R, 1, MAX_DAYS), init = readInt('Initial stock', s.initial, 0, 1e9);
  const oc = readNumber('Ordering cost', s.orderCost), hc = readNumber('Holding cost', s.holdCost), sc = readNumber('Shortage cost', s.shortCost);
  const bad = firstError(digits, demand, S, R, init, oc, hc, sc);
  if (bad) return { error: bad };
  let leadValues: number[] = [], leadProbs: number[] = [], leadFixed = 0;
  if (s.leadMode === 'table') {
    const lt = readTable('Lead-time table', s.lead);
    if ('error' in lt) return lt;
    leadValues = lt.values; leadProbs = lt.probs;
  } else {
    const lf = readInt('Lead time', s.leadFixed, 0, 365);
    if ('error' in lf) return lf;
    leadFixed = lf.v;
  }
  const dg = (digits as { v: number }).v, c = conv(s.convention), r = (R as { v: number }).v;
  let demandRns: number[], leadRns: number[] = [], days: number;
  if (s.source === 'given') {
    const p = parseRandomNumbers(s.rns, dg, c);
    if ('error' in p) return { error: `Demand random numbers: ${p.error}` };
    demandRns = p.rns; days = demandRns.length;
    if (leadProbs.length) {
      const q = parseRandomNumbers(s.leadRns, dg, c);
      if ('error' in q) return { error: `Lead-time random numbers: ${q.error}` };
      leadRns = q.rns;
    }
  } else {
    const dd = readInt('Number of days', s.days, 1, MAX_DAYS);
    if ('error' in dd) return dd;
    days = dd.v;
    const g = generateInventoryRns(days, r, dg, generator, seed, c);
    demandRns = g.demandRns; leadRns = leadProbs.length ? g.leadRns : [];
  }
  const dm = demand as { values: number[]; probs: number[] };
  return { input: { demandValues: dm.values, demandProbs: dm.probs, leadValues, leadProbs, leadFixed, digits: dg, convention: c, demandRns, leadRns, days, S: (S as { v: number }).v, R: r, initial: (init as { v: number }).v, orderCost: (oc as { v: number }).v, holdCost: (hc as { v: number }).v, shortCost: (sc as { v: number }).v, backorders: s.backorders === true } };
}

/** run the generator selected in the RNG lab (mid-square or LCG) */
export function rngRunFromSpec(r: SimRngSpec, which: 'midsquare' | 'lcg'): GenRun {
  const sample = readInt('Sample size', r.sample, 10, 100000);
  if ('error' in sample) return { error: sample.error, warnings: [], kind: which, modulus: 0, rows: [], states: [], uniform: [], cycle: { found: false, tail: 0, length: 0, scanned: 0, start: 0 } };
  const fail = (error: string): GenRun => ({ error, warnings: [], kind: which, modulus: 0, rows: [], states: [], uniform: [], cycle: { found: false, tail: 0, length: 0, scanned: 0, start: 0 } });
  if (which === 'midsquare') {
    const seed = readInt('Seed', r.msSeed, 0, 99999999), dg = readInt('Digits', r.msDigits, 2, 8);
    const bad = firstError(seed, dg);
    return bad ? fail(bad) : midSquareRun((seed as { v: number }).v, (dg as { v: number }).v, sample.v);
  }
  const lim = Number.MAX_SAFE_INTEGER;
  const a = readInt('a', r.lcgA, 0, lim), c = readInt('c', r.lcgC, 0, lim), m = readInt('m', r.lcgM, 2, lim), x0 = readInt('Seed X0', r.lcgSeed, 0, lim);
  const bad = firstError(a, c, m, x0);
  return bad ? fail(bad) : lcgRun((a as { v: number }).v, (c as { v: number }).v, (m as { v: number }).v, (x0 as { v: number }).v, sample.v);
}
