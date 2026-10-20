import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stableHash, type OperationReceipt } from "../packages/contracts/src/index.js";
import { CreatorPayments, FakeGateway, Store, StripeGateway, createPaymentsServer, signReceipt } from "../packages/payments/src/index.js";

const NOW = new Date("2026-10-20T15:00:00.000Z");
const QI_ADDR = "0x00a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3";
let n = 0;
function receipt(over: Partial<OperationReceipt> & { wh?: number } = {}): OperationReceipt {
  const { wh = 0, ...rest } = over;
  const body = { schema: "operation-receipt@1" as const, id: `rcp_${++n}`, operation: "create-voice", factoryId: "presser", runId: `run_${n}`, status: "completed" as const, operatorId: "bob", creatorId: "leo", costUsd: 0.05, energy: { measuredWh: wh, providerReportedWh: 0, estimatedWh: 0, unknownSteps: 0, methods: [] as string[] }, hosting: "operator" as const, startedAt: "2026-10-20T14:00:00.000Z", finishedAt: "2026-10-20T14:00:05.000Z", ...rest };
  return { ...body, sha256: stableHash(body) };
}

async function setup() {
  const gateway = new FakeGateway();
  const store = new Store(join(await mkdtemp(join(process.cwd(), ".tmp-pay-")), "state.json"));
  const payments = new CreatorPayments(gateway, store, { publicUrl: "https://creatorapis.test", now: () => NOW });
  let evt = 0;
  const webhook = async (type: string, object: Record<string, unknown>, livemode = false) => { const payload = JSON.stringify({ id: `evt_${++evt}`, object: "event", type, livemode, data: { object } }); return payments.handleWebhook(payload, gateway.sign(payload)); };
  return { gateway, store, payments, webhook };
}

async function onboarded() {
  const t = await setup();
  const { payments, webhook, gateway } = t;
  await payments.setup();
  const creator = await payments.registerCreator({ id: "leo", email: "leo@example.com", name: "Leo", computeBudgetCents: 100 });
  const sub = await payments.subscribeCreator("leo");
  assert.match(sub.url, /checkout\.stripe\.test/);
  assert.equal(payments.entitlement("leo").canPublish, false);
  await webhook("checkout.session.completed", { id: sub.sessionId, mode: "subscription", subscription: "sub_1", customer: creator.stripeCustomerId, metadata: { kind: "creator_subscription", creator_id: "leo" } });
  await webhook("customer.subscription.created", { id: "sub_1", customer: creator.stripeCustomerId, status: "active", items: { data: [{ current_period_end: 1_793_000_000 }] } });
  assert.equal(payments.entitlement("leo").canPublish, true);
  for (const p of [{ id: "creator:leo", kind: "creator" as const, displayName: "Leo", email: "leo@example.com" }, { id: "operator:bob", kind: "operator" as const, displayName: "Bob's rig", email: "bob@example.com", qiAddress: QI_ADDR }, { id: "tool:ana", kind: "tool" as const, displayName: "Ana (Deck Renderer)", email: "ana@example.com" }]) {
    const { payee, onboardingUrl } = await payments.registerPayee(p);
    assert.match(onboardingUrl, /connect\.stripe\.test\/onboard\/acct_/);
    await webhook("account.updated", { id: payee.stripeAccountId, capabilities: { transfers: p.kind === "tool" ? "inactive" : "active" } });
  }
  payments.createOffer({ id: "deck-expert", creatorId: "leo", factoryId: "presser", name: "Deck expert: one finished deck", unitAmountCents: 10_000, operatorPayeeId: "operator:bob", tools: [{ toolId: "deck-renderer", payeeId: "tool:ana", perSaleCents: 500 }], marginShares: [{ payeeId: "creator:leo", bps: 8000 }, { payeeId: "operator:bob", bps: 2000 }] });
  return { ...t, creator };
}

test("the full loop: subscribe, sell at the creator's price, meter compute, settle energy in Qi and margin in fiat, pay out", async () => {
  const { payments, gateway, store, webhook } = await onboarded();
  const order = await payments.checkoutOffer("deck-expert", { customerEmail: "buyer@example.com" });
  const checkout = gateway.calls.find((c) => c.method === "createPaymentCheckout")!;
  assert.deepEqual([(checkout.params as { transferGroup: string }).transferGroup, checkout.idempotencyKey], [order.id, order.id]);

  // The factory does the work and sends receipts: operator energy, one provider call, one platform-hosted step.
  await payments.ingestReceipt(receipt({ orderRef: order.id, wh: 3000 }));
  await payments.ingestReceipt(receipt({ orderRef: order.id, hosting: "provider", costUsd: 0.4 }));
  const metered = await payments.ingestReceipt(receipt({ orderRef: order.id, hosting: "platform", costUsd: 0.25 }));
  assert.deepEqual([metered.status, metered.billedCents, metered.budgetRemainingCents], ["sent", 25, 75]);
  const meter = gateway.calls.filter((c) => c.method === "recordMeterEvent").map((c) => c.params as { value: string; identifier: string; customerId: string });
  assert.deepEqual(meter.map((m) => m.value), ["25.0000"]);

  gateway.payments.set("pi_1", { paymentIntentId: "pi_1", chargeId: "ch_1", amountCents: 10_000, feeCents: 320, status: "succeeded" });
  await webhook("checkout.session.completed", { id: order.checkoutSessionId, mode: "payment", payment_status: "paid", payment_intent: "pi_1", metadata: { kind: "offer_order", order_id: order.id } });
  assert.equal(store.state.orders[order.id].status, "paid");

  // Energy needs a quote before it can be settled.
  assert.equal((await payments.settleOrder(order.id)).status, "needs_quote");
  payments.recordQuote({ qiPerKwh: 2.5, usdPerQi: 0.2, source: "manual quote for the test", observedAt: "2026-10-20T14:30:00.000Z" });
  const { status, settlement } = await payments.settleOrder(order.id);
  assert.equal(status, "settled");
  const lines = settlement!.waterfall.lines.map((l) => [l.kind, l.payeeId ?? "-", l.usdCents, l.qiBase ?? 0]);
  const margin = 10_000 - 320 - 500 - 40 - 150;
  assert.deepEqual(lines, [["stripe_fee", "-", 320, 0], ["tool_royalty", "tool:ana", 500, 0], ["provider_passthrough", "operator:bob", 40, 0], ["energy", "operator:bob", 150, 7500], ["margin", "creator:leo", margin - Math.floor(margin * 0.2), 0], ["margin", "operator:bob", Math.floor(margin * 0.2), 0]]);
  assert.equal(store.balance(`order:${order.id}`, "usd_cents"), 0, "order fully allocated");

  // Fiat payouts: transfers tied to the source charge; Ana hasn't finished onboarding, so hers waits.
  const fiat = await payments.runFiatPayouts();
  const transfers = gateway.calls.filter((c) => c.method === "createTransfer").map((c) => ({ ...(c.params as Record<string, unknown>), key: c.idempotencyKey }) as Record<string, unknown>);
  assert.ok(transfers.every((t) => t.sourceTransaction === "ch_1" && t.transferGroup === order.id && String(t.key).startsWith("pay_")));
  assert.deepEqual(fiat.map((p) => [p.payeeId, p.status]).sort(), [["creator:leo", "sent"], ["operator:bob", "sent"], ["operator:bob", "sent"], ["tool:ana", "awaiting_account"]]);
  await webhook("account.updated", { id: store.state.payees["tool:ana"].stripeAccountId, capabilities: { transfers: "active" } });
  await payments.runFiatPayouts();
  assert.equal(Object.values(store.state.payouts).filter((p) => p.rail === "stripe" && p.status !== "sent").length, 0);
  assert.equal((await payments.runFiatPayouts()).length, 0, "nothing is paid twice");

  // Qi: exported for signing outside the service, then confirmed with the chain transaction.
  const batch = payments.exportQiBatch();
  assert.deepEqual(batch.payouts.map((p) => [p.to, p.amount, p.energyWh]), [[QI_ADDR, "7.500 Qi", 3000]]);
  assert.throws(() => payments.confirmQiPayout(batch.payouts[0].id, "0x123"), /32-byte/);
  payments.confirmQiPayout(batch.payouts[0].id, `0x${"ab".repeat(32)}`);
  assert.equal(store.balance("qi:obligations", "qi_base"), 0);

  const statement = payments.operatorStatement("operator:bob", { from: "2026-10-01", to: "2026-10-31" });
  assert.equal(statement.qi.earned, "7.500 Qi");
  assert.equal(statement.qi.owedBase, 0);
  assert.equal(statement.fiat.owedCents, 0);
  assert.equal(statement.energy.reimbursedWh, 3000);
  assert.equal(statement.energyCostShareOfRevenue, 150 / 10_000);
  for (const e of store.state.journal) for (const c of ["usd_cents", "qi_base"]) assert.equal(e.postings.filter((p) => p.currency === c).reduce((t, p) => t + p.amount, 0), 0, `${e.id} balanced`);
});

test("compute is bounded: usage over the creator's monthly budget is not billed, and the factory is told to stop", async () => {
  const { payments } = await onboarded();
  const first = await payments.ingestReceipt(receipt({ hosting: "platform", costUsd: 0.8 }));
  const second = await payments.ingestReceipt(receipt({ hosting: "platform", costUsd: 0.5 }));
  assert.deepEqual([first.status, first.billedCents, first.stop], ["sent", 80, false]);
  assert.deepEqual([second.status, second.billedCents, second.unbilledCents, second.stop], ["partly_over_budget", 20, 30, true]);
  assert.equal((await payments.ingestReceipt(receipt({ hosting: "platform", costUsd: 0.1 }))).status, "over_budget");
  assert.equal((await payments.ingestReceipt(receipt({ hosting: "platform", finishedAt: "2026-08-01T00:00:00.000Z" }))).status, "too_old");
});

test("receipts are verified and idempotent", async () => {
  const { payments } = await onboarded();
  const r = receipt({ hosting: "platform", costUsd: 0.1 });
  await payments.ingestReceipt(r);
  assert.equal((await payments.ingestReceipt(r)).duplicate, true);
  await assert.rejects(payments.ingestReceipt({ ...r, costUsd: 0 }), /sha256 does not match/);
  await assert.rejects(payments.ingestReceipt({ ...r, sha256: stableHash({ ...r, sha256: undefined, costUsd: 0 }), costUsd: 0 }), /different contents/);
});

test("webhooks: bad signatures are rejected, duplicates ignored, live events refused in test mode", async () => {
  const { payments, gateway, webhook } = await setup();
  const payload = JSON.stringify({ id: "evt_x", object: "event", type: "invoice.paid", livemode: false, data: { object: {} } });
  await assert.rejects(payments.handleWebhook(payload, "t=1,v1=deadbeef"), /signature/i);
  const sig = gateway.sign(payload);
  assert.equal((await payments.handleWebhook(payload, sig)).duplicate, false);
  assert.equal((await payments.handleWebhook(payload, sig)).duplicate, true);
  assert.ok(await webhook("invoice.paid", {}, true), "fake gateway accepts live flag; only test-mode Stripe refuses");
});

test("you can't sell without an active subscription, and a refund after settlement is flagged for reversal", async () => {
  const { payments, gateway, store, webhook, creator } = await onboarded();
  const order = await payments.checkoutOffer("deck-expert");
  gateway.payments.set("pi_2", { paymentIntentId: "pi_2", chargeId: "ch_2", amountCents: 10_000, feeCents: 320, status: "succeeded" });
  await webhook("checkout.session.completed", { payment_status: "paid", payment_intent: "pi_2", metadata: { kind: "offer_order", order_id: order.id } });
  assert.equal((await payments.settleOrder(order.id)).status, "settled", "no operator energy, so no quote needed");
  await webhook("charge.refunded", { id: "ch_2", payment_intent: "pi_2", amount_refunded: 10_000 });
  assert.ok(store.state.orders[order.id].flags.includes("needs_reversal"));
  assert.equal(store.balance(`order:${order.id}`, "usd_cents"), 10_000, "the order account shows what was paid out but refunded");
  await webhook("customer.subscription.deleted", { id: "sub_1", customer: creator.stripeCustomerId, status: "canceled" });
  await assert.rejects(payments.checkoutOffer("deck-expert"), /active subscription/);
});

test("offers and payees are validated; Qi addresses must be on the Qi ledger", async () => {
  const { payments } = await onboarded();
  assert.throws(() => payments.createOffer({ id: "x", creatorId: "leo", factoryId: "f", name: "x", unitAmountCents: 10, operatorPayeeId: "operator:nobody", marginShares: [{ payeeId: "creator:leo", bps: 5000 }] }), /at least 50.*10000 bps.*unknown payee operator:nobody/);
  assert.throws(() => payments.setQiAddress("operator:bob", "0x0040000000000000000000000000000000000001"), /not a Qi-ledger address/);
  await assert.rejects(payments.registerPayee({ id: "operator:eve", kind: "creator", displayName: "Eve", email: "e@example.com" }), /<kind>:<slug>/);
});

test("the Stripe gateway refuses live keys unless explicitly allowed", () => {
  assert.throws(() => new StripeGateway({ secretKey: "sk_live_abc", webhookSecret: "whsec_x" }), /refusing a live Stripe key/);
  assert.throws(() => new StripeGateway({ secretKey: "pk_test_abc", webhookSecret: "whsec_x" }), /secret or restricted key/);
  assert.equal(new StripeGateway({ secretKey: "sk_test_abc", webhookSecret: "whsec_x" }).mode, "test");
});

test("HTTP: admin token, factory-signed receipts, Stripe-signed webhooks", async () => {
  const { payments, gateway } = await onboarded();
  const server = createPaymentsServer(payments, { adminToken: "a".repeat(32), factorySecrets: { presser: "factory-secret" } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/creators/leo/entitlement`)).status, 401);
    const ent = await (await fetch(`${base}/v1/creators/leo/entitlement`, { headers: { authorization: `Bearer ${"a".repeat(32)}` } })).json() as { canPublish: boolean };
    assert.equal(ent.canPublish, true);
    const body = JSON.stringify(receipt({ hosting: "platform", costUsd: 0.1 }));
    assert.equal((await fetch(`${base}/v1/receipts`, { method: "POST", body, headers: { "x-factory-signature": signReceipt(body, "wrong") } })).status, 401);
    const ok = await fetch(`${base}/v1/receipts`, { method: "POST", body, headers: { "x-factory-signature": signReceipt(body, "factory-secret") } });
    assert.deepEqual([ok.status, ((await ok.json()) as { billedCents: number }).billedCents], [200, 10]);
    const payload = JSON.stringify({ id: "evt_http", object: "event", type: "invoice.paid", livemode: false, data: { object: { id: "in_1", customer: "cus_fake_1", amount_paid: 2000 } } });
    const wh = await fetch(`${base}/v1/stripe/webhook`, { method: "POST", body: payload, headers: { "stripe-signature": gateway.sign(payload) } });
    assert.equal(wh.status, 200);
    assert.equal(payments.store.balance("platform:revenue", "usd_cents"), -2000);
  } finally { server.close(); }
});
