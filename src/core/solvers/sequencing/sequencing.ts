/**
 * Job sequencing: n jobs through m machines in the same order (flow shop), minimise the total elapsed time (makespan).
 *  - Johnson's rule (2 machines, exact) and its 3-machine reduction (exact only under a dominance condition)
 *  - Campbell–Dudek–Smith (CDS) heuristic for m ≥ 2 machines
 *  - exhaustive search over all n! sequences (n ≤ 9)
 * All arithmetic is exact (Rational). Nothing here throws on bad input: invalid models come back as `invalid-input`.
 */

import { Rational } from '../../math/rational';
import { Solution, Diagnostic } from '../../types/solver';
import { Step } from '../../types/step';
import { parseNum } from '../../../lib/numbers';

export type SeqMethod = 'johnson' | 'cds' | 'exact';

export const SEQ_LIMITS = { maxJobs: 200, maxMachines: 10, exactJobs: 9, maxNameLength: 24, maxValue: 1_000_000_000, maxDenominator: 1_000_000, maxCell: 40 } as const;

export interface SeqModel { jobs: string[]; machines: string[]; times: Rational[][] }

export interface SeqSpecLike { jobs: string[]; machines: string[]; times: string[][] }

/** The two "pseudo machines" Johnson's rule is applied to (the real machines when m = 2). */
export interface PseudoMachines { labels: [string, string]; a: Rational[]; b: Rational[] }

export interface MachineIdle {
  machine: number;
  busy: Rational;
  /** waiting for the first job to arrive */
  initial: Rational;
  /** idle between two consecutive jobs */
  gaps: Rational;
  /** idle after the last job until the whole batch is finished */
  tail: Rational;
  /** initial + gaps + tail = total elapsed time − busy */
  total: Rational;
}

export interface Timing {
  /** job indices in processing order */
  order: number[];
  /** [position][machine] */
  inT: Rational[][];
  outT: Rational[][];
  makespan: Rational;
  idle: MachineIdle[];
}

export interface GanttBar { pos: number; job: number; start: Rational; end: Rational }
export interface GanttIdle { start: Rational; end: Rational; kind: 'initial' | 'gap' | 'tail' }
export interface GanttData {
  makespan: Rational;
  rows: { machine: number; bars: GanttBar[]; idle: GanttIdle[] }[];
}

export interface CdsCandidate {
  k: number;
  pseudo: PseudoMachines;
  order: number[];
  makespan: Rational;
}

export interface Placement {
  job: number;
  side: 'front' | 'back';
  slot: number;
  value: Rational;
  /** 0 = first pseudo machine, 1 = second */
  on: 0 | 1;
  remaining: number[];
  /** other (job, machine) entries that share the minimum */
  tied: { job: number; on: 0 | 1 }[];
}

export interface SeqState {
  kind: 'data' | 'check' | 'place' | 'candidate' | 'pick' | 'enumerate' | 'timing' | 'result';
  jobs: string[];
  machines: string[];
  times: Rational[][];
  pseudo?: PseudoMachines;
  /** Johnson slot strip: job index per slot, null = free */
  slots?: (number | null)[];
  remaining?: number[];
  sequence?: number[];
  candidates?: CdsCandidate[];
  timing?: Timing;
}

export interface SeqResult {
  method: SeqMethod;
  jobs: string[];
  machines: string[];
  times: Rational[][];
  sequence: number[];
  sequenceNames: string[];
  makespan: Rational;
  timing: Timing;
  gantt: GanttData;
  /** true when the method proves the sequence optimal for this instance */
  guaranteedOptimal: boolean;
  guarantee: string;
  reduction?: { min1: Rational; max2: Rational; min3: Rational; holds: boolean };
  candidates?: CdsCandidate[];
  bestCandidate?: number;
  exact?: { optimum: Rational; count: number; examples: number[][]; total: number };
}

/* ------------------------------ input ------------------------------ */

export function buildSeqModel(spec: SeqSpecLike): { model: SeqModel | null; error: string | null } {
  const bad = (error: string) => ({ model: null, error });
  if (!spec || !Array.isArray(spec.jobs) || !Array.isArray(spec.machines) || !Array.isArray(spec.times)) return bad('The model is incomplete: jobs, machines and times are required.');
  const n = spec.jobs.length, m = spec.machines.length;
  if (n < 1) return bad('Add at least one job.');
  if (m < 2) return bad('Add at least two machines (a single machine has nothing to sequence).');
  if (n > SEQ_LIMITS.maxJobs) return bad(`Too many jobs: ${n}. The limit is ${SEQ_LIMITS.maxJobs}.`);
  if (m > SEQ_LIMITS.maxMachines) return bad(`Too many machines: ${m}. The limit is ${SEQ_LIMITS.maxMachines}.`);
  if (spec.times.length !== n || spec.times.some(r => !Array.isArray(r) || r.length !== m)) return bad(`The time table must have exactly ${n} rows (jobs) and ${m} columns (machines).`);
  const names = (list: unknown[], what: string): string | null => {
    const seen = new Set<string>();
    for (const [i, raw] of list.entries()) {
      if (typeof raw !== 'string') return `${what} ${i + 1}: the name must be text.`;
      const t = raw.trim();
      if (t === '') return `${what} ${i + 1} has no name. Every ${what.toLowerCase()} needs a non-empty name.`;
      if (t.length > SEQ_LIMITS.maxNameLength) return `${what} “${t.slice(0, 12)}…” has a name longer than ${SEQ_LIMITS.maxNameLength} characters.`;
      const key = t.toLowerCase();
      if (seen.has(key)) return `Two ${what.toLowerCase()}s are called “${t}”. Names must be unique.`;
      seen.add(key);
    }
    return null;
  };
  const e1 = names(spec.jobs, 'Job'); if (e1) return bad(e1);
  const e2 = names(spec.machines, 'Machine'); if (e2) return bad(e2);
  const times: Rational[][] = [];
  for (let i = 0; i < n; i++) {
    const row: Rational[] = [];
    for (let k = 0; k < m; k++) {
      const raw = spec.times[i]![k];
      const where = `Job “${spec.jobs[i]!.trim()}”, machine “${spec.machines[k]!.trim()}”`;
      if (typeof raw !== 'string') return bad(`${where}: the time must be text or a number.`);
      if (raw.length > SEQ_LIMITS.maxCell) return bad(`${where}: the entry is too long.`);
      const v = parseNum(raw);
      if (!v.ok) return bad(`${where}: ${v.error === 'empty' ? 'a processing time is missing' : v.error}.`);
      if (v.value.isNegative()) return bad(`${where}: a processing time cannot be negative (${raw.trim()}).`);
      if (v.value.n > BigInt(SEQ_LIMITS.maxValue) * v.value.d) return bad(`${where}: the time is too large (limit ${SEQ_LIMITS.maxValue.toLocaleString('en-US')}).`);
      if (v.value.d > BigInt(SEQ_LIMITS.maxDenominator)) return bad(`${where}: the fraction has too large a denominator (limit ${SEQ_LIMITS.maxDenominator.toLocaleString('en-US')}).`);
      row.push(v.value);
    }
    times.push(row);
  }
  return { model: { jobs: spec.jobs.map(s => s.trim()), machines: spec.machines.map(s => s.trim()), times }, error: null };
}

/** Validate an already-built model (direct callers of the solver). Returns an error message or null. */
export function validateSeqModel(model: SeqModel): string | null {
  if (!model || !Array.isArray(model.jobs) || !Array.isArray(model.machines) || !Array.isArray(model.times)) return 'The model is incomplete.';
  const n = model.jobs.length, m = model.machines.length;
  if (n < 1) return 'Add at least one job.';
  if (m < 2) return 'Add at least two machines.';
  if (n > SEQ_LIMITS.maxJobs) return `Too many jobs: ${n}. The limit is ${SEQ_LIMITS.maxJobs}.`;
  if (m > SEQ_LIMITS.maxMachines) return `Too many machines: ${m}. The limit is ${SEQ_LIMITS.maxMachines}.`;
  if (new Set(model.jobs).size !== n) return 'Job names must be unique.';
  if (new Set(model.machines).size !== m) return 'Machine names must be unique.';
  if (model.jobs.some(j => typeof j !== 'string' || j.trim() === '') || model.machines.some(j => typeof j !== 'string' || j.trim() === '')) return 'Names must not be empty.';
  if (model.times.length !== n || model.times.some(r => !Array.isArray(r) || r.length !== m)) return 'The time table must be jobs × machines.';
  for (const r of model.times) for (const v of r) if (!(v instanceof Rational) || v.isNegative()) return 'Processing times must be non-negative numbers.';
  return null;
}

/* ------------------------------ helpers ------------------------------ */

const R0 = Rational.ZERO;
const rmax = (a: Rational, b: Rational) => (a.gte(b) ? a : b);
const sum = (xs: Rational[]) => xs.reduce((s, x) => s.add(x), R0);
const names = (jobs: string[], order: number[]) => order.map(i => jobs[i]!);
const arrow = (list: string[]) => list.join(' → ');

/** In/out times of every job on every machine for a given sequence, and the idle-time breakdown. */
export function computeTiming(times: Rational[][], order: number[]): Timing {
  const m = times[0]?.length ?? 0;
  const inT: Rational[][] = [], outT: Rational[][] = [];
  for (let pos = 0; pos < order.length; pos++) {
    const p = times[order[pos]!]!;
    const ins: Rational[] = [], outs: Rational[] = [];
    for (let k = 0; k < m; k++) {
      const prevJob = pos > 0 ? outT[pos - 1]![k]! : R0;
      const prevMachine = k > 0 ? outs[k - 1]! : R0;
      const start = rmax(prevJob, prevMachine);
      ins.push(start);
      outs.push(start.add(p[k]!));
    }
    inT.push(ins); outT.push(outs);
  }
  const makespan = order.length ? outT[order.length - 1]![m - 1]! : R0;
  const idle: MachineIdle[] = [];
  for (let k = 0; k < m; k++) {
    const busy = sum(order.map(j => times[j]![k]!));
    const initial = order.length ? inT[0]![k]! : R0;
    let gaps = R0;
    for (let pos = 1; pos < order.length; pos++) gaps = gaps.add(inT[pos]![k]!.sub(outT[pos - 1]![k]!));
    const tail = order.length ? makespan.sub(outT[order.length - 1]![k]!) : R0;
    idle.push({ machine: k, busy, initial, gaps, tail, total: initial.add(gaps).add(tail) });
  }
  return { order: [...order], inT, outT, makespan, idle };
}

export function ganttOf(timing: Timing): GanttData {
  const m = timing.idle.length;
  const rows: GanttData['rows'] = [];
  for (let k = 0; k < m; k++) {
    const bars: GanttBar[] = [], idle: GanttIdle[] = [];
    let cursor = R0;
    timing.order.forEach((job, pos) => {
      const s = timing.inT[pos]![k]!, e = timing.outT[pos]![k]!;
      if (s.gt(cursor)) idle.push({ start: cursor, end: s, kind: pos === 0 ? 'initial' : 'gap' });
      bars.push({ pos, job, start: s, end: e });
      cursor = e;
    });
    if (timing.makespan.gt(cursor)) idle.push({ start: cursor, end: timing.makespan, kind: 'tail' });
    rows.push({ machine: k, bars, idle });
  }
  return { makespan: timing.makespan, rows };
}

/** Makespan only (no allocation of the full table) — used by CDS and the comparison. */
export function makespanOf(times: Rational[][], order: number[]): Rational {
  const m = times[0]?.length ?? 0;
  let c: Rational[] = Array.from({ length: m }, () => R0);
  for (const j of order) {
    const p = times[j]!;
    const next: Rational[] = [];
    for (let k = 0; k < m; k++) next.push(rmax(c[k]!, k > 0 ? next[k - 1]! : R0).add(p[k]!));
    c = next;
  }
  return c[m - 1] ?? R0;
}

/**
 * Johnson's rule on two (pseudo) machines. Repeatedly take the smallest remaining processing time over both machines;
 * if it is on machine 1 the job goes to the front-most free slot, if on machine 2 to the back-most free slot.
 * Ties: machine 1 before machine 2, then the job listed first.
 */
export function johnsonPlan(a: Rational[], b: Rational[]): Placement[] {
  const n = a.length;
  let remaining = Array.from({ length: n }, (_, i) => i);
  let front = 0, back = n - 1;
  const out: Placement[] = [];
  while (remaining.length) {
    let best: { job: number; on: 0 | 1; value: Rational } | null = null;
    for (const j of remaining) {
      if (best === null || a[j]!.lt(best.value)) best = { job: j, on: 0, value: a[j]! };
    }
    for (const j of remaining) {
      if (best !== null && b[j]!.lt(best.value)) best = { job: j, on: 1, value: b[j]! };
    }
    if (best === null) break;
    const v = best.value;
    const tied: Placement['tied'] = [];
    for (const j of remaining) {
      if (a[j]!.eq(v) && !(j === best.job && best.on === 0)) tied.push({ job: j, on: 0 });
      if (b[j]!.eq(v) && !(j === best.job && best.on === 1)) tied.push({ job: j, on: 1 });
    }
    const side = best.on === 0 ? 'front' : 'back';
    const slot = side === 'front' ? front++ : back--;
    out.push({ job: best.job, side, slot, value: v, on: best.on, remaining: [...remaining], tied });
    remaining = remaining.filter(j => j !== best!.job);
  }
  return out;
}

export function johnsonOrder(a: Rational[], b: Rational[]): number[] {
  const slots: number[] = new Array(a.length).fill(-1);
  for (const p of johnsonPlan(a, b)) slots[p.slot] = p.job;
  return slots;
}

/* ------------------------------ exact search ------------------------------ */

function gcdB(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a < 0n ? -a : a; }

interface ExactOut { optimum: number; count: number; examples: number[][]; scale: bigint }

/** Enumerate all sequences with prefix pruning (strictly worse than the incumbent). Integers only: times are scaled to a common denominator. */
function exactSearch(times: Rational[][], upper: Rational, upperOrder: number[]): ExactOut | null {
  const n = times.length, m = times[0]!.length;
  let scale = 1n;
  for (const r of times) for (const v of r) scale = (scale / gcdB(scale, v.d)) * v.d;
  const p: number[][] = [];
  let total = 0n;
  for (const r of times) {
    const row: number[] = [];
    for (const v of r) { const x = (v.n * scale) / v.d; total += x; row.push(Number(x)); }
    p.push(row);
  }
  if (total > 2n ** 50n) return null;
  let bestV = Number((upper.n * scale) / upper.d);
  let count = 0;
  let examples: number[][] = [];
  const used = new Array<boolean>(n).fill(false);
  const seq: number[] = [];
  const C: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m).fill(0));
  const rec = (d: number) => {
    if (d === n) {
      const v = C[d]![m - 1]!;
      if (v < bestV) { bestV = v; count = 1; examples = [seq.slice()]; }
      else if (v === bestV) { count++; if (examples.length < 6) examples.push(seq.slice()); }
      return;
    }
    const cur = C[d]!, nxt = C[d + 1]!;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const pj = p[j]!;
      let prev = 0;
      for (let k = 0; k < m; k++) { prev = (cur[k]! > prev ? cur[k]! : prev) + pj[k]!; nxt[k] = prev; }
      if (prev > bestV) continue;
      used[j] = true; seq.push(j);
      rec(d + 1);
      seq.pop(); used[j] = false;
    }
  };
  rec(0);
  if (count === 0) { count = 1; examples = [upperOrder.slice()]; }
  return { optimum: bestV, count, examples, scale };
}

/* ------------------------------ solver ------------------------------ */

interface Ctx { model: SeqModel; steps: Step<SeqState>[]; emit: boolean }

function push(ctx: Ctx, s: Omit<Step<SeqState>, 'index' | 'status'> & { index?: number; status?: Step<SeqState>['status'] }) {
  if (!ctx.emit) return;
  ctx.steps.push({ ...s, index: ctx.steps.length, status: s.status ?? (ctx.steps.length === 0 ? 'initial' : 'continue') });
}

const base = (ctx: Ctx, kind: SeqState['kind']): SeqState => ({ kind, jobs: ctx.model.jobs, machines: ctx.model.machines, times: ctx.model.times });

/** Emit one explained step per Johnson placement and return the resulting order. */
function emitJohnson(ctx: Ctx, ps: PseudoMachines, phasePrefix: string): number[] {
  const { jobs } = ctx.model;
  const n = jobs.length;
  const plan = johnsonPlan(ps.a, ps.b);
  const slots: (number | null)[] = new Array(n).fill(null);
  const [m1, m2] = ps.labels;
  plan.forEach((pl, t) => {
    slots[pl.slot] = pl.job;
    const jn = jobs[pl.job]!;
    const mach = pl.on === 0 ? m1 : m2;
    const where = pl.side === 'front' ? `the front-most free slot (slot ${pl.slot + 1})` : `the back-most free slot (slot ${pl.slot + 1})`;
    const tieText = pl.tied.length
      ? ` The same value ${pl.value.toString()} also appears for ${pl.tied.map(x => `${jobs[x.job]} on ${x.on === 0 ? m1 : m2}`).join(', ')}; ties may be broken arbitrarily without losing optimality — here machine 1 is preferred, then the job listed first.`
      : '';
    push(ctx, {
      index: 0,
      phase: `${phasePrefix}Place ${t + 1}/${n}`,
      state: { ...base(ctx, 'place'), pseudo: ps, slots: [...slots], remaining: pl.remaining.filter(j => j !== pl.job), sequence: undefined },
      action: { kind: 'place', payload: { job: jn, jobIndex: pl.job, side: pl.side, slot: pl.slot, value: pl.value.toString(), machine: pl.on + 1 } },
      explanation: {
        short: `Smallest remaining time is ${pl.value.toString()} (job ${jn} on ${mach}) → ${jn} goes to ${where}.`,
        detailed: `Among the ${pl.remaining.length} unscheduled job${pl.remaining.length === 1 ? '' : 's'} (${names(jobs, pl.remaining).join(', ')}) the smallest processing time over both machines is ${pl.value.toString()}, belonging to job ${jn} on ${mach}. ${pl.on === 0 ? `It is on the first machine, so the job should start early to keep the second machine fed: it takes ${where}.` : `It is on the second machine, so the job should finish late and its short second operation sits at the end: it takes ${where}.`}${tieText}`,
        rule: 'Johnson’s rule',
        note: pl.tied.length ? 'Tie: more than one entry has the minimum value.' : undefined,
      },
      highlights: [{ target: `job:${jn}`, intent: 'entering' }, { target: `slot:${pl.slot}`, intent: 'pivot' }, ...pl.tied.map(x => ({ target: `job:${jobs[x.job]}`, intent: 'candidate' as const }))],
      status: 'continue',
    });
  });
  return slots.map(s => s ?? 0);
}

function pseudoTwo(model: SeqModel): PseudoMachines {
  return { labels: [model.machines[0]!, model.machines[1]!], a: model.times.map(r => r[0]!), b: model.times.map(r => r[1]!) };
}

function dataStep(ctx: Ctx, method: SeqMethod, extra: string) {
  const { jobs, machines, times } = ctx.model;
  const total = sum(times.flat());
  push(ctx, {
    index: 0, phase: 'Data', state: base(ctx, 'data'), action: null,
    explanation: {
      short: `${jobs.length} job${jobs.length === 1 ? '' : 's'} through ${machines.length} machines in the order ${machines.join(' → ')}; minimise the total elapsed time.`,
      detailed: `Every job visits the machines in the same order (${machines.join(' → ')}) and a machine handles one job at a time. The total elapsed time is the moment the last job leaves the last machine. The sum of all processing times is ${total.toString()}, which no sequence can beat per machine; what a good sequence reduces is the idle time. ${extra}`,
      rule: method === 'johnson' ? 'Johnson’s rule' : method === 'cds' ? 'Campbell–Dudek–Smith heuristic' : 'Exhaustive enumeration',
    },
    highlights: [],
    status: 'initial',
  });
}

function timingSteps(ctx: Ctx, order: number[], res: { method: SeqMethod; guaranteedOptimal: boolean; guarantee: string }) {
  const { jobs, machines, times } = ctx.model;
  const timing = computeTiming(times, order);
  const seqNames = names(jobs, order);
  const last = machines.length;
  push(ctx, {
    index: 0, phase: 'Timing',
    state: { ...base(ctx, 'timing'), sequence: order, timing },
    action: { kind: 'schedule', payload: { sequence: seqNames } },
    explanation: {
      short: `Sequence ${arrow(seqNames.length > 14 ? [...seqNames.slice(0, 12), '…', seqNames[seqNames.length - 1]!] : seqNames)}: the last job leaves ${machines[last - 1]} at time ${timing.makespan.toString()}.`,
      detailed: `Process the jobs in this sequence. A job starts on a machine as soon as both (i) the previous job has left that machine and (ii) this job has left the previous machine. So in(job, machine) = max(out(previous job, machine), out(job, previous machine)) and out = in + processing time. Working through the table gives a total elapsed time of ${timing.makespan.toString()}.`,
      formula: '\\text{in}_{j,k}=\\max\\bigl(\\text{out}_{j-1,k},\\ \\text{out}_{j,k-1}\\bigr),\\quad \\text{out}_{j,k}=\\text{in}_{j,k}+p_{j,k}',
      rule: 'Forward pass of in/out times',
    },
    highlights: seqNames.map(j => ({ target: `job:${j}`, intent: 'optimal' as const })),
    status: 'continue',
  });
  const idleText = timing.idle.map(x => `${machines[x.machine]}: ${x.total.toString()}`).join(', ');
  push(ctx, {
    index: 0, phase: 'Result',
    state: { ...base(ctx, 'result'), sequence: order, timing },
    action: null,
    explanation: {
      short: `Total elapsed time ${timing.makespan.toString()}; idle time — ${idleText}.`,
      detailed: `Idle time of a machine = total elapsed time − the sum of its processing times (initial wait + gaps between jobs + waiting at the end). ${res.guarantee}`,
      rule: 'Idle time = elapsed − busy',
      note: res.guaranteedOptimal ? undefined : res.guarantee,
    },
    highlights: [],
    status: 'optimal',
  });
  return timing;
}

function finish(ctx: Ctx, method: SeqMethod, order: number[], g: { guaranteedOptimal: boolean; guarantee: string }, extra: Partial<SeqResult>, diagnostics: Diagnostic[], t0: number): Solution<SeqState, SeqResult> {
  const { model } = ctx;
  const timing = timingSteps(ctx, order, { method, ...g });
  const result: SeqResult = {
    method, jobs: model.jobs, machines: model.machines, times: model.times, sequence: order, sequenceNames: names(model.jobs, order),
    makespan: timing.makespan, timing, gantt: ganttOf(timing), guaranteedOptimal: g.guaranteedOptimal, guarantee: g.guarantee, ...extra,
  };
  return { steps: ctx.steps, result, status: 'optimal', diagnostics, metrics: { iterations: ctx.steps.length, elapsedMs: Date.now() - t0, degradedToFloat: false } };
}

function invalid(message: string, code = 'INVALID_INPUT', t0 = Date.now()): Solution<SeqState, SeqResult> {
  return { steps: [], result: null, status: 'invalid-input', diagnostics: [{ severity: 'error', code, message }], metrics: { iterations: 0, elapsedMs: Date.now() - t0, degradedToFloat: false } };
}

export function solveSequencing(model: SeqModel, method: SeqMethod, options: { emitSteps?: boolean } = {}): Solution<SeqState, SeqResult> {
  const t0 = Date.now();
  try {
    const err = validateSeqModel(model);
    if (err) return invalid(err, 'INVALID_INPUT', t0);
    const n = model.jobs.length, m = model.machines.length;
    const ctx: Ctx = { model, steps: [], emit: options.emitSteps !== false };
    const diagnostics: Diagnostic[] = [];

    /* ---------------- Johnson ---------------- */
    if (method === 'johnson') {
      if (m > 3) return invalid(`Johnson’s rule handles two machines (and three under a dominance condition). With ${m} machines use the CDS heuristic or the Exact search.`, 'INPUT_LIMIT', t0);
      if (m === 2) {
        const ps = pseudoTwo(model);
        dataStep(ctx, 'johnson', 'With two machines Johnson’s rule is exact: it fills the sequence from both ends, always using the smallest remaining processing time.');
        const order = emitJohnson(ctx, ps, '');
        return finish(ctx, 'johnson', order, { guaranteedOptimal: true, guarantee: 'Johnson’s rule is optimal for two machines: no other sequence has a smaller total elapsed time.' }, {}, diagnostics, t0);
      }
      // three machines
      const c1 = model.times.map(r => r[0]!), c2 = model.times.map(r => r[1]!), c3 = model.times.map(r => r[2]!);
      const min1 = c1.reduce((a, b) => (b.lt(a) ? b : a)), min3 = c3.reduce((a, b) => (b.lt(a) ? b : a)), max2 = c2.reduce((a, b) => (b.gt(a) ? b : a));
      const holds = min1.gte(max2) || min3.gte(max2);
      const [M1, M2, M3] = model.machines as [string, string, string];
      const ps: PseudoMachines = { labels: [`${M1}+${M2}`, `${M2}+${M3}`], a: c1.map((x, i) => x.add(c2[i]!)), b: c2.map((x, i) => x.add(c3[i]!)) };
      dataStep(ctx, 'johnson', 'Three machines: Johnson’s rule is applied to two pseudo machines (M1+M2 and M2+M3), which is exact only if the middle machine never constrains the flow.');
      const guarantee = holds
        ? `The dominance condition holds, so the reduced two-machine problem has the same optimal sequences as the original: the result is optimal.`
        : `The dominance condition fails, so optimality is NOT guaranteed — the sequence is a good heuristic only. Run Exact (n ≤ 9) to confirm, or compare with CDS.`;
      push(ctx, {
        index: 0, phase: 'Check',
        state: { ...base(ctx, 'check'), pseudo: ps },
        action: { kind: 'check', payload: { min1: min1.toString(), max2: max2.toString(), min3: min3.toString(), holds } },
        explanation: {
          short: holds ? `Condition holds (min ${M1} = ${min1.toString()}, max ${M2} = ${max2.toString()}, min ${M3} = ${min3.toString()}): reduce to ${ps.labels[0]} and ${ps.labels[1]}.` : `Condition FAILS (min ${M1} = ${min1.toString()}, max ${M2} = ${max2.toString()}, min ${M3} = ${min3.toString()}): the reduction may not be optimal.`,
          detailed: `The 3-machine reduction is exact when min(${M1}) ≥ max(${M2}) or min(${M3}) ≥ max(${M2}). Here min(${M1}) = ${min1.toString()}, max(${M2}) = ${max2.toString()}, min(${M3}) = ${min3.toString()}, so ${min1.gte(max2) ? `min(${M1}) ≥ max(${M2}) is true` : `min(${M1}) ≥ max(${M2}) is false`} and ${min3.gte(max2) ? `min(${M3}) ≥ max(${M2}) is true` : `min(${M3}) ≥ max(${M2}) is false`}. ${guarantee} Pseudo times: ${ps.labels[0]} = (${ps.a.map(x => x.toString()).join(', ')}), ${ps.labels[1]} = (${ps.b.map(x => x.toString()).join(', ')}).`,
          rule: '3-machine reduction condition',
          formula: '\\min p_{1}\\ \\ge\\ \\max p_{2}\\quad\\text{or}\\quad \\min p_{3}\\ \\ge\\ \\max p_{2}',
          note: holds ? undefined : 'Optimality is not guaranteed.',
        },
        highlights: [],
        status: 'continue',
      });
      if (!holds) diagnostics.push({ severity: 'warning', code: 'REDUCTION_NOT_GUARANTEED', message: 'The three-machine dominance condition fails: Johnson’s reduction is not guaranteed to be optimal. Use Exact (n ≤ 9) to confirm, or CDS.' });
      const order = emitJohnson(ctx, ps, '');
      return finish(ctx, 'johnson', order, { guaranteedOptimal: holds, guarantee }, { reduction: { min1, max2, min3, holds } }, diagnostics, t0);
    }

    /* ---------------- CDS ---------------- */
    if (method === 'cds') {
      dataStep(ctx, 'cds', `CDS builds ${m - 1} candidate sequence${m - 1 === 1 ? '' : 's'}: candidate k adds up the first k machines and the last k machines to get two pseudo machines, applies Johnson’s rule to them, and the best real makespan wins.`);
      const cands: CdsCandidate[] = [];
      for (let k = 1; k <= m - 1; k++) {
        const a = model.times.map(r => sum(r.slice(0, k))), b = model.times.map(r => sum(r.slice(m - k)));
        const ps: PseudoMachines = { labels: [k === 1 ? model.machines[0]! : `${model.machines[0]}…${model.machines[k - 1]}`, k === 1 ? model.machines[m - 1]! : `${model.machines[m - k]}…${model.machines[m - 1]}`], a, b };
        const order = johnsonOrder(a, b);
        const ms = makespanOf(model.times, order);
        cands.push({ k, pseudo: ps, order, makespan: ms });
        const seqN = names(model.jobs, order);
        push(ctx, {
          index: 0, phase: `Candidate ${k}/${m - 1}`,
          state: { ...base(ctx, 'candidate'), pseudo: ps, sequence: order, candidates: [...cands] },
          action: { kind: 'candidate', payload: { k, sequence: seqN, makespan: ms.toString() } },
          explanation: {
            short: `k = ${k}: Johnson on (${ps.labels[0]}, ${ps.labels[1]}) gives ${arrow(seqN.length > 14 ? [...seqN.slice(0, 12), '…'] : seqN)}, real makespan ${ms.toString()}.`,
            detailed: `For k = ${k}, pseudo machine 1 is the sum of the first ${k} machine${k === 1 ? '' : 's'} and pseudo machine 2 the sum of the last ${k}. Applying Johnson’s rule to these two columns gives the sequence ${seqN.join(', ')}. Evaluating that sequence on all ${m} real machines gives a total elapsed time of ${ms.toString()}.`,
            rule: 'Johnson on aggregated machines',
          },
          highlights: [],
          status: 'continue',
        });
      }
      let bi = 0;
      cands.forEach((c, i) => { if (c.makespan.lt(cands[bi]!.makespan)) bi = i; });
      const best = cands[bi]!;
      push(ctx, {
        index: 0, phase: 'Pick best',
        state: { ...base(ctx, 'pick'), sequence: best.order, candidates: cands },
        action: { kind: 'pick', payload: { k: best.k } },
        explanation: {
          short: `Best candidate: k = ${best.k} with total elapsed time ${best.makespan.toString()}.`,
          detailed: `Candidates give total elapsed times ${cands.map(c => `k=${c.k}: ${c.makespan.toString()}`).join(', ')}. The smallest is ${best.makespan.toString()} (k = ${best.k}; the smallest k wins a tie), so that sequence is selected.`,
          rule: 'Best of the m−1 candidates',
        },
        highlights: [],
        status: 'continue',
      });
      const guaranteed = m === 2;
      const guarantee = guaranteed ? 'With two machines CDS is exactly Johnson’s rule, which is optimal.' : 'CDS is a heuristic for three or more machines: the sequence is usually very good but not proven optimal. Compare with Exact (n ≤ 9).';
      return finish(ctx, 'cds', best.order, { guaranteedOptimal: guaranteed, guarantee }, { candidates: cands, bestCandidate: bi }, diagnostics, t0);
    }

    /* ---------------- Exact ---------------- */
    if (n > SEQ_LIMITS.exactJobs) return invalid(`Exact search is limited to ${SEQ_LIMITS.exactJobs} jobs (${SEQ_LIMITS.exactJobs}! = 362,880 sequences); this model has ${n}. Use the CDS heuristic instead.`, 'INPUT_LIMIT', t0);
    // incumbent from CDS (always feasible) for pruning
    const seed = solveSequencing(model, 'cds', { emitSteps: false }).result;
    if (!seed) return invalid('Could not seed the exact search.', 'INVALID_INPUT', t0);
    const ex = exactSearch(model.times, seed.makespan, seed.sequence);
    if (!ex) return invalid('The numbers are too large or too fine (many different denominators) for an exact enumeration. Use simpler values or the CDS heuristic.', 'INPUT_LIMIT', t0);
    const optimum = Rational.of(BigInt(ex.optimum), ex.scale);
    let total = 1; for (let i = 2; i <= n; i++) total *= i;
    dataStep(ctx, 'exact', `All ${n}! = ${total.toLocaleString('en-US')} sequences are evaluated (with branches cut once they exceed the best known total) and the smallest total elapsed time is reported.`);
    // prefer the heuristic's own sequence when it is already optimal (familiar to the student), otherwise the first optimum found
    const best = seed.makespan.eq(optimum) ? seed.sequence : ex.examples[0]!;
    push(ctx, {
      index: 0, phase: 'Enumerate',
      state: { ...base(ctx, 'enumerate'), sequence: best },
      action: { kind: 'enumerate', payload: { count: ex.count, optimum: optimum.toString() } },
      explanation: {
        short: `Smallest total elapsed time over all ${total.toLocaleString('en-US')} sequences is ${optimum.toString()}; ${ex.count} sequence${ex.count === 1 ? ' attains' : 's attain'} it.`,
        detailed: `Every ordering of the ${n} jobs was considered. The minimum total elapsed time is ${optimum.toString()}. ${ex.count} of the ${total.toLocaleString('en-US')} sequences reach it${ex.count > 1 ? `, for example ${ex.examples.slice(0, 3).map(o => names(model.jobs, o).join('')).join(', ')} (job initials joined)` : ''}. The first one in listing order is used below.`,
        rule: 'Exhaustive enumeration',
      },
      highlights: [],
      status: 'continue',
    });
    const guarantee = 'Exhaustive enumeration: no sequence has a smaller total elapsed time.';
    return finish(ctx, 'exact', best, { guaranteedOptimal: true, guarantee }, { exact: { optimum, count: ex.count, examples: ex.examples, total } }, diagnostics, t0);
  } catch (e) {
    return invalid(`The sequencing solver stopped unexpectedly (${e instanceof Error ? e.message : 'unknown error'}).`, 'INTERNAL', t0);
  }
}
