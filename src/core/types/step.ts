/**
 * Step contract for OR-Studio solvers.
 * Section 6.1 of Master Spec.
 */

export type StepStatus =
  | 'initial'
  | 'continue'
  | 'optimal'
  | 'infeasible'
  | 'unbounded'
  | 'cycling-detected'
  | 'iteration-limit'
  | 'numerical-limit';

export interface Action {
  /** e.g. 'pivot' | 'allocate' | 'relax' | 'branch' | 'prune' | 'augment' | 'cover' | 'eliminate' */
  kind: string;
  /** Action-specific payload. */
  payload: unknown;
}

export interface Explanation {
  /** One line, shown inline. e.g. "x₂ enters, s₁ leaves." */
  short: string;
  /** Full paragraph of reasoning, shown on expand and in exports. */
  detailed: string;
  /** Optional KaTeX expression supporting the reasoning. */
  formula?: string;
  /** Name of the decision rule applied, e.g. "Most negative reduced cost". */
  rule: string;
  /** Optional pedagogical note, e.g. a warning about degeneracy. */
  note?: string;
}

export interface Highlight {
  /** Addressing scheme is module-specific but MUST be stable and parseable.
   *  Examples: "cell:2,3" · "row:1" · "col:4" · "node:B" · "edge:A-C" · "treenode:7" */
  target: string;
  intent:
    | 'pivot'
    | 'entering'
    | 'leaving'
    | 'candidate'
    | 'blocked'
    | 'optimal'
    | 'changed'
    | 'loop'
    | 'critical';
}

export interface Step<TState> {
  /** Zero-based iteration index. */
  index: number;

  /** Algorithm phase label, e.g. "Phase I", "Branch depth 2", "VAM initialization". */
  phase?: string;

  /** Complete algorithm state after this step. Module-specific. */
  state: TState;

  /** The action that produced this state. Null for the initial step. */
  action: Action | null;

  /** Generated human-readable justification. */
  explanation: Explanation;

  /** Elements to emphasize in the visualizer. */
  highlights: Highlight[];

  /** Whether the algorithm continues, and if not, why it stopped. */
  status: StepStatus;
}
