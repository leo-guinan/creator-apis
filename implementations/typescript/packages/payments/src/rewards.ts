import { stableHash } from "../../contracts/src/index.js";

/**
 * Time-based Qi rewards, paid from a pool each period.
 *
 * Every kind of artifact has a standard: quality q₀ and time t₀ (the network median of last period's accepted,
 * independently judged deliveries). A delivery that meets q₀ scores t₀ × m(s), where s = t₀ / t is its speedup and
 * m(s) = 1 + β·log₂(s), clamped. So the score is in standard seconds of creation, and beating the network earns a premium.
 * t₀ is recomputed each period, like mining difficulty: last period's speed becomes this period's baseline.
 *
 * The pool is a Qi budget per period that grows with the number of active factories, split into sections
 * (e.g. voices, stories, research) with their own share. Within a section, Qi is paid in proportion to score.
 */

export type QualitySource = "customer" | "network_evaluator" | "press_documented" | "self";

/** A delivery as observed by the platform: times are taken at the platform's boundary, not reported by the operator. */
export interface Delivery {
  id: string;
  receiptId?: string;
  factoryId: string;
  operatorPayeeId: string;
  operation: string;
  /** Groups inputs of similar difficulty so operators can't earn the bonus by choosing easy jobs. */
  sizeBand?: string;
  submittedAt: string;
  deliveredAt: string;
  accepted: boolean;
  /** 0..1, from a source the operator doesn't control. */
  quality: number;
  qualitySource: QualitySource;
  /** Set when the delivery was served from earlier work; credit goes to whoever made the original. */
  reuseOf?: string;
  /** The cluster this delivery counts in. A delivery counts in at most one cluster. */
  clusterId?: string;
  /** Hash of the input, so repeated attempts on the same input can be told apart from new ones. */
  inputHash?: string;
  /** Why a rejected attempt was rejected. A rejection without a reason doesn't count as learning. */
  rejectionReason?: string;
}

export interface Standard { key: string; t0Seconds: number; q0: number; samples: number; source: "network" | "carried" | "declared"; }
export interface PoolSection { id: string; name: string; shareBps: number; /** First matching section wins. Omit for a catch-all. */ operations?: string[]; }
export interface PoolSchedule { baseQiBase: number; perActiveFactoryQiBase: number; maxQiBase: number; }
export interface RewardConfig {
  beta: number; floor: number; cap: number;
  minSamples: number;
  defaultQ0: number;
  q0ByOperation?: Record<string, number>;
  /** Used until the network has enough samples for an operation. */
  declaredStandards?: Record<string, number>;
  acceptedQualitySources: QualitySource[];
  /** Fraction of t₀ credited to the original creator when their work is reused. */
  reuseRoyaltyFraction: number;
  /** Optional: no operator takes more than this share of a section; the excess rolls over. */
  maxOperatorShareBps?: number;
  /** A factory counts toward pool growth only with at least this much score in the period. */
  minActiveScore: number;
  schedule: PoolSchedule;
  sections: PoolSection[];
}

export const defaultRewardConfig = (over: Partial<RewardConfig> = {}): RewardConfig => ({
  beta: 0.25, floor: 0.5, cap: 1.75, minSamples: 5, defaultQ0: 0.8,
  acceptedQualitySources: ["customer", "network_evaluator", "press_documented"],
  reuseRoyaltyFraction: 0.25, minActiveScore: 1,
  schedule: { baseQiBase: 100_000, perActiveFactoryQiBase: 10_000, maxQiBase: 1_000_000 },
  sections: [{ id: "all", name: "All factories", shareBps: 10_000 }],
  ...over
});

export const standardKey = (operation: string, sizeBand = "default") => `${operation}@${sizeBand}`;
export const durationSeconds = (d: Delivery) => Math.max(1, (Date.parse(d.deliveredAt) - Date.parse(d.submittedAt)) / 1000);
export const multiplier = (s: number, c: Pick<RewardConfig, "beta" | "floor" | "cap">) => Math.min(c.cap, Math.max(c.floor, 1 + c.beta * Math.log2(s)));

export function validateRewardConfig(c: RewardConfig): string[] {
  const e: string[] = [];
  if (!(c.beta >= 0) || !(c.floor > 0) || !(c.cap >= 1) || c.floor > 1) e.push("need beta ≥ 0, 0 < floor ≤ 1 ≤ cap");
  if (!c.sections.length || c.sections.reduce((t, s) => t + s.shareBps, 0) !== 10_000) e.push("section shares must sum to 10000 bps");
  if (new Set(c.sections.map((s) => s.id)).size !== c.sections.length) e.push("section ids must be unique");
  const { baseQiBase, perActiveFactoryQiBase, maxQiBase } = c.schedule;
  if (![baseQiBase, perActiveFactoryQiBase, maxQiBase].every((x) => Number.isInteger(x) && x >= 0) || maxQiBase < baseQiBase) e.push("schedule amounts must be non-negative integers with max ≥ base");
  if (c.maxOperatorShareBps !== undefined && (c.maxOperatorShareBps <= 0 || c.maxOperatorShareBps > 10_000)) e.push("maxOperatorShareBps must be 1..10000");
  if (c.acceptedQualitySources.includes("self")) e.push("self-graded quality can't earn rewards");
  return e;
}

const q0For = (op: string, c: RewardConfig) => c.q0ByOperation?.[op] ?? c.defaultQ0;
const qualifies = (d: Delivery, c: RewardConfig) => d.accepted && !d.reuseOf && c.acceptedQualitySources.includes(d.qualitySource) && d.quality >= q0For(d.operation, c);
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

/** Next period's standards from this period's qualifying deliveries; too few samples carries the old standard forward. */
export function computeStandards(deliveries: Delivery[], previous: Record<string, Standard>, c: RewardConfig): Record<string, Standard> {
  const out: Record<string, Standard> = {};
  const keys = new Set([...Object.keys(previous), ...deliveries.map((d) => standardKey(d.operation, d.sizeBand)), ...Object.keys(c.declaredStandards ?? {}).map((op) => standardKey(op))]);
  for (const key of [...keys].sort()) {
    const op = key.slice(0, key.lastIndexOf("@"));
    const times = deliveries.filter((d) => standardKey(d.operation, d.sizeBand) === key && qualifies(d, c)).map(durationSeconds);
    if (times.length >= c.minSamples) out[key] = { key, t0Seconds: median(times), q0: q0For(op, c), samples: times.length, source: "network" };
    else if (previous[key]) out[key] = { ...previous[key], source: "carried", samples: times.length };
    else if (c.declaredStandards?.[op] && key === standardKey(op)) out[key] = { key, t0Seconds: c.declaredStandards[op], q0: q0For(op, c), samples: times.length, source: "declared" };
  }
  return out;
}

/** Scores each delivery against the standards: t₀ × m(speedup) for independently judged work at or above q₀, a royalty for reuse, zero (with the reason) otherwise. */
export function scoreDeliveries(deliveries: Delivery[], all: Delivery[], standards: Record<string, Standard>, c: Pick<RewardConfig, "beta" | "floor" | "cap" | "acceptedQualitySources" | "reuseRoyaltyFraction">, sectionFor: (operation: string) => string | undefined = () => undefined): ScoredDelivery[] {
  const byId = new Map(all.map((d) => [d.id, d]));
  return deliveries.map((d) => {
    const seconds = durationSeconds(d);
    const base = { id: d.id, operatorPayeeId: d.operatorPayeeId, factoryId: d.factoryId, sectionId: sectionFor(d.operation), seconds, creditedTo: d.operatorPayeeId, creditedFactoryId: d.factoryId };
    const std = standards[standardKey(d.operation, d.sizeBand)];
    if (!d.accepted) return { ...base, score: 0, reason: "not accepted" };
    if (!c.acceptedQualitySources.includes(d.qualitySource)) return { ...base, score: 0, reason: `quality source ${d.qualitySource} isn't independent` };
    if (!std) return { ...base, score: 0, reason: "no standard yet for this operation" };
    if (d.quality < std.q0) return { ...base, t0Seconds: std.t0Seconds, score: 0, reason: `quality ${d.quality} below standard ${std.q0}` };
    if (d.reuseOf) {
      const original = byId.get(d.reuseOf);
      if (!original) return { ...base, t0Seconds: std.t0Seconds, score: 0, reason: "reuse of unknown original" };
      return { ...base, t0Seconds: std.t0Seconds, creditedTo: original.operatorPayeeId, creditedFactoryId: original.factoryId, score: std.t0Seconds * c.reuseRoyaltyFraction, reason: `reuse royalty to ${original.operatorPayeeId}` };
    }
    const speedup = std.t0Seconds / seconds;
    const m = multiplier(speedup, c);
    return { ...base, t0Seconds: std.t0Seconds, speedup, multiplier: m, score: std.t0Seconds * m, reason: "scored" };
  });
}

export interface ScoredDelivery { id: string; operatorPayeeId: string; factoryId: string; sectionId?: string; seconds: number; t0Seconds?: number; speedup?: number; multiplier?: number; score: number; reason: string; creditedTo: string; /** For reuse royalties, the factory that made the original. */ creditedFactoryId: string; }
export interface SectionResult { id: string; name: string; budgetQiBase: number; rolloverInQiBase: number; scoreTotal: number; paidQiBase: number; rolloverOutQiBase: number; }
export interface RewardPeriod {
  schema: "reward-period@1";
  id: string;
  start: string;
  end: string;
  config: RewardConfig;
  standards: Record<string, Standard>;
  nextStandards: Record<string, Standard>;
  pool: { totalQiBase: number; activeFactories: string[]; sections: SectionResult[] };
  deliveries: ScoredDelivery[];
  payouts: Array<{ payeeId: string; qiBase: number; score: number }>;
  previousPeriodId?: string;
  previousPeriodHash?: string;
  hash: string;
}

/**
 * Closes a period. Pure and deterministic: the same deliveries, standards, rollover and config always give the same
 * scores and payouts, and the sealed hash lets any operator recompute and check their pay.
 */
export function closeRewardPeriod(p: { id: string; start: string; end: string; deliveries: Delivery[]; standards: Record<string, Standard>; rollover: Record<string, number>; config: RewardConfig; previous?: { id: string; hash: string } }): RewardPeriod {
  const c = p.config;
  const errors = validateRewardConfig(c);
  if (errors.length) throw new Error(`invalid reward config: ${errors.join("; ")}`);
  const inPeriod = p.deliveries.filter((d) => d.deliveredAt >= p.start && d.deliveredAt <= p.end).sort((a, b) => a.id.localeCompare(b.id));
  const sectionFor = (op: string) => c.sections.find((s) => !s.operations || s.operations.includes(op));

  const scored = scoreDeliveries(inPeriod, p.deliveries, p.standards, c, (op) => sectionFor(op)?.id);

  const factoryScore = new Map<string, number>();
  for (const s of scored) factoryScore.set(s.factoryId, (factoryScore.get(s.factoryId) ?? 0) + s.score);
  const activeFactories = [...factoryScore].filter(([, v]) => v >= c.minActiveScore).map(([k]) => k).sort();
  const totalQiBase = Math.min(c.schedule.maxQiBase, c.schedule.baseQiBase + c.schedule.perActiveFactoryQiBase * activeFactories.length);

  const payouts = new Map<string, { qiBase: number; score: number }>();
  let allocated = 0;
  const sections: SectionResult[] = c.sections.map((sec, i) => {
    const share = i === c.sections.length - 1 ? totalQiBase - allocated : Math.floor((totalQiBase * sec.shareBps) / 10_000);
    allocated += share;
    const rolloverIn = p.rollover[sec.id] ?? 0;
    const budget = share + rolloverIn;
    const entries = scored.filter((s) => s.sectionId === sec.id && s.score > 0);
    const byPayee = new Map<string, number>();
    for (const e of entries) byPayee.set(e.creditedTo, (byPayee.get(e.creditedTo) ?? 0) + e.score);
    const scoreTotal = [...byPayee.values()].reduce((t, x) => t + x, 0);
    let paid = 0;
    if (scoreTotal > 0) for (const [payee, score] of [...byPayee].sort(([a], [b]) => a.localeCompare(b))) {
      let q = Math.floor((budget * score) / scoreTotal);
      if (c.maxOperatorShareBps !== undefined) q = Math.min(q, Math.floor((budget * c.maxOperatorShareBps) / 10_000));
      paid += q;
      const prev = payouts.get(payee) ?? { qiBase: 0, score: 0 };
      payouts.set(payee, { qiBase: prev.qiBase + q, score: prev.score + score });
    }
    return { id: sec.id, name: sec.name, budgetQiBase: share, rolloverInQiBase: rolloverIn, scoreTotal, paidQiBase: paid, rolloverOutQiBase: budget - paid };
  });

  const body: Omit<RewardPeriod, "hash"> = {
    schema: "reward-period@1", id: p.id, start: p.start, end: p.end, config: c, standards: p.standards,
    nextStandards: computeStandards(inPeriod, p.standards, c),
    pool: { totalQiBase, activeFactories, sections }, deliveries: scored,
    payouts: [...payouts].map(([payeeId, v]) => ({ payeeId, ...v })).filter((x) => x.qiBase > 0).sort((a, b) => a.payeeId.localeCompare(b.payeeId)),
    previousPeriodId: p.previous?.id, previousPeriodHash: p.previous?.hash
  };
  const clean = JSON.parse(JSON.stringify(body)) as Omit<RewardPeriod, "hash">;
  return { ...clean, hash: stableHash(clean) };
}

export function rewardPeriodHashValid(period: RewardPeriod): boolean { const { hash, ...rest } = period; return stableHash(rest) === hash; }
