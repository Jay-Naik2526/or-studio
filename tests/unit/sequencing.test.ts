import { describe, it, expect, vi } from 'vitest';
import { Rational } from '../../src/core/math/rational';
import { solveSequencing, buildSeqModel, johnsonOrder, makespanOf, computeTiming, SeqModel, SeqMethod } from '../../src/core/solvers/sequencing/sequencing';
import { rng, randInt } from '../helpers/bruteLP';
import { LIBRARY } from '../../src/data/library';

/* ---------------- independent oracles (numbers, scaled by 4 so quarters are exact) ---------------- */
vi.setConfig({ testTimeout: 60_000 });
const S = 4;

function perms(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  for (const p of perms(n - 1)) for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}

/** Completion-time recurrence C[i][k] = max(C[i-1][k], C[i][k-1]) + p — written differently from the solver (full matrix, 1-based). */
function oracleMakespan(p: number[][], order: number[]): number {
  const m = p[0]!.length;
  const C: number[][] = Array.from({ length: order.length + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= order.length; i++) for (let k = 1; k <= m; k++) C[i]![k] = Math.max(C[i - 1]![k]!, C[i]![k - 1]!) + p[order[i - 1]!]![k - 1]!;
  return C[order.length]![m]!;
}

function bruteOptimum(p: number[][]): { best: number; count: number; all: number[][] } {
  let best = Infinity, count = 0;
  const all: number[][] = [];
  for (const o of perms(p.length)) {
    const v = oracleMakespan(p, o);
    if (v < best) { best = v; count = 1; all.length = 0; all.push(o); } else if (v === best) { count++; all.push(o); }
  }
  return { best, count, all };
}

/** random integer matrix in quarter units with ties, zeros and fractions */
function randomInstance(r: () => number, n: number, m: number, opts: { fractions?: boolean; maxV?: number } = {}): { scaled: number[][]; model: SeqModel } {
  const maxV = opts.maxV ?? 9;
  const scaled = Array.from({ length: n }, () => Array.from({ length: m }, () => {
    const whole = randInt(r, 0, maxV);
    const frac = opts.fractions && r() < 0.4 ? randInt(r, 0, 3) / 4 : 0;
    return Math.round((whole + frac) * S);
  }));
  const model: SeqModel = {
    jobs: Array.from({ length: n }, (_, i) => `J${i + 1}`),
    machines: Array.from({ length: m }, (_, k) => `M${k + 1}`),
    times: scaled.map(row => row.map(v => Rational.of(v, S))),
  };
  return { scaled, model };
}

const toNum = (x: Rational) => Number(x.n * BigInt(S) / x.d);
const solve = (model: SeqModel, method: SeqMethod, emit = true) => solveSequencing(model, method, { emitSteps: emit });

describe("Johnson's rule (two machines)", () => {
  it('equals the brute-force optimum on 400 random instances (ties, zeros, fractions, n ≤ 8)', () => {
    const r = rng(7001);
    for (let t = 0; t < 400; t++) {
      const n = randInt(r, 1, 8);
      const { scaled, model } = randomInstance(r, n, 2, { fractions: t % 3 === 0, maxV: t % 4 === 0 ? 3 : 12 });
      const sol = solve(model, 'johnson');
      expect(sol.status).toBe('optimal');
      const res = sol.result!;
      expect(res.guaranteedOptimal).toBe(true);
      expect(res.sequence.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(toNum(res.makespan)).toBe(bruteOptimum(scaled).best);
      expect(toNum(res.makespan)).toBe(oracleMakespan(scaled, res.sequence));
    }
  });

  it('emits one explained placement per job, front for machine 1 and back for machine 2', () => {
    const { model } = randomInstance(rng(5), 6, 2);
    const sol = solve(model, 'johnson');
    const places = sol.steps.filter(s => s.action?.kind === 'place');
    expect(places.length).toBe(6);
    for (const s of places) {
      const pl = s.action!.payload as { side: string; machine: number; slot: number };
      expect(pl.side).toBe(pl.machine === 1 ? 'front' : 'back');
      expect(s.explanation.short.length).toBeGreaterThan(10);
      expect(s.explanation.rule).toContain('Johnson');
      expect(s.state.slots!.length).toBe(6);
      expect(s.state.slots![pl.slot]).not.toBeNull();
    }
    // the slot strip fills monotonically and ends full
    const last = places[places.length - 1]!.state.slots!;
    expect(last.every(x => x !== null)).toBe(true);
    expect(sol.steps[0]!.status).toBe('initial');
    expect(sol.steps[sol.steps.length - 1]!.status).toBe('optimal');
    sol.steps.forEach((s, i) => expect(s.index).toBe(i));
  });

  it('ties are resolved deterministically and flagged in the explanation', () => {
    const model: SeqModel = { jobs: ['A', 'B', 'C'], machines: ['M1', 'M2'], times: [[2, 2], [2, 5], [5, 2]].map(r => r.map(v => Rational.of(v))) };
    const sol = solve(model, 'johnson');
    const first = sol.steps.find(s => s.action?.kind === 'place')!;
    expect((first.action!.payload as { job: string }).job).toBe('A');
    expect(first.explanation.detailed).toMatch(/also appears/);
    expect(sol.result!.makespan.toString()).toBe(String(bruteOptimum([[2, 2], [2, 5], [5, 2]]).best));
  });
});

describe('three machines', () => {
  it('Johnson reduction is optimal whenever min(M1) ≥ max(M2) or min(M3) ≥ max(M2) (400 instances)', () => {
    const r = rng(7002);
    let checked = 0;
    for (let t = 0; t < 4000 && checked < 400; t++) {
      const n = randInt(r, 2, 7);
      const inst = randomInstance(r, n, 3, { fractions: t % 2 === 0, maxV: 9 });
      const { scaled } = inst;
      // half of the instances are pushed into the dominance region so the condition is exercised often
      if (t % 2 === 0) { const mx = Math.max(...scaled.map(x => x[1]!)); const side = t % 4 === 0 ? 0 : 2; scaled.forEach((row, i) => { row[side] = row[side]! + mx; inst.model.times[i]![side] = Rational.of(row[side]!, S); }); }
      const { model } = inst;
      const min1 = Math.min(...scaled.map(x => x[0]!)), min3 = Math.min(...scaled.map(x => x[2]!)), max2 = Math.max(...scaled.map(x => x[1]!));
      const holds = min1 >= max2 || min3 >= max2;
      const res = solve(model, 'johnson').result!;
      expect(res.reduction!.holds).toBe(holds);
      expect(res.guaranteedOptimal).toBe(holds);
      if (!holds) continue;
      checked++;
      expect(toNum(res.makespan)).toBe(bruteOptimum(scaled).best);
    }
    expect(checked).toBe(400);
  });

  it('warns when the condition fails and never claims optimality', () => {
    const model: SeqModel = { jobs: ['A', 'B', 'C'], machines: ['M1', 'M2', 'M3'], times: [[1, 9, 1], [9, 1, 9], [2, 8, 2]].map(r => r.map(v => Rational.of(v))) };
    const sol = solve(model, 'johnson');
    expect(sol.result!.guaranteedOptimal).toBe(false);
    expect(sol.diagnostics.some(d => d.code === 'REDUCTION_NOT_GUARANTEED' && d.severity === 'warning')).toBe(true);
    expect(sol.steps.some(s => s.explanation.short.includes('FAILS'))).toBe(true);
  });

  it('rejects Johnson for four or more machines with a pointer to CDS', () => {
    const { model } = randomInstance(rng(3), 4, 4);
    const sol = solve(model, 'johnson');
    expect(sol.status).toBe('invalid-input');
    expect(sol.result).toBeNull();
    expect(sol.diagnostics[0]!.message).toMatch(/CDS/);
  });
});

describe('CDS heuristic', () => {
  it('returns a valid permutation, a makespan equal to the independent recurrence and ≥ the optimum (m = 2..6)', () => {
    const r = rng(7003);
    for (let t = 0; t < 400; t++) {
      const n = randInt(r, 1, 7), m = randInt(r, 2, 6);
      const { scaled, model } = randomInstance(r, n, m, { fractions: t % 2 === 0 });
      const sol = solve(model, 'cds');
      expect(sol.status).toBe('optimal');
      const res = sol.result!;
      expect(res.sequence.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
      expect(toNum(res.makespan)).toBe(oracleMakespan(scaled, res.sequence));
      expect(toNum(res.makespan)).toBeGreaterThanOrEqual(bruteOptimum(scaled).best);
      expect(res.candidates!.length).toBe(m - 1);
      // best of the candidates, ties to the smallest k
      const mins = res.candidates!.map(c => toNum(c.makespan));
      expect(toNum(res.makespan)).toBe(Math.min(...mins));
      expect(res.bestCandidate).toBe(mins.indexOf(Math.min(...mins)));
      for (const c of res.candidates!) expect(toNum(c.makespan)).toBe(oracleMakespan(scaled, c.order));
      if (m === 2) expect(toNum(res.makespan)).toBe(bruteOptimum(scaled).best);
    }
  });

  it('candidate k sums the first k and the last k machines', () => {
    const model: SeqModel = { jobs: ['A', 'B'], machines: ['M1', 'M2', 'M3', 'M4'], times: [[1, 2, 3, 4], [4, 3, 2, 1]].map(r => r.map(v => Rational.of(v))) };
    const c = solve(model, 'cds').result!.candidates!;
    expect(c[1]!.pseudo.a.map(String)).toEqual(['3', '7']);
    expect(c[1]!.pseudo.b.map(String)).toEqual(['7', '3']);
    expect(c[2]!.pseudo.a.map(String)).toEqual(['6', '9']);
    expect(c[2]!.pseudo.b.map(String)).toEqual(['9', '6']);
  });
});

describe('exact search', () => {
  it('matches the brute-force optimum and the exact number of optimal sequences (m = 2..5)', () => {
    const r = rng(7004);
    for (let t = 0; t < 250; t++) {
      const n = randInt(r, 1, 7), m = randInt(r, 2, 5);
      const { scaled, model } = randomInstance(r, n, m, { fractions: t % 2 === 0, maxV: t % 3 === 0 ? 2 : 9 });
      const bf = bruteOptimum(scaled);
      const res = solve(model, 'exact').result!;
      expect(toNum(res.makespan)).toBe(bf.best);
      expect(res.exact!.count).toBe(bf.count);
      expect(res.exact!.total).toBe(perms(n).length);
      expect(res.guaranteedOptimal).toBe(true);
      // every reported example really is optimal
      for (const ex of res.exact!.examples) expect(oracleMakespan(scaled, ex)).toBe(bf.best);
      expect(oracleMakespan(scaled, res.sequence)).toBe(bf.best);
    }
  });

  it('counts all n! optima when every time is zero, and handles 9 jobs quickly', () => {
    const model: SeqModel = { jobs: Array.from({ length: 9 }, (_, i) => `J${i}`), machines: ['A', 'B', 'C'], times: Array.from({ length: 9 }, () => [Rational.ZERO, Rational.ZERO, Rational.ZERO]) };
    const t0 = Date.now();
    const res = solve(model, 'exact').result!;
    expect(res.exact!.count).toBe(362880);
    expect(res.makespan.toString()).toBe('0');
    expect(Date.now() - t0).toBeLessThan(10000);
  });

  it('refuses more than 9 jobs and points to CDS', () => {
    const { model } = randomInstance(rng(1), 10, 3);
    const sol = solve(model, 'exact');
    expect(sol.status).toBe('invalid-input');
    expect(sol.diagnostics[0]!.code).toBe('INPUT_LIMIT');
    expect(sol.diagnostics[0]!.message).toMatch(/CDS/);
  });

  it('exact ≤ CDS and, for two machines, Johnson reaches the same value', () => {
    const r = rng(7005);
    for (let t = 0; t < 100; t++) {
      const { model } = randomInstance(r, randInt(r, 2, 7), 2, { fractions: true });
      const j = solve(model, 'johnson', false).result!, e = solve(model, 'exact', false).result!, c = solve(model, 'cds', false).result!;
      expect(j.makespan.eq(e.makespan)).toBe(true);
      expect(c.makespan.eq(e.makespan)).toBe(true);
    }
  });
});

describe('timing, idle time and Gantt data', () => {
  it('in/out times match an independent recomputation and satisfy the idle identities', () => {
    const r = rng(7006);
    for (let t = 0; t < 300; t++) {
      const n = randInt(r, 1, 8), m = randInt(r, 2, 5);
      const { scaled, model } = randomInstance(r, n, m, { fractions: t % 2 === 0 });
      const method: SeqMethod = m === 2 ? 'johnson' : 'cds';
      const res = solve(model, method).result!;
      const tm = res.timing;
      // independent recurrence
      const C: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
      for (let i = 1; i <= n; i++) for (let k = 1; k <= m; k++) C[i]![k] = Math.max(C[i - 1]![k]!, C[i]![k - 1]!) + scaled[res.sequence[i - 1]!]![k - 1]!;
      for (let i = 0; i < n; i++) for (let k = 0; k < m; k++) {
        expect(toNum(tm.outT[i]![k]!)).toBe(C[i + 1]![k + 1]);
        expect(toNum(tm.outT[i]![k]!.sub(tm.inT[i]![k]!))).toBe(scaled[res.sequence[i]!]![k]);
      }
      expect(toNum(tm.makespan)).toBe(C[n]![m]);
      for (const id of tm.idle) {
        const busy = scaled.reduce((s, row) => s + row[id.machine]!, 0);
        expect(toNum(id.busy)).toBe(busy);
        expect(id.total.eq(id.initial.add(id.gaps).add(id.tail))).toBe(true);
        expect(toNum(id.total)).toBe(C[n]![m]! - busy);
        expect(id.total.isNegative()).toBe(false);
      }
      // machine 1 never idles before its first job nor between jobs
      expect(tm.idle[0]!.initial.isZero() && tm.idle[0]!.gaps.isZero()).toBe(true);
      expect(makespanOf(model.times, res.sequence).eq(tm.makespan)).toBe(true);
      expect(computeTiming(model.times, res.sequence).makespan.eq(tm.makespan)).toBe(true);
    }
  });

  it('Gantt intervals never overlap on a machine, a job never runs on two machines at once, machine order is respected', () => {
    const r = rng(7007);
    for (let t = 0; t < 200; t++) {
      const n = randInt(r, 1, 8), m = randInt(r, 2, 5);
      const { model } = randomInstance(r, n, m, { fractions: true });
      const res = solve(model, m === 2 ? 'johnson' : 'cds').result!;
      const g = res.gantt;
      expect(g.rows.length).toBe(m);
      const byJob = new Map<number, { s: Rational; e: Rational }[]>();
      for (const row of g.rows) {
        let cursor = Rational.ZERO;
        // bars and idle intervals together tile [0, makespan] without overlap
        const segs = [...row.bars.map(b => ({ s: b.start, e: b.end })), ...row.idle.map(i => ({ s: i.start, e: i.end }))].sort((a, b) => a.s.cmp(b.s) || a.e.cmp(b.e));
        for (const s of segs) {
          if (s.s.eq(s.e)) continue;
          expect(s.s.gte(cursor)).toBe(true);
          expect(s.s.eq(cursor)).toBe(true);
          cursor = s.e;
        }
        expect(cursor.eq(g.makespan) || row.bars.length === 0).toBe(true);
        for (let i = 1; i < row.bars.length; i++) expect(row.bars[i]!.start.gte(row.bars[i - 1]!.end)).toBe(true);
        for (const b of row.bars) { const l = byJob.get(b.job) ?? []; l.push({ s: b.start, e: b.end }); byJob.set(b.job, l); }
      }
      for (const [, list] of byJob) {
        expect(list.length).toBe(m);
        for (let k = 1; k < m; k++) expect(list[k]!.s.gte(list[k - 1]!.e)).toBe(true);
      }
    }
  });
});

describe('input validation (never throws)', () => {
  const ok = { jobs: ['A', 'B'], machines: ['M1', 'M2'], times: [['1', '2'], ['3', '4']] };
  it('accepts a valid spec and fractions', () => {
    expect(buildSeqModel(ok).error).toBeNull();
    const f = buildSeqModel({ ...ok, times: [['1/2', '2.5'], ['3', '4']] });
    expect(f.model!.times[0]![0]!.toString()).toBe('1/2');
  });
  const bad: [string, unknown, RegExp][] = [
    ['empty jobs', { jobs: [], machines: ['M1', 'M2'], times: [] }, /at least one job/],
    ['one machine', { jobs: ['A'], machines: ['M1'], times: [['1']] }, /two machines/],
    ['negative', { ...ok, times: [['-1', '2'], ['3', '4']] }, /negative/],
    ['NaN text', { ...ok, times: [['abc', '2'], ['3', '4']] }, /not a number/],
    ['missing', { ...ok, times: [['', '2'], ['3', '4']] }, /missing/],
    ['Infinity', { ...ok, times: [['Infinity', '2'], ['3', '4']] }, /not a number/],
    ['duplicate jobs', { ...ok, jobs: ['A', 'a'] }, /unique/],
    ['empty name', { ...ok, jobs: ['A', '  '] }, /no name/],
    ['duplicate machines', { ...ok, machines: ['M', 'M'] }, /unique/],
    ['huge number', { ...ok, times: [['1e9999', '2'], ['3', '4']] }, /not a number/],
    ['huge digits', { ...ok, times: [['99999999999', '2'], ['3', '4']] }, /too large/],
    ['huge denominator', { ...ok, times: [['1/99999999', '2'], ['3', '4']] }, /denominator/],
    ['very long entry', { ...ok, times: [['1'.repeat(5000), '2'], ['3', '4']] }, /too long/],
    ['ragged table', { ...ok, times: [['1'], ['3', '4']] }, /exactly/],
    ['too many jobs', { jobs: Array.from({ length: 1000 }, (_, i) => `J${i}`), machines: ['M1', 'M2'], times: Array.from({ length: 1000 }, () => ['1', '1']) }, /Too many jobs/],
    ['too many machines', { jobs: ['A'], machines: Array.from({ length: 11 }, (_, i) => `M${i}`), times: [Array(11).fill('1')] }, /Too many machines/],
    ['not text', { ...ok, times: [[1, 2], [3, 4]] }, /text or a number/],
    ['garbage', null, /incomplete/],
  ];
  for (const [name, spec, re] of bad) it(`rejects ${name}`, () => {
    const r = buildSeqModel(spec as never);
    expect(r.model).toBeNull();
    expect(r.error).toMatch(re);
  });

  it('solver returns invalid-input instead of throwing on a broken model', () => {
    for (const method of ['johnson', 'cds', 'exact'] as const) {
      const broken = { jobs: ['A', 'A'], machines: ['M1', 'M2'], times: [[Rational.ONE, Rational.ONE], [Rational.ONE, Rational.ONE]] } as SeqModel;
      expect(solve(broken, method).status).toBe('invalid-input');
      expect(solve({ jobs: [], machines: [], times: [] }, method).status).toBe('invalid-input');
      expect(solve({ jobs: ['A'], machines: ['x', 'y'], times: [[Rational.of(-1), Rational.ONE]] }, method).status).toBe('invalid-input');
      expect(() => solve(null as never, method)).not.toThrow();
    }
  });

  it('handles 200 jobs × 10 machines and a single job quickly', () => {
    const r = rng(9);
    const { model } = randomInstance(r, 200, 10, { fractions: true, maxV: 1000 });
    const t0 = Date.now();
    const sol = solve(model, 'cds');
    expect(sol.status).toBe('optimal');
    expect(sol.result!.candidates!.length).toBe(9);
    const j = solve(randomInstance(r, 200, 2).model, 'johnson');
    expect(j.steps.filter(s => s.action?.kind === 'place').length).toBe(200);
    expect(Date.now() - t0).toBeLessThan(8000);
    const one = solve(randomInstance(r, 1, 2).model, 'johnson').result!;
    expect(one.sequence).toEqual([0]);
  });
});

describe('Experiment 10, activity 4 (jobs A..I)', () => {
  const m1 = [2, 5, 4, 9, 6, 8, 7, 5, 4], m2 = [6, 8, 7, 4, 3, 9, 3, 8, 11];
  const model: SeqModel = { jobs: 'ABCDEFGHI'.split(''), machines: ['Machine I', 'Machine II'], times: m1.map((v, i) => [Rational.of(v), Rational.of(m2[i]!)]) };
  const p = m1.map((v, i) => [v, m2[i]!]);
  it('Johnson sequence is optimal; its sequence and total elapsed time are recorded here', () => {
    const res = solve(model, 'johnson').result!;
    const bf = bruteOptimum(p);
    expect(res.makespan.toString()).toBe(String(bf.best));
    expect(oracleMakespan(p, res.sequence)).toBe(bf.best);
    // recorded: A → C → I → B → H → F → D → G → E, total elapsed time 61, idle 11 (Machine I) and 2 (Machine II)
    expect(res.sequenceNames.join(' → ')).toBe('A → C → I → B → H → F → D → G → E');
    expect(res.makespan.toString()).toBe('61');
    expect(res.timing.idle.map(x => x.total.toString())).toEqual(['11', '2']);
    expect(bf.count).toBe(12344);
    expect(res.exact === undefined).toBe(true);
    expect(solve(model, 'exact').result!.exact!.count).toBe(bf.count);
    expect(johnsonOrder(model.times.map(r => r[0]!), model.times.map(r => r[1]!))).toEqual(res.sequence);
  });
});

describe('library facts', () => {
  const grab = (id: string) => {
    const e = LIBRARY.find(x => x.id === id)!;
    return buildSeqModel(e.spec as never).model!;
  };
  it('3-machine condition holds / fails where the library says so, and the optimum is as described', () => {
    expect(solve(grab('seq-3m'), 'johnson').result!.reduction!.holds).toBe(true);
    const nc = grab('seq-3m-nocond');
    const j = solve(nc, 'johnson').result!, ex = solve(nc, 'exact').result!;
    expect(j.reduction!.holds).toBe(false);
    expect(j.makespan.toString()).toBe('40');
    expect(ex.makespan.toString()).toBe('39');
    expect(ex.exact!.count).toBe(5);
  });
  it('CDS examples', () => {
    const c = solve(grab('seq-4m-cds'), 'cds').result!;
    expect(c.candidates!.map(x => x.makespan.toString())).toEqual(['52', '53', '51']);
    expect(solve(grab('seq-4m-cds'), 'exact').result!.makespan.toString()).toBe('51');
    expect(solve(grab('seq-4m-gap'), 'cds').result!.makespan.toString()).toBe('50');
    expect(solve(grab('seq-4m-gap'), 'exact').result!.makespan.toString()).toBe('49');
    expect(solve(grab('seq-ties'), 'exact').result!.exact!.count).toBe(10);
    expect(solve(grab('seq-taha'), 'johnson').result!.sequenceNames.join('')).toBe('BDCEA');
  });
});
