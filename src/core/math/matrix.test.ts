import { describe, it, expect } from 'vitest';
import { RationalMatrix } from './matrix';
import { Rational } from './rational';

describe('RationalMatrix Class', () => {
  it('initializes and reads matrix elements', () => {
    const mat = RationalMatrix.fromArray([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(mat.rows).toBe(2);
    expect(mat.cols).toBe(3);
    expect(mat.get(0, 1).toString()).toBe('2');
    expect(mat.get(1, 2).toString()).toBe('6');
  });

  it('performs row scaling and row addition correctly', () => {
    const mat = RationalMatrix.fromArray([
      [2, 4],
      [1, 3],
    ]);
    mat.scaleRow(0, Rational.parse('1/2'));
    expect(mat.get(0, 0).toString()).toBe('1');
    expect(mat.get(0, 1).toString()).toBe('2');

    mat.addScaledRow(1, 0, Rational.parse('-1'));
    expect(mat.get(1, 0).toString()).toBe('0');
    expect(mat.get(1, 1).toString()).toBe('1');
  });

  it('performs exact simplex pivoting', () => {
    // 2x3 tableau
    const mat = RationalMatrix.fromArray([
      [2, 1, 4],
      [1, 2, 5],
    ]);
    // Pivot on (0, 0), pivot element = 2
    mat.pivot(0, 0);

    // Row 0 should be [1, 1/2, 2]
    expect(mat.get(0, 0).toString()).toBe('1');
    expect(mat.get(0, 1).toString()).toBe('1/2');
    expect(mat.get(0, 2).toString()).toBe('2');

    // Row 1 should be [0, 3/2, 3]
    expect(mat.get(1, 0).toString()).toBe('0');
    expect(mat.get(1, 1).toString()).toBe('3/2');
    expect(mat.get(1, 2).toString()).toBe('3');
  });
});
