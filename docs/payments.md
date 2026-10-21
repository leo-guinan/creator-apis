# Payments: Stripe for fiat, Qi for operating energy

**Status:** TypeScript reference implementation in [`implementations/typescript`](../implementations/typescript/README.md). Tested against a fake gateway with Stripe's real webhook signature verification. Not deployed; no live keys; no calls made to Stripe's API from the build environment.

Creator APIs sells the ability to produce, not a tax on relationships. Money moves in four flows:

| Flow | Stripe mechanism | Who pays whom |
|---|---|---|
| Creator subscription | Billing: $20/month recurring price, Checkout in `subscription` mode | Creator → platform. Unlocks publishing and selling. |
| Metered compute | Billing Meter `factory_compute_cents` + metered price on the same subscription | Creator → platform, for work run on platform compute, at cost, bounded by a monthly budget |
| Customer checkout | Checkout in `payment` mode at the creator's price, `transfer_group` = order id | Customer → platform balance |
| Payouts | Connect transfers to recipient accounts, `source_transaction` = the charge | Platform balance → creator, operator, tool authors |

Plus one rail outside Stripe: **Qi rewards for factory operators**, paid from a pool each period for the time it takes to create, normalized against a standard artifact. See [`operator-rewards.md`](operator-rewards.md).

## Settlement waterfall (per paid order)

```
gross (what the customer paid)
  − Stripe fee                          from the charge's balance transaction
  − platform fee                        bps of gross; default 0
  − tool royalties                      per sale and/or bps of gross, per tool author
  − provider pass-through               third-party API costs the operator paid (receipts with hosting=provider), fiat
  − cluster set-aside                   if the offer names a cluster the factory belongs to: the charter's share of margin
  = margin                              fiat, split by the offer's shares (default 100% to the creator)
```

The cluster set-aside accumulates in the cluster's account. At each epoch close it pays finder shares, the workshare pot and the burn ([`factory-lifecycle.md`](factory-lifecycle.md)).

Operators earn Qi from the period pool, not from each sale. With `qiFrom: "sale"`, operator energy is instead deducted before margin at an energy quote and paid in Qi.

- Each step takes what's left. What a step can't cover is recorded as a **shortfall**, never a negative payout and never paid from elsewhere.
- Lines always reconcile to gross; settlement throws if they don't.
- Platform-hosted work isn't deducted here: it's already billed to the creator as metered compute.
- In `qiFrom: "sale"` mode, settlement waits (`needs_quote`) if operator energy needs pricing and there's no fresh quote.

## Ledger

One append-only journal with integer amounts in two currencies (`usd_cents`, `qi_base` = 0.001 Qi). Every entry balances per currency or is rejected.

| Account | Meaning |
|---|---|
| `stripe:balance` | Platform's Stripe balance |
| `order:<id>` | What an order still has to allocate. 0 after settlement; positive after a post-settlement refund (overpaid) |
| `payable:<payee>` | Fiat owed (negative = owed), cleared by transfers |
| `payable_qi:<payee>` / `qi:obligations` | Qi owed to operators / total Qi the platform owes |
| `qi:reserve` | USD set aside at settlement to acquire the Qi it owes |
| `platform:revenue` | Subscriptions, metered compute, platform fees |

## Webhooks handled

`checkout.session.completed`, `checkout.session.async_payment_succeeded|failed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`, `account.updated`. Every event is signature-verified, applied once (deduplicated by event id), and a live-mode event is refused by a test-mode service.

## Factory receipts

Factories POST `operation-receipt@1` JSON to `/v1/receipts`, signed with `X-Factory-Signature: sha256=<HMAC of the body>`. The receipt's own sha256 must match its contents. Platform-hosted receipts become meter events (identifier = receipt id, so retries don't double-bill), up to the creator's monthly budget; past it, usage is recorded unbilled and the response says `stop: true`.

## Decisions still open

1. **Merchant of record.** Separate charges and transfers make the *platform* the merchant of record and liable for refunds and disputes; the creator "owns the relationship" only in our records. The alternative, direct charges on the creator's account, makes the creator merchant of record but can't split one payment across operators and tool authors. Current choice: separate charges and transfers.
2. **Platform fee** defaults to 0, in keeping with "not a tax on human relationships". The subscription is the business model.
3. **Refunds after settlement** are flagged `needs_reversal`, not reversed automatically. Transfer reversals need a policy (who absorbs the loss when a payee has already withdrawn).
4. **Connected accounts** use Accounts v1 with controller properties (Express dashboard, platform liable for losses, Stripe collects KYC). Accounts v2 with the recipient configuration is the newer path; migrate when ready.
5. **Compute budget** defaults to $20/month per creator. It's a guess; set it per creator.

## Running it (test mode)

```bash
cd implementations/typescript
pnpm install
pnpm validate                       # typecheck + tests (no network)
STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... pnpm bootstrap:stripe   # creates product, prices, meter
STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... CREATORAPIS_ADMIN_TOKEN=... \
  CREATORAPIS_FACTORY_SECRETS='{"presser":"..."}' pnpm server
stripe listen --forward-to localhost:8790/v1/stripe/webhook
```

A live key is refused unless `CREATORAPIS_ALLOW_LIVE=1`.
