import { describe, it, expect } from 'vitest';
import { solveDijkstra, solveBellmanFord, solveFloydWarshall, solveMST, solveMaxFlow } from '../../src/core/solvers/network/network';
import { GraphModel } from '../../src/core/types/models';
import { solveLP } from '../../src/core/solvers/lp/engine';
import { Rational } from '../../src/core/math/rational';
import { randInt, rng } from '../helpers/bruteLP';

const R = (n: number) => Rational.of(n);
function randGraph(r: () => number, n: number, directed: boolean, neg = false): GraphModel {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: String(i + 1), label: String(i + 1) }));
  const edges: GraphModel['edges'] = [];
  let k = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j || r() < 0.55) continue;
    if (!directed && j < i) continue;
    edges.push({ id: `e${k++}`, from: String(i + 1), to: String(j + 1), weight: R(randInt(r, neg ? -2 : 1, 9)), directed });
  }
  return { nodes, edges, source: '1', sink: String(n) };
}

describe('shortest paths', () => {
  it('library example', () => {
    const g: GraphModel = { nodes: [1, 2, 3, 4].map(i => ({ id: String(i), label: String(i) })), edges: [['1', '2', 2], ['1', '3', 5], ['2', '3', 1], ['3', '4', 3]].map(([a, b, w], i) => ({ id: `e${i}`, from: a as string, to: b as string, weight: R(w as number), directed: true })), source: '1', sink: '4' };
    const s = solveDijkstra(g);
    expect(s.result!.totalDistance!.toString()).toBe('6');
    expect(s.result!.path).toEqual(['1', '2', '3', '4']);
  });
  it('Dijkstra = Bellman–Ford = Floyd on random graphs; negative edge refused by Dijkstra', () => {
    const r = rng(9);
    for (let t = 0; t < 150; t++) {
      const g = randGraph(r, randInt(r, 2, 6), r() < 0.5);
      const a = solveDijkstra(g, { variant: 'all' });
      const b = solveBellmanFord(g);
      const f = solveFloydWarshall(g);
      g.nodes.forEach((nd, j) => {
        const da = a.result!.distances[nd.id];
        const db = b.result!.distances[nd.id];
        expect(da?.toString() ?? null).toBe(db?.toString() ?? null);
        expect(f.result!.dist[0]![j]?.toString() ?? null).toBe(da?.toString() ?? null);
      });
    }
    const g = randGraph(rng(1), 4, true);
    g.edges[0]!.weight = R(-3);
    const bad = solveDijkstra(g);
    expect(bad.status).toBe('invalid-input');
    expect(bad.diagnostics.some(d => d.code === 'NEGATIVE_WEIGHT')).toBe(true);
  });
  it('negative cycle', () => {
    const g: GraphModel = { nodes: ['a', 'b', 'c'].map(x => ({ id: x, label: x })), edges: [['a', 'b', 1], ['b', 'c', -3], ['c', 'b', 1]].map(([f, t, w], i) => ({ id: `e${i}`, from: f as string, to: t as string, weight: R(w as number), directed: true })), source: 'a' };
    expect(solveBellmanFord(g).diagnostics.some(d => d.code === 'NEGATIVE_CYCLE')).toBe(true);
    expect(solveFloydWarshall(g).result!.negativeCycle).toBe(true);
  });
  it('unreachable nodes reported', () => {
    const g: GraphModel = { nodes: ['a', 'b', 'c'].map(x => ({ id: x, label: x })), edges: [{ id: 'e', from: 'a', to: 'b', weight: R(1), directed: true }], source: 'a', sink: 'b' };
    expect(solveDijkstra(g).diagnostics.some(d => d.code === 'UNREACHABLE')).toBe(true);
  });
});

describe('MST', () => {
  it('Kruskal and Prim agree on weight; disconnected gives a forest warning', () => {
    const r = rng(77);
    for (let t = 0; t < 100; t++) {
      const g = randGraph(r, randInt(r, 2, 7), false);
      const k = solveMST(g, 'kruskal');
      const p = solveMST(g, 'prim');
      if (k.result!.isConnected) expect(k.result!.totalWeight.eq(p.result!.totalWeight)).toBe(true);
      else expect(k.diagnostics.some(d => d.code === 'DISCONNECTED')).toBe(true);
    }
  });
});

describe('Max flow', () => {
  it('equals LP optimum and min-cut capacity; supports multiple terminals', () => {
    const r = rng(404);
    for (let t = 0; t < 100; t++) {
      const g = randGraph(r, randInt(r, 3, 6), true);
      if (!g.edges.length) continue;
      g.edges.forEach(e => (e.capacity = R(randInt(r, 0, 9))));
      const sol = solveMaxFlow(g);
      // LP formulation
      const es = g.edges;
      const nv = es.length;
      const cons: any[] = es.map((e, i) => ({ coeffs: Array.from({ length: nv }, (_, k) => (k === i ? Rational.ONE : Rational.ZERO)), relation: '<=', rhs: e.capacity! }));
      for (const nd of g.nodes) {
        if (nd.id === g.source || nd.id === g.sink) continue;
        cons.push({ coeffs: es.map(e => (e.to === nd.id ? Rational.ONE : e.from === nd.id ? Rational.MINUS_ONE : Rational.ZERO)), relation: '=', rhs: Rational.ZERO });
      }
      const obj = es.map(e => (e.from === g.source ? Rational.ONE : e.to === g.source ? Rational.MINUS_ONE : Rational.ZERO));
      const lp = solveLP({ sense: 'max', objective: obj, constraints: cons, varNames: es.map((_, i) => `f${i}`) }, { emitSteps: false });
      expect(sol.result!.maxFlow.toString()).toBe(lp.result!.objectiveValue.toString());
      expect(sol.result!.cutCapacity.toString()).toBe(sol.result!.maxFlow.toString());
      // per-edge flows are feasible and conserve flow
      const fl = new Proxy(sol.result!.flows, { get: (t, k: string) => t[k] ?? Rational.ZERO });
      g.edges.forEach(e => { expect(fl[e.id]!.gte(Rational.ZERO) && fl[e.id]!.lte(e.capacity!)).toBe(true); });
      for (const nd of g.nodes) { if (nd.id === g.source || nd.id === g.sink) continue; let net = Rational.ZERO; g.edges.forEach(e => { if (e.to === nd.id) net = net.add(fl[e.id]!); if (e.from === nd.id) net = net.sub(fl[e.id]!); }); expect(net.isZero()).toBe(true); }
    }
    const g: GraphModel = { nodes: ['a', 'b', 'c', 'd'].map(x => ({ id: x, label: x })), edges: [['a', 'c', 3], ['b', 'c', 4], ['c', 'd', 5]].map(([f, t, c], i) => ({ id: `e${i}`, from: f as string, to: t as string, weight: R(1), capacity: R(c as number), directed: true })), sources: ['a', 'b'], sinks: ['d'] };
    expect(solveMaxFlow(g).result!.maxFlow.toString()).toBe('5');
  });
});

describe('network audit regressions', () => {
  const nodes = ['1', '2', '3', '4', '5'].map(id => ({ id, label: id }));
  const E = (id: string, from: string, to: string, w: number, directed = false) => ({ id, from, to, weight: R(w), capacity: R(w), directed });

  it('Prim builds a full minimum spanning FOREST on a disconnected graph (same weight as Kruskal)', () => {
    const g: GraphModel = { nodes, edges: [E('a', '1', '2', 4), E('b', '2', '3', 1), E('c', '4', '5', 7), E('d', '1', '3', 2)], source: '1' };
    const k = solveMST(g, 'kruskal'), p = solveMST(g, 'prim');
    expect(p.result!.totalWeight.toString()).toBe(k.result!.totalWeight.toString());
    expect(p.result!.totalWeight.toString()).toBe('10');
    expect(p.result!.isConnected).toBe(false);
    expect(p.result!.selectedEdges.length).toBe(3);
  });

  it('shortest paths without a sink solve for every node and report no single route', () => {
    const g: GraphModel = { nodes, edges: [E('a', '1', '2', 3, true), E('b', '2', '3', 4, true)], source: '1' };
    for (const sol of [solveDijkstra(g), solveBellmanFord(g)]) {
      expect(sol.status).toBe('optimal');
      expect(sol.result!.distances['3']!.toString()).toBe('7');
      expect(sol.result!.path).toEqual([]);
      expect(sol.result!.totalDistance).toBeNull();
      expect(sol.result!.unreachable).toEqual(['4', '5']);
    }
  });

  it('a negative self-loop is refused (it is a negative cycle), not silently ignored', () => {
    const g: GraphModel = { nodes, edges: [E('a', '1', '2', 3, true), E('l', '2', '2', -1, true)], source: '1', sink: '2' };
    for (const sol of [solveDijkstra(g), solveBellmanFord(g), solveFloydWarshall(g)]) {
      expect(sol.status).toBe('invalid-input');
      expect(sol.diagnostics.some(d => d.code === 'NEGATIVE_SELF_LOOP')).toBe(true);
    }
    expect(solveMST(g, 'kruskal').status).toBe('optimal');
  });

  it('an undirected negative edge is reported as a negative cycle with an explanation', () => {
    const g: GraphModel = { nodes, edges: [E('a', '1', '2', 3), E('b', '2', '3', -2)], source: '1', sink: '3' };
    const sol = solveBellmanFord(g);
    expect(sol.status).toBe('unbounded');
    expect(sol.diagnostics.find(d => d.code === 'NEGATIVE_CYCLE')!.message).toContain('UNDIRECTED');
  });

  it('flows on undirected edges are never reported negative and respect capacity', () => {
    const g: GraphModel = { nodes, edges: [E('a', '3', '2', 5), E('b', '2', '1', 3), E('c', '3', '1', 2)], source: '1', sink: '3' };
    const sol = solveMaxFlow(g);
    expect(sol.result!.maxFlow.toString()).toBe('5');
    for (const e of g.edges) {
      const f = sol.result!.flows[e.id]!;
      expect(f.isNegative()).toBe(false);
      expect(f.lte(e.capacity!)).toBe(true);
    }
  });
});
