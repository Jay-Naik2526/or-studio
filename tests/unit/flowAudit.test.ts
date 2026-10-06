import { describe, it, expect } from 'vitest';
import { TransportSolver, findLoop, InitialMethod } from '../../src/core/solvers/transport/transport';
import { HungarianSolver } from '../../src/core/solvers/transport/hungarian';
import { solveLP } from '../../src/core/solvers/lp/engine';
import { Rational } from '../../src/core/math/rational';
import { LPModel, TransportModel } from '../../src/core/types/models';
import { randInt, rng } from '../helpers/bruteLP';

const R = (n: number) => Rational.of(n);
const sum = (xs: Rational[]) => xs.reduce((a, b) => a.add(b), Rational.ZERO);

/* ------------------------------------------------------------------ */
/* Transportation                                                      */
/* ------------------------------------------------------------------ */

/** Independent LP formulation (blocked cells forced to 0; unbalanced side as <=; max as negated min). */
function transportLP(model: TransportModel): LPModel {
  const m = model.supply.length, n = model.demand.length;
  const ts = sum(model.supply), td = sum(model.demand);
  const nv = m * n;
  const unit = (idx: number[]) => Array.from({ length: nv }, (_, k) => (idx.includes(k) ? Rational.ONE : Rational.ZERO));
  const cons: LPModel['constraints'] = [];
  for (let i = 0; i < m; i++) cons.push({ coeffs: unit(Array.from({ length: n }, (_, j) => i * n + j)), relation: ts.gt(td) ? '<=' : '=', rhs: model.supply[i]! });
  for (let j = 0; j < n; j++) cons.push({ coeffs: unit(Array.from({ length: m }, (_, i) => i * n + j)), relation: td.gt(ts) ? '<=' : '=', rhs: model.demand[j]! });
  if (ts.gt(td)) for (let j = 0; j < n; j++) cons[m + j]!.relation = '=';
  if (td.gt(ts)) for (let i = 0; i < m; i++) cons[i]!.relation = '=';
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) if (model.blocked?.[i]?.[j]) cons.push({ coeffs: unit([i * n + j]), relation: '<=', rhs: Rational.ZERO });
  const sign = model.objective === 'max' ? -1 : 1;
  return { sense: 'min', objective: model.costs.flat().map(c => c.mul(R(sign))), constraints: cons, varNames: Array.from({ length: nv }, (_, k) => `x${k + 1}`) };
}

function randomTransport(r: () => number, opts: { degenerate?: boolean; blocked?: boolean; max?: boolean } = {}): TransportModel {
  const m = randInt(r, 1, 5), n = randInt(r, 1, 5);
  const pick = () => (opts.degenerate ? [0, 0, 5, 5, 10, 10, 15, 20][randInt(r, 0, 7)]! : randInt(r, 0, 20));
  const supply = Array.from({ length: m }, pick);
  const demand = Array.from({ length: n }, pick);
  const model: TransportModel = {
    supply: supply.map(R), demand: demand.map(R),
    costs: Array.from({ length: m }, () => Array.from({ length: n }, () => R(opts.degenerate ? randInt(r, 1, 3) : randInt(r, -3, 15)))),
  };
  if (opts.max) model.objective = 'max';
  if (opts.blocked) model.blocked = Array.from({ length: m }, () => Array.from({ length: n }, () => r() < 0.3));
  return model;
}

/** Make totals equal by topping up the smaller side on a random entry. */
function balance(r: () => number, model: TransportModel): TransportModel {
  const ts = sum(model.supply), td = sum(model.demand);
  const s = [...model.supply], d = [...model.demand];
  if (ts.gt(td)) { const j = randInt(r, 0, d.length - 1); d[j] = d[j]!.add(ts.sub(td)); }
  else if (td.gt(ts)) { const i = randInt(r, 0, s.length - 1); s[i] = s[i]!.add(td.sub(ts)); }
  return { ...model, supply: s, demand: d };
}

function isSpanningTree(alloc: (Rational | null)[][]): boolean {
  const m = alloc.length, n = alloc[0]!.length;
  const parent = Array.from({ length: m + n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  let edges = 0;
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) {
    if (alloc[i]![j] === null) continue;
    edges++;
    const a = find(i), b = find(m + j);
    if (a === b) return false; // cycle
    parent[a] = b;
  }
  return edges === m + n - 1;
}

const mStr = (model: TransportModel) => JSON.stringify(model, (_k, v) => (v instanceof Rational ? v.toString() : v));

describe('flow audit: transportation', () => {
  it('every initial method yields a feasible spanning-tree basis (ties, zeros, degenerate)', () => {
    const r = rng(9001);
    for (let t = 0; t < 600; t++) {
      const base = randomTransport(r, { degenerate: r() < 0.7 });
      const model = r() < 0.6 ? balance(r, base) : base;
      for (const method of ['nwc', 'lcm', 'vam'] as InitialMethod[]) {
        const sol = new TransportSolver().solve(model, { variant: method, initialOnly: true, emitSteps: false });
        expect(sol.status, `${method} ${mStr(model)}`).toBe('optimal');
        const st = sol.result!.state;
        const ts = sum(model.supply), td = sum(model.demand);
        const supply = ts.lt(td) ? [...model.supply, td.sub(ts)] : model.supply;
        const demand = ts.gt(td) ? [...model.demand, ts.sub(td)] : model.demand;
        expect(st.allocations.length).toBe(supply.length);
        st.allocations.forEach((row, i) => expect(sum(row.map(a => a ?? Rational.ZERO)).eq(supply[i]!), `row ${i} ${method} ${mStr(model)}`).toBe(true));
        demand.forEach((dj, j) => expect(sum(st.allocations.map(row => row[j] ?? Rational.ZERO)).eq(dj), `col ${j} ${method} ${mStr(model)}`).toBe(true));
        st.allocations.flat().forEach(a => { if (a) expect(a.isNegative()).toBe(false); });
        expect(isSpanningTree(st.allocations), `${method} ${mStr(model)}`).toBe(true);
      }
    }
  });

  it('MODI optimum equals the LP optimum (balanced, unbalanced, degenerate, max, blocked)', () => {
    const r = rng(9002);
    for (let t = 0; t < 700; t++) {
      const flavour = t % 7;
      let model = randomTransport(r, { degenerate: flavour === 0 || flavour === 3, max: flavour === 2 || flavour === 5, blocked: flavour >= 3 && flavour <= 5 });
      if (flavour === 1 || flavour === 6 || r() < 0.4) model = balance(r, model);
      const lp = solveLP(transportLP(model), { emitSteps: false });
      for (const method of ['nwc', 'lcm', 'vam'] as InitialMethod[]) {
        const sol = new TransportSolver().solve(model, { variant: method, emitSteps: false });
        const tag = `${method} ${mStr(model)}`;
        if (lp.status === 'infeasible') { expect(sol.status, tag).toBe('infeasible'); continue; }
        expect(sol.status, tag).toBe('optimal');
        const obj = sol.result!.reportedObjective;
        expect(obj.hasM(), tag).toBe(false);
        const want = model.objective === 'max' ? lp.result!.objectiveValue.neg() : lp.result!.objectiveValue;
        expect(obj.toString(), tag).toBe(want.toString());
        // no flow on a blocked cell
        const st = sol.result!.state;
        model.blocked?.forEach((row, i) => row.forEach((b, j) => { if (b) expect(st.allocations[i]![j] === null || st.allocations[i]![j]!.isZero(), tag).toBe(true); }));
        expect(isSpanningTree(st.allocations), tag).toBe(true);
      }
    }
  });

  it('every MODI step has a valid closed loop, theta = min of minus cells, monotone cost', () => {
    const r = rng(9003);
    for (let t = 0; t < 200; t++) {
      const model = balance(r, randomTransport(r, { degenerate: t % 2 === 0 }));
      const sol = new TransportSolver().solve(model, { variant: 'nwc' });
      expect(sol.status).toBe('optimal');
      let prev: number | null = null;
      for (const s of sol.steps) {
        const st = s.state;
        if (st.loop && st.enteringCell && st.leavingCell && st.theta && (s.phase ?? '').endsWith('evaluate')) {
          const lp = st.loop;
          expect(lp[0]).toMatchObject({ row: st.enteringCell.row, col: st.enteringCell.col, sign: '+' });
          expect(lp.length % 2).toBe(0);
          lp.forEach((c, k) => {
            expect(c.sign).toBe(k % 2 === 0 ? '+' : '-');
            const nx = lp[(k + 1) % lp.length]!;
            // entering cell shares a column with the next one, then columns and rows alternate
            if (k % 2 === 0) expect(nx.col).toBe(c.col); else expect(nx.row).toBe(c.row);
          });
          const minus = lp.filter(c => c.sign === '-').map(c => st.allocations[c.row]![c.col]!);
          expect(minus.every(a => a !== null)).toBe(true);
          const mn = minus.reduce((a, b) => (b.lt(a) ? b : a));
          expect(st.theta.eq(mn)).toBe(true);
          const lv = lp.find(c => c.row === st.leavingCell!.row && c.col === st.leavingCell!.col)!;
          expect(lv.sign).toBe('-');
          expect(st.allocations[lv.row]![lv.col]!.eq(st.theta)).toBe(true);
        }
        if ((s.phase ?? '').endsWith('reallocate')) {
          const c = Number(st.totalCost.toString());
          if (prev !== null) expect(c).toBeLessThanOrEqual(prev + 1e-9);
          prev = c;
          expect(isSpanningTree(st.allocations)).toBe(true);
        }
      }
    }
  });

  it('findLoop returns an alternating cycle through basic cells only', () => {
    const r = rng(9004);
    for (let t = 0; t < 200; t++) {
      const model = balance(r, randomTransport(r));
      const st = new TransportSolver().solve(model, { variant: 'lcm', initialOnly: true, emitSteps: false }).result!.state;
      const basic = st.allocations.map(row => row.map(a => a !== null));
      st.allocations.forEach((row, i) => row.forEach((a, j) => {
        if (a !== null) return;
        const lp = findLoop(basic, i, j);
        expect(lp).not.toBeNull();
        lp!.slice(1).forEach(c => expect(basic[c.row]![c.col]).toBe(true));
        expect(new Set(lp!.map(c => `${c.row},${c.col}`)).size).toBe(lp!.length);
      }));
    }
  });

  it('larger heavily degenerate problems terminate at the LP optimum', () => {
    const r = rng(9005);
    for (let t = 0; t < 60; t++) {
      const m = randInt(r, 6, 9), n = randInt(r, 6, 9);
      const model = balance(r, {
        supply: Array.from({ length: m }, () => R([0, 5, 5, 10, 10][randInt(r, 0, 4)]!)),
        demand: Array.from({ length: n }, () => R([0, 5, 5, 10, 10][randInt(r, 0, 4)]!)),
        costs: Array.from({ length: m }, () => Array.from({ length: n }, () => R(randInt(r, 1, 3)))),
      });
      const want = solveLP(transportLP(model), { emitSteps: false }).result!.objectiveValue.toString();
      for (const method of ['nwc', 'lcm', 'vam'] as InitialMethod[]) {
        const sol = new TransportSolver().solve(model, { variant: method, emitSteps: false });
        expect(sol.status, `${method} ${mStr(model)}`).toBe('optimal');
        expect(sol.result!.state.totalCost.toString()).toBe(want);
      }
    }
  });

  it('degenerate edge cases: 1x1, 1xn, nx1, all-zero, all-equal costs, supply equals demand subset', () => {
    const S = new TransportSolver();
    const cases: TransportModel[] = [
      { supply: [R(5)], demand: [R(5)], costs: [[R(3)]] },
      { supply: [R(0)], demand: [R(0)], costs: [[R(3)]] },
      { supply: [R(10)], demand: [R(3), R(3), R(4)], costs: [[R(1), R(2), R(3)]] },
      { supply: [R(3), R(3), R(4)], demand: [R(10)], costs: [[R(1)], [R(2)], [R(3)]] },
      { supply: [R(0), R(0)], demand: [R(0), R(0)], costs: [[R(1), R(1)], [R(1), R(1)]] },
      { supply: [R(10), R(20)], demand: [R(10), R(20)], costs: [[R(2), R(2)], [R(2), R(2)]] },
      { supply: [R(10), R(20), R(30)], demand: [R(30), R(30)], costs: [[R(1), R(5)], [R(4), R(2)], [R(3), R(3)]] },
      { supply: [R(0), R(7)], demand: [R(7), R(0)], costs: [[R(1), R(2)], [R(3), R(4)]] },
    ];
    for (const model of cases) for (const method of ['nwc', 'lcm', 'vam'] as InitialMethod[]) {
      const sol = S.solve(model, { variant: method });
      expect(sol.status, `${method} ${mStr(model)}`).toBe('optimal');
      const lp = solveLP(transportLP(model), { emitSteps: false });
      expect(sol.result!.state.totalCost.toString()).toBe(lp.result!.objectiveValue.toString());
      expect(isSpanningTree(sol.result!.state.allocations)).toBe(true);
    }
  });

  it('all blocked or unavoidable prohibited cells report infeasible', () => {
    const S = new TransportSolver();
    const model: TransportModel = { supply: [R(5), R(5)], demand: [R(10)], costs: [[R(1)], [R(1)]], blocked: [[true], [false]] };
    expect(S.solve(model).status).toBe('infeasible');
    const ok: TransportModel = { supply: [R(5), R(5)], demand: [R(5)], costs: [[R(1)], [R(1)]], blocked: [[true], [false]] };
    const sol = S.solve(ok);
    expect(sol.status).toBe('optimal');
    expect(sol.result!.state.totalCost.toString()).toBe('5');
  });
});

/* ------------------------------------------------------------------ */
/* Assignment                                                          */
/* ------------------------------------------------------------------ */

function perms(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  for (const p of perms(n - 1)) for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}

function maxMatching(adj: boolean[][]): number {
  const n = adj[0]?.length ?? 0;
  const mc: number[] = Array(n).fill(-1);
  const go = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < n; j++) {
      if (!adj[i]![j] || seen[j]) continue;
      seen[j] = true;
      if (mc[j] === -1 || go(mc[j]!, seen)) { mc[j] = i; return true; }
    }
    return false;
  };
  let c = 0;
  for (let i = 0; i < adj.length; i++) if (go(i, Array(n).fill(false))) c++;
  return c;
}

describe('flow audit: assignment', () => {
  it('Hungarian equals brute force (negative costs, ties, forbidden, rectangular, max)', () => {
    const r = rng(9101);
    for (let t = 0; t < 600; t++) {
      const rows = randInt(r, 1, 5), cols = randInt(r, 1, 5);
      const tie = t % 3 === 0;
      const costs = Array.from({ length: rows }, () => Array.from({ length: cols }, () => (t % 11 === 0 ? 0 : tie ? randInt(r, 0, 2) : randInt(r, -8, 20))));
      const max = r() < 0.35;
      const blocked = r() < 0.4 ? Array.from({ length: rows }, () => Array.from({ length: cols }, () => r() < 0.35)) : undefined;
      const n = Math.max(rows, cols);
      let best: [number, number] | null = null; // [blockedCount, objective-as-minimised]
      for (const p of perms(n)) {
        let b = 0, s = 0;
        for (let i = 0; i < rows; i++) {
          const j = p[i]!;
          if (j >= cols) continue;
          if (blocked?.[i]?.[j]) { b++; continue; }
          s += max ? -costs[i]![j]! : costs[i]![j]!;
        }
        if (best === null || b < best[0] || (b === best[0] && s < best[1])) best = [b, s];
      }
      const sol = new HungarianSolver().solve({ costs: costs.map(row => row.map(R)), objective: max ? 'max' : 'min', blocked });
      const tag = JSON.stringify({ costs, max, blocked });
      if (best![0] > 0) { expect(sol.status, tag).toBe('infeasible'); continue; }
      expect(sol.status, tag).toBe('optimal');
      expect(Number(sol.result!.objective.toString()) + 0, tag).toBe((max ? 0 - best![1] : best![1]) + 0);
      // assignment is a valid permutation and its real cells sum to the objective
      const asg = sol.result!.assignment;
      expect(new Set(asg.map(a => a.row)).size).toBe(n);
      expect(new Set(asg.map(a => a.col)).size).toBe(n);
      let tot = 0;
      asg.forEach(a => { if (a.real) { expect(blocked?.[a.row]?.[a.col] ?? false, tag).toBe(false); tot += costs[a.row]![a.col]!; } });
      expect(tot, tag).toBe(Number(sol.result!.objective.toString()));
    }
  });

  it('every line-cover step covers all zeros with exactly max-matching-many lines (Koenig)', () => {
    const r = rng(9102);
    for (let t = 0; t < 250; t++) {
      const n = randInt(r, 1, 6);
      const costs = Array.from({ length: n }, () => Array.from({ length: n }, () => randInt(r, 0, 9)));
      const sol = new HungarianSolver().solve({ costs: costs.map(row => row.map(R)) });
      for (const s of sol.steps) {
        if (s.state.stage !== 'Line cover') continue;
        const mat = s.state.matrix;
        const zero = mat.map(row => row.map(x => x.isZero()));
        mat.forEach(row => row.forEach(x => expect(x.isNegative()).toBe(false)));
        zero.forEach((row, i) => row.forEach((z, j) => { if (z) expect(s.state.coveredRows[i] || s.state.coveredCols[j], JSON.stringify(costs)).toBe(true); }));
        const lines = s.state.coveredRows.filter(Boolean).length + s.state.coveredCols.filter(Boolean).length;
        expect(lines, JSON.stringify(costs)).toBe(maxMatching(zero));
      }
    }
  });

  it('degenerate shapes: 1x1, all zeros, 1xn, nx1', () => {
    const H = new HungarianSolver();
    expect(H.solve({ costs: [[R(7)]] }).result!.objective.toString()).toBe('7');
    expect(H.solve({ costs: [[R(0), R(0)], [R(0), R(0)]] }).result!.objective.toString()).toBe('0');
    expect(H.solve({ costs: [[R(4), R(2), R(9)]] }).result!.objective.toString()).toBe('2');
    expect(H.solve({ costs: [[R(4)], [R(2)], [R(9)]], objective: 'max' }).result!.objective.toString()).toBe('9');
  });
});

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

import { solveDijkstra, solveBellmanFord, solveFloydWarshall, solveMST, solveMaxFlow } from '../../src/core/solvers/network/network';
import { GraphModel } from '../../src/core/types/models';

type E = GraphModel['edges'][number];

function randomGraph(r: () => number, opts: { neg?: boolean; loops?: boolean; maxN?: number; zero?: boolean } = {}): GraphModel {
  const n = randInt(r, 1, opts.maxN ?? 7);
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
  const m = randInt(r, 0, n * 2 + 2);
  const edges: E[] = [];
  for (let k = 0; k < m; k++) {
    const a = randInt(r, 0, n - 1);
    let b = randInt(r, 0, n - 1);
    if (!opts.loops && n > 1) while (b === a) b = randInt(r, 0, n - 1);
    if (!opts.loops && n === 1) break;
    const w = opts.neg ? randInt(r, -3, 9) : opts.zero ? randInt(r, 0, 4) : randInt(r, 1, 9);
    edges.push({ id: `e${k}`, from: `n${a}`, to: `n${b}`, weight: R(w), directed: r() < 0.6 });
  }
  return { nodes, edges, source: 'n0', sink: `n${randInt(r, 0, n - 1)}` };
}

/** Independent oracle: plain Bellman-Ford on numbers. Returns null if a negative cycle is reachable from src. */
function oracleDist(g: GraphModel, src: string): Record<string, number | null> | null {
  const d: Record<string, number | null> = Object.fromEntries(g.nodes.map(x => [x.id, null]));
  d[src] = 0;
  const arcs: [string, string, number][] = [];
  for (const e of g.edges) {
    if (e.from === e.to) continue;
    arcs.push([e.from, e.to, Number(e.weight.toString())]);
    if (!e.directed) arcs.push([e.to, e.from, Number(e.weight.toString())]);
  }
  for (let pass = 0; pass <= g.nodes.length; pass++) {
    let ch = false;
    for (const [u, v, w] of arcs) if (d[u] !== null && (d[v] === null || d[u]! + w < d[v]!)) { d[v] = d[u]! + w; ch = true; }
    if (!ch) return d;
  }
  return null;
}

function pathCost(g: GraphModel, path: string[]): number | null {
  let c = 0;
  for (let k = 1; k < path.length; k++) {
    let best: number | null = null;
    for (const e of g.edges) {
      const fwd = e.from === path[k - 1] && e.to === path[k];
      const bwd = !e.directed && e.to === path[k - 1] && e.from === path[k];
      if ((fwd || bwd) && e.from !== e.to) { const w = Number(e.weight.toString()); if (best === null || w < best) best = w; }
    }
    if (best === null) return null;
    c += best;
  }
  return c;
}

describe('flow audit: shortest paths', () => {
  it('Dijkstra == Bellman-Ford == Floyd == oracle on random mixed graphs', () => {
    const r = rng(9201);
    for (let t = 0; t < 500; t++) {
      const g = randomGraph(r, { loops: r() < 0.5, zero: r() < 0.3 });
      const tag = JSON.stringify(g, (_k, v) => (v instanceof Rational ? v.toString() : v));
      const want = oracleDist(g, 'n0')!;
      for (const variant of [undefined, 'all']) {
        const dj = solveDijkstra(g, { emitSteps: false, variant });
        expect(dj.status === 'optimal' || dj.status === 'infeasible', tag).toBe(true);
        const dr = dj.result!;
        // the sink distance and path are always right; with variant 'all' every distance is
        const sink = g.sink!;
        expect(dr.distances[sink]?.toString() ?? null, tag).toBe(want[sink] === null ? null : String(want[sink]));
        if (variant === 'all') g.nodes.forEach(x => expect(dr.distances[x.id]?.toString() ?? null, tag).toBe(want[x.id] === null ? null : String(want[x.id])));
        if (dr.path.length) { expect(dr.path[0]).toBe('n0'); expect(dr.path[dr.path.length - 1]).toBe(sink); expect(pathCost(g, dr.path), tag).toBe(want[sink]); }
        // never claims a reachable node is unreachable
        dr.unreachable.forEach(u => expect(want[u], tag).toBeNull());
      }
      const bf = solveBellmanFord(g, { emitSteps: false }).result!;
      g.nodes.forEach(x => expect(bf.distances[x.id]?.toString() ?? null, tag).toBe(want[x.id] === null ? null : String(want[x.id])));
      if (bf.path.length) expect(pathCost(g, bf.path), tag).toBe(want[g.sink!]);
      const fw = solveFloydWarshall(g, { emitSteps: false }).result!;
      expect(fw.negativeCycle).toBe(false);
      const ids = fw.nodes;
      for (const a of ids) {
        const o = oracleDist(g, a)!;
        ids.forEach((b, j) => expect(fw.dist[ids.indexOf(a)]![j]?.toString() ?? null, tag).toBe(o[b] === null ? null : String(o[b])));
      }
      const p = fw.path(0, ids.indexOf(g.sink!));
      if (p.length) expect(pathCost(g, p.map(i => ids[i]!)), tag).toBe(want[g.sink!]);
    }
  });

  it('negative edges: Dijkstra refuses, Bellman-Ford/Floyd agree with the oracle and flag negative cycles', () => {
    const r = rng(9202);
    let cyc = 0;
    for (let t = 0; t < 600; t++) {
      const g = randomGraph(r, { neg: true, loops: r() < 0.3 });
      const tag = JSON.stringify(g, (_k, v) => (v instanceof Rational ? v.toString() : v));
      const hasNeg = g.edges.some(e => e.weight.isNegative());
      const dj = solveDijkstra(g, { emitSteps: false });
      if (hasNeg) expect(dj.status, tag).toBe('invalid-input');
      const bf = solveBellmanFord(g, { emitSteps: false });
      const selfNeg = g.edges.some(e => e.from === e.to && e.weight.isNegative());
      if (selfNeg) { expect(bf.status, tag).toBe('invalid-input'); continue; }
      const want = oracleDist(g, 'n0');
      if (want === null) { cyc++; expect(bf.status, tag).toBe('unbounded'); expect(bf.result!.negativeCycle?.length, tag).toBeGreaterThan(1); }
      else { expect(bf.status === 'optimal' || bf.status === 'infeasible', tag).toBe(true); g.nodes.forEach(x => expect(bf.result!.distances[x.id]?.toString() ?? null, tag).toBe(want[x.id] === null ? null : String(want[x.id]))); }
      // Floyd: negative cycle anywhere in the graph
      const anyCycle = g.nodes.some(x => oracleDist(g, x.id) === null);
      const fw = solveFloydWarshall(g, { emitSteps: false });
      expect(fw.result!.negativeCycle, tag).toBe(anyCycle);
    }
    expect(cyc).toBeGreaterThan(20);
  });

  it('negative cycle in Bellman-Ford is a real cycle of negative weight', () => {
    const r = rng(9203);
    for (let t = 0; t < 400; t++) {
      const g = randomGraph(r, { neg: true });
      if (g.edges.some(e => e.from === e.to && e.weight.isNegative())) continue;
      const bf = solveBellmanFord(g, { emitSteps: false });
      if (bf.status !== 'unbounded') continue;
      const cyc = bf.result!.negativeCycle!;
      expect(cyc[0]).toBe(cyc[cyc.length - 1]);
      let total = 0;
      for (let k = 1; k < cyc.length; k++) {
        // the cycle lists predecessors backwards, so edges may be walked in either orientation
        const fwd = pathCost(g, [cyc[k - 1]!, cyc[k]!]);
        const bwd = pathCost(g, [cyc[k]!, cyc[k - 1]!]);
        expect(fwd !== null || bwd !== null).toBe(true);
        total += Math.min(fwd ?? Infinity, bwd ?? Infinity);
      }
      expect(total).toBeLessThan(0);
    }
  });

  it('unknown source or sink ids do not crash', () => {
    const g: GraphModel = { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ id: 'e', from: 'a', to: 'b', weight: R(2), directed: true }], source: 'ghost', sink: 'phantom' };
    for (const f of [solveDijkstra, solveBellmanFord]) expect(() => f(g)).not.toThrow();
    expect(() => solveMST({ ...g, source: 'ghost' }, 'prim')).not.toThrow();
    const prim = solveMST({ ...g, source: 'ghost' }, 'prim');
    expect(prim.result!.selectedEdges).toEqual(['e']);
    expect(() => solveMaxFlow({ ...g, sources: ['ghost'], sinks: ['b'] })).not.toThrow();
    const dj = solveDijkstra({ ...g, source: 'a', sink: 'phantom' });
    expect(dj.status).toBe('optimal');
  });
});

describe('flow audit: spanning trees', () => {
  function bruteForestWeight(g: GraphModel): { weight: number; comps: number } {
    const edges = g.edges.filter(e => e.from !== e.to);
    const n = g.nodes.length;
    const idx = new Map(g.nodes.map((x, i) => [x.id, i]));
    const compsOf = (sub: E[]) => {
      const p = Array.from({ length: n }, (_, i) => i);
      const f = (x: number): number => (p[x] === x ? x : (p[x] = f(p[x]!)));
      let acyclic = true;
      for (const e of sub) { const a = f(idx.get(e.from)!), b = f(idx.get(e.to)!); if (a === b) acyclic = false; else p[a] = b; }
      return { acyclic, comps: new Set(p.map((_, i) => f(i))).size };
    };
    const full = compsOf(edges).comps;
    let best = Infinity;
    for (let mask = 0; mask < 1 << edges.length; mask++) {
      const sub = edges.filter((_, i) => mask & (1 << i));
      if (sub.length !== n - full) continue;
      const c = compsOf(sub);
      if (!c.acyclic || c.comps !== full) continue;
      best = Math.min(best, sub.reduce((s, e) => s + Number(e.weight.toString()), 0));
    }
    return { weight: best, comps: full };
  }

  it('Kruskal == Prim == brute force; forests on disconnected graphs; ties; negative weights', () => {
    const r = rng(9301);
    for (let t = 0; t < 400; t++) {
      const g = randomGraph(r, { loops: r() < 0.5, neg: r() < 0.3, zero: r() < 0.3, maxN: 6 });
      g.edges = g.edges.slice(0, 11);
      if (t % 4 === 0) g.edges.forEach(e => (e.weight = R(2)));
      const tag = JSON.stringify(g, (_k, v) => (v instanceof Rational ? v.toString() : v));
      const want = bruteForestWeight(g);
      for (const alg of ['kruskal', 'prim'] as const) {
        const sol = solveMST({ ...g, source: r() < 0.5 ? g.source : undefined }, alg, { emitSteps: false });
        expect(sol.status).toBe('optimal');
        const res = sol.result!;
        expect(Number(res.totalWeight.toString()), `${alg} ${tag}`).toBe(want.weight);
        expect(res.components.length, `${alg} ${tag}`).toBe(want.comps);
        expect(res.isConnected).toBe(want.comps === 1);
        expect(res.selectedEdges.length).toBe(g.nodes.length - want.comps);
        const ids = new Set(res.selectedEdges);
        expect(ids.size).toBe(res.selectedEdges.length);
        g.edges.filter(e => ids.has(e.id)).forEach(e => expect(e.from).not.toBe(e.to));
      }
    }
  });
});

describe('flow audit: maximum flow', () => {
  function randomFlowGraph(r: () => number): GraphModel {
    const n = randInt(r, 2, 7);
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `N${i}` }));
    const edges: E[] = [];
    const m = randInt(r, 1, n * 2 + 2);
    for (let k = 0; k < m; k++) {
      const a = randInt(r, 0, n - 1), b = randInt(r, 0, n - 1);
      const cap = [0, 1, 2, 3, 5, 8, 13][randInt(r, 0, 6)]!;
      const directed = r() < 0.7;
      edges.push({ id: `e${k}`, from: `n${a}`, to: `n${b}`, weight: R(cap), capacity: R(cap), directed });
    }
    // terminals: 1-2 sources, 1-2 sinks, disjoint
    const perm = Array.from({ length: n }, (_, i) => i).sort(() => r() - 0.5);
    const ns = r() < 0.3 && n >= 4 ? 2 : 1;
    const nt = r() < 0.3 && n - ns >= 2 ? 2 : 1;
    const sources = perm.slice(0, ns).map(i => `n${i}`);
    const sinks = perm.slice(ns, ns + nt).map(i => `n${i}`);
    return { nodes, edges, source: sources[0], sink: sinks[0], sources: ns > 1 ? sources : undefined, sinks: nt > 1 ? sinks : undefined };
  }

  function maxFlowLP(g: GraphModel, sources: string[], sinks: string[]): Rational {
    const arcs: { e: E; u: string; v: string }[] = [];
    for (const e of g.edges) {
      if (e.from === e.to) continue;
      const cap = e.capacity ?? e.weight;
      if (cap.isZero()) continue;
      arcs.push({ e, u: e.from, v: e.to });
      if (!e.directed) arcs.push({ e, u: e.to, v: e.from });
    }
    const nv = arcs.length;
    const row = (f: (a: { u: string; v: string }) => number): Rational[] => arcs.map(a => R(f(a)));
    const cons: LPModel['constraints'] = arcs.map((a, k) => ({ coeffs: arcs.map((_, q) => (q === k ? Rational.ONE : Rational.ZERO)), relation: '<=' as const, rhs: a.e.capacity ?? a.e.weight }));
    const net = (id: string) => row(a => (a.u === id ? 1 : 0) - (a.v === id ? 1 : 0));
    for (const x of g.nodes) {
      if (sources.includes(x.id)) cons.push({ coeffs: net(x.id), relation: '>=', rhs: Rational.ZERO });
      else if (sinks.includes(x.id)) cons.push({ coeffs: net(x.id).map(c => c.neg()), relation: '>=', rhs: Rational.ZERO });
      else cons.push({ coeffs: net(x.id), relation: '=', rhs: Rational.ZERO });
    }
    const obj = Array.from({ length: nv }, () => Rational.ZERO);
    sources.forEach(s => net(s).forEach((c, k) => (obj[k] = obj[k]!.add(c))));
    if (nv === 0) return Rational.ZERO;
    const lp = solveLP({ sense: 'max', objective: obj, constraints: cons, varNames: arcs.map((_, k) => `f${k}`) }, { emitSteps: false });
    return lp.result!.objectiveValue;
  }

  function bruteMinCut(g: GraphModel, sources: string[], sinks: string[]): number {
    const ids = g.nodes.map(x => x.id);
    let best = Infinity;
    for (let mask = 0; mask < 1 << ids.length; mask++) {
      const side = new Set(ids.filter((_, i) => mask & (1 << i)));
      if (sources.some(s => !side.has(s)) || sinks.some(s => side.has(s))) continue;
      let c = 0;
      for (const e of g.edges) {
        if (e.from === e.to) continue;
        const cap = Number((e.capacity ?? e.weight).toString());
        if (side.has(e.from) && !side.has(e.to)) c += cap;
        else if (!e.directed && side.has(e.to) && !side.has(e.from)) c += cap;
      }
      best = Math.min(best, c);
    }
    return best;
  }

  it('max flow == min cut == LP; flows legal at every step (BFS and DFS, multi-terminal, undirected)', () => {
    const r = rng(9401);
    for (let t = 0; t < 400; t++) {
      const g = randomFlowGraph(r);
      const sources = g.sources ?? [g.source!];
      const sinks = g.sinks ?? [g.sink!];
      const tag = JSON.stringify(g, (_k, v) => (v instanceof Rational ? v.toString() : v));
      const lpv = maxFlowLP(g, sources, sinks);
      const cut = bruteMinCut(g, sources, sinks);
      for (const dfs of [false, true]) {
        const sol = solveMaxFlow(g, { dfs });
        expect(sol.status, tag).toBe('optimal');
        const res = sol.result!;
        expect(res.maxFlow.toString(), `${dfs} ${tag}`).toBe(lpv.toString());
        expect(Number(res.maxFlow.toString()), tag).toBe(cut);
        expect(res.cutCapacity.eq(res.maxFlow), tag).toBe(true);
        // cut edges cross the reported source side
        const side = new Set(res.sourceSide);
        sources.forEach(s => expect(side.has(s)).toBe(true));
        sinks.forEach(s => expect(side.has(s)).toBe(false));
        let prevVal = Rational.ZERO;
        for (const st of sol.steps) {
          const s = st.state;
          if (!s.residual) continue;
          expect(s.flowValue!.gte(prevVal)).toBe(true);
          prevVal = s.flowValue!;
          // signed flow on each forward arc = capacity - residual
          const net: Record<string, Rational> = {};
          g.nodes.forEach(x => (net[x.id] = Rational.ZERO));
          for (const e of g.edges) {
            const cap = e.capacity ?? e.weight;
            if (e.from === e.to || cap.isZero()) continue;
            const resid = s.residual[e.id];
            expect(resid, tag).not.toBeUndefined();
            const f = cap.sub(resid!);
            expect(f.lte(cap), tag).toBe(true);
            if (e.directed) expect(f.isNegative(), tag).toBe(false); else expect(f.neg().lte(cap), tag).toBe(true);
            net[e.from] = net[e.from]!.add(f);
            net[e.to] = net[e.to]!.sub(f);
          }
          for (const x of g.nodes) {
            if (sources.includes(x.id)) expect(net[x.id]!.isNegative(), tag).toBe(false);
            else if (sinks.includes(x.id)) expect(net[x.id]!.isPositive(), tag).toBe(false);
            else expect(net[x.id]!.isZero(), `conservation at ${x.id} ${tag}`).toBe(true);
          }
          const out = sources.reduce((a, x) => a.add(net[x]!), Rational.ZERO);
          expect(out.eq(s.flowValue!), tag).toBe(true);
        }
        // reported per-edge flows never exceed capacity
        for (const e of g.edges) {
          const f = res.flows[e.id];
          if (f) expect(f.lte(e.capacity ?? e.weight), tag).toBe(true);
        }
      }
    }
  });

  it('guards: source == sink, negative capacity, zero capacity, missing terminals, unbounded multi-terminal', () => {
    const base: GraphModel = { nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ id: 'e', from: 'a', to: 'b', weight: R(3), capacity: R(3), directed: true }], source: 'a', sink: 'b' };
    expect(solveMaxFlow({ ...base, sink: 'a' }).status).toBe('invalid-input');
    expect(solveMaxFlow({ ...base, source: undefined }).status).toBe('invalid-input');
    expect(solveMaxFlow({ ...base, edges: [{ ...base.edges[0]!, capacity: R(-1) }] }).status).toBe('invalid-input');
    const z = solveMaxFlow({ ...base, edges: [{ ...base.edges[0]!, capacity: R(0) }] });
    expect(z.result!.maxFlow.toString()).toBe('0');
    expect(solveMaxFlow({ ...base, sources: ['a', 'b'], sinks: ['b'] }).status).toBe('invalid-input');
    expect(solveMaxFlow(base).result!.maxFlow.toString()).toBe('3');
  });
});

/* ------------------------------------------------------------------ */
/* Project planning                                                    */
/* ------------------------------------------------------------------ */

import { ProjectSolver, probabilityWithin } from '../../src/core/solvers/project/cpm';
import { crashAtTarget, crashCurve } from '../../src/core/solvers/project/crashing';
import { ProjectModel } from '../../src/core/types/models';

function randomProject(r: () => number, opts: { zero?: boolean; maxN?: number } = {}): ProjectModel {
  const n = randInt(r, 1, opts.maxN ?? 8);
  const activities = Array.from({ length: n }, (_, i) => {
    const preds: string[] = [];
    for (let k = 0; k < i; k++) if (r() < 0.35) preds.push(`T${k}`);
    return { id: `T${i}`, name: `T${i}`, predecessors: preds, duration: randInt(r, opts.zero ? 0 : 1, 6) };
  });
  return { activities };
}

describe('flow audit: CPM / PERT', () => {
  it('forward/backward identities, floats and exact critical-path enumeration', () => {
    const r = rng(9501);
    for (let t = 0; t < 500; t++) {
      const model = randomProject(r, { zero: t % 3 === 0 });
      const tag = JSON.stringify(model.activities);
      const sol = new ProjectSolver().solve(model, { emitSteps: false });
      expect(sol.status, tag).toBe('optimal');
      const res = sol.result!;
      const acts = model.activities;
      const succ = new Map(acts.map(a => [a.id, acts.filter(b => b.predecessors.includes(a.id)).map(b => b.id)]));
      // oracle longest path DP (activities are listed in topological order by construction)
      const es: Record<string, number> = {};
      for (const a of acts) es[a.id] = Math.max(0, ...a.predecessors.map(p => es[p]! + acts.find(x => x.id === p)!.duration!));
      const T = Math.max(...acts.map(a => es[a.id]! + a.duration!));
      expect(res.projectDuration, tag).toBe(T);
      for (const a of acts) {
        const s = res.schedule[a.id]!;
        expect(s.earlyStart, tag).toBe(es[a.id]);
        expect(s.earlyFinish).toBe(es[a.id]! + a.duration!);
        expect(s.lateFinish - s.lateStart).toBe(a.duration);
        expect(s.totalFloat).toBe(s.lateStart - s.earlyStart);
        expect(s.totalFloat).toBe(s.lateFinish - s.earlyFinish);
        expect(s.totalFloat).toBeGreaterThanOrEqual(0);
        const ff = Math.min(...(succ.get(a.id)!.length ? succ.get(a.id)!.map(x => es[x]!) : [T])) - s.earlyFinish;
        expect(s.freeFloat, tag).toBe(ff);
        expect(s.freeFloat).toBeLessThanOrEqual(s.totalFloat);
        expect(s.isCritical).toBe(s.totalFloat === 0);
      }
      // enumerate every source→sink path with length T
      const want: string[] = [];
      const dfs = (id: string, path: string[], len: number) => {
        const nl = len + acts.find(x => x.id === id)!.duration!;
        const nx = succ.get(id)!;
        if (!nx.length) { if (nl === T) want.push([...path, id].join('>')); return; }
        nx.forEach(x => dfs(x, [...path, id], nl));
      };
      acts.filter(a => !a.predecessors.length).forEach(a => dfs(a.id, [], 0));
      expect(res.criticalPaths.map(p => p.join('>')).sort(), tag).toEqual([...new Set(want)].sort());
    }
  });

  it('PERT: mean, variance, monotone probability', () => {
    const r = rng(9502);
    for (let t = 0; t < 200; t++) {
      const n = randInt(r, 1, 6);
      const acts = Array.from({ length: n }, (_, i) => {
        const o = randInt(r, 1, 5), m = o + randInt(r, 0, 4), p = m + randInt(r, 0, 6);
        return { id: `T${i}`, name: `T${i}`, predecessors: i > 0 && r() < 0.6 ? [`T${randInt(r, 0, i - 1)}`] : [], optimistic: o, mostLikely: m, pessimistic: p };
      });
      const sol = new ProjectSolver().solve({ activities: acts }, { variant: 'pert', emitSteps: false });
      expect(sol.status).toBe('optimal');
      const res = sol.result!;
      acts.forEach(a => {
        const s = res.schedule[a.id]!;
        expect(s.expectedDuration).toBeCloseTo((a.optimistic + 4 * a.mostLikely + a.pessimistic) / 6, 5);
        expect(s.variance).toBeCloseTo(((a.pessimistic - a.optimistic) / 6) ** 2, 5);
      });
      const pathVars = res.criticalPaths.map(p => p.reduce((s, id) => s + res.schedule[id]!.variance!, 0));
      expect(res.projectVariance!).toBeCloseTo(Math.max(...pathVars), 5);
      let prev = -1;
      for (let x = res.projectDuration - 6; x <= res.projectDuration + 6; x += 0.75) {
        const pr = probabilityWithin(res, x)!;
        expect(pr).toBeGreaterThanOrEqual(prev - 1e-12);
        expect(pr).toBeGreaterThanOrEqual(0);
        expect(pr).toBeLessThanOrEqual(1);
        prev = pr;
      }
      if (res.projectVariance! > 0) expect(probabilityWithin(res, res.projectDuration)!).toBeCloseTo(0.5, 6);
    }
  });

  it('input errors are clear: cycles, unknown/self predecessors, duplicate ids, bad estimates, hostile numbers', () => {
    const S = new ProjectSolver();
    const A = (id: string, preds: string[], d: number | undefined = 1) => ({ id, name: id, predecessors: preds, duration: d });
    expect(S.solve({ activities: [A('A', ['B']), A('B', ['A'])] }).diagnostics[0]!.message).toMatch(/Cyclic/);
    expect(S.solve({ activities: [A('A', ['A'])] }).status).toBe('invalid-input');
    expect(S.solve({ activities: [A('A', ['Z'])] }).diagnostics[0]!.message).toMatch(/unknown predecessor/);
    expect(S.solve({ activities: [A('A', []), A('A', [])] }).diagnostics[0]!.message).toMatch(/Duplicate/);
    expect(S.solve({ activities: [] }).status).toBe('invalid-input');
    expect(S.solve({ activities: [A('A', [], -1)] }).status).toBe('invalid-input');
    for (const bad of [NaN, Infinity, -Infinity, 1e308]) {
      const run = () => S.solve({ activities: [A('A', [], bad)] });
      expect(run).not.toThrow();
    }
    expect(S.solve({ activities: [A('A', [], NaN)] }).status).toBe('invalid-input');
    expect(S.solve({ activities: [A('A', [], Infinity)] }).status).toBe('invalid-input');
    const neg = S.solve({ activities: [{ id: 'A', name: 'A', predecessors: [], optimistic: -2, mostLikely: 1, pessimistic: 3 }] }, { variant: 'pert' });
    expect(neg.status).toBe('invalid-input');
    // single activity, zero duration, duplicate predecessor listing
    expect(S.solve({ activities: [A('A', [], 0)] }).result!.projectDuration).toBe(0);
    expect(S.solve({ activities: [A('A', [], 4)] }).result!.criticalPaths).toEqual([['A']]);
    const dup = S.solve({ activities: [A('A', [], 2), A('B', ['A', 'A'], 3)] });
    expect(dup.status).toBe('optimal');
    expect(dup.result!.projectDuration).toBe(5);
  });
});

describe('flow audit: crashing', () => {
  function randomCrash(r: () => number): ProjectModel {
    const n = randInt(r, 1, 4);
    const activities = Array.from({ length: n }, (_, i) => {
      const d = randInt(r, 2, 5);
      const cd = d - randInt(r, 0, Math.min(2, d - 1));
      const nc = randInt(r, 1, 9) * 10;
      return { id: `T${i}`, name: `T${i}`, predecessors: i > 0 && r() < 0.5 ? [`T${randInt(r, 0, i - 1)}`] : [], duration: d, crashDuration: cd, normalCost: nc, crashCost: nc + (d === cd ? 0 : randInt(r, 1, 40)) };
    });
    return { activities };
  }

  /** brute force over every integer reduction vector; exact slope arithmetic with fractions. */
  function bruteCrash(m: ProjectModel, target: number): number | null {
    const acts = m.activities;
    const slope = acts.map(a => (a.duration! > a.crashDuration! ? (a.crashCost! - a.normalCost!) / (a.duration! - a.crashDuration!) : 0));
    const maxRed = acts.map(a => a.duration! - a.crashDuration!);
    let best: number | null = null;
    const red = acts.map(() => 0);
    const rec = (i: number) => {
      if (i === acts.length) {
        const ef: Record<string, number> = {};
        let T = 0;
        acts.forEach((a, k) => { const es = Math.max(0, ...a.predecessors.map(p => ef[p]!)); ef[a.id] = es + a.duration! - red[k]!; T = Math.max(T, ef[a.id]!); });
        if (T <= target) { const c = red.reduce((s, x, k) => s + x * slope[k]!, 0); if (best === null || c < best) best = c; }
        return;
      }
      for (let x = 0; x <= maxRed[i]!; x++) { red[i] = x; rec(i + 1); }
    };
    rec(0);
    return best;
  }

  it('crashAtTarget equals the brute-force optimum, respects limits, handles infeasible targets', () => {
    const r = rng(9601);
    for (let t = 0; t < 250; t++) {
      const m = randomCrash(r);
      const normal = new ProjectSolver().solve(m, { emitSteps: false }).result!.projectDuration;
      for (let target = normal + 1; target >= 0; target--) {
        const want = bruteCrash(m, target);
        const got = crashAtTarget(m, target);
        const tag = `${JSON.stringify(m.activities)} T=${target}`;
        if (want === null) { expect(got, tag).toBeNull(); continue; }
        expect(got, tag).not.toBeNull();
        expect(got!.crashCost, tag).toBeCloseTo(want, 5);
        expect(got!.duration, tag).toBeLessThanOrEqual(target + 1e-9);
        m.activities.forEach(a => expect(got!.reductions[a.id] ?? 0, tag).toBeLessThanOrEqual(a.duration! - a.crashDuration! + 1e-9));
        expect(got!.totalCost).toBeCloseTo(m.activities.reduce((s, a) => s + a.normalCost!, 0) + want, 5);
      }
    }
  });

  it('crash curve is convex, non-decreasing in cost and ends at the true minimum duration', () => {
    const r = rng(9602);
    for (let t = 0; t < 150; t++) {
      const m = randomCrash(r);
      const normal = new ProjectSolver().solve(m, { emitSteps: false }).result!.projectDuration;
      const c = crashCurve(m, normal);
      const tag = JSON.stringify(m.activities);
      expect(c.curve[0]!.crashCost).toBeCloseTo(0, 6);
      for (let k = 1; k < c.curve.length; k++) {
        expect(c.curve[k]!.duration).toBeLessThan(c.curve[k - 1]!.duration);
        expect(c.curve[k]!.crashCost, tag).toBeGreaterThanOrEqual(c.curve[k - 1]!.crashCost - 1e-6);
      }
      // slopes (cost per time unit) never decrease while shortening: convexity
      for (let k = 2; k < c.curve.length; k++) {
        const s1 = (c.curve[k - 1]!.crashCost - c.curve[k - 2]!.crashCost) / (c.curve[k - 2]!.duration - c.curve[k - 1]!.duration);
        const s2 = (c.curve[k]!.crashCost - c.curve[k - 1]!.crashCost) / (c.curve[k - 1]!.duration - c.curve[k]!.duration);
        expect(s2, tag).toBeGreaterThanOrEqual(s1 - 1e-6);
      }
      let trueMin = normal;
      for (let T = normal - 1; T >= 0; T--) { if (bruteCrash(m, T) === null) break; trueMin = T; }
      expect(c.minDuration, tag).toBe(trueMin);
    }
  });

  it('non-terminating slopes are solved exactly, fractional crash limits are reachable', () => {
    const m: ProjectModel = { activities: [{ id: 'A', name: 'A', predecessors: [], duration: 7, crashDuration: 4, normalCost: 100, crashCost: 110 }] };
    const p = crashAtTarget(m, 4)!;
    expect(p.crashCost).toBeCloseTo(10, 9); // 3 units at 10/3 each
    const f: ProjectModel = { activities: [{ id: 'A', name: 'A', predecessors: [], duration: 5, crashDuration: 3.5, normalCost: 10, crashCost: 13 }] };
    const c = crashCurve(f, 5);
    expect(c.minDuration).toBeCloseTo(3.5, 9);
  });
});
