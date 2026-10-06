/**
 * Canonical Data Models for OR-Studio solvers.
 * Section 8 of Master Spec.
 */

import { Rational } from '../math/rational';
import { MNum } from '../math/bigm';

export type Relation = '<=' | '>=' | '=';
export type VarType = 'continuous' | 'integer' | 'binary';

export interface Bound {
  lower: Rational | null;               // null = -∞
  upper: Rational | null;               // null = +∞
}

export interface Constraint {
  coeffs: Rational[];
  relation: Relation;
  rhs: Rational;
  name?: string;                        // e.g. 'Labour hours'
}

export interface LPModel {
  sense: 'max' | 'min';
  objective: Rational[];                // length = number of variables
  objectiveConstant?: Rational;         // for models with a constant term
  constraints: Constraint[];
  varNames: string[];                   // display names, e.g. ['x₁', 'x₂']
  varBounds?: Bound[];                  // default { lower: 0, upper: null }
  integrality?: VarType[];              // default 'continuous'
  description?: string;
}

export interface Tableau {
  /** Full coefficient matrix including slack, surplus, and artificial columns. */
  matrix: Rational[][];
  /** Objective row (reduced costs / z-row). */
  objectiveRow: Rational[];
  /** Right-hand-side column. */
  rhs: Rational[];
  /** Objective function value at this basis. */
  objectiveValue: Rational;
  /** Column index of each basic variable, ordered by row. */
  basis: number[];
  /** Names of all columns in order. */
  columnNames: string[];
  /** Classification of each column. */
  columnTypes: ('decision' | 'slack' | 'surplus' | 'artificial')[];
  /** Which phase this tableau belongs to. */
  phase: 1 | 2 | null;
  /** Big-M coefficient row (coefficient of M in each reduced cost), when the Big-M method is in use. */
  bigMRow?: Rational[];
  /** Coefficient of M in the objective value, when the Big-M method is in use. */
  objectiveValueM?: Rational;
  /** 'max' or 'min' sense of the ORIGINAL problem (the z-row is always held in maximisation form). */
  objectiveSense?: 'max' | 'min';
  /** Label for the z-row, e.g. "z" or "Phase I: w". */
  objectiveLabel?: string;
  /** The pivot that the algorithm will make NEXT from this tableau (absent at the final state). */
  nextPivot?: NextPivot;
  /** Which algorithm produced this tableau. */
  method?: 'standard' | 'twoPhase' | 'bigM' | 'dual' | 'gomory';
}

export interface NextPivot {
  enteringCol: number;
  leavingRow: number;
  /** Ratio test outcome per row; null where the row is not eligible (non-positive pivot-column entry). */
  ratios: (Rational | null)[];
  /** Rule that chose the entering variable / row. */
  rule: string;
  /** Rows tied for the minimum ratio (length > 1 ⇒ degenerate tie). */
  tiedRows: number[];
  /** Dual simplex only: ratio |z_j / a_rj| per display column (null where not eligible). */
  colRatios?: (Rational | null)[];
}

export interface TransportModel {
  supply: Rational[];
  demand: Rational[];
  costs: Rational[][];                  // supply.length × demand.length
  supplyNames?: string[];
  demandNames?: string[];
  balanced?: boolean;
  dummyAdded?: 'row' | 'column' | null;
  /** 'max' ⇒ the matrix holds profits; converted to costs by subtracting every entry from the maximum. */
  objective?: 'min' | 'max';
  /** Prohibited routes: cost is the symbolic M, never a numeric large value. */
  blocked?: boolean[][];
}

export interface TransportState {
  allocations: (Rational | null)[][];   // null = non-basic cell; a basic cell may hold 0 (degenerate / ε)
  /** Effective unit costs (after maximisation conversion, balancing, prohibited routes as M). */
  costs?: MNum[][];
  rowLabels?: string[];
  colLabels?: string[];
  u?: (MNum | null)[];
  v?: (MNum | null)[];
  improvementIndices?: (MNum | null)[][];
  loop?: { row: number; col: number; sign: '+' | '-' }[];
  totalCost: MNum;
  isDegenerate: boolean;
  epsilonCells?: { row: number; col: number }[];
  supplyLeft?: Rational[];
  demandLeft?: Rational[];
  crossedRows?: boolean[];
  crossedCols?: boolean[];
  rowPenalty?: (MNum | null)[];
  colPenalty?: (MNum | null)[];
  enteringCell?: { row: number; col: number };
  leavingCell?: { row: number; col: number };
  theta?: Rational;
  /** Per non-basic cell: loop and the cost change of shifting one unit (stepping-stone evaluation). */
  stoneEvals?: { row: number; col: number; loop: { row: number; col: number; sign: '+' | '-' }[]; change: MNum }[];
  dummyRow?: number | null;
  dummyCol?: number | null;
  /** Alternate optimum cells (improvement index exactly 0) when optimal. */
  alternateCells?: { row: number; col: number }[];
}

export interface GraphModel {
  nodes: { id: string; label: string; x?: number; y?: number }[];
  edges: {
    id: string;
    from: string;
    to: string;
    weight: Rational;
    capacity?: Rational;
    directed: boolean;
  }[];
  source?: string;
  sink?: string;
  /** Several sources / sinks (max flow): a super-source / super-sink with infinite capacity is added. */
  sources?: string[];
  sinks?: string[];
}

export interface GraphState {
  nodeLabels: Record<string, { value: Rational | null; permanent: boolean; pred?: string | null }>;
  selectedEdges: string[];
  flows?: Record<string, Rational>;
  /** residual capacity per arc id (null = unlimited) */
  residual?: Record<string, Rational | null>;
  currentPath?: string[];
  visitedNodes: string[];
  rejectedEdges?: string[];
  considering?: string | null;
  totalWeight?: Rational;
  flowValue?: Rational;
  sourceSide?: string[];
  cutEdges?: string[];
  /** Floyd–Warshall / all-pairs */
  distMatrix?: (Rational | null)[][];
  nextMatrix?: (number | null)[][];
  nodeOrder?: string[];
  pivotNode?: string;
  /** Extra nodes/edges added for the algorithm (super source/sink) */
  augmentedNodes?: string[];
}

export interface BBNode {
  id: number;
  parentId: number | null;
  depth: number;
  addedConstraints: Constraint[];
  relaxation: { values: Rational[]; objective: Rational } | null;
  status: 'pending' | 'solved' | 'pruned-bound' | 'pruned-infeasible' | 'integer-feasible';
  branchVariable?: number;
  branchValue?: Rational;
  pruneReason?: string;
  children: number[];
  /** Human-readable branching decision that created this node, e.g. "x₁ ≤ 3". */
  branchLabel?: string;
  /** Order in which this node was processed (undefined while still open). */
  processedOrder?: number;
  /** True if this node produced the incumbent that is final. */
  isIncumbent?: boolean;
}

export interface BBState {
  nodes: BBNode[];
  activeNodeId: number | null;
  incumbent: { values: Rational[]; objective: Rational } | null;
  bestBound: Rational | null;
  exploredCount: number;
  prunedCount: number;
  /** Incumbent objective after each improvement: used for the incumbent-evolution chart. */
  incumbentHistory?: { nodeId: number; order: number; objective: Rational }[];
  /** Ids of open (unprocessed) nodes. */
  open?: number[];
}

export interface ProjectActivity {
  id: string;
  name: string;
  predecessors: string[];
  duration?: number;
  optimistic?: number;
  mostLikely?: number;
  pessimistic?: number;
  normalCost?: number;
  crashDuration?: number;
  crashCost?: number;
}

export interface ProjectModel {
  activities: ProjectActivity[];
  /** Imposed completion deadline (for negative-float analysis and PERT probabilities). */
  deadline?: number;
}

export interface ProjectState {
  schedule: Record<string, {
    earlyStart: number; earlyFinish: number;
    lateStart: number;  lateFinish: number;
    totalFloat: number; freeFloat: number;
    isCritical: boolean;
    expectedDuration?: number; variance?: number;
  }>;
  criticalPath: string[];
  projectDuration: number;
  projectVariance?: number;
  crashHistory?: { activity: string; reducedBy: number; addedCost: number; newDuration: number }[];
  /** forward / backward pass progress marker for step display */
  pass?: 'forward' | 'backward' | 'float' | 'done';
  /** Activities whose values were just computed in this step. */
  justComputed?: string[];
}

export interface SavedModel {
  version: '1.0';
  moduleId: string;
  variant?: string;
  model: unknown;
  meta: { title: string; createdAt: string; notes?: string };
}
