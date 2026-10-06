/**
 * Inventory decision models (spec §9.4): EOQ (with lead time), production-lot EPQ, EOQ with planned
 * shortages, quantity discounts (all-units AND incremental) and single-period newsvendor
 * (normal, uniform or discrete demand). Float64 per spec; errors are parameter-specific and never thrown.
 */

import { normalCDF, normalInv } from '../project/cpm';

export type InventoryModel = 'eoq' | 'epq' | 'shortage' | 'discount' | 'newsvendor';

export interface PriceBreak { minQty: number; price: number }

export interface InventoryInput {
  model: InventoryModel;
  demand?: number;          // D per unit time
  setupCost?: number;       // K per order / set-up
  holdingCost?: number;     // h per unit per unit time (fixed) – or a rate when holdingIsRate
  holdingIsRate?: boolean;  // holdingCost is a fraction I of unit price per unit time
  unitCost?: number;        // c (EOQ/EPQ/shortage purchase cost, newsvendor cost)
  leadTime?: number;        // L in the same time unit as demand
  productionRate?: number;  // k (EPQ)
  shortageCost?: number;    // p per unit short per unit time
  breaks?: PriceBreak[];    // discount schedule, ascending minQty (first must be 0 or 1)
  discountType?: 'allUnits' | 'incremental';
  // newsvendor
  sellingPrice?: number;
  salvageValue?: number;
  goodwill?: number;
  demandDist?: 'normal' | 'uniform' | 'discrete';
  mean?: number;
  stdDev?: number;
  uniformMin?: number;
  uniformMax?: number;
  discrete?: { demand: number; prob: number }[];
}

export interface CurvePoint { q: number; ordering: number; holding: number; shortage: number; purchase: number; total: number }

export interface InventoryResult {
  error?: string;
  model: InventoryModel;
  Q?: number;
  maxInventory?: number;
  maxShortage?: number;
  cycleTime?: number;
  ordersPerYear?: number;
  reorderPoint?: number;
  annualCosts?: { ordering: number; holding: number; shortage: number; purchase: number; total: number };
  curve?: CurvePoint[];
  tiers?: { tier: number; minQty: number; maxQty: number | null; price: number; unconstrainedQ: number; feasibleQ: number | null; usedQ: number; totalCost: number; isOptimal: boolean; note: string }[];
  newsvendor?: { underage: number; overage: number; criticalRatio: number; stockLevel: number; z?: number; expectedProfit: number; expectedShortage: number; expectedLeftover: number; serviceLevel: number; stockoutProb: number };
  steps: { title: string; text: string; formula?: string }[];
  interpretation: string[];
}

const f = (x: number, d = 3) => Number(x.toFixed(d)).toString();
const err = (model: InventoryModel, error: string): InventoryResult => ({ model, error, steps: [], interpretation: [] });
const pos = (x: number | undefined) => x !== undefined && Number.isFinite(x) && x > 0;

export function solveInventory(input: InventoryInput): InventoryResult {
  const res = solveInventoryRaw(input);
  const bad = (x: number | undefined) => x !== undefined && !Number.isFinite(x);
  if (!res.error && (bad(res.Q) || bad(res.annualCosts?.total) || bad(res.reorderPoint) || bad(res.newsvendor?.expectedProfit))) return err(input.model, 'The inputs are so extreme that the results overflow the number range. Use more moderate values.');
  return res;
}

function solveInventoryRaw(input: InventoryInput): InventoryResult {
  const m = input.model;
  const steps: InventoryResult['steps'] = [];
  const interp: string[] = [];

  if (m === 'newsvendor') return newsvendor(input);

  if (!pos(input.demand)) return err(m, 'Demand D must be greater than 0.');
  if (!pos(input.setupCost)) return err(m, 'The ordering/set-up cost K must be greater than 0.');
  if (m !== 'discount' && !pos(input.holdingCost)) return err(m, 'The holding cost h must be greater than 0.');
  const D = input.demand!, K = input.setupCost!;
  const h = input.holdingCost ?? 0;
  const c = input.unitCost ?? 0;
  if (!Number.isFinite(c) || c < 0) return err(m, 'The unit purchase cost must be a finite number that is not negative.');
  if (input.leadTime !== undefined && (!Number.isFinite(input.leadTime) || input.leadTime < 0)) return err(m, 'The lead time must be a finite number that is not negative.');

  if (m === 'eoq') {
    const Q = Math.sqrt((2 * K * D) / h);
    const T = Q / D;
    const curve = sweep(Q, q => ({ ordering: (K * D) / q, holding: (h * q) / 2, shortage: 0, purchase: c * D }));
    steps.push({ title: 'Economic order quantity', text: `Setting the derivative of TC(Q) = KD/Q + hQ/2 to zero balances ordering and holding cost: Q* = √(2KD/h) = √(2·${K}·${D}/${h}) = ${f(Q)}.`, formula: 'Q^*=\\sqrt{\\tfrac{2KD}{h}}' });
    let R: number | undefined;
    if (input.leadTime !== undefined) {
      // whole cycles inside L; the tolerance stops L = n·t₀ (e.g. 0.6 = 3 × 0.2) from being read as n − 1 cycles plus a full one
      const cycles = Math.floor(input.leadTime / T + 1e-9);
      const eff = Math.max(0, input.leadTime - cycles * T);
      R = D * eff;
      steps.push({ title: 'Reorder point', text: `Cycle length t₀ = Q*/D = ${f(T, 4)}. Lead time L = ${input.leadTime} → effective lead time Lₑ = L − n·t₀ = ${f(eff, 4)} (n = whole cycles inside L). Reorder when inventory falls to R = D·Lₑ = ${f(R)}.`, formula: 'R = D\\,L_e' });
    }
    const ord = (K * D) / Q, hold = (h * Q) / 2;
    interp.push(`Order ${f(Q)} units every ${f(T, 3)} time units (${f(D / Q, 2)} orders per period). At the optimum ordering cost (${f(ord)}) equals holding cost (${f(hold)}) — the two curves cross exactly at their sum's minimum.`);
    return { model: m, Q, cycleTime: T, ordersPerYear: D / Q, reorderPoint: R, maxInventory: Q, annualCosts: { ordering: ord, holding: hold, shortage: 0, purchase: c * D, total: ord + hold + c * D }, curve, steps, interpretation: interp };
  }

  if (m === 'epq') {
    const k = input.productionRate;
    if (!pos(k)) return err(m, 'The production rate must be greater than 0.');
    if (k! <= D) return err(m, `The production rate (${k}) must exceed the demand rate (${D}); otherwise stock can never build up and no finite lot size exists.`);
    const factor = 1 - D / k!;
    const Q = Math.sqrt((2 * K * D) / (h * factor));
    const Imax = Q * factor;
    steps.push({ title: 'Economic production lot', text: `While producing, stock grows at k − D, so the peak inventory is Q(1 − D/k) = ${f(Imax)}. TC(Q) = KD/Q + h·Q(1−D/k)/2 gives Q* = √(2KD / (h(1−D/k))) = ${f(Q)}.`, formula: 'Q^*=\\sqrt{\\tfrac{2KD}{h(1-D/k)}}' });
    const ord = (K * D) / Q, hold = (h * Imax) / 2;
    interp.push(`Produce ${f(Q)} units per run; inventory peaks at ${f(Imax)} and a run lasts ${f(Q / k!, 3)} time units out of each ${f(Q / D, 3)}.`);
    const curve = sweep(Q, q => ({ ordering: (K * D) / q, holding: (h * q * factor) / 2, shortage: 0, purchase: c * D }));
    return { model: m, Q, maxInventory: Imax, cycleTime: Q / D, ordersPerYear: D / Q, annualCosts: { ordering: ord, holding: hold, shortage: 0, purchase: c * D, total: ord + hold + c * D }, curve, steps, interpretation: interp };
  }

  if (m === 'shortage') {
    const p = input.shortageCost;
    if (!pos(p)) return err(m, 'The shortage (backorder) cost p must be greater than 0.');
    const Q = Math.sqrt(((2 * K * D) / h) * ((p! + h) / p!));
    const S = (Q * h) / (p! + h); // max shortage
    const y = Q - S; // max inventory
    const T = Q / D;
    const ord = (K * D) / Q, hold = (h * y * y) / (2 * Q), sh = (p! * S * S) / (2 * Q);
    steps.push({ title: 'Planned backorders', text: `Allowing shortages S per cycle: TC(y,Q) = KD/Q + h y²/(2Q) + p (Q−y)²/(2Q). Setting both partial derivatives to zero: Q* = √(2KD(h+p)/(hp)) = ${f(Q)} and maximum stock y* = Q*·p/(h+p) = ${f(y)}, so the maximum backorder is S* = Q* − y* = ${f(S)}.`, formula: 'Q^*=\\sqrt{\\tfrac{2KD(h+p)}{hp}},\; y^*=Q^*\\tfrac{p}{h+p}' });
    interp.push(`Order ${f(Q)} units each cycle of ${f(T, 3)}; let up to ${f(S)} units go on backorder, so the stock never exceeds ${f(y)}. Backordering saves money when the shortage penalty is not much larger than holding cost; as p → ∞ the model reduces to the ordinary EOQ.`);
    const base = Math.sqrt((2 * K * D) / h);
    const curve = sweep(Q, q => { const yy = q * (p! / (h + p!)); return { ordering: (K * D) / q, holding: (h * yy * yy) / (2 * q), shortage: (p! * (q - yy) ** 2) / (2 * q), purchase: c * D }; });
    interp.push(`Compared with the plain EOQ (${f(base)}), the order quantity is ${f(Q / base, 3)}× larger.`);
    return { model: m, Q, maxInventory: y, maxShortage: S, cycleTime: T, ordersPerYear: D / Q, annualCosts: { ordering: ord, holding: hold, shortage: sh, purchase: c * D, total: ord + hold + sh + c * D }, curve, steps, interpretation: interp };
  }

  // discount
  const breaks = (input.breaks ?? []).slice().sort((a, b) => a.minQty - b.minQty);
  if (breaks.length < 1) return err(m, 'Enter at least one price break (quantity from, unit price).');
  if (breaks.some(b => !(Number.isFinite(b.price) && b.price > 0) || !(Number.isFinite(b.minQty) && b.minQty >= 0))) return err(m, 'Every price must be a finite number > 0 and every break quantity a finite number ≥ 0.');
  if (new Set(breaks.map(b => b.minQty)).size !== breaks.length) return err(m, 'Two price breaks have the same starting quantity.');
  if (breaks[0]!.minQty > 1) return err(m, `The first price break must start at quantity 0 (or 1), not ${f(breaks[0]!.minQty)}; otherwise orders below that quantity would have no price.`);
  const rise = breaks.findIndex((b, i) => i > 0 && b.price > breaks[i - 1]!.price);
  if (rise > 0) return err(m, `The price rises from ${f(breaks[rise - 1]!.price)} to ${f(breaks[rise]!.price)} at quantity ${f(breaks[rise]!.minQty)}: a quantity discount must not increase the unit price.`);
  if (input.holdingIsRate && !(h > 0 && h < 5)) return err(m, 'Holding rate I should be a fraction of price per unit time, e.g. 0.2 for 20 %.');
  if (!input.holdingIsRate && !pos(input.holdingCost)) return err(m, 'The holding cost h must be greater than 0.');
  const type = input.discountType ?? 'allUnits';
  // normalise first break to start at 0
  const b0 = breaks.map((b, i) => ({ ...b, minQty: i === 0 ? 0 : b.minQty }));
  const tiers: NonNullable<InventoryResult['tiers']> = [];
  const A = (i: number) => (type === 'allUnits' ? 0 : b0.slice(0, i).reduce((s, b, j) => s + b.price * (b0[j + 1]!.minQty - b.minQty), 0) - b0[i]!.price * b0[i]!.minQty);
  const totalAt = (i: number, q: number) => {
    const price = b0[i]!.price;
    const a = A(i);
    const purchase = D * price + (type === 'incremental' ? (D * a) / q : 0);
    const hold = input.holdingIsRate ? (h * (price * q + a)) / 2 : (h * q) / 2;
    return purchase + (K * D) / q + hold;
  };
  b0.forEach((b, i) => {
    const maxQty = i + 1 < b0.length ? b0[i + 1]!.minQty : null;
    const a = A(i);
    const unconstrained = input.holdingIsRate ? Math.sqrt((2 * D * (K + a)) / (h * b.price)) : Math.sqrt((2 * D * (K + a)) / h);
    let feasible: number | null = null;
    let used = unconstrained;
    let note = '';
    if (unconstrained < Math.max(b.minQty, 0)) { used = Math.max(b.minQty, 1e-9); feasible = used; note = `Q* = ${f(unconstrained)} is below this tier's minimum, so the best feasible order is the minimum ${f(b.minQty)}.`; }
    else if (maxQty !== null && unconstrained >= maxQty) { feasible = null; used = maxQty; note = `Q* = ${f(unconstrained)} falls inside a cheaper tier; this tier is not attainable at its own optimum, its best point is the break itself (dominated by the next tier).`; }
    else { feasible = unconstrained; note = `Q* = ${f(unconstrained)} lies inside the tier — feasible.`; }
    const evalQ = feasible ?? (maxQty ?? used);
    tiers.push({ tier: i + 1, minQty: b.minQty, maxQty, price: b.price, unconstrainedQ: unconstrained, feasibleQ: feasible, usedQ: evalQ, totalCost: totalAt(i, Math.max(evalQ, 1e-9)), isOptimal: false, note });
  });
  // candidates: feasible tiers only (tiers whose unconstrained optimum fell above the tier are dominated by the next break)
  const cand = tiers.filter(t => t.feasibleQ !== null);
  if (!cand.length) cand.push(tiers[tiers.length - 1]!);
  const best = cand.reduce((a, b) => (b.totalCost < a.totalCost ? b : a));
  best.isOptimal = true;
  const bi = best.tier - 1;
  steps.push({ title: 'Price-break evaluation', text: `For each price tier compute its own EOQ ${type === 'incremental' ? '(adjusted by the constant A = savings carried from earlier tiers) ' : ''}and check it falls inside the tier. If it is below the tier, use the tier's lower limit; if it is above, the tier is dominated. Then compare total costs including purchase cost: the cheapest is tier ${best.tier} with Q = ${f(best.usedQ)} and cost ${f(best.totalCost)}.`, formula: type === 'allUnits' ? 'TC_i(Q)=Dc_i+\\tfrac{KD}{Q}+\\tfrac{h_iQ}{2}' : 'TC_i(Q)=D\\left(c_i+\\tfrac{A_i}{Q}\\right)+\\tfrac{KD}{Q}+\\tfrac{h\\,(c_iQ+A_i)}{2}' });
  const q = Math.max(best.usedQ, 1e-9);
  const price = b0[bi]!.price;
  const a = A(bi);
  const hold = input.holdingIsRate ? (h * (price * q + a)) / 2 : (h * q) / 2;
  const purchase = D * price + (type === 'incremental' ? (D * a) / q : 0);
  interp.push(`Order ${f(best.usedQ)} units at a time (${type === 'allUnits' ? `price ${price} applies to the whole order` : 'incremental pricing: each band is charged its own price'}); total cost ${f(best.totalCost)} per unit time.`);
  const curve: CurvePoint[] = [];
  const qmax = Math.max(...b0.map(b => b.minQty), best.usedQ) * 1.6 + 10;
  for (let k = 1; k <= 120; k++) {
    const qq = (qmax * k) / 120;
    let i = 0; b0.forEach((bb, j) => { if (qq >= bb.minQty) i = j; });
    const price2 = b0[i]!.price; const a2 = A(i);
    const hold2 = input.holdingIsRate ? (h * (price2 * qq + a2)) / 2 : (h * qq) / 2;
    const pur2 = D * price2 + (type === 'incremental' ? (D * a2) / qq : 0);
    curve.push({ q: qq, ordering: (K * D) / qq, holding: hold2, shortage: 0, purchase: pur2, total: (K * D) / qq + hold2 + pur2 });
  }
  return { model: m, Q: best.usedQ, cycleTime: best.usedQ / D, ordersPerYear: D / best.usedQ, annualCosts: { ordering: (K * D) / q, holding: hold, shortage: 0, purchase, total: best.totalCost }, tiers, curve, steps, interpretation: interp };
}

function sweep(Q: number, parts: (q: number) => Omit<CurvePoint, 'q' | 'total'>): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (let k = 1; k <= 100; k++) {
    const q = (Q * 2.6 * k) / 100;
    const p = parts(q);
    out.push({ q, ...p, total: p.ordering + p.holding + p.shortage + p.purchase });
  }
  return out;
}

function newsvendor(input: InventoryInput): InventoryResult {
  const m: InventoryModel = 'newsvendor';
  const p = input.sellingPrice, c = input.unitCost, s = input.salvageValue ?? 0, g = input.goodwill ?? 0;
  if (!pos(p)) return err(m, 'The selling price must be greater than 0.');
  if (!pos(c)) return err(m, 'The unit cost must be greater than 0.');
  if (p! <= c!) return err(m, 'The selling price must exceed the unit cost; otherwise no stocking is profitable.');
  if (!Number.isFinite(p!) || !Number.isFinite(c!)) return err(m, 'The selling price and unit cost must be finite numbers.');
  if (!Number.isFinite(s) || s < 0 || s >= c!) return err(m, 'The salvage value must be ≥ 0 and below the unit cost (otherwise there is no risk in over-stocking).');
  if (!Number.isFinite(g) || g < 0) return err(m, 'The goodwill (penalty per unit short) must be a finite number that is not negative.');
  const Cu = p! - c! + g, Co = c! - s;
  const CR = Cu / (Cu + Co);
  const dist = input.demandDist ?? 'normal';
  const steps: InventoryResult['steps'] = [];
  steps.push({ title: 'Critical ratio', text: `Underage cost Cu = p − c${g ? ' + goodwill' : ''} = ${f(Cu)} (profit lost per unit short); overage cost Co = c − s = ${f(Co)} (loss per leftover unit). Stock until P(D ≤ Q) ≥ Cu/(Cu+Co) = ${f(CR, 4)}.`, formula: 'F(Q^*)\\ge\\frac{C_u}{C_u+C_o}' });
  let Q = 0, z: number | undefined, expShort = 0, expLeft = 0, mu = 0;
  if (dist === 'normal') {
    mu = input.mean ?? NaN; const sd = input.stdDev ?? NaN;
    if (!Number.isFinite(mu) || mu <= 0) return err(m, 'The mean demand must be a finite number greater than 0.');
    if (!(sd >= 0) || !Number.isFinite(sd)) return err(m, 'The standard deviation must be a finite number that is not negative.');
    z = normalInv(CR);
    Q = mu + z * sd;
    if (Q < 0) return err(m, `The optimal stock level would be negative (μ + zσ = ${f(Q)}): the normal demand has too much spread (σ = ${f(sd)}) relative to its mean (μ = ${f(mu)}). Use a smaller σ or a different distribution.`);
    const phi = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    expShort = sd * (phi - z * (1 - normalCDF(z)));
    expLeft = Q - mu + expShort;
    steps.push({ title: 'Normal demand', text: `z = Φ⁻¹(${f(CR, 4)}) = ${f(z, 4)}, so Q* = μ + zσ = ${f(mu)} + ${f(z, 3)}·${f(sd)} = ${f(Q)}. Expected shortage σ[φ(z) − z(1−Φ(z))] = ${f(expShort)}.`, formula: 'Q^*=\\mu+z\\sigma' });
  } else if (dist === 'uniform') {
    const a = input.uniformMin ?? NaN, b = input.uniformMax ?? NaN;
    if (!(Number.isFinite(a) && Number.isFinite(b) && b > a)) return err(m, 'For uniform demand the maximum must exceed the minimum (both finite).');
    if (a < 0) return err(m, 'Demand cannot be negative: the minimum of the uniform range must be ≥ 0.');
    mu = (a + b) / 2;
    Q = a + CR * (b - a);
    expShort = ((b - Q) ** 2) / (2 * (b - a));
    expLeft = ((Q - a) ** 2) / (2 * (b - a));
    steps.push({ title: 'Uniform demand', text: `F(Q) = (Q − a)/(b − a) = ${f(CR, 4)} gives Q* = a + CR·(b − a) = ${f(Q)}.` });
  } else {
    const d = (input.discrete ?? []).slice().sort((x, y) => x.demand - y.demand);
    if (!d.length) return err(m, 'Enter the discrete demand values with their probabilities.');
    if (d.some(x => !Number.isFinite(x.demand) || x.demand < 0)) return err(m, 'Every demand value must be a finite number that is not negative.');
    if (d.some(x => !Number.isFinite(x.prob) || x.prob < 0 || x.prob > 1)) return err(m, 'Every probability must be a number between 0 and 1.');
    const tot = d.reduce((x, y) => x + y.prob, 0);
    if (Math.abs(tot - 1) > 1e-6) return err(m, `The probabilities sum to ${f(tot, 4)}, not 1.`);
    let cum = 0; Q = d[d.length - 1]!.demand;
    for (const x of d) { cum += x.prob; if (cum + 1e-12 >= CR) { Q = x.demand; break; } }
    mu = d.reduce((x, y) => x + y.demand * y.prob, 0);
    expShort = d.reduce((x, y) => x + Math.max(0, y.demand - Q) * y.prob, 0);
    expLeft = d.reduce((x, y) => x + Math.max(0, Q - y.demand) * y.prob, 0);
    steps.push({ title: 'Discrete demand', text: `Cumulative probabilities: ${d.map((x, i) => `P(D ≤ ${x.demand}) = ${f(d.slice(0, i + 1).reduce((s2, y) => s2 + y.prob, 0), 3)}`).join(', ')}. The first level whose cumulative probability reaches ${f(CR, 4)} is Q* = ${Q}.` });
  }
  const sales = mu - expShort;
  const expectedProfit = (p! - c!) * sales - Co * expLeft - g * expShort;
  const stockout = dist === 'normal' ? 1 - normalCDF(z!) : dist === 'uniform' ? 1 - (Q - (input.uniformMin ?? 0)) / ((input.uniformMax ?? 1) - (input.uniformMin ?? 0)) : (input.discrete ?? []).filter(x => x.demand > Q).reduce((a, b) => a + b.prob, 0);
  return {
    model: m,
    Q,
    steps,
    interpretation: [
      `Stock ${f(Q, 2)} units. This covers demand with probability ${f((1 - stockout) * 100, 1)} %; you expect ${f(expShort, 2)} units of unmet demand and ${f(expLeft, 2)} leftover units, for an expected profit of ${f(expectedProfit, 2)}.`,
      'Stock more when the profit per sale is large relative to the loss on a leftover unit — the critical ratio is the probability of NOT running out you are willing to buy.',
    ],
    newsvendor: { underage: Cu, overage: Co, criticalRatio: CR, stockLevel: Q, z, expectedProfit, expectedShortage: expShort, expectedLeftover: expLeft, serviceLevel: 1 - stockout, stockoutProb: stockout },
  };
}
