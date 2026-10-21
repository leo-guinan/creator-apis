# Operator rewards: Qi for time, from a pool

**Status:** implemented and tested in `implementations/typescript/packages/payments/src/rewards.ts`. Qi is never sent by this service. Payouts are exported for signing elsewhere and confirmed by transaction hash. The pool's size, sections and the curve's constants are configuration, set by whoever runs the network.

At the human level, time and energy can be equated. So factory operators are rewarded in Qi, Quai's energy-denominated token, for the **time it takes to create**, normalized against a standard and paid from a **pool** each period. Fiat stays the currency of sales: customers pay creators, and the margin goes out through Stripe.

## The standard

Every kind of artifact (operation × size band) has a standard: quality **q₀** and time **t₀**.

- **t₀** is the median time of last period's deliveries that were accepted, met q₀, and were judged by a source the operator doesn't control. With too few samples, the previous standard carries forward. A brand-new operation starts from a declared standard.
- The standard is recomputed every period, like mining difficulty. When the network gets faster, last period's speed becomes this period's baseline.
- Standards for the next period are published when a period closes, so operators know the curve before they do the work.

## The curve

A delivery that meets q₀ scores **t₀ × m(s)** standard seconds, where **s = t₀ / t** is its speedup:

```
m(s) = 1 + β · log₂(s), clamped to [floor, cap]        defaults: β = 0.25, floor 0.5, cap 1.75
```

| Time vs standard | Multiplier |
|---|---|
| 2× slower | 0.75 |
| at standard | 1.00 |
| 2× faster | 1.25 |
| 4× faster | 1.50 |
| 8×+ faster | 1.75 (cap) |

Same quality in less time earns more per artifact. And because a faster operator also completes more artifacts per period, the reward per hour of work rises faster than the multiplier alone.

Scores are zero when:
- the delivery wasn't accepted;
- quality came from the operator's own evaluator (`self`);
- quality was below q₀;
- or there's no standard yet for that kind of work.

A delivery served from earlier work (`reuseOf`) gets no speed bonus. Instead it credits a **reuse royalty** (25% of t₀ by default) to whoever made the original.

## Time is measured by the platform

A speed bonus makes under-reporting time profitable, so time comes from the platform's own boundary: when the job came in and when the accepted artifact came back. A delivery is recorded with `POST /v1/deliveries`, an admin route for the platform's own observations. The factory's receipt is linked as evidence but never sets the time.

## The pool

Each period has a Qi budget:

```
pool = min(max, base + perActiveFactory × active factories)
```

A factory counts as active only if it earned at least a minimum score in the period. So the pool grows with the network of factories that are actually delivering, up to a cap you raise as the network proves itself.

**Sections** split the pool by need, each with a share in basis points. For example:

| Section | Share | Matches |
|---|---|---|
| Voices | 30% | `create-voice` |
| Stories | 50% | `create-story` |
| Everything else | 20% | (catch-all) |

A delivery belongs to the first section that matches its operation. Within a section, Qi is paid in proportion to score. An optional per-operator cap stops one operator from taking a whole section. Whatever a section doesn't pay out, including rounding remainders, budget an empty section never used, and amounts over the cap, rolls into the same section next period. Nothing is created or lost.

## Held to account

A closed period is a sealed `reward-period@1` record. It contains:
- the config;
- the standards used and the next standards;
- the pool and each section's budget, rollover and payout;
- every delivery's time, standard, speedup, multiplier, score and the reason for any zero;
- the payouts.

It's hashed and chained to the previous period. Closing is deterministic, so any operator can recompute their pay from the same inputs, and a delivery can't be added to a period after it closes.

## Next: lifecycle, sponsorship and clusters

The pool is the base layer. [`factory-lifecycle.md`](factory-lifecycle.md) specifies what builds on it: miners sponsoring factories through a measured lifecycle, clusters sharing revenue the way mining pools share blocks, and graduation milestones celebrated at the press conference.

## Per-sale energy, still available

`qiFrom: "sale"` restores the earlier model, where measured operating energy is deducted from each sale at an energy quote and paid in Qi. The default is `"pool"`: sales don't deduct energy, and energy readings stay in the operator statement as evidence of efficiency.

## What we know about Qi

| Fact | Source |
|---|---|
| Qi has 3 decimal places (amounts here are integers of 0.001 Qi) | quais.js `formatQi`/`parseQi` |
| Qi uses a UTXO ledger; Qi-ledger addresses have the high bit of the second byte set | qu.ai "What is QI"; quais.js `isQiAddress` |
| Qi issuance is linear in difficulty, so each Qi represents roughly constant energy | docs.qu.ai Qi emissions |

## Open questions

1. **Pool funding.** The pool is an obligation recorded in the ledger (`qi:obligations`). Acquiring or mining the Qi, and holding it, is a treasury decision outside this service.
2. **Starting numbers.** The base, per-factory growth, cap, section shares and β are placeholders. A conservative start: a small base, sections only for the operations that exist, β = 0.25.
3. **Independent quality.** The q₀ gate is only as good as its quality sources. Today those are customer acceptance, a network evaluator, or documented answers at a press conference. How each is attested still needs defining.
4. **Sybil factories.** Pool growth per active factory invites fake factories. The minimum active score and independent quality checks are the current defence. A stake or identity requirement may be needed.
5. **Tax and regulatory treatment** of Qi payouts isn't addressed here.
