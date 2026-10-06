/**
 * Exact Rational Matrix class.
 * Section 7.5 of Master Spec.
 */

import { Rational } from './rational';

export class RationalMatrix {
  readonly rows: number;
  readonly cols: number;
  private readonly data: Rational[][];

  constructor(rows: number, cols: number, initialValue: Rational = Rational.ZERO) {
    this.rows = rows;
    this.cols = cols;
    this.data = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => initialValue)
    );
  }

  static fromArray(arr: (Rational | number | string)[][]): RationalMatrix {
    const rows = arr.length;
    if (rows === 0) throw new Error('Cannot create matrix from empty array');
    const cols = arr[0]!.length;
    const mat = new RationalMatrix(rows, cols);

    for (let i = 0; i < rows; i++) {
      const row = arr[i]!;
      if (row.length !== cols) {
        throw new Error('Inconsistent row length in RationalMatrix.fromArray');
      }
      for (let j = 0; j < cols; j++) {
        const val = row[j]!;
        mat.set(
          i,
          j,
          val instanceof Rational
            ? val
            : typeof val === 'number'
            ? Rational.of(val)
            : Rational.parse(val)
        );
      }
    }
    return mat;
  }

  static identity(n: number): RationalMatrix {
    const mat = new RationalMatrix(n, n);
    for (let i = 0; i < n; i++) {
      mat.set(i, i, Rational.ONE);
    }
    return mat;
  }

  get(row: number, col: number): Rational {
    const r = this.data[row];
    if (!r) throw new Error(`Row index out of bounds: ${row}`);
    const v = r[col];
    if (!v) throw new Error(`Col index out of bounds: ${col}`);
    return v;
  }

  set(row: number, col: number, val: Rational): void {
    const r = this.data[row];
    if (!r) throw new Error(`Row index out of bounds: ${row}`);
    r[col] = val;
  }

  clone(): RationalMatrix {
    const copy = new RationalMatrix(this.rows, this.cols);
    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.cols; j++) {
        copy.set(i, j, this.get(i, j));
      }
    }
    return copy;
  }

  getRow(row: number): Rational[] {
    const r = this.data[row];
    if (!r) throw new Error(`Row index out of bounds: ${row}`);
    return [...r];
  }

  setRow(row: number, values: Rational[]): void {
    if (values.length !== this.cols) {
      throw new Error(`Row values length (${values.length}) does not match cols (${this.cols})`);
    }
    for (let j = 0; j < this.cols; j++) {
      this.set(row, j, values[j]!);
    }
  }

  getCol(col: number): Rational[] {
    const res: Rational[] = [];
    for (let i = 0; i < this.rows; i++) {
      res.push(this.get(i, col));
    }
    return res;
  }

  // Row operations
  swapRows(r1: number, r2: number): void {
    if (r1 === r2) return;
    const temp = this.data[r1]!;
    this.data[r1] = this.data[r2]!;
    this.data[r2] = temp;
  }

  scaleRow(row: number, factor: Rational): void {
    for (let j = 0; j < this.cols; j++) {
      this.set(row, j, this.get(row, j).mul(factor));
    }
  }

  addScaledRow(targetRow: number, sourceRow: number, factor: Rational): void {
    for (let j = 0; j < this.cols; j++) {
      const added = this.get(sourceRow, j).mul(factor);
      this.set(targetRow, j, this.get(targetRow, j).add(added));
    }
  }

  pivot(pivotRow: number, pivotCol: number): void {
    const pivotVal = this.get(pivotRow, pivotCol);
    if (pivotVal.isZero()) {
      throw new Error(`Cannot pivot on zero element at (${pivotRow}, ${pivotCol})`);
    }

    const invPivot = pivotVal.inv();
    this.scaleRow(pivotRow, invPivot);

    for (let i = 0; i < this.rows; i++) {
      if (i === pivotRow) continue;
      const factor = this.get(i, pivotCol).neg();
      if (!factor.isZero()) {
        this.addScaledRow(i, pivotRow, factor);
      }
    }
  }

  toArray(): Rational[][] {
    return this.data.map(row => [...row]);
  }

  toString(): string {
    return this.data
      .map(row => row.map(v => v.toString().padStart(6)).join(' '))
      .join('\n');
  }

  maxMagnitude(): bigint {
    let max = 0n;
    for (let i = 0; i < this.rows; i++) {
      for (let j = 0; j < this.cols; j++) {
        const mag = this.get(i, j).magnitude();
        if (mag > max) max = mag;
      }
    }
    return max;
  }
}

export const Matrix = {
  multiply(A: Rational[][], B: Rational[][]): Rational[][] {
    const rowsA = A.length;
    const colsA = A[0]!.length;
    const colsB = B[0]!.length;
    const C: Rational[][] = Array.from({ length: rowsA }, () => new Array(colsB).fill(Rational.ZERO));

    for (let i = 0; i < rowsA; i++) {
      for (let j = 0; j < colsB; j++) {
        let sum = Rational.ZERO;
        for (let k = 0; k < colsA; k++) {
          const aVal = A[i]![k]!;
          const bVal = B[k]?.[j] ?? Rational.ZERO;
          sum = sum.add(aVal.mul(bVal));
        }
        C[i]![j] = sum;
      }
    }
    return C;
  },

  inverse(A: Rational[][]): Rational[][] {
    const n = A.length;
    const aug = new RationalMatrix(n, 2 * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        aug.set(i, j, A[i]![j]!);
      }
      aug.set(i, n + i, Rational.ONE);
    }

    for (let i = 0; i < n; i++) {
      let pivotRow = i;
      while (pivotRow < n && aug.get(pivotRow, i).isZero()) {
        pivotRow++;
      }
      if (pivotRow === n) {
        throw new Error('Matrix is singular and cannot be inverted.');
      }
      aug.swapRows(i, pivotRow);
      aug.pivot(i, i);
    }

    const inv: Rational[][] = Array.from({ length: n }, () => new Array(n).fill(Rational.ZERO));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        inv[i]![j] = aug.get(i, n + j);
      }
    }
    return inv;
  }
};
