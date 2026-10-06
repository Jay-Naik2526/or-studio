/**
 * Nonlinear programming (spec §9.5): unconstrained minimisation by gradient descent (exact/backtracking line search)
 * and Newton's method with SYMBOLIC derivatives, KKT-condition verification, and EXACT quadratic programming by
 * active-set (KKT) enumeration in rational arithmetic. Separable programming is documented future work.
 */

import { Rational } from '../../math/rational';
import { Step } from '../../types/step';
import { Diagnostic } from '../../types/solver';

/* ---------------- symbolic expressions ---------------- */

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'var'; i: number }
  | { k: 'add' | 'sub' | 'mul' | 'div' | 'pow'; a: Expr; b: Expr }
  | { k: 'neg'; a: Expr }
  | { k: 'fn'; f: 'exp' | 'ln' | 'sin' | 'cos' | 'sqrt'; a: Expr };

const num = (v: number): Expr => ({ k: 'num', v });
const isNum = (e: Expr, v?: number): boolean => e.k === 'num' && (v === undefined || (e as { k: 'num'; v: number }).v === v);
const nv = (e: Expr): number => (e as { k: 'num'; v: number }).v;

const MAX_EXPR_CHARS = 2000;
const MAX_EXPR_DEPTH = 80;

export function parseExpression(src: string, varNames: string[]): Expr {
  if (src.length > MAX_EXPR_CHARS) throw new Error(`The expression is too long (limit ${MAX_EXPR_CHARS} characters).`);
  let p = 0;
  let depth = 0;
  const s = src.replace(/\s+/g, '').replace(/−/g, '-').replace(/²/g, '^2').replace(/³/g, '^3');
  const peek = () => s[p];
  const fail = (m: string): never => { throw new Error(`${m} (at position ${p + 1} of "${src}")`); };
  const sum = (): Expr => { let l = term(); while (peek() === '+' || peek() === '-') { const op = s[p++]; const r = term(); l = { k: op === '+' ? 'add' : 'sub', a: l, b: r }; } return l; };
  const term = (): Expr => {
    let l = unary();
    while (peek() === '*' || peek() === '/' || (peek() !== undefined && (/[A-Za-z(]/.test(peek()!)) && implicitOk(l))) {
      if (peek() === '*' || peek() === '/') { const op = s[p++]; const r = unary(); l = { k: op === '*' ? 'mul' : 'div', a: l, b: r }; }
      else { const r = unary(); l = { k: 'mul', a: l, b: r }; }
    }
    return l;
  };
  const implicitOk = (l: Expr) => l.k === 'num';
  const unary = (): Expr => {
    if (++depth > MAX_EXPR_DEPTH) fail('The expression is nested too deeply');
    try { if (peek() === '-') { p++; return { k: 'neg', a: unary() }; } if (peek() === '+') { p++; return unary(); } return power(); } finally { depth--; }
  };
  const power = (): Expr => { const b = atom(); if (peek() === '^') { p++; const e = unary(); return { k: 'pow', a: b, b: e }; } return b; };
  const atom = (): Expr => {
    const c = peek();
    if (c === undefined) return fail('Unexpected end of expression');
    if (c === '(') { p++; const e = sum(); if (peek() !== ')') fail("Missing ')'"); p++; return e; }
    if (/[0-9.]/.test(c)) {
      let j = p; while (j < s.length && /[0-9.]/.test(s[j]!)) j++;
      // scientific notation (1e-6, 2.5E3) unless the letter starts a variable name such as e1
      if ((s[j] === 'e' || s[j] === 'E') && /^[+-]?\d/.test(s.slice(j + 1)) && !varNames.some(nm => nm.length > 0 && s.startsWith(nm, j))) { j++; if (s[j] === '+' || s[j] === '-') j++; while (j < s.length && /[0-9]/.test(s[j]!)) j++; }
      const v = Number(s.slice(p, j));
      if (!Number.isFinite(v)) { const bad = s.slice(p, j); p = j; return fail(`Bad number "${bad}"`); }
      p = j; return num(v);
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = p; while (j < s.length && /[A-Za-z0-9_₀-₉]/.test(s[j]!)) j++;
      const id = s.slice(p, j);
      if (['exp', 'ln', 'sin', 'cos', 'sqrt'].includes(id) && s[j] === '(') { p = j + 1; const a = sum(); if (peek() !== ')') fail("Missing ')'"); p++; return { k: 'fn', f: id as 'exp', a }; }
      const vi = varNames.indexOf(id);
      if (vi < 0) { p = j; return fail(`Unknown variable "${id}" — use ${varNames.join(', ')}`); }
      p = j; return { k: 'var', i: vi };
    }
    return fail(`Unexpected "${c}"`);
  };
  const e = sum();
  if (p < s.length) fail(`Unexpected "${s[p]}"`);
  return e;
}

export function evalExpr(e: Expr, x: number[]): number {
  switch (e.k) {
    case 'num': return e.v;
    case 'var': return x[e.i]!;
    case 'add': return evalExpr(e.a, x) + evalExpr(e.b, x);
    case 'sub': return evalExpr(e.a, x) - evalExpr(e.b, x);
    case 'mul': return evalExpr(e.a, x) * evalExpr(e.b, x);
    case 'div': return evalExpr(e.a, x) / evalExpr(e.b, x);
    case 'pow': return Math.pow(evalExpr(e.a, x), evalExpr(e.b, x));
    case 'neg': return -evalExpr(e.a, x);
    case 'fn': { const v = evalExpr(e.a, x); return e.f === 'exp' ? Math.exp(v) : e.f === 'ln' ? Math.log(v) : e.f === 'sin' ? Math.sin(v) : e.f === 'cos' ? Math.cos(v) : Math.sqrt(v); }
  }
}

function simp(e: Expr): Expr {
  switch (e.k) {
    case 'add': { const a = simp(e.a), b = simp(e.b); if (isNum(a, 0)) return b; if (isNum(b, 0)) return a; if (isNum(a) && isNum(b)) return num(nv(a) + nv(b)); return { k: 'add', a, b }; }
    case 'sub': { const a = simp(e.a), b = simp(e.b); if (isNum(b, 0)) return a; if (isNum(a) && isNum(b)) return num(nv(a) - nv(b)); if (isNum(a, 0)) return simp({ k: 'neg', a: b }); return { k: 'sub', a, b }; }
    case 'mul': { const a = simp(e.a), b = simp(e.b); if (isNum(a, 0) || isNum(b, 0)) return num(0); if (isNum(a, 1)) return b; if (isNum(b, 1)) return a; if (isNum(a) && isNum(b)) return num(nv(a) * nv(b)); return { k: 'mul', a, b }; }
    case 'div': { const a = simp(e.a), b = simp(e.b); if (isNum(a, 0)) return num(0); if (isNum(b, 1)) return a; if (isNum(a) && isNum(b)) return num(nv(a) / nv(b)); return { k: 'div', a, b }; }
    case 'pow': { const a = simp(e.a), b = simp(e.b); if (isNum(b, 0)) return num(1); if (isNum(b, 1)) return a; return { k: 'pow', a, b }; }
    case 'neg': { const a = simp(e.a); if (isNum(a)) return num(-nv(a)); if (a.k === 'neg') return a.a; return { k: 'neg', a }; }
    case 'fn': return { k: 'fn', f: e.f, a: simp(e.a) };
    default: return e;
  }
}

export function diff(e: Expr, i: number): Expr {
  const d = (x: Expr): Expr => {
    switch (x.k) {
      case 'num': return num(0);
      case 'var': return num(x.i === i ? 1 : 0);
      case 'add': return { k: 'add', a: d(x.a), b: d(x.b) };
      case 'sub': return { k: 'sub', a: d(x.a), b: d(x.b) };
      case 'neg': return { k: 'neg', a: d(x.a) };
      case 'mul': return { k: 'add', a: { k: 'mul', a: d(x.a), b: x.b }, b: { k: 'mul', a: x.a, b: d(x.b) } };
      case 'div': return { k: 'div', a: { k: 'sub', a: { k: 'mul', a: d(x.a), b: x.b }, b: { k: 'mul', a: x.a, b: d(x.b) } }, b: { k: 'pow', a: x.b, b: num(2) } };
      case 'pow':
        if (isNum(x.b)) return { k: 'mul', a: { k: 'mul', a: num(nv(x.b)), b: { k: 'pow', a: x.a, b: num(nv(x.b) - 1) } }, b: d(x.a) };
        return { k: 'mul', a: x, b: { k: 'add', a: { k: 'mul', a: d(x.b), b: { k: 'fn', f: 'ln', a: x.a } }, b: { k: 'div', a: { k: 'mul', a: x.b, b: d(x.a) }, b: x.a } } };
      case 'fn':
        switch (x.f) {
          case 'exp': return { k: 'mul', a: x, b: d(x.a) };
          case 'ln': return { k: 'div', a: d(x.a), b: x.a };
          case 'sin': return { k: 'mul', a: { k: 'fn', f: 'cos', a: x.a }, b: d(x.a) };
          case 'cos': return { k: 'neg', a: { k: 'mul', a: { k: 'fn', f: 'sin', a: x.a }, b: d(x.a) } };
          case 'sqrt': return { k: 'div', a: d(x.a), b: { k: 'mul', a: num(2), b: x } };
        }
    }
  };
  return simp(d(e));
}

export function exprToString(e: Expr, names: string[]): string {
  const w = (x: Expr, prec: number): string => {
    let s: string, p: number;
    switch (x.k) {
      case 'num': return x.v < 0 ? `(${x.v})` : String(Number(x.v.toFixed(8)));
      case 'var': return names[x.i]!;
      case 'neg': return `-${w(x.a, 3)}`;
      case 'add': s = `${w(x.a, 1)} + ${w(x.b, 1)}`; p = 1; break;
      case 'sub': s = `${w(x.a, 1)} − ${w(x.b, 2)}`; p = 1; break;
      case 'mul': s = `${w(x.a, 2)}·${w(x.b, 2)}`; p = 2; break;
      case 'div': s = `${w(x.a, 2)}/${w(x.b, 3)}`; p = 2; break;
      case 'pow': s = `${w(x.a, 4)}^${w(x.b, 4)}`; p = 3; break;
      case 'fn': return `${x.f}(${w(x.a, 0)})`;
    }
    return p < prec ? `(${s})` : s;
  };
  return w(e, 0);
}

/* ---------------- unconstrained optimisation ---------------- */

export interface NLPState { x: number[]; f: number; grad: number[]; gradNorm: number; stepSize?: number; direction?: number[]; hessianPD?: boolean }

export interface UnconstrainedInput {
  expression: string;
  varNames?: string[];
  start: number[];
  method: 'gradient' | 'newton';
  tolerance?: number;
  maxIterations?: number;
}

export interface UnconstrainedResult {
  error?: string;
  x: number[];
  f: number;
  converged: boolean;
  iterations: number;
  gradientText: string[];
  hessianText: string[][];
  classification?: 'minimum' | 'maximum' | 'saddle' | 'inconclusive';
  eigenvalues?: number[];
  steps: Step<NLPState>[];
  diagnostics: Diagnostic[];
  /** evaluator for contour plotting */
  evaluate: (x: number[]) => number;
}

function hessianAt(H: Expr[][], x: number[]): number[][] { return H.map(r => r.map(e => evalExpr(e, x))); }
function solve2(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r]![c]! / M[c]![c]!; for (let k = c; k <= n; k++) M[r]![k] = M[r]![k]! - f * M[c]![k]!; }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}
function eigSym(H: number[][]): number[] {
  const n = H.length;
  if (n === 1) return [H[0]![0]!];
  if (n === 2) { const a = H[0]![0]!, b = H[0]![1]!, d = H[1]![1]!; const t = (a + d) / 2, r = Math.sqrt(((a - d) / 2) ** 2 + b * b); return [t - r, t + r]; }
  // Jacobi
  const A = H.map(r => [...r]);
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i]![j]! ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p]![q]!) < 1e-14) continue;
      const th = (A[q]![q]! - A[p]![p]!) / (2 * A[p]![q]!);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const kp = A[k]![p]!, kq = A[k]![q]!; A[k]![p] = c * kp - s * kq; A[k]![q] = s * kp + c * kq; }
      for (let k = 0; k < n; k++) { const pk = A[p]![k]!, qk = A[q]![k]!; A[p]![k] = c * pk - s * qk; A[q]![k] = s * pk + c * qk; }
    }
  }
  return A.map((r, i) => r[i]!).sort((a, b) => a - b);
}

export const MAX_NLP_VARIABLES = 20;
export const MAX_NLP_ITERATIONS = 20000;

export function minimiseUnconstrained(input: UnconstrainedInput): UnconstrainedResult {
  const n = input.start.length;
  const names = input.varNames ?? Array.from({ length: n }, (_, i) => `x${i + 1}`);
  const empty: UnconstrainedResult = { x: input.start, f: NaN, converged: false, iterations: 0, gradientText: [], hessianText: [], steps: [], diagnostics: [], evaluate: () => NaN };
  if (n < 1) return { ...empty, error: 'Enter at least one variable and a starting point.' };
  if (n > MAX_NLP_VARIABLES) return { ...empty, error: `At most ${MAX_NLP_VARIABLES} variables are supported (the Hessian has n² symbolic entries).` };
  if (names.length !== n) return { ...empty, error: `There are ${n} starting values but ${names.length} variable names.` };
  if (!input.start.every(Number.isFinite)) return { ...empty, error: 'Every starting value must be a finite number.' };
  if (input.maxIterations !== undefined && !(Number.isInteger(input.maxIterations) && input.maxIterations >= 1 && input.maxIterations <= MAX_NLP_ITERATIONS)) return { ...empty, error: `The iteration limit must be a whole number between 1 and ${MAX_NLP_ITERATIONS.toLocaleString('en-US')}.` };
  if (input.tolerance !== undefined && !(Number.isFinite(input.tolerance) && input.tolerance > 0)) return { ...empty, error: 'The tolerance must be a positive number.' };
  let f: Expr;
  try { f = parseExpression(input.expression, names); } catch (e) { return { ...empty, error: (e as Error).message }; }
  const g = names.map((_, i) => diff(f, i));
  const H = g.map(gi => names.map((_, j) => diff(gi, j)));
  const F = (x: number[]) => evalExpr(f, x);
  const G = (x: number[]) => g.map(gi => evalExpr(gi, x));
  const tol = input.tolerance ?? 1e-8;
  const maxIt = input.maxIterations ?? 200;
  const steps: Step<NLPState>[] = [];
  const diagnostics: Diagnostic[] = [];
  let x = [...input.start];
  if (!Number.isFinite(F(x))) return { ...empty, error: 'The function is not finite at the starting point.' };
  const norm = (v: number[]) => Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  const push = (phase: string, short: string, detailed: string, rule: string, st: NLPState, status: Step<NLPState>['status'] = 'continue') => steps.push({ index: steps.length, phase, state: st, action: null, explanation: { short, detailed, rule }, highlights: [], status });
  const fmt = (v: number[]) => `(${v.map(a => Number(a.toFixed(5))).join(', ')})`;
  push('Start', `Start at ${fmt(x)}, f = ${Number(F(x).toFixed(6))}.`, `∇f = (${g.map(gi => exprToString(gi, names)).join(', ')}). ${input.method === 'newton' ? 'Newton\'s method solves H·d = −∇f for the step.' : 'Gradient descent moves along −∇f with a line search.'}`, 'Initialisation', { x: [...x], f: F(x), grad: G(x), gradNorm: norm(G(x)) }, 'initial');
  let converged = false;
  let unbounded = false;
  let it = 0;
  for (; it < maxIt; it++) {
    const gr = G(x);
    const gn = norm(gr);
    if (gn < tol) { converged = true; break; }
    let d: number[];
    let rule: string;
    let pd: boolean | undefined;
    if (input.method === 'newton') {
      const Hx = hessianAt(H, x);
      const sol = solve2(Hx, gr.map(v => -v));
      const eig = eigSym(Hx);
      pd = eig[0]! > 1e-12;
      if (!sol || !pd) { d = gr.map(v => -v); rule = 'Newton step unavailable (Hessian singular / not positive definite): steepest descent fallback'; diagnostics.push({ severity: 'warning', code: 'NEWTON_FALLBACK', message: `At ${fmt(x)} the Hessian is not positive definite; a gradient step was used.` }); }
      else { d = sol; rule = "Newton's method: d = −H⁻¹∇f"; }
    } else { d = gr.map(v => -v); rule = 'Steepest descent: d = −∇f'; }
    // backtracking (Armijo)
    let t = input.method === 'newton' && pd ? 1 : 1;
    const f0 = F(x), slope = gr.reduce((s, v, i) => s + v * d[i]!, 0);
    let ok = false;
    for (let k = 0; k < 60; k++) {
      const xn = x.map((v, i) => v + t * d[i]!);
      const fn = F(xn);
      if (Number.isFinite(fn) && fn <= f0 + 1e-4 * t * slope) { ok = true; break; }
      t /= 2;
    }
    if (!ok) { diagnostics.push({ severity: 'warning', code: 'LINE_SEARCH_FAILED', message: 'Line search could not find a decrease; stopping.' }); break; }
    // for gradient descent on a quadratic use the exact step when cheap
    const xn = x.map((v, i) => v + t * d[i]!);
    x = xn;
    const grn = G(x);
    push(`Iteration ${it + 1}`, `x ← ${fmt(x)}, f = ${Number(F(x).toFixed(6))}, ‖∇f‖ = ${Number(norm(grn).toPrecision(4))}.`, `Direction d = ${fmt(d)} (${rule}); step length t = ${Number(t.toPrecision(4))} found by backtracking (Armijo) so that f decreases sufficiently.`, rule, { x: [...x], f: F(x), grad: grn, gradNorm: norm(grn), stepSize: t, direction: d, hessianPD: pd });
    if (norm(x) > 1e8 || Math.abs(F(x)) > 1e30) { unbounded = true; break; }
  }
  const fin = G(x);
  if (norm(fin) < tol) converged = true;
  const Hx = hessianAt(H, x);
  const eig = eigSym(Hx);
  const cls: UnconstrainedResult['classification'] = !converged ? 'inconclusive' : eig[0]! > 1e-9 ? 'minimum' : eig[eig.length - 1]! < -1e-9 ? 'maximum' : eig[0]! < -1e-9 && eig[eig.length - 1]! > 1e-9 ? 'saddle' : 'inconclusive';
  if (unbounded) diagnostics.push({ severity: 'warning', code: 'UNBOUNDED', message: 'The iterates run off to infinity while f keeps falling: the function appears to be unbounded below, so it has no minimum.' });
  if (!converged) diagnostics.push({ severity: 'warning', code: 'NOT_CONVERGED', message: `Stopped after ${it} iterations with ‖∇f‖ = ${Number(norm(fin).toPrecision(3))}; optimality is not claimed.` });
  push('Result', converged ? `Stationary point ${fmt(x)}: ${cls}, f = ${Number(F(x).toFixed(8))}.` : 'Not converged.', `∇f ≈ 0. Hessian eigenvalues (${eig.map(v => Number(v.toFixed(4))).join(', ')}) ${cls === 'minimum' ? 'are all positive: a strict local minimum (global if f is convex)' : cls === 'maximum' ? 'are all negative: a local maximum' : cls === 'saddle' ? 'have mixed signs: a saddle point' : 'do not settle the question'}.`, 'Second-order test', { x: [...x], f: F(x), grad: fin, gradNorm: norm(fin) }, converged ? 'optimal' : 'iteration-limit');
  return { x, f: F(x), converged, iterations: it, gradientText: g.map(gi => exprToString(gi, names)), hessianText: H.map(r => r.map(e => exprToString(e, names))), classification: cls, eigenvalues: eig, steps, diagnostics, evaluate: F };
}

/* ---------------- KKT verification ---------------- */

export interface KKTInput {
  objective: string;
  /** constraints written g(x) <= 0 as text "g" ; equalities h(x) = 0 via kind */
  constraints: { expr: string; kind: 'le' | 'eq' }[];
  point: number[];
  varNames?: string[];
  tol?: number;
}

export interface KKTResult {
  error?: string;
  feasible: boolean;
  active: number[];
  multipliers: number[] | null;
  stationarityResidual: number;
  dualFeasible: boolean;
  complementary: boolean;
  satisfied: boolean;
  messages: string[];
  gradients: string[];
}

export function checkKKT(input: KKTInput): KKTResult {
  const n = input.point.length;
  const names = input.varNames ?? Array.from({ length: n }, (_, i) => `x${i + 1}`);
  const tol = input.tol ?? 1e-6;
  const bad = (error: string): KKTResult => ({ error, feasible: false, active: [], multipliers: null, stationarityResidual: NaN, dualFeasible: false, complementary: false, satisfied: false, messages: [], gradients: [] });
  if (n < 1) return bad('Enter the point to test.');
  if (n > MAX_NLP_VARIABLES) return bad(`At most ${MAX_NLP_VARIABLES} variables are supported.`);
  if (names.length !== n) return bad(`The point has ${n} coordinates but there are ${names.length} variable names.`);
  if (!input.point.every(Number.isFinite)) return bad('Every coordinate of the point must be a finite number.');
  if (input.constraints.length > 50) return bad('At most 50 constraints are supported.');
  if (!(Number.isFinite(tol) && tol > 0)) return bad('The tolerance must be a positive number.');
  let f: Expr; let gs: { e: Expr; kind: 'le' | 'eq' }[];
  try { f = parseExpression(input.objective, names); gs = input.constraints.map(c => ({ e: parseExpression(c.expr, names), kind: c.kind })); } catch (e) { return bad((e as Error).message); }
  const x = input.point;
  const gradF = names.map((_, i) => evalExpr(diff(f, i), x));
  const vals = gs.map(g => evalExpr(g.e, x));
  const messages: string[] = [];
  const feasible = gs.every((g, i) => (g.kind === 'le' ? vals[i]! <= tol : Math.abs(vals[i]!) <= tol));
  messages.push(feasible ? 'Primal feasibility holds.' : `Primal feasibility FAILS: ${gs.map((g, i) => (g.kind === 'le' ? vals[i]! > tol : Math.abs(vals[i]!) > tol) ? `constraint ${i + 1} ${Number.isFinite(vals[i]!) ? '= ' + Number(vals[i]!.toFixed(6)) : 'is not a finite number here (division by zero or log of a non-positive value?)'}` : '').filter(Boolean).join(', ')}.`);
  const active = gs.map((g, i) => (g.kind === 'eq' || Math.abs(vals[i]!) <= tol ? i : -1)).filter(i => i >= 0);
  const J = active.map(i => names.map((_, k) => evalExpr(diff(gs[i]!.e, k), x)));
  // multipliers: ∇f + Σ λ_i ∇g_i = 0 with λ ≥ 0 on the inequalities. The constrained least-squares problem is solved exactly by
  // trying every choice of which active inequalities may carry a positive multiplier (the others are fixed at 0);
  // a ridge keeps duplicated or proportional constraints (LICQ failure) from making the system singular.
  const m = active.length;
  const lsq = (cols: number[]): { lam: number[]; res: number } => {
    const A = cols.map(a => cols.map(b => J[a]!.reduce((s, v, k) => s + v * J[b]![k]!, 0) + (a === b ? 1e-10 : 0)));
    const rhs = cols.map(a => -J[a]!.reduce((s, v, k) => s + v * gradF[k]!, 0));
    const sol = cols.length ? solve2(A, rhs) : [];
    const lam = Array(m).fill(0) as number[];
    cols.forEach((a, q) => (lam[a] = sol ? sol[q]! : 0));
    const res = Math.sqrt(gradF.reduce((s, v, k) => { const t = v + lam.reduce((q2, l, a) => q2 + l * J[a]![k]!, 0); return s + t * t; }, 0));
    return { lam, res: sol ? res : NaN };
  };
  let lam: number[] | null = [];
  let residual = Math.sqrt(gradF.reduce((s, v) => s + v * v, 0));
  let lsLam: number[] | null = null;
  if (m) {
    const eqCols = active.map((i, a) => (gs[i]!.kind === 'eq' ? a : -1)).filter(a => a >= 0);
    const ineqCols = active.map((i, a) => (gs[i]!.kind === 'le' ? a : -1)).filter(a => a >= 0);
    const full = lsq(active.map((_, a) => a));
    lsLam = full.res === full.res ? full.lam : null;
    if (ineqCols.length <= 12) {
      let best: { lam: number[]; res: number } | null = null;
      for (let mask = 0; mask < 1 << ineqCols.length; mask++) {
        const cols = [...eqCols, ...ineqCols.filter((_, q) => mask & (1 << q))];
        const cand = lsq(cols);
        if (!(cand.res === cand.res)) continue;
        if (!ineqCols.every(a => cand.lam[a]! >= -1e-9)) continue;
        if (!best || cand.res < best.res - 1e-12) best = cand;
      }
      if (best) { lam = best.lam; residual = best.res; }
      else { lam = null; messages.push('Active constraint gradients are linearly dependent (LICQ fails), so multipliers are not unique.'); }
    } else if (lsLam) { lam = lsLam; residual = full.res; } else { lam = null; messages.push('Active constraint gradients are linearly dependent (LICQ fails), so multipliers are not unique.'); }
    // when no sign-feasible multipliers reproduce the gradient but unrestricted ones do, the failure is the sign (dual feasibility)
    if (lam && residual > 1e-5 && lsLam && full.res <= 1e-5) { lam = lsLam; residual = full.res; }
  }
  const stat = residual <= 1e-5;
  messages.push(stat ? 'Stationarity ∇f + Σλᵢ∇gᵢ = 0 holds.' : `Stationarity FAILS: residual ‖∇f + Σλᵢ∇gᵢ‖ = ${Number(residual.toPrecision(3))}.`);
  const dualOk = lam !== null && active.every((i, a) => gs[i]!.kind === 'eq' || lam![a]! >= -1e-7);
  messages.push(dualOk ? 'Dual feasibility (λ ≥ 0 for inequalities) holds.' : lam === null ? 'Dual feasibility could not be established.' : `Dual feasibility FAILS: negative multiplier(s) ${active.map((i, a) => (gs[i]!.kind === 'le' && lam![a]! < -1e-7 ? `λ${i + 1}=${Number(lam![a]!.toFixed(5))}` : '')).filter(Boolean).join(', ')} (for a minimisation).`);
  const comp = gs.every((g, i) => g.kind === 'eq' || Math.abs(vals[i]!) <= tol || (lam === null) || !active.includes(i));
  messages.push('Complementary slackness holds (inactive constraints have λ = 0).');
  const satisfied = feasible && stat && dualOk && comp;
  messages.push(satisfied ? 'KKT conditions are satisfied: the point is a candidate minimum (sufficient if the problem is convex).' : 'KKT conditions are NOT satisfied: the point is not a (regular) local minimum.');
  return { feasible, active, multipliers: lam, stationarityResidual: residual, dualFeasible: dualOk, complementary: comp, satisfied, messages, gradients: names.map((_, i) => exprToString(diff(f, i), names)) };
}

/* ---------------- exact quadratic programming ---------------- */

export interface QPModel {
  /** minimise ½ xᵀQx + cᵀx subject to A x ≤ b, x ≥ 0 (Q symmetric) */
  Q: Rational[][];
  c: Rational[];
  A: Rational[][];
  b: Rational[];
  varNames?: string[];
}

export interface QPResult {
  error?: string;
  x: Rational[];
  objective: Rational;
  multipliers: Rational[];   // for rows of A
  boundMultipliers: Rational[]; // for x ≥ 0
  activeSet: string[];
  convex: boolean;
  examined: number;
  explanation: string;
}

function solveRational(A: Rational[][], b: Rational[]): Rational[] | null {
  const n = A.length;
  const M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c; while (p < n && M[p]![c]!.isZero()) p++;
    if (p === n) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const inv = M[c]![c]!.inv();
    M[c] = M[c]!.map(v => v.mul(inv));
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r]![c]!; if (!f.isZero()) M[r] = M[r]!.map((v, k) => v.sub(f.mul(M[c]![k]!))); }
  }
  return M.map(r => r[n]!);
}

export function solveQP(input: QPModel): QPResult { return solveQPCore(input, false); }

/** `homogeneous` is set for the internal recession-direction search, which must not recurse and has no size limits of its own. */
function solveQPCore(input: QPModel, homogeneous: boolean): QPResult {
  let model = input;
  const n = model.c.length;
  const m = model.A.length;
  const names = model.varNames ?? Array.from({ length: n }, (_, i) => `x${i + 1}`);
  const fail = (error: string): QPResult => ({ error, x: [], objective: Rational.ZERO, multipliers: [], boundMultipliers: [], activeSet: [], convex: false, examined: 0, explanation: '' });
  if (n < 1) return fail('Enter at least one variable.');
  if (!homogeneous && (n > 6 || m > 8)) return fail('The exact active-set solver handles up to 6 variables and 8 constraints.');
  if (model.Q.length !== n || model.Q.some(r => r.length !== n)) return fail(`The Q matrix must be ${n} × ${n} (one row and column per variable).`);
  if (model.b.length !== m || model.A.some(r => r.length !== n)) return fail(`Every constraint needs ${n} coefficients and a right-hand side.`);
  // xᵀQx only sees the symmetric part of Q; work with it so the KKT conditions Qx + c + … = 0 are correct
  const Qs = model.Q.map((r, i) => r.map((v, j) => v.add(model.Q[j]![i]!).div(Rational.of(2))));
  model = { ...model, Q: Qs };
  // convexity: all principal minors ≥ 0 (PSD) via LDLᵀ-style check on eigen-free test: Sylvester on all principal minors
  const det = (M: Rational[][]): Rational => { const k = M.length; if (k === 0) return Rational.ONE; if (k === 1) return M[0]![0]!; let d = Rational.ZERO; for (let j = 0; j < k; j++) { const minor = M.slice(1).map(r => r.filter((_, c) => c !== j)); const term = M[0]![j]!.mul(det(minor)); d = j % 2 === 0 ? d.add(term) : d.sub(term); } return d; };
  let convex = true;
  const idx = Array.from({ length: n }, (_, i) => i);
  const subsets = (arr: number[]): number[][] => (arr.length === 0 ? [[]] : subsets(arr.slice(1)).flatMap(s => [s, [arr[0]!, ...s]]));
  for (const s of subsets(idx)) if (s.length && det(s.map(i => s.map(j => model.Q[i]![j]!))).isNegative()) { convex = false; break; }
  // enumerate active sets over constraints (m rows + n bounds)
  const total = m + n;
  let best: { x: Rational[]; obj: Rational; lam: Rational[]; act: number[] } | null = null;
  let examined = 0;
  for (let mask = 0; mask < 1 << total; mask++) {
    const act: number[] = [];
    for (let k = 0; k < total; k++) if (mask & (1 << k)) act.push(k);
    if (act.length > n) continue;
    examined++;
    // KKT system: Q x + c + Σ μ_k a_k = 0 ; a_k·x = rhs_k for active k   (constraints written a·x ≤ rhs, bounds −x_j ≤ 0)
    const rowOf = (k: number): { a: Rational[]; r: Rational } => (k < m ? { a: model.A[k]!, r: model.b[k]! } : { a: idx.map(j => (j === k - m ? Rational.MINUS_ONE : Rational.ZERO)), r: Rational.ZERO });
    const dim = n + act.length;
    const K: Rational[][] = Array.from({ length: dim }, () => Array(dim).fill(Rational.ZERO));
    const rhs: Rational[] = Array(dim).fill(Rational.ZERO);
    for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) K[i]![j] = model.Q[i]![j]!; rhs[i] = model.c[i]!.neg(); }
    act.forEach((k, a) => { const { a: row, r } = rowOf(k); for (let j = 0; j < n; j++) { K[n + a]![j] = row[j]!; K[j]![n + a] = row[j]!; } rhs[n + a] = r; });
    const sol = solveRational(K, rhs);
    if (!sol) continue;
    const x = sol.slice(0, n);
    const mu = sol.slice(n);
    if (mu.some(v => v.isNegative())) continue; // multipliers of ≤ constraints in a minimisation must be ≥ 0 (sign: Qx + c + Σμ a = 0 ⇒ μ ≥ 0)
    let feas = x.every(v => !v.isNegative());
    for (let i = 0; feas && i < m; i++) { const lhs = model.A[i]!.reduce((s, v, j) => s.add(v.mul(x[j]!)), Rational.ZERO); if (lhs.gt(model.b[i]!)) feas = false; }
    if (!feas) continue;
    let obj = Rational.ZERO;
    for (let i = 0; i < n; i++) { obj = obj.add(model.c[i]!.mul(x[i]!)); for (let j = 0; j < n; j++) obj = obj.add(Rational.of(1, 2).mul(x[i]!.mul(model.Q[i]![j]!).mul(x[j]!))); }
    if (!best || obj.lt(best.obj)) best = { x, obj, lam: mu, act };
    if (convex) { /* KKT point of a convex QP is global: first hit suffices */ break; }
  }
  if (!best) {
    // a polyhedron {x ≥ 0, Ax ≤ b} has a vertex iff it is non-empty, so a vertex search separates "infeasible" from "unbounded"
    let feasible = false;
    for (let mask = 0; mask < 1 << total && !feasible; mask++) {
      const act: number[] = [];
      for (let k = 0; k < total; k++) if (mask & (1 << k)) act.push(k);
      if (act.length !== n) continue;
      const rows = act.map(k => (k < m ? model.A[k]! : idx.map(j => (j === k - m ? Rational.MINUS_ONE : Rational.ZERO))));
      const rhsV = act.map(k => (k < m ? model.b[k]! : Rational.ZERO));
      const v = solveRational(rows, rhsV);
      if (!v || v.some(x => x.isNegative())) continue;
      if (model.A.every((row, i) => row.reduce((s, c, j) => s.add(c.mul(v[j]!)), Rational.ZERO).lte(model.b[i]!))) feasible = true;
    }
    if (!n) feasible = true;
    return { ...fail(feasible
      ? `The objective is unbounded below on the feasible region${convex ? '' : ' (the objective is not convex)'}: no minimum exists.`
      : 'The problem is infeasible: no point satisfies every constraint together with x ≥ 0.'), convex };
  }
  if (!convex && !homogeneous) {
    // a non-convex objective can still fall without limit along a recession direction d (d ≥ 0, A d ≤ 0, dᵀQd < 0) even though KKT points exist;
    // minimise ½dᵀQd over the normalised cone {Σd = 1} (a bounded problem, so its best KKT point is its global minimum)
    const ones = Array(n).fill(Rational.ONE) as Rational[];
    const cone = solveQPCore({ Q: model.Q, c: Array(n).fill(Rational.ZERO) as Rational[], A: [...model.A, ones, ones.map(v => v.neg())], b: [...(Array(m).fill(Rational.ZERO) as Rational[]), Rational.ONE, Rational.MINUS_ONE] }, true);
    if (!cone.error && cone.objective.isNegative()) {
      return { ...fail(`The objective is unbounded below on the feasible region (it is not convex and decreases without limit along the direction (${cone.x.map(v => v.toString()).join(', ')})): no minimum exists.`), convex };
    }
  }
  // recover which constraints are active
  const actNames: string[] = [];
  const mults: Rational[] = Array(m).fill(Rational.ZERO), bm: Rational[] = Array(n).fill(Rational.ZERO);
  best.act.forEach((k, a) => { if (k < m) mults[k] = best!.lam[a]!; else bm[k - m] = best!.lam[a]!; });
  {
    // recompute active set from best.x
    for (let i = 0; i < m; i++) { const lhs = model.A[i]!.reduce((s, v, j) => s.add(v.mul(best!.x[j]!)), Rational.ZERO); if (lhs.eq(model.b[i]!)) actNames.push(`constraint ${i + 1}`); }
    best.x.forEach((v, j) => { if (v.isZero()) actNames.push(`${names[j]} = 0`); });
  }
  return { x: best.x, objective: best.obj, multipliers: mults, boundMultipliers: bm, activeSet: actNames, convex, examined, explanation: `${convex ? 'The objective is convex, so any KKT point is the global minimum.' : 'The objective is NOT convex; the best KKT point found is reported (a global optimum is not guaranteed).'} ${examined} active sets were examined; at the optimum the active constraints are: ${actNames.join(', ') || 'none'}.` };
}
