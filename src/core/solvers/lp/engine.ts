/**
 * Unified exact simplex engine (spec §9.2).
 *
 * One pivoting core, four user-visible methods:
 *   standard  – slack basis, requires all rows ≤ with RHS ≥ 0
 *   twoPhase  – Phase I (min Σ artificials) then Phase II
 *   bigM      – artificials carry a symbolic −M cost (never a numeric M)
 *   dual      – dual simplex from a dual-feasible, primal-infeasible slack basis
 *
 * Everything is exact `Rational` arithmetic; the objective row is an `MNum` (a + bM).
 * Anti-cycling: lexicographic ratio tie-breaking always, plus a sticky switch to Bland's rule
 * when a basis repeats (reported as a diagnostic).
 */

import { Rational } from '../../math/rational';
import { MNum } from '../../math/bigm';
import { LPModel, Tableau, NextPivot } from '../../types/models';
import { Diagnostic, Solution, SolveOptions, ValidationResult, TerminationStatus } from '../../types/solver';
import { Step, Highlight, StepStatus } from '../../types/step';
import { genName, joinList } from '../../format';
import {
  buildStandardForm,
  flipNegativeRhs,
  recoverVariables,
  StandardForm,
  NormalizedRow,
} from './standardForm';

export type LPMethod = 'auto' | 'standard' | 'twoPhase' | 'bigM' | 'dual';
type ConcreteMethod = Exclude<LPMethod, 'auto'>;
type ColType = 'decision' | 'slack' | 'surplus' | 'artificial';

export interface LPSolveOptions extends SolveOptions {
  method?: LPMethod;
}

export interface LPInternals {
  sf: StandardForm;
  rows: NormalizedRow[];
  /** Final basis as indices into the engine's FULL column list. */
  basisFull: number[];
  /** Final tableau body A (m × n, all columns incl. hidden artificials). */
  A: Rational[][];
  b: Rational[];
  /** Final reduced-cost row (z_j − c_j), a-parts. */
  d: Rational[];
  idCols: number[];
  colNames: string[];
  colTypes: ColType[];
  /** Which structural/slack/… columns are visible in the final tableau (full-index). */
  method: ConcreteMethod;
  /** Per engine row: which original constraint it came from, and the sign applied. */
  rowMeta: { origIndex: number | null; sigma: 1 | -1; label: string }[];
}

export interface LPResult {
  status: string;
  variableValues: Rational[];
  objectiveValue: Rational;
  slackValues: Rational[];
  dualValues: Rational[];
  basis: number[];
  alternateOptimum?: { variableValues: Rational[]; unboundedFace?: boolean };
  varNames: string[];
  unboundedRay?: { direction: Rational[]; enteringVar: string };
  infeasibility?: {
    constraints: { index: number | null; label: string; multiplier: Rational }[];
    violation: Rational;
  };
  redundantConstraints?: number[];
  degenerate?: boolean;
  internals?: LPInternals;
}

export interface LPSolution extends Solution<Tableau, LPResult> {
  methodRequested: LPMethod;
  methodUsed: ConcreteMethod;
  redirected: boolean;
  redirectReason?: string;
  standardForm: StandardForm | null;
}

/* ------------------------------------------------------------------ */
/* Work state                                                          */
/* ------------------------------------------------------------------ */

interface Work {
  m: number;
  n: number;
  A: Rational[][];
  b: Rational[];
  d: MNum[];
  z: MNum;
  basis: number[];
  names: string[];
  types: ColType[];
  idCols: number[];
  allowEnter: boolean[];
  visible: boolean[];
}

function pivotWork(w: Work, r: number, c: number): void {
  const piv = w.A[r]![c]!;
  const inv = piv.inv();
  const rowR = w.A[r]!;
  for (let j = 0; j < w.n; j++) rowR[j] = rowR[j]!.mul(inv);
  w.b[r] = w.b[r]!.mul(inv);
  for (let i = 0; i < w.m; i++) {
    if (i === r) continue;
    const f = w.A[i]![c]!;
    if (f.isZero()) continue;
    const rowI = w.A[i]!;
    for (let j = 0; j < w.n; j++) {
      const v = rowR[j]!;
      if (!v.isZero()) rowI[j] = rowI[j]!.sub(f.mul(v));
    }
    w.b[i] = w.b[i]!.sub(f.mul(w.b[r]!));
  }
  const dc = w.d[c]!;
  if (!dc.isZero()) {
    for (let j = 0; j < w.n; j++) {
      const v = rowR[j]!;
      if (!v.isZero()) w.d[j] = w.d[j]!.sub(dc.scale(v));
    }
    w.z = w.z.sub(dc.scale(w.b[r]!));
  }
  w.basis[r] = c;
}

function maxMagnitude(w: Work): bigint {
  let mx = 0n;
  for (const row of w.A) for (const v of row) { const g = v.magnitude(); if (g > mx) mx = g; }
  for (const v of w.b) { const g = v.magnitude(); if (g > mx) mx = g; }
  return mx;
}

type Decision =
  | { kind: 'optimal' }
  | { kind: 'unbounded'; col: number }
  | { kind: 'infeasible-row'; row: number }
  | {
      kind: 'pivot';
      col: number;
      row: number;
      ratios: (Rational | null)[];
      colRatios?: (Rational | null)[];
      tiedRows: number[];
      tiedCols: number[];
      enterValue: MNum;
      rule: string;
      tieBrokenBy?: 'lexicographic' | 'bland' | 'index';
    };

/** Primal simplex decision: entering column (Dantzig / Bland) then ratio test (lexicographic tie-break). */
function decidePrimal(w: Work, bland: boolean): Decision {
  let col = -1;
  let best = MNum.ZERO;
  let tiedCols: number[] = [];
  for (let j = 0; j < w.n; j++) {
    if (!w.allowEnter[j]) continue;
    const v = w.d[j]!;
    if (!v.isNegative()) continue;
    if (bland) {
      col = j;
      best = v;
      tiedCols = [j];
      break;
    }
    if (col === -1 || v.lt(best)) {
      col = j;
      best = v;
      tiedCols = [j];
    } else if (v.eq(best)) {
      tiedCols.push(j);
    }
  }
  if (col === -1) return { kind: 'optimal' };

  const ratios: (Rational | null)[] = Array(w.m).fill(null);
  let minRatio: Rational | null = null;
  let tiedRows: number[] = [];
  for (let i = 0; i < w.m; i++) {
    const a = w.A[i]![col]!;
    if (!a.isPositive()) continue;
    const ratio = w.b[i]!.div(a);
    ratios[i] = ratio;
    if (minRatio === null || ratio.lt(minRatio)) {
      minRatio = ratio;
      tiedRows = [i];
    } else if (ratio.eq(minRatio)) {
      tiedRows.push(i);
    }
  }
  if (minRatio === null) return { kind: 'unbounded', col };

  let row = tiedRows[0]!;
  let tieBrokenBy: 'lexicographic' | 'bland' | undefined;
  if (tiedRows.length > 1) {
    if (bland) {
      row = tiedRows.reduce((p, q) => (w.basis[q]! < w.basis[p]! ? q : p));
      tieBrokenBy = 'bland';
    } else {
      // Lexicographic rule: compare rows of (identity-columns) / pivot-column entry.
      row = tiedRows.reduce((p, q) => {
        const ap = w.A[p]![col]!;
        const aq = w.A[q]![col]!;
        for (const idc of w.idCols) {
          const vp = w.A[p]![idc]!.div(ap);
          const vq = w.A[q]![idc]!.div(aq);
          const c = vp.cmp(vq);
          if (c < 0) return p;
          if (c > 0) return q;
        }
        return p;
      });
      tieBrokenBy = 'lexicographic';
    }
  }
  return {
    kind: 'pivot',
    col,
    row,
    ratios,
    tiedRows,
    tiedCols,
    enterValue: best,
    rule: bland ? "Bland's rule (lowest-index negative reduced cost)" : "Dantzig's rule (most negative reduced cost)",
    tieBrokenBy,
  };
}

/** Dual simplex decision: leaving row (most negative RHS), entering column by min |z_j / a_rj|. */
function decideDual(w: Work, bland: boolean): Decision {
  let row = -1;
  let worst = Rational.ZERO;
  for (let i = 0; i < w.m; i++) {
    const v = w.b[i]!;
    if (!v.isNegative()) continue;
    if (bland) { row = i; break; }
    if (row === -1 || v.lt(worst)) { row = i; worst = v; }
  }
  if (row === -1) return { kind: 'optimal' };

  const colRatios: (Rational | null)[] = Array(w.n).fill(null);
  let minRatio: Rational | null = null;
  let tiedCols: number[] = [];
  for (let j = 0; j < w.n; j++) {
    if (!w.allowEnter[j]) continue;
    const a = w.A[row]![j]!;
    if (!a.isNegative()) continue;
    const ratio = w.d[j]!.a.abs().div(a.abs());
    colRatios[j] = ratio;
    if (minRatio === null || ratio.lt(minRatio)) {
      minRatio = ratio;
      tiedCols = [j];
    } else if (ratio.eq(minRatio)) {
      tiedCols.push(j);
    }
  }
  if (minRatio === null) return { kind: 'infeasible-row', row };
  return {
    kind: 'pivot',
    col: tiedCols[0]!,
    row,
    ratios: Array(w.m).fill(null),
    colRatios,
    tiedRows: [row],
    tiedCols,
    enterValue: w.d[tiedCols[0]!]!,
    rule: bland
      ? "Bland's rule (lowest-index negative RHS)"
      : 'Dual simplex: most negative RHS leaves, minimum |zⱼ / aᵣⱼ| enters',
    tieBrokenBy: tiedCols.length > 1 ? 'index' : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Snapshots & explanations                                            */
/* ------------------------------------------------------------------ */

interface SnapCfg {
  method: ConcreteMethod | 'gomory';
  phase: 1 | 2 | null;
  sense: 'max' | 'min';
  objConst: Rational; // constant of the ORIGINAL objective (Σ c·offset + k)
  showM: boolean;
  label: string;
}

function visibleCols(w: Work): number[] {
  const cols: number[] = [];
  for (let j = 0; j < w.n; j++) if (w.visible[j] || w.basis.includes(j)) cols.push(j);
  return cols;
}

/** Objective value in the ORIGINAL sense for display (Phase I displays w = Σ artificials ≥ 0). */
function displayObjective(w: Work, cfg: SnapCfg): MNum {
  if (cfg.phase === 1) return w.z.neg();
  const signed = cfg.sense === 'max' ? w.z : w.z.neg();
  return signed.add(MNum.of(cfg.objConst));
}

function snapshot(w: Work, cfg: SnapCfg, decision?: Decision): Tableau {
  const cols = visibleCols(w);
  const idx = new Map<number, number>(cols.map((c, k) => [c, k]));
  const objVal = displayObjective(w, cfg);
  const tab: Tableau = {
    matrix: w.A.map(row => cols.map(c => row[c]!)),
    objectiveRow: cols.map(c => w.d[c]!.a),
    rhs: [...w.b],
    objectiveValue: objVal.a,
    basis: w.basis.map(c => idx.get(c)!),
    columnNames: cols.map(c => w.names[c]!),
    columnTypes: cols.map(c => w.types[c]!),
    phase: cfg.phase,
    objectiveSense: cfg.sense,
    objectiveLabel: cfg.phase === 1 ? 'w' : cfg.sense === 'max' ? 'z' : 'z (shown as max −z)',
    method: cfg.method,
  };
  if (cfg.showM) {
    tab.bigMRow = cols.map(c => w.d[c]!.b);
    tab.objectiveValueM = objVal.b;
  }
  if (decision && decision.kind === 'pivot') {
    const np: NextPivot = {
      enteringCol: idx.get(decision.col)!,
      leavingRow: decision.row,
      ratios: decision.ratios,
      rule: decision.rule,
      tiedRows: decision.tiedRows,
    };
    if (decision.colRatios) np.colRatios = cols.map(c => decision.colRatios![c] ?? null);
    tab.nextPivot = np;
  }
  return tab;
}

function fmtM(v: MNum): string { return v.toString(); }

/* ------------------------------------------------------------------ */
/* Core run loops                                                      */
/* ------------------------------------------------------------------ */

interface Recorder {
  steps: Step<Tableau>[];
  diags: Diagnostic[];
  emit: boolean;
  seen: Set<string>;
}

function addDiag(rec: Recorder, d: Diagnostic): void {
  const key = `${d.code}|${d.message}`;
  if (rec.seen.has(key)) return;
  rec.seen.add(key);
  rec.diags.push(d);
}

function pushStep(
  rec: Recorder,
  w: Work,
  cfg: SnapCfg,
  decision: Decision | undefined,
  phaseLabel: string,
  action: Step<Tableau>['action'],
  explanation: Step<Tableau>['explanation'],
  highlights: Highlight[],
  status: StepStatus
): void {
  if (!rec.emit) return;
  rec.steps.push({
    index: rec.steps.length,
    phase: phaseLabel,
    state: snapshot(w, cfg, decision),
    action,
    explanation,
    highlights,
    status,
  });
}

interface LoopOutcome {
  status: 'optimal' | 'unbounded' | 'infeasible' | 'iteration-limit';
  iterations: number;
  lastDecision?: Decision;
}

function runLoop(
  w: Work,
  cfg: SnapCfg,
  rec: Recorder,
  opts: { dual: boolean; maxIterations: number; phaseLabel: string; iterStart: number; antiCycling?: string; bland0?: boolean }
): LoopOutcome {
  const history = new Set<string>();
  let bland = opts.bland0 === true || opts.antiCycling === 'bland';
  let iter = 0;
  let magWarned = false;
  history.add(w.basis.slice().sort((x, y) => x - y).join(','));

  let decision = opts.dual ? decideDual(w, bland) : decidePrimal(w, bland);

  while (true) {
    if (decision.kind !== 'pivot') {
      return { status: decision.kind === 'optimal' ? 'optimal' : decision.kind === 'unbounded' ? 'unbounded' : 'infeasible', iterations: iter, lastDecision: decision };
    }
    if (iter >= opts.maxIterations) {
      addDiag(rec, {
        severity: 'error',
        code: 'ITERATION_LIMIT',
        message: `Iteration limit (${opts.maxIterations}) reached. The last tableau is shown; optimality is NOT claimed.`,
      });
      return { status: 'iteration-limit', iterations: iter, lastDecision: decision };
    }

    iter++;
    const d = decision;
    const enterName = w.names[d.col]!;
    const leaveName = w.names[w.basis[d.row]!]!;
    const pivotVal = w.A[d.row]![d.col]!;
    const zBefore = displayObjective(w, cfg);
    const bBefore = w.b[d.row]!;

    pivotWork(w, d.row, d.col);

    const zAfter = displayObjective(w, cfg);
    const delta = zAfter.sub(zBefore);
    const degenerate = bBefore.isZero();

    // Cycling detection by hashing the basis set.
    const key = w.basis.slice().sort((x, y) => x - y).join(',');
    let cyclingNote: string | undefined;
    if (history.has(key) && !bland) {
      bland = true;
      cyclingNote = `A basis repeated (cycling detected) — switching permanently to Bland's rule, which guarantees termination.`;
      addDiag(rec, { severity: 'warning', code: 'CYCLING_DETECTED', message: cyclingNote, stepIndex: rec.steps.length });
    }
    history.add(key);

    if (degenerate) {
      addDiag(rec, {
        severity: 'info',
        code: 'DEGENERATE_PIVOT',
        message: 'Degenerate pivot: the leaving variable was already 0, so the objective did not change and the vertex is unchanged. Several bases describe the same vertex.',
        stepIndex: rec.steps.length,
      });
    }
    if (d.tiedRows.length > 1 && !opts.dual) {
      addDiag(rec, {
        severity: 'info',
        code: 'RATIO_TIE',
        message: `Tie in the minimum-ratio test between ${joinList(d.tiedRows.map(r => w.names[w.basis[r]!] ?? '?'))}; resolved by the ${d.tieBrokenBy === 'bland' ? "Bland" : 'lexicographic'} rule. Tied rows produce a degenerate next basis.`,
        stepIndex: rec.steps.length,
      });
    }

    const mag = maxMagnitude(w);
    if (!magWarned && mag > 10n ** 30n) {
      magWarned = true;
      addDiag(rec, {
        severity: 'warning',
        code: 'NUMERICAL_LIMIT',
        message: 'Rational numerators/denominators exceeded 10³⁰. Results remain exact but the problem is numerically heavy.',
      });
    }

    // Next decision (also serves as the display overlay of the new tableau).
    const next = opts.dual ? decideDual(w, bland) : decidePrimal(w, bland);

    // Build final prose now (using stored decision data).
    const prose = buildPivotProse(w, cfg, d, opts.dual, {
      enterName,
      leaveName,
      pivotVal,
      zBefore,
      zAfter,
      delta,
      bBefore,
      bland,
      degenerate,
      cyclingNote,
    });

    const hl: Highlight[] = [
      { target: `cell:${d.row},${nextIdx(w, cfg, d.col)}`, intent: 'pivot' },
      { target: `row:${d.row}`, intent: 'changed' },
    ];

    pushStep(
      rec,
      w,
      cfg,
      next,
      opts.phaseLabel,
      { kind: 'pivot', payload: { entering: enterName, leaving: leaveName, pivot: pivotVal.toString(), ratios: d.ratios.map(r => r?.toString() ?? null) } },
      {
        short: prose.short,
        detailed: prose.detailed,
        formula: `\\text{pivot} = ${pivotVal.toLatex()},\\quad ${cfg.phase === 1 ? 'w' : 'z'}: ${zBefore.toLatex()} \\to ${zAfter.toLatex()}`,
        rule: d.rule,
        note: prose.note,
      },
      hl,
      'continue'
    );

    decision = next;
  }
}

function nextIdx(w: Work, _cfg: SnapCfg, col: number): number {
  const cols = visibleCols(w);
  return cols.indexOf(col);
}

interface ProseCtx {
  enterName: string;
  leaveName: string;
  pivotVal: Rational;
  zBefore: MNum;
  zAfter: MNum;
  delta: MNum;
  bBefore: Rational;
  bland: boolean;
  degenerate: boolean;
  cyclingNote?: string;
}

/**
 * NOTE: ratio and reduced-cost numbers are taken from the decision object `d`, captured BEFORE
 * the pivot overwrote the tableau.
 */
function buildPivotProse(
  w: Work,
  cfg: SnapCfg,
  d: Extract<Decision, { kind: 'pivot' }>,
  dual: boolean,
  c: ProseCtx
): { short: string; detailed: string; note?: string } {
  const objName = cfg.phase === 1 ? 'w' : 'z';
  const notes: string[] = [];
  if (c.degenerate) notes.push('Degenerate pivot: the leaving row had value 0, so the objective did not change. Multiple bases describe the same vertex.');
  if (d.tiedRows.length > 1 && !dual) notes.push(`Tie in the minimum-ratio test between ${d.tiedRows.length} rows; resolved lexicographically — expect a degenerate vertex next.`);
  if (d.tiedCols.length > 1 && !dual) notes.push(`Tie for the entering variable among ${joinList(d.tiedCols.map(k => w.names[k]!))}; the lowest column index was chosen.`);
  if (c.cyclingNote) notes.push(c.cyclingNote);
  if (cfg.sense === 'min' && cfg.phase !== 1) notes.push('The z-row is held in maximisation form (it represents −z), so "negative reduced cost" means "improves the objective".');

  if (dual) {
    return {
      short: `${c.leaveName} leaves (RHS ${c.bBefore.toString()} < 0), ${c.enterName} enters. Pivot element = ${c.pivotVal.toString()}.`,
      detailed:
        `The basic solution is infeasible: ${c.leaveName} = ${c.bBefore.toString()} < 0 is the most negative right-hand side, so its row leaves the basis. ` +
        `Only non-basic columns with a negative entry in that row can enter (otherwise the problem is infeasible). ` +
        `The dual ratio test min |zⱼ ÷ aᵣⱼ| selects ${c.enterName}` +
        (d.tiedCols.length > 1 ? ` (tied with ${joinList(d.tiedCols.filter(k => w.names[k] !== c.enterName).map(k => w.names[k]!))}; lowest index wins)` : '') +
        `. Pivot element = ${c.pivotVal.toString()}. ${objName} changes from ${fmtM(c.zBefore)} to ${fmtM(c.zAfter)} (Δ = ${fmtM(c.delta)}), keeping the z-row non-negative (dual feasibility).`,
      note: notes.length ? notes.join(' ') : undefined,
    };
  }

  const ratioParts: string[] = [];
  for (let i = 0; i < d.ratios.length; i++) {
    const r = d.ratios[i];
    ratioParts.push(r ? `row ${i + 1}: ${r.toString()}` : `row ${i + 1}: —`);
  }
  const minR = d.ratios[d.row]!;
  return {
    short: `${c.enterName} enters, ${c.leaveName} leaves. Pivot element = ${c.pivotVal.toString()}.`,
    detailed:
      `${c.enterName} enters because its reduced cost ${fmtM(d.enterValue)} is ` +
      `${c.bland ? 'the first negative entry in the z-row (Bland)' : 'the most negative entry in the z-row'}, so increasing it improves ${objName} at the fastest rate. ` +
      `Ratio test (right-hand side ÷ positive entries of the ${c.enterName} column): ${ratioParts.join(', ')}. ` +
      `The minimum ratio is ${minR.toString()}, in the row of ${c.leaveName}, so ${c.leaveName} leaves — any larger step would make it negative. ` +
      `Pivot element = ${c.pivotVal.toString()}. ${objName} changes from ${fmtM(c.zBefore)} to ${fmtM(c.zAfter)} (Δ = ${fmtM(c.delta)}).`,
    note: notes.length ? notes.join(' ') : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Work construction                                                   */
/* ------------------------------------------------------------------ */

function emptyWork(m: number, n: number): Work {
  return {
    m,
    n,
    A: Array.from({ length: m }, () => Array.from({ length: n }, () => Rational.ZERO)),
    b: Array.from({ length: m }, () => Rational.ZERO),
    d: Array.from({ length: n }, () => MNum.ZERO),
    z: MNum.ZERO,
    basis: Array(m).fill(-1),
    names: Array(n).fill(''),
    types: Array(n).fill('decision' as ColType),
    idCols: Array(m).fill(-1),
    allowEnter: Array(n).fill(true),
    visible: Array(n).fill(true),
  };
}

function buildPrimalWork(sf: StandardForm, rows: NormalizedRow[], method: 'standard' | 'twoPhase' | 'bigM'): Work {
  const m = rows.length;
  const ny = sf.yNames.length;
  let extra = 0;
  for (const r of rows) extra += method === 'standard' ? 1 : r.relation === '<=' ? 1 : r.relation === '>=' ? 2 : 1;
  const w = emptyWork(m, ny + extra);

  for (let j = 0; j < ny; j++) {
    w.names[j] = sf.yNames[j]!;
    w.types[j] = 'decision';
  }
  let col = ny;
  rows.forEach((r, i) => {
    for (let j = 0; j < ny; j++) w.A[i]![j] = r.coeffs[j]!;
    w.b[i] = r.rhs;
    if (r.relation === '<=') {
      w.A[i]![col] = Rational.ONE;
      w.names[col] = genName('s', i + 1);
      w.types[col] = 'slack';
      w.basis[i] = col;
      w.idCols[i] = col;
      col++;
    } else if (r.relation === '>=') {
      w.A[i]![col] = Rational.MINUS_ONE;
      w.names[col] = genName('e', i + 1);
      w.types[col] = 'surplus';
      col++;
      w.A[i]![col] = Rational.ONE;
      w.names[col] = genName('a', i + 1);
      w.types[col] = 'artificial';
      w.basis[i] = col;
      w.idCols[i] = col;
      col++;
    } else {
      w.A[i]![col] = Rational.ONE;
      w.names[col] = genName('a', i + 1);
      w.types[col] = 'artificial';
      w.basis[i] = col;
      w.idCols[i] = col;
      col++;
    }
  });
  w.allowEnter = w.types.map(t => t !== 'artificial');
  return w;
}

/** Set d to the true objective (max form) and canonicalise against the current basis. */
function setObjective(w: Work, sf: StandardForm, bigM: boolean): void {
  for (let j = 0; j < w.n; j++) {
    if (j < sf.yNames.length) w.d[j] = MNum.of(sf.costMax[j]!.neg());
    else if (bigM && w.types[j] === 'artificial') w.d[j] = MNum.M;
    else w.d[j] = MNum.ZERO;
  }
  w.z = MNum.ZERO;
  canonicalize(w);
}

function canonicalize(w: Work): void {
  for (let i = 0; i < w.m; i++) {
    const f = w.d[w.basis[i]!]!;
    if (f.isZero()) continue;
    for (let j = 0; j < w.n; j++) {
      const v = w.A[i]![j]!;
      if (!v.isZero()) w.d[j] = w.d[j]!.sub(f.scale(v));
    }
    w.z = w.z.sub(f.scale(w.b[i]!));
  }
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function validateLP(model: LPModel): ValidationResult {
  const errors: { field?: string; message: string }[] = [];
  const n = model.objective?.length ?? 0;
  if (n === 0) errors.push({ field: 'objective', message: 'The objective function must contain at least one variable.' });
  (model.constraints ?? []).forEach((c, i) => {
    if (c.coeffs.length !== n) {
      errors.push({
        field: `constraints[${i}]`,
        message: `Constraint ${i + 1} has ${c.coeffs.length} coefficients but the objective has ${n} variables.`,
      });
    }
  });
  return { valid: errors.length === 0, errors };
}

function invalidSolution(v: ValidationResult, requested: LPMethod): LPSolution {
  return {
    steps: [],
    result: null,
    status: 'invalid-input',
    diagnostics: v.errors.map(e => ({ severity: 'error' as const, code: 'INVALID_MODEL', message: e.message })),
    metrics: { iterations: 0, elapsedMs: 0, degradedToFloat: false },
    methodRequested: requested,
    methodUsed: 'twoPhase',
    redirected: false,
    standardForm: null,
  };
}

export function solveLP(model: LPModel, options: LPSolveOptions = {}): LPSolution {
  const t0 = performance.now();
  const requested: LPMethod = options.method ?? 'auto';
  const v = validateLP(model);
  if (!v.valid) return invalidSolution(v, requested);

  const maxIterations = options.maxIterations ?? 1000;
  const emit = options.emitSteps !== false;
  const sf = buildStandardForm(model);
  const rec: Recorder = { steps: [], diags: [], emit, seen: new Set() };

  // ---- choose method -------------------------------------------------
  const allLeq = sf.rows.every(r => r.relation === '<=');
  const anyNegRhs = sf.rows.some(r => r.rhs.isNegative());
  let method: ConcreteMethod;
  let redirected = false;
  let redirectReason: string | undefined;

  const dualFeasible = sf.costMax.every(c => !c.isPositive());
  if (requested === 'auto') {
    method = allLeq && !anyNegRhs ? 'standard' : 'twoPhase';
  } else if (requested === 'standard') {
    if (allLeq && !anyNegRhs) method = 'standard';
    else {
      method = 'twoPhase';
      redirected = true;
      redirectReason = !allLeq
        ? 'The model has ≥ or = constraints, which have no slack variable to start from; artificial variables are required.'
        : 'A constraint has a negative right-hand side, so after normalisation it becomes ≥ and needs an artificial variable.';
    }
  } else if (requested === 'dual') {
    if (dualFeasible) method = 'dual';
    else {
      method = 'twoPhase';
      redirected = true;
      redirectReason =
        'Dual simplex needs a dual-feasible start (every objective coefficient ≤ 0 in maximisation form, i.e. min with c ≥ 0). This objective is not, so Two-Phase was used instead.';
    }
  } else {
    method = requested;
  }
  if (redirected) {
    addDiag(rec, { severity: 'info', code: 'AUTO_REDIRECT', message: `Method changed to ${methodTitle(method)}: ${redirectReason}` });
  }

  const sol = method === 'dual'
    ? runDual(model, sf, rec, maxIterations, options)
    : runPrimal(model, sf, rec, method, maxIterations, options);

  const t1 = performance.now();
  return {
    ...sol,
    metrics: { ...sol.metrics, elapsedMs: Math.round((t1 - t0) * 100) / 100 },
    methodRequested: requested,
    methodUsed: method,
    redirected,
    redirectReason,
    standardForm: sf,
  } as LPSolution;
}

export function methodTitle(m: ConcreteMethod): string {
  return m === 'standard' ? 'Standard Simplex' : m === 'twoPhase' ? 'Two-Phase Simplex' : m === 'bigM' ? 'Big-M Simplex' : 'Dual Simplex';
}

type Core = Omit<LPSolution, 'methodRequested' | 'methodUsed' | 'redirected' | 'redirectReason' | 'standardForm'>;

function intro(sf: StandardForm, rowNotes: string[], method: ConcreteMethod): string {
  const parts = [...sf.notes, ...rowNotes];
  void method;
  return parts.length ? ` Normalisation: ${parts.join(' ')}` : '';
}

function runPrimal(
  model: LPModel,
  sf: StandardForm,
  rec: Recorder,
  method: 'standard' | 'twoPhase' | 'bigM',
  maxIterations: number,
  options: LPSolveOptions
): Core {
  const { rows, notes: flipNotes } = flipNegativeRhs(sf.rows);
  const w = buildPrimalWork(sf, rows, method);
  const sense = sf.isMax ? 'max' : 'min';
  const artificialCols = w.types.map((t, j) => (t === 'artificial' ? j : -1)).filter(j => j >= 0);
  const hasArtificial = artificialCols.length > 0;
  let iterations = 0;
  const redundant: number[] = [];

  const baseCfg: SnapCfg = {
    method,
    phase: null,
    sense,
    objConst: sf.objConstOrig,
    showM: method === 'bigM',
    label: 'z',
  };

  const constructionText = (() => {
    const cols = (t: ColType) => w.names.filter((_, j) => w.types[j] === t);
    const bits: string[] = [];
    if (cols('slack').length) bits.push(`slack variables ${joinList(cols('slack'))}`);
    if (cols('surplus').length) bits.push(`surplus variables ${joinList(cols('surplus'))}`);
    if (cols('artificial').length) bits.push(`artificial variables ${joinList(cols('artificial'))}`);
    return bits.join(', ');
  })();

  /* ---------- Standard simplex (no artificials) ---------- */
  if (!hasArtificial) {
    setObjective(w, sf, false);
    // Zero objective ⇒ feasibility problem.
    if (sf.costMax.every(c => c.isZero())) {
      addDiag(rec, { severity: 'info', code: 'ZERO_OBJECTIVE', message: 'All objective coefficients are zero: this is a pure feasibility problem; any feasible point is optimal.' });
    }
    const cfg = { ...baseCfg, method: method === 'bigM' ? 'bigM' : 'standard' } as SnapCfg;
    const d0 = decidePrimal(w, options.antiCycling === 'bland');
    pushStep(
      rec, w, cfg, d0, 'Initialization', null,
      {
        short: 'Initial tableau built from the slack basis.',
        detailed:
          `Each constraint gets ${constructionText}; the slacks form the starting basis, which is feasible because every right-hand side is ≥ 0, giving the origin x = 0 with ${sf.isMax ? 'z' : 'z'} = ${sf.objConstOrig.toString()}.` +
          intro(sf, flipNotes, method),
        rule: 'Standard simplex initialisation',
        note: sense === 'min' ? 'Minimisation is solved as maximisation of −z; the z-row is therefore the max-form row.' : undefined,
      },
      w.basis.map((b, i) => ({ target: `cell:${i},${visibleCols(w).indexOf(b)}`, intent: 'optimal' as const })),
      'initial'
    );
    const out = runLoop(w, cfg, rec, { dual: false, maxIterations, phaseLabel: 'Simplex iteration', iterStart: 0, antiCycling: options.antiCycling });
    iterations += out.iterations;
    return finishPrimal(model, sf, rows, w, cfg, rec, out, method, iterations, redundant, null);
  }

  /* ---------- Big-M ---------- */
  if (method === 'bigM') {
    setObjective(w, sf, true);
    const cfg: SnapCfg = { ...baseCfg, phase: null };
    const d0 = decidePrimal(w, options.antiCycling === 'bland');
    pushStep(
      rec, w, cfg, d0, 'Initialization', null,
      {
        short: 'Big-M tableau built; artificial variables carry cost −M.',
        detailed:
          `Added ${constructionText}. Each artificial variable gets objective coefficient −M, where M is a symbolic, arbitrarily large positive constant — it is carried as a separate coefficient, never as a number. ` +
          `The artificial variables form the starting basis, so the z-row is canonicalised by eliminating M from the basic columns.` + intro(sf, flipNotes, method),
        rule: 'Big-M initialisation',
        formula: `z\\text{-row entries have the form } \\alpha M + \\beta`,
      },
      w.basis.map((b, i) => ({ target: `cell:${i},${visibleCols(w).indexOf(b)}`, intent: 'optimal' as const })),
      'initial'
    );
    const out = runLoop(w, cfg, rec, { dual: false, maxIterations, phaseLabel: 'Big-M iteration', iterStart: 0, antiCycling: options.antiCycling });
    iterations += out.iterations;
    if (out.status === 'unbounded' && w.basis.some((bc, i) => w.types[bc] === 'artificial' && w.b[i]!.isPositive())) {
      // An unbounded ray with a positive artificial still in the basis is ambiguous (infeasible vs unbounded).
      // Settle it with a silent Phase I run; if the model is feasible, show the Two-Phase derivation instead.
      const probe = runPrimal(model, sf, { steps: [], diags: [], emit: false, seen: new Set() }, 'twoPhase', maxIterations, { ...options, emitSteps: false });
      if (probe.status === 'infeasible') {
        const names = w.basis.map((bc, i) => (w.types[bc] === 'artificial' && w.b[i]!.isPositive() ? rows[i]!.label : null)).filter(Boolean) as string[];
        addDiag(rec, {
          severity: 'error',
          code: 'INFEASIBLE',
          message: `Infeasible: the Big-M iteration found an improving direction, but artificial variable(s) for ${joinList(names)} are still positive, which proves no feasible point exists.`,
          detail: probe.diagnostics.find(dg => dg.code === 'INFEASIBLE')?.detail,
        });
        pushStep(
          rec, w, cfg, undefined, 'Termination', { kind: 'infeasible', payload: {} },
          {
            short: 'Infeasible: artificial variable stays positive.',
            detailed: 'The ratio test found no limit, but an artificial variable (cost −M) is still positive in the basis. Because the original constraints admit no feasible point, the artificial can never be removed; the apparent unboundedness belongs to the penalised model only.',
            rule: 'Big-M infeasibility criterion',
          },
          [],
          'infeasible'
        );
        return { steps: rec.steps, result: null, status: 'infeasible', diagnostics: rec.diags, metrics: { iterations, elapsedMs: 0, maxRationalMagnitude: maxMagnitude(w), degradedToFloat: false } };
      }
      const full = runPrimal(model, sf, { steps: [], diags: [], emit: rec.emit, seen: new Set() }, 'twoPhase', maxIterations, options);
      full.diagnostics.unshift({ severity: 'info', code: 'BIGM_FALLBACK', message: 'Big-M reached an ambiguous unbounded direction with an artificial variable still positive; the Two-Phase derivation is shown instead.' });
      return full;
    }
    if (out.status === 'optimal' && w.basis.some(bc => w.types[bc] === 'artificial') && !w.basis.some((bc, i) => w.types[bc] === 'artificial' && w.b[i]!.isPositive())) {
      // Optimal, but an artificial is still basic at value 0 (degenerate). Its row would corrupt the shadow prices and
      // the ranging, so exchange it for a real column (or flag the row redundant) and re-confirm optimality.
      driveOutArtificials(w, rows, rec, redundant, cfg, 'Big-M – clean-up');
      for (let j = 0; j < w.n; j++) if (w.types[j] === 'artificial') { w.allowEnter[j] = false; w.visible[j] = false; }
      setObjective(w, sf, false);
      const outB = runLoop(w, cfg, rec, { dual: false, maxIterations: maxIterations - iterations, phaseLabel: 'Big-M iteration', iterStart: iterations, antiCycling: options.antiCycling });
      iterations += outB.iterations;
      return finishPrimal(model, sf, rows, w, cfg, rec, outB, method, iterations, redundant, null);
    }
    return finishPrimal(model, sf, rows, w, cfg, rec, out, method, iterations, redundant, null);
  }

  /* ---------- Two-Phase ---------- */
  // Phase I objective: max −Σ a  (d_art = 1)
  for (let j = 0; j < w.n; j++) w.d[j] = w.types[j] === 'artificial' ? MNum.of(1) : MNum.ZERO;
  w.z = MNum.ZERO;
  canonicalize(w);
  const cfg1: SnapCfg = { ...baseCfg, phase: 1, label: 'w' };
  const d0 = decidePrimal(w, options.antiCycling === 'bland');
  pushStep(
    rec, w, cfg1, d0, 'Phase I – initialisation', null,
    {
      short: 'Phase I tableau: minimise w = sum of artificial variables.',
      detailed:
        `Added ${constructionText}. Phase I drives all artificial variables to zero: minimise w = ${joinList(artificialCols.map(j => w.names[j]!), 'and').replace(' and ', ' + ')}. ` +
        `If the optimum has w > 0 the original problem is infeasible; otherwise the final basis is a feasible starting vertex for Phase II.` + intro(sf, flipNotes, method),
      rule: 'Phase I construction',
    },
    w.basis.map((b, i) => ({ target: `cell:${i},${visibleCols(w).indexOf(b)}`, intent: 'optimal' as const })),
    'initial'
  );
  const out1 = runLoop(w, cfg1, rec, { dual: false, maxIterations, phaseLabel: 'Phase I iteration', iterStart: 0, antiCycling: options.antiCycling });
  iterations += out1.iterations;

  if (out1.status === 'iteration-limit') {
    return finishPrimal(model, sf, rows, w, cfg1, rec, out1, method, iterations, redundant, null);
  }

  // Phase I optimal: check w
  const wStar = w.z.neg().a; // Σ artificials (≥ 0)
  if (wStar.isPositive()) {
    // Infeasible – build Farkas-type certificate from Phase-I duals.
    const multipliers: { index: number | null; label: string; multiplier: Rational }[] = [];
    rows.forEach((r, i) => {
      const idc = w.idCols[i]!;
      const dv = w.d[idc]!.a;
      const y = w.types[idc] === 'artificial' ? dv.sub(Rational.ONE) : dv;
      const orig = y.mul(Rational.of(r.sigma));
      if (!orig.isZero()) multipliers.push({ index: r.origIndex, label: r.label, multiplier: orig });
    });
    const names = multipliers.map(m => m.label);
    addDiag(rec, {
      severity: 'error',
      code: 'INFEASIBLE',
      message: `Infeasible: Phase I ends with w = ${wStar.toString()} > 0 — the constraints cannot all hold at once.` +
        (names.length ? ` The conflict involves ${joinList(names)}.` : ''),
      detail: certificateText(multipliers),
    });
    pushStep(
      rec, w, cfg1, undefined, 'Phase I – termination', { kind: 'infeasible', payload: { w: wStar.toString() } },
      {
        short: `Infeasible: Phase I optimum w = ${wStar.toString()} > 0.`,
        detailed:
          `No negative reduced cost remains in the w-row, yet the sum of artificial variables is still ${wStar.toString()}. ` +
          `So no point satisfies every constraint simultaneously. ` +
          (names.length ? `Taking the multiples ${multipliers.map(m => `${m.multiplier.toString()}×(${m.label})`).join(' + ')} of the constraints produces a contradiction, so these constraints are mutually conflicting.` : ''),
        rule: 'Phase I infeasibility criterion (w* > 0)',
      },
      [],
      'infeasible'
    );
    return {
      steps: rec.steps,
      result: null,
      status: 'infeasible',
      diagnostics: rec.diags,
      metrics: { iterations, elapsedMs: 0, maxRationalMagnitude: maxMagnitude(w), degradedToFloat: false },
    };
  }

  driveOutArtificials(w, rows, rec, redundant, cfg1, 'Phase I – clean-up');

  // Phase II
  for (let j = 0; j < w.n; j++) {
    if (w.types[j] === 'artificial') { w.allowEnter[j] = false; w.visible[j] = false; }
  }
  setObjective(w, sf, false);
  const cfg2: SnapCfg = { ...baseCfg, phase: 2, label: 'z' };
  if (sf.costMax.every(c => c.isZero())) {
    addDiag(rec, { severity: 'info', code: 'ZERO_OBJECTIVE', message: 'All objective coefficients are zero: this is a pure feasibility problem; the feasible vertex found in Phase I is optimal.' });
  }
  const dp2 = decidePrimal(w, options.antiCycling === 'bland');
  pushStep(
    rec, w, cfg2, dp2, 'Phase II – initialisation', { kind: 'phase-switch', payload: {} },
    {
      short: 'Phase I succeeded (w = 0). Phase II starts with the original objective.',
      detailed:
        'The artificial columns are removed and the original objective row is restored and canonicalised against the feasible basis found in Phase I. ' +
        'From here the ordinary simplex method optimises the true objective.',
      rule: 'Phase II construction',
    },
    [],
    'continue'
  );
  const out2 = runLoop(w, cfg2, rec, { dual: false, maxIterations: maxIterations - iterations, phaseLabel: 'Phase II iteration', iterStart: iterations, antiCycling: options.antiCycling });
  iterations += out2.iterations;
  return finishPrimal(model, sf, rows, w, cfg2, rec, out2, method, iterations, redundant, null);
}

/** Exchange artificial variables left in the basis at value 0 for real columns (or flag the row redundant). */
function driveOutArtificials(w: Work, rows: NormalizedRow[], rec: Recorder, redundant: number[], cfg: SnapCfg, phaseLabel: string): void {
  for (let i = 0; i < w.m; i++) {
    const bc = w.basis[i]!;
    if (w.types[bc] !== 'artificial') continue;
    let pc = -1;
    for (let j = 0; j < w.n; j++) {
      if (w.types[j] === 'artificial') continue;
      if (!w.A[i]![j]!.isZero()) { pc = j; break; }
    }
    if (pc === -1) {
      const orig = rows[i]!.origIndex;
      if (orig !== null && !redundant.includes(orig)) redundant.push(orig);
      addDiag(rec, {
        severity: 'warning',
        code: 'REDUNDANT_CONSTRAINT',
        message: `${rows[i]!.label} is redundant: it is implied by the other constraints (its row is all zeros after Phase I, with ${w.names[bc]} = 0 left in the basis).`,
      });
      continue;
    }
    const outName = w.names[bc]!;
    const inName = w.names[pc]!;
    const pv = w.A[i]![pc]!;
    pivotWork(w, i, pc);
    addDiag(rec, {
      severity: 'info',
      code: 'ARTIFICIAL_DRIVEN_OUT',
      message: `${outName} was in the basis at value 0 after Phase I; pivoted ${inName} in on a non-zero entry to remove it (degenerate pivot).`,
    });
    pushStep(
      rec, w, cfg, undefined, phaseLabel, { kind: 'pivot', payload: { entering: inName, leaving: outName } },
      {
        short: `${outName} (value 0) leaves, ${inName} enters.`,
        detailed: `The artificial ${outName} remained basic at level 0. It is exchanged for ${inName} using the non-zero pivot element ${pv.toString()}; this changes the basis but not the vertex.`,
        rule: 'Drive artificial variables out of the basis',
      },
      [{ target: `row:${i}`, intent: 'changed' }],
      'continue'
    );
  }
}

function finishPrimal(
  model: LPModel,
  sf: StandardForm,
  rows: NormalizedRow[],
  w: Work,
  cfg: SnapCfg,
  rec: Recorder,
  out: LoopOutcome,
  method: ConcreteMethod,
  iterations: number,
  redundant: number[],
  _unused: null
): Core {
  const metrics = { iterations, elapsedMs: 0, maxRationalMagnitude: maxMagnitude(w), degradedToFloat: false };
  const label = cfg.phase === 1 ? 'w' : 'z';
  const idxOf = (c: number) => visibleCols(w).indexOf(c);

  if (out.status === 'iteration-limit') {
    const res = extractResult(model, sf, rows, w, cfg, method, redundant, 'iteration-limit');
    return { steps: rec.steps, result: res, status: 'iteration-limit', diagnostics: rec.diags, metrics };
  }

  if (out.status === 'unbounded') {
    const d = out.lastDecision as Extract<Decision, { kind: 'unbounded' }>;
    const q = d.col;
    const enterName = w.names[q]!;
    const dirY: Rational[] = Array(sf.yNames.length).fill(Rational.ZERO);
    if (q < sf.yNames.length) dirY[q] = Rational.ONE;
    w.basis.forEach((bc, i) => {
      if (bc < sf.yNames.length) dirY[bc] = w.A[i]![q]!.neg();
    });
    const direction = sf.varMaps.map(vm => vm.terms.reduce((acc, t) => acc.add(t.coef.mul(dirY[t.col]!)), Rational.ZERO));
    const moving = direction
      .map((v, j) => (v.isZero() ? null : `${canonName(model, j)} ${v.isPositive() ? '+' : '−'}${v.abs().toString()}`))
      .filter(Boolean) as string[];
    addDiag(rec, {
      severity: 'error',
      code: 'UNBOUNDED',
      message: `Unbounded: ${enterName} can increase forever without violating any constraint, improving ${label} without limit. ` +
        (moving.length ? `Direction of unbounded improvement per unit step: ${moving.join(', ')}. ` : '') +
        'A constraint limiting this direction is missing from the model.',
    });
    pushStep(
      rec, w, cfg, undefined, 'Termination', { kind: 'unbounded', payload: { entering: enterName } },
      {
        short: `Unbounded along ${enterName}.`,
        detailed:
          `${enterName} has a negative reduced cost, but every entry of its column is ≤ 0, so the ratio test has no limit: ${enterName} can grow without bound while all basic variables stay non-negative. ` +
          `The objective is therefore unbounded.`,
        rule: 'Ratio-test failure (no positive entry)',
      },
      [{ target: `col:${idxOf(q)}`, intent: 'blocked' }],
      'unbounded'
    );
    return {
      steps: rec.steps,
      result: { ...extractResult(model, sf, rows, w, cfg, method, redundant, 'unbounded'), unboundedRay: { direction, enteringVar: enterName } },
      status: 'unbounded',
      diagnostics: rec.diags,
      metrics,
    };
  }

  // Optimal
  const res = extractResult(model, sf, rows, w, cfg, method, redundant, 'optimal');
  let status: TerminationStatus = 'optimal';

  if (cfg.phase !== 1 && detectAlternate(model, sf, rows, w, cfg, method, redundant, res, rec)) {
    status = 'optimal-alternate-exists';
  }
  if (res.degenerate) {
    addDiag(rec, { severity: 'info', code: 'DEGENERATE_OPTIMUM', message: 'The optimal basis is degenerate (a basic variable equals 0): several bases describe this vertex.' });
  }
  // Big-M leftover artificial at positive level ⇒ infeasible
  const badArt = w.basis.findIndex((bc, i) => w.types[bc] === 'artificial' && w.b[i]!.isPositive());
  if (badArt >= 0) {
    const names = w.basis.map((bc, i) => (w.types[bc] === 'artificial' && w.b[i]!.isPositive() ? rows[i]!.label : null)).filter(Boolean) as string[];
    addDiag(rec, {
      severity: 'error',
      code: 'INFEASIBLE',
      message: `Infeasible: the Big-M optimum still has artificial variable ${w.names[w.basis[badArt]!]} > 0 (conflict involving ${joinList(names)}).`,
      detail: method === 'bigM'
        ? runPrimal(model, sf, { steps: [], diags: [], emit: false, seen: new Set() }, 'twoPhase', 1000, { emitSteps: false }).diagnostics.find(dg => dg.code === 'INFEASIBLE')?.detail
        : undefined,
    });
    pushStep(
      rec, w, cfg, undefined, 'Termination', { kind: 'infeasible', payload: {} },
      {
        short: 'Infeasible: an artificial variable stays positive.',
        detailed: `The z-row has no negative entries, but an artificial variable (cost −M) is still in the basis at a positive value. The penalty M prevents it from leaving, which proves the constraints are inconsistent.`,
        rule: 'Big-M infeasibility criterion',
      },
      [],
      'infeasible'
    );
    return { steps: rec.steps, result: null, status: 'infeasible', diagnostics: rec.diags, metrics };
  }

  if (sf.rows.length > 0 || true) {
    pushStep(
      rec, w, cfg, undefined, 'Termination', { kind: 'optimal', payload: {} },
      {
        short: `Optimal: ${label} = ${res.objectiveValue.toString()}.`,
        detailed:
          `Every reduced cost in the ${label}-row is non-negative, so no entering variable can improve the objective: the current basic feasible solution is optimal. ` +
          `Solution: ${model.varNames.map((nm, j) => `${nm} = ${res.variableValues[j]!.toString()}`).join(', ')}; ${label} = ${res.objectiveValue.toString()}.` +
          (status === 'optimal-alternate-exists' ? ' A non-basic variable has reduced cost 0, so this optimum is not unique.' : ''),
        rule: 'Optimality test (all reduced costs ≥ 0)',
        note: res.degenerate ? 'Degenerate optimum: a basic variable is 0.' : undefined,
      },
      w.basis.map((b, i) => ({ target: `cell:${i},${idxOf(b)}`, intent: 'optimal' as const })),
      'optimal'
    );
  }
  return { steps: rec.steps, result: { ...res, status }, status, diagnostics: rec.diags, metrics };
}

/** Farkas-style certificate text: the listed multiples of the constraints add up to a contradiction. */
function certificateText(mult: { index: number | null; label: string; multiplier: Rational }[]): string {
  const merged = new Map<string, { label: string; multiplier: Rational }>();
  for (const m of mult) {
    const key = m.index === null ? `bound:${m.label}` : `row:${m.index}`;
    const base = m.index === null ? m.label : m.label.replace(/ \((≤|≥) part\)$/, '');
    const prev = merged.get(key);
    merged.set(key, { label: base, multiplier: prev ? prev.multiplier.add(m.multiplier) : m.multiplier });
  }
  return [...merged.values()].filter(m => !m.multiplier.isZero()).map(m => `${m.multiplier.toString()} × (${m.label})`).join('  +  ');
}

function canonName(model: LPModel, j: number): string {
  return model.varNames[j] ?? `x${j + 1}`;
}

/**
 * Alternate optima: a non-basic column with reduced cost exactly 0 whose entry into the basis moves to a
 * DIFFERENT vertex (the original variables change). Columns that only re-label the same vertex
 * (degenerate pivots, ± halves of a split free variable) are ignored.
 */
function detectAlternate(
  model: LPModel,
  sf: StandardForm,
  rows: NormalizedRow[],
  w: Work,
  cfg: SnapCfg,
  method: ConcreteMethod,
  redundant: number[],
  res: LPResult,
  rec: Recorder
): boolean {
  for (let j = 0; j < w.n; j++) {
    if (!w.allowEnter[j] || w.basis.includes(j)) continue;
    if (!w.d[j]!.isZero()) continue;
    const clone: Work = { ...w, A: w.A.map(r => [...r]), b: [...w.b], d: [...w.d], basis: [...w.basis] };
    let bestRow = -1;
    let bestRatio: Rational | null = null;
    for (let i = 0; i < clone.m; i++) {
      const a = clone.A[i]![j]!;
      if (a.isPositive()) {
        const r = clone.b[i]!.div(a);
        if (bestRatio === null || r.lt(bestRatio)) { bestRatio = r; bestRow = i; }
      }
    }
    if (bestRow < 0) {
      // Check the ray really changes an original variable.
      const ny = sf.yNames.length;
      const dirY: Rational[] = Array(ny).fill(Rational.ZERO);
      if (j < ny) dirY[j] = Rational.ONE;
      w.basis.forEach((bc, i) => { if (bc < ny) dirY[bc] = w.A[i]![j]!.neg(); });
      const moves = sf.varMaps.some(vm => !vm.terms.reduce((acc, t) => acc.add(t.coef.mul(dirY[t.col]!)), Rational.ZERO).isZero());
      if (!moves) continue;
      res.alternateOptimum = { variableValues: res.variableValues, unboundedFace: true };
      addDiag(rec, {
        severity: 'info',
        code: 'ALTERNATE_OPTIMA_RAY',
        message: `Alternate optima: ${w.names[j]} has reduced cost 0 and no limiting row, so the optimal face is unbounded — infinitely many optimal solutions along a ray.`,
      });
      return true;
    }
    pivotWork(clone, bestRow, j);
    const alt = extractResult(model, sf, rows, clone, cfg, method, redundant, 'optimal');
    if (alt.variableValues.every((v, k) => v.eq(res.variableValues[k]!))) continue;
    res.alternateOptimum = { variableValues: alt.variableValues };
    addDiag(rec, {
      severity: 'info',
      code: 'ALTERNATE_OPTIMA',
      message: `Alternate optima: non-basic variable ${w.names[j]} has reduced cost exactly 0, so pivoting it in gives a different vertex with the same objective value. Every point on the edge between the two vertices is optimal.`,
    });
    return true;
  }
  // At a degenerate vertex a zero-reduced-cost column can fail to expose an alternate optimum (every pivot
  // is a zero-length step). Settle it exactly: over the optimal face, maximise and minimise each original variable.
  if (w.b.some(v => v.isZero())) {
    const other = probeOptimalFace(model, sf, rows, w, cfg, method, redundant, res);
    if (other) {
      if (other.unbounded) {
        res.alternateOptimum = { variableValues: res.variableValues, unboundedFace: true };
        addDiag(rec, {
          severity: 'info',
          code: 'ALTERNATE_OPTIMA_RAY',
          message: 'Alternate optima: the optimal face is unbounded (found by exploring the degenerate vertex), so infinitely many optimal solutions lie along a ray.',
        });
      } else {
        res.alternateOptimum = { variableValues: other.values };
        addDiag(rec, {
          severity: 'info',
          code: 'ALTERNATE_OPTIMA',
          message: 'Alternate optima: this degenerate vertex is not the only optimal point; another vertex has the same objective value, and every point between them is optimal.',
        });
      }
      return true;
    }
  }
  return false;
}

function probeOptimalFace(
  model: LPModel,
  sf: StandardForm,
  rows: NormalizedRow[],
  w: Work,
  cfg: SnapCfg,
  method: ConcreteMethod,
  redundant: number[],
  res: LPResult
): { values: Rational[]; unbounded: boolean } | null {
  const ny = sf.yNames.length;
  const frozen = w.d.map(v => !v.isZero());
  for (let j = 0; j < sf.varMaps.length; j++) {
    for (const sign of [Rational.ONE, Rational.MINUS_ONE]) {
      const clone: Work = {
        ...w,
        A: w.A.map(r => [...r]),
        b: [...w.b],
        d: Array.from({ length: w.n }, () => MNum.ZERO),
        z: MNum.ZERO,
        basis: [...w.basis],
        allowEnter: w.allowEnter.map((ok, k) => ok && !frozen[k]),
      };
      for (const t of sf.varMaps[j]!.terms) if (t.col < ny) clone.d[t.col] = MNum.of(sign.mul(t.coef).neg());
      canonicalize(clone);
      const scratch: Recorder = { steps: [], diags: [], emit: false, seen: new Set() };
      const out = runLoop(clone, cfg, scratch, { dual: false, maxIterations: 1000, phaseLabel: '', iterStart: 0 });
      if (out.status === 'unbounded') return { values: res.variableValues, unbounded: true };
      if (out.status !== 'optimal') continue;
      const alt = extractResult(model, sf, rows, clone, cfg, method, redundant, 'optimal');
      if (alt.variableValues.some((v, k) => !v.eq(res.variableValues[k]!))) return { values: alt.variableValues, unbounded: false };
    }
  }
  return null;
}

function extractResult(
  model: LPModel,
  sf: StandardForm,
  rows: NormalizedRow[],
  w: Work,
  cfg: SnapCfg,
  method: ConcreteMethod,
  redundant: number[],
  status: string
): LPResult {
  const ny = sf.yNames.length;
  const y: Rational[] = Array(ny).fill(Rational.ZERO);
  w.basis.forEach((bc, i) => {
    if (bc < ny) y[bc] = w.b[i]!;
  });
  const x = recoverVariables(sf, y);

  // Objective in original sense.
  let obj = model.objectiveConstant ?? Rational.ZERO;
  for (let j = 0; j < x.length; j++) obj = obj.add((model.objective[j] ?? Rational.ZERO).mul(x[j]!));

  // Slack values per ORIGINAL constraint
  const slackValues = model.constraints.map(c => {
    let lhs = Rational.ZERO;
    for (let j = 0; j < x.length; j++) lhs = lhs.add((c.coeffs[j] ?? Rational.ZERO).mul(x[j]!));
    return c.relation === '<=' ? c.rhs.sub(lhs) : c.relation === '>=' ? lhs.sub(c.rhs) : Rational.ZERO;
  });

  // Shadow prices per original constraint
  const dualValues: Rational[] = model.constraints.map(() => Rational.ZERO);
  const sgn = sf.isMax ? Rational.ONE : Rational.MINUS_ONE;
  rows.forEach((r, i) => {
    if (r.origIndex === null) return;
    const idc = w.idCols[i]!;
    const dv = w.d[idc]!;
    const yy = w.types[idc] === 'artificial' && method === 'bigM' ? dv.a : dv.a;
    const contrib = sgn.mul(Rational.of(r.sigma)).mul(yy);
    dualValues[r.origIndex] = dualValues[r.origIndex]!.add(contrib);
  });

  const degenerate = w.b.some(v => v.isZero());
  const result: LPResult = {
    status,
    variableValues: x,
    objectiveValue: obj,
    slackValues,
    dualValues,
    basis: w.basis.map(bc => visibleCols(w).indexOf(bc)),
    varNames: model.varNames,
    degenerate,
    redundantConstraints: redundant.length ? redundant : undefined,
    internals: {
      sf,
      rows,
      basisFull: [...w.basis],
      A: w.A.map(r => [...r]),
      b: [...w.b],
      d: w.d.map(v => v.a),
      idCols: [...w.idCols],
      colNames: [...w.names],
      colTypes: [...w.types],
      method,
      rowMeta: rows.map(r => ({ origIndex: r.origIndex, sigma: r.sigma, label: r.label })),
    },
  };
  void cfg;
  return result;
}

/* ------------------------------------------------------------------ */
/* Dual simplex                                                        */
/* ------------------------------------------------------------------ */

function runDual(model: LPModel, sf: StandardForm, rec: Recorder, maxIterations: number, options: LPSolveOptions): Core {
  // Rows as ≤ over slack basis: ≥ rows are negated; = rows become a ≤ row plus a negated ≥ row.
  type DRow = NormalizedRow;
  const rows: DRow[] = [];
  const notes: string[] = [];
  sf.rows.forEach((r, i) => {
    if (r.relation === '<=') rows.push({ ...r, sigma: 1 });
    else if (r.relation === '>=') {
      rows.push({ ...r, coeffs: r.coeffs.map(c => c.neg()), rhs: r.rhs.neg(), relation: '<=', sigma: -1 });
      notes.push(`Row ${i + 1} (${r.label}) is ≥, so it is multiplied by −1 to become ≤ ${r.rhs.neg().toString()}.`);
    } else {
      rows.push({ ...r, relation: '<=', sigma: 1, label: `${r.label} (≤ part)` });
      rows.push({ ...r, coeffs: r.coeffs.map(c => c.neg()), rhs: r.rhs.neg(), relation: '<=', sigma: -1, label: `${r.label} (≥ part)` });
      notes.push(`Row ${i + 1} (${r.label}) is an equality and is replaced by the pair ≤ and ≥.`);
    }
  });

  const m = rows.length;
  const ny = sf.yNames.length;
  const w = emptyWork(m, ny + m);
  for (let j = 0; j < ny; j++) { w.names[j] = sf.yNames[j]!; w.types[j] = 'decision'; }
  rows.forEach((r, i) => {
    for (let j = 0; j < ny; j++) w.A[i]![j] = r.coeffs[j]!;
    w.b[i] = r.rhs;
    w.A[i]![ny + i] = Rational.ONE;
    w.names[ny + i] = genName('s', i + 1);
    w.types[ny + i] = 'slack';
    w.basis[i] = ny + i;
    w.idCols[i] = ny + i;
  });
  setObjective(w, sf, false);

  const cfg: SnapCfg = {
    method: 'dual',
    phase: null,
    sense: sf.isMax ? 'max' : 'min',
    objConst: sf.objConstOrig,
    showM: false,
    label: 'z',
  };
  const d0 = decideDual(w, options.antiCycling === 'bland');
  pushStep(
    rec, w, cfg, d0, 'Initialization', null,
    {
      short: 'Dual-feasible start: all reduced costs ≥ 0 but some right-hand sides are negative.',
      detailed:
        'Every constraint is written as ≤ with a slack variable, giving a basis that is optimal (dual feasible) but infeasible wherever a right-hand side is negative. ' +
        'The dual simplex method repairs feasibility while keeping every z-row entry non-negative.' + (notes.length ? ` Normalisation: ${notes.join(' ')}` : ''),
      rule: 'Dual simplex initialisation',
    },
    [],
    'initial'
  );
  const out = runLoop(w, cfg, rec, { dual: true, maxIterations, phaseLabel: 'Dual simplex iteration', iterStart: 0, antiCycling: options.antiCycling });

  const metrics = { iterations: out.iterations, elapsedMs: 0, maxRationalMagnitude: maxMagnitude(w), degradedToFloat: false };
  if (out.status === 'iteration-limit') {
    return { steps: rec.steps, result: extractResult(model, sf, rows, w, cfg, 'dual', [], 'iteration-limit'), status: 'iteration-limit', diagnostics: rec.diags, metrics };
  }
  if (out.status === 'infeasible') {
    const dec = out.lastDecision as Extract<Decision, { kind: 'infeasible-row' }>;
    const row = dec.row;
    const mult: { index: number | null; label: string; multiplier: Rational }[] = [];
    rows.forEach((r, i) => {
      const v = w.A[row]![w.idCols[i]!]!;
      if (!v.isZero()) mult.push({ index: r.origIndex, label: r.label, multiplier: v.mul(Rational.of(r.sigma)) });
    });
    addDiag(rec, {
      severity: 'error',
      code: 'INFEASIBLE',
      message: `Infeasible: in the row of ${w.names[w.basis[row]!]} the right-hand side ${w.b[row]!.toString()} is negative but no entry is negative, so no variable can repair it. Conflict involves ${joinList(mult.map(m2 => m2.label))}.`,
      detail: certificateText(mult),
    });
    pushStep(
      rec, w, cfg, undefined, 'Termination', { kind: 'infeasible', payload: { row } },
      {
        short: 'Infeasible: a negative RHS row has no negative entry.',
        detailed: `Row ${row + 1} reads (non-negative terms) = ${w.b[row]!.toString()} < 0, which is impossible for x ≥ 0.`,
        rule: 'Dual simplex infeasibility test',
      },
      [{ target: `row:${row}`, intent: 'blocked' }],
      'infeasible'
    );
    return { steps: rec.steps, result: null, status: 'infeasible', diagnostics: rec.diags, metrics };
  }

  const res = extractResult(model, sf, rows, w, cfg, 'dual', [], 'optimal');
  let dualStatus: TerminationStatus = 'optimal';
  if (detectAlternate(model, sf, rows, w, cfg, 'dual', [], res, rec)) dualStatus = 'optimal-alternate-exists';
  res.status = dualStatus;
  if (res.degenerate) addDiag(rec, { severity: 'info', code: 'DEGENERATE_OPTIMUM', message: 'The optimal basis is degenerate (a basic variable equals 0).' });
  pushStep(
    rec, w, cfg, undefined, 'Termination', { kind: 'optimal', payload: {} },
    {
      short: `Optimal: z = ${res.objectiveValue.toString()}.`,
      detailed: `All right-hand sides are now non-negative while every reduced cost is still ≥ 0, so the basis is both primal and dual feasible, hence optimal. ` +
        `Solution: ${model.varNames.map((nm, j) => `${nm} = ${res.variableValues[j]!.toString()}`).join(', ')}.`,
      rule: 'Optimality (primal + dual feasible)',
    },
    w.basis.map((b, i) => ({ target: `cell:${i},${visibleCols(w).indexOf(b)}`, intent: 'optimal' as const })),
    'optimal'
  );
  return { steps: rec.steps, result: res, status: dualStatus, diagnostics: rec.diags, metrics };
}

/* ------------------------------------------------------------------ */
/* Internals shared with the cutting-plane module                      */
/* ------------------------------------------------------------------ */

export type EngineWork = Work;
export type EngineSnapCfg = SnapCfg;
export type EngineRecorder = Recorder;

export const engineInternals = {
  runLoop,
  snapshot,
  pushStep,
  addDiag,
  visibleCols,
  displayObjective,
  maxMagnitude,
  decideDual,
  pivotWork,
};

/** Rebuild the engine's work arrays from the final internals of a finished solve (used by Gomory cuts). */
export function workFromInternals(I: LPInternals, zMax: Rational): Work {
  const m = I.A.length;
  const n = I.colNames.length;
  const w = emptyWork(m, n);
  w.A = I.A.map(r => [...r]);
  w.b = [...I.b];
  w.d = I.d.map(v => MNum.of(v));
  w.z = MNum.of(zMax);
  w.basis = [...I.basisFull];
  w.names = [...I.colNames];
  w.types = [...I.colTypes];
  w.idCols = [...I.idCols];
  w.allowEnter = w.types.map(t => t !== 'artificial');
  w.visible = w.types.map(t => t !== 'artificial');
  return w;
}
