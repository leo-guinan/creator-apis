import type { EnergySource, OperationReceipt } from "../../contracts/src/index.js";
import { priceEnergy, type EnergyQuote } from "./qi.js";

export interface ToolRoyalty { toolId: string; payeeId: string; perSaleCents?: number; bps?: number; }
export interface MarginShare { payeeId: string; bps: number; }

export interface WaterfallInput {
  grossCents: number;
  stripeFeeCents: number;
  quantity: number;
  platformFeeBps: number;
  tools: ToolRoyalty[];
  /** Who ran the factory. Receives provider pass-through (fiat) and energy (Qi). */
  operatorPayeeId: string;
  marginShares: MarginShare[];
  receipts: OperationReceipt[];
  quote?: EnergyQuote;
  /** Energy evidence that earns Qi. Unknown energy never does. */
  acceptEnergy: Exclude<EnergySource, "unknown">[];
}

export type LineKind = "stripe_fee" | "platform_fee" | "tool_royalty" | "provider_passthrough" | "energy" | "margin";
export interface SettlementLine { kind: LineKind; payeeId?: string; rail: "none" | "platform" | "stripe" | "qi"; usdCents: number; qiBase?: number; energyWh?: number; note: string; }
export interface Waterfall {
  status: "ok" | "needs_quote";
  lines: SettlementLine[];
  /** Amounts owed but not funded by this sale (the sale didn't cover them). Recorded, never paid from elsewhere. */
  shortfalls: Array<{ kind: LineKind; payeeId?: string; usdCents: number; energyWh?: number; note: string }>;
  energy: { acceptedWh: number; excludedWh: number; unknownSteps: number; platformHostedWh: number; methods: string[] };
  checks: { linesSumToGross: boolean };
}

const bps = (amount: number, b: number) => Math.floor((amount * b) / 10_000);

/**
 * The settlement waterfall for one paid order. Pure: same inputs, same lines.
 *
 *   gross − Stripe fee = available
 *   − platform fee (bps of gross; default 0)
 *   − tool royalties (per sale and/or bps of gross)
 *   − provider pass-through: what the operator paid third-party APIs, reimbursed in fiat
 *   − operating energy: operator-hosted, accepted evidence only, paid in Qi at the quote, deducted at the quote's USD value
 *   = margin, paid in fiat by share
 *
 * Each step takes what's left; anything a step can't cover is a shortfall, never a negative payout.
 * Platform-hosted work isn't deducted here: it's billed to the creator as metered compute.
 */
export function computeWaterfall(input: WaterfallInput): Waterfall {
  if (!Number.isInteger(input.grossCents) || input.grossCents < 0 || !Number.isInteger(input.stripeFeeCents) || input.stripeFeeCents < 0) throw new Error("gross and fee must be non-negative integer cents");
  const shareTotal = input.marginShares.reduce((s, m) => s + m.bps, 0);
  if (!input.marginShares.length || shareTotal !== 10_000 || input.marginShares.some((m) => !Number.isInteger(m.bps) || m.bps < 0)) throw new Error("margin shares must be non-negative integers summing to 10000 bps");
  const lines: SettlementLine[] = [];
  const shortfalls: Waterfall["shortfalls"] = [];
  let left = input.grossCents;
  const take = (want: number, line: Omit<SettlementLine, "usdCents">) => { const paid = Math.max(0, Math.min(want, left)); left -= paid; if (paid > 0 || want === 0) lines.push({ ...line, usdCents: paid }); if (want > paid) shortfalls.push({ kind: line.kind, payeeId: line.payeeId, usdCents: want - paid, energyWh: line.energyWh, note: line.note }); return paid; };

  take(input.stripeFeeCents, { kind: "stripe_fee", rail: "none", note: "Stripe processing fee from the balance transaction" });
  if (input.platformFeeBps > 0) take(bps(input.grossCents, input.platformFeeBps), { kind: "platform_fee", rail: "platform", note: `${input.platformFeeBps} bps of gross` });
  for (const t of input.tools) take((t.perSaleCents ?? 0) * input.quantity + bps(input.grossCents, t.bps ?? 0), { kind: "tool_royalty", payeeId: t.payeeId, rail: "stripe", note: `tool ${t.toolId}` });

  const completed = input.receipts.filter((r) => r.status === "completed");
  const providerCents = completed.filter((r) => r.hosting === "provider").reduce((s, r) => s + Math.round(r.costUsd * 100), 0);
  if (providerCents > 0) take(providerCents, { kind: "provider_passthrough", payeeId: input.operatorPayeeId, rail: "stripe", note: "third-party API costs the operator paid" });

  const energy = { acceptedWh: 0, excludedWh: 0, unknownSteps: 0, platformHostedWh: 0, methods: [] as string[] };
  for (const r of completed) {
    const byClass: Record<Exclude<EnergySource, "unknown">, number> = { measured: r.energy.measuredWh, provider_reported: r.energy.providerReportedWh, estimated: r.energy.estimatedWh };
    energy.unknownSteps += r.energy.unknownSteps;
    for (const [cls, wh] of Object.entries(byClass) as Array<[Exclude<EnergySource, "unknown">, number]>) {
      if (r.hosting === "platform") energy.platformHostedWh += wh;
      else if (r.hosting === "operator" && input.acceptEnergy.includes(cls)) energy.acceptedWh += wh;
      else energy.excludedWh += wh;
    }
    if (r.hosting === "operator" && input.acceptEnergy.includes("estimated")) for (const m of r.energy.methods) if (!energy.methods.includes(m)) energy.methods.push(m);
  }
  if (energy.acceptedWh > 0) {
    if (!input.quote) return { status: "needs_quote", lines, shortfalls, energy, checks: { linesSumToGross: false } };
    const priced = priceEnergy(energy.acceptedWh, input.quote);
    const paid = Math.min(priced.usdCents, left);
    const qiBase = priced.usdCents === 0 ? priced.qiBase : Math.floor((priced.qiBase * paid) / priced.usdCents);
    left -= paid;
    lines.push({ kind: "energy", payeeId: input.operatorPayeeId, rail: "qi", usdCents: paid, qiBase, energyWh: energy.acceptedWh, note: `${energy.acceptedWh.toFixed(3)} Wh at ${input.quote.qiPerKwh} Qi/kWh, $${input.quote.usdPerQi}/Qi (${input.quote.source}, ${input.quote.observedAt})` });
    if (priced.usdCents > paid) shortfalls.push({ kind: "energy", payeeId: input.operatorPayeeId, usdCents: priced.usdCents - paid, energyWh: energy.acceptedWh * (1 - paid / priced.usdCents), note: "energy cost the sale didn't cover" });
  }

  const margin = left;
  let assigned = 0;
  const shares = input.marginShares.map((m) => { const c = bps(margin, m.bps); assigned += c; return { ...m, cents: c }; });
  shares[0].cents += margin - assigned; // rounding remainder, deterministic
  for (const s of shares) if (s.cents > 0 || margin === 0) lines.push({ kind: "margin", payeeId: s.payeeId, rail: "stripe", usdCents: s.cents, note: `${s.bps} bps of margin` });
  left = 0;
  const sum = lines.reduce((s, l) => s + l.usdCents, 0);
  return { status: "ok", lines, shortfalls, energy, checks: { linesSumToGross: sum === input.grossCents } };
}
