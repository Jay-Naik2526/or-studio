/**
 * Graphical LP solver for 2-variable problems (spec §9.1 module 1, §4.3).
 *
 * Corner-point enumeration with exact rational vertices, binding-constraint identification,
 * alternate-optimum and unboundedness detection. Optimal status/value come from the exact simplex engine,
 * so the picture can never disagree with the algebra.
 */

import { Rational } from '../../math/rational';
import { LPModel, Relation } from '../../types/models';
import { solveLP } from './engine';

export interface Point2D {
  x: Rational;
  y: Rational;
}

export interface Line2D {
  a: Rational; // a·x + b·y (relation) c
  b: Rational;
  c: Rational;
  label: string;
  relation: Relation;
  /** index in model.constraints, or null for bound lines (x ≥ 0 …) */
  constraintIndex: number | null;
}

export interface VertexInfo extends Point2D {
  z: Rational;
  /** indices into `lines` of every line passing through this vertex */
  binding: number[];
  isOptimal: boolean;
}

export interface GraphicalSolution {
  status: 'optimal' | 'infeasible' | 'unbounded';
  vertices: VertexInfo[];
  optimalVertex: Point2D | null;
  optimalVertices: Point2D[];
  optimalValue: Rational | null;
  alternateOptima: boolean;
  /** original constraint indices binding at the first optimal vertex */
  bindingConstraints: number[];
  lines: Line2D[];
  regionUnbounded: boolean;
  objective: { c1: Rational; c2: Rational; sense: 'max' | 'min' };
  messages: string[];
}

function lhs(l: { a: Rational; b: Rational }, p: Point2D): Rational {
  return l.a.mul(p.x).add(l.b.mul(p.y));
}

function satisfies(l: Line2D, p: Point2D): boolean {
  const v = lhs(l, p);
  return l.relation === '<=' ? v.lte(l.c) : l.relation === '>=' ? v.gte(l.c) : v.eq(l.c);
}

export class GraphicalLPSolver {
  static solve(model: LPModel): GraphicalSolution {
    if (model.objective.length !== 2) {
      throw new Error('The graphical method needs exactly 2 decision variables.');
    }
    const [c1, c2] = [model.objective[0]!, model.objective[1]!];
    const isMax = model.sense === 'max';
    const names = model.varNames;
    const messages: string[] = [];

    const lines: Line2D[] = model.constraints.map((c, i) => ({
      a: c.coeffs[0] ?? Rational.ZERO,
      b: c.coeffs[1] ?? Rational.ZERO,
      c: c.rhs,
      label: c.name || `Constraint ${i + 1}`,
      relation: c.relation,
      constraintIndex: i,
    }));
    // bounds (default x ≥ 0)
    for (let j = 0; j < 2; j++) {
      const b = model.varBounds?.[j] ?? { lower: Rational.ZERO, upper: null };
      const unit = { a: j === 0 ? Rational.ONE : Rational.ZERO, b: j === 1 ? Rational.ONE : Rational.ZERO };
      if (b.lower !== null) lines.push({ ...unit, c: b.lower, label: `${names[j]} ≥ ${b.lower.toString()}`, relation: '>=', constraintIndex: null });
      if (b.upper !== null) lines.push({ ...unit, c: b.upper, label: `${names[j]} ≤ ${b.upper.toString()}`, relation: '<=', constraintIndex: null });
    }

    // Candidate vertices: pairwise intersections
    const cand: Point2D[] = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const l1 = lines[i]!;
        const l2 = lines[j]!;
        const det = l1.a.mul(l2.b).sub(l2.a.mul(l1.b));
        if (det.isZero()) continue;
        const x = l1.c.mul(l2.b).sub(l2.c.mul(l1.b)).div(det);
        const y = l1.a.mul(l2.c).sub(l2.a.mul(l1.c)).div(det);
        cand.push({ x, y });
      }
    }
    const feasible: Point2D[] = [];
    for (const p of cand) {
      if (!lines.every(l => satisfies(l, p))) continue;
      if (!feasible.some(q => q.x.eq(p.x) && q.y.eq(p.y))) feasible.push(p);
    }

    const sol = solveLP(model, { emitSteps: false });
    const objAt = (p: Point2D) => c1.mul(p.x).add(c2.mul(p.y)).add(model.objectiveConstant ?? Rational.ZERO);

    // Region unbounded?
    const ray = (sense: 'max' | 'min') =>
      solveLP({ ...model, sense, objective: [Rational.ONE, Rational.ONE], objectiveConstant: undefined }, { emitSteps: false }).status === 'unbounded';
    const regionUnbounded = feasible.length > 0 && (ray('max') || ray('min') || [Rational.ONE, Rational.MINUS_ONE].some(sgn =>
      solveLP({ ...model, sense: 'max', objective: [sgn, Rational.MINUS_ONE.mul(sgn)], objectiveConstant: undefined }, { emitSteps: false }).status === 'unbounded'));

    const vertices: VertexInfo[] = feasible.map(p => ({
      ...p,
      z: objAt(p),
      binding: lines.map((l, i) => (lhs(l, p).eq(l.c) ? i : -1)).filter(i => i >= 0),
      isOptimal: false,
    }));

    if (sol.status === 'infeasible' || (feasible.length === 0 && sol.status !== 'unbounded' && !sol.result)) {
      return { status: 'infeasible', vertices: [], optimalVertex: null, optimalVertices: [], optimalValue: null, alternateOptima: false, bindingConstraints: [], lines, regionUnbounded: false, objective: { c1, c2, sense: model.sense }, messages: ['The constraints have no common point: the feasible region is empty.'] };
    }
    if (sol.status === 'unbounded') {
      messages.push('The objective improves without limit along an unbounded edge of the region: no finite optimum exists.');
      return { status: 'unbounded', vertices, optimalVertex: null, optimalVertices: [], optimalValue: null, alternateOptima: false, bindingConstraints: [], lines, regionUnbounded: true, objective: { c1, c2, sense: model.sense }, messages };
    }

    const bestVal = sol.result!.objectiveValue;
    const optimalVertices = vertices.filter(v => v.z.eq(bestVal));
    optimalVertices.forEach(v => (v.isOptimal = true));
    let first: VertexInfo | null = optimalVertices[0] ?? null;
    if (!first && sol.result) {
      // The region has no corner point at all (free variables, e.g. a strip or a half-plane): report the solver's point.
      const pt: Point2D = { x: sol.result.variableValues[0] ?? Rational.ZERO, y: sol.result.variableValues[1] ?? Rational.ZERO };
      first = { ...pt, z: bestVal, binding: lines.map((l, i) => (lhs(l, pt).eq(l.c) ? i : -1)).filter(i => i >= 0), isOptimal: true };
      optimalVertices.push(first);
      messages.push('The feasible region has no corner point (a variable is unrestricted), so the optimum is reported at a point on its boundary.');
    }
    const binding = first ? first.binding.map(i => lines[i]!.constraintIndex).filter((i): i is number => i !== null) : [];
    const alt = optimalVertices.length > 1 || sol.status === 'optimal-alternate-exists';
    if (alt) messages.push('The iso-profit line is parallel to a binding constraint: every point on that edge is optimal (alternate optima).');
    if (regionUnbounded) messages.push('The feasible region is unbounded, but the objective is bounded in its improving direction, so an optimum exists.');
    if (first && first.binding.length > 2) messages.push('More than two constraints meet at the optimal vertex — the solution is degenerate.');

    return {
      status: 'optimal',
      vertices,
      optimalVertex: first ? { x: first.x, y: first.y } : null,
      optimalVertices: optimalVertices.map(v => ({ x: v.x, y: v.y })),
      optimalValue: bestVal,
      alternateOptima: alt,
      bindingConstraints: binding,
      lines,
      regionUnbounded,
      objective: { c1, c2, sense: model.sense },
      messages: [...messages, isMax ? '' : ''].filter(Boolean),
    };
  }
}
