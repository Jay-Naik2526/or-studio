import { describe, it, expect } from 'vitest';
import { conforms } from '../../src/components/modules/common';
import { LIBRARY } from '../../src/data/library';

describe('saved-state shape check', () => {
  it('every library problem has the same shape as its module default, so valid saves are never rejected', () => {
    for (const mod of new Set(LIBRARY.map(e => e.module))) {
      const entries = LIBRARY.filter(e => e.module === mod);
      const def = entries[0]!.spec;
      for (const e of entries) expect(conforms(def, e.spec), `${mod}/${e.id}`).toBe(true);
    }
  });
  it('rejects wrong types, missing fields, non-objects and oversized text', () => {
    const def = { text: 'max x', nodes: [{ id: 'a', label: 'A' }], flag: true, n: 1 };
    expect(conforms(def, { text: 'min y', nodes: [], flag: false, n: 5 })).toBe(true);
    expect(conforms(def, { text: [1, 2], nodes: [], flag: true, n: 1 })).toBe(false);
    expect(conforms(def, { text: 'x', nodes: 'x', flag: true, n: 1 })).toBe(false);
    expect(conforms(def, { text: 'x', nodes: [{ id: 1, label: 'A' }], flag: true, n: 1 })).toBe(false);
    expect(conforms(def, { text: 'x', nodes: [], flag: true })).toBe(false);
    expect(conforms(def, null)).toBe(false);
    expect(conforms(def, 'x'.repeat(10))).toBe(false);
    expect(conforms(def, { text: 'x'.repeat(200_000), nodes: [], flag: true, n: 1 })).toBe(false);
  });
});
