import { describe, it, expect } from 'vitest';
import { ProjectSolver, normalCDF, normalInv, probabilityWithin } from '../../src/core/solvers/project/cpm';
import { crashCurve, crashAtTarget } from '../../src/core/solvers/project/crashing';
import { ProjectModel } from '../../src/core/types/models';

const lib: ProjectModel = { activities: [
  { id: 'A', name: 'A', predecessors: [], duration: 3 }, { id: 'B', name: 'B', predecessors: [], duration: 5 },
  { id: 'C', name: 'C', predecessors: ['A'], duration: 2 }, { id: 'D', name: 'D', predecessors: ['B'], duration: 4 },
  { id: 'E', name: 'E', predecessors: ['C', 'D'], duration: 3 }, { id: 'F', name: 'F', predecessors: ['E'], duration: 2 } ] };

describe('CPM / PERT', () => {
  it('library example: 14 units, critical B-D-E-F, A and C float 4', () => {
    const r = new ProjectSolver().solve(lib).result!;
    expect(r.projectDuration).toBe(14);
    expect(r.criticalPath).toEqual(['B', 'D', 'E', 'F']);
    expect(r.schedule.A!.totalFloat).toBe(4);
  });
  it('detects cycles and names them', () => {
    const s = new ProjectSolver().solve({ activities: [{ id: 'A', name: 'A', predecessors: ['C'], duration: 1 }, { id: 'B', name: 'B', predecessors: ['A'], duration: 1 }, { id: 'C', name: 'C', predecessors: ['B'], duration: 1 }] });
    expect(s.status).toBe('invalid-input');
    expect(s.diagnostics[0]!.message).toMatch(/Cyclic dependency/);
  });
  it('multiple critical paths, negative float vs deadline', () => {
    const m: ProjectModel = { deadline: 5, activities: [{ id: 'A', name: 'A', predecessors: [], duration: 3 }, { id: 'B', name: 'B', predecessors: [], duration: 3 }, { id: 'C', name: 'C', predecessors: ['A', 'B'], duration: 4 }] };
    const s = new ProjectSolver().solve(m);
    expect(s.result!.criticalPaths).toHaveLength(2);
    expect(s.diagnostics.some(d => d.code === 'NEGATIVE_FLOAT')).toBe(true);
  });
  it('PERT with zero variance activity and probability', () => {
    const m: ProjectModel = { activities: [{ id: 'A', name: 'A', predecessors: [], optimistic: 2, mostLikely: 4, pessimistic: 6 }, { id: 'B', name: 'B', predecessors: ['A'], optimistic: 3, mostLikely: 3, pessimistic: 3 }] };
    const s = new ProjectSolver().solve(m, { variant: 'pert' });
    expect(s.result!.projectDuration).toBe(7);
    expect(s.diagnostics.some(d => d.code === 'ZERO_VARIANCE')).toBe(true);
    expect(probabilityWithin(s.result!, 7)!).toBeCloseTo(0.5, 5);
  });
  it('normal CDF / inverse', () => {
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 3);
    expect(normalInv(0.975)).toBeCloseTo(1.96, 2);
  });
});

describe('Crashing', () => {
  it('cost grows monotonically and respects crash limits', () => {
    const m: ProjectModel = { activities: [
      { id: 'A', name: 'A', predecessors: [], duration: 4, normalCost: 100, crashDuration: 2, crashCost: 160 },
      { id: 'B', name: 'B', predecessors: ['A'], duration: 3, normalCost: 80, crashDuration: 2, crashCost: 110 },
      { id: 'C', name: 'C', predecessors: [], duration: 6, normalCost: 120, crashDuration: 5, crashCost: 150 } ] };
    const c = crashCurve(m, 7);
    expect(c.curve[0]!.duration).toBe(7);
    for (let k = 1; k < c.curve.length; k++) expect(c.curve[k]!.crashCost).toBeGreaterThanOrEqual(c.curve[k - 1]!.crashCost - 1e-9);
    expect(c.minDuration).toBe(5);
    expect(crashAtTarget(m, 4)).toBeNull();
  });
});
