/**
 * LP duality: construction of the dual, correspondence tables, and a verification report.
 *
 * Rules used (the "SOB" rules — Sensible / Odd / Bizarre — in their sign-table form):
 *
 *   PRIMAL  max z = c·x                  DUAL  min w = b·y
 *     constraint i  ≤                      variable y_i ≥ 0
 *     constraint i  ≥                      variable y_i ≤ 0
 *     constraint i  =                      variable y_i unrestricted
 *     variable x_j ≥ 0                     constraint j  (Aᵀy)_j ≥ c_j
 *     variable x_j ≤ 0                     constraint j  (Aᵀy)_j ≤ c_j
 *     variable x_j free                    constraint j  (Aᵀy)_j = c_j
 *
 *   PRIMAL  min z = c·x                  DUAL  max w = b·y
 *     constraint i  ≥                      variable y_i ≥ 0
 *     constraint i  ≤                      variable y_i ≤ 0
 *     constraint i  =                      variable y_i unrestricted
 *     variable x_j ≥ 0                     constraint j  (Aᵀy)_j ≤ c_j
 *     variable x_j ≤ 0                     constraint j  (Aᵀy)_j ≥ c_j
 *     variable x_j free                    constraint j  (Aᵀy)_j = c_j
 *
 * With these conventions y_i = ∂z/∂b_i, i.e. the dual variables ARE the shadow prices.
 * Variables with other bounds are first shifted (x = l + x′) so that every variable is ≥ 0, ≤ 0 or free; a finite
 * upper bound on a shifted variable becomes an explicit constraint row. Integrality is ignored (LP relaxation).
 */

import { Rational } from '../../math/rational';
import { LPModel, Relation } from '../../types/models';
import { formatLinear } from '../../parse/algebraic';
import { canonVarName } from '../../format';
import { solveLP, validateLP } from './engine';

export type SignRestriction = '>=0' | '<=0' | 'free';

export const signText = (s: SignRestriction): string => (s === '>=0' ? '≥ 0' : s === '<=0' ? '≤ 0' : 'unrestricted');
const relText = (r: Relation): string => (r === '<=' ? '≤' : r === '>=' ? '≥' : '=');

/** The SOB table that the construction follows (for display). */
export const SOB_TABLE: { primal: string; dual: string }[] = [
  { primal: 'Objective: max', dual: 'Objective: min' },
  { primal: 'Constraint ≤  (sensible for max)', dual: 'Variable ≥ 0' },
  { primal: 'Constraint ≥  (odd for max)', dual: 'Variable ≤ 0' },
  { primal: 'Constraint =  (bizarre)', dual: 'Variable unrestricted' },
  { primal: 'Variable ≥ 0', dual: 'Constraint ≥  (for a max primal)' },
  { primal: 'Variable ≤ 0', dual: 'Constraint ≤  (for a max primal)' },
  { primal: 'Variable unrestricted', dual: 'Constraint =' },
  { primal: 'For a MIN primal: ≥ is sensible, ≤ is odd, = is bizarre', dual: 'Same signs on y; variable ≥ 0 gives a ≤ constraint, ≤ 0 gives ≥' },
];

export interface DualBuild {
  ok: true;
  /** The primal after shifting bounds, so that every variable is ≥ 0, ≤ 0 or free. */
  primal: LPModel;
  primalSigns: SignRestriction[];
  /** x_j(original) = offsets[j] + x′_j(normalised). */
  offsets: Rational[];
  /** Indices (in primal.constraints) of rows added for finite upper bounds. */
  addedRows: number[];
  dual: LPModel;
  dualSigns: SignRestriction[];
  correspondence: {
    constraints: { index: number; label: string; relation: Relation; dualVar: string; dualSign: SignRestriction; note: string }[];
    variables: { index: number; name: string; sign: SignRestriction; dualConstraint: string; dualRelation: Relation; note: string }[];
  };
  notes: string[];
  /** Plain-language statement of the dual in the same notation as the input. */
  displayText: string;
  /** Matrix form of primal and dual. */
  matrixPrimal: MatrixForm;
  matrixDual: MatrixForm;
}
export type DualFailure = { ok: false; reason: string };

export interface MatrixForm {
  sense: 'max' | 'min';
  varNames: string[];
  c: string[];
  A: string[][];
  rel: string[];
  b: string[];
  signs: string[];
  /** Compact one-line-per-row text version. */
  lines: string[];
}

const zeroQ = Rational.ZERO;

function boundsOf(model: LPModel, j: number): { lower: Rational | null; upper: Rational | null } {
  const b = model.varBounds?.[j];
  if (!b) return { lower: zeroQ, upper: null };
  return { lower: b.lower, upper: b.upper };
}

/** Shift variables so that each one is ≥ 0, ≤ 0 or free. Pure; an already-normal model comes back unchanged. */
export function normalisePrimal(model: LPModel): {
  model: LPModel;
  signs: SignRestriction[];
  offsets: Rational[];
  addedRows: number[];
  notes: string[];
} {
  const n = model.objective.length;
  const signs: SignRestriction[] = [];
  const offsets: Rational[] = [];
  const names: string[] = [];
  const bounds: { lower: Rational | null; upper: Rational | null }[] = [];
  const extra: { j: number; rhs: Rational; label: string }[] = [];
  const notes: string[] = [];
  for (let j = 0; j < n; j++) {
    const nm = model.varNames[j] ?? `x${j + 1}`;
    const { lower, upper } = boundsOf(model, j);
    if (lower === null && upper === null) {
      signs.push('free'); offsets.push(zeroQ); names.push(nm); bounds.push({ lower: null, upper: null });
    } else if (lower === null && upper !== null) {
      if (upper.isZero()) {
        signs.push('<=0'); offsets.push(zeroQ); names.push(nm); bounds.push({ lower: null, upper: zeroQ });
      } else {
        signs.push('<=0'); offsets.push(upper); names.push(`${nm}′`); bounds.push({ lower: null, upper: zeroQ });
        notes.push(`${nm} ≤ ${upper.toString()} is shifted: ${nm} = ${upper.toString()} + ${nm}′ with ${nm}′ ≤ 0.`);
      }
    } else {
      const lo = lower!;
      signs.push('>=0'); offsets.push(lo); bounds.push({ lower: zeroQ, upper: null });
      if (lo.isZero()) names.push(nm);
      else { names.push(`${nm}′`); notes.push(`${nm} ≥ ${lo.toString()} is shifted: ${nm} = ${lo.toString()} + ${nm}′ with ${nm}′ ≥ 0.`); }
      if (upper !== null) {
        extra.push({ j, rhs: upper.sub(lo), label: `${names[j]} ≤ ${upper.sub(lo).toString()}` });
        notes.push(`The upper bound ${nm} ≤ ${upper.toString()} becomes an explicit constraint row, which gets its own dual variable.`);
      }
    }
  }
  let constant = model.objectiveConstant ?? zeroQ;
  for (let j = 0; j < n; j++) constant = constant.add((model.objective[j] ?? zeroQ).mul(offsets[j]!));
  const constraints = model.constraints.map(c => {
    let rhs = c.rhs;
    for (let j = 0; j < n; j++) rhs = rhs.sub((c.coeffs[j] ?? zeroQ).mul(offsets[j]!));
    return { ...c, coeffs: [...c.coeffs], rhs };
  });
  const addedRows: number[] = [];
  for (const e of extra) {
    addedRows.push(constraints.length);
    constraints.push({
      coeffs: Array.from({ length: n }, (_, k) => (k === e.j ? Rational.ONE : zeroQ)),
      relation: '<=', rhs: e.rhs, name: e.label,
    });
  }
  const out: LPModel = {
    sense: model.sense,
    objective: [...model.objective],
    objectiveConstant: constant.isZero() ? undefined : constant,
    constraints,
    varNames: names,
    varBounds: bounds,
  };
  return { model: out, signs, offsets, addedRows, notes };
}

function dualVarSign(sense: 'max' | 'min', rel: Relation): SignRestriction {
  if (rel === '=') return 'free';
  if (sense === 'max') return rel === '<=' ? '>=0' : '<=0';
  return rel === '>=' ? '>=0' : '<=0';
}
function dualConRel(sense: 'max' | 'min', sign: SignRestriction): Relation {
  if (sign === 'free') return '=';
  if (sense === 'max') return sign === '>=0' ? '>=' : '<=';
  return sign === '>=0' ? '<=' : '>=';
}
function boundFor(s: SignRestriction): { lower: Rational | null; upper: Rational | null } {
  return s === '>=0' ? { lower: zeroQ, upper: null } : s === '<=0' ? { lower: null, upper: zeroQ } : { lower: null, upper: null };
}

/** Sign restriction recorded in a model's bounds (after normalisation). */
export function signsOf(model: LPModel): SignRestriction[] {
  return model.objective.map((_, j) => {
    const { lower, upper } = boundsOf(model, j);
    if (lower === null && upper === null) return 'free';
    if (lower === null) return '<=0';
    return '>=0';
  });
}

export function matrixFormOf(model: LPModel, signs: SignRestriction[]): MatrixForm {
  const q = (v: Rational) => v.toString();
  const c = model.objective.map(q);
  const A = model.constraints.map(r => model.objective.map((_, j) => q(r.coeffs[j] ?? zeroQ)));
  const rel = model.constraints.map(r => relText(r.relation));
  const b = model.constraints.map(r => q(r.rhs));
  const sg = signs.map((s, j) => `${model.varNames[j]} ${signText(s)}`);
  const w = Math.max(1, ...c.map(s => s.length), ...A.flat().map(s => s.length));
  const pad = (s: string) => s.padStart(w);
  const lines = [
    `${model.sense} z = [ ${c.map(pad).join(' ')} ] · [ ${model.varNames.join(' ')} ]ᵀ`,
    'subject to  A·x ' + (new Set(rel).size === 1 ? rel[0] ?? '' : '(≤, ≥, =)') + ' b, with',
    ...A.map((row, i) => `  [ ${row.map(pad).join(' ')} ]  ${rel[i]}  ${b[i]}`),
    `  ${sg.join(', ') || '—'}`,
  ];
  return { sense: model.sense, varNames: [...model.varNames], c, A, rel, b, signs: sg, lines };
}

/** Readable statement of a model with explicit sign restrictions (same notation as the input panel). */
export function formatWithSigns(model: LPModel, signs: SignRestriction[], label?: (i: number) => string): string {
  const names = model.varNames;
  const obj = formatLinear(model.objective, names);
  const k = model.objectiveConstant;
  const kTxt = k && !k.isZero() ? (k.isNegative() ? ` - ${k.abs().toString()}` : ` + ${k.toString()}`) : '';
  const lines = [`${model.sense} ${obj}${kTxt}`, 'subject to'];
  model.constraints.forEach((c, i) => {
    const lab = label ? label(i) : '';
    lines.push(`  ${lab ? lab + ':  ' : ''}${formatLinear(c.coeffs, names)} ${relText(c.relation)} ${c.rhs.toString()}`);
  });
  const groups: Record<SignRestriction, string[]> = { '>=0': [], '<=0': [], free: [] };
  signs.forEach((s, j) => groups[s].push(names[j]!));
  if (groups['>=0'].length) lines.push(`  ${groups['>=0'].join(', ')} ≥ 0`);
  if (groups['<=0'].length) lines.push(`  ${groups['<=0'].join(', ')} ≤ 0`);
  if (groups.free.length) lines.push(`  ${groups.free.join(', ')} unrestricted in sign`);
  return lines.join('\n');
}

export function buildDual(model: LPModel): DualBuild | DualFailure {
  const v = validateLP(model);
  if (!v.valid) return { ok: false, reason: v.errors[0]?.message ?? 'The model is not valid.' };
  const norm = normalisePrimal(model);
  const P = norm.model;
  const n = P.objective.length;
  const m = P.constraints.length;
  const sense = P.sense;
  const dualSense: 'max' | 'min' = sense === 'max' ? 'min' : 'max';

  const yNames = Array.from({ length: m }, (_, i) => canonVarName(`y${i + 1}`));
  const dualSigns = P.constraints.map(c => dualVarSign(sense, c.relation));
  const conRel = norm.signs.map(s => dualConRel(sense, s));
  const dual: LPModel = {
    sense: dualSense,
    objective: P.constraints.map(c => c.rhs),
    objectiveConstant: P.objectiveConstant,
    constraints: P.objective.map((cj, j) => ({
      coeffs: P.constraints.map(r => r.coeffs[j] ?? zeroQ),
      relation: conRel[j]!,
      rhs: cj,
      name: P.varNames[j],
    })),
    varNames: yNames,
    varBounds: dualSigns.map(boundFor),
  };

  const conLabel = (i: number) => P.constraints[i]?.name?.trim() || `constraint ${i + 1}`;
  const correspondence = {
    constraints: P.constraints.map((c, i) => ({
      index: i, label: conLabel(i), relation: c.relation, dualVar: yNames[i]!, dualSign: dualSigns[i]!,
      note: c.relation === '=' ? 'an equation has no slack, so its multiplier may take either sign'
        : (sense === 'max') === (c.relation === '<=') ? 'the "sensible" direction for this objective: multiplier ≥ 0'
          : 'the "odd" direction for this objective: multiplier ≤ 0',
    })),
    variables: P.objective.map((_, j) => ({
      index: j, name: P.varNames[j]!, sign: norm.signs[j]!, dualConstraint: `dual constraint ${j + 1}`, dualRelation: conRel[j]!,
      note: norm.signs[j] === 'free' ? 'a free variable forces its dual constraint to be an equation'
        : `a ${norm.signs[j] === '>=0' ? 'non-negative' : 'non-positive'} variable gives an inequality in the dual`,
    })),
  };

  const notes = [...norm.notes];
  notes.push(`Primal is a ${sense === 'max' ? 'maximisation' : 'minimisation'}, so the dual is a ${dualSense === 'max' ? 'maximisation' : 'minimisation'} with one variable per primal constraint (${m}) and one constraint per primal variable (${n}).`);
  if (model.integrality?.some(t => t && t !== 'continuous')) notes.push('Integrality is ignored: duality is defined for the LP relaxation.');

  const displayText = formatWithSigns(dual, dualSigns, j => `(${P.varNames[j]})`);
  return {
    ok: true,
    primal: P,
    primalSigns: norm.signs,
    offsets: norm.offsets,
    addedRows: norm.addedRows,
    dual,
    dualSigns,
    correspondence,
    notes,
    displayText,
    matrixPrimal: matrixFormOf(P, norm.signs),
    matrixDual: matrixFormOf(dual, dualSigns),
  };
}

/* ------------------------------------------------------------------ */
/* Evaluation helpers (exact)                                          */
/* ------------------------------------------------------------------ */

export function lhsOf(coeffs: Rational[], x: Rational[]): Rational {
  let s = zeroQ;
  for (let j = 0; j < x.length; j++) s = s.add((coeffs[j] ?? zeroQ).mul(x[j]!));
  return s;
}
export function objectiveAt(model: LPModel, x: Rational[]): Rational {
  return lhsOf(model.objective, x).add(model.objectiveConstant ?? zeroQ);
}
export function isFeasiblePoint(model: LPModel, x: Rational[]): boolean {
  for (let j = 0; j < x.length; j++) {
    const { lower, upper } = boundsOf(model, j);
    if (lower !== null && x[j]!.lt(lower)) return false;
    if (upper !== null && x[j]!.gt(upper)) return false;
  }
  for (const c of model.constraints) {
    const l = lhsOf(c.coeffs, x);
    if (c.relation === '<=' && l.gt(c.rhs)) return false;
    if (c.relation === '>=' && l.lt(c.rhs)) return false;
    if (c.relation === '=' && !l.eq(c.rhs)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

export type PairStatus = 'optimal' | 'infeasible' | 'unbounded' | 'unknown';

export interface DualityCheck {
  id: string;
  label: string;
  /** null = not applicable */
  holds: boolean | null;
  detail: string;
}

export interface CsRow {
  kind: 'constraint' | 'variable';
  label: string;
  /** primal slack (constraint rows) or dual-constraint slack = reduced cost (variable rows) */
  left: Rational;
  /** dual variable (constraint rows) or primal variable (variable rows) */
  right: Rational;
  leftName: string;
  rightName: string;
  holds: boolean;
}

export interface ShadowNote { name: string; y: Rational; text: string }

export interface DualityReport {
  ok: true;
  build: DualBuild;
  primalStatus: PairStatus;
  dualStatus: PairStatus;
  primalValue: Rational | null;
  dualValue: Rational | null;
  /** Primal solution in the original variables. */
  x: Rational[] | null;
  /** Dual optimum (the y that solves the dual problem itself). */
  y: Rational[] | null;
  /** Shadow prices read from the final primal tableau (dualValues). */
  tableauDuals: Rational[] | null;
  tableauDualsOptimal: boolean | null;
  tableauDualsEqualDualOptimum: boolean | null;
  checks: DualityCheck[];
  cs: CsRow[];
  pairing: { primal: PairStatus; dual: PairStatus; consistent: boolean; text: string };
  shadow: ShadowNote[];
  /** True when every applicable check holds. */
  allHold: boolean;
}

function statusOf(s: string): PairStatus {
  if (s === 'optimal' || s === 'optimal-alternate-exists') return 'optimal';
  if (s === 'infeasible') return 'infeasible';
  if (s === 'unbounded' || s === 'unbounded-objective') return 'unbounded';
  return 'unknown';
}
const statusWord = (s: PairStatus) => (s === 'optimal' ? 'has an optimum' : s === 'infeasible' ? 'is infeasible' : s === 'unbounded' ? 'is unbounded' : 'could not be decided');

export function pairingText(p: PairStatus, d: PairStatus): { consistent: boolean; text: string } {
  const head = `Primal ${statusWord(p)}; dual ${statusWord(d)}.`;
  if (p === 'unknown' || d === 'unknown') return { consistent: true, text: `${head} At least one problem hit the solver's iteration limit, so the pairing cannot be confirmed.` };
  if (p === 'optimal') {
    return d === 'optimal'
      ? { consistent: true, text: `${head} Both are feasible and bounded, as the fundamental duality theorem requires: the optimal values are equal.` }
      : { consistent: false, text: `${head} This contradicts the duality theorem: an optimal primal always has an optimal dual.` };
  }
  if (p === 'unbounded') {
    return d === 'infeasible'
      ? { consistent: true, text: `${head} An unbounded primal has no feasible dual: if a dual feasible point existed, weak duality would bound the primal objective.` }
      : { consistent: false, text: `${head} An unbounded primal must have an infeasible dual.` };
  }
  // primal infeasible
  return d === 'infeasible' || d === 'unbounded'
    ? { consistent: true, text: `${head} If the primal is infeasible, the dual is either infeasible or unbounded (it cannot have an optimum, because an optimal dual would give an optimal primal).` }
    : { consistent: false, text: `${head} An infeasible primal cannot have an optimal dual.` };
}

function dec(v: Rational): string {
  return v.isInteger() ? v.toString() : `${v.toString()} (≈ ${v.toDecimal(3)})`;
}

export function dualityReport(model: LPModel): DualityReport | DualFailure {
  const build = buildDual(model);
  if (!build.ok) return build;
  const P = build.primal;
  const D = build.dual;
  const ps = solveLP(P, { method: 'auto', emitSteps: false });
  const ds = solveLP(D, { method: 'auto', emitSteps: false });
  const primalStatus = statusOf(ps.status);
  const dualStatus = statusOf(ds.status);
  const xN = primalStatus === 'optimal' && ps.result ? ps.result.variableValues : null;
  const y = dualStatus === 'optimal' && ds.result ? ds.result.variableValues : null;
  const pv = xN && ps.result ? ps.result.objectiveValue : null;
  const dv = y && ds.result ? ds.result.objectiveValue : null;

  const checks: DualityCheck[] = [];
  const pairing = (() => { const t = pairingText(primalStatus, dualStatus); return { primal: primalStatus, dual: dualStatus, ...t }; })();
  checks.push({ id: 'pairing', label: 'Primal / dual outcomes are a legal pair', holds: pairing.consistent, detail: pairing.text });

  const cs: CsRow[] = [];
  let tableauDuals: Rational[] | null = null;
  let tableauDualsOptimal: boolean | null = null;
  let tableauDualsEqual: boolean | null = null;

  if (xN && y && pv && dv) {
    checks.push({ id: 'primal-feasible', label: 'x* is feasible for the primal', holds: isFeasiblePoint(P, xN), detail: 'Every constraint and sign restriction is checked exactly.' });
    checks.push({ id: 'dual-feasible', label: 'y* is feasible for the dual', holds: isFeasiblePoint(D, y), detail: 'Every dual constraint and sign restriction is checked exactly.' });
    checks.push({ id: 'strong', label: 'Strong duality: optimal values are equal', holds: pv.eq(dv), detail: `primal z* = ${pv.toString()}, dual w* = ${dv.toString()}.` });
    const wk = P.sense === 'max' ? pv.lte(dv) : pv.gte(dv);
    checks.push({ id: 'weak', label: `Weak duality: ${P.sense === 'max' ? 'primal ≤ dual' : 'primal ≥ dual'} at the optimum`, holds: wk, detail: `${pv.toString()} ${P.sense === 'max' ? '≤' : '≥'} ${dv.toString()}. For any feasible pair the primal value never passes the dual value; here they meet.` });

    // complementary slackness
    P.constraints.forEach((c, i) => {
      const resid = c.rhs.sub(lhsOf(c.coeffs, xN)); // b − a·x
      const slack = c.relation === '<=' ? resid : c.relation === '>=' ? resid.neg() : resid.abs();
      cs.push({ kind: 'constraint', label: c.name?.trim() || `constraint ${i + 1}`, left: slack, right: y[i]!, leftName: 'slack', rightName: D.varNames[i]!, holds: slack.mul(y[i]!).isZero() });
    });
    D.constraints.forEach((c, j) => {
      const resid = lhsOf(c.coeffs, y).sub(c.rhs);
      const slack = c.relation === '>=' ? resid : c.relation === '<=' ? resid.neg() : resid.abs();
      cs.push({ kind: 'variable', label: P.varNames[j]!, left: slack, right: xN[j]!, leftName: 'reduced cost', rightName: P.varNames[j]!, holds: slack.mul(xN[j]!).isZero() });
    });
    const csOk = cs.every(r => r.holds);
    checks.push({ id: 'cs', label: 'Complementary slackness: slack × dual variable = 0 and reduced cost × variable = 0 (all pairs)', holds: csOk, detail: csOk ? 'Each product in the table below is exactly zero.' : 'At least one product is non-zero — see the table.' });

    // dual values from the primal tableau
    tableauDuals = ps.result ? ps.result.dualValues : null;
    if (tableauDuals && tableauDuals.length === D.varNames.length) {
      const feas = isFeasiblePoint(D, tableauDuals);
      const val = objectiveAt(D, tableauDuals);
      tableauDualsOptimal = feas && val.eq(dv);
      tableauDualsEqual = tableauDuals.every((v, i) => v.eq(y[i]!));
      checks.push({
        id: 'tableau-duals',
        label: 'Shadow prices read from the final primal tableau solve the dual',
        holds: tableauDualsOptimal,
        detail: tableauDualsEqual ? 'They coincide exactly with the optimum found by solving the dual problem itself.' : tableauDualsOptimal ? 'They are a different but equally optimal dual solution (the dual has alternate optima, which happens when the primal is degenerate).' : 'They do not form an optimal dual solution.',
      });
    }
  } else if (primalStatus === 'unbounded') {
    checks.push({ id: 'unb', label: 'Primal unbounded ⇒ dual infeasible', holds: dualStatus === 'infeasible', detail: 'No dual point can bound the primal objective, so the dual has no feasible point.' });
  } else if (dualStatus === 'unbounded') {
    checks.push({ id: 'unb', label: 'Dual unbounded ⇒ primal infeasible', holds: primalStatus === 'infeasible', detail: 'The dual objective runs off to infinity, so the primal has no feasible point.' });
  } else if (primalStatus === 'infeasible') {
    checks.push({ id: 'inf', label: 'Primal infeasible ⇒ dual infeasible or unbounded', holds: dualStatus !== 'optimal', detail: 'The dual cannot have an optimum.' });
  }

  // outputs in original variable space
  const x = xN ? xN.map((v, j) => v.add(build.offsets[j]!)) : null;

  const shadow: ShadowNote[] = [];
  if (y) {
    y.forEach((v, i) => {
      const nm = P.constraints[i]?.name?.trim() || `constraint ${i + 1}`;
      const added = build.addedRows.includes(i);
      let text: string;
      if (v.isZero()) text = `${nm}: shadow price 0. This restriction is not limiting the optimum, so loosening it by one unit changes nothing.`;
      else {
        const dir = v.isPositive() ? 'increases' : 'decreases';
        text = `${nm}: shadow price ${dec(v)}. Raising its right-hand side by one unit ${dir} the optimal ${P.sense === 'max' ? 'profit' : 'cost'} z by ${dec(v.abs())}, for as long as the optimal basis stays the same (the Sensitivity tab gives the range).`;
      }
      if (added) text += ' (This row comes from a variable bound.)';
      shadow.push({ name: nm, y: v, text });
    });
  }

  const allHold = checks.every(c => c.holds !== false);
  return {
    ok: true, build, primalStatus, dualStatus, primalValue: pv, dualValue: dv, x, y, tableauDuals,
    tableauDualsOptimal, tableauDualsEqualDualOptimum: tableauDualsEqual, checks, cs, pairing, shadow, allHold,
  };
}
