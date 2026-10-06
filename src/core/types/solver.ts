/**
 * Solver contract for OR-Studio solvers.
 * Section 6.2 of Master Spec.
 */

import { Step } from './step';
import { Candidate, Choice, TutorFeedback } from './tutor';

export type ModuleCategory =
  | 'linear-programming'
  | 'transportation'
  | 'integer-programming'
  | 'network'
  | 'project'
  | 'queuing'
  | 'inventory'
  | 'games'
  | 'markov'
  | 'simulation'
  | 'nonlinear';

export type TerminationStatus =
  | 'optimal'
  | 'optimal-alternate-exists'
  | 'infeasible'
  | 'unbounded'
  | 'unbounded-objective'
  | 'cycling'
  | 'iteration-limit'
  | 'numerical-failure'
  | 'invalid-input';

export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;          // e.g. 'DEGENERATE_BASIS'
  message: string;       // human-readable
  stepIndex?: number;    // where it occurred
  detail?: string;       // extended explanation
}

export interface SolveMetrics {
  iterations: number;
  elapsedMs: number;
  /** Peak numerator/denominator magnitude — early warning for rational overflow. */
  maxRationalMagnitude?: bigint;
  /** Whether the solver fell back to floating point. */
  degradedToFloat: boolean;
}

export interface SolverResult {
  status: TerminationStatus | 'optimal' | 'infeasible' | 'unbounded';
  optimalValue: import('../math/rational').Rational | number | null;
  solution: { values: import('../math/rational').Rational[]; varNames: string[] } | null;
  finalTableau?: any;
  steps: any[];
}

export interface Solution<TState, TResult> {
  steps: Step<TState>[];
  /** Final answer in module-specific form. Null if no solution exists. */
  result: TResult | null;
  status: TerminationStatus;
  /** Non-fatal observations worth surfacing. */
  diagnostics: Diagnostic[];
  /** Performance and shape metadata for the benchmark report. */
  metrics: SolveMetrics;
}

export interface SolveOptions {
  variant?: string;
  maxIterations?: number;          // default 1000
  antiCycling?: 'bland' | 'lexicographic' | 'auto';   // default 'auto'
  emitSteps?: boolean;             // false for benchmark runs
  useExactArithmetic?: boolean;    // default true where applicable
}

export interface ValidationResult {
  valid: boolean;
  errors: { field?: string; message: string }[];
}

export interface Variant {
  id: string;
  name: string;
  description: string;
}

export interface SolverMeta {
  name: string;
  category: ModuleCategory;
  /** Method variants selectable by the user, e.g. ['NWC', 'LCM', 'VAM']. */
  variants: Variant[];
  /** Which visualizer component renders this solver's state. */
  visualizerId: string;
  /** Practical problem-size ceiling before a warning is shown. */
  sizeLimit: { rows: number; cols: number };
  /** Whether tutorial mode is supported. */
  supportsTutorial: boolean;
  /** Textbook reference for the method as implemented. */
  reference: string;
}

export interface StateDiff {
  matches: boolean;
  differences: {
    target: string;
    expected: string;
    actual: string;
    likelyCause?: string;
  }[];
  divergenceStep?: number;
  summary: string;
}

export interface Solver<TModel, TState, TResult> {
  /** Stable unique identifier, e.g. 'lp.simplex.bigM'. */
  id: string;

  meta: SolverMeta;

  /** Structural and semantic validation. MUST NOT throw; returns errors. */
  validate(model: TModel): ValidationResult;

  /** Canonicalize: balance supply/demand, add slack/surplus/artificial, standardize sense. */
  normalize(model: TModel): TModel;

  /** Solve, emitting every intermediate state. MUST NOT throw on degenerate input. */
  solve(model: TModel, options?: SolveOptions): Solution<TState, TResult>;

  /** Tutorial mode: enumerate all legal next moves from a given state. */
  candidates?(step: Step<TState>): Candidate[];

  /** Tutorial mode: judge a user's chosen move and explain any error. */
  verify?(step: Step<TState>, choice: Choice): TutorFeedback;

  /** Diff Mode: compare a user-supplied state against the correct one. */
  compare?(userState: TState, correctState: TState): StateDiff;
}
