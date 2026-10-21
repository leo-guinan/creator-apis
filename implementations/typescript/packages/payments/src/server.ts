import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { OperationReceipt } from "../../contracts/src/index.js";
import { StripeGateway } from "./gateway.js";
import { CreatorPayments } from "./service.js";
import { Store } from "./store.js";

/**
 * Minimal HTTP surface. Admin routes take `Authorization: Bearer <CREATORAPIS_ADMIN_TOKEN>`; factories sign receipts
 * with `X-Factory-Signature: sha256=<hmac of raw body>` using their shared secret; Stripe signs webhooks.
 * Local/reference only: no rate limiting, no per-creator auth, no TLS termination.
 */
export interface ServerOptions { adminToken: string; factorySecrets: Record<string, string>; }

const readBody = (req: IncomingMessage) => new Promise<Buffer>((resolve, reject) => { const chunks: Buffer[] = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject); });
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function signReceipt(raw: string | Buffer, secret: string) { return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`; }

export function createPaymentsServer(payments: CreatorPayments, opts: ServerOptions): Server {
  if (!opts.adminToken || opts.adminToken.length < 24) throw new Error("CREATORAPIS_ADMIN_TOKEN must be at least 24 characters");
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      const raw = await readBody(req);
      const json = () => (raw.length ? JSON.parse(raw.toString("utf8")) : {});
      const admin = () => { if (!safeEqual(req.headers.authorization ?? "", `Bearer ${opts.adminToken}`)) throw Object.assign(new Error("unauthorized"), { status: 401 }); };
      const route = `${req.method} ${url.pathname}`;
      let m: RegExpMatchArray | null;

      if (route === "GET /health") return send(res, 200, { ok: true, mode: payments.gateway.mode });
      if (route === "POST /v1/stripe/webhook") return send(res, 200, await payments.handleWebhook(raw, String(req.headers["stripe-signature"] ?? "")));
      if (route === "POST /v1/receipts") {
        const receipt = json() as OperationReceipt;
        const secret = opts.factorySecrets[receipt.factoryId];
        if (!secret || !safeEqual(String(req.headers["x-factory-signature"] ?? ""), signReceipt(raw, secret))) return send(res, 401, { error: "receipt signature invalid for this factory" });
        return send(res, 200, await payments.ingestReceipt(receipt));
      }
      admin();
      if (route === "POST /v1/setup") return send(res, 200, await payments.setup());
      if (route === "POST /v1/creators") return send(res, 201, await payments.registerCreator(json()));
      if ((m = route.match(/^POST \/v1\/creators\/([^/]+)\/subscribe$/))) return send(res, 200, await payments.subscribeCreator(m[1]));
      if ((m = route.match(/^GET \/v1\/creators\/([^/]+)\/entitlement$/))) return send(res, 200, payments.entitlement(m[1]));
      if (route === "POST /v1/payees") return send(res, 201, await payments.registerPayee(json()));
      if ((m = route.match(/^PUT \/v1\/payees\/([^/]+)\/qi-address$/))) return send(res, 200, payments.setQiAddress(decodeURIComponent(m[1]), json().address));
      if (route === "POST /v1/offers") return send(res, 201, payments.createOffer(json()));
      if ((m = route.match(/^POST \/v1\/offers\/([^/]+)\/checkout$/))) return send(res, 201, await payments.checkoutOffer(m[1], json()));
      if (route === "POST /v1/quotes") return send(res, 201, payments.recordQuote(json()));
      if ((m = route.match(/^POST \/v1\/orders\/([^/]+)\/settle$/))) return send(res, 200, await payments.settleOrder(m[1]));
      if (route === "POST /v1/payouts/fiat/run") return send(res, 200, await payments.runFiatPayouts());
      if (route === "POST /v1/payouts/qi/export") return send(res, 200, payments.exportQiBatch());
      if ((m = route.match(/^POST \/v1\/payouts\/([^/]+)\/confirm$/))) return send(res, 200, payments.confirmQiPayout(m[1], json().txHash));
      if ((m = route.match(/^GET \/v1\/operators\/([^/]+)\/statement$/))) return send(res, 200, payments.operatorStatement(decodeURIComponent(m[1]), { from: url.searchParams.get("from") ?? "0000", to: url.searchParams.get("to") ?? "9999" }));
      if (route === "POST /v1/deliveries") return send(res, 201, payments.recordDelivery(json()));
      if (route === "GET /v1/rewards/standards") return send(res, 200, payments.currentStandards());
      if (route === "POST /v1/rewards/periods/close") return send(res, 200, payments.closeRewardPeriod(json()));
      if ((m = route.match(/^GET \/v1\/rewards\/periods\/([^/]+)$/))) { const period = payments.store.state.rewardPeriods.find((x) => x.id === decodeURIComponent(m![1])); return period ? send(res, 200, period) : send(res, 404, { error: "no such period" }); }
      if (route === "POST /v1/clusters") return send(res, 201, payments.registerCharter(json()));
      if ((m = route.match(/^POST \/v1\/clusters\/([^/]+)\/epochs\/close$/))) { const b = json(); return send(res, 200, payments.closeClusterEpoch(m[1], b.epoch, { phases: b.phases, costCents: b.costCents })); }
      if ((m = route.match(/^GET \/v1\/clusters\/([^/]+)\/epochs$/))) return send(res, 200, payments.store.state.clusterEpochs[m[1]] ?? []);
      if ((m = route.match(/^POST \/v1\/clusters\/([^/]+)\/epochs\/([^/]+)\/burn$/))) return send(res, 200, payments.confirmClusterBurn(m[1], decodeURIComponent(m[2]), json().txHash));
      if ((m = route.match(/^POST \/v1\/clusters\/([^/]+)\/factories\/([^/]+)\/proving-set$/))) return send(res, 201, payments.registerProvingSet(m[1], decodeURIComponent(m[2]), json().inputHashes));
      if (route === "POST /v1/proving-runs") return send(res, 201, payments.recordProvingRun(json()));
      if (route === "POST /v1/press-records") return send(res, 201, payments.recordPressRecord(json()));
      if ((m = route.match(/^POST \/v1\/clusters\/([^/]+)\/close$/))) { const b = json(); return send(res, 200, payments.closeEpoch(m[1], b.epoch, { costCents: b.costCents })); }
      if ((m = route.match(/^GET \/v1\/clusters\/([^/]+)\/epochs\/([^/]+)\/agenda$/))) return send(res, 200, payments.ritualAgenda(m[1], decodeURIComponent(m[2])));
      if ((m = route.match(/^POST \/v1\/milestones\/([^/]+)\/burn$/))) return send(res, 200, payments.confirmMilestoneBurn(decodeURIComponent(m[1]), json().txHash));
      if (route === "POST /v1/commission-pools") return send(res, 201, payments.registerCommissionPool(json()));
      if ((m = route.match(/^GET \/v1\/commission-pools\/([^/]+)\/learning$/))) return send(res, 200, payments.learningReport(m[1]));
      if (route === "POST /v1/commissions") return send(res, 201, payments.requestCommission(json()));
      if ((m = route.match(/^GET \/v1\/commissions\/([^/]+)$/))) { const c = payments.store.state.commissions[decodeURIComponent(m[1])]; return c ? send(res, 200, c) : send(res, 404, { error: "no such commission" }); }
      if ((m = route.match(/^POST \/v1\/commissions\/([^/]+)\/payment$/))) return send(res, 200, payments.confirmCommissionPayment(decodeURIComponent(m[1]), json()));
      if ((m = route.match(/^POST \/v1\/commissions\/([^/]+)\/delivery$/))) return send(res, 200, payments.deliverCommission(decodeURIComponent(m[1]), json()));
      if ((m = route.match(/^POST \/v1\/commissions\/([^/]+)\/decision$/))) return send(res, 200, payments.decideCommission(decodeURIComponent(m[1]), json()));
      if ((m = route.match(/^POST \/v1\/commissions\/([^/]+)\/refund$/))) return send(res, 200, payments.confirmCommissionRefund(decodeURIComponent(m[1]), json().txHash));
      if ((m = route.match(/^POST \/v1\/commissions\/([^/]+)\/burn$/))) return send(res, 200, payments.confirmCommissionBurn(decodeURIComponent(m[1]), json().txHash));
      if (route === "GET /v1/ledger/balances") return send(res, 200, payments.store.balances(url.searchParams.get("prefix") ?? ""));
      return send(res, 404, { error: "not found" });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      return send(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const gateway = new StripeGateway({ secretKey: env.STRIPE_SECRET_KEY ?? "", webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? "", allowLive: env.CREATORAPIS_ALLOW_LIVE === "1" });
  const payments = new CreatorPayments(gateway, new Store(env.CREATORAPIS_PAYMENTS_STATE ?? "data/payments-state.json"), { publicUrl: env.CREATORAPIS_PUBLIC_URL ?? "http://127.0.0.1:8790" });
  const port = Number(env.PORT ?? 8790);
  createPaymentsServer(payments, { adminToken: env.CREATORAPIS_ADMIN_TOKEN ?? "", factorySecrets: JSON.parse(env.CREATORAPIS_FACTORY_SECRETS ?? "{}") }).listen(port, "127.0.0.1", () => console.log(`creator-apis payments (${gateway.mode}) on http://127.0.0.1:${port}`));
}
