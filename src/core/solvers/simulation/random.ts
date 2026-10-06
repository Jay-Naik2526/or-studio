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
    this.s = Math.abs(Math.floor(seed)) % 2147483647;
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
    this.mt[0] = seed >>> 0;
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
  switch (d.type) {
    case 'uniform': return d.b > d.a ? null : 'Uniform: b must exceed a.';
    case 'exponential': return d.rate > 0 ? null : 'Exponential: the rate must be positive.';
    case 'normal': return d.sd >= 0 ? null : 'Normal: σ cannot be negative.';
    case 'triangular': return d.a <= d.m && d.m <= d.b && d.b > d.a ? null : 'Triangular: need a ≤ m ≤ b and a < b.';
    case 'poisson': return d.mean > 0 ? null : 'Poisson: the mean must be positive.';
    case 'discrete': {
      if (!d.values.length || d.values.length !== d.probs.length) return 'Discrete: values and probabilities must have the same length.';
      if (d.probs.some(p => p < 0)) return 'Discrete: probabilities cannot be negative.';
      const s = d.probs.reduce((a, b) => a + b, 0);
      return Math.abs(s - 1) < 1e-9 ? null : `Discrete: probabilities sum to ${s}, not 1.`;
    }
    case 'constant': return null;
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
    case 'poisson': {
      const L = Math.exp(-d.mean);
      let k = 0, p = 1;
      do { k++; p *= rng.next(); } while (p > L);
      return k - 1;
    }
    case 'discrete': {
      const u = rng.next();
      let c = 0;
      for (let i = 0; i < d.values.length; i++) { c += d.probs[i]!; if (u <= c) return d.values[i]!; }
      return d.values[d.values.length - 1]!;
    }
    case 'constant': return d.value;
  }
}

/* ---------------- safe expression evaluator ---------------- */

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) { let j = i; while (j < src.length && /[0-9.eE]/.test(src[j]!)) j++; const v = Number(src.slice(i, j)); if (Number.isNaN(v)) throw new Error(`Bad number "${src.slice(i, j)}"`); out.push({ t: 'num', v }); i = j; continue; }
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

/** Compile an arithmetic expression over named variables. Supports + − * / ^, parentheses, functions, comparisons (as 0/1). */
export function compileExpression(src: string, vars: string[]): (env: Record<string, number>) => number {
  const toks = tokenize(src);
  let p = 0;
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
  const unary = (): Node => { if (peek() && (peek() as any).t === 'op' && (peek() as any).v === '-') { eat(); const u = unary(); return e => -u(e); } if (peek() && (peek() as any).v === '+') { eat(); return unary(); } return pow(); };
  const pow = (): Node => { const b = atom(); if (peek() && (peek() as any).t === 'op' && (peek() as any).v === '^') { eat(); const x = unary(); return e => Math.pow(b(e), x(e)); } return b; };
  const atom = (): Node => {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === 'num') { p++; const v = t.v; return () => v; }
    if (t.t === 'id') {
      p++;
      if (peek() && (peek() as any).v === '(') {
        const f = FUNCS[t.v];
        if (!f) throw new Error(`Unknown function "${t.v}"`);
        eat('(');
        const args: Node[] = [];
        if (!(peek() && (peek() as any).v === ')')) { args.push(cmp()); while (peek() && (peek() as any).v === ',') { eat(','); args.push(cmp()); } }
        eat(')');
        return e => f(...args.map(a => a(e)));
      }
      if (t.v === 'pi') return () => Math.PI;
      if (!vars.includes(t.v)) throw new Error(`Unknown variable "${t.v}" (defined: ${vars.join(', ') || 'none'})`);
      const name = t.v;
      return e => e[name]!;
    }
    if (t.v === '(') { eat('('); const n = cmp(); eat(')'); return n; }
    throw new Error(`Unexpected "${t.v}"`);
  };
  const root = cmp();
  if (p < toks.length) throw new Error(`Unexpected "${(toks[p] as any).v}"`);
  return root;
}
