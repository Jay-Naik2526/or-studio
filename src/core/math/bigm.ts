/**
 * Symbolic Big-M numbers: a + b·M where M is an unspecified, arbitrarily large positive constant.
 * Spec §7 / §9.2 / §10.2 — M is NEVER substituted by a numeric value.
 *
 * Ordering is lexicographic on (b, a): any positive multiple of M dominates every constant.
 */

import { Rational } from './rational';

export class MNum {
  static readonly ZERO = new MNum(Rational.ZERO, Rational.ZERO);
  static readonly M = new MNum(Rational.ZERO, Rational.ONE);

  readonly a: Rational; // constant part
  readonly b: Rational; // coefficient of M

  constructor(a: Rational, b: Rational = Rational.ZERO) {
    this.a = a;
    this.b = b;
  }

  static of(a: Rational | number | bigint, b: Rational | number | bigint = 0): MNum {
    return new MNum(
      a instanceof Rational ? a : Rational.of(a),
      b instanceof Rational ? b : Rational.of(b)
    );
  }

  add(o: MNum): MNum {
    return new MNum(this.a.add(o.a), this.b.add(o.b));
  }

  sub(o: MNum): MNum {
    return new MNum(this.a.sub(o.a), this.b.sub(o.b));
  }

  neg(): MNum {
    return new MNum(this.a.neg(), this.b.neg());
  }

  /** Scale by an ordinary rational. */
  scale(k: Rational): MNum {
    if (k.isZero()) return MNum.ZERO;
    return new MNum(this.a.mul(k), this.b.mul(k));
  }

  cmp(o: MNum): -1 | 0 | 1 {
    const cb = this.b.cmp(o.b);
    if (cb !== 0) return cb;
    return this.a.cmp(o.a);
  }

  lt(o: MNum): boolean { return this.cmp(o) < 0; }
  gt(o: MNum): boolean { return this.cmp(o) > 0; }
  lte(o: MNum): boolean { return this.cmp(o) <= 0; }
  gte(o: MNum): boolean { return this.cmp(o) >= 0; }
  eq(o: MNum): boolean { return this.a.eq(o.a) && this.b.eq(o.b); }

  isZero(): boolean { return this.a.isZero() && this.b.isZero(); }
  isNegative(): boolean { return this.b.isNegative() || (this.b.isZero() && this.a.isNegative()); }
  isPositive(): boolean { return this.b.isPositive() || (this.b.isZero() && this.a.isPositive()); }
  hasM(): boolean { return !this.b.isZero(); }

  toString(): string {
    if (this.b.isZero()) return this.a.toString();
    const mPart = this.b.eq(Rational.ONE) ? 'M'
      : this.b.eq(Rational.MINUS_ONE) ? '-M'
      : this.b.isInteger() ? `${this.b.toString()}M`
      : `(${this.b.toString()})M`;
    if (this.a.isZero()) return mPart;
    const sign = this.a.isNegative() ? ' - ' : ' + ';
    return `${mPart}${sign}${this.a.abs().toString()}`;
  }

  toLatex(): string {
    if (this.b.isZero()) return this.a.toLatex();
    const mPart = this.b.eq(Rational.ONE) ? 'M'
      : this.b.eq(Rational.MINUS_ONE) ? '-M'
      : `${this.b.toLatex()}M`;
    if (this.a.isZero()) return mPart;
    const sign = this.a.isNegative() ? ' - ' : ' + ';
    return `${mPart}${sign}${this.a.abs().toLatex()}`;
  }
}
