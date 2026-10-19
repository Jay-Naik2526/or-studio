/**
 * Periodic-review (order-up-to) inventory simulation driven by random-number-interval tables.
 *
 * Timeline of day t (t = 1…T):
 *   begin_t   = ending stock of day t−1 (initial stock on day 1)
 *   arrival_t = orders whose arrival day is t, received at the start of the day
 *   demand_t  = drawn from the demand table with random number t
 *   sales_t   = min(begin + arrival, demand + backlog carried in)           (backlog is always 0 when sales are lost)
 *   end_t     = begin + arrival − sales
 *   shortage_t= backlog_in + demand − sales       (units still unmet at the end of the day)
 *   If t is a multiple of R (and t < T), the inventory position  end − backlog + on order  is compared with S and
 *   S − position units are ordered when positive. A lead time of L days means the order arrives at the start of day t + L + 1
 *   (L = 0: next morning). Lead times come from a fixed value or a random-number-interval table.
 * Costs: ordering cost per order placed, holding cost per unit of ending stock per day, shortage cost per unit short per day.
 */
import { Step } from '../../types/step';
import { buildIntervals, mapRn, padRn, fmt, Convention, IntervalTable, MAX_DAYS, STEP_DAYS, generateRandomNumbers } from './demandTable';

export interface InventoryInput {
  demandValues: number[]; demandProbs: number[];
  /** lead-time table; leave empty to use leadFixed */
  leadValues: number[]; leadProbs: number[]; leadFixed: number;
  digits: number; convention: Convention;
  demandRns: number[]; leadRns: number[];
  days: number; S: number; R: number; initial: number;
  orderCost: number; holdCost: number; shortCost: number; backorders: boolean;
}

export interface InvDay {
  day: number; begin: number; arrival: number; backlogIn: number;
  rn: number; rnLabel: string; demand: number; sales: number; end: number; shortage: number;
  position: number; ordered: number; leadRn?: number; leadTime?: number; arrivesDay?: number;
  orderCostDay: number; holdCostDay: number; shortCostDay: number; costDay: number;
}

export interface InvTotals {
  orders: number; orderCost: number; holdCost: number; shortCost: number; total: number; avgPerDay: number;
  demand: number; sales: number; shortUnits: number; endStock: number; fillRate: number; avgInventory: number; outstanding: number;
}

export interface InventorySim {
  error?: string; warnings: string[];
  days: InvDay[]; totals: InvTotals;
  demandTable?: IntervalTable; leadTable?: IntervalTable;
  input?: InventoryInput;
}

const emptyTotals = (): InvTotals => ({ orders: 0, orderCost: 0, holdCost: 0, shortCost: 0, total: 0, avgPerDay: 0, demand: 0, sales: 0, shortUnits: 0, endStock: 0, fillRate: 1, avgInventory: 0, outstanding: 0 });
const fail = (error: string): InventorySim => ({ error, warnings: [], days: [], totals: emptyTotals() });

/** number of lead-time random numbers a run can consume */
export const ordersPossible = (days: number, R: number) => Math.floor((days - 1) / R);

export function validateInventory(i: InventoryInput): string | null {
  const intNN = (x: number, label: string, max = 1e9) => (!Number.isInteger(x) || x < 0 || x > max ? `${label} must be a whole number from 0 to ${max.toLocaleString()}.` : null);
  if (!Number.isInteger(i.days) || i.days < 1 || i.days > MAX_DAYS) return `Days must be a whole number from 1 to ${MAX_DAYS.toLocaleString()}.`;
  if (!Number.isInteger(i.R) || i.R < 1 || i.R > MAX_DAYS) return 'Review period R must be a whole number of days, at least 1.';
  const e = intNN(i.S, 'Order-up-to level S') ?? intNN(i.initial, 'Initial stock');
  if (e) return e;
  for (const [x, l] of [[i.orderCost, 'Ordering cost'], [i.holdCost, 'Holding cost'], [i.shortCost, 'Shortage cost']] as [number, string][]) if (!Number.isFinite(x) || x < 0) return `${l} must be a number that is not negative.`;
  if (i.demandValues.some(v => !Number.isInteger(v) || v < 0)) return 'Demand values must be whole numbers that are not negative.';
  if (i.leadProbs.length === 0 && (!Number.isInteger(i.leadFixed) || i.leadFixed < 0 || i.leadFixed > 365)) return 'The lead time must be a whole number of days from 0 to 365.';
  if (i.leadValues.some(v => !Number.isInteger(v) || v < 0 || v > 365)) return 'Lead-time values must be whole numbers of days from 0 to 365.';
  return null;
}

/** Core day loop. detail = false skips the per-day rows (used by the policy search). */
function run(i: InventoryInput, S: number, dt: IntervalTable, lt: IntervalTable | null, detail: boolean): { days: InvDay[]; totals: InvTotals } {
  const T = i.days;
  const days: InvDay[] = [];
  const pipeline = new Map<number, number>();
  let onOrder = 0, end = i.initial, backlog = 0, orderIdx = 0;
  const tot = emptyTotals();
  let endSum = 0;
  for (let t = 1; t <= T; t++) {
    const begin = end, backlogIn = backlog;
    const arrival = pipeline.get(t) ?? 0;
    if (arrival) { pipeline.delete(t); onOrder -= arrival; }
    const rn = i.demandRns[t - 1]!;
    const demand = dt.intervals[mapRn(dt, rn)]!.value;
    const avail = begin + arrival;
    const sales = i.backorders ? Math.min(avail, demand + backlogIn) : Math.min(avail, demand);
    end = avail - sales;
    const shortage = backlogIn + demand - sales;
    backlog = i.backorders ? shortage : 0;
    let ordered = 0, leadRn: number | undefined, leadTime: number | undefined, arrivesDay: number | undefined;
    const position = end - backlog + onOrder;
    if (t % i.R === 0 && t < T && position < S) {
      ordered = S - position;
      if (lt) { leadRn = i.leadRns[orderIdx]!; leadTime = lt.intervals[mapRn(lt, leadRn)]!.value; } else leadTime = i.leadFixed;
      orderIdx++;
      arrivesDay = t + leadTime + 1;
      pipeline.set(arrivesDay, (pipeline.get(arrivesDay) ?? 0) + ordered);
      onOrder += ordered;
    }
    const oc = ordered > 0 ? i.orderCost : 0, hc = i.holdCost * end, sc = i.shortCost * shortage;
    tot.orders += ordered > 0 ? 1 : 0; tot.orderCost += oc; tot.holdCost += hc; tot.shortCost += sc;
    tot.demand += demand; tot.sales += sales; endSum += end;
    if (detail) days.push({ day: t, begin, arrival, backlogIn, rn, rnLabel: padRn(rn, i.digits), demand, sales, end, shortage, position, ordered, leadRn, leadTime, arrivesDay, orderCostDay: oc, holdCostDay: hc, shortCostDay: sc, costDay: oc + hc + sc });
  }
  tot.shortUnits = backlog + (i.backorders ? 0 : tot.demand - tot.sales);
  tot.total = tot.orderCost + tot.holdCost + tot.shortCost;
  tot.avgPerDay = tot.total / T;
  tot.endStock = end;
  tot.fillRate = tot.demand > 0 ? tot.sales / tot.demand : 1;
  tot.avgInventory = endSum / T;
  tot.outstanding = onOrder;
  return { days, totals: tot };
}

export function simulateInventory(i: InventoryInput): InventorySim {
  const bad = validateInventory(i);
  if (bad) return fail(bad);
  const dt = buildIntervals(i.demandValues, i.demandProbs, i.digits, i.convention);
  if (dt.error) return fail(`Demand table: ${dt.error}`);
  let lt: IntervalTable | null = null;
  if (i.leadProbs.length) {
    lt = buildIntervals(i.leadValues, i.leadProbs, i.digits, i.convention);
    if (lt.error) return fail(`Lead-time table: ${lt.error}`);
  }
  if (i.demandRns.length < i.days) return fail(`${i.days} days need ${i.days} demand random numbers, but only ${i.demandRns.length} were given.`);
  const needLead = lt ? ordersPossible(i.days, i.R) : 0;
  if (lt && i.leadRns.length < needLead) return fail(`Up to ${needLead} orders can be placed, each needing a lead-time random number, but only ${i.leadRns.length} were given.`);
  const warnings = [...dt.warnings.map(w => `Demand table: ${w}`), ...(lt?.warnings ?? []).map(w => `Lead-time table: ${w}`)];
  if (i.initial > i.S) warnings.push(`The initial stock (${i.initial}) is above S (${i.S}); no order is placed until the stock falls.`);
  const r = run(i, i.S, dt, lt, true);
  return { warnings, days: r.days, totals: r.totals, demandTable: dt, leadTable: lt ?? undefined, input: i };
}

export interface PolicyRow { S: number; orders: number; orderCost: number; holdCost: number; shortCost: number; total: number; avgPerDay: number; fillRate: number }
export interface PolicySearch { error?: string; rows: PolicyRow[]; best: number; bestS: number }

/** Re-run the same random numbers for S = from, from+step, … ≤ to and pick the cheapest policy (ties → smaller S). */
export function policySearch(i: InventoryInput, from: number, to: number, step: number): PolicySearch {
  const none = (error: string): PolicySearch => ({ error, rows: [], best: -1, bestS: NaN });
  if (![from, to, step].every(Number.isFinite) || !Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(step)) return none('The S range (from, to, step) must be whole numbers.');
  if (from < 0 || to < from || step < 1) return none('Policy search needs 0 ≤ from ≤ to and a step of at least 1.');
  const count = Math.floor((to - from) / step) + 1;
  if (count > 400) return none(`The search would try ${count} values of S; narrow the range or enlarge the step (at most 400).`);
  if (count * i.days > 6e6) return none('The search is too large for this many days; shorten the run or narrow the range.');
  const check = validateInventory({ ...i, S: from });
  if (check) return none(check);
  const dt = buildIntervals(i.demandValues, i.demandProbs, i.digits, i.convention);
  if (dt.error) return none(dt.error);
  const lt = i.leadProbs.length ? buildIntervals(i.leadValues, i.leadProbs, i.digits, i.convention) : null;
  if (lt?.error) return none(lt.error);
  if (i.demandRns.length < i.days || (lt && i.leadRns.length < ordersPossible(i.days, i.R))) return none('Not enough random numbers for the policy search.');
  const rows: PolicyRow[] = [];
  let best = 0;
  for (let k = 0, S = from; k < count; k++, S += step) {
    const t = run(i, S, dt, lt, false).totals;
    rows.push({ S, orders: t.orders, orderCost: t.orderCost, holdCost: t.holdCost, shortCost: t.shortCost, total: t.total, avgPerDay: t.avgPerDay, fillRate: t.fillRate });
    if (t.total < rows[best]!.total - 1e-12) best = k;
  }
  return { rows, best, bestS: rows[best]!.S };
}

/** Random numbers for a generated run: demand from the seed, lead times from an independent stream. */
export function generateInventoryRns(days: number, R: number, digits: number, generator: 'lcg' | 'mt', seed: number, convention: Convention): { demandRns: number[]; leadRns: number[] } {
  return {
    demandRns: generateRandomNumbers(days, digits, generator, seed, convention),
    leadRns: generateRandomNumbers(Math.max(1, ordersPossible(days, R)), digits, generator, seed + 104729, convention),
  };
}

/* ------------------------------ step-by-step walkthrough ------------------------------ */

export interface InvStepState { phase: 'setup' | 'day' | 'summary'; day: number }

export function inventorySteps(sim: InventorySim): Step<InvStepState>[] {
  if (sim.error || !sim.input || !sim.demandTable) return [];
  const i = sim.input;
  const steps: Step<InvStepState>[] = [];
  const push = (phase: string, state: InvStepState, short: string, detailed: string, rule: string, note?: string) =>
    steps.push({ index: steps.length, phase, state, action: { kind: state.phase, payload: state }, explanation: { short, detailed, rule, note }, highlights: [], status: 'continue' });
  push('Setup', { phase: 'setup', day: 0 },
    `Order up to S = ${i.S} every R = ${i.R} day${i.R > 1 ? 's' : ''}, starting with ${i.initial} unit${i.initial === 1 ? '' : 's'} in stock.`,
    `Every ${i.R} day${i.R > 1 ? 's' : ''}, at the end of the day, the inventory position (stock on hand − backorders + units on order) is compared with S = ${i.S}; if it is lower, the difference is ordered. ${sim.leadTable ? 'The lead time of each order is drawn from the lead-time table.' : `Every order arrives after ${i.leadFixed} day${i.leadFixed === 1 ? '' : 's'} of lead time (it is received at the start of day t + ${i.leadFixed + 1} when ordered at the end of day t).`} Unmet demand is ${i.backorders ? 'backordered and filled when stock arrives' : 'lost'}. Costs: ${fmt(i.orderCost)} per order, ${fmt(i.holdCost)} per unit of ending stock per day, ${fmt(i.shortCost)} per unit short per day.`,
    'Periodic-review (R, S) policy', sim.warnings[0]);
  const shown = Math.min(sim.days.length, STEP_DAYS);
  for (let k = 0; k < shown; k++) {
    const d = sim.days[k]!;
    const ord = d.ordered > 0 ? ` Order ${d.ordered} placed, arriving at the start of day ${d.arrivesDay}${d.arrivesDay! > i.days ? ' (after the horizon)' : ''}.` : '';
    push(`Day ${d.day}`, { phase: 'day', day: d.day },
      `Day ${d.day}: demand ${d.demand}, sales ${d.sales}, ending stock ${d.end}${d.shortage ? `, short ${d.shortage}` : ''}${d.ordered ? `, order ${d.ordered}` : ''}.`,
      `Start with ${d.begin} on hand${d.arrival ? ` plus ${d.arrival} received` : ''}. Random number ${d.rnLabel} gives a demand of ${d.demand}${i.backorders && d.backlogIn ? ` (plus ${d.backlogIn} backordered)` : ''}, so ${d.sales} unit${d.sales === 1 ? ' is' : 's are'} sold and ${d.end} remain.${d.shortage ? ` ${d.shortage} unit${d.shortage === 1 ? ' is' : 's are'} short (${i.backorders ? 'backordered' : 'lost'}).` : ''}${ord} Cost of the day: ${fmt(d.costDay)}.`,
      'Day-by-day inventory balance');
  }
  const t = sim.totals;
  push('Summary', { phase: 'summary', day: sim.days.length },
    `Total cost ${fmt(t.total)} over ${i.days} days: average ${fmt(t.avgPerDay, 4)} per day.`,
    `${t.orders} order${t.orders === 1 ? '' : 's'} cost ${fmt(t.orderCost)}, holding ${fmt(t.holdCost)}, shortage ${fmt(t.shortCost)}; total ${fmt(t.total)}. Demand ${t.demand}, sales ${t.sales}, fill rate ${fmt(t.fillRate * 100, 1)} %. ${sim.days.length > shown ? `The player stepped through the first ${shown} days; the table lists all ${sim.days.length}.` : ''}`,
    'Total cost = ordering + holding + shortage');
  return steps;
}
