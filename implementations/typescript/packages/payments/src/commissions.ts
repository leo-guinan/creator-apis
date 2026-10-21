import { stableHash } from "../../contracts/src/index.js";
import { QI_BASE_PER_QI, type EnergyQuote } from "./qi.js";

/**
 * Commissions: miners pay a factory in Qi for one artifact (the first pilot is a music video factory).
 *
 * The point is to measure the Qi price falling as the factory gains skill. The Qi a miner pays moves for three
 * reasons, and only one of them is skill, so every quote records all three:
 *   1. skill: tool units (e.g. slop.cc credits) the factory needs per finished second
 *   2. tool price: USD per tool unit
 *   3. Qi price: USD per Qi, from a sourced, timestamped quote
 * Qi per finished second = units/s × USD/unit ÷ USD/Qi, so the log change splits exactly into those three terms.
 *
 * Two pricing modes:
 *  - fixed_quote: the miner pays the projected cost; the factory keeps any under-run and absorbs any over-run.
 *  - stake: the miner stakes Qi up to a ceiling. At the verdict the factory takes actual cost plus a margin, and
 *    the rest of the stake is returned or burned, as the miner chose when staking. The margin is a share of the
 *    projected cost by default, not the actual cost: a margin on actual cost would shrink every time the factory
 *    got better, which pays it to stay slow. A rejected attempt charges cost only (by default), so miners fund the
 *    factory's learning without paying it a profit on failures.
 * Open stakes are the pool's float: Qi committed to future work and held until a verdict releases it.
 */

export interface ToolPrice {
  /** What one unit is, e.g. "slop.cc credit". */
  unit: string;
  /** Price as a ratio so it stays exact: `usdCents` buys `units`. slop.cc: 3000 cents per 1,080 credits. */
  usdCents: number;
  units: number;
  source: string;
}

export interface Baseline {
  /** The finished artifact the standard comes from (n = 1 on the learning curve). */
  label: string;
  units: number;
  firstCutUnits?: number;
  fixUnits?: number;
  finishedSeconds: number;
  source: string;
}

export interface CommissionPool {
  id: string;
  factoryId: string;
  operation: string;
  operatorPayeeId: string;
  /** Miner payees allowed to commission, each with a cap on open (unpaid or undelivered) commissions. */
  miners: Array<{ payeeId: string; maxOpen: number }>;
  tool: ToolPrice;
  baseline: Baseline;
  /** Prior used until there are enough points to fit: cost multiplier per doubling of output (0.625 = 37.5% cheaper). */
  priorLearningRate: number;
  /** Accepted points (baseline included) needed before the curve is fitted from data instead of the prior. */
  minFitPoints: number;
  /** Fixes as a share of the first cut: the factory's process target, reported on every delivery. */
  maxFixRatio?: number;
  pricing: "fixed_quote" | "stake";
  /** fixed_quote only: share of the Qi refunded when a miner rejects with a reason. The rest pays for the attempt. */
  rejectionRefundBps: number;
  /** stake only. */
  stake?: StakeTerms;
  minSeconds: number;
  maxSeconds: number;
  quoteValidHours: number;
  clusterId?: string;
  createdAt: string;
}

export interface StakeTerms {
  /** Margin on top of cost, in basis points (1000 = 10%). */
  marginBps: number;
  /** "projected": margin on the projected cost at staking (default). "actual": margin on actual cost. */
  marginBasis: "projected" | "actual";
  /** Share of actual cost charged when the miner rejects (with a reason). No margin on rejections. */
  rejectedCostShareBps: number;
  /** What happens to unused stake when the miner doesn't say. */
  defaultRemainder: Remainder;
}
export type Remainder = "return" | "burn";
export const DEFAULT_STAKE: StakeTerms = { marginBps: 1000, marginBasis: "projected", rejectedCostShareBps: 10_000, defaultRemainder: "return" };

export interface StakeSettlement {
  /** Actual units converted at the tool price and the Qi rate locked when the job was quoted. */
  costQiBase: number;
  marginQiBase: number;
  /** min(stake, cost + margin). */
  chargedQiBase: number;
  /** cost + margin that the stake didn't cover; the factory absorbs it. */
  shortfallQiBase: number;
  remainderQiBase: number;
  remainder: Remainder;
}

export type CommissionStatus = "quoted" | "paid" | "delivered" | "accepted" | "rejected" | "expired";

export interface Projection {
  /** Position on the learning curve this quote is for (baseline = 1). */
  n: number;
  unitsPerSecond: number;
  basis: "prior" | "fit";
  learningRate: number;
  points: number;
}

export interface Commission {
  id: string;
  poolId: string;
  factoryId: string;
  minerPayeeId: string;
  brief: { title: string; songRef?: string; requestedSeconds: number; notes?: string };
  status: CommissionStatus;
  projection: Projection;
  /** `qiBase` is what the miner must send: the price (fixed_quote) or the minimum stake, projected cost + margin (stake). */
  quote: { units: number; usdCents: number; costQiBase: number; marginQiBase: number; qiBase: number; usdPerQi: number; energyQuoteId: string; tool: ToolPrice; validUntil: string; at: string };
  pricing: CommissionPool["pricing"];
  payment?: { txHash: string; qiBase: number; at: string; remainder?: Remainder };
  delivery?: { at: string; firstCutUnits: number; fixUnits: number; finishedSeconds: number; artifactRef: string; receiptIds: string[] };
  decision?: { at: string; accepted: boolean; quality?: number; reason?: string; refundQiBase: number; refundTxHash?: string; burnQiBase?: number; burnTxHash?: string; settlement?: StakeSettlement };
  sha256?: string;
}

export const DEFAULT_POOL = { pricing: "fixed_quote" as const, priorLearningRate: 0.625, minFitPoints: 3, rejectionRefundBps: 10_000, minSeconds: 30, maxSeconds: 300, quoteValidHours: 24 } as const;

export function validatePool(p: CommissionPool): string[] {
  const e: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(p.id)) e.push("id must be a lowercase slug");
  if (!p.factoryId || !p.operation) e.push("factoryId and operation are required");
  if (new Set(p.miners.map((m) => m.payeeId)).size !== p.miners.length) e.push("each miner appears once");
  for (const m of p.miners) { if (!m.payeeId.startsWith("miner:")) e.push(`${m.payeeId} is not a miner payee`); if (!Number.isInteger(m.maxOpen) || m.maxOpen < 1) e.push(`${m.payeeId}: maxOpen must be a positive integer`); }
  if (!(p.tool.usdCents > 0 && p.tool.units > 0) || !p.tool.unit || !p.tool.source) e.push("tool price needs unit, usdCents, units and a source");
  if (!(p.baseline.units > 0 && p.baseline.finishedSeconds > 0) || !p.baseline.source) e.push("baseline needs units, finishedSeconds and a source");
  if (!(p.priorLearningRate > 0 && p.priorLearningRate <= 1)) e.push("priorLearningRate must be in (0, 1]");
  if (!Number.isInteger(p.minFitPoints) || p.minFitPoints < 2) e.push("minFitPoints must be an integer of at least 2");
  if (!Number.isInteger(p.rejectionRefundBps) || p.rejectionRefundBps < 0 || p.rejectionRefundBps > 10_000) e.push("rejectionRefundBps must be 0..10000");
  if (!(p.minSeconds > 0 && p.maxSeconds >= p.minSeconds)) e.push("minSeconds and maxSeconds must be positive and in order");
  if (!(p.quoteValidHours > 0)) e.push("quoteValidHours must be positive");
  if (p.pricing !== "fixed_quote" && p.pricing !== "stake") e.push("pricing must be fixed_quote or stake");
  if (p.pricing === "stake") {
    const t = p.stake;
    if (!t) e.push("stake pricing needs stake terms");
    else {
      if (!Number.isInteger(t.marginBps) || t.marginBps < 0 || t.marginBps > 10_000) e.push("stake.marginBps must be 0..10000");
      if (t.marginBasis !== "projected" && t.marginBasis !== "actual") e.push("stake.marginBasis must be projected or actual");
      if (!Number.isInteger(t.rejectedCostShareBps) || t.rejectedCostShareBps < 0 || t.rejectedCostShareBps > 10_000) e.push("stake.rejectedCostShareBps must be 0..10000");
      if (t.defaultRemainder !== "return" && t.defaultRemainder !== "burn") e.push("stake.defaultRemainder must be return or burn");
    }
  }
  if (p.maxFixRatio !== undefined && !(p.maxFixRatio >= 0)) e.push("maxFixRatio must be non-negative");
  return e;
}

/** One point per accepted artifact, baseline first. Order is by acceptance, which is the order the factory learned in. */
export function curvePoints(pool: CommissionPool, commissions: Commission[]): Array<{ n: number; unitsPerSecond: number; ref: string }> {
  const accepted = commissions.filter((c) => c.poolId === pool.id && c.status === "accepted" && c.delivery).sort((a, b) => a.decision!.at.localeCompare(b.decision!.at) || a.id.localeCompare(b.id));
  return [{ n: 1, unitsPerSecond: pool.baseline.units / pool.baseline.finishedSeconds, ref: `baseline:${pool.baseline.label}` }, ...accepted.map((c, i) => ({ n: i + 2, unitsPerSecond: (c.delivery!.firstCutUnits + c.delivery!.fixUnits) / c.delivery!.finishedSeconds, ref: c.id }))];
}

/**
 * Wright's law: cost(n) = c1 · n^(−b), learning rate = 2^(−b) (cost multiplier per doubling).
 * Before `minFitPoints` points exist, the prior rate is applied to the baseline. After, b and c1 are a least-squares
 * fit of ln cost on ln n, with b clamped to [0, 1.5] so one lucky or unlucky video can't make a wild quote.
 */
export function project(pool: CommissionPool, commissions: Commission[]): Projection {
  const pts = curvePoints(pool, commissions);
  const n = pts.length + 1;
  if (pts.length < pool.minFitPoints) {
    const b = -Math.log2(pool.priorLearningRate);
    return { n, unitsPerSecond: pts[0].unitsPerSecond * n ** -b, basis: "prior", learningRate: pool.priorLearningRate, points: pts.length };
  }
  const xs = pts.map((p) => Math.log(p.n)), ys = pts.map((p) => Math.log(p.unitsPerSecond));
  const mx = xs.reduce((a, x) => a + x, 0) / xs.length, my = ys.reduce((a, y) => a + y, 0) / ys.length;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const b = Math.min(1.5, Math.max(0, -(sxy / sxx)));
  const lnC1 = my + b * mx;
  return { n, unitsPerSecond: Math.exp(lnC1 - b * Math.log(n)), basis: "fit", learningRate: 2 ** -b, points: pts.length };
}

export const unitsToCents = (units: number, tool: ToolPrice) => Math.round((units * tool.usdCents) / tool.units);
/** Rounded up: the factory never quotes below cost because of rounding. */
export const centsToQiBase = (cents: number, usdPerQi: number) => Math.ceil((cents / 100 / usdPerQi) * QI_BASE_PER_QI);

export function priceCommission(pool: CommissionPool, commissions: Commission[], seconds: number, quote: EnergyQuote, now: Date) {
  const projection = project(pool, commissions);
  // The epsilon keeps float noise (1440.0000000002) from adding a whole unit.
  const units = Math.ceil(projection.unitsPerSecond * seconds - 1e-9);
  const usdCents = unitsToCents(units, pool.tool);
  const costQiBase = centsToQiBase(usdCents, quote.usdPerQi);
  const marginQiBase = pool.pricing === "stake" ? Math.floor((costQiBase * pool.stake!.marginBps) / 10_000) : 0;
  return { projection, pricing: pool.pricing, quote: { units, usdCents, costQiBase, marginQiBase, qiBase: costQiBase + marginQiBase, usdPerQi: quote.usdPerQi, energyQuoteId: quote.id, tool: { ...pool.tool }, validUntil: new Date(now.getTime() + pool.quoteValidHours * 3_600_000).toISOString(), at: now.toISOString() } };
}

/** Stake mode: what the factory takes from the stake, and what's left to return or burn. */
export function settleStake(pool: CommissionPool, c: Commission, accepted: boolean): StakeSettlement {
  const t = pool.stake!, d = c.delivery!, stake = c.payment!.qiBase;
  const costQiBase = centsToQiBase(unitsToCents(d.firstCutUnits + d.fixUnits, c.quote.tool), c.quote.usdPerQi);
  const owedCost = accepted ? costQiBase : Math.floor((costQiBase * t.rejectedCostShareBps) / 10_000);
  const marginQiBase = accepted ? Math.floor(((t.marginBasis === "projected" ? c.quote.costQiBase : costQiBase) * t.marginBps) / 10_000) : 0;
  const chargedQiBase = Math.min(stake, owedCost + marginQiBase);
  return { costQiBase, marginQiBase, chargedQiBase, shortfallQiBase: owedCost + marginQiBase - chargedQiBase, remainderQiBase: stake - chargedQiBase, remainder: c.payment!.remainder ?? t.defaultRemainder };
}

export const sealCommission = (c: Commission): Commission => { const { sha256: _drop, ...body } = c; return { ...c, sha256: stableHash(body) }; };
export const commissionHashValid = (c: Commission) => { const { sha256, ...body } = c; return sha256 === stableHash(body); };

export interface CurveRow {
  n: number;
  ref: string;
  title: string;
  pricing?: CommissionPool["pricing"];
  finishedSeconds: number;
  /** Stake mode: the factory's margin on this video. */
  marginQiBase?: number;
  /** What the factory actually used, per finished second. This is the skill measure. */
  unitsPerSecond: number;
  usdPerSecond: number;
  /** What the miner paid in Qi per finished second: the fixed quote, or the stake's charge (cost + margin). */
  qiPerSecond?: number;
  quotedUnits?: number;
  actualUnits: number;
  /** Positive = the factory beat its own quote. */
  underRunUnits?: number;
  fixRatio?: number;
  meetsFixTarget?: boolean;
  /** Log change in cost-in-Qi per second from the previous row, split into its three causes. Sums to `total`. */
  change?: { total: number; skill: number; toolPrice: number; qiPrice: number };
}

export interface LearningReport {
  poolId: string;
  factoryId: string;
  unit: string;
  rows: CurveRow[];
  /** Fitted (or prior) curve and the price the next commission would be quoted at, per finished second. */
  next: Projection & { usdPerSecond: number };
  /** Across all paid commissions: how much of the drop in Qi per second came from skill, tool price and Qi price. */
  cumulative?: { qiPerSecondFirst: number; qiPerSecondLast: number; total: number; skill: number; toolPrice: number; qiPrice: number };
  skillVsBaseline: number;
  /** Qi staked on commissions that haven't had a verdict yet: committed to work, held until released. */
  float: { openCommissions: number; qiBase: number };
  /** Stake mode totals over decided commissions. */
  stakes?: { staked: number; charged: number; margin: number; returned: number; burned: number; shortfall: number };
  notes: string[];
  sha256: string;
}

/** The learning report the presser reads from. Only accepted work counts as skill; rejected work is listed in notes. */
export function learningReport(pool: CommissionPool, commissions: Commission[]): LearningReport {
  const mine = commissions.filter((c) => c.poolId === pool.id);
  const accepted = mine.filter((c) => c.status === "accepted" && c.delivery).sort((a, b) => a.decision!.at.localeCompare(b.decision!.at) || a.id.localeCompare(b.id));
  const perUnitCents = pool.tool.usdCents / pool.tool.units;
  const b0 = pool.baseline;
  const rows: CurveRow[] = [{ n: 1, ref: `baseline:${b0.label}`, title: b0.label, finishedSeconds: b0.finishedSeconds, unitsPerSecond: b0.units / b0.finishedSeconds, usdPerSecond: (b0.units * perUnitCents) / 100 / b0.finishedSeconds, actualUnits: b0.units, ...(b0.firstCutUnits && b0.fixUnits !== undefined ? { fixRatio: b0.fixUnits / b0.firstCutUnits, meetsFixTarget: pool.maxFixRatio === undefined ? undefined : b0.fixUnits / b0.firstCutUnits <= pool.maxFixRatio } : {}) }];
  let prev: { qps: number; ups: number; cpu: number; upq: number } | undefined;
  let first: typeof prev;
  accepted.forEach((c, i) => {
    const d = c.delivery!, actual = d.firstCutUnits + d.fixUnits, ups = actual / d.finishedSeconds;
    const cpu = c.quote.tool.usdCents / c.quote.tool.units;
    const paidQi = c.decision!.settlement ? c.decision!.settlement.chargedQiBase : c.quote.qiBase;
    const qps = paidQi / QI_BASE_PER_QI / d.finishedSeconds;
    // What drives the miner's price: quoted units under a fixed quote, actual units under a stake.
    const basisUps = (c.pricing === "stake" ? actual : c.quote.units) / d.finishedSeconds;
    const row: CurveRow = { n: i + 2, ref: c.id, title: c.brief.title, pricing: c.pricing, finishedSeconds: d.finishedSeconds, unitsPerSecond: ups, marginQiBase: c.decision!.settlement?.marginQiBase ?? 0, usdPerSecond: (actual * cpu) / 100 / d.finishedSeconds, qiPerSecond: qps, quotedUnits: c.quote.units, actualUnits: actual, underRunUnits: c.quote.units - actual, fixRatio: d.firstCutUnits > 0 ? d.fixUnits / d.firstCutUnits : undefined };
    if (pool.maxFixRatio !== undefined && row.fixRatio !== undefined) row.meetsFixTarget = row.fixRatio <= pool.maxFixRatio;
    // The split runs on cost (units × USD/unit ÷ USD/Qi), so it is exact; the margin is reported beside it.
    const cur = { qps: (basisUps * cpu) / 100 / c.quote.usdPerQi, ups: basisUps, cpu, upq: c.quote.usdPerQi };
    if (prev) row.change = split(prev, cur);
    prev = cur; first ??= cur;
    rows.push(row);
  });
  const next = project(pool, mine);
  const notes: string[] = [];
  const open = mine.filter((c) => (c.status === "paid" || c.status === "delivered") && c.payment);
  const settled = mine.filter((c) => c.decision?.settlement);
  if (next.basis === "prior") notes.push(`quotes use the prior learning rate (${pool.priorLearningRate}) until ${pool.minFitPoints} accepted points exist; ${next.points} so far, baseline included`);
  const rejected = mine.filter((c) => c.status === "rejected");
  if (rejected.length) notes.push(`${rejected.length} rejected: ${rejected.map((c) => `${c.id} (${c.decision?.reason ?? "no reason"})`).join(", ")}; rejected work is not a point on the curve`);
  const report: Omit<LearningReport, "sha256"> = {
    poolId: pool.id, factoryId: pool.factoryId, unit: pool.tool.unit, rows,
    next: { ...next, usdPerSecond: (next.unitsPerSecond * perUnitCents) / 100 },
    cumulative: first && prev && first !== prev ? { qiPerSecondFirst: first.qps, qiPerSecondLast: prev.qps, ...split(first, prev) } : undefined,
    skillVsBaseline: rows.at(-1)!.unitsPerSecond / rows[0].unitsPerSecond,
    float: { openCommissions: open.length, qiBase: open.reduce((t, c) => t + c.payment!.qiBase, 0) },
    stakes: settled.length ? settled.reduce((t, c) => { const x = c.decision!.settlement!; t.staked += c.payment!.qiBase; t.charged += x.chargedQiBase; t.margin += Math.min(x.marginQiBase, x.chargedQiBase); t[x.remainder === "burn" ? "burned" : "returned"] += x.remainderQiBase; t.shortfall += x.shortfallQiBase; return t; }, { staked: 0, charged: 0, margin: 0, returned: 0, burned: 0, shortfall: 0 }) : undefined,
    notes
  };
  return { ...report, sha256: stableHash(report) };
}

/** ln(qps1/qps0) = ln(ups1/ups0) + ln(cpu1/cpu0) − ln(upq1/upq0), up to rounding of the Qi quote. */
function split(a: { qps: number; ups: number; cpu: number; upq: number }, b: { qps: number; ups: number; cpu: number; upq: number }) {
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return { total: r(Math.log(b.qps / a.qps)), skill: r(Math.log(b.ups / a.ups)), toolPrice: r(Math.log(b.cpu / a.cpu)), qiPrice: r(-Math.log(b.upq / a.upq)) };
}
