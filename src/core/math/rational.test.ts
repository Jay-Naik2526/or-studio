import { describe, it, expect } from 'vitest';
import { Rational } from './rational';

describe('Rational Class - Exact Arithmetic', () => {
  it('constructs and reduces fractions to lowest terms', () => {
    const r1 = Rational.of(4, 8);
    expect(r1.n).toBe(1n);
    expect(r1.d).toBe(2n);
    expect(r1.toString()).toBe('1/2');

    const r2 = Rational.of(-6, -9);
    expect(r2.toString()).toBe('2/3');

    const r3 = Rational.of(5, -10);
    expect(r3.toString()).toBe('-1/2');

    const rZero = Rational.of(0, 100);
    expect(rZero.eq(Rational.ZERO)).toBe(true);
    expect(rZero.toString()).toBe('0');
  });

  it('parses strings correctly (fractions, decimals, integers)', () => {
    expect(Rational.parse('3/4').toString()).toBe('3/4');
    expect(Rational.parse('-2').toString()).toBe('-2');
    expect(Rational.parse('0.25').toString()).toBe('1/4');
    expect(Rational.parse('-1.5').toString()).toBe('-3/2');
    expect(Rational.parse(' 5 / 10 ').toString()).toBe('1/2');
  });

  it('performs exact addition and subtraction', () => {
    const a = Rational.parse('1/3');
    const b = Rational.parse('1/6');
    expect(a.add(b).toString()).toBe('1/2');
    expect(a.sub(b).toString()).toBe('1/6');
    expect(b.sub(a).toString()).toBe('-1/6');
  });

  it('performs exact multiplication and division', () => {
    const a = Rational.parse('3/4');
    const b = Rational.parse('2/3');
    expect(a.mul(b).toString()).toBe('1/2');
    expect(a.div(b).toString()).toBe('9/8');
  });

  it('handles division by zero', () => {
    expect(() => Rational.parse('1/0')).toThrow();
    expect(() => Rational.ONE.div(Rational.ZERO)).toThrow();
  });

  it('performs comparisons accurately without floating point drift', () => {
    const a = Rational.parse('1/3');
    const b = Rational.parse('2/6');
    const c = Rational.parse('1/2');

    expect(a.eq(b)).toBe(true);
    expect(a.lt(c)).toBe(true);
    expect(c.gt(a)).toBe(true);
    expect(a.cmp(b)).toBe(0);
    expect(a.cmp(c)).toBe(-1);
    expect(c.cmp(a)).toBe(1);
  });

  it('formats to LaTeX correctly', () => {
    expect(Rational.parse('3/4').toLatex()).toBe('\\frac{3}{4}');
    expect(Rational.parse('-3/4').toLatex()).toBe('-\\frac{3}{4}');
    expect(Rational.parse('5').toLatex()).toBe('5');
  });

  it('computes magnitude for overflow monitoring', () => {
    const r = Rational.of(100n, 5n); // 20/1
    expect(r.magnitude()).toBe(20n);
  });
});
