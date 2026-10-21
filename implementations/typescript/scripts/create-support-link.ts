import Stripe from "stripe";

/**
 * Creates the Stripe Payment Link for "Explain Quai to me", the miner-commissioned music video.
 * Customers choose what to pay: $50 minimum, $50 preset, more buys more iterations. Two text fields collect what the
 * miner's Qi is doing and what the video should explain. Idempotent by price lookup key. Test mode unless you opt in.
 *
 *   STRIPE_SECRET_KEY=sk_test_... pnpm create:support-link
 *
 * Prints the link URL; paste it into the miner page.
 */
const key = process.env.STRIPE_SECRET_KEY ?? "";
if (!/^sk_(test|live)_/.test(key) && !/^rk_(test|live)_/.test(key)) throw new Error("set STRIPE_SECRET_KEY");
if (key.includes("_live_") && process.env.CREATORAPIS_ALLOW_LIVE !== "1") throw new Error("live key refused; set CREATORAPIS_ALLOW_LIVE=1 to use it");
const stripe = new Stripe(key);
const lookupKey = "miner_music_video_support_v1";
const minimumCents = Number(process.env.SUPPORT_MINIMUM_CENTS ?? 5000);

const existing = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
let price = existing.data[0];
if (!price) {
  const product = await stripe.products.create({ name: "Explain Quai to me: a music video", description: "Back a music video that explains Quai, Qi, and what miners connect them to. More support buys more iterations.", metadata: { factory_id: "music-video", campaign: "miner-explainer" } });
  price = await stripe.prices.create({ product: product.id, currency: "usd", lookup_key: lookupKey, custom_unit_amount: { enabled: true, minimum: minimumCents, preset: minimumCents }, metadata: { factory_id: "music-video" } });
}
const link = await stripe.paymentLinks.create({
  line_items: [{ price: price.id, quantity: 1 }],
  custom_fields: [
    { key: "qi_now", type: "text", optional: true, label: { type: "custom", custom: "What is your Qi doing right now?" } },
    { key: "inspire", type: "text", optional: true, label: { type: "custom", custom: "What should the video explain?" } }
  ],
  metadata: { factory_id: "music-video", campaign: "miner-explainer", kind: "offer_order" }
});
console.log(JSON.stringify({ mode: key.includes("_live_") ? "live" : "test", priceId: price.id, paymentLinkUrl: link.url }, null, 2));
