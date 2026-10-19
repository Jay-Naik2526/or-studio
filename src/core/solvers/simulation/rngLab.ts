/**
 * Random-number generator lab: mid-square (von Neumann) and linear congruential generators with worked steps,
 * cycle detection, the Hull–Dobell full-period test, a chi-square uniformity test with the exact chi-square
 * distribution function, and consecutive-pair scatter data.
 */

export const MAX_SAMPLE = 100000;
const CYCLE_LIMIT = 200000;
const MAX_INT = Number.MAX_SAFE_INTEGER;

export interface GenRow { i: number; x: number; working: string; next: number }
export interface CycleInfo {
  /** true when a repeated state was found within the scan limit */
  found: boolean;
  /** number of steps before the cycle starts (0 = the seed itself lies on the cycle) */
  tail: number;
  /** period of the cycle; when not found, the number of states scanned */
  length: number;
  scanned: number;
  /** the first state that lies on the cycle */
  start: number;
}
export interface HullDobellItem { text: string; ok: boolean }
export interface HullDobell { checked: boolean; full: boolean; items: HullDobellItem[] }

export interface GenRun {
  error?: string;
  warnings: string[];
  kind: 'midsquare' | 'lcg';
  modulus: number;
  /** the first (up to 10) steps of working */
  rows: GenRow[];
  /** states X1 … Xn */
  states: number[];
  /** uniform numbers X_i / m in [0,1) */
  uniform: number[];
  cycle: CycleInfo;
  hullDobell?: HullDobell;
}

const failRun = (kind: 'midsquare' | 'lcg', error: string): GenRun => ({ error, warnings: [], kind, modulus: 0, rows: [], states: [], uniform: [], cycle: { found: false, tail: 0, length: 0, scanned: 0, start: 0 } });

/** Floyd-free cycle detection with a visited map, scanning at most CYCLE_LIMIT states. */
function findCycle(x0: number, next: (x: number) => number): CycleInfo {
  const seen = new Map<number, number>();
  let x = x0;
  for (let i = 0; i < CYCLE_LIMIT; i++) {
    const at = seen.get(x);
    if (at !== undefined) return { found: true, tail: at, length: i - at, scanned: i, start: x };
    seen.set(x, i);
    x = next(x);
  }
  return { found: false, tail: 0, length: CYCLE_LIMIT, scanned: CYCLE_LIMIT, start: x0 };
}

/* ------------------------------ mid-square ------------------------------ */

export function midSquareStep(x: number, digits: number): { square: string; middle: string; next: number } {
  const sq = (BigInt(x) * BigInt(x)).toString().padStart(2 * digits, '0');
  const start = digits / 2;
  const middle = sq.slice(start, start + digits);
  return { square: sq, middle, next: Number(middle) };
}

export function midSquareRun(seed: number, digits: number, count: number): GenRun {
  if (!Number.isInteger(digits) || digits < 2 || digits > 8 || digits % 2) return failRun('midsquare', 'Mid-square needs an even number of digits: 2, 4, 6 or 8.');
  const M = 10 ** digits;
  if (!Number.isInteger(seed) || seed < 0 || seed >= M) return failRun('midsquare', `The seed must be a whole number from 0 to ${M - 1} (${digits} digits).`);
  if (!Number.isInteger(count) || count < 1 || count > MAX_SAMPLE) return failRun('midsquare', `The sample size must be a whole number from 1 to ${MAX_SAMPLE.toLocaleString()}.`);
  const rows: GenRow[] = [], states: number[] = [];
  let x = seed;
  for (let i = 1; i <= count; i++) {
    const s = midSquareStep(x, digits);
    if (i <= 10) rows.push({ i, x, working: `${String(x).padStart(digits, '0')}² = ${s.square} → middle ${digits} digits = ${s.middle}`, next: s.next });
    x = s.next; states.push(x);
  }
  const cycle = findCycle(seed, v => midSquareStep(v, digits).next);
  const warnings: string[] = [];
  if (cycle.found && cycle.length === 1) warnings.push(`The sequence gets stuck on ${String(cycle.start).padStart(digits, '0')} forever (a cycle of length 1) - the classic failure of the mid-square method.`);
  else if (cycle.found && cycle.length < 100) warnings.push(`The sequence repeats after only ${cycle.length} numbers, far fewer than the ${M} possible states.`);
  return { warnings, kind: 'midsquare', modulus: M, rows, states, uniform: states.map(v => v / M), cycle };
}

/* ------------------------------ linear congruential ------------------------------ */

function gcd(a: number, b: number): number { while (b) [a, b] = [b, a % b]; return a; }

/** distinct prime factors by trial division (bounded work); returns null when the cofactor could not be resolved */
function primeFactors(n: number): number[] | null {
  const out: number[] = [];
  let m = n;
  for (let p = 2, steps = 0; p * p <= m; p += p === 2 ? 1 : 2, steps++) {
    if (steps > 12_000_000) return null;
    if (m % p === 0) { out.push(p); while (m % p === 0) m /= p; }
  }
  if (m > 1) out.push(m);
  return out;
}

export function hullDobell(a: number, c: number, m: number): HullDobell {
  const items: HullDobellItem[] = [];
  const pf = primeFactors(m);
  const g = gcd(c, m);
  items.push({ text: `c and m are coprime: gcd(${c}, ${m}) = ${g}`, ok: g === 1 });
  if (!pf) return { checked: false, full: false, items: [...items, { text: 'm is too large to factor here; the remaining conditions were not checked.', ok: false }] };
  const bad = pf.filter(p => (a - 1) % p !== 0);
  items.push({ text: `a − 1 = ${a - 1} is divisible by every prime factor of m (${pf.join(', ') || 'none'})${bad.length ? `; not by ${bad.join(', ')}` : ''}`, ok: bad.length === 0 });
  if (m % 4 === 0) items.push({ text: `4 divides m, so 4 must divide a − 1 = ${a - 1}`, ok: (a - 1) % 4 === 0 });
  return { checked: true, full: items.every(x => x.ok), items };
}

export function lcgRun(a: number, c: number, m: number, seed: number, count: number): GenRun {
  const isInt = (x: number) => Number.isInteger(x) && x >= 0 && x <= MAX_INT;
  if (!isInt(a) || !isInt(c) || !isInt(m) || !isInt(seed)) return failRun('lcg', `a, c, m and the seed must be whole numbers from 0 to ${MAX_INT.toLocaleString()}.`);
  if (m < 2) return failRun('lcg', 'The modulus m must be at least 2.');
  if (seed >= m) return failRun('lcg', `The seed must be smaller than the modulus (0 ≤ X0 < ${m}).`);
  if (!Number.isInteger(count) || count < 1 || count > MAX_SAMPLE) return failRun('lcg', `The sample size must be a whole number from 1 to ${MAX_SAMPLE.toLocaleString()}.`);
  const A = BigInt(a), C = BigInt(c), Mm = BigInt(m);
  const step = (x: number) => Number((A * BigInt(x) + C) % Mm);
  const rows: GenRow[] = [], states: number[] = [];
  let x = seed;
  for (let i = 1; i <= count; i++) {
    const prod = A * BigInt(x) + C;
    const nx = Number(prod % Mm);
    if (i <= 10) rows.push({ i, x, working: `(${a}·${x} + ${c}) mod ${m} = ${prod} mod ${m} = ${nx}`, next: nx });
    x = nx; states.push(x);
  }
  const cycle = findCycle(seed, step);
  const hd = hullDobell(a, c, m);
  const warnings: string[] = [];
  if (cycle.found && cycle.length < m) warnings.push(`The period is ${cycle.length}, shorter than the modulus ${m}${hd.checked && !hd.full ? ' - consistent with the failed Hull–Dobell condition below' : ''}.`);
  if (!cycle.found) warnings.push(`No repeat was found in the first ${CYCLE_LIMIT.toLocaleString()} states, so the period exceeds that.`);
  if (a === 0 || a === 1) warnings.push(a === 0 ? 'With a = 0 every number after the first equals c.' : 'With a = 1 the generator only counts up by c, which is not random.');
  return { warnings, kind: 'lcg', modulus: m, rows, states, uniform: states.map(v => v / m), cycle, hullDobell: hd };
}

/* ------------------------------ chi-square uniformity ------------------------------ */

function lnGamma(x: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let s = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) s += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}

/** regularised lower incomplete gamma P(a, x) */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 1000; n++) { term *= x / (a + n); sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-16) break; }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - lnGamma(a)));
  }
  // continued fraction for Q (modified Lentz)
  const tiny = 1e-300;
  let b = x + 1 - a, cc = 1 / tiny, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < tiny) d = tiny;
    cc = b + an / cc; if (Math.abs(cc) < tiny) cc = tiny;
    d = 1 / d;
    const del = d * cc;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.max(0, 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h);
}

/** chi-square cumulative distribution function with k degrees of freedom */
export function chiSquareCdf(x: number, k: number): number { return x <= 0 ? 0 : gammaP(k / 2, x / 2); }
/** upper-tail probability (the p-value of an observed statistic x) */
export function chiSquareSf(x: number, k: number): number { return 1 - chiSquareCdf(x, k); }

/** p-value as text; exact zero (underflow) is shown as an inequality */
export const formatP = (p: number): string => (!Number.isFinite(p) ? '–' : p === 0 || p < 1e-15 ? '< 1e-15' : p < 1e-4 ? p.toExponential(2) : String(Number(p.toFixed(4))));

export interface ChiSquare {
  error?: string;
  n: number; bins: number; counts: number[]; expected: number; chi2: number; df: number; p: number;
  /** p ≥ 0.05: uniformity is not rejected at the 5 % level */
  pass: boolean; lowExpected: boolean;
}

export function chiSquareUniform(u: number[], bins = 10): ChiSquare {
  const base: ChiSquare = { n: u.length, bins, counts: new Array<number>(bins).fill(0), expected: u.length / bins, chi2: NaN, df: bins - 1, p: NaN, pass: false, lowExpected: false };
  if (u.length < bins) return { ...base, error: `The test needs at least ${bins} numbers (one per bin on average).` };
  for (const v of u) { if (!(v >= 0 && v <= 1)) return { ...base, error: 'Every number must lie in [0, 1].' }; base.counts[Math.min(bins - 1, Math.floor(v * bins))]!++; }
  const E = u.length / bins;
  const chi2 = base.counts.reduce((a, o) => a + (o - E) ** 2 / E, 0);
  const p = chiSquareSf(chi2, bins - 1);
  return { ...base, chi2, p, pass: p >= 0.05, lowExpected: E < 5 };
}

/** consecutive pairs (u_i, u_{i+1}), thinned to at most `max` points */
export function consecutivePairs(u: number[], max = 1000): { x: number; y: number }[] {
  const n = Math.max(0, u.length - 1);
  const stride = Math.max(1, Math.ceil(n / max));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i += stride) out.push({ x: u[i]!, y: u[i + 1]! });
  return out;
}
