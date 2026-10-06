/**
 * Algebraic text parser for linear programmes (spec §11.4).
 *
 * Accepts natural notation:
 *
 *     max z = 3x1 + 5x2
 *     subject to
 *       labour:  x1 <= 4
 *       2x2 ≤ 12
 *       3x1 + 2x2 <= 18
 *       x1, x2 >= 0
 *       int x1
 *       x3 free
 *
 * Tolerates: max/maximize/maximise/min…, st / s.t. / subject to / such that, <= ≤ =< < >= ≥ => > = ==,
 * implicit coefficients, * · ×, fractions (1/2, (1/2)x), decimals, unicode subscripts and minus,
 * variables on both sides, constants on the left, chained a <= expr <= b, blank lines and comments (// #).
 * Errors carry an exact line and column.
 */

import { Rational } from '../math/rational';
import { LPModel, Constraint, Relation, VarType, Bound } from '../types/models';
import { canonVarName as baseCanonVarName, unsubscript } from '../format';

/** "x_1", "x1" and "x₁" all name the same variable. */
const canonVarName = (name: string): string => baseCanonVarName(name.replace(/^([A-Za-z])_(\d+)$/, '$1$2'));

export interface ParseError {
  line: number;
  col: number;
  message: string;
}

export interface ParseResult {
  success: boolean;
  model?: LPModel;
  error?: ParseError;
  warnings?: { line: number; col: number; message: string }[];
}

interface LinearExpr {
  coeffs: Map<string, Rational>;
  constant: Rational;
}

class ParseFailure extends Error {
  constructor(public line: number, public col: number, message: string) {
    super(message);
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_₀-₉]/;
const RESERVED = new Set(['st', 'subject', 'to', 'max', 'min', 'maximize', 'minimize', 'maximise', 'minimise', 'int', 'integer', 'bin', 'binary', 'free', 'unrestricted', 'urs', 'such', 'that', 'and']);

const REL_RE = /(<=|>=|=<|=>|==|≤|≥|<|>|=)/;

function normRel(s: string): Relation {
  if (s === '<=' || s === '=<' || s === '≤' || s === '<') return '<=';
  if (s === '>=' || s === '=>' || s === '≥' || s === '>') return '>=';
  return '=';
}

/** Parse a linear expression; `text` starts at absolute column `col0` of line `line`. */
function parseExpr(text: string, line: number, col0: number): LinearExpr {
  const coeffs = new Map<string, Rational>();
  let constant = Rational.ZERO;
  let i = 0;
  const n = text.length;
  const col = (k: number) => col0 + k;
  const skipWs = () => { while (i < n && /\s/.test(text[i]!)) i++; };

  const readNumber = (): Rational | null => {
    const start = i;
    if (text[i] === '(') {
      // parenthesised number / fraction
      const close = text.indexOf(')', i);
      if (close < 0) throw new ParseFailure(line, col(i), "Missing closing ')'.");
      const inner = text.slice(i + 1, close).trim();
      try {
        const v = Rational.parse(inner.replace(/\s+/g, '').replace('−', '-'));
        i = close + 1;
        return v;
      } catch {
        throw new ParseFailure(line, col(i), `Cannot read "(${inner})" as a number or fraction.`);
      }
    }
    while (i < n && /[0-9]/.test(text[i]!)) i++;
    if (text[i] === '.' && /[0-9]/.test(text[i + 1] ?? '')) {
      i++;
      while (i < n && /[0-9]/.test(text[i]!)) i++;
    } else if (text[i] === '.' && i > start) {
      i++; // "3." style
    }
    if (i === start) return null;
    let numStr = text.slice(start, i);
    // fraction a/b (digits only after slash) — but not when '/' is followed by a variable
    if (text[i] === '/' && /[0-9]/.test(text[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(text[j]!)) j++;
      numStr = text.slice(start, j);
      i = j;
    }
    try {
      return Rational.parse(numStr);
    } catch {
      throw new ParseFailure(line, col(start), `Cannot read "${numStr}" as a number.`);
    }
  };

  const readIdent = (): string | null => {
    if (i < n && IDENT_START.test(text[i]!)) {
      const s = i;
      i++;
      while (i < n && IDENT_PART.test(text[i]!)) i++;
      return text.slice(s, i);
    }
    return null;
  };

  skipWs();
  if (i >= n) throw new ParseFailure(line, col0, 'Expected an expression here.');

  while (true) {
    skipWs();
    let sign = 1;
    let sawSign = false;
    while (i < n && (text[i] === '+' || text[i] === '-' || text[i] === '−')) {
      if (text[i] !== '+') sign = -sign;
      sawSign = true;
      i++;
      skipWs();
    }
    void sawSign;
    if (i >= n) throw new ParseFailure(line, col(Math.max(0, n - 1)), 'The expression ends with an operator — a term is missing.');

    const startTerm = i;
    let num = readNumber();
    skipWs();
    if (i < n && (text[i] === '*' || text[i] === '·' || text[i] === '×')) { i++; skipWs(); }
    const ident = readIdent();
    if (num === null && ident === null) {
      const bad = text[startTerm] ?? text[i] ?? '';
      throw new ParseFailure(line, col(startTerm), `Unexpected "${bad}" — expected a number or a variable name.`);
    }
    if (ident !== null) {
      const lower = unsubscript(ident).toLowerCase();
      if (RESERVED.has(lower)) {
        throw new ParseFailure(line, col(startTerm), `"${ident}" is a reserved word and cannot be used as a variable name.`);
      }
      const name = canonVarName(ident);
      const coef = (num ?? Rational.ONE).mul(Rational.of(sign));
      coeffs.set(name, (coeffs.get(name) ?? Rational.ZERO).add(coef));
    } else {
      constant = constant.add(num!.mul(Rational.of(sign)));
    }
    num = null;

    skipWs();
    if (i >= n) break;
    if (text[i] === '+' || text[i] === '-' || text[i] === '−') continue;
    throw new ParseFailure(line, col(i), `Unexpected "${text[i]}" — terms must be separated by + or −.`);
  }
  return { coeffs, constant };
}

interface LogicalLine {
  text: string;
  line: number; // 1-based
  col0: number; // 1-based column of text[0]
}

function splitNames(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

export class AlgebraicParser {
  static parse(input: string): ParseResult {
    try {
      return AlgebraicParser.parseInner(input);
    } catch (e) {
      if (e instanceof ParseFailure) {
        return { success: false, error: { line: e.line, col: e.col, message: e.message } };
      }
      return { success: false, error: { line: 1, col: 1, message: e instanceof Error ? e.message : 'Unknown parse error' } };
    }
  }

  private static parseInner(input: string): ParseResult {
    const warnings: NonNullable<ParseResult['warnings']> = [];
    if (input.length > 1_000_000) throw new ParseFailure(1, 1, 'The model text is too long (limit 1,000,000 characters).');
    const raw = input.replace(/\r/g, '').split('\n');
    raw.forEach((ln, idx) => { if (ln.length > 200_000) throw new ParseFailure(idx + 1, 1, 'This line is too long (limit 200,000 characters).'); });
    const lines: LogicalLine[] = [];
    raw.forEach((ln, idx) => {
      let t = ln;
      const cut = Math.min(...['//', '#'].map(c => (t.indexOf(c) < 0 ? Infinity : t.indexOf(c))));
      if (Number.isFinite(cut)) t = t.slice(0, cut);
      const lead = t.length - t.trimStart().length;
      const trimmed = t.trim();
      if (trimmed) lines.push({ text: trimmed, line: idx + 1, col0: lead + 1 });
    });
    if (lines.length === 0) throw new ParseFailure(1, 1, 'The model is empty. Start with "max" or "min" followed by the objective function.');

    // ---------- objective ----------
    const first = lines[0]!;
    const objMatch = first.text.match(/^(maximi[sz]e|minimi[sz]e|max|min)\b\s*:?\s*/i);
    if (!objMatch) {
      throw new ParseFailure(first.line, first.col0, 'The first line must start with "max" or "min" (or maximize / minimize) followed by the objective, e.g. "max 3x1 + 5x2".');
    }
    const sense: 'max' | 'min' = objMatch[1]!.toLowerCase().startsWith('max') ? 'max' : 'min';
    let objText = first.text.slice(objMatch[0].length);
    let objCol = first.col0 + objMatch[0].length;
    const lab = objText.match(/^([A-Za-z_]\w*)\s*=\s*/);
    if (lab && !/^(<|>)/.test(objText.slice(lab[0].length))) {
      objText = objText.slice(lab[0].length);
      objCol += lab[0].length;
    }
    if (!objText.trim()) throw new ParseFailure(first.line, first.col0 + first.text.length, 'The objective function is missing after "max"/"min".');
    if (REL_RE.test(objText)) {
      const rm = objText.match(REL_RE)!;
      throw new ParseFailure(first.line, objCol + rm.index!, 'The objective is an expression, not an equation or inequality — remove the relation sign.');
    }
    const objExpr = parseExpr(objText, first.line, objCol);

    // ---------- the rest ----------
    const varOrder: string[] = [];
    const seen = new Set<string>();
    const note = (name: string) => { if (!seen.has(name)) { seen.add(name); varOrder.push(name); } };
    for (const k of objExpr.coeffs.keys()) note(k);

    interface RawCon { lhs: LinearExpr; rel: Relation; rhsConst: Rational; name?: string; line: number }
    const rawCons: RawCon[] = [];
    const freeNames = new Set<string>();
    const intNames = new Set<string>();
    const binNames = new Set<string>();
    const nonnegNames = new Set<string>();

    let idx = 1;
    // optional "subject to" header line (own line)
    if (idx < lines.length) {
      const l = lines[idx]!;
      const hm = l.text.match(/^(subject\s+to|such\s+that|s\.t\.|st)(?=\s|:|$)\s*:?\s*/i);
      if (hm) {
        const restText = l.text.slice(hm[0].length);
        if (restText) lines[idx] = { text: restText, line: l.line, col0: l.col0 + hm[0].length };
        else idx++;
      }
    }

    for (; idx < lines.length; idx++) {
      let ln = lines[idx]!;
      // Declarations
      const decl = ln.text.match(/^(int|integers?|bin|binary|free|unrestricted|urs|nonneg|nonnegative)\b\s*:?\s*(.*)$/i);
      if (decl && !REL_RE.test(ln.text)) {
        const kind = decl[1]!.toLowerCase();
        const names = splitNames(decl[2]!);
        if (names.length === 0) throw new ParseFailure(ln.line, ln.col0 + decl[1]!.length, `"${decl[1]}" must be followed by one or more variable names.`);
        for (const nm of names) {
          if (!IDENT_START.test(nm[0]!)) throw new ParseFailure(ln.line, ln.col0, `"${nm}" is not a valid variable name.`);
          const c = canonVarName(nm);
          note(c);
          if (kind.startsWith('int')) intNames.add(c);
          else if (kind.startsWith('bin')) binNames.add(c);
          else if (kind.startsWith('non')) nonnegNames.add(c);
          else freeNames.add(c);
        }
        continue;
      }
      const suffix = /\s(free|unrestricted|urs|integer|int|binary|bin)$/i.exec(ln.text); // linear scan (no nested quantifiers)
      if (suffix && !REL_RE.test(ln.text)) {
        const kind = suffix[1]!.toLowerCase();
        for (const nm of splitNames(ln.text.slice(0, suffix.index))) {
          const c = canonVarName(nm);
          note(c);
          if (kind.startsWith('int')) intNames.add(c);
          else if (kind.startsWith('bin')) binNames.add(c);
          else freeNames.add(c);
        }
        continue;
      }

      // Optional label "name:" (but not keywords like st:)
      let label: string | undefined;
      const lm = ln.text.match(/^([A-Za-z_][\w ]*):\s*(.*)$/);
      if (lm && !/^(st|s\.t\.|subject to)$/i.test(lm[1]!)) {
        label = lm[1]!.trim();
        ln = { text: lm[2]!, line: ln.line, col0: ln.col0 + (ln.text.length - lm[2]!.length) };
      }
      if (!ln.text) throw new ParseFailure(ln.line, ln.col0, 'Empty constraint.');

      // Split on relations (supports chained a <= expr <= b)
      const segs: { text: string; col: number }[] = [];
      const ops: string[] = [];
      {
        const re = new RegExp(REL_RE.source, 'g');
        let last = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(ln.text)) !== null) {
          segs.push({ text: ln.text.slice(last, m.index), col: ln.col0 + last });
          ops.push(m[0]);
          last = m.index + m[0].length;
        }
        segs.push({ text: ln.text.slice(last), col: ln.col0 + last });
      }
      if (ops.length === 0) {
        throw new ParseFailure(ln.line, ln.col0, `No relation found in "${ln.text}". Use <=, >= or = (for example "x1 + x2 <= 10").`);
      }
      for (const op of ops) if (op === '<' || op === '>') {
        warnings.push({ line: ln.line, col: ln.col0, message: `Strict inequality "${op}" is treated as "${op}=" (linear programmes cannot represent strict inequalities).` });
      }
      for (let k = 0; k < segs.length; k++) {
        if (!segs[k]!.text.trim()) {
          throw new ParseFailure(ln.line, segs[k]!.col + (k === 0 ? 0 : 0), k === segs.length - 1 ? 'The right-hand side of the relation is missing.' : 'The left-hand side of the relation is missing.');
        }
      }

      // "x1, x2 >= 0" style list declaration
      if (ops.length === 1 && /,/.test(segs[0]!.text) && !/[+\-−*]/.test(segs[0]!.text.replace(/\s/g, ''))) {
        const names = splitNames(segs[0]!.text);
        const rhsE = parseExpr(segs[1]!.text, ln.line, segs[1]!.col);
        if (rhsE.coeffs.size > 0) throw new ParseFailure(ln.line, segs[1]!.col, 'A variable list must be compared with a plain number, e.g. "x1, x2 >= 0".');
        const rel = normRel(ops[0]!);
        for (const nm of names) {
          const c = canonVarName(nm);
          note(c);
          if (rel === '>=' && rhsE.constant.isZero()) { nonnegNames.add(c); continue; }
          rawCons.push({ lhs: { coeffs: new Map([[c, Rational.ONE]]), constant: Rational.ZERO }, rel, rhsConst: rhsE.constant, line: ln.line });
        }
        continue;
      }

      const exprs = segs.map(s => parseExpr(s.text, ln.line, s.col));
      for (let k = 0; k < ops.length; k++) {
        let L = exprs[k]!;
        let R = exprs[k + 1]!;
        let opK = ops[k]!;
        if (L.coeffs.size === 0 && R.coeffs.size > 0) {
          // "1 <= x + y": read as "x + y >= 1" so the variables stay on the left.
          [L, R] = [R, L];
          const nr = normRel(opK);
          opK = nr === '<=' ? '>=' : nr === '>=' ? '<=' : '=';
        }
        // "x1 >= 0" / "0 <= x1": plain non-negativity declaration, not a constraint row.
        const single = (e: LinearExpr) => e.coeffs.size === 1 && e.constant.isZero() && [...e.coeffs.values()][0]!.eq(Rational.ONE);
        const zero = (e: LinearExpr) => e.coeffs.size === 0 && e.constant.isZero();
        const rl = normRel(opK);
        if ((rl === '>=' && single(L) && zero(R)) || (rl === '<=' && zero(L) && single(R))) {
          const nm = [...(single(L) ? L : R).coeffs.keys()][0]!;
          note(nm);
          nonnegNames.add(nm);
          continue;
        }
        const coeffs = new Map<string, Rational>();
        for (const [nm, v] of L.coeffs) coeffs.set(nm, (coeffs.get(nm) ?? Rational.ZERO).add(v));
        for (const [nm, v] of R.coeffs) coeffs.set(nm, (coeffs.get(nm) ?? Rational.ZERO).sub(v));
        const rhs = R.constant.sub(L.constant);
        for (const nm of coeffs.keys()) note(nm);
        let relS = normRel(opK);
        // For chained forms the same expression is the middle term; relation direction is as written.
        const allZero = [...coeffs.values()].every(v => v.isZero());
        if (allZero) {
          // 0 rel c: keep (infeasible / trivial) so the solver reports it, but warn.
          warnings.push({ line: ln.line, col: ln.col0, message: 'This constraint contains no variables; it is either always true or always false.' });
        }
        rawCons.push({ lhs: { coeffs, constant: Rational.ZERO }, rel: relS, rhsConst: rhs, name: label, line: ln.line });
        relS = relS; // eslint placeholder
      }
    }

    // ---------- assemble ----------
    const varNames = varOrder;
    if (varNames.length === 0) {
      throw new ParseFailure(first.line, first.col0, 'No variables found. The objective needs at least one variable such as x1.');
    }
    const objective = varNames.map(v => objExpr.coeffs.get(v) ?? Rational.ZERO);
    const constraints: Constraint[] = rawCons.map(rc => ({
      coeffs: varNames.map(v => rc.lhs.coeffs.get(v) ?? Rational.ZERO),
      relation: rc.rel,
      rhs: rc.rhsConst,
      name: rc.name,
    }));

    const model: LPModel = { sense, objective, constraints, varNames };
    if (!objExpr.constant.isZero()) model.objectiveConstant = objExpr.constant;

    const anyFree = freeNames.size > 0;
    const anyBin = binNames.size > 0;
    if (anyFree || anyBin) {
      model.varBounds = varNames.map((v): Bound => {
        if (binNames.has(v)) return { lower: Rational.ZERO, upper: Rational.ONE };
        if (freeNames.has(v)) return { lower: null, upper: null };
        return { lower: Rational.ZERO, upper: null };
      });
    }
    if (intNames.size > 0 || anyBin) {
      model.integrality = varNames.map((v): VarType => (binNames.has(v) ? 'binary' : intNames.has(v) ? 'integer' : 'continuous'));
    }
    for (const f of freeNames) if (nonnegNames.has(f) && !binNames.has(f)) {
      warnings.push({ line: 1, col: 1, message: `${f} is declared both free and non-negative; free wins.` });
    }
    // variables that never appear in a constraint nor objective with a coefficient
    const usedInCon = varNames.map((_, k) => constraints.some(c => !c.coeffs[k]!.isZero()));
    for (const [k, v] of varNames.entries()) {
      const inObj = !(objExpr.coeffs.get(v) ?? Rational.ZERO).isZero();
      const inCon = usedInCon[k]!;
      if (!inObj && !inCon) warnings.push({ line: 1, col: 1, message: `Variable ${v} has no effect on the model.` });
    }
    return { success: true, model, warnings: warnings.length ? warnings : undefined };
  }
}

/* ------------------------------------------------------------------ */
/* Serialiser — LPModel → text (used by Form ⇄ Text sync and export)    */
/* ------------------------------------------------------------------ */

function fmtCoef(c: Rational): string {
  return c.isInteger() ? c.abs().toString() : `(${c.abs().toString()})`;
}

export function formatLinear(coeffs: Rational[], names: string[]): string {
  const parts: string[] = [];
  coeffs.forEach((c, j) => {
    if (c.isZero()) return;
    const neg = c.isNegative();
    const mag = c.abs();
    const body = mag.eq(Rational.ONE) ? names[j]! : `${fmtCoef(mag)}${names[j]!}`;
    if (parts.length === 0) parts.push(neg ? `-${body}` : body);
    else parts.push(neg ? `- ${body}` : `+ ${body}`);
  });
  return parts.length ? parts.join(' ') : '0';
}

export function formatLP(model: LPModel): string {
  const lines: string[] = [];
  const names = model.varNames;
  // Variables are numbered by first appearance when the text is parsed again; keep the order stable by naming every
  // variable in the objective (with a 0 coefficient) whenever the natural order of appearance would differ.
  const firstSeen: string[] = [];
  const see = (j: number) => { if (!firstSeen.includes(names[j]!)) firstSeen.push(names[j]!); };
  model.objective.forEach((c, j) => { if (!c.isZero()) see(j); });
  model.constraints.forEach(c => c.coeffs.forEach((a, j) => { if (!a.isZero()) see(j); }));
  const needsOrder = firstSeen.length !== names.length || firstSeen.some((nm, k) => nm !== names[k]);
  let obj: string;
  if (needsOrder) {
    obj = names.map((nm, j) => {
      const c = model.objective[j] ?? Rational.ZERO;
      const mag = c.abs();
      const body = c.isZero() ? `0${nm}` : mag.eq(Rational.ONE) ? nm : `${fmtCoef(mag)}${nm}`;
      return { neg: c.isNegative(), body };
    }).reduce((acc, t, k) => (k === 0 ? (t.neg ? `-${t.body}` : t.body) : `${acc} ${t.neg ? '-' : '+'} ${t.body}`), '');
  } else {
    obj = formatLinear(model.objective, names);
  }
  if (model.objectiveConstant && !model.objectiveConstant.isZero()) {
    const k = model.objectiveConstant;
    obj += k.isNegative() ? ` - ${k.abs().toString()}` : ` + ${k.toString()}`;
  }
  lines.push(`${model.sense} ${obj}`);
  lines.push('subject to');
  const labelOk = (nm: string) => /^[A-Za-z_][\w ]*$/.test(nm) && !/^(st|s\.t\.|subject to)$/i.test(nm.trim());
  for (const c of model.constraints) {
    const rel = c.relation === '<=' ? '<=' : c.relation === '>=' ? '>=' : '=';
    lines.push(`  ${c.name && labelOk(c.name) ? c.name.trim() + ': ' : ''}${formatLinear(c.coeffs, names)} ${rel} ${c.rhs.toString()}`);
  }
  const bounds = (j: number) => model.varBounds?.[j];
  const isBin = (j: number) => model.integrality?.[j] === 'binary';
  // The text format has no negative-lower-bound declaration: such a variable is declared free and bounded by a row.
  const isFree = (j: number) => !isBin(j) && !!bounds(j) && (bounds(j)!.lower === null || bounds(j)!.lower!.isNegative());
  const free = names.filter((_, j) => isFree(j));
  const nonneg = names.filter((_, j) => !isFree(j));
  if (nonneg.length) lines.push(`  ${nonneg.join(', ')} >= 0`);
  if (free.length) lines.push(`  free ${free.join(', ')}`);
  // Non-trivial bounds become ordinary rows (equivalent to a bound, and understood by the parser).
  names.forEach((nm, j) => {
    const b = bounds(j);
    if (!b || isBin(j)) return;
    if (b.lower !== null && !b.lower.isZero()) lines.push(`  ${nm} >= ${b.lower.toString()}`);
    if (b.upper !== null) lines.push(`  ${nm} <= ${b.upper.toString()}`);
  });
  const ints = names.filter((_, j) => model.integrality?.[j] === 'integer');
  const bins = names.filter((_, j) => model.integrality?.[j] === 'binary');
  if (ints.length) lines.push(`  int ${ints.join(', ')}`);
  if (bins.length) lines.push(`  bin ${bins.join(', ')}`);
  return lines.join('\n');
}
