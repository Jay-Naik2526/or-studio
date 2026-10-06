import { lazy, ComponentType, LazyExoticComponent } from 'react';
import { TrendingUp, Grid3x3, Link2, Share2, Layers, CalendarClock, Hourglass, Boxes, Swords, Dices, Shuffle, Sigma, LucideIcon } from 'lucide-react';
import { ModuleId } from '../../data/specs';

export interface ModuleInfo {
  id: ModuleId;
  name: string;
  short: string;
  description: string;
  methods: string[];
  icon: LucideIcon;
  accent: string;
  component: LazyExoticComponent<ComponentType>;
  /** deficiency of TORA this module addresses */
  beyondTora: string;
}

export const MODULES: ModuleInfo[] = [
  { id: 'lp', name: 'Linear programming', short: 'LP', description: 'Simplex, Two-Phase, Big-M and dual simplex with every tableau, ratio test and pivot explained; graphical solution with draggable constraints; exact sensitivity analysis.', methods: ['Simplex', 'Two-Phase', 'Big-M', 'Dual simplex', 'Graphical', 'Sensitivity'], icon: TrendingUp, accent: '#4f46e5', component: lazy(() => import('../modules/LPModule')), beyondTora: 'Animated pivots, all ratios shown, shadow-price what-if sliders.' },
  { id: 'integer', name: 'Integer programming', short: 'IP', description: 'Branch & bound with a zoomable tree, three node-selection strategies and an incumbent chart; Gomory fractional and mixed-integer cuts drawn in the plane.', methods: ['Branch & bound', 'Gomory cuts', 'Binary / mixed'], icon: Layers, accent: '#7c3aed', component: lazy(() => import('../modules/IntegerModule')), beyondTora: 'The tree TORA shows as a flat list is drawn, pannable and prunable.' },
  { id: 'transport', name: 'Transportation', short: 'TP', description: 'North-west corner, least-cost and Vogel starts, MODI u–v optimality with the closed loop drawn on the grid, stepping-stone evaluation and Method Comparison.', methods: ['NWC', 'Least-cost', 'VAM', 'MODI', 'Stepping-stone'], icon: Grid3x3, accent: '#059669', component: lazy(() => import('../modules/TransportModule')), beyondTora: 'Side-by-side method comparison; prohibited routes handled with symbolic M.' },
  { id: 'assign', name: 'Assignment', short: 'AP', description: 'Hungarian method with row/column reduction, exact minimum line cover animation, adjustments, rectangular and maximisation problems.', methods: ['Hungarian', 'Maximise', 'Rectangular'], icon: Link2, accent: '#d97706', component: lazy(() => import('../modules/AssignModule')), beyondTora: 'Line-covering shown at every stage, with proofs of optimality.' },
  { id: 'network', name: 'Network models', short: 'NET', description: 'Click-to-draw graph editor with Dijkstra, Bellman–Ford, Floyd–Warshall, Kruskal, Prim and max-flow (residual graph and min cut).', methods: ['Dijkstra', 'Bellman–Ford', 'Floyd–Warshall', 'Kruskal', 'Prim', 'Max flow'], icon: Share2, accent: '#0891b2', component: lazy(() => import('../modules/NetworkModule')), beyondTora: 'Draw the graph instead of typing adjacency tables.' },
  { id: 'project', name: 'Project planning', short: 'PM', description: 'CPM and PERT with forward/backward passes, floats, all critical paths, Gantt chart, AON diagram, probability of on-time completion and exact time–cost crashing.', methods: ['CPM', 'PERT', 'Crashing', 'Gantt'], icon: CalendarClock, accent: '#e11d48', component: lazy(() => import('../modules/ProjectModule')), beyondTora: 'Gantt, AON diagram and an exact cost-vs-time curve.' },
  { id: 'queuing', name: 'Queuing analysis', short: 'Q', description: 'M/M/1, M/M/c, M/M/1/N, M/M/c/N, machine servicing and M/G/1 with live λ/μ/c sliders, charts and an optimal-server cost model.', methods: ['M/M/1', 'M/M/c', 'Finite', 'Machine', 'M/G/1', 'Cost'], icon: Hourglass, accent: '#2563eb', component: lazy(() => import('../modules/QueuingModule')), beyondTora: 'Interactive sliders and plain-language interpretation.' },
  { id: 'inventory', name: 'Inventory', short: 'INV', description: 'EOQ with reorder point, production lots, planned shortages, all-units and incremental discounts, and the newsvendor — with cost curves.', methods: ['EOQ', 'EPQ', 'Shortages', 'Discounts', 'Newsvendor'], icon: Boxes, accent: '#65a30d', component: lazy(() => import('../modules/InventoryModule')), beyondTora: 'Total-cost curve with components and the optimum annotated.' },
  { id: 'games', name: 'Zero-sum games', short: 'GT', description: 'Saddle points, step-by-step dominance, graphical 2×n / m×2 solution and the exact LP method, with a payoff heatmap.', methods: ['Saddle point', 'Dominance', 'Graphical', 'LP'], icon: Swords, accent: '#0d9488', component: lazy(() => import('../modules/GamesModule')), beyondTora: 'Payoff heatmap and verified optimal strategies for both players.' },
  { id: 'markov', name: 'Markov chains', short: 'MC', description: 'n-step transitions, exact steady state, communicating classes, periodicity, absorbing analysis and first-passage times, with a state diagram and heatmap.', methods: ['n-step', 'Steady state', 'Absorbing', 'First passage'], icon: Shuffle, accent: '#c026d3', component: lazy(() => import('../modules/MarkovModule')), beyondTora: 'Animated convergence and chain classification.' },
  { id: 'simulation', name: 'Simulation', short: 'SIM', description: 'Seedable LCG/Mersenne Twister, Monte Carlo estimation with confidence intervals and convergence plot, and a multi-server discrete-event queue simulation with event trace.', methods: ['Monte Carlo', 'Queue sim', 'Distributions'], icon: Dices, accent: '#ea580c', component: lazy(() => import('../modules/SimulationModule')), beyondTora: 'Histograms, convergence plots and reproducible seeds.' },
  { id: 'nlp', name: 'Nonlinear programming', short: 'NLP', description: 'Gradient and Newton iterations with symbolic derivatives and contour plots, KKT verification, and exact quadratic programming.', methods: ['Gradient', 'Newton', 'KKT', 'QP'], icon: Sigma, accent: '#475569', component: lazy(() => import('../modules/NLPModule')), beyondTora: 'Contour plot with the iterate path.' },
];

export const moduleById = (id: string) => MODULES.find(m => m.id === id);
