import Stripe from "stripe";

/** The slice of Stripe that Creator APIs uses. StripeGateway talks to Stripe; FakeGateway records calls for tests and dry runs. */
export interface Catalog { productId: string; subscriptionPriceId: string; meterId: string; meterEventName: string; meteredPriceId: string; }
export interface CatalogSpec { subscriptionCents: number; meterEventName: string; /** cents charged per meter unit; the meter value is compute cost in cents, so "1" bills at cost */ meteredUnitAmountDecimal: string; }
export interface PaymentDetails { paymentIntentId: string; chargeId?: string; amountCents: number; feeCents?: number; status: string; }
export interface WebhookEvent { id: string; type: string; data: { object: Record<string, unknown> }; livemode: boolean; }

export interface PaymentsGateway {
  readonly mode: "test" | "live" | "fake";
  ensureCatalog(spec: CatalogSpec): Promise<Catalog>;
  createCustomer(p: { email: string; name: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  createSubscriptionCheckout(p: { customerId: string; subscriptionPriceId: string; meteredPriceId: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string; url: string }>;
  recordMeterEvent(p: { eventName: string; customerId: string; value: string; identifier: string; timestamp: number }): Promise<void>;
  createPaymentCheckout(p: { name: string; unitAmountCents: number; quantity: number; currency: "usd"; transferGroup: string; metadata: Record<string, string>; customerEmail?: string; successUrl: string; cancelUrl: string }, idempotencyKey: string): Promise<{ id: string; url: string }>;
  createRecipientAccount(p: { email: string; country: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  createOnboardingLink(accountId: string, p: { refreshUrl: string; returnUrl: string }): Promise<{ url: string }>;
  getPaymentDetails(paymentIntentId: string): Promise<PaymentDetails>;
  createTransfer(p: { amountCents: number; currency: "usd"; destination: string; transferGroup: string; sourceTransaction?: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  /** Verifies the Stripe-Signature header against the raw body. Throws if it doesn't match. */
  parseWebhook(rawBody: string | Buffer, signature: string): WebhookEvent;
}

function verifier(webhookSecret: string) {
  const client = new Stripe("sk_test_webhook_verifier_only");
  return (raw: string | Buffer, sig: string) => client.webhooks.constructEvent(raw, sig, webhookSecret) as unknown as WebhookEvent;
}

export interface StripeGatewayOptions { secretKey: string; webhookSecret: string; allowLive?: boolean; client?: Stripe; }

export class StripeGateway implements PaymentsGateway {
  readonly mode: "test" | "live";
  private readonly stripe: Stripe;
  private readonly verify: ReturnType<typeof verifier>;
  constructor(o: StripeGatewayOptions) {
    if (!/^(sk|rk)_(test|live)_/.test(o.secretKey)) throw new Error("STRIPE_SECRET_KEY must be a Stripe secret or restricted key");
    this.mode = o.secretKey.includes("_live_") ? "live" : "test";
    if (this.mode === "live" && !o.allowLive) throw new Error("refusing a live Stripe key; set CREATORAPIS_ALLOW_LIVE=1 only when you mean to move real money");
    if (!o.webhookSecret?.startsWith("whsec_")) throw new Error("STRIPE_WEBHOOK_SECRET must be a whsec_ signing secret");
    this.stripe = o.client ?? new Stripe(o.secretKey);
    this.verify = verifier(o.webhookSecret);
  }

  async ensureCatalog(spec: CatalogSpec): Promise<Catalog> {
    const lookupSub = `creatorapis_creator_monthly_${spec.subscriptionCents}`;
    const lookupMetered = `creatorapis_compute_${spec.meterEventName}`;
    const prices = await this.stripe.prices.list({ lookup_keys: [lookupSub, lookupMetered], active: true, limit: 10 });
    let sub = prices.data.find((p) => p.lookup_key === lookupSub);
    let metered = prices.data.find((p) => p.lookup_key === lookupMetered);
    const meters = await this.stripe.billing.meters.list({ status: "active", limit: 100 });
    let meter = meters.data.find((m) => m.event_name === spec.meterEventName);
    const productId = (sub?.product as string | undefined) ?? (await this.stripe.products.create({ name: "Creator APIs factory control plane", metadata: { creatorapis: "subscription" } }, { idempotencyKey: `product:${lookupSub}` })).id;
    if (!sub) sub = await this.stripe.prices.create({ product: productId, currency: "usd", unit_amount: spec.subscriptionCents, recurring: { interval: "month" }, lookup_key: lookupSub, nickname: "Creator monthly" }, { idempotencyKey: `price:${lookupSub}` });
    if (!meter) meter = await this.stripe.billing.meters.create({ display_name: "Factory compute (USD cents at cost)", event_name: spec.meterEventName, default_aggregation: { formula: "sum" }, customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" }, value_settings: { event_payload_key: "value" } }, { idempotencyKey: `meter:${spec.meterEventName}` });
    if (!metered) metered = await this.stripe.prices.create({ product: productId, currency: "usd", unit_amount_decimal: Stripe.Decimal.from(spec.meteredUnitAmountDecimal), recurring: { interval: "month", usage_type: "metered", meter: meter.id }, lookup_key: lookupMetered, nickname: "Factory compute" }, { idempotencyKey: `price:${lookupMetered}` });
    return { productId, subscriptionPriceId: sub.id, meterId: meter.id, meterEventName: spec.meterEventName, meteredPriceId: metered.id };
  }

  async createCustomer(p: { email: string; name: string; metadata: Record<string, string> }, idempotencyKey: string) {
    const c = await this.stripe.customers.create({ email: p.email, name: p.name, metadata: p.metadata }, { idempotencyKey });
    return { id: c.id };
  }

  async createSubscriptionCheckout(p: { customerId: string; subscriptionPriceId: string; meteredPriceId: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }, idempotencyKey: string) {
    const s = await this.stripe.checkout.sessions.create({ mode: "subscription", customer: p.customerId, line_items: [{ price: p.subscriptionPriceId, quantity: 1 }, { price: p.meteredPriceId }], success_url: p.successUrl, cancel_url: p.cancelUrl, metadata: p.metadata, subscription_data: { metadata: p.metadata } }, { idempotencyKey });
    return { id: s.id, url: s.url ?? "" };
  }

  async recordMeterEvent(p: { eventName: string; customerId: string; value: string; identifier: string; timestamp: number }) {
    await this.stripe.billing.meterEvents.create({ event_name: p.eventName, payload: { stripe_customer_id: p.customerId, value: p.value }, identifier: p.identifier, timestamp: p.timestamp }, { idempotencyKey: `meter:${p.identifier}` });
  }

  async createPaymentCheckout(p: { name: string; unitAmountCents: number; quantity: number; currency: "usd"; transferGroup: string; metadata: Record<string, string>; customerEmail?: string; successUrl: string; cancelUrl: string }, idempotencyKey: string) {
    const s = await this.stripe.checkout.sessions.create({ mode: "payment", line_items: [{ quantity: p.quantity, price_data: { currency: p.currency, unit_amount: p.unitAmountCents, product_data: { name: p.name } } }], payment_intent_data: { transfer_group: p.transferGroup, metadata: p.metadata }, metadata: p.metadata, customer_email: p.customerEmail, success_url: p.successUrl, cancel_url: p.cancelUrl }, { idempotencyKey });
    return { id: s.id, url: s.url ?? "" };
  }

  /** A recipient account: receives transfers, Express dashboard, platform liable for losses, Stripe collects KYC. */
  async createRecipientAccount(p: { email: string; country: string; metadata: Record<string, string> }, idempotencyKey: string) {
    const a = await this.stripe.accounts.create({ email: p.email, country: p.country, metadata: p.metadata, capabilities: { transfers: { requested: true } }, controller: { stripe_dashboard: { type: "express" }, fees: { payer: "application" }, losses: { payments: "application" }, requirement_collection: "stripe" } }, { idempotencyKey });
    return { id: a.id };
  }

  async createOnboardingLink(accountId: string, p: { refreshUrl: string; returnUrl: string }) {
    const l = await this.stripe.accountLinks.create({ account: accountId, refresh_url: p.refreshUrl, return_url: p.returnUrl, type: "account_onboarding" });
    return { url: l.url };
  }

  async getPaymentDetails(paymentIntentId: string): Promise<PaymentDetails> {
    const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
    const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : undefined;
    const bt = charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : undefined;
    return { paymentIntentId: pi.id, chargeId: charge?.id ?? (typeof pi.latest_charge === "string" ? pi.latest_charge : undefined), amountCents: pi.amount_received, feeCents: bt?.fee ?? undefined, status: pi.status };
  }

  async createTransfer(p: { amountCents: number; currency: "usd"; destination: string; transferGroup: string; sourceTransaction?: string; metadata: Record<string, string> }, idempotencyKey: string) {
    const t = await this.stripe.transfers.create({ amount: p.amountCents, currency: p.currency, destination: p.destination, transfer_group: p.transferGroup, source_transaction: p.sourceTransaction, metadata: p.metadata }, { idempotencyKey });
    return { id: t.id };
  }

  parseWebhook(raw: string | Buffer, signature: string) { return this.verify(raw, signature); }
}

/** In-memory gateway. Webhook verification is real (Stripe's own signature check), so tests exercise the same path. */
export class FakeGateway implements PaymentsGateway {
  readonly mode = "fake" as const;
  readonly calls: Array<{ method: string; params: unknown; idempotencyKey?: string }> = [];
  readonly payments = new Map<string, PaymentDetails>();
  private readonly seen = new Map<string, { id: string; url: string }>();
  private n = 0;
  private readonly verify: ReturnType<typeof verifier>;
  constructor(readonly webhookSecret = "whsec_test_fake") { this.verify = verifier(webhookSecret); }
  private id(prefix: string, key?: string) { if (key && this.seen.has(key)) return this.seen.get(key)!; const r = { id: `${prefix}_fake_${++this.n}`, url: `https://checkout.stripe.test/${prefix}_${this.n}` }; if (key) this.seen.set(key, r); return r; }
  private log(method: string, params: unknown, idempotencyKey?: string) { this.calls.push({ method, params, idempotencyKey }); }
  async ensureCatalog(spec: CatalogSpec) { this.log("ensureCatalog", spec); return { productId: "prod_fake", subscriptionPriceId: "price_fake_sub", meterId: "mtr_fake", meterEventName: spec.meterEventName, meteredPriceId: "price_fake_metered" }; }
  async createCustomer(p: unknown, k: string) { this.log("createCustomer", p, k); return { id: this.id("cus", k).id }; }
  async createSubscriptionCheckout(p: unknown, k: string) { this.log("createSubscriptionCheckout", p, k); return this.id("cs", k); }
  async recordMeterEvent(p: unknown) { this.log("recordMeterEvent", p); }
  async createPaymentCheckout(p: unknown, k: string) { this.log("createPaymentCheckout", p, k); return this.id("cs", k); }
  async createRecipientAccount(p: unknown, k: string) { this.log("createRecipientAccount", p, k); return { id: this.id("acct", k).id }; }
  async createOnboardingLink(accountId: string, p: unknown) { this.log("createOnboardingLink", { accountId, ...(p as object) }); return { url: `https://connect.stripe.test/onboard/${accountId}` }; }
  async getPaymentDetails(pi: string) { this.log("getPaymentDetails", pi); const d = this.payments.get(pi); if (!d) throw new Error(`unknown payment intent ${pi}`); return d; }
  async createTransfer(p: unknown, k: string) { this.log("createTransfer", p, k); return { id: this.id("tr", k).id }; }
  parseWebhook(raw: string | Buffer, sig: string) { return this.verify(raw, sig); }
  /** Signs a payload the way Stripe does, for tests. */
  sign(payload: string) { return new Stripe("sk_test_signer").webhooks.generateTestHeaderString({ payload, secret: this.webhookSecret }); }
}
