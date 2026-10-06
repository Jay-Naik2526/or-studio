/**
 * LP sensitivity & post-optimal analysis (spec §9.1 module 3, F9).
 *
 * Works from the FINAL BASIS of the exact engine, not from the displayed tableau, so it is correct for
 * min/max problems, ≥/≤/= rows, flipped rows, and bounded variables.
 *
 *  • shadow prices (dual values) with prose interpretation
 *  • RHS ranging  — interval of b_k over which the current basis stays feasible (shadow price valid)
 *  • cost ranging — interval of c_j over which the current basis stays optimal
 *  • reduced costs of non-basic variables
 *  • 100 % rule check for simultaneous changes
 *  • what-if re-solve
 */

import { Rational } from '../../math/rational';
import { LPModel } from '../../types/models';
import { LPResult, solveLP, LPSolution, LPMethod } from './engine';

export interface SensitivityRange {
  current: Rational;
  /** null = −∞ */
  min: Rational | null;
  /** null = +∞ */
  max: Rational | null;
}

export interface ShadowPriceInfo {
  index: number;
  name: string;
  shadowPrice: Rational;
  slack: Rational;
  binding: boolean;
  interpretation: string;
}

export interface RhsRangeInfo {
  index: number;
  constraintName: string;
  range: SensitivityRange;
  /** Which basic variable (name) first hits zero at each end, for explanation. */
  limitingLow?: string;
  limitingHigh?: string;
}

export interface CostRangeInfo {
  index: number;
  varName: string;
  value: Rational;
  isBasic: boolean;
  /** Marginal change of the objective per unit increase of this (non-basic) variable. Null for basic variables. */
  reducedCost: Rational | null;
  range: SensitivityRange;
  /** False for variables replaced by substitution (free / reflected) – ranging not offered. */
  available: boolean;
  note?: string;
}

export interface SensitivityReport {
  shadowPrices: ShadowPriceInfo[];
  rhsRanging: RhsRangeInfo[];
  objectiveRanging: CostRangeInfo[];
  valid: boolean;
  reason?: string;
}

export class SensitivityAnalyzer {
  static analyze(model: LPModel, result: LPResult): SensitivityReport {
    const empty: SensitivityReport = { shadowPrices: [], rhsRanging: [], objectiveRanging: [], valid: false };
    const I = result.internals;
    if (!I) return { ...empty, reason: 'No final basis is available.' };
    if (!(result.status === 'optimal' || result.status === 'optimal-alternate-exists')) {
      return { ...empty, reason: 'Sensitivity analysis is only defined at an optimal solution.' };
    }

    const m = I.rows.length;
    const nCols = I.colNames.length;
    const isMax = I.sf.isMax;
    const s = isMax ? Rational.ONE : Rational.MINUS_ONE;
    const ny = I.sf.yNames.length;

    // B^{-1}[i][r] = final A[i][idCols[r]]
    const Binv = (i: number, r: number) => I.A[i]![I.idCols[r]!]!;
    const xB = I.b;
    const basisSet = new Set(I.basisFull);
    const allowed = (j: number) => I.colTypes[j] !== 'artificial';

    // ---------- shadow prices ----------
    const shadowPrices: ShadowPriceInfo[] = model.constraints.map((c, k) => {
      const name = c.name || `Constraint ${k + 1}`;
      const y = result.dualValues[k]!;
      const slack = result.slackValues[k]!;
      const binding = slack.isZero();
      const dir = y.isZero() ? 'does not change' : y.isPositive() ? 'increases' : 'decreases';
      const interp = y.isZero()
        ? `${name} is ${binding ? 'binding but with zero marginal value (degenerate)' : `not binding (slack ${slack.toString()})`}, so relaxing or tightening it slightly does not change the optimal objective.`
        : `Each extra unit of right-hand side of ${name} ${dir} the optimal objective by ${y.abs().toString()} (z moves from ${result.objectiveValue.toString()} to ${result.objectiveValue.add(y).toString()} per unit), as long as the right-hand side stays inside its allowable range.`;
      return { index: k, name, shadowPrice: y, slack, binding, interpretation: interp };
    });

    // ---------- RHS ranging ----------
    const rhsRanging: RhsRangeInfo[] = model.constraints.map((c, k) => {
      const name = c.name || `Constraint ${k + 1}`;
      const rowsOfK = I.rowMeta.map((rm, r) => (rm.origIndex === k ? r : -1)).filter(r => r >= 0);
      let lo: Rational | null = null; // largest lower Δ  (Δ ≥ lo)
      let hi: Rational | null = null; // smallest upper Δ  (Δ ≤ hi)
      let loVar: string | undefined;
      let hiVar: string | undefined;
      if (rowsOfK.length === 1) {
        const r = rowsOfK[0]!;
        const sigma = Rational.of(I.rowMeta[r]!.sigma);
        for (let i = 0; i < m; i++) {
          const coef = Binv(i, r).mul(sigma); // d x_Bi / d Δ
          if (coef.isZero()) continue;
          const bound = xB[i]!.neg().div(coef); // x_Bi + Δ·coef ≥ 0
          const name2 = I.colNames[I.basisFull[i]!]!;
          if (coef.isPositive()) {
            if (lo === null || bound.gt(lo)) { lo = bound; loVar = name2; }
          } else {
            if (hi === null || bound.lt(hi)) { hi = bound; hiVar = name2; }
          }
        }
      }
      return {
        index: k,
        constraintName: name,
        range: {
          current: c.rhs,
          min: rowsOfK.length === 1 && lo !== null ? c.rhs.add(lo) : null,
          max: rowsOfK.length === 1 && hi !== null ? c.rhs.add(hi) : null,
        },
        limitingLow: loVar,
        limitingHigh: hiVar,
      };
    });

    // ---------- cost ranging ----------
    const objectiveRanging: CostRangeInfo[] = model.objective.map((cj, j) => {
      const vm = I.sf.varMaps[j]!;
      const name = model.varNames[j] ?? `x${j + 1}`;
      const value = result.variableValues[j]!;
      const simple = (vm.kind === 'plain' || vm.kind === 'shifted') && vm.terms.length === 1 && vm.terms[0]!.coef.eq(Rational.ONE);
      if (!simple) {
        return {
          index: j,
          varName: name,
          value,
          isBasic: !value.isZero(),
          reducedCost: null,
          range: { current: cj, min: null, max: null },
          available: false,
          note: 'Replaced by a substitution (free or reflected variable); ranging of the original coefficient is not offered.',
        };
      }
      const p = vm.terms[0]!.col;
      const rowOfP = I.basisFull.indexOf(p);
      let loD: Rational | null = null; // Δ' ≥ loD   (max-form)
      let hiD: Rational | null = null; // Δ' ≤ hiD
      let reducedCost: Rational | null = null;
      if (rowOfP < 0) {
        const dp = I.d[p]!;
        hiD = dp; // Δ' ≤ d_p
        reducedCost = s.neg().mul(dp); // marginal change of z per unit increase
      } else {
        for (let k = 0; k < nCols; k++) {
          if (basisSet.has(k) || !allowed(k)) continue;
          const alpha = I.A[rowOfP]![k]!;
          if (alpha.isZero()) continue;
          const dk = I.d[k]!;
          const bound = dk.neg().div(alpha); // d_k + Δ' α ≥ 0
          if (alpha.isPositive()) { if (loD === null || bound.gt(loD)) loD = bound; }
          else { if (hiD === null || bound.lt(hiD)) hiD = bound; }
        }
      }
      // Map Δ' (max-form) to Δ on c_j: Δ' = s·Δ
      let minC: Rational | null;
      let maxC: Rational | null;
      if (isMax) {
        minC = loD === null ? null : cj.add(loD);
        maxC = hiD === null ? null : cj.add(hiD);
      } else {
        // Δ = −Δ'  ⇒ Δ ∈ [−hiD, −loD]
        minC = hiD === null ? null : cj.sub(hiD);
        maxC = loD === null ? null : cj.sub(loD);
      }
      return {
        index: j,
        varName: name,
        value,
        isBasic: rowOfP >= 0,
        reducedCost,
        range: { current: cj, min: minC, max: maxC },
        available: true,
      };
    });
    void ny;
    return { shadowPrices, rhsRanging, objectiveRanging, valid: true };
  }

  /**
   * 100 % rule for simultaneous changes. Each change is expressed as a signed delta against the
   * current value; the ratio is delta / allowable-in-that-direction. The basis is guaranteed
   * unchanged if the ratios sum to ≤ 1 (sufficient, not necessary).
   */
  static hundredPercentRule(
    ranges: { range: SensitivityRange; delta: Rational }[]
  ): { sum: Rational; withinRule: boolean; parts: Rational[] } {
    let sum = Rational.ZERO;
    const parts: Rational[] = [];
    for (const { range, delta } of ranges) {
      let allowed: Rational | null;
      if (delta.isZero()) { parts.push(Rational.ZERO); continue; }
      if (delta.isPositive()) allowed = range.max === null ? null : range.max.sub(range.current);
      else allowed = range.min === null ? null : range.current.sub(range.min);
      if (allowed === null) { parts.push(Rational.ZERO); continue; }
      if (allowed.isZero()) { parts.push(Rational.of(2)); sum = sum.add(Rational.of(2)); continue; }
      const ratio = delta.abs().div(allowed);
      parts.push(ratio);
      sum = sum.add(ratio);
    }
    return { sum, withinRule: sum.lte(Rational.ONE), parts };
  }

  /** Re-solve with changed objective coefficient(s) / RHS(s) and compare with the baseline. */
  static whatIf(
    model: LPModel,
    change: { cost?: Record<number, Rational>; rhs?: Record<number, Rational> },
    base: LPSolution,
    method: LPMethod = 'auto'
  ): { model: LPModel; solution: LPSolution; basisChanged: boolean; objectiveDelta: Rational | null } {
    const next: LPModel = {
      ...model,
      objective: model.objective.map((c, j) => change.cost?.[j] ?? c),
      constraints: model.constraints.map((c, i) => ({ ...c, rhs: change.rhs?.[i] ?? c.rhs })),
    };
    const solution = solveLP(next, { method, emitSteps: false });
    const b0 = base.result?.internals?.basisFull.slice().sort((x, y) => x - y).join(',');
    const b1 = solution.result?.internals?.basisFull.slice().sort((x, y) => x - y).join(',');
    return {
      model: next,
      solution,
      basisChanged: b0 !== b1,
      objectiveDelta: base.result && solution.result ? solution.result.objectiveValue.sub(base.result.objectiveValue) : null,
    };
  }
}
