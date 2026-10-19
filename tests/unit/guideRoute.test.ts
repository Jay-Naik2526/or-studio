import { describe, it, expect } from 'vitest';
import { resolveRoute } from '../../src/components/shell/routeUtil';
import { lookupTerm } from '../../src/lib/glossary';
import { MODULE_IDS } from '../../src/lib/persist';

describe('user guide route and glossary', () => {
  it('resolves #/guide (any case) to the guide screen', () => {
    expect(resolveRoute(['guide'], MODULE_IDS)).toEqual({ kind: 'guide' });
    expect(resolveRoute(['Guide'], MODULE_IDS)).toEqual({ kind: 'guide' });
    expect(resolveRoute(['guides'], MODULE_IDS).kind).toBe('not-found');
  });
  it('knows all thirteen modules', () => { expect(MODULE_IDS).toHaveLength(13); expect(MODULE_IDS).toContain('sequencing'); });
  it('explains common short forms, scoped by module', () => {
    expect(lookupTerm('RHS')?.title).toMatch(/right-hand side/i);
    expect(lookupTerm('s₁', 'lp')?.title).toMatch(/slack/i);
    expect(lookupTerm('s₁', 'games')).toBeNull();
    expect(lookupTerm('ES', 'project')?.title).toMatch(/earliest start/i);
    expect(lookupTerm('ES', 'lp')).toBeNull();
    expect(lookupTerm('y₂', 'lp')?.title).toMatch(/dual variable/i);
    expect(lookupTerm('Makespan')?.def).toMatch(/last job/);
    expect(lookupTerm('something unrelated')).toBeNull();
    expect(lookupTerm('x'.repeat(80))).toBeNull();
  });
});
