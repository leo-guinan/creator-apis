import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { commissionHashValid, CreatorPayments, FakeGateway, learningReport, project, Store, validatePool, type Commission, type CommissionPool } from "../packages/payments/src/index.js";

const repo = resolve(process.cwd(), "../..");
const committed = JSON.parse(readFileSync(join(repo, "creators/leo/factories/music-video/commission-pool.json"), "utf8")) as Omit<CommissionPool, "createdAt">;
const QI_ADDR = "0x0080000000000000000000000000000000000001";

async function setup(over: Partial<CommissionPool> = {}) {
  let now = new Date("2026-10-21T12:00:00.000Z");
  const payments = new CreatorPayments(new FakeGateway(), new Store(), { publicUrl: "https://x.test", now: () => now });
  for (const id of ["operator:leo", "miner:rig", "miner:farm"]) await payments.registerPayee({ id, kind: id.split(":")[0] as "miner", displayName: id, email: "x@example.com", qiAddress: QI_ADDR });
  const pool = payments.registerCommissionPool({ ...committed, miners: [{ payeeId: "miner:rig", maxOpen: 1 }, { payeeId: "miner:farm", maxOpen: 3 }], ...over });
  const quote = (usdPerQi: number) => payments.recordQuote({ qiPerKwh: 10, usdPerQi, source: "test quote", observedAt: now.toISOString() });
  const tick = (hours: number) => { now = new Date(now.getTime() + hours * 3_600_000); };
  let tx = 0;
  /** Runs one commission end to end and returns it. */
  const make = (p: { units: [number, number]; seconds?: number; miner?: string; accept?: boolean; usdPerQi?: number }) => {
    if (p.usdPerQi) quote(p.usdPerQi);
    const c = payments.requestCommission({ poolId: pool.id, minerPayeeId: p.miner ?? "miner:farm", title: `video ${tx + 1}`, requestedSeconds: p.seconds ?? 143.6 });
    payments.confirmCommissionPayment(c.id, { txHash: `0xtx${++tx}`, qiBase: c.quote.qiBase });
    tick(24);
    payments.deliverCommission(c.id, { firstCutUnits: p.units[0], fixUnits: p.units[1], finishedSeconds: p.seconds ?? 143.6, artifactRef: `render:${tx}` });
    tick(1);
    return payments.decideCommission(c.id, p.accept === false ? { accepted: false, reason: "chorus off the beat" } : { accepted: true, quality: 0.9 });
  };
  return { payments, pool, quote, tick, make };
}

test("the committed music video pool is valid and its baseline is ALL GREEN at $64", () => {
  assert.deepEqual(validatePool({ ...committed, createdAt: "2026-10-21T00:00:00.000Z" }), []);
  assert.equal(Math.round((committed.baseline.units * committed.tool.usdCents) / committed.tool.units), 6400);
});

test("the first quote is the $40 projection, priced in Qi at the sourced rate", async () => {
  const { payments, quote, pool } = await setup();
  quote(0.05);
  const c = payments.requestCommission({ poolId: pool.id, minerPayeeId: "miner:rig", title: "first commission", requestedSeconds: 143.6 });
  assert.deepEqual([c.projection.basis, c.projection.n, c.quote.units, c.quote.usdCents, c.quote.qiBase], ["prior", 2, 1440, 4000, 800_000]);
  assert.match(c.quote.energyQuoteId, /^quote_/);
});

test("pay → deliver → accept: Qi held, then earned; the verdict counts as a customer delivery", async () => {
  const { payments, make } = await setup();
  const c = make({ units: [1100, 250], usdPerQi: 0.05 });
  assert.equal(c.status, "accepted");
  assert.ok(commissionHashValid(c));
  const b = payments.store.balances();
  assert.equal(b["qi:wallet:music-video|qi_base"], 800_000);
  assert.equal(b["earned_qi:music-video|qi_base"], -800_000);
  assert.equal(b[`commission:${c.id}|qi_base`] ?? 0, 0);
  const d = payments.store.state.deliveries[`delivery:${c.id}`];
  assert.deepEqual([d.accepted, d.qualitySource, d.operation], [true, "customer", "create-music-video"]);
  const r = payments.learningReport("music-video-pilot");
  assert.equal(r.rows[1].underRunUnits, 90, "quoted 1,440, used 1,350");
  assert.equal(r.rows[1].meetsFixTarget, true);
  assert.equal(r.rows[0].meetsFixTarget, false, "ALL GREEN's fixes were 99% of the first cut");
});

test("Qi per second splits exactly into skill, tool price and Qi price", async () => {
  const { payments, make } = await setup();
  make({ units: [1100, 250], usdPerQi: 0.05 });
  make({ units: [1000, 200], usdPerQi: 0.04 }); // Qi got cheaper in USD, so miners pay more Qi for the same work
  const third = make({ units: [900, 150], usdPerQi: 0.04 });
  const r = payments.learningReport("music-video-pilot");
  for (const row of r.rows.slice(2)) {
    const ch = row.change!;
    assert.ok(Math.abs(ch.total - (ch.skill + ch.toolPrice + ch.qiPrice)) < 1e-3, "the three causes sum to the total");
    assert.ok(ch.skill < 0, "the factory got faster");
    assert.equal(ch.toolPrice, 0);
  }
  assert.ok(r.rows[2].change!.qiPrice > 0, "a weaker Qi pushes the Qi price up");
  assert.ok(r.cumulative!.skill < 0);
  assert.equal(r.rows.length, 4);
  assert.equal(third.projection.basis, "fit", "three points (baseline + two accepted) switch the quote to the fitted curve");
});

test("the curve is fitted from accepted work only; a rejection is a note, not a point", async () => {
  const { payments, make } = await setup();
  make({ units: [1100, 250], usdPerQi: 0.05 });
  make({ units: [3000, 0], accept: false, usdPerQi: 0.05 });
  make({ units: [1000, 200], usdPerQi: 0.05 });
  const r = payments.learningReport("music-video-pilot");
  assert.equal(r.rows.length, 3);
  assert.match(r.notes.join(" "), /1 rejected: .*chorus off the beat/);
  assert.equal(r.next.basis, "fit");
  assert.ok(r.next.learningRate > 0.5 && r.next.learningRate < 0.8, `fitted rate ${r.next.learningRate}`);
  assert.ok(r.next.unitsPerSecond < 1200 / 143.6);
});

test("a rejection refunds the miner's share and the refund is confirmed by tx", async () => {
  const { payments, make } = await setup({ rejectionRefundBps: 5000 });
  const c = make({ units: [1500, 0], accept: false, usdPerQi: 0.05 });
  assert.equal(c.decision!.refundQiBase, 400_000);
  assert.equal(payments.store.balances()["payable_qi:miner:farm|qi_base"], -400_000);
  const done = payments.confirmCommissionRefund(c.id, "0xrefund");
  assert.ok(commissionHashValid(done));
  assert.equal(payments.store.balances()["qi:wallet:music-video|qi_base"], 400_000);
  assert.equal(payments.store.state.deliveries[`delivery:${c.id}`].rejectionReason, "chorus off the beat");
});

test("guards: pool membership, open caps, stale Qi quotes, short payments, reused tx, reasonless rejections", async () => {
  const { payments, quote, tick, pool } = await setup();
  const req = (miner = "miner:rig") => payments.requestCommission({ poolId: pool.id, minerPayeeId: miner, title: "t", requestedSeconds: 120 });
  assert.throws(() => req(), /Qi quote: no energy quote/);
  quote(0.05);
  assert.throws(() => req("miner:stranger"), /not in pool/);
  const a = req();
  assert.throws(() => req(), /already has 1 open/);
  assert.throws(() => payments.confirmCommissionPayment(a.id, { txHash: "0x1", qiBase: a.quote.qiBase - 1 }), /below the quote/);
  payments.confirmCommissionPayment(a.id, { txHash: "0x1", qiBase: a.quote.qiBase });
  const b = req("miner:farm");
  assert.throws(() => payments.confirmCommissionPayment(b.id, { txHash: "0x1", qiBase: b.quote.qiBase }), /already paid another/);
  tick(25);
  assert.throws(() => req("miner:farm"), /quote is 25.0h old/);
  assert.equal(payments.store.state.commissions[b.id].status, "expired", "unpaid quotes expire after quoteValidHours");
  quote(0.05);
  req("miner:farm");
  payments.deliverCommission(a.id, { firstCutUnits: 1000, fixUnits: 100, finishedSeconds: 120, artifactRef: "render:a" });
  assert.throws(() => payments.decideCommission(a.id, { accepted: false }), /needs a reason/);
  assert.throws(() => payments.decideCommission(a.id, { accepted: true }), /quality score/);
  assert.throws(() => payments.registerCommissionPool({ ...committed, miners: [{ payeeId: "miner:rig", maxOpen: 1 }], priorLearningRate: 0.5 }), /priorLearningRate can't change/);
});

test("projection math: the prior gives $40 next, then the fit takes over and clamps wild swings", () => {
  const pool = { ...committed, createdAt: "x" } as CommissionPool;
  assert.ok(Math.abs(project(pool, []).unitsPerSecond * 143.6 - 1440) < 1e-6);
  const accepted = (i: number, units: number): Commission => ({ id: `c${i}`, poolId: pool.id, factoryId: "music-video", minerPayeeId: "miner:rig", brief: { title: "x", requestedSeconds: 100 }, status: "accepted", projection: project(pool, []), quote: { units, usdCents: 0, qiBase: 1000, usdPerQi: 1, energyQuoteId: "q", tool: pool.tool, validUntil: "", at: "" }, delivery: { at: "", firstCutUnits: units, fixUnits: 0, finishedSeconds: 100, artifactRef: "r", receiptIds: [] }, decision: { at: `2026-10-2${i}`, accepted: true, refundQiBase: 0 } });
  // A factory that suddenly needs almost nothing: the slope is clamped at b = 1.5.
  const p = project(pool, [accepted(1, 100), accepted(2, 1)]);
  assert.equal(p.basis, "fit");
  assert.ok(p.learningRate >= 2 ** -1.5 - 1e-12);
  assert.equal(learningReport(pool, [accepted(1, 1000)]).rows.length, 2);
});
