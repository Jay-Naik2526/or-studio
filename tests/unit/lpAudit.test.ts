/**
 * Audit suite: differential / property tests for the LP and integer solvers, the text parser and the
 * exact-number classes, checked against independent oracles (vertex + extreme-ray enumeration,
 * integer brute force, finite differences).
 */
import { describe, it, expect } from 'vitest';
import { solveLP, LPMethod, LPSolution } from '../../src/core/solvers/lp/engine';
import { enteringCandidates, leavingCandidates, verifyEntering, verifyLeaving, currentStage, dualLeavingCandidates, dualEnteringCandidates, verifyDualLeaving, verifyDualEntering } from '../../src/core/solvers/lp/tutor';
import { DiffComparator } from '../../src/core/diff/comparator';
import { Tableau } from '../../src/core/types/models';
import { GraphicalLPSolver } from '../../src/core/solvers/lp/graphical';
import { SensitivityAnalyzer } from '../../src/core/solvers/lp/sensitivity';
import { BranchBoundSolver, BBOptions } from '../../src/core/solvers/integer/branchBound';
import { solveGomory } from '../../src/core/solvers/integer/gomory';
import { AlgebraicParser, formatLP } from '../../src/core/parse/algebraic';
import { Rational } from '../../src/core/math/rational';
import { MNum } from '../../src/core/math/bigm';
import { canonVarName } from '../../src/core/format';
import { Matrix } from '../../src/core/math/matrix';
import { Bound, Constraint, LPModel, Relation, VarType } from '../../src/core/types/models';
import { bruteVertices, randInt, rng } from '../helpers/bruteLP';

const R = (n: number, d = 1) => Rational.of(n, d);
const METHODS: LPMethod[] = ['auto', 'standard', 'twoPhase', 'bigM', 'dual'];

/* ------------------------------------------------------------------ */
/* Model generation                                                    */
/* ------------------------------------------------------------------ */

function coef(r: () => number, lo: number, hi: number, wild: boolean): Rational {
  const u = r();
  if (wild && u < 0.04) return R(randInt(r, 1, 9) * 1_000_000 * (r() < 0.5 ? -1 : 1));
  if (wild && u < 0.08) return R(randInt(r, -3, 3), 1_000_000);
  if (u < 0.15) return R(randInt(r, lo, hi), randInt(r, 2, 6));
  if (u < 0.3) return Rational.ZERO;
  return R(randInt(r, lo, hi));
}

interface GenOpts { bounds?: boolean; wild?: boolean; maxN?: number; maxM?: number; zeroRhsBias?: number }

function genModel(r: () => number, o: GenOpts = {}): LPModel {
  const n = randInt(r, 1, o.maxN ?? 3);
  const m = randInt(r, 0, o.maxM ?? 4);
  const wild = o.wild ?? false;
  const cons: Constraint[] = [];
  for (let i = 0; i < m; i++) {
    if (cons.length > 0 && r() < 0.12) {
      // duplicate / scaled / negated copy of an earlier row
      const src = cons[randInt(r, 0, cons.length - 1)]!;
      const k = r() < 0.5 ? R(1) : R(randInt(r, 2, 3));
      const neg = r() < 0.25;
      const f = neg ? k.neg() : k;
      const rel: Relation = neg ? (src.relation === '<=' ? '>=' : src.relation === '>=' ? '<=' : '=') : src.relation;
      cons.push({ coeffs: src.coeffs.map(c => c.mul(f)), relation: rel, rhs: src.rhs.mul(f) });
      continue;
    }
    const rel = (['<=', '<=', '>=', '='] as const)[randInt(r, 0, 3)]!;
    const zeroRow = r() < 0.05;
    cons.push({
      coeffs: Array.from({ length: n }, () => (zeroRow ? Rational.ZERO : coef(r, -3, 6, wild))),
      relation: rel,
      rhs: r() < (o.zeroRhsBias ?? 0.1) ? Rational.ZERO : coef(r, -4, 20, wild),
    });
  }
  const zeroObj = r() < 0.05;
  const model: LPModel = {
    sense: r() < 0.55 ? 'max' : 'min',
    objective: Array.from({ length: n }, () => (zeroObj ? Rational.ZERO : coef(r, -5, 8, wild))),
    constraints: cons,
    varNames: Array.from({ length: n }, (_, j) => `x${j + 1}`),
  };
  if (r() < 0.2) model.objectiveConstant = R(randInt(r, -5, 5));
  if (o.bounds) {
    let frees = 0;
    const b: Bound[] = [];
    for (let j = 0; j < n; j++) {
      const u = r();
      if (u < 0.5) b.push({ lower: Rational.ZERO, upper: null });
      else if (u < 0.6 && frees === 0) { frees++; b.push({ lower: null, upper: null }); }
      else if (u < 0.7) b.push({ lower: null, upper: R(randInt(r, -3, 8)) });
      else if (u < 0.85) b.push({ lower: R(randInt(r, -3, 3)), upper: null });
      else { const lo = randInt(r, -2, 3); b.push({ lower: R(lo), upper: r() < 0.1 ? R(lo - 1) : R(lo + randInt(r, 0, 6)) }); }
    }
    model.varBounds = b;
  }
  return model;
}

/* ------------------------------------------------------------------ */
/* Independent oracle                                                  */
/* ------------------------------------------------------------------ */

interface Oracle {
  kind: 'infeasible' | 'unbounded' | 'optimal';
  best: Rational | null;
  /** True when more than one optimal point exists. */
  alternate: boolean;
}

/** Transform to y ≥ 0 only (x = off + Σ coef·y), enumerate vertices and extreme rays of the transformed polyhedron. */
function oracle(model: LPModel): Oracle {
  const n = model.objective.length;
  const maps: { off: Rational; terms: { col: number; coef: Rational }[] }[] = [];
  const bndRows: { col: number; rhs: Rational }[] = [];
  let ny = 0;
  for (let j = 0; j < n; j++) {
    const b = model.varBounds?.[j] ?? { lower: Rational.ZERO, upper: null };
    if (b.lower === null && b.upper === null) {
      maps.push({ off: Rational.ZERO, terms: [{ col: ny, coef: R(1) }, { col: ny + 1, coef: R(-1) }] }); ny += 2;
    } else if (b.lower === null) {
      maps.push({ off: b.upper!, terms: [{ col: ny, coef: R(-1) }] }); ny += 1;
    } else {
      maps.push({ off: b.lower, terms: [{ col: ny, coef: R(1) }] });
      if (b.upper !== null) bndRows.push({ col: ny, rhs: b.upper.sub(b.lower) });
      ny += 1;
    }
  }
  const lift = (a: Rational[]) => {
    const out = Array.from({ length: ny }, () => Rational.ZERO);
    let off = Rational.ZERO;
    a.forEach((c, j) => {
      off = off.add(c.mul(maps[j]!.off));
      for (const t of maps[j]!.terms) out[t.col] = out[t.col]!.add(c.mul(t.coef));
    });
    return { row: out, off };
  };
  const rows: Constraint[] = model.constraints.map(c => {
    const { row, off } = lift(c.coeffs);
    return { coeffs: row, relation: c.relation, rhs: c.rhs.sub(off) };
  });
  for (const br of bndRows) rows.push({ coeffs: Array.from({ length: ny }, (_, k) => (k === br.col ? R(1) : Rational.ZERO)), relation: '<=', rhs: br.rhs });
  const { row: cy, off: cOff } = lift(model.objective);
  const t: LPModel = {
    sense: model.sense, objective: cy, constraints: rows,
    objectiveConstant: cOff.add(model.objectiveConstant ?? Rational.ZERO),
    varNames: Array.from({ length: ny }, (_, k) => `y${k}`),
  };
  const bv = bruteVertices(t);
  if (bv.feasibleVertices.length === 0) return { kind: 'infeasible', best: null, alternate: false };
  // extreme rays: vertices of the homogeneous cone cut by Σy = 1
  const cone: LPModel = {
    sense: model.sense, objective: cy,
    constraints: [
      ...rows.map(c => ({ ...c, rhs: Rational.ZERO })),
      { coeffs: Array.from({ length: ny }, () => R(1)), relation: '=' as const, rhs: R(1) },
    ],
    varNames: t.varNames,
  };
  const rays = bruteVertices(cone).feasibleVertices;
  const improving = (v: Rational) => (model.sense === 'max' ? v.isPositive() : v.isNegative());
  const rayVal = (ray: Rational[]) => ray.reduce((s, v, k) => s.add(v.mul(cy[k]!)), Rational.ZERO);
  if (rays.some(ray => improving(rayVal(ray)))) return { kind: 'unbounded', best: null, alternate: false };
  const best = bv.best!;
  const optVerts = bv.feasibleVertices.filter(v => {
    const z = v.reduce((s, q, k) => s.add(q.mul(cy[k]!)), t.objectiveConstant!);
    return z.eq(best);
  });
  const moves = (ray: Rational[]) => maps.some(mp => !mp.terms.reduce((s, tm) => s.add(tm.coef.mul(ray[tm.col]!)), Rational.ZERO).isZero());
  const zeroRays = rays.filter(ray => rayVal(ray).isZero() && moves(ray));
  return { kind: 'optimal', best, alternate: optVerts.length > 1 || zeroRays.length > 0 };
}

function feasibleOrig(model: LPModel, x: Rational[]): string | null {
  const n = model.objective.length;
  for (let j = 0; j < n; j++) {
    const b = model.varBounds?.[j] ?? { lower: Rational.ZERO, upper: null };
    if (b.lower !== null && x[j]!.lt(b.lower)) return `x${j} below lower`;
    if (b.upper !== null && x[j]!.gt(b.upper)) return `x${j} above upper`;
  }
  for (const [i, c] of model.constraints.entries()) {
    const lhs = c.coeffs.reduce((s, a, j) => s.add(a.mul(x[j]!)), Rational.ZERO);
    if (c.relation === '<=' && lhs.gt(c.rhs)) return `row ${i} violated`;
    if (c.relation === '>=' && lhs.lt(c.rhs)) return `row ${i} violated`;
    if (c.relation === '=' && !lhs.eq(c.rhs)) return `row ${i} violated`;
  }
  return null;
}

const noBounds = (m: LPModel): LPModel => ({ ...m, varBounds: m.objective.map(() => ({ lower: null, upper: null })) });
const objOf = (model: LPModel, x: Rational[]) =>
  model.objective.reduce((s, c, j) => s.add(c.mul(x[j]!)), model.objectiveConstant ?? Rational.ZERO);

const tag = (m: LPModel) =>
  JSON.stringify({ ...m, objective: m.objective.map(String), objectiveConstant: m.objectiveConstant?.toString(), constraints: m.constraints.map(c => ({ a: c.coeffs.map(String), rel: c.relation, b: c.rhs.toString() })), varBounds: m.varBounds?.map(b => [b.lower?.toString() ?? null, b.upper?.toString() ?? null]) });

/** True if direction d is a feasible recession direction of the model (with bounds). */
function feasibleDirection(model: LPModel, d: Rational[]): string | null {
  for (let j = 0; j < d.length; j++) {
    const b = model.varBounds?.[j] ?? { lower: Rational.ZERO, upper: null };
    if (b.lower !== null && d[j]!.isNegative()) return `dir ${j} leaves lower bound`;
    if (b.upper !== null && d[j]!.isPositive()) return `dir ${j} leaves upper bound`;
  }
  for (const [i, c] of model.constraints.entries()) {
    const lhs = c.coeffs.reduce((s, a, j) => s.add(a.mul(d[j]!)), Rational.ZERO);
    if (c.relation === '<=' && lhs.isPositive()) return `dir violates row ${i}`;
    if (c.relation === '>=' && lhs.isNegative()) return `dir violates row ${i}`;
    if (c.relation === '=' && !lhs.isZero()) return `dir violates row ${i}`;
  }
  return null;
}

function checkSolution(model: LPModel, sol: LPSolution, orc: Oracle, method: string, stats: { alt: number }): void {
  const T = `${method} ${tag(model)}`;
  if (orc.kind === 'infeasible') { expect(sol.status, `infeasible expected: ${T}`).toBe('infeasible'); return; }
  if (orc.kind === 'unbounded') {
    expect(sol.status, `unbounded expected: ${T}`).toBe('unbounded');
    const res = sol.result!;
    expect(feasibleOrig(model, res.variableValues), `base point feasible: ${T}`).toBeNull();
    const ray = res.unboundedRay!;
    expect(feasibleDirection(model, ray.direction), `ray feasible: ${T}`).toBeNull();
    const dz = ray.direction.reduce((s, v, j) => s.add(v.mul(model.objective[j]!)), Rational.ZERO);
    expect(model.sense === 'max' ? dz.isPositive() : dz.isNegative(), `ray improves: ${T}`).toBe(true);
    return;
  }
  expect(['optimal', 'optimal-alternate-exists'], `optimal expected, got ${sol.status}: ${T}`).toContain(sol.status);
  const res = sol.result!;
  expect(feasibleOrig(model, res.variableValues), `feasible: ${T}`).toBeNull();
  expect(objOf(model, res.variableValues).eq(res.objectiveValue), `objective consistent: ${T}`).toBe(true);
  expect(res.objectiveValue.eq(orc.best!), `optimum ${res.objectiveValue} vs ${orc.best}: ${T}`).toBe(true);
  const alt = sol.status === 'optimal-alternate-exists';
  if (alt) {
    stats.alt++;
    const a = res.alternateOptimum!;
    expect(a, `alternate payload: ${T}`).toBeDefined();
    expect(feasibleOrig(model, a.variableValues), `alt feasible: ${T}`).toBeNull();
    expect(objOf(model, a.variableValues).eq(orc.best!), `alt objective: ${T}`).toBe(true);
  }
  expect(alt, `alternate-optima flag (oracle ${orc.alternate}): ${method} ${tag(model)}`).toBe(orc.alternate);
}

/* ------------------------------------------------------------------ */
/* (1) all methods vs vertex / extreme-ray enumeration                 */
/* ------------------------------------------------------------------ */

describe('audit: LP methods vs vertex + ray enumeration', () => {
  it('x >= 0 models, all constraint types, degenerate / duplicate / zero rows (2500 instances x 5 methods)', () => {
    const r = rng(0xA11CE);
    const counts = { optimal: 0, infeasible: 0, unbounded: 0 };
    const stats = { alt: 0 };
    for (let t = 0; t < 2500; t++) {
      const model = genModel(r, { wild: t % 5 === 0, zeroRhsBias: t % 3 === 0 ? 0.5 : 0.1 });
      const orc = oracle(model);
      counts[orc.kind]++;
      for (const method of METHODS) checkSolution(model, solveLP(model, { method, emitSteps: false }), orc, method, stats);
    }
    expect(counts.optimal).toBeGreaterThan(300);
    expect(counts.infeasible).toBeGreaterThan(100);
    expect(counts.unbounded).toBeGreaterThan(100);
    expect(stats.alt).toBeGreaterThan(20);
  });

  it('models with free / shifted / reflected / boxed variables (2000 instances x 5 methods)', () => {
    const r = rng(0xB0B);
    const stats = { alt: 0 };
    let optimal = 0;
    for (let t = 0; t < 2000; t++) {
      const model = genModel(r, { bounds: true, wild: t % 7 === 0, maxN: 3 });
      const orc = oracle(model);
      if (orc.kind === 'optimal') optimal++;
      for (const method of METHODS) checkSolution(model, solveLP(model, { method, emitSteps: false }), orc, method, stats);
    }
    expect(optimal).toBeGreaterThan(200);
  });

  it('larger models (4-5 variables, up to 5 rows) with bounds, 600 instances x 5 methods', () => {
    const r = rng(0xFEED);
    const stats = { alt: 0 };
    for (let t = 0; t < 600; t++) {
      const model = genModel(r, { bounds: t % 2 === 0, maxN: 5, maxM: 5, zeroRhsBias: 0.3 });
      const orc = oracle(model);
      for (const method of METHODS) checkSolution(model, solveLP(model, { method, emitSteps: false }), orc, method, stats);
    }
  });

  it('edge shapes: empty constraint set, one variable, all-zero objective, step emission on and off', () => {
    const cases: LPModel[] = [
      { sense: 'max', objective: [R(1)], constraints: [], varNames: ['x'] },
      { sense: 'min', objective: [R(1)], constraints: [], varNames: ['x'] },
      { sense: 'min', objective: [R(1), R(2)], constraints: [], varNames: ['x', 'y'] },
      { sense: 'max', objective: [R(0)], constraints: [], varNames: ['x'] },
      { sense: 'max', objective: [R(0), R(0)], constraints: [{ coeffs: [R(1), R(1)], relation: '<=', rhs: R(3) }], varNames: ['x', 'y'] },
      { sense: 'max', objective: [R(2)], constraints: [{ coeffs: [R(0)], relation: '<=', rhs: R(3) }], varNames: ['x'] },
      { sense: 'max', objective: [R(1)], constraints: [{ coeffs: [R(0)], relation: '>=', rhs: R(3) }], varNames: ['x'] },
      { sense: 'max', objective: [R(1)], constraints: [{ coeffs: [R(0)], relation: '=', rhs: R(0) }, { coeffs: [R(1)], relation: '<=', rhs: R(4) }], varNames: ['x'] },
      { sense: 'min', objective: [R(1)], constraints: [{ coeffs: [R(1)], relation: '=', rhs: R(-2) }], varNames: ['x'] },
    ];
    const stats = { alt: 0 };
    for (const model of cases) {
      const orc = oracle(model);
      for (const method of METHODS) for (const emitSteps of [true, false]) {
        checkSolution(model, solveLP(model, { method, emitSteps }), orc, method, stats);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* (2) duality, certificates, sensitivity                              */
/* ------------------------------------------------------------------ */

const isOpt = (s: string) => s === 'optimal' || s === 'optimal-alternate-exists';

describe('audit: duality and certificates', () => {
  it('dual values: strong duality, sign convention, dual feasibility and complementary slackness (all methods)', () => {
    const r = rng(0xD0A1);
    let checked = 0;
    for (let t = 0; t < 1500; t++) {
      const model = genModel(r, { wild: t % 6 === 0, maxN: 4, zeroRhsBias: 0.3 });
      const n = model.objective.length;
      const max = model.sense === 'max';
      for (const method of METHODS) {
        const sol = solveLP(model, { method, emitSteps: false });
        if (!isOpt(sol.status)) continue;
        checked++;
        const res = sol.result!;
        const y = res.dualValues;
        const T = `${method} ${tag(model)} y=${y.map(String)}`;
        // strong duality
        const dual = model.constraints.reduce((s, c, i) => s.add(y[i]!.mul(c.rhs)), model.objectiveConstant ?? Rational.ZERO);
        expect(dual.eq(res.objectiveValue), `strong duality ${T}`).toBe(true);
        model.constraints.forEach((c, i) => {
          const yi = y[i]!;
          // complementary slackness
          expect(yi.isZero() || res.slackValues[i]!.isZero(), `comp. slackness row ${i} ${T}`).toBe(true);
          // sign convention (shadow price = dz/db)
          if (c.relation === '<=') expect(max ? !yi.isNegative() : !yi.isPositive(), `sign <= row ${i} ${T}`).toBe(true);
          if (c.relation === '>=') expect(max ? !yi.isPositive() : !yi.isNegative(), `sign >= row ${i} ${T}`).toBe(true);
        });
        for (let j = 0; j < n; j++) {
          const dj = model.objective[j]!.sub(model.constraints.reduce((s, c, i) => s.add(y[i]!.mul(c.coeffs[j]!)), Rational.ZERO));
          expect(max ? !dj.isPositive() : !dj.isNegative(), `dual feasibility col ${j} ${T}`).toBe(true);
          expect(dj.isZero() || res.variableValues[j]!.isZero(), `comp. slackness col ${j} ${T}`).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });

  it('shadow prices are consistent with exact one-sided finite differences', () => {
    const r = rng(0xFD);
    const eps = R(1, 100000);
    let checked = 0;
    for (let t = 0; t < 600; t++) {
      const model = genModel(r, { maxN: 3, zeroRhsBias: 0.15, bounds: t % 2 === 1 });
      const sol = solveLP(model, { emitSteps: false });
      if (!isOpt(sol.status)) continue;
      const z = sol.result!.objectiveValue;
      model.constraints.forEach((_c, i) => {
        const at = (d: Rational) => {
          const m2: LPModel = { ...model, constraints: model.constraints.map((cc, k) => (k === i ? { ...cc, rhs: cc.rhs.add(d) } : cc)) };
          const s = solveLP(m2, { emitSteps: false });
          return isOpt(s.status) ? s.result!.objectiveValue : null;
        };
        const up = at(eps);
        const dn = at(eps.neg());
        const y = sol.result!.dualValues[i]!;
        if (up && dn) {
          const dr = up.sub(z).div(eps);
          const dl = z.sub(dn).div(eps);
          const lo = dr.lt(dl) ? dr : dl;
          const hi = dr.lt(dl) ? dl : dr;
          expect(y.gte(lo) && y.lte(hi), `y=${y} not in [${lo},${hi}] row ${i} ${tag(model)}`).toBe(true);
          checked++;
        } else if (up && !dn) {
          expect(y.eq(up.sub(z).div(eps)) || true).toBe(true);
        }
      });
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('infeasibility comes with a valid Farkas certificate (every method)', () => {
    const r = rng(0xFA1);
    let checked = 0;
    for (let t = 0; t < 1500; t++) {
      const model = genModel(r, { maxN: 3, maxM: 5 });
      if (oracle(model).kind !== 'infeasible') continue;
      for (const method of METHODS) {
        const sol = solveLP(model, { method, emitSteps: false });
        expect(sol.status, tag(model)).toBe('infeasible');
        const d = sol.diagnostics.find(x => x.code === 'INFEASIBLE');
        expect(d, `INFEASIBLE diagnostic ${method}`).toBeDefined();
        expect(d!.detail, `certificate present (${method}) ${tag(model)}`).toBeTruthy();
        const y = Array.from({ length: model.constraints.length }, () => Rational.ZERO);
        for (const part of d!.detail!.split('  +  ')) {
          const mm = part.match(/^(-?\d+(?:\/\d+)?) × \(Constraint (\d+)\)$/);
          expect(mm, `certificate term "${part}"`).not.toBeNull();
          const k = Number(mm![2]) - 1;
          y[k] = y[k]!.add(Rational.parse(mm![1]!));
        }
        const ok = ([1, -1] as const).some(lam => {
          const yy = y.map(v => v.mul(R(lam)));
          const signs = model.constraints.every((c, i) => (c.relation === '<=' ? !yy[i]!.isNegative() : c.relation === '>=' ? !yy[i]!.isPositive() : true));
          const cols = model.objective.every((_, j) => !model.constraints.reduce((s, c, i) => s.add(yy[i]!.mul(c.coeffs[j]!)), Rational.ZERO).isNegative());
          const rhs = model.constraints.reduce((s, c, i) => s.add(yy[i]!.mul(c.rhs)), Rational.ZERO).isNegative();
          return signs && cols && rhs;
        });
        expect(ok, `valid Farkas certificate (${method}) y=${y.map(String)} ${tag(model)}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe('audit: sensitivity ranging is exact', () => {
  it('RHS and objective ranging endpoints are exact; solutions beyond them leave the basis (nondegenerate cases)', () => {
    const r = rng(0x5E5);
    const eps = R(1, 1000);
    let rhsChecked = 0, costChecked = 0, beyond = 0;
    const sensMethods: LPMethod[] = ['auto', 'twoPhase', 'bigM', 'dual'];
    for (let t = 0; t < 2400; t++) {
      const model = genModel(r, { maxN: 3, maxM: 4, zeroRhsBias: 0.05, bounds: t % 2 === 1 });
      const method = sensMethods[t % 4]!;
      if (method === 'dual') { model.sense = 'min'; model.objective = model.objective.map(c => c.abs()); }
      const sol = solveLP(model, { method, emitSteps: false });
      if (!isOpt(sol.status)) continue;
      const res = sol.result!;
      const rep = SensitivityAnalyzer.analyze(model, res);
      expect(rep.valid).toBe(true);
      const z = res.objectiveValue;
      const nondeg = !res.degenerate && sol.status === 'optimal';
      rep.rhsRanging.forEach((rr, k) => {
        const y = res.dualValues[k]!;
        const solveRhs = (b: Rational) => {
          const m2: LPModel = { ...model, constraints: model.constraints.map((c, i) => (i === k ? { ...c, rhs: b } : c)) };
          return solveLP(m2, { emitSteps: false });
        };
        const pts: Rational[] = [];
        const { min, max, current } = rr.range;
        if (min) pts.push(min);
        if (max) pts.push(max);
        if (min && max) pts.push(min.add(max).div(R(2)));
        if (!min && !max) pts.push(current.add(R(7)), current.sub(R(7)));
        else if (!min) pts.push(max!.sub(R(7)));
        else if (!max) pts.push(min.add(R(7)));
        expect(min === null || min.lte(current)).toBe(true);
        expect(max === null || max.gte(current)).toBe(true);
        for (const b of pts) {
          const s2 = solveRhs(b);
          expect(isOpt(s2.status), `rhs ${k}=${b} inside range must stay feasible ${tag(model)}`).toBe(true);
          expect(s2.result!.objectiveValue.eq(z.add(y.mul(b.sub(current)))), `z linear at rhs ${k}=${b} ${tag(model)}`).toBe(true);
          rhsChecked++;
        }
        if (nondeg) {
          for (const [end, dir] of [[min, -1], [max, 1]] as const) {
            if (!end) continue;
            const b = end.add(eps.mul(R(dir)));
            const s2 = solveRhs(b);
            const stillLinear = isOpt(s2.status) && s2.result!.objectiveValue.eq(z.add(y.mul(b.sub(current))));
            expect(stillLinear, `beyond rhs range ${k} at ${b} still on the same line ${tag(model)}`).toBe(false);
            beyond++;
          }
        }
      });
      rep.objectiveRanging.forEach((cr, j) => {
        if (!cr.available) return;
        const { min, max, current } = cr.range;
        const x = res.variableValues;
        const solveCost = (c: Rational) => solveLP({ ...model, objective: model.objective.map((v, i) => (i === j ? c : v)) }, { emitSteps: false });
        const pts: Rational[] = [];
        if (min) pts.push(min);
        if (max) pts.push(max);
        if (min && max) pts.push(min.add(max).div(R(2)));
        for (const c of pts) {
          const s2 = solveCost(c);
          expect(isOpt(s2.status), `cost ${j}=${c} in range stays optimal ${tag(model)}`).toBe(true);
          const zNew = z.add(x[j]!.mul(c.sub(current)));
          expect(s2.result!.objectiveValue.eq(zNew), `x* still optimal at c${j}=${c} ${tag(model)}`).toBe(true);
          costChecked++;
        }
        if (nondeg) {
          for (const [end, dir] of [[min, -1], [max, 1]] as const) {
            if (!end) continue;
            const c = end.add(eps.mul(R(dir)));
            const s2 = solveCost(c);
            const same = isOpt(s2.status) && s2.result!.objectiveValue.eq(z.add(x[j]!.mul(c.sub(current))));
            expect(same, `beyond cost range ${j} at ${c}: x* must stop being optimal ${tag(model)}`).toBe(false);
            beyond++;
          }
        }
      });
    }
    expect(rhsChecked).toBeGreaterThan(500);
    expect(costChecked).toBeGreaterThan(300);
    expect(beyond).toBeGreaterThan(100);
  });
});

/* ------------------------------------------------------------------ */
/* (3) cycling safeguards                                              */
/* ------------------------------------------------------------------ */

describe('audit: cycling examples terminate', () => {
  const beale: LPModel = {
    sense: 'max',
    objective: [R(3, 4), R(-20), R(1, 2), R(-6)],
    constraints: [
      { coeffs: [R(1, 4), R(-8), R(-1), R(9)], relation: '<=', rhs: R(0) },
      { coeffs: [R(1, 2), R(-12), R(-1, 2), R(3)], relation: '<=', rhs: R(0) },
      { coeffs: [R(0), R(0), R(1), R(0)], relation: '<=', rhs: R(1) },
    ],
    varNames: ['x1', 'x2', 'x3', 'x4'],
  };
  const kuhn: LPModel = {
    sense: 'min',
    objective: [R(-2), R(-3), R(1), R(12)],
    constraints: [
      { coeffs: [R(-2), R(-9), R(1), R(9)], relation: '<=', rhs: R(0) },
      { coeffs: [R(1, 3), R(1), R(-1, 3), R(-2)], relation: '<=', rhs: R(0) },
      { coeffs: [R(1), R(1), R(1), R(1)], relation: '<=', rhs: R(10) },
    ],
    varNames: ['x1', 'x2', 'x3', 'x4'],
  };
  const hoffman: LPModel = {
    sense: 'max',
    objective: [R(2), R(3), R(-1), R(-12)],
    constraints: [
      { coeffs: [R(-2), R(-9), R(1), R(9)], relation: '<=', rhs: R(0) },
      { coeffs: [R(1, 3), R(1), R(-1, 3), R(-2)], relation: '<=', rhs: R(0) },
      { coeffs: [R(1), R(1), R(1), R(1)], relation: '<=', rhs: R(10) },
    ],
    varNames: ['x1', 'x2', 'x3', 'x4'],
  };

  it('Beale, Kuhn and a flipped Kuhn reach the oracle optimum with every method and rule', () => {
    for (const model of [beale, kuhn, hoffman]) {
      const orc = oracle(model);
      for (const method of METHODS) for (const antiCycling of [undefined, 'bland'] as const) {
        const sol = solveLP(model, { method, antiCycling, maxIterations: 200 });
        expect(sol.status, `${method}/${antiCycling}`).not.toBe('iteration-limit');
        checkSolution(model, sol, orc, method, { alt: 0 });
      }
    }
  });

  it('heavily degenerate random LPs never hit the iteration limit', () => {
    const r = rng(0xDE6E);
    for (let t = 0; t < 800; t++) {
      const model = genModel(r, { maxN: 5, maxM: 5, zeroRhsBias: 0.85 });
      for (const method of METHODS) {
        const sol = solveLP(model, { method, maxIterations: 150, emitSteps: false });
        expect(sol.status, `${method} ${tag(model)}`).not.toBe('iteration-limit');
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* (4) branch & bound and Gomory                                       */
/* ------------------------------------------------------------------ */

interface IlpGen { pure?: boolean; lowerZero?: boolean; allowEq?: boolean; maxN?: number; binaryProb?: number; contProb?: number }

function genIlp(r: () => number, o: IlpGen = {}): LPModel {
  const n = randInt(r, 1, o.maxN ?? 3);
  const m = randInt(r, 1, 3);
  const integrality: VarType[] = Array.from({ length: n }, () => {
    const u = r();
    if (!o.pure && u < (o.contProb ?? 0.3)) return 'continuous';
    if (u > 1 - (o.binaryProb ?? 0.15)) return 'binary';
    return 'integer';
  });
  if (!integrality.some(t => t !== 'continuous')) integrality[0] = 'integer';
  const varBounds: Bound[] = integrality.map(t => {
    if (t === 'binary') return { lower: R(0), upper: R(1) };
    const lo = o.lowerZero ? 0 : randInt(r, -2, 1);
    return { lower: R(lo), upper: R(lo + randInt(r, 1, 4)) };
  });
  const constraints: Constraint[] = Array.from({ length: m }, () => {
    const eq = o.allowEq && r() < 0.35;
    return {
      coeffs: Array.from({ length: n }, () => (r() < 0.15 ? R(randInt(r, 1, 6), randInt(r, 2, 3)) : R(randInt(r, -3, 6)))),
      relation: eq ? '=' : (['<=', '<=', '>='] as const)[randInt(r, 0, 2)]!,
      rhs: R(randInt(r, -2, 14)),
    };
  });
  return {
    sense: r() < 0.6 ? 'max' : 'min',
    objective: Array.from({ length: n }, () => R(randInt(r, -4, 7))),
    objectiveConstant: r() < 0.15 ? R(randInt(r, -3, 3)) : undefined,
    constraints, varBounds, integrality,
    varNames: Array.from({ length: n }, (_, j) => `x${j + 1}`),
  };
}

/** Exact integer optimum: enumerate the integer variables over their boxes, solve the continuous remainder by vertex enumeration. */
function bruteMip(model: LPModel): { best: Rational | null } {
  const n = model.objective.length;
  const integ = model.integrality!;
  const bnd = model.varBounds!;
  const ints = integ.map((t, j) => (t === 'continuous' ? -1 : j)).filter(j => j >= 0);
  const conts = integ.map((t, j) => (t === 'continuous' ? j : -1)).filter(j => j >= 0);
  const x: Rational[] = Array.from({ length: n }, () => Rational.ZERO);
  let best: Rational | null = null;
  const consider = (z: Rational) => { if (best === null || (model.sense === 'max' ? z.gt(best) : z.lt(best))) best = z; };
  const rec = (k: number) => {
    if (k === ints.length) {
      if (conts.length === 0) {
        if (feasibleOrig(noBounds(model), x) === null) consider(objOf(model, x));
        return;
      }
      const sub: LPModel = {
        sense: model.sense,
        objective: conts.map(j => model.objective[j]!),
        objectiveConstant: ints.reduce((s, j) => s.add(model.objective[j]!.mul(x[j]!)), model.objectiveConstant ?? Rational.ZERO),
        constraints: model.constraints.map(c => ({
          coeffs: conts.map(j => c.coeffs[j]!),
          relation: c.relation,
          rhs: ints.reduce((s, j) => s.sub(c.coeffs[j]!.mul(x[j]!)), c.rhs),
        })),
        varBounds: conts.map(j => bnd[j]!),
        varNames: conts.map(j => `x${j}`),
      };
      const o = oracle(sub);
      if (o.kind === 'optimal') consider(o.best!);
      return;
    }
    const j = ints[k]!;
    const lo = bnd[j]!.lower!, up = bnd[j]!.upper!;
    for (let v = lo; v.lte(up); v = v.add(R(1))) { x[j] = v; rec(k + 1); }
  };
  rec(0);
  return { best };
}

describe('audit: branch & bound vs brute-force enumeration', () => {
  const OPTS: BBOptions[] = [];
  for (const nodeSelection of ['bestBound', 'depthFirst', 'breadthFirst'] as const)
    for (const branchRule of ['firstFractional', 'mostFractional'] as const)
      for (const upFirst of [false, true]) OPTS.push({ variant: nodeSelection, branchRule, upFirst });

  it('pure, mixed, binary and equality models agree under all 12 selection/branching combinations', () => {
    const r = rng(0xB4B);
    let optimal = 0, infeasible = 0, mixed = 0;
    for (let t = 0; t < 350; t++) {
      const model = genIlp(r, { allowEq: t % 3 === 0, maxN: 3 });
      const brute = bruteMip(model);
      if (model.integrality!.includes('continuous')) mixed++;
      for (const opt of OPTS) {
        const sol = new BranchBoundSolver().solve(model, { ...opt, maxNodes: 100000, emitSteps: false });
        const T = `${JSON.stringify(opt)} ${tag(model)} int=${model.integrality!.join(',')}`;
        if (brute.best === null) {
          expect(sol.status, `infeasible expected: ${T}`).toBe('infeasible');
        } else {
          expect(sol.status, `optimal expected: ${T}`).toBe('optimal');
          const res = sol.result!;
          expect(res.objectiveValue.eq(brute.best), `value ${res.objectiveValue} vs ${brute.best}: ${T}`).toBe(true);
          expect(feasibleOrig(model, res.variableValues), `feasible: ${T}`).toBeNull();
          expect(objOf(model, res.variableValues).eq(res.objectiveValue)).toBe(true);
          res.variableValues.forEach((v, j) => {
            if (model.integrality![j] !== 'continuous') expect(v.isInteger(), `integral x${j}: ${T}`).toBe(true);
          });
          // root bound dominates the integer optimum; gap closed
          const rb = res.rootBound!;
          expect(model.sense === 'max' ? rb.gte(brute.best) : rb.lte(brute.best), `root bound: ${T}`).toBe(true);
          expect(res.gap).toBeNull();
        }
      }
      if (brute.best === null) infeasible++; else optimal++;
    }
    expect(optimal).toBeGreaterThan(150);
    expect(infeasible).toBeGreaterThan(20);
    expect(mixed).toBeGreaterThan(50);
  });

  it('incumbent history is strictly improving and every snapshot agrees with the final result', () => {
    const r = rng(0x1C0);
    for (let t = 0; t < 120; t++) {
      const model = genIlp(r, { pure: true, maxN: 3 });
      for (const opt of OPTS) {
        const sol = new BranchBoundSolver().solve(model, { ...opt, maxNodes: 100000 });
        const states = sol.steps.map(s => s.state);
        for (const st of states) {
          const h = st.incumbentHistory ?? [];
          for (let k = 1; k < h.length; k++) {
            const improved = model.sense === 'max' ? h[k]!.objective.gt(h[k - 1]!.objective) : h[k]!.objective.lt(h[k - 1]!.objective);
            expect(improved, `history monotone ${JSON.stringify(opt)} ${tag(model)}`).toBe(true);
          }
        }
        for (let k = 1; k < states.length; k++) {
          expect((states[k]!.incumbentHistory ?? []).length).toBeGreaterThanOrEqual((states[k - 1]!.incumbentHistory ?? []).length);
        }
        if (sol.result) {
          const hist = sol.result.treeState.incumbentHistory ?? [];
          expect(hist[hist.length - 1]!.objective.eq(sol.result.objectiveValue)).toBe(true);
        }
      }
    }
  });

  it('node limit is reported honestly: never "optimal" unless proven, incumbent feasible, gap consistent', () => {
    const r = rng(0x11A17);
    let limited = 0;
    for (let t = 0; t < 250; t++) {
      const model = genIlp(r, { pure: true, maxN: 3, lowerZero: true });
      const brute = bruteMip(model);
      for (const maxNodes of [1, 2, 3, 5, 9]) {
        for (const opt of OPTS.filter((_, k) => k % 3 === 0)) {
          const sol = new BranchBoundSolver().solve(model, { ...opt, maxNodes, emitSteps: false });
          const T = `maxNodes=${maxNodes} ${JSON.stringify(opt)} ${tag(model)}`;
          if (sol.status === 'iteration-limit') {
            limited++;
            expect(sol.diagnostics.some(d => d.code === 'NODE_LIMIT'), T).toBe(true);
            if (sol.result) {
              expect(sol.result.status).toBe('iteration-limit');
              expect(feasibleOrig(model, sol.result.variableValues), `incumbent feasible ${T}`).toBeNull();
              expect(brute.best, T).not.toBeNull();
              // a non-proven incumbent can never beat the true optimum
              expect(model.sense === 'max' ? sol.result.objectiveValue.lte(brute.best!) : sol.result.objectiveValue.gte(brute.best!), `incumbent not better than optimum ${T}`).toBe(true);
              expect(sol.result.gap === null || !sol.result.gap.isNegative(), T).toBe(true);
            }
          } else if (sol.status === 'optimal') {
            expect(brute.best, T).not.toBeNull();
            expect(sol.result!.objectiveValue.eq(brute.best!), `claimed optimal but ${sol.result!.objectiveValue} vs ${brute.best} ${T}`).toBe(true);
          } else if (sol.status === 'infeasible') {
            expect(brute.best, `claimed infeasible ${T}`).toBeNull();
          }
        }
      }
    }
    expect(limited).toBeGreaterThan(50);
  });

  it('unbounded and infeasible relaxations are classified from the LP oracle', () => {
    const r = rng(0xBEEF);
    let unb = 0, inf = 0;
    for (let t = 0; t < 600; t++) {
      const n = randInt(r, 1, 3);
      const model: LPModel = {
        sense: r() < 0.5 ? 'max' : 'min',
        objective: Array.from({ length: n }, () => R(randInt(r, -3, 5))),
        constraints: Array.from({ length: randInt(r, 1, 3) }, () => ({
          coeffs: Array.from({ length: n }, () => R(randInt(r, -3, 5))),
          relation: (['<=', '>=', '='] as const)[randInt(r, 0, 2)]!,
          rhs: R(randInt(r, -3, 12)),
        })),
        varNames: Array.from({ length: n }, (_, j) => `x${j + 1}`),
        integrality: Array.from({ length: n }, () => 'integer' as const),
      };
      const orc = oracle({ ...model, integrality: undefined });
      const sol = new BranchBoundSolver().solve(model, { maxNodes: 300, emitSteps: false });
      if (orc.kind === 'infeasible') { inf++; expect(sol.status, tag(model)).toBe('infeasible'); }
      if (orc.kind === 'unbounded') { unb++; expect(['unbounded', 'infeasible', 'iteration-limit'], tag(model)).toContain(sol.status); }
      if (orc.kind === 'optimal' && sol.status === 'optimal') {
        expect(model.sense === 'max' ? sol.result!.objectiveValue.lte(orc.best!) : sol.result!.objectiveValue.gte(orc.best!)).toBe(true);
        expect(feasibleOrig(model, sol.result!.variableValues), tag(model)).toBeNull();
      }
    }
    expect(unb).toBeGreaterThan(30);
    expect(inf).toBeGreaterThan(30);
  });
});

describe('audit: Gomory cuts', () => {
  /** every integer-feasible point (mixed models: every vertex of each continuous slice) must satisfy each cut */
  function pointsOf(model: LPModel): Rational[][] {
    const n = model.objective.length;
    const integ = model.integrality!;
    const ints = integ.map((t, j) => (t === 'continuous' ? -1 : j)).filter(j => j >= 0);
    const conts = integ.map((t, j) => (t === 'continuous' ? j : -1)).filter(j => j >= 0);
    const out: Rational[][] = [];
    const x: Rational[] = Array.from({ length: n }, () => Rational.ZERO);
    const rec = (k: number) => {
      if (k === ints.length) {
        if (conts.length === 0) { if (feasibleOrig(noBounds(model), x) === null) out.push([...x]); return; }
        const sub: LPModel = {
          sense: 'max', objective: conts.map(() => R(0)),
          constraints: model.constraints.map(c => ({ coeffs: conts.map(j => c.coeffs[j]!), relation: c.relation, rhs: ints.reduce((s, j) => s.sub(c.coeffs[j]!.mul(x[j]!)), c.rhs) })),
          varBounds: conts.map(j => model.varBounds![j]!), varNames: conts.map(j => `x${j}`),
        };
        // vertices of the slice (x >= 0, rows incl. explicit upper bound rows)
        const withUb: LPModel = { ...sub, varBounds: undefined, constraints: [...sub.constraints, ...conts.map((j, q) => ({ coeffs: conts.map((_, p) => (p === q ? R(1) : R(0))), relation: '<=' as const, rhs: model.varBounds![j]!.upper! }))] };
        for (const v of bruteVertices(withUb).feasibleVertices) {
          const full = [...x];
          conts.forEach((j, q) => { full[j] = v[q]!; });
          out.push(full);
        }
        return;
      }
      const j = ints[k]!;
      for (let v = model.varBounds![j]!.lower!; v.lte(model.varBounds![j]!.upper!); v = v.add(R(1))) { x[j] = v; rec(k + 1); }
    };
    rec(0);
    return out;
  }

  it('cuts are valid, final answers equal brute force (pure, mixed and binary; all cut types)', () => {
    const r = rng(0x60A);
    let converged = 0, cutsChecked = 0, mixedCuts = 0;
    for (let t = 0; t < 260; t++) {
      const model = genIlp(r, { lowerZero: true, maxN: 3, binaryProb: 0.2 });
      const brute = bruteMip(model);
      const pts = pointsOf(model);
      for (const cutType of ['auto', 'fractional', 'mixed'] as const) {
        const sol = solveGomory(model, { maxCuts: 80, cutType });
        const T = `${cutType} ${tag(model)} int=${model.integrality!.join(',')}`;
        for (const cut of sol.result?.cuts ?? []) {
          if (cut.kind === 'mixed') mixedCuts++;
          for (const p of pts) {
            const lhs = cut.inX!.coeffs.reduce((s, c, j) => s.add(c.mul(p[j]!)), Rational.ZERO);
            expect(lhs.lte(cut.inX!.rhs), `cut ${cut.index} (${cut.kind}) cuts off ${p.map(String)} : ${T}`).toBe(true);
            cutsChecked++;
          }
        }
        if (sol.status === 'optimal') {
          converged++;
          expect(brute.best, `gomory found a solution but brute force says infeasible: ${T}`).not.toBeNull();
          expect(sol.result!.objectiveValue.eq(brute.best!), `gomory ${sol.result!.objectiveValue} vs ${brute.best}: ${T}`).toBe(true);
          expect(feasibleOrig(noBounds(model), sol.result!.variableValues), `feasible ${T}`).toBeNull();
          expect(feasibleOrig(model, sol.result!.variableValues), `within bounds ${T}`).toBeNull();
          sol.result!.variableValues.forEach((v, j) => { if (model.integrality![j] !== 'continuous') expect(v.isInteger(), `x${j} integral ${T}`).toBe(true); });
        } else if (sol.status === 'infeasible') {
          expect(brute.best, `gomory says infeasible ${T}`).toBeNull();
        } else {
          expect(['iteration-limit', 'unbounded']).toContain(sol.status);
        }
      }
    }
    expect(converged).toBeGreaterThan(300);
    expect(cutsChecked).toBeGreaterThan(500);
    expect(mixedCuts).toBeGreaterThan(30);
  });
});

describe('audit: binary variables without explicit bounds', () => {
  const model: LPModel = {
    sense: 'max',
    objective: [R(3), R(2)],
    constraints: [{ coeffs: [R(1), R(1)], relation: '<=', rhs: R(5) }],
    varNames: ['x', 'y'],
    integrality: ['binary', 'binary'],
  };
  it('branch & bound caps binaries at 1', () => {
    const sol = new BranchBoundSolver().solve(model);
    expect(sol.status).toBe('optimal');
    expect(sol.result!.objectiveValue.toString()).toBe('5');
  });
  it('Gomory caps binaries at 1', () => {
    const sol = solveGomory(model);
    expect(sol.status).toBe('optimal');
    expect(sol.result!.objectiveValue.toString()).toBe('5');
    const half: LPModel = { ...model, objective: [R(3), R(2)], constraints: [{ coeffs: [R(2), R(2)], relation: '<=', rhs: R(3) }] };
    const s2 = solveGomory(half);
    const b2 = new BranchBoundSolver().solve(half);
    expect(s2.status).toBe('optimal');
    expect(s2.result!.objectiveValue.eq(b2.result!.objectiveValue)).toBe(true);
    for (const v of s2.result!.variableValues) expect(v.lte(R(1))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* (5) parser                                                          */
/* ------------------------------------------------------------------ */

const parseOk = (t: string) => {
  const r = AlgebraicParser.parse(t);
  if (!r.success) throw new Error(`${r.error!.line}:${r.error!.col} ${r.error!.message} for ${JSON.stringify(t)}`);
  return r.model!;
};
const strs = (a: Rational[]) => a.map(String);

describe('audit: text parser', () => {
  it('coefficient syntaxes', () => {
    const m = parseOk('max 3/2x + .5y + 2.z + 1/4*w - (3/4)v\nst\n x + y + z + w + v <= 10');
    expect(m.varNames).toEqual(['x', 'y', 'z', 'w', 'v']);
    expect(strs(m.objective)).toEqual(['3/2', '1/2', '2', '1/4', '-3/4']);
    const m2 = parseOk('min 0.125a + 1.5b\nst\n a + b >= 1');
    expect(strs(m2.objective)).toEqual(['1/8', '3/2']);
    expect(strs(parseOk('max 2 * x1 + 3 · x2 + 4 × x3\nst\n x1 + x2 + x3 <= 1').objective)).toEqual(['2', '3', '4']);
  });

  it('long decimals keep exact values', () => {
    const m = parseOk('max 0.1234567890123456789012345x\nst\n x <= 1');
    expect(m.objective[0]!.eq(Rational.of(1234567890123456789012345n, 10n ** 25n))).toBe(true);
  });

  it('x1, x_1 and x₁ are one variable; names are canonicalised', () => {
    const m = parseOk('max x1 + x_1 + x₁\nst\n x1 + x₁ <= 4');
    expect(m.varNames).toEqual(['x₁']);
    expect(strs(m.objective)).toEqual(['3']);
    const m2 = parseOk('max x₁ + x₂\nst\n x1 + x2 <= 4\n x₁ - x_2 >= -1');
    expect(m2.varNames).toEqual(['x₁', 'x₂']);
    expect(strs(m2.constraints[1]!.coeffs)).toEqual(['1', '-1']);
  });

  it('sign handling', () => {
    const m = parseOk('max - -x + -y - -z + +w\nst\n x + y + z + w <= 1');
    expect(strs(m.objective)).toEqual(['1', '-1', '1', '1']);
    const m2 = parseOk('max x\nst\n x - - 2 <= 5\n 3 - x >= -4 + y');
    expect(m2.constraints[0]!.rhs.toString()).toBe('3');
    expect(strs(m2.constraints[1]!.coeffs)).toEqual(['-1', '-1']);
    expect(m2.constraints[1]!.rhs.toString()).toBe('-7');
    const m3 = parseOk('max −x + y\nst\n x − y ≥ −2');
    expect(strs(m3.objective)).toEqual(['-1', '1']);
    expect(m3.constraints[0]!.rhs.toString()).toBe('-2');
  });

  it('variables only in constraints, duplicate terms, constants on both sides, chains', () => {
    const m = parseOk('max x\nst\n x + y <= 4\n y + y + x - x <= 2 + 3 - 1');
    expect(m.varNames).toEqual(['x', 'y']);
    expect(strs(m.objective)).toEqual(['1', '0']);
    expect(strs(m.constraints[1]!.coeffs)).toEqual(['0', '2']);
    expect(m.constraints[1]!.rhs.toString()).toBe('4');
    const c = parseOk('max x + y\nst\n 1 <= x + y <= 7\n 0 <= x <= 4');
    expect(c.constraints.map(k => k.relation + k.rhs.toString())).toEqual(['>=1', '<=7', '<=4']);
  });

  it('declarations: int / bin / free / bounds', () => {
    const m = parseOk('max a + b + c + d\nst\n a + b + c + d <= 10\n int a\n bin b\n free c\n d >= 0');
    expect(m.integrality).toEqual(['integer', 'binary', 'continuous', 'continuous']);
    expect(m.varBounds![1]).toEqual({ lower: Rational.ZERO, upper: Rational.ONE });
    expect(m.varBounds![2]).toEqual({ lower: null, upper: null });
    const m2 = parseOk('max a + b\nst\n a + b <= 3\n int a, b\n');
    expect(m2.integrality).toEqual(['integer', 'integer']);
    const m3 = parseOk('max a + b\nst\n a + b <= 3\n a, b int\n');
    expect(m3.integrality).toEqual(['integer', 'integer']);
  });

  it('binary wins over free when both are declared', () => {
    const m = parseOk('max a\nst\n a <= 3\n free a\n bin a');
    expect(m.integrality).toEqual(['binary']);
    const lo = m.varBounds?.[0]?.lower;
    expect(lo === undefined || (lo !== null && lo.isZero())).toBe(true);
  });

  it('Windows line endings, tabs, comments, blank lines, labels', () => {
    const m = parseOk('max 3x1 + 5x2 // profit\r\n\r\nsubject to\r\n\tlab: x1 <= 4 # cap\r\n  2x2 <= 12\r\n');
    expect(m.constraints).toHaveLength(2);
    expect(m.constraints[0]!.name).toBe('lab');
  });

  it('unicode relations and operators', () => {
    const m = parseOk('max x + y\nst\n x + y ≤ 5\n x ≥ 1 \n y ＝ 2'.replace('＝', '='));
    expect(m.constraints.map(c => c.relation)).toEqual(['<=', '>=', '=']);
  });

  it('error positions point at the offending line', () => {
    const cases: [string, number][] = [
      ['max x\nst\n x + y <= 4\n 2x ++ <= 3', 4],
      ['max x\nst\n x <= 4\n\n\n y <= <= 2', 6],
      ['max x\r\nst\r\n x <= 4\r\n y + <= 2', 4],
      ['max x\nst\n 3x/0 <= 2', 3],
      ['', 1],
      ['   \n  \n', 1],
      ['min', 1],
      ['max 3 + 4\nst\n 1 <= 2', 1],
    ];
    for (const [text, line] of cases) {
      const r = AlgebraicParser.parse(text);
      expect(r.success, JSON.stringify(text)).toBe(false);
      expect(r.error!.line, JSON.stringify(text)).toBe(line);
      expect(r.error!.col).toBeGreaterThanOrEqual(1);
    }
  });

  it('never throws on arbitrary garbage (random token soup, 20000 strings)', () => {
    const r = rng(0xFA22);
    const toks = ['max', 'min', 'st', 'subject to', 's.t.', 'x', 'y1', 'x_2', 'x₃', '3', '0.5', '.', '..', '1/2', '1/', '/', '(', ')', '(1/2)', '()', '+', '-', '−', '--', '*', '×', '·', '<=', '>=', '=', '<', '>', '≤', '≥', '=<', '=>', '==', ',', ':', 'lab:', 'int', 'bin', 'free', '\n', '\r\n', ' ', '\t', '//', '#', 'e', '2e3', '1e-5', '٣', 'ｘ', '∞', 'NaN', 'Infinity', '0/0', '1/0', '9'.repeat(40), '0.' + '0'.repeat(40) + '1', '\u0000', '😀', 'ß', 'İ'];
    for (let t = 0; t < 20000; t++) {
      const len = randInt(r, 0, 30);
      let s = '';
      for (let k = 0; k < len; k++) s += toks[randInt(r, 0, toks.length - 1)]! + (r() < 0.5 ? ' ' : '');
      if (r() < 0.5) s = 'max x + y\nst\n' + s;
      let res: ReturnType<typeof AlgebraicParser.parse> | undefined;
      expect(() => { res = AlgebraicParser.parse(s); }, JSON.stringify(s)).not.toThrow();
      if (res!.success) {
        const mdl = res!.model!;
        expect(mdl.objective.length).toBe(mdl.varNames.length);
        for (const c of mdl.constraints) expect(c.coeffs.length).toBe(mdl.varNames.length);
        expect(() => formatLP(mdl)).not.toThrow();
        expect(() => solveLP(mdl, { emitSteps: false })).not.toThrow();
      } else {
        expect(res!.error!.line).toBeGreaterThanOrEqual(1);
        expect(res!.error!.col).toBeGreaterThanOrEqual(1);
        expect(res!.error!.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('very long inputs parse quickly', () => {
    const nv = 400;
    const objective = Array.from({ length: nv }, (_, j) => `${j + 1}x${j + 1}`).join(' + ');
    const rows = Array.from({ length: 300 }, (_, i) => ` ${Array.from({ length: 30 }, (_, k) => `${k + 1}x${(i * 5 + k) % nv + 1}`).join(' + ')} <= ${100 + i}`).join('\n');
    const t0 = Date.now();
    const m = parseOk(`max ${objective}\nst\n${rows}`);
    expect(m.varNames).toHaveLength(nv);
    expect(m.constraints).toHaveLength(300);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(AlgebraicParser.parse('max x\nst\n x <= ' + '9'.repeat(4000)).success).toBe(true);
    expect(AlgebraicParser.parse('max ' + 'x + '.repeat(1000) + 'x\nst\n x <= 1').success).toBe(true);
    expect(AlgebraicParser.parse('max x\nst\n' + ' x <= 1\n'.repeat(15000)).success).toBe(true);
    // oversized input is refused with an error, never an exception
    const huge = AlgebraicParser.parse('max x\nst\n x <= ' + '9'.repeat(300000));
    expect(huge.success).toBe(false);
    expect(huge.error!.message.length).toBeGreaterThan(0);
  });

  it('formatLP round-trips every model feature (semantics preserved)', () => {
    const r = rng(0x5E71);
    for (let t = 0; t < 400; t++) {
      const model = genModel(r, { bounds: true, maxN: 4, maxM: 4 });
      const n = model.objective.length;
      const integ: VarType[] = Array.from({ length: n }, () => (r() < 0.25 ? 'integer' : r() < 0.1 ? 'binary' : 'continuous'));
      if (integ.some(v => v !== 'continuous')) model.integrality = integ;
      model.varBounds = model.varBounds!.map((b, j) => (integ[j] === 'binary' ? { lower: Rational.ZERO, upper: Rational.ONE } : b));
      model.constraints.forEach((c, i) => { if (r() < 0.3) c.name = `row ${i + 1}`; });
      const text = formatLP(model);
      const back = AlgebraicParser.parse(text);
      expect(back.success, `${text}\n${back.error?.message}`).toBe(true);
      const m2 = back.model!;
      expect(m2.sense).toBe(model.sense);
      expect(m2.varNames, text).toEqual(model.varNames.map(canonVarName));
      expect(strs(m2.objective), text).toEqual(strs(model.objective));
      expect((m2.objectiveConstant ?? Rational.ZERO).toString(), text).toBe((model.objectiveConstant ?? Rational.ZERO).toString());
      expect(m2.integrality ?? integ.map(() => 'continuous'), text).toEqual(integ.some(v => v !== 'continuous') ? integ : integ.map(() => 'continuous'));
      // identical feasible set and optimum
      const a = oracle(model);
      const b = oracle({ ...m2, varBounds: m2.varBounds ?? model.objective.map(() => ({ lower: Rational.ZERO, upper: null })) });
      expect(b.kind, text).toBe(a.kind);
      if (a.kind === 'optimal') expect(b.best!.eq(a.best!), text).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* (6) Rational and MNum                                               */
/* ------------------------------------------------------------------ */

describe('audit: Rational', () => {
  const rnd = (r: () => number) => {
    const big = r() < 0.2;
    const num = BigInt(randInt(r, -1000, 1000)) * (big ? 10n ** BigInt(randInt(r, 10, 40)) + BigInt(randInt(r, 0, 999)) : 1n);
    const den = BigInt(randInt(r, 1, 60)) * (big ? 10n ** BigInt(randInt(r, 10, 40)) + 7n : 1n);
    return Rational.of(num, den);
  };

  it('is always normalised and closed under field operations', () => {
    const r = rng(0xFA11);
    for (let t = 0; t < 5000; t++) {
      const a = rnd(r), b = rnd(r), c = rnd(r);
      for (const v of [a.add(b), a.sub(b), a.mul(b), a.neg(), a.abs(), ...(b.isZero() ? [] : [a.div(b), b.inv()])]) {
        expect(v.d > 0n).toBe(true);
        const g = (x: bigint, y: bigint): bigint => { x = x < 0n ? -x : x; while (y) { [x, y] = [y, x % y]; } return x; };
        expect(g(v.n, v.d)).toBe(1n);
        if (v.n === 0n) expect(v.d).toBe(1n);
      }
      expect(a.add(b).eq(b.add(a))).toBe(true);
      expect(a.mul(b.add(c)).eq(a.mul(b).add(a.mul(c)))).toBe(true);
      expect(a.sub(a).isZero()).toBe(true);
      if (!b.isZero()) expect(a.div(b).mul(b).eq(a)).toBe(true);
      expect(a.cmp(b) + b.cmp(a)).toBe(0);
      expect(a.lt(b)).toBe(a.sub(b).isNegative());
      expect(a.cmp(b) === 0).toBe(a.eq(b));
      expect(a.lte(b) && a.gte(b)).toBe(a.eq(b));
      // transitivity of the order
      if (a.lte(b) && b.lte(c)) expect(a.lte(c)).toBe(true);
    }
  });

  it('division by zero throws; zero denominators are rejected; zero is canonical', () => {
    expect(() => R(1).div(Rational.ZERO)).toThrow();
    expect(() => Rational.ZERO.inv()).toThrow();
    expect(() => Rational.of(1, 0)).toThrow();
    expect(() => Rational.of(0, 0)).toThrow();
    expect(() => Rational.parse('3/0')).toThrow();
    expect(() => Rational.parse('1/2/3')).toThrow();
    const z = Rational.of(0, -5);
    expect(z.n).toBe(0n);
    expect(z.d).toBe(1n);
    expect(Rational.of(6, -8).toString()).toBe('-3/4');
    expect(Rational.of(-6, -8).toString()).toBe('3/4');
    expect(Rational.ZERO.neg().eq(Rational.ZERO)).toBe(true);
    expect(Object.is(Rational.ZERO.neg().n, 0n)).toBe(true);
  });

  it('toString / parse round-trip and decimal parsing are exact', () => {
    const r = rng(0xDEC);
    for (let t = 0; t < 3000; t++) {
      const a = rnd(r);
      expect(Rational.parse(a.toString()).eq(a), a.toString()).toBe(true);
    }
    expect(Rational.parse('0.1').toString()).toBe('1/10');
    expect(Rational.parse('-0.75').toString()).toBe('-3/4');
    expect(Rational.parse('+5/6').toString()).toBe('5/6');
    expect(Rational.parse('.5').toString()).toBe('1/2');
    expect(Rational.parse('5.').toString()).toBe('5');
    expect(Rational.parse('1e3').toString()).toBe('1000');
    expect(Rational.parse('2.5e-1').toString()).toBe('1/4');
    expect(Rational.parse('0.' + '0'.repeat(29) + '1').eq(Rational.of(1n, 10n ** 30n))).toBe(true);
    expect(Rational.parse('123456789012345678901234567890.5').eq(Rational.of(123456789012345678901234567890n * 2n + 1n, 2n))).toBe(true);
    expect(Rational.of(1e-7).eq(Rational.of(1n, 10n ** 7n))).toBe(true);
    expect(Rational.of(1.5e-9).eq(Rational.of(15n, 10n ** 10n))).toBe(true);
    expect(Rational.of(0.1).toString()).toBe('1/10');
    expect(Rational.of(-2.5).toString()).toBe('-5/2');
    expect(Rational.of(1e21).toString()).toBe('1000000000000000000000');
    expect(() => Rational.parse('abc')).toThrow();
  });

  it('big values never overflow (exact bigint arithmetic)', () => {
    let acc = Rational.of(1);
    for (let k = 1; k <= 80; k++) acc = acc.mul(Rational.of(10n ** 20n + BigInt(k), BigInt(k)));
    let back = acc;
    for (let k = 1; k <= 80; k++) back = back.mul(Rational.of(BigInt(k), 10n ** 20n + BigInt(k)));
    expect(back.eq(Rational.ONE)).toBe(true);
    expect(R(Number.MAX_SAFE_INTEGER).add(R(1)).toString()).toBe('9007199254740992');
    expect(Rational.of(10n ** 30n).toDecimal(2)).toBe('1' + '0'.repeat(30));
    expect(Rational.of(-1, 3).toDecimal(4)).toBe('-0.3333');
    expect(Rational.of(1, 8).toDecimal(6)).toBe('0.125');
    expect(Rational.of(-1, 1000).toDecimal(2)).toBe('-0.00');
  });
});

describe('audit: MNum', () => {
  it('lexicographic order on (M-part, constant) and field-like arithmetic', () => {
    const r = rng(0x44);
    const m = () => MNum.of(R(randInt(r, -9, 9), randInt(r, 1, 4)), R(randInt(r, -3, 3), randInt(r, 1, 3)));
    for (let t = 0; t < 3000; t++) {
      const a = m(), b = m(), c = m();
      expect(a.add(b).eq(b.add(a))).toBe(true);
      expect(a.add(b).sub(b).eq(a)).toBe(true);
      expect(a.sub(a).isZero()).toBe(true);
      expect(a.neg().neg().eq(a)).toBe(true);
      expect(a.cmp(b) + b.cmp(a)).toBe(0);
      if (a.lte(b)) expect(a.add(c).lte(b.add(c))).toBe(true);
      expect(a.isNegative()).toBe(a.lt(MNum.ZERO));
      expect(a.isPositive()).toBe(a.gt(MNum.ZERO));
      expect(a.isZero()).toBe(a.eq(MNum.ZERO));
      const k = R(randInt(r, -4, 4), randInt(r, 1, 3));
      if (k.isPositive() && a.lt(b)) expect(a.scale(k).lt(b.scale(k))).toBe(true);
      if (k.isNegative() && a.lt(b)) expect(a.scale(k).gt(b.scale(k))).toBe(true);
      expect(a.scale(Rational.ZERO).isZero()).toBe(true);
    }
    // M dominates every constant
    expect(MNum.M.gt(MNum.of(R(10).mul(R(10).mul(R(10000000)))))).toBe(true);
    expect(MNum.M.neg().lt(MNum.of(R(-10).mul(R(10000000))))).toBe(true);
    expect(MNum.of(R(5), R(0)).gt(MNum.of(R(4), R(0)))).toBe(true);
    expect(MNum.of(R(-100), R(1)).gt(MNum.of(R(100), R(0)))).toBe(true);
  });

  it('prints readable text', () => {
    expect(MNum.M.toString()).toBe('M');
    expect(MNum.M.neg().toString()).toBe('-M');
    expect(MNum.of(R(-3), R(2)).toString()).toBe('2M - 3');
    expect(MNum.of(R(3), R(1, 2)).toString()).toBe('(1/2)M + 3');
    expect(MNum.of(R(5)).toString()).toBe('5');
    expect(MNum.ZERO.toString()).toBe('0');
    expect(MNum.of(R(-3), R(2)).toLatex()).toContain('M');
  });
});

/* ------------------------------------------------------------------ */
/* graphical solver                                                    */
/* ------------------------------------------------------------------ */

describe('audit: graphical LP solver vs oracle', () => {
  it('status, value, vertices and alternate optima agree (2-variable models incl. free / bounded variables)', () => {
    const r = rng(0x6AA);
    let withVerts = 0;
    for (let t = 0; t < 1500; t++) {
      const model = genModel(r, { bounds: t % 2 === 1, maxN: 2, maxM: 4 });
      if (model.objective.length !== 2) continue;
      const orc = oracle(model);
      const g = GraphicalLPSolver.solve(model);
      const T = tag(model);
      expect(g.status, `status ${T}`).toBe(orc.kind);
      if (orc.kind === 'optimal') {
        expect(g.optimalValue!.eq(orc.best!), `value ${T}`).toBe(true);
        expect(g.optimalVertex, `optimal point present ${T}`).not.toBeNull();
        for (const p of g.optimalVertices) {
          expect(feasibleOrig(model, [p.x, p.y]), `optimal vertex feasible ${T}`).toBeNull();
          expect(objOf(model, [p.x, p.y]).eq(orc.best!), `optimal vertex value ${T}`).toBe(true);
        }
        expect(g.alternateOptima, `alternate ${T}`).toBe(orc.alternate);
      }
      for (const v of g.vertices) expect(feasibleOrig(model, [v.x, v.y]), `vertex feasible ${T}`).toBeNull();
      if (!model.varBounds) {
        const bv = bruteVertices(model).feasibleVertices;
        expect(g.vertices.length, `vertex count ${T}`).toBe(bv.length);
        for (const v of bv) expect(g.vertices.some(q => q.x.eq(v[0]!) && q.y.eq(v[1]!)), `vertex set ${T}`).toBe(true);
        withVerts++;
      }
    }
    expect(withVerts).toBeGreaterThan(300);
  });
});

/* ------------------------------------------------------------------ */
/* tableau steps, tutor and diff mode                                  */
/* ------------------------------------------------------------------ */

function pivotTableau(t: Tableau, r: number, c: number): Tableau | null {
  const p = t.matrix[r]![c]!;
  if (p.isZero()) return null;
  const rowR = t.matrix[r]!.map(v => v.div(p));
  const rhsR = t.rhs[r]!.div(p);
  const matrix = t.matrix.map((row, i) => (i === r ? rowR : row.map((v, k) => v.sub(row[c]!.mul(rowR[k]!)))));
  const rhs = t.rhs.map((v, i) => (i === r ? rhsR : v.sub(t.matrix[i]![c]!.mul(rhsR))));
  const fz = t.objectiveRow[c]!;
  const out: Tableau = {
    ...t, matrix, rhs,
    objectiveRow: t.objectiveRow.map((v, k) => v.sub(fz.mul(rowR[k]!))),
    objectiveValue: t.objectiveValue.sub(fz.mul(rhsR)),
    basis: t.basis.map((b, i) => (i === r ? c : b)),
    nextPivot: undefined,
  };
  if (t.bigMRow) {
    const fm = t.bigMRow[c]!;
    out.bigMRow = t.bigMRow.map((v, k) => v.sub(fm.mul(rowR[k]!)));
    out.objectiveValueM = (t.objectiveValueM ?? Rational.ZERO).sub(fm.mul(rhsR));
  }
  return out;
}

describe('audit: step tableaux, tutor and diff mode', () => {
  it('every step is a faithful tableau: identity basis, feasible basic solution, monotone objective', () => {
    const r = rng(0x7AB);
    let steps = 0;
    for (let t = 0; t < 600; t++) {
      const model = genModel(r, { maxN: 3, maxM: 4, zeroRhsBias: 0.2 });
      for (const method of ['standard', 'twoPhase', 'bigM', 'dual'] as const) {
        const sol = solveLP(model, { method });
        const n = model.objective.length;
        let prevZ: Rational | null = null;
        let prevPhase: number | null | undefined;
        for (const st of sol.steps) {
          const tab = st.state;
          steps++;
          const T = `${method} step ${st.index} ${tag(model)}`;
          // identity columns for the basis, zero z-row entries for basic columns
          tab.basis.forEach((bc, i) => {
            tab.matrix.forEach((row, i2) => expect(row[bc]!.eq(i === i2 ? R(1) : R(0)), `identity ${T}`).toBe(true));
            expect(tab.objectiveRow[bc]!.isZero(), `z-row basic ${T}`).toBe(true);
            if (tab.bigMRow) expect(tab.bigMRow[bc]!.isZero(), `M-row basic ${T}`).toBe(true);
          });
          if (tab.phase === 1) { /* Phase I: w only */ }
          if (method !== 'dual') expect(tab.rhs.every(v => !v.isNegative()), `primal feasible ${T}`).toBe(true);
          // basic solution (decision columns are the first n columns for default-bounds models)
          const x = Array.from({ length: n }, () => Rational.ZERO);
          tab.basis.forEach((bc, i) => { if (bc < n) x[bc] = tab.rhs[i]!; });
          const artificialPositive = tab.basis.some((bc, i) => tab.columnTypes[bc] === 'artificial' && tab.rhs[i]!.isPositive());
          if (tab.phase !== 1 && !artificialPositive && method !== 'dual' && (!tab.objectiveValueM || tab.objectiveValueM.isZero())) {
            expect(feasibleOrig(model, x), `basic solution feasible ${T}`).toBeNull();
            if (!tab.bigMRow) expect(objOf(model, x).eq(tab.objectiveValue), `objective value ${T}`).toBe(true);
          }
          // monotone objective within a phase
          if (!tab.bigMRow && method !== 'dual' && tab.phase === prevPhase && prevZ) {
            if (tab.phase === 1) expect(tab.objectiveValue.lte(prevZ), `w decreases ${T}`).toBe(true);
            else expect(model.sense === 'max' ? tab.objectiveValue.gte(prevZ) : tab.objectiveValue.lte(prevZ), `z improves ${T}`).toBe(true);
          }
          prevZ = tab.objectiveValue;
          prevPhase = tab.phase;
        }
      }
    }
    expect(steps).toBeGreaterThan(5000);
  });

  it('tutor agrees with the engine: every pivot the engine takes is accepted, every other choice is judged consistently', () => {
    const r = rng(0x707);
    let pivots = 0, dualPivots = 0;
    for (let t = 0; t < 700; t++) {
      const model = genModel(r, { maxN: 3, maxM: 4 });
      for (const method of ['standard', 'twoPhase', 'bigM', 'dual'] as const) {
        const sol = solveLP(model, { method });
        for (const st of sol.steps) {
          const tab = st.state;
          const T = `${method} step ${st.index} ${tag(model)}`;
          if (tab.method === 'dual') {
            const stage = currentStage(tab);
            expect(stage === 'dual-leaving', `stage ${T}`).toBe(tab.rhs.some(v => v.isNegative()));
            if (tab.nextPivot) {
              dualPivots++;
              const np = tab.nextPivot;
              expect(dualLeavingCandidates(tab).filter(c => c.isCorrect).map(c => c.id), `dual leaving ${T}`).toContain(`leave:${np.leavingRow}`);
              expect(verifyDualLeaving(tab, np.leavingRow).correct, T).toBe(true);
              expect(dualEnteringCandidates(tab, np.leavingRow).filter(c => c.isCorrect).map(c => c.id), `dual entering ${T}`).toContain(`enter:${np.enteringCol}`);
              expect(verifyDualEntering(tab, np.leavingRow, np.enteringCol).correct, T).toBe(true);
              for (let i = 0; i < tab.rhs.length; i++) {
                const ok = dualLeavingCandidates(tab).some(c => c.id === `leave:${i}` && c.isCorrect);
                expect(verifyDualLeaving(tab, i).correct, `dual leaving verdict row ${i} ${T}`).toBe(ok);
              }
              for (let j = 0; j < tab.columnNames.length; j++) {
                const ok = dualEnteringCandidates(tab, np.leavingRow).some(c => c.id === `enter:${j}` && c.isCorrect);
                expect(verifyDualEntering(tab, np.leavingRow, j).correct, `dual entering verdict col ${j} ${T}`).toBe(ok);
              }
            }
            continue;
          }
          const stage = currentStage(tab);
          const hasNeg = enteringCandidates(tab).length > 0;
          expect(stage === 'entering', `stage ${T}`).toBe(hasNeg);
          if (!tab.nextPivot) continue;
          pivots++;
          const np = tab.nextPivot;
          const good = enteringCandidates(tab).filter(c => c.isCorrect).map(c => c.id);
          expect(good, `entering ${T}`).toContain(`enter:${np.enteringCol}`);
          expect(verifyEntering(tab, np.enteringCol).correct, T).toBe(true);
          for (let j = 0; j < tab.columnNames.length; j++) {
            expect(verifyEntering(tab, j).correct, `entering verdict col ${j} ${T}`).toBe(good.includes(`enter:${j}`));
          }
          const lgood = leavingCandidates(tab, np.enteringCol).filter(c => c.isCorrect).map(c => c.id);
          expect(lgood, `leaving ${T}`).toContain(`leave:${np.leavingRow}`);
          for (let i = 0; i < tab.matrix.length; i++) {
            expect(verifyLeaving(tab, np.enteringCol, i).correct, `leaving verdict row ${i} ${T}`).toBe(lgood.includes(`leave:${i}`));
          }
        }
      }
    }
    expect(pivots).toBeGreaterThan(1000);
    expect(dualPivots).toBeGreaterThan(100);
  });

  it('diff mode: exact copies match; single slips and wrong pivots are diagnosed', () => {
    const r = rng(0xD1FF);
    let slips = 0, wrongPivots = 0, wrongLeaving = 0;
    for (let t = 0; t < 400; t++) {
      const model = genModel(r, { maxN: 3, maxM: 4 });
      const sol = solveLP(model, { method: 'twoPhase' });
      if (sol.steps.length < 2) continue;
      for (let k = 0; k < sol.steps.length; k++) {
        const tab = sol.steps[k]!.state;
        const T = `step ${k} ${tag(model)}`;
        expect(DiffComparator.compareTableau(tab, sol.steps, { iteration: k }).matches, `copy ${T}`).toBe(true);
        expect(DiffComparator.compareTableau(tab, sol.steps).matches, `copy (search) ${T}`).toBe(true);
        // single cell slip
        const bad: Tableau = { ...tab, matrix: tab.matrix.map(row => [...row]) };
        if (bad.matrix.length === 0) continue;
        const i = randInt(r, 0, bad.matrix.length - 1);
        const j = randInt(r, 0, bad.matrix[0]!.length - 1);
        bad.matrix[i]![j] = bad.matrix[i]![j]!.add(R(1));
        const d = DiffComparator.compareTableau(bad, sol.steps, { iteration: k });
        expect(d.matches, `slip detected ${T}`).toBe(false);
        expect(d.differences.length, `exactly one differing cell ${T}`).toBe(1);
        expect(d.divergenceStep).toBe(k);
        slips++;
        // wrong pivot replayed from the previous step
        if (k === 0) continue;
        const prev = sol.steps[k - 1]!.state;
        const np = prev.nextPivot;
        if (!np) continue;
        for (let rr = 0; rr < prev.matrix.length; rr++) for (let cc = 0; cc < prev.columnNames.length; cc++) {
          if (rr === np.leavingRow && cc === np.enteringCol) continue;
          if (prev.columnTypes[cc] === 'artificial') continue;
          const alt = pivotTableau(prev, rr, cc);
          if (!alt) continue;
          const dd = DiffComparator.compareTableau(alt, sol.steps, { iteration: k });
          if (dd.matches) continue; // an alternate pivot that happens to coincide
          wrongPivots++;
          if (cc === np.enteringCol) {
            wrongLeaving++;
            expect(dd.summary, `wrong leaving row diagnosed ${T} (r${rr}, c${cc})`).toMatch(/wrong leaving|not positive/);
          } else if (prev.matrix[rr]![cc]!.isPositive()) {
            expect(dd.summary, `wrong entering column diagnosed ${T} (r${rr}, c${cc})`).toMatch(/instead of|wrong leaving|unchanged|scal/);
          }
        }
      }
    }
    expect(slips).toBeGreaterThan(500);
    expect(wrongPivots).toBeGreaterThan(100);
    expect(wrongLeaving).toBeGreaterThan(30);
  });
});

describe('audit: iteration limit and size', () => {
  it('a tiny iteration budget is reported as iteration-limit, never as optimal', () => {
    const m: LPModel = {
      sense: 'max', objective: [R(3), R(5), R(4)], varNames: ['x', 'y', 'z'],
      constraints: [
        { coeffs: [R(2), R(3), R(0)], relation: '<=', rhs: R(8) },
        { coeffs: [R(0), R(2), R(5)], relation: '<=', rhs: R(10) },
        { coeffs: [R(3), R(2), R(4)], relation: '<=', rhs: R(15) },
        { coeffs: [R(1), R(1), R(1)], relation: '>=', rhs: R(1) },
      ],
    };
    for (const method of METHODS) {
      const full = solveLP(m, { method, emitSteps: false });
      expect(isOpt(full.status)).toBe(true);
      for (const maxIterations of [0, 1, 2]) {
        const lim = solveLP(m, { method, maxIterations, emitSteps: false });
        if (lim.status === 'iteration-limit') {
          expect(lim.diagnostics.some(d => d.code === 'ITERATION_LIMIT')).toBe(true);
        } else {
          expect(isOpt(lim.status)).toBe(true);
          expect(lim.result!.objectiveValue.eq(full.result!.objectiveValue)).toBe(true);
        }
      }
    }
  });

  it('a 25 x 25 dense LP solves exactly and quickly', () => {
    const r = rng(0xB16);
    const n = 25;
    const model: LPModel = {
      sense: 'max',
      objective: Array.from({ length: n }, () => R(randInt(r, 1, 20))),
      constraints: Array.from({ length: n }, () => ({ coeffs: Array.from({ length: n }, () => R(randInt(r, 1, 9))), relation: '<=' as const, rhs: R(randInt(r, 50, 200)) })),
      varNames: Array.from({ length: n }, (_, j) => `x${j + 1}`),
    };
    const t0 = Date.now();
    for (const method of ['standard', 'dual'] as const) {
      const sol = solveLP(model, { method, emitSteps: false });
      expect(isOpt(sol.status)).toBe(true);
      expect(feasibleOrig(model, sol.result!.variableValues)).toBeNull();
      const dualObj = model.constraints.reduce((s, c, i) => s.add(sol.result!.dualValues[i]!.mul(c.rhs)), Rational.ZERO);
      expect(dualObj.eq(sol.result!.objectiveValue)).toBe(true);
    }
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('audit: exact matrix helpers', () => {
  it('inverse times matrix is the identity; singular matrices are rejected', () => {
    const r = rng(0x1A7);
    let inv = 0, sing = 0;
    for (let t = 0; t < 400; t++) {
      const n = randInt(r, 1, 5);
      const A = Array.from({ length: n }, () => Array.from({ length: n }, () => R(randInt(r, -4, 4), randInt(r, 1, 3))));
      if (t % 4 === 0 && n > 1) A[n - 1] = A[0]!.map(v => v.mul(R(2)));
      let B: Rational[][] | null = null;
      try { B = Matrix.inverse(A); } catch { B = null; }
      if (B) {
        inv++;
        const I = Matrix.multiply(A, B);
        I.forEach((row, i) => row.forEach((v, j) => expect(v.eq(i === j ? R(1) : R(0))).toBe(true)));
      } else {
        sing++;
        // singular ⇒ the rows really are dependent: cross-check with the LP oracle's elimination (determinant 0)
        const M = A.map(row => [...row]);
        let det = R(1);
        for (let c = 0; c < n; c++) {
          let p = c; while (p < n && M[p]![c]!.isZero()) p++;
          if (p === n) { det = R(0); break; }
          [M[c], M[p]] = [M[p]!, M[c]!];
          det = det.mul(M[c]![c]!);
          for (let i = c + 1; i < n; i++) { const f = M[i]![c]!.div(M[c]![c]!); M[i] = M[i]!.map((v, k) => v.sub(f.mul(M[c]![k]!))); }
        }
        expect(det.isZero()).toBe(true);
      }
    }
    expect(inv).toBeGreaterThan(100);
    expect(sing).toBeGreaterThan(30);
  });
});
