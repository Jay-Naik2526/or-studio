/**
 * LP Solver implementing the binding Solver contract (spec §6.2).
 */

import { Solver, Solution, SolveOptions, ValidationResult } from '../../types/solver';
import { LPModel, Tableau } from '../../types/models';
import { Step } from '../../types/step';
import { Candidate, Choice, TutorFeedback } from '../../types/tutor';
import { solveLP, validateLP, LPResult, LPMethod } from './engine';
import {
  currentStage,
  enteringCandidates,
  leavingCandidates,
  dualLeavingCandidates,
  dualEnteringCandidates,
  verifyEntering,
  verifyLeaving,
  verifyDualEntering,
  verifyDualLeaving,
} from './tutor';
import { DiffComparator } from '../../diff/comparator';
import { StateDiff } from '../../types/solver';

export class LPSolver implements Solver<LPModel, Tableau, LPResult> {
  readonly id = 'lp.simplex';

  readonly meta = {
    name: 'Linear Programming — Simplex family',
    category: 'linear-programming' as const,
    variants: [
      { id: 'auto', name: 'Auto-detect', description: 'Standard simplex when every constraint is ≤ with RHS ≥ 0, otherwise Two-Phase.' },
      { id: 'standard', name: 'Standard simplex', description: 'Slack basis, Dantzig rule, ratio test.' },
      { id: 'twoPhase', name: 'Two-Phase', description: 'Phase I minimises the artificial sum, Phase II optimises the objective.' },
      { id: 'bigM', name: 'Big-M', description: 'Artificial variables carry a symbolic −M penalty.' },
      { id: 'dual', name: 'Dual simplex', description: 'Starts optimal-but-infeasible and repairs feasibility.' },
    ],
    visualizerId: 'TableauView',
    sizeLimit: { rows: 200, cols: 200 },
    supportsTutorial: true,
    reference: 'Taha, Operations Research: An Introduction, Ch. 3–4',
  };

  validate(model: LPModel): ValidationResult {
    return validateLP(model);
  }

  normalize(model: LPModel): LPModel {
    return model;
  }

  solve(model: LPModel, options: SolveOptions = {}): Solution<Tableau, LPResult> {
    return solveLP(model, { ...options, method: (options.variant as LPMethod) ?? 'auto' });
  }

  candidates(step: Step<Tableau>): Candidate[] {
    const t = step.state;
    const stage = currentStage(t);
    if (stage === 'entering') return enteringCandidates(t);
    if (stage === 'dual-leaving') return dualLeavingCandidates(t);
    return [];
  }

  verify(step: Step<Tableau>, choice: Choice): TutorFeedback {
    const t = step.state;
    const [kind, idx] = choice.candidateId.split(':');
    const n = Number(idx);
    if (kind === 'enter') {
      const row = choice.parts?.row !== undefined ? Number(choice.parts.row) : undefined;
      if (t.method === 'dual' && row !== undefined) return verifyDualEntering(t, row, n);
      return verifyEntering(t, n);
    }
    if (kind === 'leave') {
      if (t.method === 'dual') return verifyDualLeaving(t, n);
      const col = Number(choice.parts?.col ?? t.nextPivot?.enteringCol ?? 0);
      return verifyLeaving(t, col, n);
    }
    return { correct: false, message: 'Unknown choice.' };
  }

  compare(userState: Tableau, correctState: Tableau): StateDiff {
    const step: Step<Tableau> = { index: 0, state: correctState, action: null, explanation: { short: '', detailed: '', rule: '' }, highlights: [], status: 'continue' };
    return DiffComparator.compareTableau(userState, [step], { iteration: 0 });
  }
}

export { dualEnteringCandidates, leavingCandidates };
