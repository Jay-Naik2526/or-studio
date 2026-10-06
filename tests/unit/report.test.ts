import { describe, it, expect } from 'vitest';
import { Report, reportToHTML, reportToLaTeX, reportToCSV } from '../../src/lib/report';
import { readModelFile, MODULE_IDS } from '../../src/lib/persist';

const base: Report = {
  title: 'Product mix <test>', module: 'Linear programming', method: 'Two-phase simplex', problem: 'max 3x₁ + 5x₂\nx₁ ≤ 4',
  steps: [{ title: 'Pivot', short: 'x₂ enters', detailed: 'ratio 3/2 is smallest', rule: 'Dantzig', formula: '\\frac{a}{b}', table: { caption: 'T1', headers: ['Basis', 'x₁', 'RHS'], rows: [['z', '-3/2', '36'], ['s₁', '1', '4']], highlightRows: [1] } }],
  result: { heading: 'Result: Optimal', lines: ['z = 36'], tables: [{ headers: ['Var', 'Value'], rows: [['x₁', '2']] }] },
  diagnostics: ['Alternate optima exist'],
  figures: [{ caption: 'Graph', svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>' }],
};

describe('report export', () => {
  const html = reportToHTML(base);
  it('puts the answer before the working and numbers the sections', () => {
    expect(html.indexOf('Answer')).toBeGreaterThan(0);
    expect(html.indexOf('Answer')).toBeLessThan(html.indexOf('Working'));
    expect(html).toContain('class="n">3</span>Working');
  });
  it('escapes user text, renders fractions, formulas and figures', () => {
    expect(html).toContain('Product mix &lt;test&gt;');
    expect(html).not.toContain('<test>');
    expect(html).toContain('<span class="fr"><i>3</i><b>2</b></span>');
    expect(html).toContain('<math');
    expect(html).toContain('<figure><svg');
    expect(html).toContain('class="hl"');
    expect(html).toContain('@page');
  });
  it('LaTeX output is balanced and resizes wide tables', () => {
    const wide: Report = { ...base, steps: [{ ...base.steps[0]!, table: { headers: Array.from({ length: 10 }, (_, i) => `c${i}`), rows: [Array.from({ length: 10 }, () => '1/2')] } }] };
    const tex = reportToLaTeX(wide);
    expect(tex).toContain('\\resizebox');
    expect(tex).toContain('graphicx');
    expect((tex.match(/\\begin\{/g) ?? []).length).toBe((tex.match(/\\end\{/g) ?? []).length);
    expect(tex).toContain('\\frac{1}{2}');
  });
  it('CSV exports the result tables', () => {
    expect(reportToCSV(base)).toContain('"Var","Value"');
  });
});

describe('model files', () => {
  const file = (o: unknown) => new File([typeof o === 'string' ? o : JSON.stringify(o)], 'm.json');
  it('accepts a valid model and fills in missing metadata', async () => {
    const m = await readModelFile(file({ moduleId: 'lp', model: { text: 'max x' } }));
    expect(m.meta.title).toBe('Imported model');
  });
  it('rejects non-JSON, unknown modules and empty models with a clear message', async () => {
    await expect(readModelFile(file('not json'))).rejects.toThrow(/not valid JSON/);
    await expect(readModelFile(file({ moduleId: 'zzz', model: {} }))).rejects.toThrow(/unknown module/);
    await expect(readModelFile(file({ moduleId: 'lp', model: 5 }))).rejects.toThrow(/damaged/);
    await expect(readModelFile(file({ foo: 1 }))).rejects.toThrow(/not an OR-Studio model/);
  });
  it('knows all twelve modules', () => { expect(MODULE_IDS.length).toBe(12); });
});
