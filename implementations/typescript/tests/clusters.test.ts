import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { stableHash, type ClusterCharter } from "../packages/contracts/src/index.js";
import { closeClusterEpoch, clusterEpochHashValid, clusterEpochReconciles, computeStandards, CreatorPayments, defaultRewardConfig, FakeGateway, Store, type Delivery, type Win } from "../packages/payments/src/index.js";

const repo = resolve(process.cwd(), "../..");
const example = JSON.parse(readFileSync(join(repo, "contracts/examples/cluster-charter.example.json"), "utf8")) as ClusterCharter;
const members = { miners: [{ id: "miner:rig" }], factories: ["a", "b", "c", "d"].map((f) => ({ factoryId: f, creatorId: `creator-${f}`, sponsors: f === "a" ? ["miner:rig"] : [] })) };
const charter = (over: Partial<ClusterCharter["revenueMining"]> = {}): ClusterCharter => ({ ...example, id: "test-cluster", members, revenueMining: { ...example.revenueMining, minTenureEpochs: 0, ...over } });
const standards = computeStandards([], {}, defaultRewardConfig({ declaredStandards: { "create-voice": 60 } }));
const W1 = { id: "e1", start: "2026-10-19T00:00:00.000Z", end: "2026-10-25T23:59:59.999Z" };
const W2 = { id: "e2", start: "2026-10-26T00:00:00.000Z", end: "2026-11-01T23:59:59.999Z" };
let n = 0;
const work = (factoryId: string, count: number, day = "2026-10-21"): Delivery[] => Array.from({ length: count }, () => { const i = ++n; return { id: `d${i}`, factoryId, operatorPayeeId: `operator:${factoryId}`, operation: "create-voice", submittedAt: `${day}T10:00:00.000Z`, deliveredAt: `${day}T10:01:00.000Z`, accepted: true, quality: 0.9, qualitySource: "customer" as const }; });
const win = (id: string, factoryId: string, marginCents: number, customerKey = id, at = "2026-10-22T12:00:00.000Z"): Win => ({ id, factoryId, customerKey, marginCents, at });

test("the spec's worked example: finders keep the majority, the pot pays everyone who worked, the burn comes off the top", () => {
  const e = closeClusterEpoch({ charter: charter(), epoch: W1, wins: [win("ordA", "a", 100_000), win("ordC", "c", 30_000)], deliveries: [...work("a", 4), ...work("b", 3), ...work("c", 2), ...work("d", 1)], standards });
  assert.deepEqual(e.wins.map((w) => [w.id, w.setAsideCents, w.burnCents, w.finderCents, w.potCents]), [["ordA", 20_000, 4_000, 9_600, 6_400], ["ordC", 6_000, 1_200, 2_880, 1_920]]);
  assert.deepEqual(e.payouts.map((p) => [p.factoryId, p.finderCents, p.potCents, p.totalCents]), [["a", 9_600, 3_328, 12_928], ["b", 0, 2_496, 2_496], ["c", 2_880, 1_664, 4_544], ["d", 0, 832, 832]]);
  assert.equal(e.burn.cents, 5_200);
  assert.ok(clusterEpochReconciles(e));
  assert.ok(clusterEpochHashValid(e));
});

test("charters change the outcome: a co-op charter with a small finder share pays more through the pot", () => {
  const inputs = { epoch: W1, wins: [win("ordA", "a", 100_000)], deliveries: [...work("a", 1), ...work("b", 3)], standards };
  const pool = closeClusterEpoch({ ...inputs, charter: charter() });
  const coop = closeClusterEpoch({ ...inputs, charter: charter({ finderBps: 1000, burnBps: 0 }) });
  const b = (e: typeof pool) => e.payouts.find((p) => p.factoryId === "b")?.totalCents ?? 0;
  assert.ok(b(coop) > b(pool));
  assert.equal(coop.burn.cents, 0);
  assert.ok(clusterEpochReconciles(coop));
});

test("a repeat customer earns the factory no second finder bonus (wash sales don't pay)", () => {
  const e = closeClusterEpoch({ charter: charter(), epoch: W1, wins: [win("o1", "a", 10_000, "same"), win("o2", "a", 10_000, "same", "2026-10-23T00:00:00.000Z"), win("o3", "a", 10_000, "other")], deliveries: work("a", 1), standards });
  const by = Object.fromEntries(e.wins.map((w) => [w.id, w]));
  assert.deepEqual([by.o1.finderEligible, by.o2.finderEligible, by.o3.finderEligible], [true, false, true]);
  assert.equal(by.o2.finderCents, 0);
  assert.ok(clusterEpochReconciles(e));
});

test("tenure, trailing window and no-win decay", () => {
  const c = charter({ minTenureEpochs: 1, workshareWindowEpochs: 2, noWinDecayEpochs: 1, perFactoryCapBps: undefined });
  const e1 = closeClusterEpoch({ charter: c, epoch: W1, wins: [win("w1", "a", 50_000)], deliveries: [...work("a", 2), ...work("b", 2)], standards });
  assert.ok(e1.workshares.every((w) => !w.eligible), "nobody has tenure in the first epoch");
  assert.equal(e1.pot.distributedCents, 0);
  assert.equal(e1.pot.rolloverOutCents, e1.pot.fromWinsCents, "undistributed pot rolls over");
  const e2 = closeClusterEpoch({ charter: c, epoch: W2, wins: [win("w2", "a", 50_000, "w2", "2026-10-28T00:00:00.000Z")], deliveries: [...work("a", 1, "2026-10-28"), ...work("b", 1, "2026-10-28")], standards, history: [e1] });
  const a = e2.workshares.find((w) => w.factoryId === "a")!, b = e2.workshares.find((w) => w.factoryId === "b")!;
  assert.deepEqual([a.windowScore, b.windowScore], [180, 180], "window includes last epoch's work");
  assert.deepEqual([a.weight, b.weight], [180, 45], "b hasn't won in 2 epochs: weight halves per epoch without a win");
  assert.equal(e2.pot.rolloverInCents, e1.pot.rolloverOutCents);
  assert.equal(e2.previousEpochHash, e1.hash);
  assert.ok(clusterEpochReconciles(e2));
  const ignition = closeClusterEpoch({ charter: c, epoch: W2, wins: [win("w2", "a", 50_000, "w2", "2026-10-28T00:00:00.000Z")], deliveries: [...work("a", 1, "2026-10-28"), ...work("b", 1, "2026-10-28")], standards, history: [e1], phases: { b: "ignition" } });
  assert.equal(ignition.workshares.find((w) => w.factoryId === "b")!.weight, 180, "no decay while a factory is still in Ignition");
});

test("per-factory cap rolls the excess over; non-members and double counting are excluded", () => {
  const e = closeClusterEpoch({ charter: charter({ perFactoryCapBps: 2500 }), epoch: W1, wins: [win("ok", "a", 100_000), win("stranger", "zz", 100_000)], deliveries: [...work("a", 9), ...work("b", 1), ...work("zz", 3), { ...work("b", 1)[0], clusterId: "another-cluster" }], standards });
  const a = e.payouts.find((p) => p.factoryId === "a")!;
  assert.equal(a.potCents, Math.floor((e.pot.fromWinsCents * 2500) / 10_000));
  assert.ok(e.pot.rolloverOutCents > 0);
  assert.deepEqual(e.excluded.map((x) => [x.kind, x.reason]).sort(), [["delivery", "attributed to cluster another-cluster"], ["delivery", "factory is not a member"], ["delivery", "factory is not a member"], ["delivery", "factory is not a member"], ["win", "factory is not a member"]]);
  assert.ok(clusterEpochReconciles(e));
  const next = closeClusterEpoch({ charter: charter(), epoch: W2, wins: [win("ok", "a", 100_000, "ok", "2026-10-28T00:00:00.000Z")], deliveries: [], standards, history: [e] });
  assert.deepEqual(next.excluded.map((x) => x.reason), ["already counted in an earlier epoch"]);
});

test("epochs are deterministic, sealed, chained, and refuse an invalid charter or broken history", () => {
  const inputs = { charter: charter(), epoch: W1, wins: [win("x", "a", 40_000)], deliveries: [...work("a", 2), ...work("c", 1)], standards };
  const e = closeClusterEpoch(inputs);
  assert.deepEqual(closeClusterEpoch({ ...inputs, wins: [...inputs.wins].reverse(), deliveries: [...inputs.deliveries].reverse() }), e);
  assert.equal(clusterEpochHashValid({ ...e, burn: { ...e.burn, cents: 0 } }), false);
  assert.throws(() => closeClusterEpoch({ ...inputs, charter: { ...charter(), quality: { ...charter().quality, acceptedSources: ["self"] } } }), /self-graded/);
  assert.throws(() => closeClusterEpoch({ ...inputs, epoch: W2, history: [{ ...e, previousEpochHash: "f".repeat(64) }] }), /not a chain/);
});

test("service: charter, cluster offer, set-aside at settlement, epoch close, payouts and the burn ritual", async () => {
  const gateway = new FakeGateway();
  const store = new Store();
  let now = new Date("2026-10-22T10:00:00.000Z");
  const payments = new CreatorPayments(gateway, store, { publicUrl: "https://x.test", rewards: defaultRewardConfig({ declaredStandards: { "create-voice": 60 } }), now: () => now });
  await payments.registerCreator({ id: "leo", email: "leo@example.com", name: "Leo" });
  const creator = store.state.creators.leo;
  const sign = async (type: string, object: Record<string, unknown>) => { const payload = JSON.stringify({ id: `evt_${type}_${Math.random()}`, object: "event", type, livemode: false, data: { object } }); return payments.handleWebhook(payload, gateway.sign(payload)); };
  await sign("customer.subscription.created", { id: "sub", customer: creator.stripeCustomerId, status: "active" });
  for (const id of ["creator:leo", "operator:leo"]) { const { payee } = await payments.registerPayee({ id, kind: id.split(":")[0] as "creator" | "operator", displayName: id, email: "leo@example.com" }); await sign("account.updated", { id: payee.stripeAccountId, capabilities: { transfers: "active" } }); }

  const v1 = { ...example, effectiveFrom: "2026-10-19T00:00:00.000Z", revenueMining: { ...example.revenueMining, minTenureEpochs: 0 } };
  payments.registerCharter(v1);
  assert.equal(payments.registerCharter(v1), store.state.charters[v1.id][0], "re-registering the same version is idempotent");
  assert.throws(() => payments.registerCharter({ ...v1, version: 2, effectiveFrom: "2026-11-02T00:00:00.000Z" }), /hash of the previous version/);

  payments.createOffer({ id: "voice-pack", creatorId: "leo", factoryId: "presser", clusterId: v1.id, name: "Voice pack", unitAmountCents: 10_000, operatorPayeeId: "operator:leo" });
  const order = await payments.checkoutOffer("voice-pack", { customerEmail: "buyer@example.com" });
  gateway.payments.set("pi_c", { paymentIntentId: "pi_c", chargeId: "ch_c", amountCents: 10_000, feeCents: 320, status: "succeeded" });
  await sign("checkout.session.completed", { payment_status: "paid", payment_intent: "pi_c", metadata: { kind: "offer_order", order_id: order.id } });
  const { settlement } = await payments.settleOrder(order.id);
  const setAside = settlement!.waterfall.lines.find((l) => l.kind === "cluster_set_aside")!;
  assert.deepEqual([setAside.usdCents, setAside.payeeId], [Math.floor(9_680 * 0.2), `cluster:${v1.id}`]);
  assert.ok(settlement!.waterfall.checks.linesSumToGross);
  assert.equal(store.state.clusterWins[v1.id][0].marginCents, 9_680);

  for (const d of [...work("presser", 2, "2026-10-21"), ...work("research-factory", 1, "2026-10-21")]) payments.recordDelivery({ ...d, operatorPayeeId: "operator:leo" });
  assert.throws(() => payments.closeClusterEpoch(v1.id, W1), /before it ends/);
  now = new Date("2026-10-27T09:00:00.000Z");
  const epoch = payments.closeClusterEpoch(v1.id, W1);
  assert.equal(payments.closeClusterEpoch(v1.id, W1), epoch, "closing twice returns the same record");
  assert.ok(clusterEpochReconciles(epoch));
  assert.equal(epoch.payouts.reduce((t, p) => t + p.totalCents, 0) + epoch.burn.cents + epoch.pot.rolloverOutCents, setAside.usdCents);

  const fiat = await payments.runFiatPayouts();
  assert.ok(fiat.some((p) => p.line.kind === "cluster_payout" && p.status === "sent"));
  payments.confirmClusterBurn(v1.id, W1.id, `0x${"cd".repeat(32)}`);
  assert.equal(store.balance(`burn_reserve:cluster:${v1.id}`, "usd_cents"), 0);
  assert.equal(store.balance(`payable:cluster:${v1.id}`, "usd_cents"), -epoch.pot.rolloverOutCents, "the cluster account holds exactly the rollover");
  assert.throws(() => payments.registerCharter({ ...v1, version: 2, previousVersionHash: stableHash(v1), effectiveFrom: "2026-10-25T00:00:00.000Z" }), /already closed/);
  for (const e of store.state.journal) assert.equal(e.postings.filter((p) => p.currency === "usd_cents").reduce((t, p) => t + p.amount, 0), 0, e.id);
});
