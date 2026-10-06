/**
 * Gomory cutting-plane method (spec §9.1 module 6, §10.5).
 *
 *  • pure-integer rows  → Gomory FRACTIONAL cut   Σ frac(αⱼ)·xⱼ ≥ frac(β)
 *  • mixed rows         → Gomory MIXED-INTEGER cut (continuous / integer nonbasic variables treated separately)
 *
 * Each cut is appended to the exact optimal tableau as a new row with a new slack, and feasibility is restored
 * with the dual simplex method. Every cut is also translated back to the original variables so it can be drawn.
 * If the cut count exceeds the limit the solver reports non-convergence and recommends branch & bound.
 */

import { Rational } from '../../math/rational';
import { MNum } from '../../math/bigm';
import { LPModel, Tableau } from '../../types/models';
import { Solution, Solver, ValidationResult, SolveOptions, Diagnostic, TerminationStatus } from '../../types/solver';
import { Step } from '../../types/step';
import { solveLP, validateLP, workFromInternals, engineInternals, LPInternals, EngineWork, EngineSnapCfg, EngineRecorder } from '../lp/engine';
import { genName, joinList } from '../../format';

export interface CutInfo {
  index: number;
  sourceVariable: string;
  fractionalValue: Rational;
  kind: 'fractional' | 'mixed';
  /** coefficient per column name (non-basic variables with non-zero coefficient) */
  terms: { column: string; coef: Rational }[];
  rhs: Rational;
  /** Cut expressed in original variables:  a·x ≤ rhs  (a has one entry per original variable). */
  inX: { coeffs: Rational[]; rhs: Rational } | null;
  text: string;
}

export interface GomoryResult {
  status: string;
  variableValues: Rational[];
  objectiveValue: Rational;
  lpBound: Rational;
  cuts: CutInfo[];
}

export interface GomoryOptions extends SolveOptions {
  maxCuts?: number;
  cutType?: 'auto' | 'fractional' | 'mixed';
}

interface Affine { c0: Rational; coefs: Rational[] }

function floorR(r: Rational): Rational {
  const q = r.n / r.d;
  return Rational.of(r.n < 0n && r.n % r.d !== 0n ? q - 1n : q);
}
const frac = (r: Rational) => r.sub(floorR(r));

export class GomorySolver implements Solver<LPModel, Tableau, GomoryResult> {
  readonly id = 'integer.gomory';

  readonly meta = {
    name: 'Gomory cutting planes',
    category: 'integer-programming' as const,
    variants: [
      { id: 'auto', name: 'Fractional / mixed (auto)', description: 'Fractional cut for all-integer rows, mixed-integer cut otherwise.' },
      { id: 'fractional', name: 'Fractional cuts only', description: 'Textbook Gomory fractional cut (pure integer programmes).' },
      { id: 'mixed', name: 'Mixed-integer cuts', description: 'Gomory mixed-integer cut for every row.' },
    ],
    visualizerId: 'TableauView',
    sizeLimit: { rows: 30, cols: 30 },
    supportsTutorial: false,
    reference: 'Taha, Operations Research: An Introduction, §9.2',
  };

  validate(model: LPModel): ValidationResult {
    const v = validateLP(model);
    const errors = [...v.errors];
    const n = model.objective.length;
    if (!(model.integrality ?? Array(n).fill('integer')).some(t => t !== 'continuous')) {
      errors.push({ message: 'At least one variable must be integer.' });
    }
    model.varBounds?.forEach((b, j) => {
      if (b.lower === null || !b.lower.isZero()) errors.push({ field: `var ${j + 1}`, message: 'Gomory cuts here require variables with lower bound 0. Use branch & bound for shifted or free variables.' });
    });
    return { valid: errors.length === 0, errors };
  }

  normalize(model: LPModel): LPModel {
    const integrality = model.integrality ?? (Array(model.objective.length).fill('integer') as LPModel['integrality']);
    // A binary variable is an integer in [0, 1]: make the upper bound explicit so the relaxation respects it.
    const varBounds = integrality!.some(t => t === 'binary')
      ? model.objective.map((_, j) => {
          const b = model.varBounds?.[j] ?? { lower: Rational.ZERO, upper: null };
          if (integrality![j] !== 'binary') return b;
          return { lower: b.lower, upper: b.upper === null || b.upper.gt(Rational.ONE) ? Rational.ONE : b.upper };
        })
      : model.varBounds;
    return { ...model, integrality, varBounds };
  }

  solve(rawModel: LPModel, options: GomoryOptions = {}): Solution<Tableau, GomoryResult> {
    const t0 = performance.now();
    const fail = (message: string, code: string, status: TerminationStatus = 'invalid-input'): Solution<Tableau, GomoryResult> => ({
      steps: [], result: null, status, diagnostics: [{ severity: 'error', code, message }],
      metrics: { iterations: 0, elapsedMs: 0, degradedToFloat: false },
    });
    const val = this.validate(rawModel);
    if (!val.valid) return fail(val.errors.map(e => e.message).join(' '), 'INVALID_MODEL');
    const model = this.normalize(rawModel);
    const n = model.objective.length;
    const integ = model.integrality!;
    const maxCuts = options.maxCuts ?? options.maxIterations ?? 40;
    const cutType = (options.variant as GomoryOptions['cutType']) ?? options.cutType ?? 'auto';

    // 1. LP relaxation
    const lp = solveLP({ ...model, integrality: undefined }, { method: 'auto' });
    if (!lp.result || !(lp.status === 'optimal' || lp.status === 'optimal-alternate-exists')) {
      return { steps: lp.steps, result: null, status: lp.status, diagnostics: [...lp.diagnostics, { severity: 'error', code: 'LP_NOT_OPTIMAL', message: 'The LP relaxation has no optimal solution, so cutting planes cannot start.' }], metrics: lp.metrics };
    }
    const lpBound = lp.result.objectiveValue;
    const I = lp.result.internals as LPInternals;
    const sf = I.sf;
    if (sf.varMaps.some(vm => vm.kind !== 'plain')) return fail('Gomory cuts need plain non-negative variables.', 'UNSUPPORTED_VARIABLES');

    const diagnostics: Diagnostic[] = [...lp.diagnostics];
    const steps: Step<Tableau>[] = [...lp.steps];
    const rec: EngineRecorder = { steps, diags: diagnostics, emit: true, seen: new Set() };
    const isMax = sf.isMax;
    const zMax = isMax ? lpBound.sub(sf.objConstOrig) : lpBound.sub(sf.objConstOrig).neg();
    const w: EngineWork = workFromInternals(I, zMax);
    const cfg: EngineSnapCfg = { method: 'gomory', phase: null, sense: isMax ? 'max' : 'min', objConst: sf.objConstOrig, showM: false, label: 'z' };

    // Affine definition of each column in terms of the original variables (plain ⇒ y = x).
    const affine: Affine[] = w.names.map(() => ({ c0: Rational.ZERO, coefs: Array(n).fill(Rational.ZERO) }));
    for (let p = 0; p < sf.yNames.length; p++) {
      affine[p] = { c0: Rational.ZERO, coefs: Array.from({ length: n }, (_, j) => (sf.varMaps[j]!.terms[0]!.col === p ? Rational.ONE : Rational.ZERO)) };
    }
    I.rows.forEach((row, r) => {
      const idc = I.idCols[r]!;
      if (row.relation === '<=') {
        affine[idc] = { c0: row.rhs, coefs: row.coeffs.map(c => c.neg()) };
      } else if (row.relation === '>=') {
        affine[idc - 1] = { c0: row.rhs.neg(), coefs: [...row.coeffs] };
      }
    });
    const colInteger = (j: number): boolean => {
      if (w.types[j] === 'decision') return integ[sf.varMaps.findIndex(vm => vm.terms[0]!.col === j)] !== 'continuous';
      const a = affine[j]!;
      if (!a.c0.isInteger()) return false;
      return a.coefs.every((c, k) => c.isZero() || (c.isInteger() && integ[k] !== 'continuous'));
    };

    const cuts: CutInfo[] = [];
    let status: TerminationStatus = 'optimal';
    const intRowsFractional = () => {
      let best = -1;
      let bestF = Rational.ZERO;
      for (let i = 0; i < w.m; i++) {
        const bc = w.basis[i]!;
        if (w.types[bc] !== 'decision') continue;
        const origIdx = sf.varMaps.findIndex(vm => vm.terms[0]!.col === bc);
        if (origIdx < 0 || integ[origIdx] === 'continuous') continue;
        const f = frac(w.b[i]!);
        if (f.isZero()) continue;
        if (best === -1 || f.gt(bestF)) { best = i; bestF = f; }
      }
      return best;
    };

    let totalPivots = 0;
    while (true) {
      const row = intRowsFractional();
      if (row === -1) break;
      if (cuts.length >= maxCuts) {
        status = 'iteration-limit';
        diagnostics.push({
          severity: 'warning',
          code: 'GOMORY_NOT_CONVERGING',
          message: `Gomory cutting planes did not reach an integer solution within ${maxCuts} cuts. Pure cutting-plane methods are known to converge slowly; use Branch & Bound for this problem.`,
        });
        break;
      }

      const bc = w.basis[row]!;
      const f0 = frac(w.b[row]!);
      const srcName = w.names[bc]!;
      const nonbasic: number[] = [];
      for (let j = 0; j < w.n; j++) if (w.allowEnter[j] && !w.basis.includes(j) && !w.A[row]![j]!.isZero()) nonbasic.push(j);
      const allInt = nonbasic.every(j => colInteger(j));
      const kind: 'fractional' | 'mixed' = cutType === 'mixed' ? 'mixed' : cutType === 'fractional' ? (allInt ? 'fractional' : 'mixed') : allInt ? 'fractional' : 'mixed';

      const coef = new Map<number, Rational>();
      for (const j of nonbasic) {
        const a = w.A[row]![j]!;
        let c: Rational;
        if (kind === 'fractional') c = frac(a);
        else if (colInteger(j)) {
          const fj = frac(a);
          c = fj.lte(f0) ? fj : f0.mul(Rational.ONE.sub(fj)).div(Rational.ONE.sub(f0));
        } else {
          c = a.isNegative() ? f0.div(Rational.ONE.sub(f0)).mul(a.neg()) : a;
        }
        if (!c.isZero()) coef.set(j, c);
      }

      // new column g (slack of the cut): g = −f0 + Σ coef_j x_j ≥ 0
      const gIdx = w.n;
      const gName = genName('g', cuts.length + 1);
      for (let i = 0; i < w.m; i++) w.A[i]!.push(Rational.ZERO);
      w.d.push(MNum.ZERO);
      w.names.push(gName);
      w.types.push('slack');
      w.allowEnter.push(true);
      w.visible.push(true);
      w.n += 1;
      const newRow: Rational[] = Array(w.n).fill(Rational.ZERO);
      for (const [j, c] of coef) newRow[j] = c.neg();
      newRow[gIdx] = Rational.ONE;
      w.A.push(newRow);
      w.b.push(f0.neg());
      w.basis.push(gIdx);
      w.idCols.push(gIdx);
      w.m += 1;

      // affine def of g in x-space
      const aff: Affine = { c0: f0.neg(), coefs: Array(n).fill(Rational.ZERO) };
      for (const [j, c] of coef) {
        aff.c0 = aff.c0.add(c.mul(affine[j]!.c0));
        affine[j]!.coefs.forEach((v, k) => { aff.coefs[k] = aff.coefs[k]!.add(c.mul(v)); });
      }
      affine.push(aff);
      // g ≥ 0  ⇔  c0 + Σ a_k x_k ≥ 0  ⇔  Σ (−a_k) x_k ≤ c0
      const inX = { coeffs: aff.coefs.map(c => c.neg()), rhs: aff.c0 };

      const terms = [...coef].map(([j, c]) => ({ column: w.names[j]!, coef: c }));
      const text = `${terms.map(t => `${t.coef.toString()}·${t.column}`).join(' + ') || '0'} ≥ ${f0.toString()}`;
      const info: CutInfo = { index: cuts.length + 1, sourceVariable: srcName, fractionalValue: w.b[row]!, kind, terms, rhs: f0, inX, text };
      cuts.push(info);

      const next = engineInternals.decideDual(w, false);
      engineInternals.pushStep(
        rec, w, cfg, next, `Cut ${info.index}`, { kind: 'cut', payload: { index: info.index, source: srcName } },
        {
          short: `Gomory ${kind} cut ${info.index} from the row of ${srcName} = ${w.b[row]!.toString()}.`,
          detailed:
            `${srcName} must be an integer but equals ${w.b[row]!.toString()} (fractional part ${f0.toString()}). ` +
            `Its row is  ${srcName} + Σ αⱼ·xⱼ = ${w.b[row]!.toString()}  over the non-basic variables ${joinList(nonbasic.map(j => w.names[j]!))}. ` +
            (kind === 'fractional'
              ? `Every variable in this row is integer-valued, so the Gomory fractional cut applies: Σ frac(αⱼ)·xⱼ ≥ frac(β), i.e. ${text}.`
              : `The row involves continuous (or non-integer-valued) variables, so the Gomory mixed-integer cut is used: ${text}.`) +
            ` The current LP optimum violates it (all non-basic variables are 0 so the left side is 0 < ${f0.toString()}), but every integer-feasible point satisfies it. ` +
            `Written with a new slack ${gName}: −(Σ coefficients·xⱼ) + ${gName} = −${f0.toString()}. This adds a row with negative right-hand side, so the dual simplex method now restores feasibility.` +
            (inX ? ` In the original variables the cut reads  ${inX.coeffs.map((c, k) => (c.isZero() ? '' : `${c.toString()}·${model.varNames[k]}`)).filter(Boolean).join(' + ')} ≤ ${inX.rhs.toString()}.` : ''),
          rule: kind === 'fractional' ? 'Gomory fractional cut' : 'Gomory mixed-integer cut',
          formula: `\\sum_j f_j x_j \\ge f_0 = ${f0.toLatex()}`,
        },
        [{ target: `row:${w.m - 1}`, intent: 'changed' }],
        'continue'
      );

      const out = engineInternals.runLoop(w, cfg, rec, { dual: true, maxIterations: 200, phaseLabel: `Dual simplex after cut ${info.index}`, iterStart: 0 });
      totalPivots += out.iterations;
      if (out.status === 'infeasible') {
        diagnostics.push({ severity: 'error', code: 'INTEGER_INFEASIBLE', message: `After cut ${info.index} the LP is infeasible: the integer programme has no feasible solution.` });
        engineInternals.pushStep(rec, w, cfg, undefined, 'Termination', { kind: 'infeasible', payload: {} },
          { short: 'The cut made the LP infeasible: no integer solution exists.', detailed: 'Dual simplex found a row with negative right-hand side and no negative entry. The integer programme is infeasible.', rule: 'Dual simplex infeasibility test' }, [], 'infeasible');
        return { steps, result: null, status: 'infeasible', diagnostics, metrics: { iterations: totalPivots, elapsedMs: performance.now() - t0, degradedToFloat: false } };
      }
      if (out.status === 'iteration-limit') { status = 'iteration-limit'; break; }
    }

    // read off solution
    const y: Rational[] = Array(sf.yNames.length).fill(Rational.ZERO);
    w.basis.forEach((bc, i) => { if (bc < sf.yNames.length) y[bc] = w.b[i]!; });
    const x = sf.varMaps.map(vm => y[vm.terms[0]!.col]!);
    let obj = model.objectiveConstant ?? Rational.ZERO;
    x.forEach((v, j) => { obj = obj.add(model.objective[j]!.mul(v)); });

    if (status === 'optimal') {
      engineInternals.pushStep(rec, w, cfg, undefined, 'Termination', { kind: 'optimal', payload: {} },
        {
          short: `Integer optimum reached after ${cuts.length} cut${cuts.length === 1 ? '' : 's'}: z = ${obj.toString()}.`,
          detailed: `Every integer-restricted variable is now integral: ${model.varNames.map((nm, j) => `${nm} = ${x[j]!.toString()}`).join(', ')}, z = ${obj.toString()} (the LP relaxation bound was ${lpBound.toString()}). ${cuts.length === 0 ? 'The LP relaxation was already integral, so no cut was needed.' : ''}`,
          rule: 'Integrality reached',
        },
        w.basis.map((b, i) => ({ target: `cell:${i},${engineInternals.visibleCols(w).indexOf(b)}`, intent: 'optimal' as const })), 'optimal');
    }
    const finalSteps = steps.map((s, i) => ({ ...s, index: i }));
    return {
      steps: finalSteps,
      result: { status, variableValues: x, objectiveValue: obj, lpBound, cuts },
      status,
      diagnostics,
      metrics: { iterations: totalPivots + lp.metrics.iterations, elapsedMs: performance.now() - t0, degradedToFloat: false },
    };
  }
}

/** Convenience function used by tests and the UI. */
export function solveGomory(model: LPModel, options: GomoryOptions = {}) {
  return new GomorySolver().solve(model, options);
}
