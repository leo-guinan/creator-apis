# Creator APIs TypeScript reference

Three packages, one workspace:

- **`packages/contracts`**: types, validators and canonical hashing for the shared contracts in [`/contracts`](../../contracts/README.md)
- **`packages/press`**: creator press content (cast → agent cards → press corps), story templates, story packages with approval and consent
- **`packages/payments`**: Stripe subscriptions, metered compute, customer checkout, Connect payouts, and Qi operator rewards from a time-based pool ([`docs/payments.md`](../../docs/payments.md), [`docs/operator-rewards.md`](../../docs/operator-rewards.md))

```bash
pnpm install
pnpm validate            # typecheck + 39 tests, no network
pnpm export:press        # regenerate creators/leo/press agent cards from cast.json
pnpm bootstrap:stripe    # test-mode catalog: $20/month price, compute meter, metered price
pnpm server              # local HTTP API on :8790
```

Environment for `server`: `STRIPE_SECRET_KEY` (sk_test_…), `STRIPE_WEBHOOK_SECRET` (whsec_…), `CREATORAPIS_ADMIN_TOKEN` (≥24 chars), `CREATORAPIS_FACTORY_SECRETS` (JSON map of factory id → HMAC secret), `CREATORAPIS_PUBLIC_URL`, `CREATORAPIS_PAYMENTS_STATE` (state file path, keep private). A live Stripe key is refused unless `CREATORAPIS_ALLOW_LIVE=1`.

**What is tested:** the settlement waterfall, Qi pricing and address checks, the full subscribe → sell → meter → settle → transfer → Qi export/confirm loop against a fake gateway with Stripe's real webhook signature verification, the HTTP surface, schema conformance of the contract examples and the committed creator content.

**What is not:** calls to Stripe's API (the build environment can't reach it; run `bootstrap:stripe` with a test key to check), Qi transfers on a network, production storage (state is one JSON file), multi-tenant auth.
