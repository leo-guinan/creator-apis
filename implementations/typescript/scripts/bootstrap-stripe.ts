import { StripeGateway } from "../packages/payments/src/gateway.js";

/**
 * Creates (or finds) the Stripe catalog in your account: the $20/month creator price, the factory compute meter, and the
 * metered price. Idempotent: lookup keys and the meter event name are checked first. Test mode unless you opt in.
 *
 *   STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... pnpm bootstrap:stripe
 */
const gateway = new StripeGateway({ secretKey: process.env.STRIPE_SECRET_KEY ?? "", webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "", allowLive: process.env.CREATORAPIS_ALLOW_LIVE === "1" });
const catalog = await gateway.ensureCatalog({ subscriptionCents: Number(process.env.CREATORAPIS_SUBSCRIPTION_CENTS ?? 2000), meterEventName: process.env.CREATORAPIS_METER_EVENT ?? "factory_compute_cents", meteredUnitAmountDecimal: process.env.CREATORAPIS_METERED_UNIT_CENTS ?? "1" });
console.log(JSON.stringify({ mode: gateway.mode, ...catalog }, null, 2));
