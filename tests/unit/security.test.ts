import { describe, it, expect } from 'vitest';
import LZ from 'lz-string';
import { decodeShared, normalizeSaved, safeParseJSON, exceedsDepth, slug, MAX_SHARE_CHARS } from '../../src/lib/persist';
import { reportToLaTeX, reportToHTML, safeTexMath, verbatimSafe, cleanSvg, csvCell, reportToCSV, esc, type Report } from '../../src/lib/report';
import { compileExpression } from '../../src/core/solvers/simulation/random';
import { parseExpression } from '../../src/core/solvers/nlp/nlp';
import { AlgebraicParser } from '../../src/core/parse/algebraic';

const enc = (o: unknown) => LZ.compressToEncodedURIComponent(typeof o === 'string' ? o : JSON.stringify(o));
const base = { version: '1.0', moduleId: 'lp', model: { a: 1 }, meta: { title: 'T', createdAt: '' } };

describe('share link decoding', () => {
  it('accepts a normal payload', () => { expect(decodeShared(enc(base))?.moduleId).toBe('lp'); });
  it('rejects garbage, null and wrong module', () => {
    expect(decodeShared(null)).toBeNull();
    expect(decodeShared('!!!notlz')).toBeNull();
    expect(decodeShared(enc({ ...base, moduleId: 'nope' }))).toBeNull();
    expect(decodeShared(enc('[1,2,3]'))).toBeNull();
    expect(decodeShared(enc({ ...base, model: 'str' }))).toBeNull();
  });
  it('drops prototype-polluting keys', () => {
    const m = decodeShared(enc('{"moduleId":"lp","model":{"__proto__":{"polluted":1},"constructor":{"x":1},"ok":2},"meta":{"title":"x"}}'))!;
    expect(Object.keys(m.model as object)).toEqual(['ok']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('coerces non-string metadata', () => {
    const m = decodeShared(enc({ ...base, meta: { title: { a: 1 }, createdAt: 5, notes: [] }, variant: 7 }))!;
    expect(typeof m.meta.title).toBe('string');
    expect(m.meta.createdAt).toBe('');
    expect(m.meta.notes).toBeUndefined();
    expect(m.variant).toBeUndefined();
  });
  it('refuses oversized payloads without decompressing', () => {
    expect(decodeShared('A'.repeat(MAX_SHARE_CHARS + 1))).toBeNull();
  });
  it('refuses very deeply nested models', () => {
    let o: unknown = { v: 1 };
    for (let i = 0; i < 200; i++) o = { n: o };
    expect(decodeShared(enc({ ...base, model: o }))).toBeNull();
    expect(exceedsDepth(o)).toBe(true);
  });
  it('a high-ratio payload under the cap stays cheap', () => {
    const e = enc('{"moduleId":"lp","model":{"x":"' + 'a'.repeat(400_000) + '"},"meta":{}}');
    const t = Date.now();
    decodeShared(e);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('saved model validation', () => {
  it('normalizeSaved never throws on hostile values', () => {
    for (const v of [undefined, null, 1, 'x', [], { moduleId: 5 }, { moduleId: 'lp' }, { moduleId: 'lp', model: null }]) expect(normalizeSaved(v)).toBeNull();
  });
  it('safeParseJSON strips unsafe keys', () => {
    expect(JSON.stringify(safeParseJSON('{"a":{"__proto__":1,"b":2}}'))).toBe('{"a":{"b":2}}');
  });
  it('slug is a safe, bounded file name', () => {
    const s = slug('../../etc/passwd\u0000 <script>' + 'x'.repeat(500));
    expect(s).toMatch(/^[a-z0-9_]+$/);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(slug('')).toBe('model');
  });
});

const rep = (over: Partial<Report> = {}): Report => ({ title: 't', module: 'm', problem: 'p', steps: [], result: { heading: 'h', lines: [] }, diagnostics: [], ...over });

describe('LaTeX export', () => {
  it('cannot close the verbatim block', () => {
    const out = reportToLaTeX(rep({ problem: 'x\n\\end{verbatim}\\input{/etc/passwd}' }));
    expect(out).not.toMatch(/\\end\{verbatim\}\\input/);
    expect(verbatimSafe('\\end{verbatim}')).not.toContain('\\end{verbatim}');
    expect(out.split('\\end{verbatim}').length).toBe(2);
  });
  it('typesets dangerous formulas as plain text', () => {
    for (const f of ['\\input{/etc/passwd}', '\\write18{id}', '\\immediate\\write18{id}', '\\catcode`\\%=12', '\\def\\x{y}', '\\x\\end{document}'])
      expect(safeTexMath(f)).toMatch(/^\\text\{/);
    expect(safeTexMath('\\frac{1}{2} + \\rho')).toBe('\\frac{1}{2} + \\rho');
    expect(safeTexMath('50% off $x$')).toBe('50\\% off \\$x\\$');
  });
  it('escapes control characters in text fields', () => {
    const out = reportToLaTeX(rep({ title: '\\input{x} \\write18{y} %', steps: [{ title: '\\def', short: '${}#_' }] }));
    expect(out).not.toMatch(/(^|[^\\])\\input\{x\}/);
    expect(out).not.toContain('\\write18{y}');
  });
});

describe('HTML export', () => {
  it('escapes every text field and ships a script-less CSP', () => {
    const bad = '<img src=x onerror=alert(1)>"\'';
    const html = reportToHTML(rep({ title: bad, module: bad, method: bad, problem: bad, steps: [{ title: bad, short: bad, detailed: bad, rule: bad, note: bad, table: { caption: bad, headers: [bad], rows: [[bad, bad]] } }], result: { heading: bad, lines: [bad] }, diagnostics: [bad] }));
    expect(html).not.toContain('<img');
    expect(html).toContain("Content-Security-Policy");
    expect(html).toMatch(/default-src 'none'/);
  });
  it('closes </style> and script breakouts through the title variables', () => {
    const html = reportToHTML(rep({ title: '</style><script>alert(1)</script>' }));
    expect(html).not.toContain('<script');
    expect(html.match(/<\/style>/g)?.length).toBe(1);
  });
  it('cleanSvg strips scripts, handlers, foreign objects and script URLs', () => {
    const dirty = '<svg viewBox="0 0 1 1" onload="x()"><script>alert(1)</script><foreignObject><div onclick="y()"></div></foreignObject><a href="javascript:alert(1)"><rect onmouseover=\'z()\'/></a></svg>';
    const c = cleanSvg(dirty);
    expect(c).not.toMatch(/script|foreignObject|onload|onclick|onmouseover|javascript:/i);
    expect(cleanSvg('<div onclick=1></div>')).toBe('');
    expect(cleanSvg('<svg></svg><img src=x onerror=1>')).toBe('');
  });
  it('esc escapes quotes', () => { expect(esc('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&#39;'); });
});

describe('CSV export', () => {
  it('neutralises spreadsheet formulas but keeps numbers', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('+cmd|calc')).toBe('"\'+cmd|calc"');
    expect(csvCell('-3/4')).toBe('"-3/4"');
    expect(csvCell('-1.5')).toBe('"-1.5"');
    expect(csvCell('plain')).toBe('"plain"');
    expect(reportToCSV(rep({ result: { heading: '=1+1', lines: ['@x'] } }))).not.toMatch(/^"=/m);
  });
});

describe('expression parsers', () => {
  it('never reach globals or prototype members', () => {
    for (const src of ['constructor(1)', '__proto__', 'toString(1)', 'hasOwnProperty(1)', 'process', 'globalThis', 'window.x', 'x.constructor', 'alert(1)'])
      expect(() => compileExpression(src, ['x'])).toThrow();
    expect(() => parseExpression('constructor(x)', ['x'])).toThrow();
    expect(() => parseExpression('__proto__', ['x'])).toThrow();
  });
  it('still evaluates normal input', () => {
    expect(compileExpression('max(x, 2) ^ 2 + sqrt(16)', ['x'])({ x: 3 })).toBe(13);
  });
  it('rejects very long or deeply nested input cleanly', () => {
    expect(() => compileExpression('('.repeat(5000) + '1' + ')'.repeat(5000), [])).toThrow(/too|nested/);
    expect(() => compileExpression('1+'.repeat(5000) + '1', [])).toThrow(/too long/);
    expect(() => compileExpression('-'.repeat(500) + '1', [])).toThrow(/nested/);
    expect(() => parseExpression('('.repeat(5000) + '1' + ')'.repeat(5000), [])).toThrow(/too|nested/);
    expect(() => parseExpression('-'.repeat(500) + 'x', ['x'])).toThrow(/nested/);
  });
  it('algebraic parser fails cleanly on oversized models and lines', () => {
    expect(AlgebraicParser.parse('max x\nst\n' + 'x <= 1\n'.repeat(200000)).success).toBe(false);
    expect(AlgebraicParser.parse('max x\nst\nx <= 1' + ' '.repeat(250000)).success).toBe(false);
  });
  it('algebraic parser has no quadratic regex on whitespace-heavy lines', () => {
    const t = Date.now();
    AlgebraicParser.parse('max x\nst\na' + ' '.repeat(100000) + 'b');
    AlgebraicParser.parse('max x\nst\na' + ' '.repeat(100000) + 'b c');
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
