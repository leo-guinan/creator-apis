import assert from "node:assert/strict";
import { test } from "node:test";
import { stableHash } from "../packages/contracts/src/index.js";
import { closeRewardPeriod, computeStandards, computeWaterfall, CreatorPayments, defaultRewardConfig, FakeGateway, multiplier, rewardPeriodHashValid, Store, type Delivery, type RewardConfig } from "../packages/payments/src/index.js";

const T = (s: number) => new Date(Date.parse("2026-10-20T12:00:00.000Z") + s * 1000).toISOString();
let n = 0;
const delivery = (over: Partial<Delivery> & { seconds?: number } = {}): Delivery => {
  const { seconds = 60, ...rest } = over;
  const start = 100 * ++n;
  return { id: `dlv_${n}`, factoryId: "f-a", operatorPayeeId: "operator:a", operation: "create-voice", submittedAt: T(start), deliveredAt: T(start + seconds), accepted: true, quality: 0.9, qualitySource: "customer", ...rest };
};
const period = { id: "2026-W43", start: "2026-10-19T00:00:00.000Z", end: "2026-10-25T23:59:59.999Z" };
const cfg = (over: Partial<RewardConfig> = {}) => defaultRewardConfig({ declaredStandards: { "create-voice": 60, "create-story": 300 }, schedule: { baseQiBase: 100_000, perActiveFactoryQiBase: 10_000, maxQiBase: 150_000 }, ...over });

test("the curve: each halving of time adds β; clamped at floor and cap", () => {
  const c = { beta: 0.25, floor: 0.5, cap: 1.75 };
  assert.deepEqual([0.25, 0.5, 1, 2, 4, 8, 20].map((s) => multiplier(s, c)), [0.5, 0.75, 1, 1.25, 1.5, 1.75, 1.75]);
});

test("standards adjust like difficulty: network median when there are enough samples, otherwise carried or declared", () => {
  const c = cfg({ minSamples: 3 });
  const declared = computeStandards([], {}, c);
  assert.deepEqual([declared["create-voice@default"].t0Seconds, declared["create-voice@default"].source], [60, "declared"]);
  const fast = [20, 30, 40].map((seconds) => delivery({ seconds }));
  const noise = [delivery({ seconds: 5, qualitySource: "self" }), delivery({ seconds: 5, quality: 0.5 }), delivery({ seconds: 5, accepted: false })];
  const next = computeStandards([...fast, ...noise], declared, c);
  assert.deepEqual([next["create-voice@default"].t0Seconds, next["create-voice@default"].source, next["create-voice@default"].samples], [30, "network", 3], "self-graded, low-quality and rejected work don't set the standard");
  const thin = computeStandards([delivery({ seconds: 1 })], next, c);
  assert.deepEqual([thin["create-voice@default"].t0Seconds, thin["create-voice@default"].source], [30, "carried"]);
  assert.equal(computeStandards([delivery({ sizeBand: "long" })], {}, c)["create-voice@long"], undefined, "a new size band has no standard until it earns one");
});

test("scoring: standard seconds × multiplier for independently judged quality; nothing for the rest", () => {
  const ds = [
    delivery({ id: "fast", seconds: 30 }),
    delivery({ id: "standard", seconds: 60 }),
    delivery({ id: "slow", seconds: 240 }),
    delivery({ id: "self-graded", qualitySource: "self" }),
    delivery({ id: "low-q", quality: 0.7 }),
    delivery({ id: "rejected", accepted: false }),
    delivery({ id: "no-standard", operation: "create-image" })
  ];
  const r = closeRewardPeriod({ ...period, deliveries: ds, standards: computeStandards([], {}, cfg()), rollover: {}, config: cfg() });
  const by = Object.fromEntries(r.deliveries.map((d) => [d.id, d]));
  assert.deepEqual([by.fast.score, by.standard.score, by.slow.score], [75, 60, 30]);
  assert.match(by["self-graded"].reason, /isn't independent/);
  assert.match(by["low-q"].reason, /below standard/);
  assert.equal(by.rejected.reason, "not accepted");
  assert.match(by["no-standard"].reason, /no standard/);
});

test("reused work pays a royalty to whoever made the original, not a speed bonus to whoever served it", () => {
  const original = delivery({ id: "orig", operatorPayeeId: "operator:maker" });
  const cached = delivery({ id: "cached", operatorPayeeId: "operator:cache", seconds: 1, reuseOf: "orig" });
  const r = closeRewardPeriod({ ...period, deliveries: [original, cached], standards: computeStandards([], {}, cfg()), rollover: {}, config: cfg() });
  const hit = r.deliveries.find((d) => d.id === "cached")!;
  assert.deepEqual([hit.creditedTo, hit.score], ["operator:maker", 15]);
  assert.deepEqual(r.payouts.map((p) => p.payeeId), ["operator:maker"]);
});

test("the pool grows with active factories up to a cap, and pays in proportion to score", () => {
  const c = cfg();
  const one = closeRewardPeriod({ ...period, deliveries: [delivery({ seconds: 30 }), delivery({ operatorPayeeId: "operator:b", factoryId: "f-b", seconds: 60 })], standards: computeStandards([], {}, c), rollover: {}, config: c });
  assert.equal(one.pool.totalQiBase, 120_000);
  assert.deepEqual(one.payouts.map((p) => [p.payeeId, p.qiBase]), [["operator:a", Math.floor((120_000 * 75) / 135)], ["operator:b", Math.floor((120_000 * 60) / 135)]]);
  assert.equal(one.payouts.reduce((t, p) => t + p.qiBase, 0) + one.pool.sections[0].rolloverOutQiBase, 120_000, "nothing is created or lost: remainder rolls over");
  const many = closeRewardPeriod({ ...period, deliveries: Array.from({ length: 9 }, (_, i) => delivery({ factoryId: `f-${i}` })), standards: computeStandards([], {}, c), rollover: {}, config: c });
  assert.equal(many.pool.totalQiBase, 150_000, "capped");
});

test("sections split the pool by need; an empty section rolls its budget into the next period", () => {
  const c = cfg({ sections: [{ id: "voices", name: "Voices", shareBps: 3000, operations: ["create-voice"] }, { id: "stories", name: "Stories", shareBps: 5000, operations: ["create-story"] }, { id: "everything-else", name: "Everything else", shareBps: 2000 }] });
  const r = closeRewardPeriod({ ...period, deliveries: [delivery(), delivery({ operation: "create-story", seconds: 300, operatorPayeeId: "operator:s" })], standards: computeStandards([], {}, c), rollover: { "everything-else": 500 }, config: c });
  const sec = Object.fromEntries(r.pool.sections.map((s) => [s.id, s]));
  assert.equal(r.pool.totalQiBase, 110_000);
  assert.deepEqual([sec.voices.budgetQiBase, sec.stories.budgetQiBase, sec["everything-else"].budgetQiBase], [33_000, 55_000, 22_000]);
  assert.deepEqual([sec["everything-else"].paidQiBase, sec["everything-else"].rolloverOutQiBase], [0, 22_500]);
  assert.deepEqual(r.payouts.map((p) => [p.payeeId, p.qiBase]), [["operator:a", 33_000], ["operator:s", 55_000]]);
});

test("an optional per-operator cap keeps one operator from taking a whole section", () => {
  const c = cfg({ maxOperatorShareBps: 5000 });
  const r = closeRewardPeriod({ ...period, deliveries: [delivery(), delivery(), delivery({ operatorPayeeId: "operator:b", factoryId: "f-b", seconds: 120 })], standards: computeStandards([], {}, c), rollover: {}, config: c });
  const a = r.payouts.find((p) => p.payeeId === "operator:a")!;
  assert.equal(a.qiBase, 60_000);
  assert.ok(r.pool.sections[0].rolloverOutQiBase > 0);
});

test("a closed period is sealed and deterministic, so anyone can recompute it", () => {
  const ds = [delivery({ seconds: 45 }), delivery({ operatorPayeeId: "operator:b", factoryId: "f-b" })];
  const args = { ...period, deliveries: ds, standards: computeStandards([], {}, cfg()), rollover: {}, config: cfg() };
  const r1 = closeRewardPeriod(args);
  assert.deepEqual(closeRewardPeriod({ ...args, deliveries: [...ds].reverse() }), r1);
  assert.ok(rewardPeriodHashValid(r1));
  assert.equal(rewardPeriodHashValid({ ...r1, payouts: [{ payeeId: "operator:a", qiBase: 999_999, score: 1 }] }), false);
  assert.throws(() => closeRewardPeriod({ ...args, config: { ...cfg(), sections: [{ id: "x", name: "x", shareBps: 9000 }] } }), /10000/);
  assert.throws(() => closeRewardPeriod({ ...args, config: { ...cfg(), acceptedQualitySources: ["self"] } }), /self-graded/);
});

test("in pool mode, sales no longer deduct energy: margin stays fiat", () => {
  const body = { schema: "operation-receipt@1" as const, id: "rcp_x", operation: "create-voice", factoryId: "f", runId: "r", status: "completed" as const, operatorId: "a", costUsd: 0, energy: { measuredWh: 4000, providerReportedWh: 0, estimatedWh: 0, unknownSteps: 0, methods: [] as string[] }, hosting: "operator" as const, startedAt: T(0), finishedAt: T(1) };
  const w = computeWaterfall({ grossCents: 10_000, stripeFeeCents: 320, quantity: 1, platformFeeBps: 0, tools: [], operatorPayeeId: "operator:a", marginShares: [{ payeeId: "creator:leo", bps: 10_000 }], receipts: [{ ...body, sha256: stableHash(body) }], acceptEnergy: ["measured"], deductEnergy: false });
  assert.equal(w.status, "ok");
  assert.equal(w.lines.find((l) => l.kind === "margin")!.usdCents, 9680);
});

test("service: periods chain, payouts queue as Qi, deliveries can't land in a closed period", async () => {
  const gateway = new FakeGateway();
  const store = new Store();
  let now = new Date("2026-10-26T12:00:00.000Z");
  const payments = new CreatorPayments(gateway, store, { publicUrl: "https://x.test", rewards: cfg({ minSamples: 2 }), now: () => now });
  for (const id of ["operator:a", "operator:b"]) await payments.registerPayee({ id, kind: "operator", displayName: id, email: `${id.slice(9)}@example.com`, qiAddress: "0x0080000000000000000000000000000000000001" });
  payments.recordDelivery(delivery({ id: "w43-1", seconds: 30 }));
  payments.recordDelivery(delivery({ id: "w43-2", seconds: 40, operatorPayeeId: "operator:b", factoryId: "f-b" }));
  assert.throws(() => payments.recordDelivery(delivery({ id: "bad", operatorPayeeId: "operator:nobody" })), /unknown payee/);
  assert.throws(() => payments.closeRewardPeriod({ id: "2026-W44", start: "2026-10-26T00:00:00.000Z", end: "2026-11-01T23:59:59.999Z" }), /before it ends/);
  const w43 = payments.closeRewardPeriod(period);
  assert.equal(payments.closeRewardPeriod(period), w43, "closing twice returns the same period");
  assert.equal(payments.currentStandards()["create-voice@default"].t0Seconds, 35, "next standard is last period's median");
  assert.throws(() => payments.recordDelivery({ ...delivery({ id: "late" }), deliveredAt: "2026-10-22T00:00:00.000Z", submittedAt: "2026-10-21T23:59:00.000Z" }), /already closed/);
  const batch = payments.exportQiBatch();
  assert.deepEqual(batch.payouts.map((p) => p.payeeId).sort(), ["operator:a", "operator:b"]);
  assert.equal(batch.payouts.reduce((t, p) => t + p.amountBase, 0), store.balance("qi:obligations", "qi_base"));
  now = new Date("2026-11-03T00:00:00.000Z");
  payments.recordDelivery({ ...delivery({ id: "w44-1" }), submittedAt: "2026-10-27T10:00:00.000Z", deliveredAt: "2026-10-27T10:00:35.000Z" });
  const w44 = payments.closeRewardPeriod({ id: "2026-W44", start: "2026-10-26T00:00:00.000Z", end: "2026-11-01T23:59:59.999Z" });
  assert.deepEqual([w44.previousPeriodId, w44.previousPeriodHash], [w43.id, w43.hash]);
  const statement = payments.operatorStatement("operator:a", { from: "2026-10-01", to: "2026-11-30" });
  assert.equal(statement.rewards.scored, 2);
  assert.ok(statement.rewards.qiBase > 0);
  for (const e of store.state.journal) assert.equal(e.postings.filter((p) => p.currency === "qi_base").reduce((t, p) => t + p.amount, 0), 0);
});
