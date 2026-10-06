/**
 * Network models (spec §9.1 module 7, §10.3): Dijkstra, Bellman–Ford, Floyd–Warshall,
 * Kruskal, Prim, Edmonds–Karp / Ford–Fulkerson max flow. All emit the common Step contract.
 */

import { Rational } from '../../math/rational';
import { Solution, Diagnostic, SolveOptions, TerminationStatus } from '../../types/solver';
import { Step, Highlight } from '../../types/step';
import { GraphModel, GraphState } from '../../types/models';
import { joinList } from '../../format';

type Edge = GraphModel['edges'][number];
type Labels = GraphState['nodeLabels'];

const nodeName = (g: GraphModel, id: string) => g.nodes.find(n => n.id === id)?.label ?? id;
const edgeText = (g: GraphModel, e: Edge) => `${nodeName(g, e.from)}${e.directed ? '→' : '–'}${nodeName(g, e.to)}`;

export interface GraphIssues { diagnostics: Diagnostic[]; usable: Edge[]; fatal?: string; negativeLoop?: Edge }

/** Common validation: unknown endpoints, self-loops (ignored with a warning). */
export function checkGraph(g: GraphModel): GraphIssues {
  const diagnostics: Diagnostic[] = [];
  const ids = new Set(g.nodes.map(n => n.id));
  const usable: Edge[] = [];
  let negativeLoop: Edge | undefined;
  if (g.nodes.length === 0) return { diagnostics, usable, fatal: 'The graph has no nodes.' };
  for (const e of g.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      diagnostics.push({ severity: 'error', code: 'DANGLING_EDGE', message: `Edge ${e.id} refers to a node that does not exist.` });
      continue;
    }
    if (e.from === e.to) {
      if (e.weight.isNegative() && !negativeLoop) negativeLoop = e;
      diagnostics.push({ severity: 'warning', code: 'SELF_LOOP', message: `Self-loop on node ${nodeName(g, e.from)} ignored: a loop can never be part of a shortest path, spanning tree or flow.` });
      continue;
    }
    usable.push(e);
  }
  const pairs = new Map<string, number>();
  usable.forEach(e => { const k = e.directed ? `${e.from}>${e.to}` : [e.from, e.to].sort().join('~'); pairs.set(k, (pairs.get(k) ?? 0) + 1); });
  if ([...pairs.values()].some(c => c > 1)) diagnostics.push({ severity: 'info', code: 'PARALLEL_EDGES', message: 'Parallel edges are present; they are drawn separately and the algorithms use the best one automatically.' });
  return { diagnostics, usable, negativeLoop };
}

const negLoopMsg = (g: GraphModel, e: Edge) => `The self-loop on ${nodeName(g, e.from)} has negative weight ${e.weight.toString()}: it is a negative cycle by itself, so shortest distances are undefined (every lap makes the route shorter). Remove the loop or make its weight non-negative.`;

function mkSolution<S, R>(steps: Step<S>[], result: R | null, status: TerminationStatus, diagnostics: Diagnostic[], iterations: number, t0: number): Solution<S, R> {
  return { steps, result, status, diagnostics, metrics: { iterations, elapsedMs: Math.round((performance.now() - t0) * 100) / 100, degradedToFloat: false } };
}

const invalid = <R>(message: string, code: string, diags: Diagnostic[] = []): Solution<GraphState, R> => ({
  steps: [], result: null, status: 'invalid-input',
  diagnostics: [...diags, { severity: 'error', code, message }],
  metrics: { iterations: 0, elapsedMs: 0, degradedToFloat: false },
});

const cloneLabels = (l: Labels): Labels => Object.fromEntries(Object.entries(l).map(([k, v]) => [k, { ...v }]));

/* ================================================================== */
/* Shortest path: Dijkstra and Bellman–Ford                             */
/* ================================================================== */

export interface PathResult {
  distances: Record<string, Rational | null>;
  predecessor: Record<string, string | null>;
  path: string[];
  totalDistance: Rational | null;
  unreachable: string[];
  /** a negative cycle (node ids), Bellman–Ford only */
  negativeCycle?: string[];
}

function reconstruct(pred: Record<string, string | null>, target: string): string[] {
  const path: string[] = [];
  let cur: string | null = target;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) { guard.add(cur); path.unshift(cur); cur = pred[cur] ?? null; }
  return path;
}

export function solveDijkstra(g: GraphModel, options: SolveOptions = {}): Solution<GraphState, PathResult> {
  const t0 = performance.now();
  const { diagnostics, usable, fatal, negativeLoop } = checkGraph(g);
  if (fatal) return invalid(fatal, 'EMPTY_GRAPH', diagnostics);
  if (negativeLoop) return invalid(negLoopMsg(g, negativeLoop), 'NEGATIVE_SELF_LOOP', diagnostics);
  const src = g.source;
  if (!src || !g.nodes.some(n => n.id === src)) return invalid('Choose a source node.', 'NO_SOURCE', diagnostics);
  const neg = usable.filter(e => e.weight.isNegative());
  if (neg.length) {
    return invalid(`Dijkstra requires non-negative weights, but ${joinList(neg.map(e => `${edgeText(g, e)} (${e.weight.toString()})`))} is negative. Dijkstra's greedy "permanent label" argument is only valid when no later edge can shorten a finished distance. Use Bellman–Ford instead — it handles negative weights and detects negative cycles.`, 'NEGATIVE_WEIGHT', diagnostics);
  }
  const emit = options.emitSteps !== false;
  const steps: Step<GraphState>[] = [];
  const labels: Labels = {};
  g.nodes.forEach(n => (labels[n.id] = { value: null, permanent: false, pred: null }));
  labels[src]!.value = Rational.ZERO;
  const pred: Record<string, string | null> = Object.fromEntries(g.nodes.map(n => [n.id, null]));
  const selected: string[] = [];
  const visited: string[] = [];
  const snap = (extra: Partial<GraphState> = {}): GraphState => ({ nodeLabels: cloneLabels(labels), selectedEdges: [...selected], visitedNodes: [...visited], ...extra });
  const push = (phase: string, action: Step<GraphState>['action'], short: string, detailed: string, rule: string, hl: Highlight[], status: Step<GraphState>['status'], extra: Partial<GraphState> = {}) => {
    if (emit) steps.push({ index: steps.length, phase, state: snap(extra), action, explanation: { short, detailed, rule }, highlights: hl, status });
  };
  push('Initialisation', null, `Source ${nodeName(g, src)} gets label 0; every other node starts at ∞.`,
    `Dijkstra keeps a tentative distance for each node. The source starts at 0 and all others at ∞. Repeatedly the unfinished node with the smallest tentative distance becomes permanent (its distance can no longer be improved because all weights are ≥ 0), and its outgoing edges are relaxed.`,
    'Initialisation', [{ target: `node:${src}`, intent: 'optimal' }], 'initial');

  let iter = 0;
  while (true) {
    // choose min tentative
    let best: string | null = null;
    for (const n of g.nodes) {
      const l = labels[n.id]!;
      if (l.permanent || l.value === null) continue;
      if (best === null || l.value.lt(labels[best]!.value!)) best = n.id;
    }
    if (!best) break;
    labels[best]!.permanent = true;
    visited.push(best);
    iter++;
    if (pred[best]) {
      const via = usable.filter(e => (e.from === pred[best] && e.to === best) || (!e.directed && e.to === pred[best] && e.from === best))
        .sort((a, b) => a.weight.cmp(b.weight))[0];
      if (via) selected.push(via.id);
    }
    push('Permanent label', { kind: 'permanent', payload: { node: best } },
      `${nodeName(g, best)} becomes permanent with distance ${labels[best]!.value!.toString()}.`,
      `Among the unfinished nodes, ${nodeName(g, best)} has the smallest tentative distance ${labels[best]!.value!.toString()}. Because every weight is non-negative, no other route can reach it more cheaply, so the label is final.`,
      'Smallest tentative label', [{ target: `node:${best}`, intent: 'optimal' }], 'continue', { considering: best });
    if (g.sink && best === g.sink && options.variant !== 'all') {
      break;
    }
    const d = labels[best]!.value!;
    for (const e of usable) {
      const other = e.from === best ? e.to : !e.directed && e.to === best ? e.from : null;
      if (!other || labels[other]!.permanent) continue;
      const cand = d.add(e.weight);
      const cur = labels[other]!.value;
      if (cur === null || cand.lt(cur)) {
        labels[other]!.value = cand;
        labels[other]!.pred = best;
        pred[other] = best;
        push('Relaxation', { kind: 'relax', payload: { edge: e.id, node: other } },
          `Relax ${edgeText(g, e)}: ${nodeName(g, other)} improves to ${cand.toString()}.`,
          `${nodeName(g, best)} (${d.toString()}) + weight ${e.weight.toString()} = ${cand.toString()} is ${cur === null ? 'the first route found to' : `shorter than the current ${cur.toString()} for`} ${nodeName(g, other)}, so its label is updated and its predecessor becomes ${nodeName(g, best)}.`,
          'Label relaxation', [{ target: `node:${other}`, intent: 'entering' }, { target: `edge:${e.id}`, intent: 'candidate' }], 'continue', { considering: other });
      }
    }
  }
  // The search may stop as soon as the sink is final, so a missing label does not prove a node is unreachable: test reachability directly.
  const reach = new Set([src]);
  for (const stack = [src]; stack.length;) {
    const u = stack.pop()!;
    for (const e of usable) {
      const w = e.from === u ? e.to : !e.directed && e.to === u ? e.from : null;
      if (w && !reach.has(w)) { reach.add(w); stack.push(w); }
    }
  }
  const unreachable = g.nodes.filter(n => !reach.has(n.id)).map(n => n.id);
  if (unreachable.length) diagnostics.push({ severity: 'warning', code: 'UNREACHABLE', message: `Unreachable from ${nodeName(g, src)}: ${joinList(unreachable.map(u => nodeName(g, u)))}. The reachable part is still solved.` });
  const target = g.sink && g.nodes.some(n => n.id === g.sink) ? g.sink : null;
  if (!target) diagnostics.push({ severity: 'info', code: 'NO_TARGET', message: `No sink chosen: distances from ${nodeName(g, src)} to every node are shown. Pick a sink to also highlight one route.` });
  const path = target && labels[target]!.value !== null ? reconstruct(pred, target) : [];
  const distances = Object.fromEntries(g.nodes.map(n => [n.id, labels[n.id]!.value]));
  const total = target ? labels[target]!.value : null;
  const pathEdges = path.slice(1).map((v, k) => usable.filter(e => (e.from === path[k] && e.to === v) || (!e.directed && e.to === path[k] && e.from === v)).sort((a, b) => a.weight.cmp(b.weight))[0]?.id).filter(Boolean) as string[];
  const failed = !!target && total === null;
  push('Result', { kind: 'done', payload: {} },
    !target ? `All shortest distances from ${nodeName(g, src)} are final.` : failed ? `${nodeName(g, target)} cannot be reached from ${nodeName(g, src)}.` : `Shortest route to ${nodeName(g, target)}: ${path.map(p => nodeName(g, p)).join(' → ')} = ${total!.toString()}.`,
    !target ? 'Every reachable node now has a permanent label, which is its shortest distance from the source. Choose a sink to highlight a single route.' : failed ? `No directed path leads from the source to ${nodeName(g, target)}.` : `Following predecessor labels backwards from ${nodeName(g, target)} gives the shortest route with total length ${total!.toString()}.`,
    'Path reconstruction', pathEdges.map(id => ({ target: `edge:${id}`, intent: 'optimal' as const })), failed ? 'infeasible' : 'optimal', { currentPath: path, selectedEdges: pathEdges });
  return mkSolution(steps, { distances, predecessor: pred, path, totalDistance: total, unreachable }, failed ? 'infeasible' : 'optimal', diagnostics, iter, t0);
}

export function solveBellmanFord(g: GraphModel, options: SolveOptions = {}): Solution<GraphState, PathResult> {
  const t0 = performance.now();
  const { diagnostics, usable, fatal, negativeLoop } = checkGraph(g);
  if (fatal) return invalid(fatal, 'EMPTY_GRAPH', diagnostics);
  if (negativeLoop) return invalid(negLoopMsg(g, negativeLoop), 'NEGATIVE_SELF_LOOP', diagnostics);
  const src = g.source;
  if (!src || !g.nodes.some(n => n.id === src)) return invalid('Choose a source node.', 'NO_SOURCE', diagnostics);
  const emit = options.emitSteps !== false;
  const steps: Step<GraphState>[] = [];
  const labels: Labels = {};
  g.nodes.forEach(n => (labels[n.id] = { value: null, permanent: false, pred: null }));
  labels[src]!.value = Rational.ZERO;
  const pred: Record<string, string | null> = Object.fromEntries(g.nodes.map(n => [n.id, null]));
  const arcs: { e: Edge; u: string; v: string }[] = [];
  usable.forEach(e => { arcs.push({ e, u: e.from, v: e.to }); if (!e.directed) arcs.push({ e, u: e.to, v: e.from }); });
  const snap = (extra: Partial<GraphState> = {}): GraphState => ({ nodeLabels: cloneLabels(labels), selectedEdges: [], visitedNodes: [], ...extra });
  const push = (phase: string, action: Step<GraphState>['action'], short: string, detailed: string, status: Step<GraphState>['status'], extra: Partial<GraphState> = {}, hl: Highlight[] = []) => {
    if (emit) steps.push({ index: steps.length, phase, state: snap(extra), action, explanation: { short, detailed, rule: 'Bellman–Ford edge relaxation' }, highlights: hl, status });
  };
  push('Initialisation', null, `Source ${nodeName(g, src)} = 0, all others ∞.`, 'Bellman–Ford relaxes every edge, n−1 times. After pass k every shortest path with at most k edges is correct. An n-th pass that still improves a label proves a negative cycle.', 'initial');
  const n = g.nodes.length;
  let negCycleNode: string | null = null;
  let passes = 0;
  for (let pass = 1; pass <= n; pass++) {
    let changed = false;
    for (const a of arcs) {
      const du = labels[a.u]!.value;
      if (du === null) continue;
      const cand = du.add(a.e.weight);
      const cur = labels[a.v]!.value;
      if (cur === null || cand.lt(cur)) {
        labels[a.v]!.value = cand;
        labels[a.v]!.pred = a.u;
        pred[a.v] = a.u;
        changed = true;
        if (pass === n) negCycleNode = a.v;
      }
    }
    passes = pass;
    push(`Pass ${pass}`, { kind: 'pass', payload: { pass } }, pass === n ? (changed ? `Pass ${pass} (n-th) still changes labels: a negative cycle exists.` : `Pass ${pass}: no change.`) : `Pass ${pass}: ${changed ? 'labels improved' : 'no change — converged'}.`,
      pass === n && changed ? 'Shortest paths contain at most n−1 edges, so an improvement in the n-th pass can only come from a cycle of negative total weight.' : `All ${arcs.length} edge relaxations of pass ${pass} are applied in order.`, 'continue');
    if (!changed) break;
  }
  let negativeCycle: string[] | undefined;
  if (negCycleNode) {
    let x: string = negCycleNode;
    for (let k = 0; k < n; k++) x = pred[x] ?? x;
    const cyc = [x];
    for (let y = pred[x]; y && y !== x; y = pred[y] ?? null) cyc.unshift(y);
    cyc.unshift(x);
    negativeCycle = cyc;
    diagnostics.push({ severity: 'error', code: 'NEGATIVE_CYCLE', message: `Negative cycle ${cyc.map(c => nodeName(g, c)).join(' → ')}: going around it again always shortens the route, so the shortest path is undefined.${usable.some(e => !e.directed && e.weight.isNegative()) ? ' Note: an UNDIRECTED edge with negative weight can be walked back and forth, which is itself a negative cycle — make such edges directed.' : ''}` });
    push('Negative cycle', { kind: 'negative-cycle', payload: { cycle: cyc } }, `Negative cycle detected: ${cyc.map(c => nodeName(g, c)).join(' → ')}.`, 'Shortest distances are undefined for nodes reachable from this cycle.', 'unbounded', {}, cyc.map(c => ({ target: `node:${c}`, intent: 'blocked' as const })));
    return mkSolution(steps, { distances: Object.fromEntries(g.nodes.map(x2 => [x2.id, null])), predecessor: pred, path: [], totalDistance: null, unreachable: [], negativeCycle }, 'unbounded', diagnostics, passes, t0);
  }
  const unreachable = g.nodes.filter(x => labels[x.id]!.value === null).map(x => x.id);
  if (unreachable.length) diagnostics.push({ severity: 'warning', code: 'UNREACHABLE', message: `Unreachable from ${nodeName(g, src)}: ${joinList(unreachable.map(u => nodeName(g, u)))}.` });
  const target = g.sink && g.nodes.some(n => n.id === g.sink) ? g.sink : null;
  if (!target) diagnostics.push({ severity: 'info', code: 'NO_TARGET', message: `No sink chosen: distances from ${nodeName(g, src)} to every node are shown. Pick a sink to also highlight one route.` });
  const path = target && labels[target]!.value !== null ? reconstruct(pred, target) : [];
  const failed = !!target && labels[target]!.value === null;
  push('Result', { kind: 'done', payload: {} }, !target ? `All shortest distances from ${nodeName(g, src)} are final.` : path.length ? `Shortest route to ${nodeName(g, target)}: ${path.map(p => nodeName(g, p)).join(' → ')} = ${labels[target]!.value!.toString()}.` : `${nodeName(g, target)} is unreachable.`, 'Labels are final after convergence.', failed ? 'infeasible' : 'optimal', { currentPath: path });
  return mkSolution(steps, { distances: Object.fromEntries(g.nodes.map(x => [x.id, labels[x.id]!.value])), predecessor: pred, path, totalDistance: target ? labels[target]!.value : null, unreachable }, failed ? 'infeasible' : 'optimal', diagnostics, passes, t0);
}

/* ================================================================== */
/* Floyd–Warshall                                                       */
/* ================================================================== */

export interface FloydResult {
  nodes: string[];
  dist: (Rational | null)[][];
  next: (number | null)[][];
  negativeCycle: boolean;
  path: (from: number, to: number) => number[];
}

export function solveFloydWarshall(g: GraphModel, options: SolveOptions = {}): Solution<GraphState, FloydResult> {
  const t0 = performance.now();
  const { diagnostics, usable, fatal, negativeLoop } = checkGraph(g);
  if (fatal) return invalid(fatal, 'EMPTY_GRAPH', diagnostics);
  if (negativeLoop) return invalid(negLoopMsg(g, negativeLoop), 'NEGATIVE_SELF_LOOP', diagnostics);
  const ids = g.nodes.map(x => x.id);
  const n = ids.length;
  const ix = new Map(ids.map((id, i) => [id, i]));
  const dist: (Rational | null)[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? Rational.ZERO : null)));
  const next: (number | null)[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? i : null)));
  for (const e of usable) {
    const arcs: [number, number][] = [[ix.get(e.from)!, ix.get(e.to)!]];
    if (!e.directed) arcs.push([ix.get(e.to)!, ix.get(e.from)!]);
    for (const [u, v] of arcs) if (dist[u]![v] === null || e.weight.lt(dist[u]![v]!)) { dist[u]![v] = e.weight; next[u]![v] = v; }
  }
  const steps: Step<GraphState>[] = [];
  const emit = options.emitSteps !== false;
  const snap = (pivot?: string): GraphState => ({
    nodeLabels: {}, selectedEdges: [], visitedNodes: [], nodeOrder: ids,
    distMatrix: dist.map(r => [...r]), nextMatrix: next.map(r => [...r]), pivotNode: pivot,
  });
  const push = (phase: string, short: string, detailed: string, status: Step<GraphState>['status'], pivot?: string, hl: Highlight[] = []) => {
    if (emit) steps.push({ index: steps.length, phase, state: snap(pivot), action: null, explanation: { short, detailed, rule: 'Floyd–Warshall triple operation' }, highlights: hl, status });
  };
  push('Initialisation', 'D⁽⁰⁾: direct edge weights, 0 on the diagonal, ∞ elsewhere.', 'D(i,j) holds the best known distance using only intermediate nodes already processed. Initially no intermediate node is allowed.', 'initial');
  let negative = false;
  for (let k = 0; k < n; k++) {
    const changed: string[] = [];
    const hl: Highlight[] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const a = dist[i]![k] ?? null;
      const b = dist[k]![j] ?? null;
      if (a === null || b === null) continue;
      const cand = a.add(b);
      if (dist[i]![j] === null || cand.lt(dist[i]![j]!)) {
        changed.push(`${nodeName(g, ids[i]!)}→${nodeName(g, ids[j]!)}: ${dist[i]![j] === null ? '∞' : dist[i]![j]!.toString()} → ${cand.toString()}`);
        dist[i]![j] = cand;
        next[i]![j] = next[i]![k]!;
        hl.push({ target: `cell:${i},${j}`, intent: 'changed' });
      }
    }
    if (dist.some((row, i) => row[i] !== null && row[i]!.isNegative())) negative = true;
    push(`Pivot ${nodeName(g, ids[k]!)}`, `Allow ${nodeName(g, ids[k]!)} as an intermediate node: ${changed.length} distance(s) improve.`,
      changed.length ? `D(i,j) ← min(D(i,j), D(i,${nodeName(g, ids[k]!)}) + D(${nodeName(g, ids[k]!)},j)). Improved: ${changed.join('; ')}.` : `Routing through ${nodeName(g, ids[k]!)} improves nothing.`,
      negative ? 'unbounded' : 'continue', ids[k], hl);
    if (negative) break;
  }
  if (negative) diagnostics.push({ severity: 'error', code: 'NEGATIVE_CYCLE', message: 'A negative cycle exists (a diagonal entry became negative): shortest paths through it are undefined.' });
  const unreachablePairs = dist.flatMap((r, i) => r.map((v, j) => (v === null ? [i, j] : null)).filter(Boolean) as number[][]);
  if (unreachablePairs.length) diagnostics.push({ severity: 'info', code: 'UNREACHABLE_PAIRS', message: `${unreachablePairs.length} ordered pair(s) have no connecting route (shown as ∞).` });
  const path = (from: number, to: number): number[] => {
    if (dist[from]![to] === null) return [];
    const out = [from];
    let cur = from;
    let guard = 0;
    while (cur !== to && guard++ < n + 1) { cur = next[cur]![to]!; if (cur === null || cur === undefined) return []; out.push(cur); }
    return out;
  };
  if (emit) steps[steps.length - 1]!.status = negative ? 'unbounded' : 'optimal';
  return mkSolution(steps, { nodes: ids, dist, next, negativeCycle: negative, path }, negative ? 'unbounded' : 'optimal', diagnostics, n, t0);
}

/* ================================================================== */
/* Minimum spanning tree                                                */
/* ================================================================== */

export interface MSTResult { selectedEdges: string[]; totalWeight: Rational; isConnected: boolean; components: string[][]; }

class DSU {
  parent = new Map<string, string>();
  constructor(ids: string[]) { ids.forEach(i => this.parent.set(i, i)); }
  find(x: string): string { const p = this.parent.get(x)!; if (p === x) return x; const r = this.find(p); this.parent.set(x, r); return r; }
  union(a: string, b: string): boolean { const ra = this.find(a); const rb = this.find(b); if (ra === rb) return false; this.parent.set(ra, rb); return true; }
}

export function solveMST(g: GraphModel, algorithm: 'kruskal' | 'prim' = 'kruskal', options: SolveOptions = {}): Solution<GraphState, MSTResult> {
  const t0 = performance.now();
  const { diagnostics, usable, fatal } = checkGraph(g);
  if (fatal) return invalid(fatal, 'EMPTY_GRAPH', diagnostics);
  const emit = options.emitSteps !== false;
  const steps: Step<GraphState>[] = [];
  const chosen: string[] = [];
  const rejected: string[] = [];
  let total = Rational.ZERO;
  const visited: string[] = [];
  const snap = (considering: string | null = null): GraphState => ({ nodeLabels: {}, selectedEdges: [...chosen], rejectedEdges: [...rejected], visitedNodes: [...visited], considering, totalWeight: total });
  const push = (phase: string, short: string, detailed: string, rule: string, hl: Highlight[], status: Step<GraphState>['status'], considering: string | null = null) => {
    if (emit) steps.push({ index: steps.length, phase, state: snap(considering), action: null, explanation: { short, detailed, rule }, highlights: hl, status });
  };
  const ids = g.nodes.map(x => x.id);
  if (usable.some(e => e.directed)) diagnostics.push({ severity: 'info', code: 'DIRECTED_IGNORED', message: 'Edge directions are ignored: spanning trees are defined on undirected graphs.' });

  if (algorithm === 'kruskal') {
    const sorted = [...usable].sort((a, b) => a.weight.cmp(b.weight) || a.id.localeCompare(b.id));
    const dsu = new DSU(ids);
    push('Initialisation', `Sort the ${sorted.length} edges by weight.`, `Kruskal examines edges from lightest to heaviest and keeps an edge exactly when it connects two different components (otherwise it would close a cycle). Order: ${sorted.map(e => `${edgeText(g, e)}(${e.weight.toString()})`).join(', ')}.`, 'Kruskal initialisation', [], 'initial');
    for (const e of sorted) {
      if (chosen.length === ids.length - 1) break;
      if (dsu.union(e.from, e.to)) {
        chosen.push(e.id);
        total = total.add(e.weight);
        push('Add edge', `Add ${edgeText(g, e)} (${e.weight.toString()}); total ${total.toString()}.`, `${nodeName(g, e.from)} and ${nodeName(g, e.to)} are in different components, so the edge is safe (cut property) and merges them.`, 'Cycle test passed', [{ target: `edge:${e.id}`, intent: 'optimal' }], 'continue', e.id);
      } else {
        rejected.push(e.id);
        push('Reject edge', `Reject ${edgeText(g, e)}: it would form a cycle.`, `${nodeName(g, e.from)} and ${nodeName(g, e.to)} are already connected through chosen edges, so adding it creates a cycle.`, 'Cycle test failed', [{ target: `edge:${e.id}`, intent: 'blocked' }], 'continue', e.id);
      }
    }
  } else {
    const start = g.source && ids.includes(g.source) ? g.source : ids[0]!;
    const inTree = new Set([start]);
    visited.push(start);
    push('Initialisation', `Grow a tree from ${nodeName(g, start)}.`, 'Prim repeatedly adds the cheapest edge leaving the current tree.', 'Prim initialisation', [{ target: `node:${start}`, intent: 'optimal' }], 'initial');
    while (inTree.size < ids.length) {
      const frontier = usable.filter(e => (inTree.has(e.from) !== inTree.has(e.to)));
      if (!frontier.length) {
        const restart = ids.find(x => !inTree.has(x))!;
        inTree.add(restart);
        visited.push(restart);
        push('New component', `${nodeName(g, restart)} cannot be reached from the tree so far — start a new tree there.`, `No edge leaves the current tree, so the graph is disconnected. Prim is restarted from ${nodeName(g, restart)} to build a minimum spanning forest (one tree per component).`, 'Prim restart', [{ target: `node:${restart}`, intent: 'optimal' }], 'continue');
        continue;
      }
      const best = frontier.reduce((a, b) => (b.weight.lt(a.weight) ? b : a));
      const newNode = inTree.has(best.from) ? best.to : best.from;
      inTree.add(newNode);
      visited.push(newNode);
      chosen.push(best.id);
      total = total.add(best.weight);
      push('Add edge', `Add ${edgeText(g, best)} (${best.weight.toString()}), bringing in ${nodeName(g, newNode)}.`, `Edges leaving the tree: ${frontier.map(e => `${edgeText(g, e)}(${e.weight.toString()})`).join(', ')}. The cheapest is ${edgeText(g, best)}.`, 'Cheapest crossing edge', [{ target: `edge:${best.id}`, intent: 'optimal' }, { target: `node:${newNode}`, intent: 'entering' }], 'continue', best.id);
    }
  }
  const dsu2 = new DSU(ids);
  chosen.forEach(id => { const e = usable.find(x => x.id === id)!; dsu2.union(e.from, e.to); });
  const comps = new Map<string, string[]>();
  ids.forEach(i => { const r = dsu2.find(i); comps.set(r, [...(comps.get(r) ?? []), i]); });
  const components = [...comps.values()];
  const connected = components.length === 1;
  if (!connected) diagnostics.push({ severity: 'warning', code: 'DISCONNECTED', message: `The graph is disconnected (${components.length} components), so no spanning tree exists; a minimum spanning FOREST of weight ${total.toString()} was built: ${components.map(c => `{${c.map(x => nodeName(g, x)).join(', ')}}`).join(' ')}.` });
  push('Result', connected ? `Minimum spanning tree weight = ${total.toString()}.` : `Minimum spanning forest weight = ${total.toString()}.`, `Selected edges: ${chosen.map(id => edgeText(g, usable.find(e => e.id === id)!)).join(', ') || 'none'}.`, 'Completion', chosen.map(id => ({ target: `edge:${id}`, intent: 'optimal' as const })), 'optimal');
  return mkSolution(steps, { selectedEdges: [...chosen], totalWeight: total, isConnected: connected, components }, 'optimal', diagnostics, chosen.length, t0);
}

/* ================================================================== */
/* Maximum flow (Edmonds–Karp / Ford–Fulkerson)                         */
/* ================================================================== */

export interface MaxFlowResult {
  maxFlow: Rational;
  flows: Record<string, Rational>; // per edge id (net flow for undirected edges)
  sourceSide: string[];
  sinkSide: string[];
  cutEdges: string[];
  cutCapacity: Rational;
}

interface Arc { id: string; edge: string; from: string; to: string; cap: Rational | null; flow: Rational; rev: number }

export function solveMaxFlow(g: GraphModel, options: SolveOptions & { dfs?: boolean } = {}): Solution<GraphState, MaxFlowResult> {
  const t0 = performance.now();
  const { diagnostics, usable, fatal } = checkGraph(g);
  if (fatal) return invalid(fatal, 'EMPTY_GRAPH', diagnostics);
  const known = new Set(g.nodes.map(x => x.id));
  const sources = [...new Set((g.sources?.length ? g.sources : g.source ? [g.source] : []).filter(x => known.has(x)))];
  const sinks = [...new Set((g.sinks?.length ? g.sinks : g.sink ? [g.sink] : []).filter(x => known.has(x)))];
  if (!sources.length || !sinks.length) return invalid('Choose a source and a sink node.', 'NO_TERMINALS', diagnostics);
  if (sources.some(s => sinks.includes(s))) return invalid('A node cannot be both source and sink.', 'TERMINAL_CLASH', diagnostics);
  const augmented: string[] = [];
  let S = sources[0]!;
  let T = sinks[0]!;
  const nodes = g.nodes.map(x => x.id);
  const extra: { from: string; to: string; id: string }[] = [];
  if (sources.length > 1) { S = '⊕S'; nodes.push(S); augmented.push(S); sources.forEach(s => extra.push({ from: S, to: s, id: `super:${s}` })); diagnostics.push({ severity: 'info', code: 'SUPER_SOURCE', message: `Several sources: a super-source ⊕S with infinite-capacity edges to ${joinList(sources.map(s => nodeName(g, s)))} is added.` }); }
  if (sinks.length > 1) { T = '⊕T'; nodes.push(T); augmented.push(T); sinks.forEach(s => extra.push({ from: s, to: T, id: `supert:${s}` })); diagnostics.push({ severity: 'info', code: 'SUPER_SINK', message: `Several sinks: a super-sink ⊕T with infinite-capacity edges from ${joinList(sinks.map(s => nodeName(g, s)))} is added.` }); }

  const arcs: Arc[] = [];
  const adj = new Map<string, number[]>();
  nodes.forEach(x => adj.set(x, []));
  const addArc = (id: string, edge: string, u: string, v: string, cap: Rational | null, revCap: Rational | null) => {
    const a: Arc = { id: `${id}`, edge, from: u, to: v, cap, flow: Rational.ZERO, rev: arcs.length + 1 };
    const b: Arc = { id: `${id}~`, edge, from: v, to: u, cap: revCap, flow: Rational.ZERO, rev: arcs.length };
    adj.get(u)!.push(arcs.length); arcs.push(a);
    adj.get(v)!.push(arcs.length); arcs.push(b);
  };
  for (const e of usable) {
    const cap = e.capacity ?? e.weight;
    if (cap.isZero()) { diagnostics.push({ severity: 'info', code: 'ZERO_CAPACITY', message: `Edge ${edgeText(g, e)} has capacity 0 and is treated as absent.` }); continue; }
    if (cap.isNegative()) return invalid(`Edge ${edgeText(g, e)} has negative capacity.`, 'NEGATIVE_CAPACITY', diagnostics);
    addArc(e.id, e.id, e.from, e.to, cap, e.directed ? Rational.ZERO : cap);
  }
  for (const x of extra) addArc(x.id, x.id, x.from, x.to, null, Rational.ZERO);

  const emit = options.emitSteps !== false;
  const steps: Step<GraphState>[] = [];
  let value = Rational.ZERO;
  const residualOf = (a: Arc): Rational | null => (a.cap === null ? null : a.cap.sub(a.flow));
  const netFlows = (): Record<string, Rational> => {
    const f: Record<string, Rational> = {};
    for (let k = 0; k < arcs.length; k += 2) { const fl = arcs[k]!.flow; f[arcs[k]!.edge] = fl.isNegative() ? fl.neg() : fl; }
    return f;
  };
  const snap = (path: string[] | undefined, cut?: { side: string[]; edges: string[] }): GraphState => {
    const residual: Record<string, Rational | null> = {};
    arcs.forEach(a => { residual[a.id] = residualOf(a); });
    return { nodeLabels: {}, selectedEdges: [], visitedNodes: [], flows: netFlows(), residual, currentPath: path, flowValue: value, sourceSide: cut?.side, cutEdges: cut?.edges, augmentedNodes: augmented };
  };
  const push = (phase: string, short: string, detailed: string, rule: string, hl: Highlight[], status: Step<GraphState>['status'], path?: string[], cut?: { side: string[]; edges: string[] }) => {
    if (emit) steps.push({ index: steps.length, phase, state: snap(path, cut), action: null, explanation: { short, detailed, rule }, highlights: hl, status });
  };
  push('Initialisation', 'Start with zero flow.', `The residual graph initially equals the capacity graph. Each round finds an augmenting path from ${nodeName(g, S)} to ${nodeName(g, T)} with positive residual capacity (${options.dfs ? 'depth-first: Ford–Fulkerson' : 'shortest by edge count: Edmonds–Karp'}) and pushes the bottleneck amount along it.`, 'Flow initialisation', [], 'initial');

  let rounds = 0;
  while (true) {
    const prev = new Map<string, number>();
    const seen = new Set([S]);
    const frontier = [S];
    while (frontier.length && !seen.has(T)) {
      const u = options.dfs ? frontier.pop()! : frontier.shift()!;
      for (const ai of adj.get(u)!) {
        const a = arcs[ai]!;
        const r = residualOf(a);
        if ((r === null || r.isPositive()) && !seen.has(a.to)) { seen.add(a.to); prev.set(a.to, ai); frontier.push(a.to); }
      }
    }
    if (!seen.has(T)) {
      const side = [...seen];
      const cutEdges = usable.filter(e => (side.includes(e.from) && !side.includes(e.to)) || (!e.directed && side.includes(e.to) && !side.includes(e.from))).filter(e => !(e.capacity ?? e.weight).isZero()).map(e => e.id);
      let cutCap = Rational.ZERO;
      cutEdges.forEach(id => { const e = usable.find(x => x.id === id)!; cutCap = cutCap.add(e.capacity ?? e.weight); });
      const sinkSide = nodes.filter(x => !side.includes(x));
      push('Maximum flow', `No augmenting path remains: maximum flow = ${value.toString()}.`, `From ${nodeName(g, S)} the nodes reachable in the residual graph are {${side.map(x => nodeName(g, x)).join(', ')}}. Every edge leaving this set is saturated, so they form a minimum cut of capacity ${cutCap.toString()} = the flow value (max-flow min-cut theorem).`, 'Max-flow min-cut', cutEdges.map(id => ({ target: `edge:${id}`, intent: 'critical' as const })), 'optimal', undefined, { side, edges: cutEdges });
      return mkSolution(steps, { maxFlow: value, flows: netFlows(), sourceSide: side, sinkSide, cutEdges, cutCapacity: cutCap }, 'optimal', diagnostics, rounds, t0);
    }
    const path: number[] = [];
    let cur = T;
    while (cur !== S) { const ai = prev.get(cur)!; path.unshift(ai); cur = arcs[ai]!.from; }
    let bott: Rational | null = null;
    for (const ai of path) { const r = residualOf(arcs[ai]!); if (r !== null && (bott === null || r.lt(bott))) bott = r; }
    if (bott === null) {
      diagnostics.push({ severity: 'error', code: 'UNBOUNDED_FLOW', message: 'An augmenting path with unlimited capacity exists: the maximum flow is unbounded.' });
      return mkSolution<GraphState, MaxFlowResult>(steps, null, 'unbounded', diagnostics, rounds, t0);
    }
    for (const ai of path) { arcs[ai]!.flow = arcs[ai]!.flow.add(bott); arcs[arcs[ai]!.rev]!.flow = arcs[arcs[ai]!.rev]!.flow.sub(bott); }
    value = value.add(bott);
    rounds++;
    const names = [S, ...path.map(ai => arcs[ai]!.to)].map(x => nodeName(g, x));
    push(`Augmentation ${rounds}`, `Augment ${bott.toString()} along ${names.join(' → ')}; flow = ${value.toString()}.`, `Residual capacities along the path are ${path.map(ai => (residualOf(arcs[ai]!) === null ? '∞' : residualOf(arcs[ai]!)!.add(bott!).toString())).join(', ')}; the bottleneck is ${bott.toString()}. Pushing it increases the flow on forward arcs and (via the reverse arcs) leaves room to undo it later.`, options.dfs ? 'Ford–Fulkerson augmentation' : 'Edmonds–Karp augmentation', path.map(ai => ({ target: `edge:${arcs[ai]!.edge}`, intent: 'changed' as const })), 'continue', [S, ...path.map(ai => arcs[ai]!.to)]);
    if (rounds > 5000) { diagnostics.push({ severity: 'error', code: 'ITERATION_LIMIT', message: 'Too many augmentations.' }); return mkSolution<GraphState, MaxFlowResult>(steps, null, 'iteration-limit', diagnostics, rounds, t0); }
  }
}
