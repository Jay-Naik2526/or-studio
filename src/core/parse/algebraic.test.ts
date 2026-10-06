import { describe, it, expect } from 'vitest';
import { AlgebraicParser, formatLP } from './algebraic';

const ok = (t: string) => {
  const r = AlgebraicParser.parse(t);
  if (!r.success) throw new Error(`${r.error!.line}:${r.error!.col} ${r.error!.message}`);
  return r.model!;
};

describe('AlgebraicParser', () => {
  it('parses the spec example', () => {
    const m = ok(`max 3x1 + 5x2
st
  x1 <= 4
  2x2 <= 12
  3x1 + 2x2 <= 18
  x1, x2 >= 0`);
    expect(m.sense).toBe('max');
    expect(m.varNames).toEqual(['x₁', 'x₂']);
    expect(m.objective.map(String)).toEqual(['3', '5']);
    expect(m.constraints).toHaveLength(3);
    expect(m.constraints[2]!.coeffs.map(String)).toEqual(['3', '2']);
  });

  it('accepts keyword, relation and unicode variants', () => {
    const m = ok(`Minimize z = 2x₁ − x2
s.t.
  x₁ + x2 ≥ 3
  x1 =< 10
  x2 => 1
  x1 = 4`);
    expect(m.sense).toBe('min');
    expect(m.objective.map(String)).toEqual(['2', '-1']);
    expect(m.constraints.map(c => c.relation)).toEqual(['>=', '<=', '>=', '=']);
  });

  it('handles variables on both sides, constants on the left, fractions, decimals and *', () => {
    const m = ok(`max 1/2 x + 0.25*y
subject to
  3 + x <= 5 - y
  (1/3)x + y >= 1/2`);
    expect(m.objective.map(String)).toEqual(['1/2', '1/4']);
    expect(m.constraints[0]!.coeffs.map(String)).toEqual(['1', '1']);
    expect(m.constraints[0]!.rhs.toString()).toBe('2');
    expect(m.constraints[1]!.coeffs.map(String)).toEqual(['1/3', '1']);
  });

  it('supports chained inequalities, labels, free/int/bin declarations and objective constants', () => {
    const m = ok(`max 2x + y + 7
st
  cap: 2 <= x + y <= 8
  free y
  int x`);
    expect(m.objectiveConstant!.toString()).toBe('7');
    expect(m.constraints).toHaveLength(2);
    expect(m.constraints[0]!.name).toBe('cap');
    expect(m.varBounds![1]!.lower).toBeNull();
    expect(m.integrality).toEqual(['integer', 'continuous']);
  });

  it('does not turn x >= 0 into a constraint row', () => {
    const m = ok('max x + y\nst\n x + y <= 4\n x >= 0\n y >= 0');
    expect(m.constraints).toHaveLength(1);
  });

  it('reports line and column for errors', () => {
    const r = AlgebraicParser.parse('max 3x1 + 5x2\nst\n  x1 <= 4\n  2x2 + * 3 <= 12');
    expect(r.success).toBe(false);
    expect(r.error!.line).toBe(4);
    expect(r.error!.col).toBeGreaterThan(1);
    expect(AlgebraicParser.parse('hello').error!.message).toMatch(/max/);
    expect(AlgebraicParser.parse('max x\nst\n x + 2').error!.message).toMatch(/relation/i);
    expect(AlgebraicParser.parse('max x\nst\n x <=').error!.message).toMatch(/right-hand side/);
  });

  it('round-trips through formatLP', () => {
    const m = ok('max 3x1 + 5x2\nst\n x1 <= 4\n 3x1 + 2x2 >= 18\n free x2');
    const again = ok(formatLP(m));
    expect(again.objective.map(String)).toEqual(m.objective.map(String));
    expect(again.constraints.map(c => c.relation)).toEqual(m.constraints.map(c => c.relation));
    expect(again.varBounds![1]!.lower).toBeNull();
  });
});
