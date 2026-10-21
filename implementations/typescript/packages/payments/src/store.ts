import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OperationReceipt } from "../../contracts/src/index.js";
import type { EnergyQuote } from "./qi.js";
import type { Delivery, RewardPeriod } from "./rewards.js";
import type { ClusterCharter } from "../../contracts/src/index.js";
import type { ClusterEpoch, Win } from "./clusters.js";
import type { LifecycleEpoch, Milestone, PressEvidence, ProvingRun, ProvingSet } from "./lifecycle.js";
import type { MarginShare, SettlementLine, ToolRoyalty, Waterfall } from "./settlement.js";

export type Currency = "usd_cents" | "qi_base";
export interface Posting { account: string; currency: Currency; amount: number; }
export interface JournalEntry { id: string; at: string; kind: string; postings: Posting[]; refs: Record<string, string>; }

export type SubscriptionStatus = "none" | "pending" | "active" | "past_due" | "canceled";
export interface Creator { id: string; email: string; name: string; stripeCustomerId: string; subscription: { id?: string; status: SubscriptionStatus; currentPeriodEnd?: string }; computeBudgetCents: number; computeUsed: Record<string, number>; createdAt: string; }
/** Anyone who gets paid: creators, operators, tool authors. */
export interface Payee { id: string; kind: "creator" | "operator" | "tool" | "miner"; displayName: string; email: string; stripeAccountId?: string; transfersEnabled: boolean; qiAddress?: string; createdAt: string; }
export interface Offer { id: string; creatorId: string; factoryId: string; clusterId?: string; name: string; unitAmountCents: number; currency: "usd"; operatorPayeeId: string; tools: ToolRoyalty[]; marginShares: MarginShare[]; platformFeeBps: number; active: boolean; createdAt: string; }
export type OrderStatus = "awaiting_payment" | "paid" | "failed" | "refunded" | "settled";
export interface Order { id: string; offerId: string; creatorId: string; quantity: number; amountCents: number; status: OrderStatus; checkoutSessionId: string; checkoutUrl: string; paymentIntentId?: string; chargeId?: string; stripeFeeCents?: number; customerEmail?: string; createdAt: string; paidAt?: string; settlementId?: string; flags: string[]; }
export type MeterStatus = "sent" | "partly_over_budget" | "over_budget" | "not_platform" | "too_old" | "no_subscription" | "not_completed";
export interface ReceiptRecord { receipt: OperationReceipt; receivedAt: string; metering: { status: MeterStatus; billedCents: number; unbilledCents: number }; }
export interface Settlement { id: string; orderId: string; at: string; quote?: EnergyQuote; waterfall: Waterfall; receiptIds: string[]; }
export type PayoutStatus = "pending" | "awaiting_account" | "sent" | "exported" | "confirmed" | "failed";
export interface PayoutInstruction { id: string; settlementId: string; orderId: string; payeeId: string; rail: "stripe" | "qi"; amount: number; currency: Currency; status: PayoutStatus; transferGroup: string; sourceTransaction?: string; transferId?: string; qiAddress?: string; txHash?: string; energyWh?: number; error?: string; updatedAt: string; line: SettlementLine; }

export interface State {
  version: 1;
  catalog?: { productId: string; subscriptionPriceId: string; meterId: string; meterEventName: string; meteredPriceId: string };
  creators: Record<string, Creator>;
  payees: Record<string, Payee>;
  offers: Record<string, Offer>;
  orders: Record<string, Order>;
  receipts: Record<string, ReceiptRecord>;
  settlements: Record<string, Settlement>;
  payouts: Record<string, PayoutInstruction>;
  quotes: EnergyQuote[];
  processedEvents: Record<string, string>;
  deliveries: Record<string, Delivery>;
  rewardPeriods: RewardPeriod[];
  charters: Record<string, ClusterCharter[]>;
  clusterWins: Record<string, Win[]>;
  clusterEpochs: Record<string, ClusterEpoch[]>;
  clusterBurns: Record<string, { clusterId: string; epochId: string; cents: number; status: "pending" | "confirmed"; txHash?: string; confirmedAt?: string }>;
  provingSets: Record<string, ProvingSet[]>;
  provingRuns: Record<string, ProvingRun>;
  pressEvidence: Record<string, PressEvidence[]>;
  lifecycle: Record<string, LifecycleEpoch[]>;
  milestones: Milestone[];
  milestoneBurns: Record<string, { milestoneId: string; qiBase: number; status: "pending" | "confirmed"; txHash?: string }>;
  journal: JournalEntry[];
}

const empty = (): State => ({ version: 1, creators: {}, payees: {}, offers: {}, orders: {}, receipts: {}, settlements: {}, payouts: {}, quotes: [], processedEvents: {}, deliveries: {}, rewardPeriods: [], charters: {}, clusterWins: {}, clusterEpochs: {}, clusterBurns: {}, provingSets: {}, provingRuns: {}, pressEvidence: {}, lifecycle: {}, milestones: [], milestoneBurns: {}, journal: [] });

/** One JSON file, written atomically after every mutation, so entities and the journal never disagree. A reference store, not a production database. */
export class Store {
  state: State;
  constructor(private readonly path?: string) {
    this.state = empty();
    if (path) { try { this.state = { ...empty(), ...(JSON.parse(readFileSync(path, "utf8")) as State) }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  }
  /** Runs a mutation and persists once. If the mutation throws, nothing is written and memory is restored. */
  mutate<T>(fn: (s: State) => T): T {
    const before = structuredClone(this.state);
    try { const result = fn(this.state); this.persist(); return result; } catch (error) { this.state = before; throw error; }
  }
  post(s: State, entry: JournalEntry) {
    if (s.journal.some((e) => e.id === entry.id)) return;
    for (const currency of ["usd_cents", "qi_base"] as Currency[]) {
      const sum = entry.postings.filter((p) => p.currency === currency).reduce((t, p) => t + p.amount, 0);
      if (sum !== 0) throw new Error(`journal entry ${entry.id} is unbalanced in ${currency} by ${sum}`);
    }
    if (entry.postings.some((p) => !Number.isInteger(p.amount))) throw new Error(`journal entry ${entry.id} has a non-integer amount`);
    s.journal.push(entry);
  }
  balance(account: string, currency: Currency): number { return this.state.journal.flatMap((e) => e.postings).filter((p) => p.account === account && p.currency === currency).reduce((t, p) => t + p.amount, 0); }
  balances(prefix = ""): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.state.journal.flatMap((e) => e.postings)) if (p.account.startsWith(prefix)) out[`${p.account}|${p.currency}`] = (out[`${p.account}|${p.currency}`] ?? 0) + p.amount;
    return out;
  }
  private persist() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path);
  }
}
