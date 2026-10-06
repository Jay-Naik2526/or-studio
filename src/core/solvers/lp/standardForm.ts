/**
 * LP preprocessing: variable substitution (free / shifted / reflected / upper-bounded variables)
 * and conversion into rows over non-negative structural columns y ≥ 0.
 *
 * Spec §10.1: "Unrestricted variable — substitute x = x⁺ − x⁻; show the substitution explicitly",
 *             "Negative right-hand side — multiply through by −1 and flip the relation; show this".
 */

import { Rational } from '../../math/rational';
import { LPModel, Relation } from '../../types/models';
import { canonVarName } from '../../format';

export interface VarMap {
  /** x_j = offset + Σ coef · y_col */
  offset: Rational;
  terms: { col: number; coef: Rational }[];
  kind: 'plain' | 'shifted' | 'reflected' | 'free';
}

export interface StdRow {
  coeffs: Rational[]; // over structural columns y
  relation: Relation;
  rhs: Rational;
  /** Index of the original constraint, or null for generated bound rows. */
  origIndex: number | null;
  label: string;
}

export interface StandardForm {
  yNames: string[];
  varMaps: VarMap[];
  /** Objective on y in MAXIMISATION form (negated for min problems). */
  costMax: Rational[];
  /** Constant part of the ORIGINAL objective after substitution (Σ c_j·offset_j + k). */
  objConstOrig: Rational;
  rows: StdRow[];
  isMax: boolean;
  /** Human-readable normalisation notes shown in step 0. */
  notes: string[];
}

export function buildStandardForm(model: LPModel): StandardForm {
  const n = model.objective.length;
  const isMax = model.sense === 'max';
  const notes: string[] = [];
  const names = Array.from({ length: n }, (_, j) => canonVarName(model.varNames[j] || `x${j + 1}`));

  const yNames: string[] = [];
  const varMaps: VarMap[] = [];
  const boundRows: StdRow[] = [];

  for (let j = 0; j < n; j++) {
    const b = model.varBounds?.[j];
    const lower = b ? b.lower : Rational.ZERO;
    const upper = b ? b.upper : null;
    const name = names[j]!;

    if (lower === null && upper === null) {
      const p = yNames.length;
      yNames.push(`${name}⁺`, `${name}⁻`);
      varMaps.push({
        offset: Rational.ZERO,
        terms: [
          { col: p, coef: Rational.ONE },
          { col: p + 1, coef: Rational.MINUS_ONE },
        ],
        kind: 'free',
      });
      notes.push(`${name} is unrestricted in sign, so it is replaced by ${name} = ${name}⁺ − ${name}⁻ with ${name}⁺, ${name}⁻ ≥ 0.`);
    } else if (lower === null && upper !== null) {
      const p = yNames.length;
      yNames.push(`${name}′`);
      varMaps.push({ offset: upper, terms: [{ col: p, coef: Rational.MINUS_ONE }], kind: 'reflected' });
      notes.push(`${name} ≤ ${upper.toString()} with no lower bound, so substitute ${name} = ${upper.toString()} − ${name}′ with ${name}′ ≥ 0.`);
    } else {
      const lo = lower!;
      const p = yNames.length;
      if (lo.isZero()) {
        yNames.push(name);
        varMaps.push({ offset: Rational.ZERO, terms: [{ col: p, coef: Rational.ONE }], kind: 'plain' });
      } else {
        yNames.push(`${name}′`);
        varMaps.push({ offset: lo, terms: [{ col: p, coef: Rational.ONE }], kind: 'shifted' });
        notes.push(`${name} ≥ ${lo.toString()}, so substitute ${name} = ${lo.toString()} + ${name}′ with ${name}′ ≥ 0.`);
      }
      if (upper !== null) {
        boundRows.push({
          coeffs: [], // filled after column count is known
          relation: '<=',
          rhs: upper.sub(lo),
          origIndex: null,
          label: `${name}${lo.isZero() ? '' : '′'} ≤ ${upper.sub(lo).toString()}`,
        });
        (boundRows[boundRows.length - 1] as StdRow & { _col?: number })._col = p;
        notes.push(`Upper bound ${name} ≤ ${upper.toString()} is added as an explicit constraint row.`);
      }
    }
  }

  const ny = yNames.length;

  // Objective
  let objConstOrig = model.objectiveConstant ?? Rational.ZERO;
  const costOrig: Rational[] = Array(ny).fill(Rational.ZERO);
  for (let j = 0; j < n; j++) {
    const cj = model.objective[j] ?? Rational.ZERO;
    const vm = varMaps[j]!;
    objConstOrig = objConstOrig.add(cj.mul(vm.offset));
    for (const t of vm.terms) costOrig[t.col] = costOrig[t.col]!.add(cj.mul(t.coef));
  }
  const costMax = costOrig.map(c => (isMax ? c : c.neg()));

  // Constraint rows
  const rows: StdRow[] = [];
  model.constraints.forEach((con, i) => {
    const coeffs: Rational[] = Array(ny).fill(Rational.ZERO);
    let rhs = con.rhs;
    for (let j = 0; j < n; j++) {
      const a = con.coeffs[j] ?? Rational.ZERO;
      if (a.isZero()) continue;
      const vm = varMaps[j]!;
      rhs = rhs.sub(a.mul(vm.offset));
      for (const t of vm.terms) coeffs[t.col] = coeffs[t.col]!.add(a.mul(t.coef));
    }
    rows.push({
      coeffs,
      relation: con.relation,
      rhs,
      origIndex: i,
      label: con.name || `Constraint ${i + 1}`,
    });
  });

  for (const br of boundRows) {
    const col = (br as StdRow & { _col?: number })._col!;
    const coeffs: Rational[] = Array(ny).fill(Rational.ZERO);
    coeffs[col] = Rational.ONE;
    br.coeffs = coeffs;
    delete (br as StdRow & { _col?: number })._col;
    rows.push(br);
  }

  return { yNames, varMaps, costMax, objConstOrig, rows, isMax, notes };
}

/** Recover original variable values from structural values y. */
export function recoverVariables(sf: StandardForm, y: Rational[]): Rational[] {
  return sf.varMaps.map(vm => {
    let v = vm.offset;
    for (const t of vm.terms) v = v.add(t.coef.mul(y[t.col] ?? Rational.ZERO));
    return v;
  });
}

export interface NormalizedRow extends StdRow {
  /** −1 if the row was multiplied by −1 to make the right-hand side non-negative, else +1. */
  sigma: 1 | -1;
}

/** Multiply rows with negative RHS by −1 (flipping ≤ ↔ ≥). */
export function flipNegativeRhs(rows: StdRow[]): { rows: NormalizedRow[]; notes: string[] } {
  const notes: string[] = [];
  const out: NormalizedRow[] = rows.map((r, i) => {
    if (r.rhs.isNegative()) {
      const rel: Relation = r.relation === '<=' ? '>=' : r.relation === '>=' ? '<=' : '=';
      notes.push(
        `Row ${i + 1} (${r.label}) has a negative right-hand side (${r.rhs.toString()}); multiplied through by −1 so that it becomes ${rel} ${r.rhs.neg().toString()}.`
      );
      return { ...r, coeffs: r.coeffs.map(c => c.neg()), relation: rel, rhs: r.rhs.neg(), sigma: -1 as const };
    }
    return { ...r, sigma: 1 as const };
  });
  return { rows: out, notes };
}
