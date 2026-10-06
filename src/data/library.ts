/**
 * Curated problem library (F16): textbook-style problems for every module, each with a known answer
 * that the automated test-suite re-derives with the solvers.
 */
import { ModuleId, LPSpec, TransportSpec, AssignSpec, GraphSpec, ProjectSpec, QueueSpec, InventorySpec, GameSpec, MarkovSpec, SimSpec, NLPSpec } from './specs';

export interface LibraryEntry {
  id: string;
  module: ModuleId;
  variant?: string;
  title: string;
  source: string;
  description: string;
  /** teaching tag(s) */
  tags: string[];
  spec: unknown;
  /** human-readable expected answer */
  expected: string;
  /** machine-checked key value (string form of the main number) */
  check?: string;
}

const lp = (text: string): LPSpec => ({ text });
const sn = (n: number) => String(n);
const mat = (rows: number[][]): string[][] => rows.map(r => r.map(sn));
const D0 = { type: 'exponential' as const, p1: '2', p2: '', p3: '', values: '' };

const graph = (nodes: [string, number, number][], edges: [string, string, number, number?, boolean?][], source: string, sink: string, extra: Partial<GraphSpec> = {}): GraphSpec => ({
  nodes: nodes.map(([id, x, y]) => ({ id, label: id, x, y })),
  edges: edges.map(([f, t, w, c, d], i) => ({ id: `e${i + 1}`, from: f, to: t, weight: sn(w), capacity: sn(c ?? w), directed: d ?? true })),
  source, sink, sources: [], sinks: [], ...extra,
});

const act = (id: string, pred: string, duration: number | string, o: Partial<ProjectSpec['activities'][number]> = {}): ProjectSpec['activities'][number] => ({ id, pred, duration: String(duration), a: '', m: '', b: '', normalCost: '', crashDuration: '', crashCost: '', ...o });

const queue = (o: Partial<QueueSpec>): QueueSpec => ({ model: 'mm1', lambda: '2', mu: '3', servers: '1', capacity: '', sigma: '', Cs: '', Cw: '', basis: 'system', ...o });

const inv = (o: Partial<InventorySpec>): InventorySpec => ({ model: 'eoq', D: '1000', K: '100', h: '2', hRate: false, c: '10', L: '', k: '', p: '', breaks: [{ minQty: '0', price: '10' }], discountType: 'allUnits', price: '10', salvage: '2', goodwill: '0', dist: 'normal', mean: '100', sd: '20', umin: '50', umax: '150', discrete: [{ demand: '10', prob: '0.3' }, { demand: '20', prob: '0.4' }, { demand: '30', prob: '0.3' }], ...o });

const sim = (o: Partial<SimSpec>): SimSpec => ({
  kind: 'montecarlo', seed: '12345', generator: 'mt', vars: [{ name: 'x', dist: { type: 'uniform', p1: '0', p2: '1', p3: '', values: '' } }, { name: 'y', dist: { type: 'uniform', p1: '0', p2: '1', p3: '', values: '' } }],
  expression: '4*step(1 - x*x - y*y)', trials: '20000', threshold: '', interarrival: D0, service: { type: 'exponential', p1: '3', p2: '', p3: '', values: '' }, servers: '1', customers: '2000', warmup: '100', ...o,
});

export const LIBRARY: LibraryEntry[] = [
  /* ---------------- Linear programming ---------------- */
  { id: 'lp-wyndor', module: 'lp', title: 'Wyndor Glass — product mix', source: 'Hillier & Lieberman, §3.1', description: 'Classic two-variable maximisation; all constraints ≤ so plain simplex applies. Try the graphical tab and the sensitivity sliders.', tags: ['standard simplex', 'graphical', 'sensitivity'], spec: lp('max 3x1 + 5x2\nsubject to\n  plant1: x1 <= 4\n  plant2: 2x2 <= 12\n  plant3: 3x1 + 2x2 <= 18\n  x1, x2 >= 0'), expected: 'x = (2, 6), z = 36; shadow prices 0, 3/2, 1', check: '36' },
  { id: 'lp-reddy', module: 'lp', title: 'Reddy Mikks paint company', source: 'Taha, Example 2.1-1', description: 'Exterior and interior paint from two raw materials with market limits.', tags: ['standard simplex', 'graphical'], spec: lp('max 5x1 + 4x2\nsubject to\n  M1: 6x1 + 4x2 <= 24\n  M2: x1 + 2x2 <= 6\n  Market: -x1 + x2 <= 1\n  Demand: x2 <= 2\n  x1, x2 >= 0'), expected: 'x = (3, 3/2), z = 21', check: '21' },
  { id: 'lp-twophase', module: 'lp', variant: 'twoPhase', title: 'Two-Phase method — mixed constraints', source: 'Taha, Example 3.4-2', description: 'An equality and a ≥ constraint force artificial variables; Phase I finds a feasible vertex.', tags: ['two-phase'], spec: lp('min 4x1 + x2\nsubject to\n  3x1 + x2 = 3\n  4x1 + 3x2 >= 6\n  x1 + 2x2 <= 4\n  x1, x2 >= 0'), expected: 'x = (2/5, 9/5), z = 17/5', check: '17/5' },
  { id: 'lp-bigm', module: 'lp', variant: 'bigM', title: 'Big-M method — same model', source: 'Taha, Example 3.4-1', description: 'The same problem solved with a symbolic penalty M instead of two phases.', tags: ['big-M'], spec: lp('min 4x1 + x2\nsubject to\n  3x1 + x2 = 3\n  4x1 + 3x2 >= 6\n  x1 + 2x2 <= 4\n  x1, x2 >= 0'), expected: 'x = (2/5, 9/5), z = 17/5', check: '17/5' },
  { id: 'lp-dual', module: 'lp', variant: 'dual', title: 'Dual simplex', source: 'Taha, §4.4', description: 'Starts optimal but infeasible (negative RHS after turning ≥ into ≤); each pivot repairs feasibility.', tags: ['dual simplex'], spec: lp('min 3x1 + 2x2\nsubject to\n  3x1 + x2 >= 3\n  4x1 + 3x2 >= 6\n  x1 + x2 <= 3\n  x1, x2 >= 0'), expected: 'x = (3/5, 6/5), z = 21/5', check: '21/5' },
  { id: 'lp-unbounded', module: 'lp', title: 'Unbounded objective', source: 'Edge-case register §10.1', description: 'No constraint stops x₁ from growing — the solver names the direction of unbounded improvement.', tags: ['edge case'], spec: lp('max 2x1 + x2\nsubject to\n  x1 - x2 <= 10\n  x1, x2 >= 0'), expected: 'Unbounded', check: 'unbounded' },
  { id: 'lp-infeasible', module: 'lp', title: 'Infeasible constraints', source: 'Edge-case register §10.1', description: 'Contradictory constraints: Phase I ends with w > 0 and the conflicting rows are named.', tags: ['edge case'], spec: lp('max x1 + x2\nsubject to\n  x1 + x2 <= 2\n  x1 + x2 >= 5\n  x1, x2 >= 0'), expected: 'Infeasible', check: 'infeasible' },
  { id: 'lp-alt', module: 'lp', title: 'Alternate optima', source: 'Taha, §3.5', description: 'The objective is parallel to the first constraint: a whole edge is optimal.', tags: ['edge case', 'graphical'], spec: lp('max 2x1 + 4x2\nsubject to\n  x1 + 2x2 <= 5\n  x1 + x2 <= 4\n  x1, x2 >= 0'), expected: 'z = 10; optimal edge from (0, 5/2) to (3, 1)', check: '10' },
  { id: 'lp-beale', module: 'lp', title: 'Degeneracy and cycling (Beale)', source: 'Beale 1955', description: 'The classic example on which Dantzig\'s rule alone can cycle forever; the engine ties-breaks lexicographically and detects repeats.', tags: ['edge case', 'degeneracy'], spec: lp('max 3/4x1 - 20x2 + 1/2x3 - 6x4\nsubject to\n  1/4x1 - 8x2 - x3 + 9x4 <= 0\n  1/2x1 - 12x2 - 1/2x3 + 3x4 <= 0\n  x3 <= 1'), expected: 'z = 5/4', check: '5/4' },
  { id: 'lp-free', module: 'lp', title: 'Free (unrestricted) variable', source: 'Spec §10.1', description: 'x₁ may be negative: it is replaced by x₁⁺ − x₁⁻ and the substitution is shown.', tags: ['edge case'], spec: lp('min x1 + 2x2\nsubject to\n  x1 + x2 >= -3\n  x2 <= 5\n  x2 >= 1\n  free x1'), expected: 'z = −2 at x = (−4, 1)', check: '-2' },
  { id: 'lp-diet', module: 'lp', title: 'Diet problem', source: 'Stigler-style', description: 'Minimise cost of two foods meeting protein, fat and calorie minima.', tags: ['two-phase', 'sensitivity'], spec: lp('min 0.6x1 + 0.35x2\nsubject to\n  protein: 5x1 + 7x2 >= 8\n  fat: 4x1 + 2x2 >= 15\n  calories: 2x1 + 1x2 >= 3\n  x1, x2 >= 0'), expected: 'See solution', check: '' },

  /* ---------------- Integer programming ---------------- */
  { id: 'int-taha', module: 'integer', title: 'Branch & bound — Taha classic', source: 'Taha, Example 9.2-1', description: 'LP relaxation z = 21 at (3, 3/2); the integer optimum is lower. Watch the tree grow.', tags: ['branch and bound', 'gomory'], spec: lp('max 5x1 + 4x2\nsubject to\n  6x1 + 4x2 <= 24\n  x1 + 2x2 <= 6\n  int x1, x2'), expected: 'x = (4, 0), z = 20 (LP bound 21)', check: '20' },
  { id: 'int-taha2', module: 'integer', title: 'Two-variable ILP', source: 'Taha, Problem 9.2', description: 'Fractional LP optimum (15/4, 5/4).', tags: ['branch and bound'], spec: lp('max 5x1 + 4x2\nsubject to\n  x1 + x2 <= 5\n  10x1 + 6x2 <= 45\n  int x1, x2'), expected: 'z = 23', check: '23' },
  { id: 'int-knap', module: 'integer', title: '0-1 knapsack', source: 'Classic', description: 'Choose items under a weight limit; all variables binary.', tags: ['binary', 'branch and bound'], spec: lp('max 10x1 + 13x2 + 7x3 + 8x4\nsubject to\n  5x1 + 7x2 + 4x3 + 3x4 <= 14\n  bin x1, x2, x3, x4'), expected: 'z = 28', check: '28' },
  { id: 'int-mixed', module: 'integer', title: 'Mixed integer', source: 'Spec §9.1', description: 'Only x is integer; y stays continuous (mixed-integer Gomory cut).', tags: ['mixed', 'gomory'], spec: lp('max 2x + 3y\nsubject to\n  2x + 4y <= 9\n  3x + y <= 7\n  int x'), expected: 'See solution', check: '' },
  { id: 'int-infeasible', module: 'integer', title: 'Integer-infeasible', source: 'Edge-case register §10.5', description: 'The LP is feasible (x = 3/2) but no integer satisfies 2x = 3.', tags: ['edge case'], spec: lp('max x1\nsubject to\n  2x1 = 3\n  int x1'), expected: 'Integer infeasible', check: 'infeasible' },

  /* ---------------- Transportation ---------------- */
  { id: 'tr-taha', module: 'transport', variant: 'vam', title: 'SunRay transport', source: 'Taha, Example 5.1-1', description: 'Three sources, four destinations, balanced. Compare NWC, least-cost and VAM with the Method Comparison tab.', tags: ['VAM', 'MODI', 'comparison'], spec: { rows: ['S1', 'S2', 'S3'], cols: ['D1', 'D2', 'D3', 'D4'], costs: mat([[10, 2, 20, 11], [12, 7, 9, 20], [4, 14, 16, 18]]), supply: ['15', '25', '10'], demand: ['5', '15', '15', '15'], objective: 'min' } satisfies TransportSpec, expected: 'Optimal cost 435', check: '435' },
  { id: 'tr-unbal', module: 'transport', variant: 'lcm', title: 'Unbalanced problem (dummy)', source: 'Taha, §5.1', description: 'Supply exceeds demand: a labelled dummy destination absorbs the surplus.', tags: ['balancing'], spec: { rows: ['Plant 1', 'Plant 2', 'Plant 3'], cols: ['City A', 'City B', 'City C'], costs: mat([[8, 6, 10], [9, 12, 13], [14, 9, 16]]), supply: ['120', '80', '80'], demand: ['150', '70', '60'], objective: 'min' } satisfies TransportSpec, expected: 'See solution', check: '' },
  { id: 'tr-block', module: 'transport', variant: 'vam', title: 'Prohibited route (symbolic M)', source: 'Spec §10.2', description: 'Route S2→D1 is blocked; it carries the symbolic cost M instead of a numeric big number.', tags: ['edge case'], spec: { rows: ['S1', 'S2'], cols: ['D1', 'D2'], costs: [['1', '2'], ['M', '1']], supply: ['10', '10'], demand: ['10', '10'], objective: 'min' } satisfies TransportSpec, expected: 'Cost 20', check: '20' },
  { id: 'tr-max', module: 'transport', variant: 'vam', title: 'Maximisation (profits)', source: 'Spec §10.2', description: 'Entries are profits; they are converted to opportunity costs and shown.', tags: ['maximisation'], spec: { rows: ['A', 'B', 'C'], cols: ['X', 'Y', 'Z'], costs: mat([[16, 14, 12], [10, 15, 13], [9, 8, 14]]), supply: ['20', '30', '25'], demand: ['25', '25', '25'], objective: 'max' } satisfies TransportSpec, expected: 'See solution', check: '' },

  /* ---------------- Assignment ---------------- */
  { id: 'as-3x3', module: 'assign', title: 'Machine–job 3 × 3', source: 'Classic', description: 'Reduce rows and columns, cover zeros, pick independent zeros.', tags: ['hungarian'], spec: { rows: ['Worker 1', 'Worker 2', 'Worker 3'], cols: ['Job 1', 'Job 2', 'Job 3'], costs: mat([[9, 2, 7], [6, 4, 3], [5, 8, 1]]), objective: 'min' } satisfies AssignSpec, expected: 'Total cost 9', check: '9' },
  { id: 'as-4x4', module: 'assign', title: 'Four jobs — needs an adjustment step', source: 'Taha, Example 5.4-1 style', description: 'The first line cover uses fewer than n lines, so the matrix is adjusted.', tags: ['hungarian', 'adjustment'], spec: { rows: ['1', '2', '3', '4'], cols: ['J1', 'J2', 'J3', 'J4'], costs: mat([[1, 4, 6, 3], [9, 7, 10, 9], [4, 5, 11, 7], [8, 7, 8, 5]]), objective: 'min' } satisfies AssignSpec, expected: 'Total cost 21', check: '21' },
  { id: 'as-rect', module: 'assign', title: 'More jobs than workers (dummy)', source: 'Spec §10.2', description: 'A non-square matrix is padded with a zero-cost dummy row.', tags: ['edge case'], spec: { rows: ['W1', 'W2'], cols: ['J1', 'J2', 'J3'], costs: mat([[7, 5, 9], [6, 8, 4]]), objective: 'min' } satisfies AssignSpec, expected: 'Total cost 9', check: '9' },
  { id: 'as-max', module: 'assign', title: 'Maximise profit', source: 'Spec §10.2', description: 'Profits are converted by subtracting from the matrix maximum.', tags: ['maximisation'], spec: { rows: ['A', 'B', 'C'], cols: ['P', 'Q', 'R'], costs: mat([[16, 10, 14], [11, 12, 13], [15, 13, 12]]), objective: 'max' } satisfies AssignSpec, expected: 'See solution', check: '' },

  /* ---------------- Network ---------------- */
  { id: 'net-short', module: 'network', variant: 'dijkstra', title: 'Shortest route', source: 'Taha, Example 6.3-1 style', description: 'Directed network, node 1 to node 5.', tags: ['dijkstra'], spec: graph([['1', 60, 190], ['2', 220, 80], ['3', 220, 300], ['4', 400, 190], ['5', 540, 190]], [['1', '2', 3, 3, false], ['1', '3', 9, 9, false], ['2', '3', 4, 4, false], ['2', '4', 2, 2, false], ['3', '4', 3, 3, false], ['3', '5', 8, 8, false], ['4', '5', 5, 5, false], ['2', '5', 9, 9, false]], '1', '5'), expected: '1 → 2 → 4 → 5, length 10', check: '10' },
  { id: 'net-mst', module: 'network', variant: 'kruskal', title: 'Minimum spanning tree', source: 'Taha, Example 6.2-1 style', description: 'Connect all nodes at least cost; compare Kruskal with Prim.', tags: ['kruskal', 'prim'], spec: graph([['1', 70, 120], ['2', 230, 50], ['3', 230, 250], ['4', 400, 80], ['5', 400, 280], ['6', 540, 180]], [['1', '2', 3, 3, false], ['1', '3', 5, 5, false], ['2', '3', 4, 4, false], ['2', '4', 6, 6, false], ['3', '5', 7, 7, false], ['4', '5', 2, 2, false], ['4', '6', 8, 8, false], ['5', '6', 3, 3, false]], '1', '6'), expected: 'Weight 18', check: '18' },
  { id: 'net-flow', module: 'network', variant: 'maxflow', title: 'Maximum flow', source: 'Taha, Example 6.4-1 style', description: 'Augmenting paths in the residual graph; the min cut equals the flow.', tags: ['max flow'], spec: graph([['S', 50, 190], ['A', 230, 70], ['B', 230, 310], ['C', 400, 70], ['D', 400, 310], ['T', 560, 190]], [['S', 'A', 10, 10], ['S', 'B', 8, 8], ['A', 'B', 2, 2], ['A', 'C', 5, 5], ['A', 'D', 8, 8], ['B', 'D', 7, 7], ['C', 'T', 7, 7], ['D', 'T', 10, 10], ['C', 'D', 3, 3]], 'S', 'T'), expected: 'Max flow 15', check: '15' },
  { id: 'net-neg', module: 'network', variant: 'bellman', title: 'Negative weights (Bellman–Ford)', source: 'Spec §10.3', description: 'Dijkstra refuses negative edges; Bellman–Ford handles them.', tags: ['edge case'], spec: graph([['A', 70, 190], ['B', 260, 80], ['C', 260, 300], ['D', 470, 190]], [['A', 'B', 4], ['A', 'C', 5], ['B', 'D', 3], ['C', 'B', -2], ['C', 'D', 6]], 'A', 'D'), expected: 'A → C → B → D = 6', check: '6' },

  /* ---------------- Project planning ---------------- */
  { id: 'pr-cpm', module: 'project', variant: 'cpm', title: 'Six-activity CPM network', source: 'Classic', description: 'Forward/backward pass, floats and critical path.', tags: ['cpm'], spec: { activities: [act('A', '', 3), act('B', '', 5), act('C', 'A', 2), act('D', 'B', 4), act('E', 'C, D', 3), act('F', 'E', 2)], deadline: '', target: '' } satisfies ProjectSpec, expected: 'Duration 14; critical B–D–E–F; A and C have float 4', check: '14' },
  { id: 'pr-pert', module: 'project', variant: 'pert', title: 'PERT with three-point estimates', source: 'Taha, Example 6.5-3 style', description: 'Expected durations, variances and the probability of finishing by a target date.', tags: ['pert'], spec: { activities: [act('A', '', '', { a: '2', m: '4', b: '6' }), act('B', '', '', { a: '3', m: '5', b: '9' }), act('C', 'A', '', { a: '4', m: '5', b: '12' }), act('D', 'A, B', '', { a: '1', m: '2', b: '3' }), act('E', 'C, D', '', { a: '3', m: '4', b: '5' })], deadline: '', target: '16' } satisfies ProjectSpec, expected: 'See solution', check: '' },
  { id: 'pr-crash', module: 'project', variant: 'crash', title: 'Time–cost crashing', source: 'Taha, §6.5.1 style', description: 'Shorten the project at least extra cost; the cost-versus-time curve is computed exactly by LP.', tags: ['crashing'], spec: { activities: [act('A', '', 4, { normalCost: '100', crashDuration: '2', crashCost: '160' }), act('B', 'A', 3, { normalCost: '80', crashDuration: '2', crashCost: '110' }), act('C', '', 6, { normalCost: '120', crashDuration: '5', crashCost: '150' }), act('D', 'B, C', 2, { normalCost: '60', crashDuration: '1', crashCost: '100' })], deadline: '', target: '' } satisfies ProjectSpec, expected: 'See solution', check: '' },

  /* ---------------- Queuing ---------------- */
  { id: 'q-mm1', module: 'queuing', title: 'M/M/1 — single clerk', source: 'Taha, §18.6', description: 'λ = 2, μ = 3 per hour: slide λ towards μ to watch the queue explode.', tags: ['mm1'], spec: queue({ model: 'mm1', lambda: '2', mu: '3' }), expected: 'Ls = 2, Lq = 4/3, Ws = 1', check: '2' },
  { id: 'q-mmc', module: 'queuing', title: 'M/M/c — call centre', source: 'Taha, §18.6.2', description: 'Three servers; the Erlang-C probability of waiting is reported.', tags: ['mmc'], spec: queue({ model: 'mmc', lambda: '10', mu: '4', servers: '3' }), expected: 'See solution', check: '' },
  { id: 'q-cost', module: 'queuing', title: 'Optimal number of servers', source: 'Taha, §18.8', description: 'Server cost 20/h, waiting cost 30 per customer-hour.', tags: ['cost model'], spec: queue({ model: 'mmc', lambda: '10', mu: '3', servers: '4', Cs: '20', Cw: '30' }), expected: 'See cost curve', check: '' },
  { id: 'q-finite', module: 'queuing', title: 'M/M/1/N — limited waiting room', source: 'Taha, §18.6.4', description: 'Capacity 5: arrivals finding it full are lost, so the system is always stable.', tags: ['finite'], spec: queue({ model: 'mm1n', lambda: '4', mu: '3', capacity: '5' }), expected: 'See solution', check: '' },
  { id: 'q-machine', module: 'queuing', title: 'Machine servicing (M/M/c/K/K)', source: 'Taha, §18.6.5', description: '5 machines, one repairman.', tags: ['machine'], spec: queue({ model: 'mmcnn', lambda: '0.1', mu: '1', servers: '1', capacity: '5' }), expected: 'See solution', check: '' },
  { id: 'q-mg1', module: 'queuing', title: 'M/G/1 — Pollaczek–Khinchine', source: 'Taha, §18.7', description: 'General service times with σ = 0.2; compare with σ = 0 (M/D/1).', tags: ['mg1'], spec: queue({ model: 'mg1', lambda: '2', mu: '3', sigma: '0.2' }), expected: 'See solution', check: '' },

  /* ---------------- Inventory ---------------- */
  { id: 'inv-eoq', module: 'inventory', title: 'Basic EOQ with reorder point', source: 'Taha, Example 13.3-1', description: 'Ordering and holding cost curves cross at the optimum.', tags: ['eoq'], spec: inv({ model: 'eoq', D: '1000', K: '100', h: '2', c: '10', L: '0.1' }), expected: 'Q* = 316.2', check: '' },
  { id: 'inv-short', module: 'inventory', title: 'EOQ with planned shortages', source: 'Taha, §13.3.3', description: 'Backorders allowed at penalty p.', tags: ['shortage'], spec: inv({ model: 'shortage', D: '1000', K: '100', h: '2', p: '6' }), expected: 'See solution', check: '' },
  { id: 'inv-disc', module: 'inventory', title: 'All-units quantity discount', source: 'Taha, §13.3.5', description: 'Three price breaks; the best feasible tier wins.', tags: ['discount'], spec: inv({ model: 'discount', D: '10000', K: '100', h: '0.2', hRate: true, breaks: [{ minQty: '0', price: '10' }, { minQty: '500', price: '9.5' }, { minQty: '2000', price: '9' }], discountType: 'allUnits' }), expected: 'See solution', check: '' },
  { id: 'inv-news', module: 'inventory', title: 'Newsvendor', source: 'Taha, §13.4', description: 'Normal demand N(100, 20²); critical ratio sets the stocking level.', tags: ['newsvendor'], spec: inv({ model: 'newsvendor', price: '10', c: '6', salvage: '2', dist: 'normal', mean: '100', sd: '20' }), expected: 'Q* = 100 (critical ratio 0.5)', check: '100' },

  /* ---------------- Games ---------------- */
  { id: 'g-saddle', module: 'games', title: 'Game with a saddle point', source: 'Taha, Example 14.4-1', description: 'Maximin equals minimax: a pure-strategy equilibrium.', tags: ['saddle'], spec: { rows: ['A1', 'A2', 'A3'], cols: ['B1', 'B2', 'B3'], payoff: mat([[3, 5, 4], [2, 1, 0], [1, 6, 3]]) } satisfies GameSpec, expected: 'Value 3 at (A1, B1)', check: '3' },
  { id: 'g-pennies', module: 'games', title: 'Matching pennies', source: 'Classic', description: 'No saddle point: both mix ½–½; the game is fair.', tags: ['mixed'], spec: { rows: ['Heads', 'Tails'], cols: ['Heads', 'Tails'], payoff: mat([[1, -1], [-1, 1]]) } satisfies GameSpec, expected: 'Value 0', check: '0' },
  { id: 'g-dom', module: 'games', title: 'Dominance reduction', source: 'Taha, Example 14.4-2', description: 'Dominated rows/columns are struck out until a 2 × 2 game remains.', tags: ['dominance'], spec: { rows: ['A1', 'A2', 'A3', 'A4'], cols: ['B1', 'B2', 'B3', 'B4'], payoff: mat([[3, 2, 4, 0], [3, 4, 2, 4], [4, 2, 4, 0], [0, 4, 0, 8]]) } satisfies GameSpec, expected: 'Value 8/3', check: '8/3' },
  { id: 'g-2xn', module: 'games', title: 'Graphical 2 × n game', source: 'Taha, §14.5', description: 'Plot the expected payoff lines; maximise their lower envelope.', tags: ['graphical'], spec: { rows: ['A1', 'A2'], cols: ['B1', 'B2', 'B3', 'B4'], payoff: mat([[2, 2, 3, -1], [4, 3, 2, 6]]) } satisfies GameSpec, expected: 'Value 8/3', check: '' },
  { id: 'g-rps', module: 'games', title: 'Rock–paper–scissors (3 × 3 LP)', source: 'Classic', description: 'Solved by linear programming; strategies ⅓–⅓–⅓.', tags: ['lp'], spec: { rows: ['Rock', 'Paper', 'Scissors'], cols: ['Rock', 'Paper', 'Scissors'], payoff: mat([[0, -1, 1], [1, 0, -1], [-1, 1, 0]]) } satisfies GameSpec, expected: 'Value 0', check: '0' },

  /* ---------------- Markov ---------------- */
  { id: 'mk-weather', module: 'markov', title: 'Weather chain', source: 'Taha, Example 19.1', description: 'Sunny/rainy: n-step probabilities converge to the steady state 4/7, 3/7.', tags: ['steady state'], spec: { names: ['Sunny', 'Rainy'], P: [['0.7', '0.3'], ['0.4', '0.6']], init: ['1', '0'], n: '10' } satisfies MarkovSpec, expected: 'π = (4/7, 3/7)', check: '4/7' },
  { id: 'mk-abs', module: 'markov', title: 'Gambler\'s ruin (absorbing)', source: 'Classic', description: 'Fundamental matrix, expected steps and absorption probabilities.', tags: ['absorbing'], spec: { names: ['Broke', '$1', '$2', 'Win'], P: [['1', '0', '0', '0'], ['0.5', '0', '0.5', '0'], ['0', '0.5', '0', '0.5'], ['0', '0', '0', '1']], init: ['0', '1', '0', '0'], n: '8' } satisfies MarkovSpec, expected: 'Expected steps 2, 2', check: '' },
  { id: 'mk-period', module: 'markov', title: 'Periodic chain', source: 'Spec §10.6', description: 'Flip-flop of period 2: Pⁿ never converges, yet π = (½, ½) exists.', tags: ['edge case'], spec: { names: ['A', 'B'], P: [['0', '1'], ['1', '0']], init: ['1', '0'], n: '7' } satisfies MarkovSpec, expected: 'Periodic', check: '' },

  /* ---------------- Simulation ---------------- */
  { id: 'sim-pi', module: 'simulation', title: 'Estimate π by Monte Carlo', source: 'Classic', description: 'Fraction of random points inside the quarter circle; watch the estimate converge.', tags: ['monte carlo'], spec: sim({}), expected: 'π ≈ 3.14', check: '' },
  { id: 'sim-queue', module: 'simulation', title: 'M/M/1 queue simulation', source: 'Taha, §18.9', description: 'λ = 2, μ = 3: simulated waiting time approaches the theoretical 2/3.', tags: ['queue sim'], spec: sim({ kind: 'queue', customers: '5000', warmup: '200' }), expected: 'Wq ≈ 0.667', check: '' },
  { id: 'sim-dice', module: 'simulation', title: 'Sum of two dice', source: 'Classic', description: 'Discrete distribution sampling and a histogram.', tags: ['discrete'], spec: sim({ vars: [{ name: 'd1', dist: { type: 'discrete', p1: '', p2: '', p3: '', values: '1:1/6, 2:1/6, 3:1/6, 4:1/6, 5:1/6, 6:1/6' } }, { name: 'd2', dist: { type: 'discrete', p1: '', p2: '', p3: '', values: '1:1/6, 2:1/6, 3:1/6, 4:1/6, 5:1/6, 6:1/6' } }], expression: 'd1 + d2', trials: '10000', threshold: '10' }), expected: 'Mean 7', check: '' },

  /* ---------------- Nonlinear ---------------- */
  { id: 'nlp-bowl', module: 'nlp', title: 'Unconstrained quadratic', source: 'Classic', description: 'Newton converges in one step; gradient descent zig-zags.', tags: ['gradient', 'newton'], spec: { tab: 'unconstrained', expression: '(x1 - 3)^2 + 2*(x2 + 1)^2 + x1*x2', start: '0, 0', method: 'newton', constraints: [{ expr: 'x1 + x2 - 2', kind: 'le' }], point: '1, 1', Q: [['2', '0'], ['0', '2']], c: ['-4', '-4'], A: [['1', '1']], b: ['2'] } satisfies NLPSpec, expected: 'Minimum', check: '' },
  { id: 'nlp-kkt', module: 'nlp', title: 'KKT verification', source: 'Taha, §21.2', description: 'Is (1, 1) a KKT point of min (x₁−2)² + (x₂−2)² s.t. x₁ + x₂ ≤ 2?', tags: ['kkt'], spec: { tab: 'kkt', expression: '(x1 - 2)^2 + (x2 - 2)^2', start: '0, 0', method: 'newton', constraints: [{ expr: 'x1 + x2 - 2', kind: 'le' }], point: '1, 1', Q: [['2', '0'], ['0', '2']], c: ['-4', '-4'], A: [['1', '1']], b: ['2'] } satisfies NLPSpec, expected: 'KKT satisfied', check: '' },
  { id: 'nlp-qp', module: 'nlp', title: 'Quadratic programme (exact)', source: 'Taha, §21.2.2', description: 'Active-set / KKT enumeration in exact arithmetic.', tags: ['qp'], spec: { tab: 'qp', expression: '', start: '0, 0', method: 'newton', constraints: [], point: '1, 1', Q: [['2', '0'], ['0', '2']], c: ['-4', '-4'], A: [['1', '1']], b: ['2'] } satisfies NLPSpec, expected: 'x = (1, 1), objective −6', check: '-6' },
];

export const MODULE_TITLES: Record<ModuleId, string> = {
  lp: 'Linear programming', integer: 'Integer programming', transport: 'Transportation', assign: 'Assignment', network: 'Network models', project: 'Project planning',
  queuing: 'Queuing analysis', inventory: 'Inventory', games: 'Zero-sum games', markov: 'Markov chains', simulation: 'Simulation', nlp: 'Nonlinear programming',
};

export function libraryFor(module: ModuleId): LibraryEntry[] {
  return LIBRARY.filter(e => e.module === module);
}
