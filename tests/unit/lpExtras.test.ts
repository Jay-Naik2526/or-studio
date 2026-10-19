import { describe, it, expect } from 'vitest';
import { solveLP } from '../../src/core/solvers/lp/engine';
import { AlgebraicParser } from '../../src/core/parse/algebraic';
import { Rational } from '../../src/core/math/rational';
import { LPModel, Relation } from '../../src/core/types/models';
import { buildDual, dualityReport, SOB_TABLE, isFeasiblePoint, objectiveAt } from '../../src/core/solvers/lp/duality';
import { enumerateBasicSolutions, binomial, MAX_BASES } from '../../src/core/solvers/lp/basicSolutions';
import { solvePrimalDual } from '../../src/core/solvers/lp/primalDual';
import { bruteVertices, randInt, randomLP, rng } from '../helpers/bruteLP';

const parse = (t: string) => {
  const r = AlgebraicParser.parse(t);
  if (!r.success) throw new Error(JSON.stringify(r.error));
  return r.model!;
};
const Q = (n: number) => Rational.of(n);
const isOpt = (s: string) => s === 'optimal' || s === 'optimal-alternate-exists';

type Kind = 'plain' | 'free' | 'nonpos' | 'boxed' | 'lower';

/** Random LP over every sign type; feasible by construction (a point x0 is built in). */
function genModel(r: () => number, opts: { bounds?: boolean } = {}): LPModel {
  const n = randInt(r, 1, 4);
  const m = randInt(r, 1, 4);
  const kinds: Kind[] = Array.from({ length: n }, () => {
    const k = randInt(r, 0, opts.bounds ? 4 : 2);
    return (['plain', 'free', 'nonpos', 'boxed', 'lower'] as const)[k]!;
  });
  const bounds: { lower: Rational | null; upper: Rational | null }[] = [];
  const x0: number[] = [];
  for (const k of kinds) {
    if (k === 'plain') { bounds.push({ lower: Q(0), upper: null }); x0.push(randInt(r, 0, 4)); }
    else if (k === 'free') { bounds.push({ lower: null, upper: null }); x0.push(randInt(r, -4, 4)); }
    else if (k === 'nonpos') { bounds.push({ lower: null, upper: Q(0) }); x0.push(-randInt(r, 0, 4)); }
    else if (k === 'boxed') { const lo = randInt(r, -2, 2); const hi = lo + randInt(r, 1, 5); bounds.push({ lower: Q(lo), upper: Q(hi) }); x0.push(randInt(r, lo, hi)); }
    else { const lo = randInt(r, -3, 3); bounds.push({ lower: Q(lo), upper: null }); x0.push(lo + randInt(r, 0, 4)); }
  }
  const constraints = Array.from({ length: m }, () => {
    const coeffs = Array.from({ length: n }, () => Q(randInt(r, -3, 5)));
    const relation: Relation = (['<=', '>=', '=', '<='] as const)[randInt(r, 0, 3)]!;
    const at = coeffs.reduce((s, a, j) => s + Number(a.toString()) * x0[j]!, 0);
    const slack = randInt(r, 0, 3);
    const rhs = relation === '<=' ? at + slack : relation === '>=' ? at - slack : at;
    return { coeffs, relation, rhs: Q(rhs) };
  });
  return {
    sense: r() < 0.5 ? 'max' : 'min',
    objective: Array.from({ length: n }, () => Q(randInt(r, -5, 8))),
    objectiveConstant: r() < 0.2 ? Q(randInt(r, -3, 3)) : undefined,
    constraints,
    varNames: Array.from({ length: n }, (_, j) => `x${j + 1}`),
    varBounds: bounds.map(b => ({ lower: b.lower, upper: b.upper })),
  };
}

function sameModel(a: LPModel, b: LPModel): string | null {
  if (a.sense !== b.sense) return 'sense';
  if (a.objective.length !== b.objective.length || a.objective.some((c, j) => !c.eq(b.objective[j]!))) return 'objective';
  if (!(a.objectiveConstant ?? Q(0)).eq(b.objectiveConstant ?? Q(0))) return 'constant';
  if (a.constraints.length !== b.constraints.length) return 'row count';
  for (let i = 0; i < a.constraints.length; i++) {
    const x = a.constraints[i]!, y = b.constraints[i]!;
    if (x.relation !== y.relation || !x.rhs.eq(y.rhs) || x.coeffs.some((c, j) => !c.eq(y.coeffs[j]!))) return `row ${i}`;
  }
  const bd = (m: LPModel, j: number) => m.varBounds?.[j] ?? { lower: Q(0), upper: null };
  for (let j = 0; j < a.objective.length; j++) {
    const p = bd(a, j), s = bd(b, j);
    const eqN = (u: Rational | null, v: Rational | null) => (u === null || v === null ? u === v : u.eq(v));
    if (!eqN(p.lower, s.lower) || !eqN(p.upper, s.upper)) return `bounds ${j}`;
  }
  return null;
}

describe('duality — construction', () => {
  it('states the SOB table', () => {
    expect(SOB_TABLE.length).toBeGreaterThan(5);
  });

  it('dual of the Reddy Mikks model is the textbook dual', () => {
    const m = parse('max 5x1 + 4x2\nst\n 6x1 + 4x2 <= 24\n x1 + 2x2 <= 6\n -x1 + x2 <= 1\n x2 <= 2');
    const b = buildDual(m);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.dual.sense).toBe('min');
    expect(b.dual.objective.map(String)).toEqual(['24', '6', '1', '2']);
    expect(b.dual.constraints.map(c => c.relation)).toEqual(['>=', '>=']);
    expect(b.dual.constraints[0]!.rhs.toString()).toBe('5');
    expect(b.dual.constraints[0]!.coeffs.map(String)).toEqual(['6', '1', '-1', '0']);
    expect(b.dualSigns).toEqual(['>=0', '>=0', '>=0', '>=0']);
    expect(b.displayText).toContain('min');
  });

  it('mixed relations and free variables follow the SOB table (min primal)', () => {
    const m = parse('min 2x1 + 3x2 + x3\nst\n x1 + x2 + x3 >= 4\n x1 - x2 <= 2\n x2 + 2x3 = 5\n x1 >= 0\n x2 >= 0\n free x3');
    const b = buildDual(m);
    if (!b.ok) throw new Error('no dual');
    expect(b.dual.sense).toBe('max');
    expect(b.dualSigns).toEqual(['>=0', '<=0', 'free']);
    expect(b.dual.constraints.map(c => c.relation)).toEqual(['<=', '<=', '=']);
  });

  it('dual of the dual equals the (normalised) primal for 600 random models of every sign type', () => {
    const r = rng(11);
    for (let t = 0; t < 600; t++) {
      const model = genModel(r, { bounds: true });
      const b1 = buildDual(model);
      if (!b1.ok) throw new Error('b1');
      const b2 = buildDual(b1.dual);
      if (!b2.ok) throw new Error('b2');
      expect(sameModel(b2.dual, b1.primal), `trial ${t}`).toBeNull();
      // the second "normalised primal" is the first dual, untouched
      expect(sameModel(b2.primal, b1.dual), `trial ${t} (dual unchanged)`).toBeNull();
    }
  });

  it('fails gracefully on an invalid model', () => {
    const bad: LPModel = { sense: 'max', objective: [], constraints: [], varNames: [] };
    expect(buildDual(bad).ok).toBe(false);
    expect(dualityReport(bad).ok).toBe(false);
  });
});

describe('duality — theorems on random LPs', () => {
  it('strong duality, weak duality and complementary slackness hold on 1000 feasible bounded LPs', () => {
    const r = rng(2024);
    let good = 0, tries = 0, withEq = 0, withGe = 0, withFree = 0, mins = 0, maxs = 0, engineDualsOk = 0;
    while (good < 1000 && tries < 8000) {
      tries++;
      const model = genModel(r, { bounds: tries % 3 === 0 });
      const primal = solveLP(model, { emitSteps: false });
      if (!isOpt(primal.status)) continue;
      const rep = dualityReport(model);
      if (!rep.ok) throw new Error('report failed');
      good++;
      expect(rep.primalStatus, `trial ${tries}`).toBe('optimal');
      expect(rep.dualStatus, `trial ${tries}`).toBe('optimal');
      expect(rep.primalValue!.eq(primal.result!.objectiveValue), `value ${tries}`).toBe(true);
      expect(rep.primalValue!.eq(rep.dualValue!), `strong duality ${tries}`).toBe(true);
      for (const c of rep.checks) expect(c.holds, `${c.id} @ ${tries}`).not.toBe(false);
      expect(rep.cs.every(x => x.holds)).toBe(true);
      expect(rep.cs.length).toBe(rep.build.primal.constraints.length + rep.build.primal.objective.length);
      // the primal solution recovered in original variables matches the engine's
      expect(rep.x!.every((v, j) => v.eq(primal.result!.variableValues[j]!)) || primal.status === 'optimal-alternate-exists').toBe(true);
      if (rep.tableauDualsOptimal) engineDualsOk++;
      if (model.constraints.some(c => c.relation === '=')) withEq++;
      if (model.constraints.some(c => c.relation === '>=')) withGe++;
      if (model.varBounds!.some(b => b.lower === null)) withFree++;
      if (model.sense === 'min') mins++; else maxs++;
    }
    expect(good).toBe(1000);
    expect(withEq).toBeGreaterThan(100);
    expect(withGe).toBeGreaterThan(100);
    expect(withFree).toBeGreaterThan(100);
    expect(mins).toBeGreaterThan(100);
    expect(maxs).toBeGreaterThan(100);
    // shadow prices read from the tableau are an optimal dual solution in every case
    expect(engineDualsOk).toBe(good);
  });

  it('primal unbounded ⇒ dual infeasible; primal infeasible ⇒ dual infeasible or unbounded', () => {
    const r = rng(77);
    let unb = 0, inf = 0;
    for (let t = 0; t < 3000 && (unb < 40 || inf < 40); t++) {
      // free-form random models (not built feasible) to hit infeasible/unbounded
      const model = t % 2 ? genModel(r) : randomLP(r);
      const rep = dualityReport(model);
      if (!rep.ok) throw new Error('report');
      if (rep.primalStatus === 'unbounded') { unb++; expect(rep.dualStatus, `t=${t}`).toBe('infeasible'); expect(rep.pairing.consistent).toBe(true); }
      if (rep.primalStatus === 'infeasible') { inf++; expect(['infeasible', 'unbounded']).toContain(rep.dualStatus); expect(rep.pairing.consistent).toBe(true); }
      if (rep.dualStatus === 'unbounded') expect(rep.primalStatus).toBe('infeasible');
      expect(rep.allHold, `t=${t} ${rep.pairing.text}`).toBe(true);
    }
    expect(unb).toBeGreaterThanOrEqual(40);
    expect(inf).toBeGreaterThanOrEqual(40);
  });

  it('explains the textbook pairing outcomes in words', () => {
    const unb = dualityReport(parse('max 2x1 + x2\nst\n x1 - x2 <= 10'));
    const inf = dualityReport(parse('max x1 + x2\nst\n x1 + x2 <= 2\n x1 + x2 >= 5'));
    if (!unb.ok || !inf.ok) throw new Error('report');
    expect(unb.primalStatus).toBe('unbounded');
    expect(unb.dualStatus).toBe('infeasible');
    expect(unb.pairing.text).toMatch(/unbounded primal/);
    expect(inf.primalStatus).toBe('infeasible');
    expect(inf.pairing.text).toMatch(/infeasible/);
  });

  it('shadow prices of Reddy Mikks: 3/4 and 1/2 on the two materials', () => {
    const rep = dualityReport(parse('max 5x1 + 4x2\nst\n 6x1 + 4x2 <= 24\n x1 + 2x2 <= 6\n -x1 + x2 <= 1\n x2 <= 2'));
    if (!rep.ok) throw new Error('report');
    expect(rep.y!.map(String)).toEqual(['3/4', '1/2', '0', '0']);
    expect(rep.dualValue!.toString()).toBe('21');
    expect(rep.tableauDualsEqualDualOptimum).toBe(true);
  });
});

describe('basic solutions', () => {
  it('worked example: Reddy Mikks has C(6,4)=15 candidate bases', () => {
    const m = parse('max 5x1 + 4x2\nst\n 6x1 + 4x2 <= 24\n x1 + 2x2 <= 6\n -x1 + x2 <= 1\n x2 <= 2');
    const res = enumerateBasicSolutions(m);
    if (!res.ok) throw new Error(res.reason);
    expect(res.total).toBe(15);
    expect(res.bases.length).toBe(res.total);
    expect(res.best!.toString()).toBe('21');
    expect(res.vertices.length).toBe(bruteVertices(m).feasibleVertices.length);
    expect(res.counts.singular + res.counts.infeasible + res.counts.feasible).toBe(res.total);
  });

  it('binomial and the 5000-basis limit message', () => {
    expect(binomial(6, 4)).toBe(15n);
    expect(binomial(50, 25) > BigInt(MAX_BASES)).toBe(true);
    const n = 25;
    const model: LPModel = {
      sense: 'max',
      objective: Array.from({ length: n }, () => Q(1)),
      constraints: Array.from({ length: 12 }, (_, i) => ({ coeffs: Array.from({ length: n }, (_, j) => Q(1 + ((i + j) % 3))), relation: '<=' as const, rhs: Q(10) })),
      varNames: Array.from({ length: n }, (_, j) => `x${j + 1}`),
    };
    const res = enumerateBasicSolutions(model);
    expect(res.ok).toBe(false);
    if (!res.ok) { expect(res.tooMany).toBe(true); expect(res.reason).toMatch(/5000/); }
  });

  it('best BFS equals the simplex optimum, and corner points match vertex enumeration (2000 random LPs)', () => {
    const r = rng(5150);
    let compared = 0, twoVar = 0, degenerateSeen = 0, nondegSeen = 0;
    for (let t = 0; t < 2000; t++) {
      const model = t % 4 === 0 ? genModel(r) : randomLP(r);
      // genModel can contain free/boxed variables: skip those for the vertex comparison (BFS of the substituted form)
      const plain = model.varBounds === undefined || model.varBounds.every(b => b.lower !== null && b.lower.isZero() && b.upper === null);
      const sol = solveLP(model, { emitSteps: false });
      const res = enumerateBasicSolutions(model);
      if (!res.ok) {
        // only an inconsistent equality system can fail on these small sizes
        expect(res.tooMany).toBeUndefined();
        expect(sol.status, `t=${t}`).toBe('infeasible');
        continue;
      }
      expect(res.counts.singular + res.counts.infeasible + res.counts.feasible).toBe(res.bases.length);
      if (sol.status === 'infeasible') { expect(res.counts.feasible, `t=${t}`).toBe(0); continue; }
      if (isOpt(sol.status)) {
        expect(res.best, `best exists t=${t}`).not.toBeNull();
        expect(res.best!.eq(sol.result!.objectiveValue), `best BFS = simplex t=${t}`).toBe(true);
        compared++;
      }
      if (plain) {
        const brute = bruteVertices(model);
        expect(res.vertices.length, `corner count t=${t}`).toBe(brute.feasibleVertices.length);
        for (const v of brute.feasibleVertices) expect(res.vertices.some(w => w.point.every((q, k) => q.eq(v[k]!))), `vertex present t=${t}`).toBe(true);
        if (res.m === model.constraints.length) {
          for (const v of brute.feasibleVertices) {
            const tight = model.constraints.filter(c => { const l = c.coeffs.reduce((s, a, k) => s.add(a.mul(v[k]!)), Q(0)); return l.eq(c.rhs); }).length + v.filter(q => q.isZero()).length;
            const vx = res.vertices.find(w => w.point.every((q, k) => q.eq(v[k]!)))!;
            expect(vx.degenerate, `degenerate flag t=${t}`).toBe(tight > model.objective.length);
            if (vx.degenerate) degenerateSeen++; else nondegSeen++;
          }
        }
        if (model.objective.length === 2) twoVar++;
      }
    }
    expect(compared).toBeGreaterThan(200);
    expect(twoVar).toBeGreaterThan(100);
    expect(degenerateSeen).toBeGreaterThan(5);
    expect(nondegSeen).toBeGreaterThan(50);
  });

  it('flags a degenerate vertex (three lines through one corner)', () => {
    const m = parse('max x1 + x2\nst\n x1 + x2 <= 4\n x1 <= 4\n x2 <= 4\n x1 + 2x2 <= 8');
    const res = enumerateBasicSolutions(m);
    if (!res.ok) throw new Error(res.reason);
    expect(res.counts.degenerate).toBeGreaterThan(0);
    const corner = res.vertices.find(v => v.point[0]!.toString() === '0' && v.point[1]!.toString() === '4');
    expect(corner?.degenerate).toBe(true);
  });

  it('survives redundant equations and contradictory ones', () => {
    const red = enumerateBasicSolutions(parse('max x1 + x2\nst\n x1 + x2 = 4\n 2x1 + 2x2 = 8\n x1 <= 3'));
    expect(red.ok).toBe(true);
    if (red.ok) expect(red.best!.toString()).toBe('4');
    const bad = enumerateBasicSolutions(parse('max x1 + x2\nst\n x1 + x2 = 4\n 2x1 + 2x2 = 9'));
    expect(bad.ok).toBe(false);
  });
});

describe('primal–dual algorithm', () => {
  it('textbook minimisation with ≥ rows', () => {
    const m = parse('min 3x1 + 2x2\nst\n 3x1 + x2 >= 3\n 4x1 + 3x2 >= 6\n x1 + x2 <= 3');
    const res = solvePrimalDual(m);
    expect(res.status).toBe('optimal');
    expect(res.objective!.toString()).toBe('21/5');
    expect(res.x!.map(String)).toEqual(['3/5', '6/5']);
    expect(res.steps.length).toBeGreaterThan(3);
    expect(res.steps[res.steps.length - 1]!.status).toBe('optimal');
    expect(res.steps.map(s => s.index)).toEqual(res.steps.map((_, i) => i));
  });

  it('starts from a helper dual point when a cost is negative, and reports no start for an unbounded problem', () => {
    const a = solvePrimalDual(parse('min -x1 + x2\nst\n x1 + x2 >= 1\n x1 - x2 <= 2\n x2 <= 3'));
    const ref = solveLP(parse('min -x1 + x2\nst\n x1 + x2 >= 1\n x1 - x2 <= 2\n x2 <= 3'));
    if (isOpt(ref.status)) { expect(a.status).toBe('optimal'); expect(a.objective!.eq(ref.result!.objectiveValue)).toBe(true); }
    const u = solvePrimalDual(parse('max 2x1 + x2\nst\n x1 - x2 <= 10'));
    expect(u.status).toBe('no-dual-start');
    expect(u.message).toMatch(/dual/);
  });

  it('detects an infeasible primal through an unbounded dual', () => {
    const res = solvePrimalDual(parse('min x1 + x2\nst\n x1 + x2 <= 2\n x1 + x2 >= 5'));
    expect(res.status).toBe('infeasible');
    expect(res.steps[res.steps.length - 1]!.status).toBe('infeasible');
  });

  it('matches the simplex optimum on 1500 random problems and always terminates', () => {
    const r = rng(9001);
    let optimal = 0, infeasible = 0, noStart = 0, maxSteps = 0;
    for (let t = 0; t < 1500; t++) {
      const model = t % 2 ? genModel(r, { bounds: t % 4 === 1 }) : randomLP(r);
      const ref = solveLP(model, { emitSteps: false });
      const pd = solvePrimalDual(model);
      expect(['iteration-limit', 'cycling', 'invalid'], `t=${t} ${pd.message}`).not.toContain(pd.status);
      maxSteps = Math.max(maxSteps, pd.steps.length);
      expect(pd.steps.length).toBeLessThan(400);
      if (isOpt(ref.status)) {
        expect(pd.status, `t=${t} ${pd.message}`).toBe('optimal');
        expect(pd.objective!.eq(ref.result!.objectiveValue), `objective t=${t}: ${pd.objective?.toString()} vs ${ref.result!.objectiveValue.toString()}`).toBe(true);
        // the returned x is feasible and attains the optimum
        expect(isFeasiblePoint(model, pd.x!), `x feasible t=${t}`).toBe(true);
        expect(objectiveAt(model, pd.x!).eq(pd.objective!)).toBe(true);
        optimal++;
      } else if (ref.status === 'infeasible') {
        expect(['infeasible', 'no-dual-start'], `t=${t}`).toContain(pd.status);
        infeasible++;
      } else {
        expect(pd.status, `t=${t} unbounded`).toBe('no-dual-start');
        noStart++;
      }
      expect(pd.steps[pd.steps.length - 1]!.status === 'continue').toBe(false);
    }
    expect(optimal).toBeGreaterThanOrEqual(500);
    expect(infeasible + noStart).toBeGreaterThan(20);
    expect(maxSteps).toBeGreaterThan(5);
  });

  it('every iteration strictly raises the dual objective', () => {
    const r = rng(31337);
    for (let t = 0; t < 150; t++) {
      const model = randomLP(r);
      const pd = solvePrimalDual(model);
      const ds = pd.steps.filter(s => s.state.dualObjective !== null).map(s => s.state.dualObjective!);
      const ups = pd.steps.filter(s => s.state.stage === 'update' && s.state.direction?.newY).map(s => s.state);
      for (const s of ups) {
        const b = s.problem.b;
        const nb = b.reduce((acc, bi, i) => acc.add(bi.mul(s.direction!.newY![i]!)), Q(0));
        expect(nb.gt(s.dualObjective!), `t=${t}`).toBe(true);
      }
      void ds;
    }
  });

  it('rejects an invalid model without throwing', () => {
    const res = solvePrimalDual({ sense: 'max', objective: [], constraints: [], varNames: [] });
    expect(res.status).toBe('invalid');
  });
});
