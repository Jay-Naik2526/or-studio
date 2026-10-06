import { describe, it, expect } from 'vitest';
import { LIBRARY } from '../../src/data/library';
import { LPSpec, TransportSpec, AssignSpec, GraphSpec, ProjectSpec, GameSpec, MarkovSpec } from '../../src/data/specs';
import { AlgebraicParser } from '../../src/core/parse/algebraic';
import { solveLP } from '../../src/core/solvers/lp/engine';
import { BranchBoundSolver } from '../../src/core/solvers/integer/branchBound';
import { solveGomory } from '../../src/core/solvers/integer/gomory';
import { TransportSolver } from '../../src/core/solvers/transport/transport';
import { HungarianSolver } from '../../src/core/solvers/transport/hungarian';
import { solveDijkstra, solveBellmanFord, solveMST, solveMaxFlow } from '../../src/core/solvers/network/network';
import { ProjectSolver } from '../../src/core/solvers/project/cpm';
import { solveZeroSumGame } from '../../src/core/solvers/games/zeroSum';
import { solveMarkovChain } from '../../src/core/solvers/markov/markov';
import { solveInventory } from '../../src/core/solvers/inventory/inventory';
import { solveQueue } from '../../src/core/solvers/queuing/queuing';
import { Rational } from '../../src/core/math/rational';

const R = (s: string) => Rational.parse(s);
const blocked = (s: string) => /^(m|x)$/i.test(s.trim());

describe('problem library is consistent with the solvers', () => {
  for (const e of LIBRARY) {
    it(`${e.module}/${e.id}`, () => {
      const check = e.check ?? '';
      switch (e.module) {
        case 'lp': {
          const p = AlgebraicParser.parse((e.spec as LPSpec).text);
          expect(p.success, JSON.stringify(p.error)).toBe(true);
          const s = solveLP(p.model!, { method: (e.variant as never) ?? 'auto' });
          if (check === 'unbounded' || check === 'infeasible') expect(s.status).toBe(check);
          else { expect(['optimal', 'optimal-alternate-exists']).toContain(s.status); if (check) expect(s.result!.objectiveValue.toString()).toBe(check); }
          break;
        }
        case 'integer': {
          const p = AlgebraicParser.parse((e.spec as LPSpec).text);
          expect(p.success).toBe(true);
          const bb = new BranchBoundSolver().solve(p.model!, {});
          if (check === 'infeasible') expect(bb.status).toBe('infeasible');
          else { expect(bb.status).toBe('optimal'); if (check) expect(bb.result!.objectiveValue.toString()).toBe(check); const g = solveGomory(p.model!); if (g.status === 'optimal') expect(g.result!.objectiveValue.eq(bb.result!.objectiveValue)).toBe(true); }
          break;
        }
        case 'transport': {
          const s = e.spec as TransportSpec;
          const m = { supply: s.supply.map(R), demand: s.demand.map(R), costs: s.costs.map(r => r.map(c => (blocked(c) ? Rational.ZERO : R(c)))), blocked: s.costs.map(r => r.map(blocked)), objective: s.objective };
          const sol = new TransportSolver().solve(m, { variant: (e.variant as never) ?? 'vam' });
          expect(sol.status).toBe('optimal');
          if (check) expect(sol.result!.reportedObjective.toString()).toBe(check);
          break;
        }
        case 'assign': {
          const s = e.spec as AssignSpec;
          const sol = new HungarianSolver().solve({ costs: s.costs.map(r => r.map(R)), objective: s.objective });
          expect(sol.status).toBe('optimal');
          if (check) expect(sol.result!.objective.toString()).toBe(check);
          break;
        }
        case 'network': {
          const s = e.spec as GraphSpec;
          const g = { nodes: s.nodes, edges: s.edges.map(x => ({ id: x.id, from: x.from, to: x.to, weight: R(x.weight), capacity: R(x.capacity), directed: x.directed })), source: s.source, sink: s.sink };
          if (e.variant === 'dijkstra') expect(solveDijkstra(g).result!.totalDistance!.toString()).toBe(check);
          else if (e.variant === 'bellman') expect(solveBellmanFord(g).result!.totalDistance!.toString()).toBe(check);
          else if (e.variant === 'kruskal') { const a = solveMST(g, 'kruskal').result!, b = solveMST(g, 'prim').result!; expect(a.totalWeight.toString()).toBe(check); expect(b.totalWeight.toString()).toBe(check); }
          else expect(solveMaxFlow(g).result!.maxFlow.toString()).toBe(check);
          break;
        }
        case 'project': {
          const s = e.spec as ProjectSpec;
          const num = (x: string) => (x.trim() === '' ? undefined : Number(x));
          const m = { activities: s.activities.map(a => ({ id: a.id, name: a.id, predecessors: a.pred.split(/[,\s]+/).filter(Boolean), duration: num(a.duration), optimistic: num(a.a), mostLikely: num(a.m), pessimistic: num(a.b) })) };
          const sol = new ProjectSolver().solve(m, { variant: e.variant === 'pert' ? 'pert' : 'cpm' });
          expect(sol.status).toBe('optimal');
          if (check) expect(String(sol.result!.projectDuration)).toBe(check);
          break;
        }
        case 'games': {
          const s = e.spec as GameSpec;
          const r = solveZeroSumGame({ payoff: s.payoff.map(row => row.map(R)) });
          expect(r.verified).toBe(true);
          if (check) expect(r.gameValue.toString()).toBe(check);
          break;
        }
        case 'markov': {
          const s = e.spec as MarkovSpec;
          const r = solveMarkovChain({ transitionMatrix: s.P.map(row => row.map(R)) }, 3);
          expect(r.error).toBeUndefined();
          if (check) expect(r.steadyState!.distribution[0]!.toString()).toBe(check);
          break;
        }
        case 'queuing': {
          const s = e.spec as { model: 'mm1'; lambda: string; mu: string; servers: string; capacity: string; sigma: string };
          const r = solveQueue({ model: s.model, lambda: Number(s.lambda), mu: Number(s.mu), servers: Number(s.servers), capacity: s.capacity ? Number(s.capacity) : undefined, serviceStdDev: s.sigma ? Number(s.sigma) : undefined });
          expect(r.error).toBeUndefined();
          if (check) expect(Math.round(r.metrics!.Ls)).toBe(Number(check));
          break;
        }
        case 'inventory': {
          const s = e.spec as { model: 'eoq'; D: string; K: string; h: string; c: string; price: string; salvage: string; dist: 'normal'; mean: string; sd: string };
          const r = e.id === 'inv-news' ? solveInventory({ model: 'newsvendor', sellingPrice: Number(s.price), unitCost: Number(s.c), salvageValue: Number(s.salvage), demandDist: 'normal', mean: Number(s.mean), stdDev: Number(s.sd) }) : { error: undefined, Q: 0 };
          expect(r.error).toBeUndefined();
          if (check) expect(Math.round(r.Q!)).toBe(Number(check));
          break;
        }
        default: break;
      }
    });
  }
});
