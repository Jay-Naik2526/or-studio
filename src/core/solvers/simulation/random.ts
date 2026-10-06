/**
 * Seedable random number generators (LCG, Mersenne Twister MT19937), inverse-transform variate generation
 * and a tiny safe expression evaluator for Monte-Carlo experiments (spec §9.4: the seed MUST be user-settable).
 */

export interface Rng { next(): number; readonly name: string }

/** Park–Miller / "minimal standard" LCG: x ← 16807·x mod (2³¹−1). */
export class LcgRng implements Rng {
  readonly name = 'LCG (16807, 2³¹−1)';
  private s: number;
  constructor(seed: number) {
    // a non-finite seed would otherwise turn every draw into NaN
    this.s = Number.isFinite(seed) ? Math.abs(Math.floor(seed)) % 2147483647 : 1;
    if (this.s === 0) this.s = 1;
  }
  next(): number {
    this.s = (this.s * 16807) % 2147483647;
    return this.s / 2147483647;
  }
}

/** MT19937 (32-bit). */
export class MersenneTwister implements Rng {
  readonly name = 'Mersenne Twister MT19937';
  private mt = new Uint32Array(624);
  private idx = 624;
  constructor(seed: number) {
    this.mt[0] = (Number.isFinite(seed) ? Math.floor(seed) : 0) >>> 0;
    for (let i = 1; i < 624; i++) {
      const prev = this.mt[i - 1]! ^ (this.mt[i - 1]! >>> 30);
      this.mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
  }
  private twist() {
    for (let i = 0; i < 624; i++) {
      const y = (this.mt[i]! & 0x80000000) | (this.mt[(i + 1) % 624]! & 0x7fffffff);
      let v = this.mt[(i + 397) % 624]! ^ (y >>> 1);
      if (y & 1) v ^= 0x9908b0df;
      this.mt[i] = v >>> 0;
    }
    this.idx = 0;
  }
  nextUint32(): number {
    if (this.idx >= 624) this.twist();
    let y = this.mt[this.idx++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  next(): number {
    // (0,1): never exactly 0 or 1
    return (this.nextUint32() + 0.5) / 4294967296;
  }
}

export function makeRng(kind: 'lcg' | 'mt', seed: number): Rng {
  return kind === 'lcg' ? new LcgRng(seed) : new MersenneTwister(seed);
}

export type Distribution =
  | { type: 'uniform'; a: number; b: number }
  | { type: 'exponential'; rate: number }
  | { type: 'normal'; mean: number; sd: number }
  | { type: 'triangular'; a: number; m: number; b: number }
  | { type: 'poisson'; mean: number }
  | { type: 'discrete'; values: number[]; probs: number[] }
  | { type: 'constant'; value: number };

export function describeDistribution(d: Distribution): string {
  switch (d.type) {
    case 'uniform': return `Uniform(${d.a}, ${d.b})`;
    case 'exponential': return `Exponential(rate ${d.rate})`;
    case 'normal': return `Normal(${d.mean}, σ=${d.sd})`;
    case 'triangular': return `Triangular(${d.a}, ${d.m}, ${d.b})`;
    case 'poisson': return `Poisson(${d.mean})`;
    case 'discrete': return `Discrete{${d.values.map((v, i) => `${v}:${d.probs[i]}`).join(', ')}}`;
    case 'constant': return `Constant(${d.value})`;
  }
}

export function validateDistribution(d: Distribution): string | null {
  const fin = (...xs: number[]) => xs.every(x => typeof x === 'number' && Number.isFinite(x));
  switch (d.type) {
    case 'uniform': return !fin(d.a, d.b) ? 'Uniform: a and b must be finite numbers.' : d.b > d.a ? null : 'Uniform: b must exceed a.';
    case 'exponential': return fin(d.rate) && d.rate > 0 ? null : 'Exponential: the rate must be a positive, finite number.';
    case 'normal': return !fin(d.mean) ? 'Normal: the mean must be a finite number.' : fin(d.sd) && d.sd >= 0 ? null : 'Normal: σ must be a finite number that is not negative.';
    case 'triangular': return !fin(d.a, d.m, d.b) ? 'Triangular: a, m and b must be finite numbers.' : d.a <= d.m && d.m <= d.b && d.b > d.a ? null : 'Triangular: need a ≤ m ≤ b and a < b.';
    case 'poisson': return fin(d.mean) && d.mean > 0 ? null : 'Poisson: the mean must be a positive, finite number.';
    case 'discrete': {
      if (!d.values.length || d.values.length !== d.probs.length) return 'Discrete: values and probabilities must have the same length.';
      if (!fin(...d.values)) return 'Discrete: every value must be a finite number.';
      if (d.probs.some(p => !Number.isFinite(p) || p < 0)) return 'Discrete: probabilities must be finite and not negative.';
      const s = d.probs.reduce((a, b) => a + b, 0);
      return Math.abs(s - 1) < 1e-9 ? null : `Discrete: probabilities sum to ${s}, not 1.`;
    }
    case 'constant': return fin(d.value) ? null : 'Constant: the value must be a finite number.';
  }
}

/** Inverse-transform sampling (Box–Muller for the normal, Knuth for Poisson). */
export function sample(d: Distribution, rng: Rng): number {
  switch (d.type) {
    case 'uniform': return d.a + (d.b - d.a) * rng.next();
    case 'exponential': return -Math.log(1 - rng.next()) / d.rate;
    case 'normal': {
      const u1 = rng.next(), u2 = rng.next();
      return d.mean + d.sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    case 'triangular': {
      const u = rng.next();
      const f = (d.m - d.a) / (d.b - d.a);
      return u < f ? d.a + Math.sqrt(u * (d.b - d.a) * (d.m - d.a)) : d.b - Math.sqrt((1 - u) * (d.b - d.a) * (d.b - d.m));
    }
    case 'poisson': return poisson(d.mean, rng);
    case 'discrete': {
      const u = rng.next();
      let c = 0;
      for (let i = 0; i < d.values.length; i++) { c += d.probs[i]!; if (u <= c) return d.values[i]!; }
      return d.values[d.values.length - 1]!;
    }
    case 'constant': return d.value;
  }
}

/** ln Γ(x) by the Stirling series (x ≥ 10) — enough accuracy for the rejection test below. */
function lgammaBig(x: number): number {
  const x2 = x * x;
  return (x - 0.5) * Math.log(x) - x + 0.5 * Math.log(2 * Math.PI) + 1 / (12 * x) - 1 / (360 * x * x2) + 1 / (1260 * x2 * x2 * x);
}
const LOG_FACT_SMALL: number[] = [0];
for (let i = 1; i < 10; i++) LOG_FACT_SMALL.push(LOG_FACT_SMALL[i - 1]! + Math.log(i));
const logFactorial = (k: number) => (k < 10 ? LOG_FACT_SMALL[k]! : lgammaBig(k + 1));

/** Poisson variate: Knuth's product method for small means, Hörmann's PTRS transformed rejection beyond that (exact for any mean). */
function poisson(mean: number, rng: Rng): number {
  if (mean < 30) {
    const L = Math.exp(-mean);
    let k = 0, p = 1;
    do { k++; p *= rng.next(); } while (p > L);
    return k - 1;
  }
  const slam = Math.sqrt(mean), loglam = Math.log(mean);
  const b = 0.931 + 2.53 * slam, a = -0.059 + 0.02483 * b;
  const invalpha = 1.1239 + 1.1328 / (b - 3.4), vr = 0.9277 - 3.6224 / (b - 2);
  for (;;) {
    const U = rng.next() - 0.5, V = rng.next();
    const us = 0.5 - Math.abs(U);
    const k = Math.floor(((2 * a) / us + b) * U + mean + 0.43);
    if (us >= 0.07 && V <= vr) return k;
    if (k < 0 || (us < 0.013 && V > us)) continue;
    if (Math.log(V) + Math.log(invalpha) - Math.log(a / (us * us) + b) <= -mean + k * loglam - logFactorial(k)) return k;
  }
}

/* ---------------- safe expression evaluator ---------------- */

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

const MAX_EXPR_CHARS = 2000;
const MAX_EXPR_DEPTH = 80;

function tokenize(src: string): Tok[] {
  if (src.length > MAX_EXPR_CHARS) throw new Error(`The expression is too long (limit ${MAX_EXPR_CHARS} characters).`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      // digits, optional fraction, optional exponent with a sign (1e-6, 2.5E+3)
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) { let j = i; while (j < src.length && /[0-9.]/.test(src[j]!)) j++; throw new Error(`Bad number "${src.slice(i, j)}"`); }
      const next = src[i + m[0].length];
      if (next !== undefined && /[0-9.]/.test(next)) { let j = i; while (j < src.length && /[0-9.]/.test(src[j]!)) j++; throw new Error(`Bad number "${src.slice(i, j)}"`); }
      out.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(ch)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++; out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue; }
    if ('+-*/^(),<>=?:'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    throw new Error(`Unexpected character "${ch}" at position ${i + 1}`);
  }
  return out;
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log, sin: Math.sin, cos: Math.cos,
  min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, pow: Math.pow,
  step: (x: number) => (x >= 0 ? 1 : 0),
};

const FUNC_ARITY: Record<string, number | 'many'> = { min: 'many', max: 'many', pow: 2 };

/** Compile an arithmetic expression over named variables. Supports + − * / ^, parentheses, functions, comparisons (as 0/1). */
export function compileExpression(src: string, vars: string[]): (env: Record<string, number>) => number {
  const toks = tokenize(src);
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => { const t = toks[p]; if (!t || (v !== undefined && !(t.t === 'op' && t.v === v))) throw new Error(v ? `Expected "${v}"` : 'Unexpected end of expression'); p++; return t; };
  type Node = (env: Record<string, number>) => number;
  const cmp = (): Node => {
    let l = add();
    while (peek() && peek()!.t === 'op' && ['<', '>'].includes((peek() as any).v)) {
      const op = (eat() as any).v as string; let eq = false;
      if (peek() && (peek() as any).v === '=') { eat(); eq = true; }
      const r = add(); const ll = l;
      l = op === '<' ? (e => (eq ? ll(e) <= r(e) : ll(e) < r(e)) ? 1 : 0) : (e => (eq ? ll(e) >= r(e) : ll(e) > r(e)) ? 1 : 0);
    }
    return l;
  };
  const add = (): Node => { let l = mul(); while (peek() && peek()!.t === 'op' && ['+', '-'].includes((peek() as any).v)) { const op = (eat() as any).v; const r = mul(); const ll = l; l = op === '+' ? e => ll(e) + r(e) : e => ll(e) - r(e); } return l; };
  const mul = (): Node => { let l = unary(); while (peek() && peek()!.t === 'op' && ['*', '/'].includes((peek() as any).v)) { const op = (eat() as any).v; const r = unary(); const ll = l; l = op === '*' ? e => ll(e) * r(e) : e => ll(e) / r(e); } return l; };
  const unary = (): Node => { if (++depth > MAX_EXPR_DEPTH) throw new Error('The expression is nested too deeply'); try { if (peek() && (peek() as any).t === 'op' && (peek() as any).v === '-') { eat(); const u = unary(); return e => -u(e); } if (peek() && (peek() as any).v === '+') { eat(); return unary(); } return pow(); } finally { depth--; } };
  const pow = (): Node => { const b = atom(); if (peek() && (peek() as any).t === 'op' && (peek() as any).v === '^') { eat(); const x = unary(); return e => Math.pow(b(e), x(e)); } return b; };
  const atom = (): Node => {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === 'num') { p++; const v = t.v; return () => v; }
    if (t.t === 'id') {
      p++;
      if (peek() && (peek() as any).v === '(') {
        const f = Object.hasOwn(FUNCS, t.v) ? FUNCS[t.v] : undefined;
        if (!f) throw new Error(`Unknown function "${t.v}"`);
        eat('(');
        const args: Node[] = [];
        if (!(peek() && (peek() as any).v === ')')) { args.push(cmp()); while (peek() && (peek() as any).v === ',') { eat(','); args.push(cmp()); } }
        eat(')');
        const want = FUNC_ARITY[t.v] ?? 1;
        if (want === 'many' ? args.length < 1 : args.length !== want) throw new Error(`"${t.v}" takes ${want === 'many' ? 'at least one argument' : `${want} argument${want === 1 ? '' : 's'}`}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} given`);
        return e => f(...args.map(a => a(e)));
      }
      if (t.v === 'pi' && !vars.includes('pi')) return () => Math.PI;
      if (!vars.includes(t.v)) throw new Error(`Unknown variable "${t.v}" (defined: ${vars.join(', ') || 'none'})`);
      const name = t.v;
      return e => e[name]!;
    }
    if (t.v === '(') { if (++depth > MAX_EXPR_DEPTH) throw new Error('The expression is nested too deeply'); eat('('); const n = cmp(); eat(')'); depth--; return n; }
    throw new Error(`Unexpected "${t.v}"`);
  };
  const root = cmp();
  if (p < toks.length) throw new Error(`Unexpected "${(toks[p] as any).v}"`);
  return root;
}
