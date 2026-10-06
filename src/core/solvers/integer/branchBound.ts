/**
 * Branch & bound for pure / mixed / binary integer programmes (spec §8.5, §9.1 module 6, §10.5).
 *
 * Exact rational LP relaxations (solved by the unified simplex engine), branching by tightening variable
 * bounds. One Step per processed node, each carrying a full snapshot of the tree so the Step Player can
 * replay the tree growing. Node-selection strategy is user-selectable (best-bound / depth-first / breadth-first).
 */

import { Rational } from '../../math/rational';
import { Solver, Solution, ValidationResult, SolveOptions, Diagnostic } from '../../types/solver';
import { Step } from '../../types/step';
import { LPModel, BBState, BBNode, Constraint, Bound, VarType } from '../../types/models';
import { solveLP, validateLP } from '../lp/engine';
import { joinList } from '../../format';

export interface BBResult {
  status: string;
  variableValues: Rational[];
  objectiveValue: Rational;
  treeState: BBState;
  /** LP-relaxation objective at the root: the best conceivable value. */
  rootBound: Rational | null;
  /** Remaining optimality gap if the search stopped early (null when proven optimal). */
  gap: Rational | null;
}

export type NodeSelection = 'bestBound' | 'depthFirst' | 'breadthFirst';
export type BranchRule = 'firstFractional' | 'mostFractional';

export interface BBOptions extends SolveOptions {
  nodeSelection?: NodeSelection;
  branchRule?: BranchRule;
  /** explore the "≥ ceil" child before the "≤ floor" child */
  upFirst?: boolean;
  maxNodes?: number;
}

function floorR(r: Rational): Rational {
  const q = r.n / r.d;
  const fl = r.n < 0n && r.n % r.d !== 0n ? q - 1n : q;
  return Rational.of(fl);
}

function ceilR(r: Rational): Rational {
  return floorR(r).add(r.isInteger() ? Rational.ZERO : Rational.ONE);
}

export class BranchBoundSolver implements Solver<LPModel, BBState, BBResult> {
  readonly id = 'integer.branchBound';

  readonly meta = {
    name: 'Branch & Bound',
    category: 'integer-programming' as const,
    variants: [
      { id: 'bestBound', name: 'Best-bound first', description: 'Always expand the open node with the best LP bound.' },
      { id: 'depthFirst', name: 'Depth first', description: 'Dive down one branch before backtracking (finds incumbents early).' },
      { id: 'breadthFirst', name: 'Breadth first', description: 'Expand nodes level by level.' },
    ],
    visualizerId: 'BBTree',
    sizeLimit: { rows: 50, cols: 50 },
    supportsTutorial: false,
    reference: 'Taha, Operations Research: An Introduction, Ch. 9',
  };

  validate(model: LPModel): ValidationResult {
    return validateLP(model);
  }

  normalize(model: LPModel): LPModel {
    const n = model.objective.length;
    return { ...model, integrality: model.integrality ?? (Array(n).fill('integer') as VarType[]) };
  }

  solve(rawModel: LPModel, options: BBOptions = {}): Solution<BBState, BBResult> {
    const t0 = performance.now();
    const v = this.validate(rawModel);
    const fail = (message: string, code: string): Solution<BBState, BBResult> => ({
      steps: [], result: null, status: 'invalid-input',
      diagnostics: [{ severity: 'error', code, message }],
      metrics: { iterations: 0, elapsedMs: 0, degradedToFloat: false },
    });
    if (!v.valid) return fail(v.errors.map(e => e.message).join(' '), 'INVALID_MODEL');

    const model = this.normalize(rawModel);
    const n = model.objective.length;
    const isMax = model.sense === 'max';
    const integ = model.integrality!;
    const isIntVar = (j: number) => integ[j] !== 'continuous';
    if (!integ.some((_, j) => isIntVar(j))) {
      return fail('No variable is marked integer; this is an ordinary LP. Mark at least one variable as integer or binary.', 'NO_INTEGER_VARIABLES');
    }
    const strategy: NodeSelection = (options.variant as NodeSelection) ?? options.nodeSelection ?? 'bestBound';
    const branchRule = options.branchRule ?? 'firstFractional';
    const maxNodes = options.maxNodes ?? options.maxIterations ?? 200;
    const emit = options.emitSteps !== false;
    const diagnostics: Diagnostic[] = [];
    const names = model.varNames.map((nm, j) => nm || `x${j + 1}`);

    const better = (a: Rational, b: Rational) => (isMax ? a.gt(b) : a.lt(b));
    const betterOrEq = (a: Rational, b: Rational) => (isMax ? a.gte(b) : a.lte(b));

    // Baseline bounds (binary ⇒ [0,1])
    const baseBounds: Bound[] = model.objective.map((_, j) => {
      const b = model.varBounds?.[j] ?? { lower: Rational.ZERO, upper: null };
      if (integ[j] === 'binary') {
        return { lower: b.lower === null ? Rational.ZERO : (b.lower.gt(Rational.ZERO) ? b.lower : Rational.ZERO), upper: b.upper === null ? Rational.ONE : (b.upper.lt(Rational.ONE) ? b.upper : Rational.ONE) };
      }
      return { lower: b.lower, upper: b.upper };
    });

    // Node store
    interface Node extends BBNode { bounds: Bound[]; priority: Rational | null }
    const nodes: Node[] = [];
    const open: number[] = [];
    let incumbent = null as { values: Rational[]; objective: Rational } | null;
    const incumbentHistory: NonNullable<BBState['incumbentHistory']> = [];
    let explored = 0;
    let pruned = 0;
    let order = 0;
    const steps: Step<BBState>[] = [];

    const snapshot = (active: number | null): BBState => ({
      nodes: nodes.map(nd => ({
        id: nd.id, parentId: nd.parentId, depth: nd.depth,
        addedConstraints: nd.addedConstraints, relaxation: nd.relaxation ? { values: [...nd.relaxation.values], objective: nd.relaxation.objective } : null,
        status: nd.status, branchVariable: nd.branchVariable, branchValue: nd.branchValue, pruneReason: nd.pruneReason,
        children: [...nd.children], branchLabel: nd.branchLabel, processedOrder: nd.processedOrder, isIncumbent: nd.isIncumbent,
      })),
      activeNodeId: active,
      incumbent: incumbent ? { values: [...incumbent.values], objective: incumbent.objective } : null,
      bestBound: bestOpenBound(),
      exploredCount: explored,
      prunedCount: pruned,
      incumbentHistory: incumbentHistory.map(h => ({ ...h })),
      open: [...open],
    });

    const bestOpenBound = (): Rational | null => {
      let b: Rational | null = null;
      for (const id of open) {
        const p = nodes[id]!.priority;
        if (p && (b === null || better(p, b))) b = p;
      }
      if (incumbent && (b === null || !better(b, incumbent.objective))) b = incumbent.objective;
      return b;
    };

    const record = (active: number | null, kind: string, short: string, detailed: string, rule: string, status: Step<BBState>['status'], intent: 'optimal' | 'blocked' | 'candidate' | 'changed' = 'changed', note?: string) => {
      if (!emit) return;
      steps.push({
        index: steps.length,
        phase: active === null ? 'Branch & Bound' : `Node ${active}${nodes[active]!.depth ? ` (depth ${nodes[active]!.depth})` : ' (root)'}`,
        state: snapshot(active),
        action: { kind, payload: { node: active } },
        explanation: { short, detailed, rule, note },
        highlights: active === null ? [] : [{ target: `treenode:${active}`, intent }],
        status,
      });
    };

    const nodeModel = (nd: Node): LPModel => ({ ...model, varBounds: nd.bounds, integrality: undefined });

    const fmtSol = (vals: Rational[]) => names.map((nm, j) => `${nm} = ${vals[j]!.toString()}`).join(', ');

    /* ---------- root ---------- */
    const root: Node = { id: 0, parentId: null, depth: 0, addedConstraints: [], relaxation: null, status: 'pending', children: [], bounds: baseBounds, priority: null };
    nodes.push(root);
    const rootSol = solveLP(nodeModel(root), { emitSteps: false });
    explored++;
    root.processedOrder = order++;

    if (rootSol.status === 'infeasible') {
      root.status = 'pruned-infeasible';
      root.pruneReason = 'The LP relaxation is infeasible, so the integer problem is infeasible too.';
      pruned++;
      record(0, 'prune', 'Root LP relaxation is infeasible.', root.pruneReason, 'Infeasibility pruning', 'infeasible', 'blocked');
      diagnostics.push({ severity: 'error', code: 'INTEGER_INFEASIBLE', message: root.pruneReason });
      return { steps, result: null, status: 'infeasible', diagnostics, metrics: { iterations: 1, elapsedMs: performance.now() - t0, degradedToFloat: false } };
    }
    if (rootSol.status === 'unbounded') {
      root.status = 'pruned-infeasible';
      root.pruneReason = 'The LP relaxation is unbounded.';
      record(0, 'prune', 'Root LP relaxation is unbounded.', 'The root LP relaxation is unbounded: the integer problem is either unbounded or infeasible. Add bounds on the variables to decide.', 'Unbounded relaxation', 'unbounded', 'blocked');
      diagnostics.push({ severity: 'error', code: 'UNBOUNDED_RELAXATION', message: 'The LP relaxation is unbounded — the integer problem is unbounded or infeasible. Bound the variables to find out which.' });
      return { steps, result: null, status: 'unbounded', diagnostics, metrics: { iterations: 1, elapsedMs: performance.now() - t0, degradedToFloat: false } };
    }
    if (!rootSol.result) return fail('The LP relaxation could not be solved.', 'LP_FAILED');

    root.relaxation = { values: rootSol.result.variableValues, objective: rootSol.result.objectiveValue };
    const rootBound = root.relaxation.objective;

    const fractionalVars = (vals: Rational[]) => vals.map((x, j) => (isIntVar(j) && !x.isInteger() ? j : -1)).filter(j => j >= 0);

    /** process a node whose relaxation is stored; decide prune / incumbent / branch. Returns children ids. */
    const decide = (nd: Node): void => {
      const rel = nd.relaxation!;
      if (incumbent && betterOrEq(incumbent.objective, rel.objective)) {
        nd.status = 'pruned-bound';
        nd.pruneReason = `Bound ${rel.objective.toString()} cannot beat the incumbent ${incumbent.objective.toString()}.`;
        pruned++;
        record(nd.id, 'prune', `Node ${nd.id} pruned by bound.`,
          `The relaxation of node ${nd.id} gives ${rel.objective.toString()}, which is not better than the incumbent ${incumbent.objective.toString()}. No integer point in this subtree can improve on the incumbent, so it is cut off.`,
          'Prune by bound', 'continue', 'blocked');
        return;
      }
      const fr = fractionalVars(rel.values);
      if (fr.length === 0) {
        nd.status = 'integer-feasible';
        const improved = !incumbent || better(rel.objective, incumbent.objective);
        if (improved) {
          incumbent = { values: [...rel.values], objective: rel.objective };
          incumbentHistory.push({ nodeId: nd.id, order: nd.processedOrder!, objective: rel.objective });
          diagnostics.push({ severity: 'info', code: 'NEW_INCUMBENT', message: `New incumbent at node ${nd.id}: z = ${rel.objective.toString()} (${fmtSol(rel.values)}).` });
          // prune open nodes dominated by the new incumbent
          for (let k = open.length - 1; k >= 0; k--) {
            const o = nodes[open[k]!]!;
            if (o.priority && betterOrEq(rel.objective, o.priority)) {
              o.status = 'pruned-bound';
              o.pruneReason = `Parent bound ${o.priority.toString()} cannot beat the new incumbent ${rel.objective.toString()}.`;
              o.processedOrder = undefined;
              pruned++;
              open.splice(k, 1);
            }
          }
        }
        record(nd.id, 'incumbent', improved ? `Node ${nd.id}: integer solution, new incumbent z = ${rel.objective.toString()}.` : `Node ${nd.id}: integer solution z = ${rel.objective.toString()}, not an improvement.`,
          `The relaxation of node ${nd.id} satisfies every integrality requirement: ${fmtSol(rel.values)} with z = ${rel.objective.toString()}. ` +
          (improved ? 'It becomes the incumbent (best known integer solution); open nodes whose bound cannot beat it are pruned.' : 'It is no better than the incumbent, so nothing changes.'),
          'Integer feasibility test', 'continue', 'optimal');
        return;
      }
      // branch
      let j = fr[0]!;
      if (branchRule === 'mostFractional') {
        // closest to ½ = largest min(f, 1−f); ties → lowest index
        const dist = (x: Rational) => { const f = x.sub(floorR(x)); return f.gt(Rational.of(1, 2)) ? Rational.ONE.sub(f) : f; };
        j = fr.reduce((best, q) => (dist(rel.values[q]!).gt(dist(rel.values[best]!)) ? q : best), fr[0]!);
      }
      const val = rel.values[j]!;
      const fl = floorR(val);
      const ce = ceilR(val);
      nd.branchVariable = j;
      nd.branchValue = val;
      nd.status = 'solved';

      const mk = (down: boolean): Node => {
        const bounds = nd.bounds.map(b => ({ ...b }));
        if (down) bounds[j] = { lower: bounds[j]!.lower, upper: bounds[j]!.upper === null || fl.lt(bounds[j]!.upper!) ? fl : bounds[j]!.upper };
        else bounds[j] = { lower: bounds[j]!.lower === null || ce.gt(bounds[j]!.lower!) ? ce : bounds[j]!.lower, upper: bounds[j]!.upper };
        const label = down ? `${names[j]} ≤ ${fl.toString()}` : `${names[j]} ≥ ${ce.toString()}`;
        const cons: Constraint = { coeffs: Array.from({ length: n }, (_, k) => (k === j ? Rational.ONE : Rational.ZERO)), relation: down ? '<=' : '>=', rhs: down ? fl : ce, name: label };
        return { id: nodes.length, parentId: nd.id, depth: nd.depth + 1, addedConstraints: [...nd.addedConstraints, cons], relaxation: null, status: 'pending', children: [], bounds, priority: rel.objective, branchLabel: label };
      };
      const down = mk(true);
      nodes.push(down);
      const up = mk(false);
      nodes.push(up);
      nd.children = [down.id, up.id];
      const pair = options.upFirst ? [up.id, down.id] : [down.id, up.id];
      if (strategy === 'depthFirst') {
        // `open` acts as a stack (last element is popped first): push the second child first.
        open.push(pair[1]!, pair[0]!);
      } else {
        open.push(pair[0]!, pair[1]!);
      }
      record(nd.id, 'branch', `Branch on ${names[j]} = ${val.toString()}: ${down.branchLabel} | ${up.branchLabel}.`,
        `Node ${nd.id}: LP optimum ${fmtSol(rel.values)}, z = ${rel.objective.toString()}. ${names[j]} = ${val.toString()} is fractional, but ${names[j]} must be an integer, so no integer solution lies strictly between ${fl.toString()} and ${ce.toString()}. ` +
        `The region is split into two subproblems: ${down.branchLabel} (node ${down.id}) and ${up.branchLabel} (node ${up.id}). ` +
        `${fr.length > 1 ? `Other fractional variables: ${joinList(fr.filter(k => k !== j).map(k => names[k]!))}; ${branchRule === 'mostFractional' ? 'the one closest to ½ was chosen' : 'the lowest-index one was chosen'}. ` : ''}Together the two children contain every integer-feasible point of this node.`,
        branchRule === 'mostFractional' ? 'Branch on most fractional variable' : 'Branch on first fractional variable', 'continue', 'candidate');
    };

    // Root step(s)
    if (fractionalVars(root.relaxation.values).length === 0) {
      root.status = 'integer-feasible';
      incumbent = { values: [...root.relaxation.values], objective: root.relaxation.objective };
      incumbentHistory.push({ nodeId: 0, order: 0, objective: root.relaxation.objective });
      root.isIncumbent = true;
      record(0, 'incumbent', 'The LP relaxation is already integral — no branching needed.',
        `The root LP relaxation gives ${fmtSol(root.relaxation.values)} with z = ${root.relaxation.objective.toString()}, which already satisfies all integrality requirements. It is therefore optimal for the integer problem; no branching was necessary.`,
        'Relaxation already integral', 'optimal', 'optimal');
      diagnostics.push({ severity: 'info', code: 'RELAXATION_INTEGRAL', message: 'The LP relaxation is already integral; the tree has only the root node.' });
      return {
        steps,
        result: { status: 'optimal', variableValues: incumbent.values, objectiveValue: incumbent.objective, treeState: snapshot(0), rootBound, gap: null },
        status: 'optimal',
        diagnostics,
        metrics: { iterations: 1, elapsedMs: performance.now() - t0, degradedToFloat: false },
      };
    }
    record(0, 'relax', `Root relaxation: z = ${root.relaxation.objective.toString()}.`,
      `Ignoring integrality, the LP relaxation gives ${fmtSol(root.relaxation.values)} with z = ${root.relaxation.objective.toString()}. This is an ${isMax ? 'upper' : 'lower'} bound on any integer solution. Fractional variable(s): ${joinList(fractionalVars(root.relaxation.values).map(j => names[j]!))}.`,
      'LP relaxation', 'continue', 'candidate');
    decide(root);

    /* ---------- main loop ---------- */
    let nodeBudgetHit = false;
    while (open.length > 0) {
      if (nodes.length >= maxNodes) { nodeBudgetHit = true; break; }
      // select
      let pickIdx = 0;
      if (strategy === 'depthFirst') pickIdx = open.length - 1;
      else if (strategy === 'breadthFirst') pickIdx = 0;
      else {
        pickIdx = 0;
        for (let k = 1; k < open.length; k++) {
          const a = nodes[open[k]!]!.priority!;
          const b = nodes[open[pickIdx]!]!.priority!;
          if (better(a, b)) pickIdx = k;
        }
      }
      const id = open.splice(pickIdx, 1)[0]!;
      const nd = nodes[id]!;
      nd.processedOrder = order++;
      explored++;

      // infeasible bounds shortcut
      const crossed = nd.bounds.some(b => b.lower !== null && b.upper !== null && b.lower.gt(b.upper));
      const sol = crossed ? null : solveLP(nodeModel(nd), { emitSteps: false });
      if (!sol || sol.status === 'infeasible') {
        nd.status = 'pruned-infeasible';
        nd.pruneReason = 'The LP relaxation of this subproblem is infeasible.';
        pruned++;
        record(id, 'prune', `Node ${id} (${nd.branchLabel}) is infeasible.`, `Adding ${nd.branchLabel} leaves no feasible LP point, so this subtree contains no integer solution.`, 'Prune by infeasibility', 'continue', 'blocked');
        continue;
      }
      if (sol.status === 'unbounded' || !sol.result) {
        nd.status = 'pruned-infeasible';
        nd.pruneReason = 'Unbounded subproblem.';
        pruned++;
        record(id, 'prune', `Node ${id} is unbounded.`, 'The subproblem relaxation is unbounded; add bounds on the variables.', 'Unbounded', 'continue', 'blocked');
        continue;
      }
      nd.relaxation = { values: sol.result.variableValues, objective: sol.result.objectiveValue };
      decide(nd);
    }

    const elapsed = performance.now() - t0;
    if (nodeBudgetHit) {
      diagnostics.push({
        severity: 'warning',
        code: 'NODE_LIMIT',
        message: `Node limit (${maxNodes}) reached with ${open.length} open node(s). The search is incomplete: ${incumbent ? `best integer solution so far z = ${incumbent.objective.toString()} is NOT proven optimal` : 'no integer solution found yet'}. Raise the limit, switch the node-selection strategy, or abort.`,
      });
      const gapVal: Rational | null = incumbent && bestOpenBound() ? bestOpenBound()!.sub(incumbent.objective).abs() : null;
      record(null, 'limit', 'Node limit reached.', 'The configured node limit was reached before the tree was exhausted.', 'Node limit', 'iteration-limit', 'changed');
      return {
        steps,
        result: incumbent ? { status: 'iteration-limit', variableValues: incumbent.values, objectiveValue: incumbent.objective, treeState: snapshot(null), rootBound, gap: gapVal } : null,
        status: 'iteration-limit',
        diagnostics,
        metrics: { iterations: explored, elapsedMs: elapsed, degradedToFloat: false },
      };
    }

    if (!incumbent) {
      diagnostics.push({ severity: 'error', code: 'INTEGER_INFEASIBLE', message: `The tree is exhausted without an integer-feasible node: the integer problem is infeasible. (The LP relaxation bound ${rootBound.toString()} is unattainable.)` });
      record(null, 'done', 'Tree exhausted: no integer solution exists.', `Every node was pruned and none was integer-feasible. The LP relaxation bound ${rootBound.toString()} cannot be attained by any integer point.`, 'Exhaustive search', 'infeasible', 'blocked');
      return { steps, result: null, status: 'infeasible', diagnostics, metrics: { iterations: explored, elapsedMs: elapsed, degradedToFloat: false } };
    }

    // mark incumbent node
    const incNode = [...nodes].reverse().find(nd => nd.status === 'integer-feasible' && incumbent && nd.relaxation!.objective.eq(incumbent.objective));
    if (incNode) incNode.isIncumbent = true;
    record(incNode?.id ?? null, 'done', `Optimal integer solution: z = ${incumbent.objective.toString()}.`,
      `All nodes are processed or pruned. The best integer solution is ${fmtSol(incumbent.values)} with z = ${incumbent.objective.toString()}, compared with the LP-relaxation bound ${rootBound.toString()} (integrality gap ${incumbent.objective.sub(rootBound).abs().toString()}).`,
      'Optimality by exhaustion', 'optimal', 'optimal');
    return {
      steps,
      result: { status: 'optimal', variableValues: incumbent.values, objectiveValue: incumbent.objective, treeState: snapshot(incNode?.id ?? null), rootBound, gap: null },
      status: 'optimal',
      diagnostics,
      metrics: { iterations: explored, elapsedMs: elapsed, degradedToFloat: false },
    };
  }
}
