import assert from "node:assert/strict";
import { test } from "node:test";
import { stableHash, type OperationReceipt } from "../packages/contracts/src/index.js";
import { computeWaterfall, formatQi, isQiAddress, priceEnergy, validateQuote, type EnergyQuote, type WaterfallInput } from "../packages/payments/src/index.js";

const quote: EnergyQuote = { id: "q1", qiPerKwh: 2.5, usdPerQi: 0.2, source: "test quote", observedAt: "2026-10-20T12:00:00.000Z" };
export function receipt(over: Partial<OperationReceipt> & { wh?: number; cls?: "measuredWh" | "providerReportedWh" | "estimatedWh" } = {}): OperationReceipt {
  const { wh = 0, cls = "measuredWh", ...rest } = over;
  const body = { schema: "operation-receipt@1" as const, id: `rcp_${Math.random().toString(16).slice(2, 10)}`, operation: "create-story", factoryId: "presser", runId: "run_1", status: "completed" as const, operatorId: "bob", creatorId: "leo", orderRef: "ord_1", costUsd: 0, energy: { measuredWh: 0, providerReportedWh: 0, estimatedWh: 0, unknownSteps: 0, methods: [] as string[], [cls]: wh }, hosting: "operator" as const, startedAt: "2026-10-20T12:00:00.000Z", finishedAt: "2026-10-20T12:00:01.000Z", ...rest };
  return { ...body, sha256: stableHash(body) };
}
const base = (over: Partial<WaterfallInput> = {}): WaterfallInput => ({ grossCents: 10_000, stripeFeeCents: 320, quantity: 1, platformFeeBps: 0, tools: [], operatorPayeeId: "operator:bob", marginShares: [{ payeeId: "creator:leo", bps: 7000 }, { payeeId: "operator:bob", bps: 3000 }], receipts: [], quote, acceptEnergy: ["measured", "provider_reported", "estimated"], ...over });
const line = (w: ReturnType<typeof computeWaterfall>, kind: string, payee?: string) => w.lines.filter((l) => l.kind === kind && (!payee || l.payeeId === payee));

test("Qi facts: 3 decimals, Qi-ledger address bit, energy priced down to the base unit", () => {
  assert.equal(formatQi(12_345), "12.345 Qi");
  assert.equal(isQiAddress("0x0080000000000000000000000000000000000001"), true);
  assert.equal(isQiAddress("0x0040000000000000000000000000000000000001"), false);
  assert.equal(isQiAddress("0x00800000"), false);
  assert.deepEqual(priceEnergy(1000, quote), { qiBase: 2500, usdCents: 50 });
  assert.deepEqual(priceEnergy(0.3, quote), { qiBase: 0, usdCents: 0 }, "0.00075 Qi rounds down to nothing: never overpay");
});

test("quotes must name a source and be fresh", () => {
  const now = new Date("2026-10-21T13:00:00.000Z");
  assert.match(validateQuote(quote, now, 24).join(), /25.0h old/);
  assert.deepEqual(validateQuote(quote, now, 48), []);
  assert.match(validateQuote({ ...quote, source: " " }, now, 48).join(), /source/);
  assert.match(validateQuote(undefined, now, 48).join(), /no energy quote/);
});

test("waterfall: fee, royalties, provider pass-through, energy in Qi, margin in fiat — reconciles to gross", () => {
  const w = computeWaterfall(base({
    platformFeeBps: 100,
    tools: [{ toolId: "deck-renderer", payeeId: "tool:ana", perSaleCents: 300 }, { toolId: "pitch-eval", payeeId: "tool:sam", bps: 500 }],
    receipts: [receipt({ wh: 4000, cls: "measuredWh" }), receipt({ hosting: "provider", costUsd: 1.234 }), receipt({ hosting: "platform", wh: 999, costUsd: 5 })]
  }));
  assert.equal(w.status, "ok");
  assert.ok(w.checks.linesSumToGross);
  assert.equal(line(w, "stripe_fee")[0].usdCents, 320);
  assert.equal(line(w, "platform_fee")[0].usdCents, 100);
  assert.deepEqual(line(w, "tool_royalty").map((l) => [l.payeeId, l.usdCents]), [["tool:ana", 300], ["tool:sam", 500]]);
  assert.equal(line(w, "provider_passthrough")[0].usdCents, 123);
  const energy = line(w, "energy")[0];
  assert.deepEqual([energy.rail, energy.qiBase, energy.usdCents, energy.energyWh], ["qi", 10_000, 200, 4000]);
  const margin = 10_000 - 320 - 100 - 800 - 123 - 200;
  assert.deepEqual(line(w, "margin").map((l) => [l.payeeId, l.usdCents]), [["creator:leo", margin - Math.floor(margin * 0.3)], ["operator:bob", Math.floor(margin * 0.3)]]);
  assert.deepEqual([w.energy.platformHostedWh, w.energy.acceptedWh], [999, 4000], "platform-hosted energy is billed as metered compute, not deducted here");
});

test("unknown energy earns nothing; estimates only count if accepted; failed operations don't count", () => {
  const w = computeWaterfall(base({ acceptEnergy: ["measured"], receipts: [receipt({ wh: 500, cls: "estimatedWh" }), receipt({ energy: { measuredWh: 0, providerReportedWh: 0, estimatedWh: 0, unknownSteps: 3, methods: [] } }), receipt({ wh: 800, status: "failed" })] }));
  assert.equal(line(w, "energy").length, 0);
  assert.deepEqual([w.energy.acceptedWh, w.energy.excludedWh, w.energy.unknownSteps], [0, 500, 3]);
});

test("energy that needs pricing without a valid quote holds the settlement", () => {
  const w = computeWaterfall(base({ quote: undefined, receipts: [receipt({ wh: 10 })] }));
  assert.equal(w.status, "needs_quote");
  assert.equal(computeWaterfall(base({ quote: undefined })).status, "ok", "no energy, no quote needed");
});

test("a sale too small for its costs pays what it can, records shortfalls, and never goes negative", () => {
  const w = computeWaterfall(base({ grossCents: 500, stripeFeeCents: 45, tools: [{ toolId: "t", payeeId: "tool:ana", perSaleCents: 300 }], receipts: [receipt({ wh: 200_000 })] }));
  assert.ok(w.checks.linesSumToGross);
  const energy = line(w, "energy")[0];
  assert.equal(energy.usdCents, 155);
  assert.equal(energy.qiBase, Math.floor((500_000 * 155) / 10_000));
  assert.deepEqual(w.shortfalls.map((s) => [s.kind, s.usdCents]), [["energy", 10_000 - 155]]);
  assert.ok(line(w, "margin").every((l) => l.usdCents === 0));
  assert.ok(w.lines.every((l) => l.usdCents >= 0));
});

test("margin shares must sum to 100% and rounding remainders go to the first share", () => {
  assert.throws(() => computeWaterfall(base({ marginShares: [{ payeeId: "creator:leo", bps: 9000 }] })), /10000/);
  const w = computeWaterfall(base({ grossCents: 1001, stripeFeeCents: 0, marginShares: [{ payeeId: "a", bps: 3333 }, { payeeId: "b", bps: 3333 }, { payeeId: "c", bps: 3334 }] }));
  assert.deepEqual(line(w, "margin").map((l) => l.usdCents), [335, 333, 333]);
  assert.ok(w.checks.linesSumToGross);
});
