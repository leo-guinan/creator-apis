import { randomUUID } from "node:crypto";
import { stableHash, validateCharterAmendment, validateClusterCharter, validateReceipt, type ClusterCharter, type EnergySource, type OperationReceipt } from "../../contracts/src/index.js";
import { closeClusterEpoch, type ClusterEpoch, type Phase } from "./clusters.js";
import { closeLifecycleEpoch, lifecycleMetrics, sealProvingSet, type LifecycleEpoch, type Milestone, type PressEvidence, type ProvingRun, type ProvingSet } from "./lifecycle.js";
import type { PaymentsGateway, WebhookEvent } from "./gateway.js";
import { formatQi, isQiAddress, validateQuote, type EnergyQuote } from "./qi.js";
import { computeWaterfall, type MarginShare, type ToolRoyalty } from "./settlement.js";
import { closeRewardPeriod, computeStandards, defaultRewardConfig, validateRewardConfig, type Delivery, type RewardConfig, type RewardPeriod } from "./rewards.js";
import type { Creator, MeterStatus, Offer, Order, Payee, PayoutInstruction, Settlement, State, Store, SubscriptionStatus } from "./store.js";

export interface PaymentsConfig {
  publicUrl: string;
  subscriptionCents?: number;
  meterEventName?: string;
  /** Cents billed per meter unit. The meter value is compute cost in cents, so "1" bills compute at cost. */
  meteredUnitAmountDecimal?: string;
  defaultComputeBudgetCents?: number;
  quoteMaxAgeHours?: number;
  acceptEnergy?: Exclude<EnergySource, "unknown">[];
  /** "pool": operators earn Qi from the period reward pool (default). "sale": operator energy is deducted from each sale and paid in Qi. */
  qiFrom?: "pool" | "sale";
  rewards?: RewardConfig;
  now?: () => Date;
}

const METER_WINDOW_DAYS = 35;
const subStatus = (s: string): SubscriptionStatus => (s === "active" || s === "trialing" ? "active" : s === "past_due" || s === "unpaid" ? "past_due" : s === "canceled" || s === "incomplete_expired" ? "canceled" : "pending");
const month = (iso: string) => iso.slice(0, 7);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "object" && v && "id" in v ? String((v as { id: unknown }).id) : undefined);

export class CreatorPayments {
  readonly cfg: Required<Omit<PaymentsConfig, "now">> & { now: () => Date };
  constructor(readonly gateway: PaymentsGateway, readonly store: Store, config: PaymentsConfig) {
    this.cfg = { subscriptionCents: 2000, meterEventName: "factory_compute_cents", meteredUnitAmountDecimal: "1", defaultComputeBudgetCents: 2000, quoteMaxAgeHours: 24, acceptEnergy: ["measured", "provider_reported", "estimated"], qiFrom: "pool", rewards: defaultRewardConfig(), now: () => new Date(), ...config } as CreatorPayments["cfg"];
  }
  private get s(): State { return this.store.state; }
  private nowIso() { return this.cfg.now().toISOString(); }

  // ------------------------------------------------------------ catalog + creators ($20/month)

  async setup() { const catalog = await this.gateway.ensureCatalog({ subscriptionCents: this.cfg.subscriptionCents, meterEventName: this.cfg.meterEventName, meteredUnitAmountDecimal: this.cfg.meteredUnitAmountDecimal }); this.store.mutate((s) => { s.catalog = catalog; }); return catalog; }

  async registerCreator(p: { id: string; email: string; name: string; computeBudgetCents?: number }): Promise<Creator> {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(p.id)) throw new Error("creator id must be a lowercase slug");
    const existing = this.s.creators[p.id];
    if (existing) return existing;
    const customer = await this.gateway.createCustomer({ email: p.email, name: p.name, metadata: { creatorapis_creator_id: p.id } }, `creator:${p.id}`);
    return this.store.mutate((s) => {
      const creator: Creator = { id: p.id, email: p.email, name: p.name, stripeCustomerId: customer.id, subscription: { status: "none" }, computeBudgetCents: p.computeBudgetCents ?? this.cfg.defaultComputeBudgetCents, computeUsed: {}, createdAt: this.nowIso() };
      s.creators[p.id] = creator;
      return creator;
    });
  }

  async subscribeCreator(creatorId: string): Promise<{ url: string; sessionId: string }> {
    const creator = this.mustCreator(creatorId);
    if (!this.s.catalog) throw new Error("run setup() first to create the Stripe catalog");
    if (creator.subscription.status === "active") throw new Error(`creator ${creatorId} already has an active subscription`);
    const session = await this.gateway.createSubscriptionCheckout({ customerId: creator.stripeCustomerId, subscriptionPriceId: this.s.catalog.subscriptionPriceId, meteredPriceId: this.s.catalog.meteredPriceId, successUrl: `${this.cfg.publicUrl}/creators/${creatorId}/subscribed?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${this.cfg.publicUrl}/creators/${creatorId}`, metadata: { kind: "creator_subscription", creator_id: creatorId } }, `subscribe:${creatorId}:${month(this.nowIso())}`);
    this.store.mutate((s) => { if (s.creators[creatorId].subscription.status === "none") s.creators[creatorId].subscription.status = "pending"; });
    return { url: session.url, sessionId: session.id };
  }

  entitlement(creatorId: string) {
    const c = this.mustCreator(creatorId);
    const used = c.computeUsed[month(this.nowIso())] ?? 0;
    return { creatorId, status: c.subscription.status, canPublish: c.subscription.status === "active", computeBudgetCents: c.computeBudgetCents, computeUsedCents: used, computeRemainingCents: Math.max(0, c.computeBudgetCents - used) };
  }

  // ------------------------------------------------------------ payees (Connect recipients) + Qi addresses

  async registerPayee(p: { id: string; kind: Payee["kind"]; displayName: string; email: string; country?: string; qiAddress?: string }): Promise<{ payee: Payee; onboardingUrl: string }> {
    if (!/^(creator|operator|tool|miner):[a-z0-9][a-z0-9-]{0,63}$/.test(p.id) || !p.id.startsWith(`${p.kind}:`)) throw new Error("payee id must look like <kind>:<slug>");
    if (p.qiAddress && !isQiAddress(p.qiAddress)) throw new Error(`${p.qiAddress} is not a Qi-ledger address`);
    let payee = this.s.payees[p.id];
    if (!payee) {
      const account = await this.gateway.createRecipientAccount({ email: p.email, country: p.country ?? "US", metadata: { creatorapis_payee_id: p.id } }, `payee:${p.id}`);
      payee = this.store.mutate((s) => (s.payees[p.id] = { id: p.id, kind: p.kind, displayName: p.displayName, email: p.email, stripeAccountId: account.id, transfersEnabled: false, qiAddress: p.qiAddress, createdAt: this.nowIso() }));
    }
    const link = await this.gateway.createOnboardingLink(payee.stripeAccountId!, { refreshUrl: `${this.cfg.publicUrl}/payees/${encodeURIComponent(p.id)}/onboard`, returnUrl: `${this.cfg.publicUrl}/payees/${encodeURIComponent(p.id)}` });
    return { payee, onboardingUrl: link.url };
  }

  setQiAddress(payeeId: string, address: string) {
    if (!isQiAddress(address)) throw new Error(`${address} is not a Qi-ledger address`);
    return this.store.mutate((s) => { const p = s.payees[payeeId]; if (!p) throw new Error(`unknown payee ${payeeId}`); p.qiAddress = address; return p; });
  }

  // ------------------------------------------------------------ offers + customer checkout at the creator's price

  createOffer(p: { id: string; creatorId: string; factoryId: string; clusterId?: string; name: string; unitAmountCents: number; operatorPayeeId: string; tools?: ToolRoyalty[]; marginShares?: MarginShare[]; platformFeeBps?: number }): Offer {
    this.mustCreator(p.creatorId);
    const shares = p.marginShares ?? [{ payeeId: `creator:${p.creatorId}`, bps: 10_000 }];
    const errors: string[] = [];
    if (!Number.isInteger(p.unitAmountCents) || p.unitAmountCents < 50) errors.push("unitAmountCents must be an integer of at least 50 (Stripe's USD minimum)");
    if (shares.reduce((t, m) => t + m.bps, 0) !== 10_000) errors.push("margin shares must sum to 10000 bps");
    for (const id of [p.operatorPayeeId, ...shares.map((m) => m.payeeId), ...(p.tools ?? []).map((t) => t.payeeId)]) if (!this.s.payees[id]) errors.push(`unknown payee ${id}`);
    if ((p.platformFeeBps ?? 0) < 0 || (p.platformFeeBps ?? 0) > 10_000) errors.push("platformFeeBps must be 0..10000");
    if (p.clusterId && !this.s.charters[p.clusterId]) errors.push(`unknown cluster ${p.clusterId}`);
    if (errors.length) throw new Error(`invalid offer ${p.id}: ${errors.join("; ")}`);
    return this.store.mutate((s) => (s.offers[p.id] = { id: p.id, creatorId: p.creatorId, factoryId: p.factoryId, clusterId: p.clusterId, name: p.name, unitAmountCents: p.unitAmountCents, currency: "usd", operatorPayeeId: p.operatorPayeeId, tools: p.tools ?? [], marginShares: shares, platformFeeBps: p.platformFeeBps ?? 0, active: true, createdAt: this.nowIso() }));
  }

  async checkoutOffer(offerId: string, p: { quantity?: number; customerEmail?: string } = {}): Promise<Order> {
    const offer = this.s.offers[offerId];
    if (!offer?.active) throw new Error(`offer ${offerId} is not available`);
    if (!this.entitlement(offer.creatorId).canPublish) throw new Error(`creator ${offer.creatorId} needs an active subscription to sell`);
    const quantity = p.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error("quantity must be a positive integer");
    const orderId = `ord_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const session = await this.gateway.createPaymentCheckout({ name: offer.name, unitAmountCents: offer.unitAmountCents, quantity, currency: "usd", transferGroup: orderId, metadata: { kind: "offer_order", order_id: orderId, offer_id: offer.id, creator_id: offer.creatorId, factory_id: offer.factoryId }, customerEmail: p.customerEmail, successUrl: `${this.cfg.publicUrl}/orders/${orderId}?session_id={CHECKOUT_SESSION_ID}`, cancelUrl: `${this.cfg.publicUrl}/offers/${offer.id}` }, orderId);
    return this.store.mutate((s) => (s.orders[orderId] = { id: orderId, offerId, creatorId: offer.creatorId, quantity, amountCents: offer.unitAmountCents * quantity, status: "awaiting_payment", checkoutSessionId: session.id, checkoutUrl: session.url, customerEmail: p.customerEmail, createdAt: this.nowIso(), flags: [] }));
  }

  // ------------------------------------------------------------ factory receipts: metered compute (bounded)

  async ingestReceipt(receipt: OperationReceipt): Promise<{ status: MeterStatus; billedCents: number; unbilledCents: number; budgetRemainingCents?: number; stop: boolean; duplicate: boolean }> {
    const errors = validateReceipt(receipt);
    if (errors.length) throw new Error(`invalid receipt: ${errors.join("; ")}`);
    const prior = this.s.receipts[receipt.id];
    if (prior) { if (prior.receipt.sha256 !== receipt.sha256) throw new Error(`receipt ${receipt.id} already recorded with different contents`); return { ...prior.metering, stop: false, duplicate: true }; }
    const creator = receipt.creatorId ? this.s.creators[receipt.creatorId] : undefined;
    const valueCents = Math.round(receipt.costUsd * 100 * 10_000) / 10_000;
    let status: MeterStatus = "sent"; let billed = 0;
    const ageDays = (this.cfg.now().getTime() - Date.parse(receipt.finishedAt)) / 86_400_000;
    if (receipt.status !== "completed") status = "not_completed";
    else if (receipt.hosting !== "platform") status = "not_platform";
    else if (!creator || creator.subscription.status !== "active") status = "no_subscription";
    else if (ageDays > METER_WINDOW_DAYS || ageDays < -5 / 1440) status = "too_old";
    else {
      const used = creator.computeUsed[month(receipt.finishedAt)] ?? 0;
      billed = Math.max(0, Math.min(valueCents, creator.computeBudgetCents - used));
      status = billed === 0 && valueCents > 0 ? "over_budget" : billed < valueCents ? "partly_over_budget" : "sent";
      if (billed > 0) await this.gateway.recordMeterEvent({ eventName: this.s.catalog?.meterEventName ?? this.cfg.meterEventName, customerId: creator.stripeCustomerId, value: billed.toFixed(4), identifier: receipt.id, timestamp: Math.floor(Date.parse(receipt.finishedAt) / 1000) });
    }
    const metering = { status, billedCents: billed, unbilledCents: status === "not_platform" || status === "not_completed" ? 0 : Math.round((valueCents - billed) * 10_000) / 10_000 };
    this.store.mutate((s) => { s.receipts[receipt.id] = { receipt, receivedAt: this.nowIso(), metering }; if (creator && billed > 0) { const m = month(receipt.finishedAt); s.creators[creator.id].computeUsed[m] = (s.creators[creator.id].computeUsed[m] ?? 0) + billed; } });
    const remaining = creator ? this.entitlement(creator.id).computeRemainingCents : undefined;
    return { ...metering, budgetRemainingCents: remaining, stop: receipt.hosting === "platform" && remaining !== undefined && remaining <= 0, duplicate: false };
  }

  // ------------------------------------------------------------ energy quotes

  recordQuote(q: Omit<EnergyQuote, "id"> & { id?: string }): EnergyQuote {
    const quote: EnergyQuote = { id: q.id ?? `quote_${randomUUID().slice(0, 8)}`, qiPerKwh: q.qiPerKwh, usdPerQi: q.usdPerQi, source: q.source, observedAt: q.observedAt };
    const errors = validateQuote(quote, new Date(Date.parse(quote.observedAt)), Number.POSITIVE_INFINITY);
    if (errors.length) throw new Error(`invalid quote: ${errors.join("; ")}`);
    return this.store.mutate((s) => { s.quotes.push(quote); return quote; });
  }
  latestQuote(): EnergyQuote | undefined { return [...this.s.quotes].sort((a, b) => a.observedAt.localeCompare(b.observedAt)).at(-1); }

  // ------------------------------------------------------------ webhooks

  async handleWebhook(raw: string | Buffer, signature: string): Promise<{ id: string; type: string; duplicate: boolean; note?: string }> {
    const event = this.gateway.parseWebhook(raw, signature);
    if (this.gateway.mode === "test" && event.livemode) throw new Error("live-mode event sent to a test-mode service");
    if (this.s.processedEvents[event.id]) return { id: event.id, type: event.type, duplicate: true };
    const note = await this.dispatch(event);
    this.store.mutate((s) => { s.processedEvents[event.id] = this.nowIso(); });
    return { id: event.id, type: event.type, duplicate: false, note };
  }

  private async dispatch(event: WebhookEvent): Promise<string | undefined> {
    const o = event.data.object;
    const meta = (o.metadata ?? {}) as Record<string, string>;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        if (meta.kind === "creator_subscription") { this.store.mutate((s) => { const c = s.creators[meta.creator_id]; if (c && c.subscription.status !== "active") c.subscription = { ...c.subscription, id: str(o.subscription), status: "pending" }; }); return "subscription checkout completed; waiting for subscription status"; }
        if (meta.kind === "offer_order") {
          const order = this.s.orders[meta.order_id];
          if (!order) return `unknown order ${meta.order_id}`;
          const pi = str(o.payment_intent);
          if (o.payment_status !== "paid" || !pi) { this.store.mutate((s) => { s.orders[order.id].paymentIntentId = pi; }); return "payment not yet confirmed"; }
          return this.markPaid(order.id, pi);
        }
        return undefined;
      }
      case "checkout.session.async_payment_failed": { const order = this.s.orders[meta.order_id]; if (order) this.store.mutate((s) => { s.orders[order.id].status = "failed"; }); return "payment failed"; }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const creator = this.creatorByCustomer(str(o.customer));
        if (!creator) return "subscription for an unknown customer";
        const items = (o.items as { data?: Array<{ current_period_end?: number }> } | undefined)?.data;
        const end = items?.[0]?.current_period_end ?? (o.current_period_end as number | undefined);
        const status = event.type === "customer.subscription.deleted" ? "canceled" : subStatus(String(o.status));
        this.store.mutate((s) => { s.creators[creator.id].subscription = { id: str(o.id), status, currentPeriodEnd: end ? new Date(end * 1000).toISOString() : undefined }; });
        return `creator ${creator.id} subscription ${status}`;
      }
      case "invoice.paid": {
        const creator = this.creatorByCustomer(str(o.customer));
        const amount = Number(o.amount_paid ?? 0);
        if (!creator || !amount) return "invoice with no creator or no amount";
        this.store.mutate((s) => this.store.post(s, { id: `invoice:${str(o.id)}`, at: this.nowIso(), kind: "subscription_invoice_paid", refs: { invoice: str(o.id)!, creator: creator.id }, postings: [{ account: "stripe:balance", currency: "usd_cents", amount }, { account: "platform:revenue", currency: "usd_cents", amount: -amount }] }));
        return `invoice paid by ${creator.id}`;
      }
      case "invoice.payment_failed": { const creator = this.creatorByCustomer(str(o.customer)); if (creator) this.store.mutate((s) => { s.creators[creator.id].subscription.status = "past_due"; }); return "invoice payment failed"; }
      case "charge.refunded": {
        const order = Object.values(this.s.orders).find((x) => x.chargeId === str(o.id) || x.paymentIntentId === str(o.payment_intent));
        if (!order) return "refund for an unknown order";
        const refunded = Number(o.amount_refunded ?? 0);
        this.store.mutate((s) => {
          const ord = s.orders[order.id];
          if (ord.status === "settled" && !ord.flags.includes("needs_reversal")) ord.flags.push("needs_reversal");
          ord.status = ord.status === "settled" ? "settled" : "refunded";
          this.store.post(s, { id: `refund:${str(o.id)}:${refunded}`, at: this.nowIso(), kind: "refund", refs: { order: order.id }, postings: [{ account: `order:${order.id}`, currency: "usd_cents", amount: refunded }, { account: "stripe:balance", currency: "usd_cents", amount: -refunded }] });
        });
        return order.status === "settled" ? "refunded after settlement: transfers need reversing" : "refunded before settlement";
      }
      case "account.updated": {
        const payee = Object.values(this.s.payees).find((p) => p.stripeAccountId === str(o.id));
        if (!payee) return "unknown connected account";
        const enabled = (o.capabilities as Record<string, string> | undefined)?.transfers === "active";
        this.store.mutate((s) => { s.payees[payee.id].transfersEnabled = enabled; });
        return `${payee.id} transfers ${enabled ? "enabled" : "not enabled"}`;
      }
      default: return undefined;
    }
  }

  private async markPaid(orderId: string, paymentIntentId: string) {
    const details = await this.gateway.getPaymentDetails(paymentIntentId);
    this.store.mutate((s) => {
      const order = s.orders[orderId];
      if (order.status === "paid" || order.status === "settled") return;
      Object.assign(order, { status: "paid", paymentIntentId, chargeId: details.chargeId, stripeFeeCents: details.feeCents, paidAt: this.nowIso() });
      if (details.amountCents !== order.amountCents) order.flags.push(`amount_mismatch:${details.amountCents}`);
      this.store.post(s, { id: `paid:${orderId}`, at: this.nowIso(), kind: "order_paid", refs: { order: orderId, charge: details.chargeId ?? "" }, postings: [{ account: "stripe:balance", currency: "usd_cents", amount: details.amountCents }, { account: `order:${orderId}`, currency: "usd_cents", amount: -details.amountCents }] });
      if (details.feeCents !== undefined) this.store.post(s, { id: `fee:${orderId}`, at: this.nowIso(), kind: "stripe_fee", refs: { order: orderId }, postings: [{ account: `order:${orderId}`, currency: "usd_cents", amount: details.feeCents }, { account: "stripe:balance", currency: "usd_cents", amount: -details.feeCents }] });
    });
    return `order ${orderId} paid`;
  }

  // ------------------------------------------------------------ settlement: energy in Qi, margin in fiat

  async settleOrder(orderId: string): Promise<{ status: "settled" | "needs_quote" | "not_ready"; settlement?: Settlement; reasons: string[] }> {
    let order = this.s.orders[orderId];
    if (!order) throw new Error(`unknown order ${orderId}`);
    if (order.settlementId) return { status: "settled", settlement: this.s.settlements[order.settlementId], reasons: [] };
    if (order.status !== "paid") return { status: "not_ready", reasons: [`order is ${order.status}`] };
    if (order.stripeFeeCents === undefined && order.paymentIntentId) {
      const d = await this.gateway.getPaymentDetails(order.paymentIntentId);
      if (d.feeCents !== undefined) this.store.mutate((s) => { s.orders[orderId].stripeFeeCents = d.feeCents; s.orders[orderId].chargeId = d.chargeId; this.store.post(s, { id: `fee:${orderId}`, at: this.nowIso(), kind: "stripe_fee", refs: { order: orderId }, postings: [{ account: `order:${orderId}`, currency: "usd_cents", amount: d.feeCents! }, { account: "stripe:balance", currency: "usd_cents", amount: -d.feeCents! }] }); });
      order = this.s.orders[orderId];
    }
    if (order.stripeFeeCents === undefined) return { status: "not_ready", reasons: ["Stripe fee not known yet"] };
    const offer = this.s.offers[order.offerId];
    const receipts = Object.values(this.s.receipts).map((r) => r.receipt).filter((r) => r.orderRef === orderId);
    const quote = this.latestQuote();
    const quoteErrors = validateQuote(quote, this.cfg.now(), this.cfg.quoteMaxAgeHours);
    const charter = offer.clusterId ? this.activeCharter(offer.clusterId, order.paidAt ?? this.nowIso()) : undefined;
    const inCluster = charter?.members.factories.some((f) => f.factoryId === offer.factoryId) ? charter : undefined;
    const waterfall = computeWaterfall({ clusterSetAside: inCluster ? { clusterId: inCluster.id, bps: inCluster.revenueMining.setAsideBps } : undefined, grossCents: order.amountCents, stripeFeeCents: order.stripeFeeCents, quantity: order.quantity, platformFeeBps: offer.platformFeeBps, tools: offer.tools, operatorPayeeId: offer.operatorPayeeId, marginShares: offer.marginShares, receipts, quote: quoteErrors.length ? undefined : quote, acceptEnergy: this.cfg.acceptEnergy, deductEnergy: this.cfg.qiFrom === "sale" });
    if (waterfall.status === "needs_quote") return { status: "needs_quote", reasons: [`${waterfall.energy.acceptedWh.toFixed(3)} Wh of operator energy needs pricing`, ...quoteErrors] };
    if (!waterfall.checks.linesSumToGross) throw new Error(`settlement for ${orderId} does not reconcile to gross`);
    const id = `stl_${orderId.slice(4)}`;
    const settlement: Settlement = { id, orderId, at: this.nowIso(), quote: waterfall.lines.some((l) => l.kind === "energy") ? quote : undefined, waterfall, receiptIds: receipts.map((r) => r.id) };
    this.store.mutate((s) => {
      const usd = waterfall.lines.filter((l) => l.kind !== "stripe_fee");
      const net = usd.reduce((t, l) => t + l.usdCents, 0);
      this.store.post(s, { id: `settle:${orderId}`, at: settlement.at, kind: "settlement", refs: { order: orderId, settlement: id }, postings: [{ account: `order:${orderId}`, currency: "usd_cents", amount: net }, ...usd.filter((l) => l.usdCents > 0).map((l) => ({ account: l.kind === "platform_fee" ? "platform:revenue" : l.kind === "energy" ? "qi:reserve" : `payable:${l.payeeId}`, currency: "usd_cents" as const, amount: -l.usdCents }))] });
      for (const l of waterfall.lines.filter((x) => x.kind === "energy" && (x.qiBase ?? 0) > 0)) this.store.post(s, { id: `qi-owed:${orderId}:${l.payeeId}`, at: settlement.at, kind: "qi_obligation", refs: { order: orderId }, postings: [{ account: "qi:obligations", currency: "qi_base", amount: l.qiBase! }, { account: `payable_qi:${l.payeeId}`, currency: "qi_base", amount: -l.qiBase! }] });
      waterfall.lines.filter((l) => l.rail === "stripe" || l.rail === "qi").filter((l) => (l.rail === "qi" ? (l.qiBase ?? 0) : l.usdCents) > 0).forEach((l, i) => {
        const pid = `pay_${id.slice(4)}_${i}`;
        s.payouts[pid] = { id: pid, settlementId: id, orderId, payeeId: l.payeeId!, rail: l.rail as "stripe" | "qi", amount: l.rail === "qi" ? l.qiBase! : l.usdCents, currency: l.rail === "qi" ? "qi_base" : "usd_cents", status: "pending", transferGroup: orderId, sourceTransaction: order.chargeId, energyWh: l.energyWh, updatedAt: settlement.at, line: l } satisfies PayoutInstruction;
      });
      s.settlements[id] = settlement;
      if (inCluster) {
        const setAside = waterfall.lines.filter((l) => l.kind === "cluster_set_aside").reduce((t, l) => t + l.usdCents, 0);
        const margin = waterfall.lines.filter((l) => l.kind === "margin").reduce((t, l) => t + l.usdCents, 0) + setAside;
        (s.clusterWins[inCluster.id] ??= []).push({ id: orderId, factoryId: offer.factoryId, customerKey: stableHash(order.customerEmail?.toLowerCase() ?? `anonymous:${orderId}`).slice(0, 16), marginCents: margin, setAsideCents: setAside, at: order.paidAt ?? settlement.at });
      }
      s.orders[orderId].settlementId = id;
      s.orders[orderId].status = "settled";
    });
    return { status: "settled", settlement, reasons: waterfall.shortfalls.map((x) => `shortfall ${x.kind} ${x.payeeId ?? ""}: ${x.usdCents}¢ (${x.note})`) };
  }

  /** Sends fiat payouts as Stripe transfers tied to the source charge. Payees without an enabled account wait. */
  async runFiatPayouts(): Promise<PayoutInstruction[]> {
    const due = Object.values(this.s.payouts).filter((p) => p.rail === "stripe" && ["pending", "awaiting_account", "failed"].includes(p.status));
    for (const p of due) {
      const payee = this.s.payees[p.payeeId];
      if (!payee?.stripeAccountId || !payee.transfersEnabled) { this.store.mutate((s) => { s.payouts[p.id].status = "awaiting_account"; s.payouts[p.id].updatedAt = this.nowIso(); }); continue; }
      try {
        const t = await this.gateway.createTransfer({ amountCents: p.amount, currency: "usd", destination: payee.stripeAccountId, transferGroup: p.transferGroup, sourceTransaction: p.sourceTransaction, metadata: { payout_id: p.id, order_id: p.orderId, kind: p.line.kind } }, p.id);
        this.store.mutate((s) => { Object.assign(s.payouts[p.id], { status: "sent", transferId: t.id, error: undefined, updatedAt: this.nowIso() }); this.store.post(s, { id: `transfer:${p.id}`, at: this.nowIso(), kind: "transfer", refs: { payout: p.id, transfer: t.id }, postings: [{ account: `payable:${p.payeeId}`, currency: "usd_cents", amount: p.amount }, { account: "stripe:balance", currency: "usd_cents", amount: -p.amount }] }); });
      } catch (error) { this.store.mutate((s) => { Object.assign(s.payouts[p.id], { status: "failed", error: error instanceof Error ? error.message : String(error), updatedAt: this.nowIso() }); }); }
    }
    return due.map((p) => this.s.payouts[p.id]);
  }

  /** Qi payouts are exported for signing outside this service: it never holds keys. Confirm each with its transaction hash. */
  exportQiBatch(): { batchId: string; createdAt: string; payouts: Array<{ id: string; payeeId: string; to: string; amountBase: number; amount: string; energyWh?: number }>; waiting: string[] } {
    const createdAt = this.nowIso();
    const due = Object.values(this.s.payouts).filter((p) => p.rail === "qi" && (p.status === "pending" || p.status === "awaiting_account"));
    const ready = due.filter((p) => this.s.payees[p.payeeId]?.qiAddress);
    this.store.mutate((s) => { for (const p of due) { const addr = s.payees[p.payeeId]?.qiAddress; Object.assign(s.payouts[p.id], addr ? { status: "exported", qiAddress: addr } : { status: "awaiting_account" }, { updatedAt: createdAt }); } });
    return { batchId: `qib_${createdAt.replace(/[^0-9]/g, "").slice(0, 14)}`, createdAt, payouts: ready.map((p) => ({ id: p.id, payeeId: p.payeeId, to: this.s.payees[p.payeeId].qiAddress!, amountBase: p.amount, amount: formatQi(p.amount), energyWh: p.energyWh })), waiting: due.filter((p) => !this.s.payees[p.payeeId]?.qiAddress).map((p) => p.id) };
  }

  confirmQiPayout(payoutId: string, txHash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");
    return this.store.mutate((s) => {
      const p = s.payouts[payoutId];
      if (!p || p.rail !== "qi") throw new Error(`unknown Qi payout ${payoutId}`);
      if (p.status === "confirmed") { if (p.txHash !== txHash) throw new Error(`payout ${payoutId} already confirmed with ${p.txHash}`); return p; }
      if (p.status !== "exported") throw new Error(`payout ${payoutId} is ${p.status}; export it first`);
      Object.assign(p, { status: "confirmed", txHash, updatedAt: this.nowIso() });
      this.store.post(s, { id: `qi-paid:${payoutId}`, at: this.nowIso(), kind: "qi_payout", refs: { payout: payoutId, tx: txHash }, postings: [{ account: `payable_qi:${p.payeeId}`, currency: "qi_base", amount: p.amount }, { account: "qi:obligations", currency: "qi_base", amount: -p.amount }] });
      return p;
    });
  }

  // ------------------------------------------------------------ clusters: self-governing miners + factories

  /** Registers a cluster's first charter, or an amendment chained to the current version. */
  registerCharter(charter: ClusterCharter): ClusterCharter {
    const versions = this.s.charters[charter.id] ?? [];
    const last = versions.at(-1);
    if (last && last.version === charter.version) { if (stableHash(last) !== stableHash(charter)) throw new Error(`charter ${charter.id} v${charter.version} already registered differently`); return last; }
    const errors = last ? validateCharterAmendment(last, charter) : charter.version === 1 ? validateClusterCharter(charter) : ["a new cluster starts at version 1"];
    const closed = (this.s.clusterEpochs[charter.id] ?? []).at(-1);
    if (closed && charter.effectiveFrom <= closed.epoch.end) errors.push("an amendment can't take effect inside an epoch that has already closed");
    if (errors.length) throw new Error(`invalid charter: ${errors.join("; ")}`);
    return this.store.mutate((s) => { (s.charters[charter.id] ??= []).push(charter); return charter; });
  }

  activeCharter(clusterId: string, at: string): ClusterCharter | undefined { return [...(this.s.charters[clusterId] ?? [])].reverse().find((c) => c.effectiveFrom <= at); }

  /** Closes a cluster epoch: blocks are the cluster's wins, workshares its members' accepted deliveries; queues payouts and the burn. */
  closeClusterEpoch(clusterId: string, epoch: { id: string; start: string; end: string }, opts: { phases?: Record<string, Phase>; costCents?: Record<string, number>; lifecycleMetrics?: { timeToFirstLightDays: number | null; timeToSteadyStateDays: number | null; survivalRate: number | null } } = {}): ClusterEpoch {
    const history = this.s.clusterEpochs[clusterId] ?? [];
    const existing = history.find((e) => e.epoch.id === epoch.id);
    if (existing) return existing;
    if (epoch.end > this.nowIso()) throw new Error("an epoch can't close before it ends");
    const charter = this.activeCharter(clusterId, epoch.start);
    if (!charter) throw new Error(`cluster ${clusterId} has no charter in effect at ${epoch.start}`);
    const countedElsewhere = new Set(Object.entries(this.s.clusterEpochs).filter(([id]) => id !== clusterId).flatMap(([, es]) => es.flatMap((e) => e.deliveryIds)));
    const membership = (factoryId: string) => Object.keys(this.s.charters).filter((id) => this.activeCharter(id, epoch.start)?.members.factories.some((f) => f.factoryId === factoryId));
    const all = Object.values(this.s.deliveries);
    const mine = all.filter((d) => !countedElsewhere.has(d.id) && (d.clusterId ? d.clusterId === clusterId : membership(d.factoryId).length === 1 && membership(d.factoryId)[0] === clusterId));
    const record = closeClusterEpoch({ charter, epoch, wins: this.s.clusterWins[clusterId] ?? [], deliveries: mine, allDeliveries: all, standards: this.currentStandards(), history, phases: opts.phases, costCents: opts.costCents, lifecycleMetrics: opts.lifecycleMetrics });
    this.store.mutate((s) => {
      (s.clusterEpochs[clusterId] ??= []).push(record);
      const paid = record.payouts.reduce((t, p) => t + p.totalCents, 0);
      if (paid + record.burn.cents > 0) this.store.post(s, { id: `cluster-epoch:${clusterId}:${epoch.id}`, at: this.nowIso(), kind: "cluster_epoch", refs: { cluster: clusterId, epoch: epoch.id }, postings: [{ account: `payable:cluster:${clusterId}`, currency: "usd_cents", amount: paid + record.burn.cents }, ...record.payouts.map((p) => ({ account: `payable:creator:${p.creatorId}`, currency: "usd_cents" as const, amount: -p.totalCents })), ...(record.burn.cents ? [{ account: `burn_reserve:cluster:${clusterId}`, currency: "usd_cents" as const, amount: -record.burn.cents }] : [])] });
      record.payouts.forEach((p, i) => {
        const pid = `clu_${clusterId}_${epoch.id}_${i}`.replace(/[^A-Za-z0-9_]/g, "");
        s.payouts[pid] = { id: pid, settlementId: `${clusterId}/${epoch.id}`, orderId: `${clusterId}/${epoch.id}`, payeeId: `creator:${p.creatorId}`, rail: "stripe", amount: p.totalCents, currency: "usd_cents", status: "pending", transferGroup: `${clusterId}:${epoch.id}`, updatedAt: this.nowIso(), line: { kind: "cluster_payout", payeeId: `creator:${p.creatorId}`, rail: "stripe", usdCents: p.totalCents, note: `factory ${p.factoryId}: finder ${p.finderCents}¢ + pot ${p.potCents}¢` } };
      });
      if (record.burn.cents > 0) s.clusterBurns[`${clusterId}/${epoch.id}`] = { clusterId, epochId: epoch.id, cents: record.burn.cents, status: "pending" };
    });
    return record;
  }

  /** Records the on-chain buy-and-burn for an epoch. The buy itself happens outside this service. */
  confirmClusterBurn(clusterId: string, epochId: string, txHash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");
    return this.store.mutate((s) => {
      const b = s.clusterBurns[`${clusterId}/${epochId}`];
      if (!b) throw new Error(`no burn pending for ${clusterId} ${epochId}`);
      if (b.status === "confirmed") { if (b.txHash !== txHash) throw new Error(`burn already confirmed with ${b.txHash}`); return b; }
      Object.assign(b, { status: "confirmed", txHash, confirmedAt: this.nowIso() });
      this.store.post(s, { id: `burn:${clusterId}:${epochId}`, at: this.nowIso(), kind: "cluster_burn", refs: { cluster: clusterId, epoch: epochId, tx: txHash }, postings: [{ account: `burn_reserve:cluster:${clusterId}`, currency: "usd_cents", amount: b.cents }, { account: "stripe:balance", currency: "usd_cents", amount: -b.cents }] });
      return b;
    });
  }

  // ------------------------------------------------------------ lifecycle: proving sets, graduations, the ritual

  /** Registers (or re-versions) a factory's proving set. A new version resets the stability streak. */
  registerProvingSet(clusterId: string, factoryId: string, inputHashes: string[]): ProvingSet {
    const charter = this.activeCharter(clusterId, this.nowIso());
    if (!charter?.members.factories.some((f) => f.factoryId === factoryId)) throw new Error(`${factoryId} is not a member of ${clusterId}`);
    const key = `${clusterId}/${factoryId}`;
    const prev = this.s.provingSets[key]?.at(-1);
    const set = sealProvingSet({ id: `ps_${clusterId}_${factoryId}_v${(prev?.version ?? 0) + 1}`, clusterId, factoryId, version: (prev?.version ?? 0) + 1, inputHashes: [...inputHashes].sort(), registeredAt: this.nowIso() });
    return this.store.mutate((s) => { (s.provingSets[key] ??= []).push(set); return set; });
  }

  recordProvingRun(run: ProvingRun): ProvingRun {
    const set = Object.values(this.s.provingSets).flat().find((p) => p.id === run.provingSetId);
    const e: string[] = [];
    if (!set || set.factoryId !== run.factoryId) e.push(`unknown proving set ${run.provingSetId} for ${run.factoryId}`);
    else if (!set.inputHashes.includes(run.inputHash)) e.push("input is not in the proving set");
    if (typeof run.passed !== "boolean" || !run.outputHash || Number.isNaN(Date.parse(run.at))) e.push("passed, outputHash and at are required");
    if (this.s.provingRuns[run.id]) e.push(`proving run ${run.id} already recorded`);
    if (e.length) throw new Error(`invalid proving run: ${e.join("; ")}`);
    return this.store.mutate((s) => (s.provingRuns[run.id] = { ...run }));
  }

  /** Accepts a sealed press record from a factory, verifies its hash, and keeps the summary as evidence. */
  recordPressRecord(record: { schema: string; id: string; factoryId: string; heldAt: string; summary: { documentedRate: number }; hash: string }): PressEvidence {
    const { hash, ...rest } = record;
    if (record.schema !== "press-record@1" || stableHash(rest) !== hash) throw new Error("press record hash does not match its contents");
    const list = this.s.pressEvidence[record.factoryId] ?? [];
    const existing = list.find((p) => p.recordId === record.id);
    if (existing) return existing;
    return this.store.mutate((s) => { const ev = { recordId: record.id, recordHash: hash, factoryId: record.factoryId, documentedRate: record.summary.documentedRate, heldAt: record.heldAt }; (s.pressEvidence[record.factoryId] ??= []).push(ev); return ev; });
  }

  /**
   * The full epoch close: each member factory's lifecycle epoch (phase, stability, milestones and their Qi bounties),
   * then the cluster epoch using the phases at the start of the epoch and the lifecycle metrics.
   */
  closeEpoch(clusterId: string, epoch: { id: string; start: string; end: string }, opts: { costCents?: Record<string, number> } = {}): { lifecycle: LifecycleEpoch[]; milestones: Milestone[]; clusterEpoch: ClusterEpoch } {
    if (epoch.end > this.nowIso()) throw new Error("an epoch can't close before it ends");
    const charter = this.activeCharter(clusterId, epoch.start);
    if (!charter) throw new Error(`cluster ${clusterId} has no charter in effect at ${epoch.start}`);
    const all = Object.values(this.s.deliveries);
    const records: LifecycleEpoch[] = [];
    const newMilestones: Milestone[] = [];
    for (const f of charter.members.factories) {
      const key = `${clusterId}/${f.factoryId}`;
      const history = this.s.lifecycle[key] ?? [];
      const done = history.find((r) => r.epoch.id === epoch.id);
      if (done) { records.push(done); continue; }
      const awarded = this.s.milestones.filter((m) => m.clusterId === clusterId && m.factoryId === f.factoryId && !m.childFactoryId).map((m) => m.kind);
      const { record, milestones } = closeLifecycleEpoch({ charter, factoryId: f.factoryId, epoch, deliveries: all, provingSets: this.s.provingSets[key] ?? [], provingRuns: Object.values(this.s.provingRuns).filter((r) => r.factoryId === f.factoryId), press: this.s.pressEvidence[f.factoryId] ?? [], standards: this.currentStandards(), history, awarded });
      const fresh = milestones.filter((m) => !this.s.milestones.some((x) => x.id === m.id));
      this.store.mutate((s) => {
        (s.lifecycle[key] ??= []).push(record);
        for (const m of fresh) {
          s.milestones.push(m);
          const payees = [m.bounty.factory, ...m.bounty.sponsors, ...m.bounty.contributors].filter((p) => p.qiBase > 0);
          const paid = payees.reduce((t, p) => t + p.qiBase, 0);
          this.store.post(s, { id: `milestone:${m.id}`, at: this.nowIso(), kind: "milestone_bounty", refs: { milestone: m.id }, postings: [{ account: "qi:obligations", currency: "qi_base", amount: paid + m.bounty.burnQiBase }, ...payees.map((p) => ({ account: `payable_qi:${p.payeeId}`, currency: "qi_base" as const, amount: -p.qiBase })), ...(m.bounty.burnQiBase ? [{ account: "qi:burn_reserve", currency: "qi_base" as const, amount: -m.bounty.burnQiBase }] : [])] });
          payees.forEach((p, i) => { const pid = `${m.id}_${i}`.replace(/[^A-Za-z0-9_]/g, ""); s.payouts[pid] = { id: pid, settlementId: m.id, orderId: m.id, payeeId: p.payeeId, rail: "qi", amount: p.qiBase, currency: "qi_base", status: "pending", transferGroup: m.id, updatedAt: this.nowIso(), line: { kind: "time_reward", payeeId: p.payeeId, rail: "qi", usdCents: 0, qiBase: p.qiBase, note: `${m.kind} bounty for ${m.factoryId}` } }; });
          if (m.bounty.burnQiBase) s.milestoneBurns[m.id] = { milestoneId: m.id, qiBase: m.bounty.burnQiBase, status: "pending" };
        }
      });
      records.push(record);
      newMilestones.push(...fresh);
    }
    const phases = Object.fromEntries(records.map((r) => [r.factoryId, r.phaseBefore]));
    const histories = charter.members.factories.map((f) => this.s.lifecycle[`${clusterId}/${f.factoryId}`] ?? []).filter((h) => h.length);
    const metrics = lifecycleMetrics(histories, this.s.milestones.filter((m) => m.clusterId === clusterId));
    const clusterEpoch = this.closeClusterEpoch(clusterId, epoch, { phases, costCents: opts.costCents, lifecycleMetrics: metrics });
    return { lifecycle: records, milestones: newMilestones, clusterEpoch };
  }

  confirmMilestoneBurn(milestoneId: string, txHash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("txHash must be a 32-byte hex hash");
    return this.store.mutate((s) => {
      const b = s.milestoneBurns[milestoneId];
      if (!b) throw new Error(`no burn pending for ${milestoneId}`);
      if (b.status === "confirmed") { if (b.txHash !== txHash) throw new Error(`burn already confirmed with ${b.txHash}`); return b; }
      Object.assign(b, { status: "confirmed", txHash });
      this.store.post(s, { id: `milestone-burn:${milestoneId}`, at: this.nowIso(), kind: "milestone_burn", refs: { milestone: milestoneId, tx: txHash }, postings: [{ account: "qi:burn_reserve", currency: "qi_base", amount: b.qiBase }, { account: "qi:obligations", currency: "qi_base", amount: -b.qiBase }] });
      return b;
    });
  }

  /** The running order for the ritual at the press conference: graduations first, then the scoreboard, results and the burn. */
  ritualAgenda(clusterId: string, epochId: string) {
    const epoch = (this.s.clusterEpochs[clusterId] ?? []).find((e) => e.epoch.id === epochId);
    if (!epoch) throw new Error(`epoch ${epochId} isn't closed for ${clusterId}`);
    const graduations = this.s.milestones.filter((m) => m.clusterId === clusterId && m.epochId === epochId);
    const burn = this.s.clusterBurns[`${clusterId}/${epochId}`];
    return {
      clusterId, epochId, epochHash: epoch.hash,
      beats: [
        ...graduations.map((m) => ({ beat: "graduation", kind: m.kind, factoryId: m.factoryId, childFactoryId: m.childFactoryId, milestoneId: m.id, milestoneHash: m.hash, evidence: m.evidence, bountyQiBase: m.bounty.qiBase })),
        { beat: "scoreboard", ...epoch.scoreboard },
        { beat: "results", wins: epoch.wins.map((w) => ({ factoryId: w.factoryId, finderCents: w.finderCents })), pot: epoch.pot, payouts: epoch.payouts },
        { beat: "burn", cents: epoch.burn.cents, status: burn?.status ?? (epoch.burn.cents ? "pending" : "none"), txHash: burn?.txHash }
      ]
    };
  }

  // ------------------------------------------------------------ time-based Qi rewards from the period pool

  /** Records a delivery as the platform observed it. Times come from the platform's boundary, not the operator's receipt. */
  recordDelivery(d: Delivery): Delivery {
    const e: string[] = [];
    if (!/^[A-Za-z0-9_.:-]{3,80}$/.test(d.id ?? "")) e.push("id is required");
    if (!this.s.payees[d.operatorPayeeId]) e.push(`unknown payee ${d.operatorPayeeId}`);
    if (!d.operation || !d.factoryId) e.push("operation and factoryId are required");
    if (Number.isNaN(Date.parse(d.submittedAt)) || Number.isNaN(Date.parse(d.deliveredAt)) || d.deliveredAt < d.submittedAt) e.push("submittedAt and deliveredAt must be dates in order");
    if (!(d.quality >= 0 && d.quality <= 1)) e.push("quality must be 0..1");
    if (d.receiptId && !this.s.receipts[d.receiptId]) e.push(`unknown receipt ${d.receiptId}`);
    if (d.reuseOf && !this.s.deliveries[d.reuseOf]) e.push(`unknown original delivery ${d.reuseOf}`);
    if (this.s.rewardPeriods.some((p) => d.deliveredAt <= p.end)) e.push("delivery falls in a period that is already closed");
    if (e.length) throw new Error(`invalid delivery: ${e.join("; ")}`);
    const prior = this.s.deliveries[d.id];
    if (prior) { if (JSON.stringify(prior) !== JSON.stringify(d)) throw new Error(`delivery ${d.id} already recorded differently`); return prior; }
    return this.store.mutate((s) => (s.deliveries[d.id] = { ...d }));
  }

  /** The standards in force for the next period to close: the last period's computed standards, or declared ones at the start. */
  currentStandards() { const last = this.s.rewardPeriods.at(-1); return last?.nextStandards ?? computeStandards([], {}, this.cfg.rewards); }

  /** Closes a reward period: scores deliveries against the standards, sizes and splits the pool, and queues Qi payouts. */
  closeRewardPeriod(p: { id: string; start: string; end: string }): RewardPeriod {
    const existing = this.s.rewardPeriods.find((x) => x.id === p.id);
    if (existing) return existing;
    const errors = validateRewardConfig(this.cfg.rewards);
    if (errors.length) throw new Error(`invalid reward config: ${errors.join("; ")}`);
    const last = this.s.rewardPeriods.at(-1);
    if (p.end > this.nowIso()) throw new Error("a period can't close before it ends");
    if (p.start > p.end) throw new Error("period start must be before its end");
    if (last && p.start <= last.end) throw new Error(`period ${p.id} overlaps ${last.id}`);
    const rollover = Object.fromEntries((last?.pool.sections ?? []).map((sec) => [sec.id, sec.rolloverOutQiBase]));
    const period = closeRewardPeriod({ ...p, deliveries: Object.values(this.s.deliveries), standards: this.currentStandards(), rollover, config: this.cfg.rewards, previous: last ? { id: last.id, hash: last.hash } : undefined });
    this.store.mutate((s) => {
      s.rewardPeriods.push(period);
      for (const [i, payout] of period.payouts.entries()) {
        this.store.post(s, { id: `qi-reward:${period.id}:${payout.payeeId}`, at: this.nowIso(), kind: "qi_time_reward", refs: { period: period.id }, postings: [{ account: "qi:obligations", currency: "qi_base", amount: payout.qiBase }, { account: `payable_qi:${payout.payeeId}`, currency: "qi_base", amount: -payout.qiBase }] });
        const pid = `rwd_${period.id.replace(/[^A-Za-z0-9]/g, "")}_${i}`;
        s.payouts[pid] = { id: pid, settlementId: period.id, orderId: period.id, payeeId: payout.payeeId, rail: "qi", amount: payout.qiBase, currency: "qi_base", status: "pending", transferGroup: period.id, updatedAt: this.nowIso(), line: { kind: "time_reward", payeeId: payout.payeeId, rail: "qi", usdCents: 0, qiBase: payout.qiBase, note: `${payout.score.toFixed(1)} standard seconds in period ${period.id}` } };
      }
    });
    return period;
  }

  // ------------------------------------------------------------ how much energy operators keep operating with

  operatorStatement(payeeId: string, period: { from: string; to: string }) {
    const settlements = Object.values(this.s.settlements).filter((x) => x.at >= period.from && x.at <= period.to);
    const lines = settlements.flatMap((x) => x.waterfall.lines.filter((l) => l.payeeId === payeeId).map((l) => ({ ...l, orderId: x.orderId })));
    const receipts = Object.values(this.s.receipts).map((r) => r.receipt).filter((r) => `operator:${r.operatorId}` === payeeId && r.finishedAt >= period.from && r.finishedAt <= period.to);
    const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
    const energyByClass = { measuredWh: sum(receipts.map((r) => r.energy.measuredWh)), providerReportedWh: sum(receipts.map((r) => r.energy.providerReportedWh)), estimatedWh: sum(receipts.map((r) => r.energy.estimatedWh)), unknownSteps: sum(receipts.map((r) => r.energy.unknownSteps)) };
    const energyLines = lines.filter((l) => l.kind === "energy");
    const grossOfOrders = sum([...new Set(lines.map((l) => l.orderId))].map((id) => this.s.orders[id]?.amountCents ?? 0));
    const energyCents = sum(energyLines.map((l) => l.usdCents));
    const shortfalls = settlements.flatMap((x) => x.waterfall.shortfalls.filter((f) => f.payeeId === payeeId));
    return {
      payeeId, period,
      operations: { total: receipts.length, completed: receipts.filter((r) => r.status === "completed").length, byHosting: { operator: receipts.filter((r) => r.hosting === "operator").length, platform: receipts.filter((r) => r.hosting === "platform").length, provider: receipts.filter((r) => r.hosting === "provider").length } },
      energy: { ...energyByClass, reimbursedWh: sum(energyLines.map((l) => l.energyWh ?? 0)), unfundedWh: sum(shortfalls.filter((f) => f.kind === "energy").map((f) => f.energyWh ?? 0)) },
      qi: { earnedBase: sum(energyLines.map((l) => l.qiBase ?? 0)), earned: formatQi(sum(energyLines.map((l) => l.qiBase ?? 0))), owedBase: -this.store.balance(`payable_qi:${payeeId}`, "qi_base") || 0 },
      fiat: { marginCents: sum(lines.filter((l) => l.kind === "margin").map((l) => l.usdCents)), providerReimbursedCents: sum(lines.filter((l) => l.kind === "provider_passthrough").map((l) => l.usdCents)), owedCents: -this.store.balance(`payable:${payeeId}`, "usd_cents") || 0 },
      rewards: (() => {
        const periods = this.s.rewardPeriods.filter((x) => x.end >= period.from && x.start <= period.to);
        const mine = periods.flatMap((x) => x.deliveries.filter((d) => d.operatorPayeeId === payeeId));
        const scored = mine.filter((d) => d.speedup !== undefined);
        return {
          qiBase: sum(periods.flatMap((x) => x.payouts.filter((p) => p.payeeId === payeeId).map((p) => p.qiBase))),
          deliveries: mine.length, scored: scored.length,
          medianSpeedup: scored.length ? [...scored.map((d) => d.speedup!)].sort((a, b) => a - b)[Math.floor(scored.length / 2)] : null,
          standardSecondsEarned: sum(periods.flatMap((x) => x.deliveries.filter((d) => d.creditedTo === payeeId).map((d) => d.score))),
          unscoredReasons: Object.fromEntries([...new Set(mine.filter((d) => d.score === 0).map((d) => d.reason))].map((r) => [r, mine.filter((d) => d.reason === r).length]))
        };
      })(),
      /** Share of the revenue on this operator's orders that went to operating energy. Lower is more efficient. */
      energyCostShareOfRevenue: grossOfOrders ? energyCents / grossOfOrders : null,
      completedOperationsPerKwh: energyByClass.measuredWh + energyByClass.providerReportedWh + energyByClass.estimatedWh > 0 ? receipts.filter((r) => r.status === "completed").length / ((energyByClass.measuredWh + energyByClass.providerReportedWh + energyByClass.estimatedWh) / 1000) : null
    };
  }

  // ------------------------------------------------------------ helpers
  private mustCreator(id: string) { const c = this.s.creators[id]; if (!c) throw new Error(`unknown creator ${id}`); return c; }
  private creatorByCustomer(customerId?: string) { return Object.values(this.s.creators).find((c) => c.stripeCustomerId === customerId); }
}
