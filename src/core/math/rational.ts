/**
 * Exact Rational Arithmetic Engine backed by bigint.
 * Section 7.4 of Master Spec.
 *
 * Invariants:
 * 1. Always reduced to lowest terms (GCD applied).
 * 2. Denominator is strictly positive (d > 0n).
 * 3. Zero is canonically 0/1 (0n / 1n).
 * 4. Immutable.
 */

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

export class Rational {
  readonly n: bigint;
  readonly d: bigint;

  private constructor(n: bigint, d: bigint) {
    if (d === 0n) {
      throw new Error('Division by zero in Rational constructor');
    }

    if (n === 0n) {
      this.n = 0n;
      this.d = 1n;
      return;
    }

    // Ensure sign is on numerator
    if (d < 0n) {
      n = -n;
      d = -d;
    }

    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }

  static readonly ZERO = new Rational(0n, 1n);
  static readonly ONE = new Rational(1n, 1n);
  static readonly MINUS_ONE = new Rational(-1n, 1n);

  static fromInt(n: number | bigint): Rational {
    return Rational.of(n);
  }

  static fromFraction(n: number | bigint, d: number | bigint): Rational {
    return Rational.of(n, d);
  }

  static of(n: bigint | number, d: bigint | number = 1): Rational {
    if (typeof n === 'number') {
      if (!Number.isInteger(n)) {
        return Rational.fromDecimalString(n.toString());
      }
      n = BigInt(n);
    }
    if (typeof d === 'number') {
      if (!Number.isInteger(d)) {
        throw new Error('Denominator must be an integer');
      }
      d = BigInt(d);
    }
    if (n === 0n) return Rational.ZERO;
    if (n === 1n && d === 1n) return Rational.ONE;
    return new Rational(n, d);
  }

  /**
   * Parse a decimal string like "0.25", "-1.5", "12" into a Rational.
   */
  static fromDecimalString(s: string): Rational {
    s = s.trim();
    if (s === '') return Rational.ZERO;

    const isNeg = s.startsWith('-');
    if (isNeg || s.startsWith('+')) {
      s = s.substring(1);
    }

    const dotIdx = s.indexOf('.');
    if (dotIdx === -1) {
      const n = BigInt(s);
      return new Rational(isNeg ? -n : n, 1n);
    }

    const intPart = s.substring(0, dotIdx);
    const fracPart = s.substring(dotIdx + 1);

    const scale = BigInt(10 ** fracPart.length);
    const n = BigInt(intPart + fracPart);

    return new Rational(isNeg ? -n : n, scale);
  }

  /**
   * Parse "3/4", "-2", "1.5", "0", "+5/6", etc.
   */
  static parse(s: string): Rational {
    s = s.trim();
    if (s === '') return Rational.ZERO;

    const slashIdx = s.indexOf('/');
    if (slashIdx !== -1) {
      const numStr = s.substring(0, slashIdx).trim();
      const denStr = s.substring(slashIdx + 1).trim();
      const num = Rational.parse(numStr);
      const den = Rational.parse(denStr);
      return num.div(den);
    }

    if (s.includes('.')) {
      return Rational.fromDecimalString(s);
    }

    return Rational.of(BigInt(s));
  }

  // Arithmetic Operations
  add(o: Rational): Rational {
    if (this.n === 0n) return o;
    if (o.n === 0n) return this;
    const num = this.n * o.d + o.n * this.d;
    const den = this.d * o.d;
    return new Rational(num, den);
  }

  sub(o: Rational): Rational {
    return this.add(o.neg());
  }

  mul(o: Rational): Rational {
    if (this.n === 0n || o.n === 0n) return Rational.ZERO;
    return new Rational(this.n * o.n, this.d * o.d);
  }

  div(o: Rational): Rational {
    if (o.n === 0n) {
      throw new Error('Division by zero in Rational.div');
    }
    return new Rational(this.n * o.d, this.d * o.n);
  }

  neg(): Rational {
    if (this.n === 0n) return Rational.ZERO;
    return new Rational(-this.n, this.d);
  }

  negate(): Rational {
    return this.neg();
  }

  abs(): Rational {
    if (this.n >= 0n) return this;
    return new Rational(-this.n, this.d);
  }

  inv(): Rational {
    if (this.n === 0n) {
      throw new Error('Division by zero in Rational.inv');
    }
    return new Rational(this.d, this.n);
  }

  // Comparison operations (Exact, no epsilon)
  cmp(o: Rational): -1 | 0 | 1 {
    const diff = this.n * o.d - o.n * this.d;
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  }

  eq(o: Rational): boolean {
    return this.n === o.n && this.d === o.d;
  }

  equals(o: Rational): boolean {
    return this.eq(o);
  }

  lt(o: Rational): boolean {
    return this.cmp(o) < 0;
  }

  lte(o: Rational): boolean {
    return this.cmp(o) <= 0;
  }

  gt(o: Rational): boolean {
    return this.cmp(o) > 0;
  }

  gte(o: Rational): boolean {
    return this.cmp(o) >= 0;
  }

  isZero(): boolean {
    return this.n === 0n;
  }

  isPositive(): boolean {
    return this.n > 0n;
  }

  isNegative(): boolean {
    return this.n < 0n;
  }

  isInteger(): boolean {
    return this.d === 1n;
  }

  // Formatting & Output
  toString(): string {
    if (this.d === 1n) {
      return this.n.toString();
    }
    return `${this.n}/${this.d}`;
  }

  toLatex(): string {
    if (this.d === 1n) {
      return this.n.toString();
    }
    if (this.n < 0n) {
      return `-\\frac{${(-this.n).toString()}}{${this.d.toString()}}`;
    }
    return `\\frac{${this.n.toString()}}{${this.d.toString()}}`;
  }

  toDecimal(places = 4): string {
    if (this.d === 1n) return this.n.toString();
    const sign = this.n < 0n ? '-' : '';
    const absN = this.n < 0n ? -this.n : this.n;

    const intPart = absN / this.d;
    let rem = absN % this.d;

    if (rem === 0n) return sign + intPart.toString();

    let fracStr = '';
    for (let i = 0; i < places; i++) {
      rem *= 10n;
      fracStr += (rem / this.d).toString();
      rem %= this.d;
      if (rem === 0n) break;
    }

    return `${sign}${intPart}.${fracStr}`;
  }

  toNumber(): number {
    return Number(this.n) / Number(this.d);
  }

  magnitude(): bigint {
    const absN = this.n < 0n ? -this.n : this.n;
    return absN > this.d ? absN : this.d;
  }
}
