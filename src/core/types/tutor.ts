/**
 * Tutorial contract for OR-Studio solvers.
 * Section 6.3 of Master Spec.
 */

export interface Candidate {
  id: string;
  label: string;                  // "Enter x₂"
  target: string;                 // highlight address
  isCorrect: boolean;
  /** Why this is or is not the right move under the active rule. */
  rationale: string;
}

export interface Choice {
  candidateId: string;
  /** For multi-part decisions, e.g. pivot = (column, row). */
  parts?: Record<string, string>;
}

export interface TutorFeedback {
  correct: boolean;
  /** Specific, actionable. NOT "wrong, try again". */
  message: string;
  /** What the correct move was, revealed only after a configurable number of attempts. */
  reveal?: string;
  /** The rule the user appears to have misapplied. */
  misconception?: string;
}
