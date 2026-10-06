import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { safeDecode, resolveRoute, hash32, moduleKey, contrastRatio, parseHex } from '../../src/components/shell/routeUtil';
import { isTypingTarget, ownsArrowKeys, ownsSpaceKey, shortcutBlocked } from '../../src/components/ui/keys';

const IDS = ['lp', 'integer', 'nlp', 'transport', 'assign', 'network', 'project', 'queuing', 'inventory', 'games', 'markov', 'simulation'];

describe('route resolution', () => {
  it('safeDecode survives malformed escapes', () => {
    expect(safeDecode('%zz')).toBe('%zz');
    expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A');
    expect(safeDecode('l%70')).toBe('lp');
  });
  it('maps the known screens', () => {
    expect(resolveRoute([], IDS)).toEqual({ kind: 'hub' });
    expect(resolveRoute(['library'], IDS)).toEqual({ kind: 'library' });
    expect(resolveRoute(['docs', 'extra'], IDS)).toEqual({ kind: 'docs' });
    expect(resolveRoute(['m', 'lp'], IDS)).toEqual({ kind: 'module', id: 'lp' });
  });
  it('is tolerant about case and percent-encoding in the module id', () => {
    expect(resolveRoute(['m', 'LP'], IDS)).toEqual({ kind: 'module', id: 'lp' });
    expect(resolveRoute(['m', 'l%70'], IDS)).toEqual({ kind: 'module', id: 'lp' });
    expect(resolveRoute(['M', 'games'], IDS)).toEqual({ kind: 'module', id: 'games' });
  });
  it('reports unknown modules and pages without throwing', () => {
    expect(resolveRoute(['m'], IDS)).toEqual({ kind: 'unknown-module', id: '' });
    expect(resolveRoute(['m', '%zz'], IDS)).toEqual({ kind: 'unknown-module', id: '%zz' });
    const long = 'x'.repeat(5000);
    const r = resolveRoute(['m', long], IDS);
    expect(r.kind).toBe('unknown-module');
    expect(r.kind === 'unknown-module' && r.id.length).toBe(40);
    expect(resolveRoute(['main'], IDS).kind).toBe('not-found');
    expect(resolveRoute(['__proto__'], IDS).kind).toBe('not-found');
  });
});

describe('module remount key', () => {
  const q = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
  it('differs for shared models that share a long common prefix', () => {
    const a = 'N4IgzgpgNgDgTgOwK4FsD2AXA2gXQDSA' + 'A'.repeat(200) + '1';
    const b = 'N4IgzgpgNgDgTgOwK4FsD2AXA2gXQDSA' + 'A'.repeat(200) + '2';
    expect(a.slice(0, 12)).toBe(b.slice(0, 12));
    expect(moduleKey('lp', q({ model: a }))).not.toBe(moduleKey('lp', q({ model: b })));
  });
  it('is stable for the same link and separates library problem / variant', () => {
    expect(moduleKey('lp', q({ lib: 'x', model: 'abc' }))).toBe(moduleKey('lp', q({ lib: 'x', model: 'abc' })));
    expect(moduleKey('lp', q({ lib: 'x' }))).not.toBe(moduleKey('lp', q({ lib: 'y' })));
    expect(moduleKey('lp', q({ lib: 'x', variant: 'bigm' }))).not.toBe(moduleKey('lp', q({ lib: 'x', variant: 'twophase' })));
    expect(moduleKey('lp', q({}))).not.toBe(moduleKey('integer', q({})));
  });
  it('hash32 is deterministic and length-sensitive', () => {
    expect(hash32('abc')).toBe(hash32('abc'));
    expect(hash32('abc')).not.toBe(hash32('abd'));
    expect(hash32('')).toBe(hash32(''));
  });
});

describe('keyboard shortcut guards', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, closest: () => null, ...extra });
  it('detects typing targets', () => {
    expect(isTypingTarget(el('INPUT'))).toBe(true);
    expect(isTypingTarget(el('textarea'))).toBe(true);
    expect(isTypingTarget(el('SELECT'))).toBe(true);
    expect(isTypingTarget(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el('DIV'))).toBe(false);
    expect(isTypingTarget(el('BUTTON'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
  it('blocks shortcuts while typing, with modifiers, composing, handled or while a dialog is open', () => {
    const base = { key: 'ArrowRight', target: el('BODY') };
    expect(shortcutBlocked(base, false)).toBe(false);
    expect(shortcutBlocked({ ...base, target: el('INPUT') }, false)).toBe(true);
    expect(shortcutBlocked({ ...base, ctrlKey: true }, false)).toBe(true);
    expect(shortcutBlocked({ ...base, metaKey: true }, false)).toBe(true);
    expect(shortcutBlocked({ ...base, altKey: true }, false)).toBe(true);
    expect(shortcutBlocked({ ...base, isComposing: true }, false)).toBe(true);
    expect(shortcutBlocked({ ...base, defaultPrevented: true }, false)).toBe(true);
    expect(shortcutBlocked(base, true)).toBe(true);
  });
  it('lets composite widgets and buttons keep their own keys', () => {
    const inside = (sel: string) => ({ tagName: 'BUTTON', closest: (s: string) => (s.includes(sel) ? {} : null) });
    expect(ownsArrowKeys(inside('role="tablist"'))).toBe(true);
    expect(ownsArrowKeys(inside('role="radiogroup"'))).toBe(true);
    expect(ownsArrowKeys(el('BODY'))).toBe(false);
    expect(ownsSpaceKey(inside('button'))).toBe(true);
    expect(ownsSpaceKey(el('BODY'))).toBe(false);
    expect(ownsArrowKeys(null)).toBe(false);
  });
});

describe('colour tokens (WCAG)', () => {
  const css = readFileSync(resolve(__dirname, '../../src/index.css'), 'utf8');
  const block = (re: RegExp) => { const m = css.match(re); if (!m) throw new Error('block not found'); const o: Record<string, string> = {}; for (const x of m[1]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) o[x[1]!] = x[2]!.trim(); return o; };
  const light = block(/:root\s*\{([\s\S]*?)\n\}/);
  const dark = { ...light, ...block(/\n\.dark\s*\{([\s\S]*?)\n\}/) };
  const text: [string, string][] = [['text', 'bg'], ['text', 'surface'], ['text-2', 'bg'], ['text-2', 'surface'], ['text-2', 'surface-3'], ['text-3', 'bg'], ['text-3', 'surface'], ['text-3', 'surface-2'], ['text-3', 'surface-3'], ['on-accent', 'accent'], ['ok', 'ok-soft'], ['bad', 'bad-soft'], ['warn', 'warn-soft'], ['entering', 'entering-soft'], ['leaving', 'leaving-soft'], ['ok', 'surface'], ['bad', 'surface'], ['warn', 'surface'], ['text-3', 'ok-soft'], ['text-3', 'bad-soft'], ['text-3', 'warn-soft'], ['text-3', 'entering-soft']];
  for (const [name, t] of [['light', light], ['dark', dark]] as const) {
    it(`${name}: body-size text pairs reach 4.5:1`, () => {
      for (const [fg, bg] of text) {
        const r = contrastRatio(t[fg]!, t[bg]!);
        expect(r, `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: form-control borders and focus ring reach 3:1`, () => {
      for (const bg of ['surface', 'bg']) {
        expect(contrastRatio(t['border-strong']!, t[bg]!), `border-strong on ${bg}`).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(t['focus']!, t[bg]!), `focus on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
  it('contrast helper matches known values', () => {
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
    expect(parseHex('#abc')).toEqual([170, 187, 204]);
    expect(() => parseHex('nope')).toThrow();
  });
  it('no declared font size falls below 12px at the 17px root size', () => {
    const small = [...css.matchAll(/font-size:\s*(\.?\d*\.?\d+)rem/g)].map(m => Number(m[1]) * 17).filter(px => px < 12);
    expect(small).toEqual([]);
  });
});
