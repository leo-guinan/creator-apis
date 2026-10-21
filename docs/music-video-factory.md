# Music video factory: the first commission pool

The first pilot is a music video factory with a small pool of miners who commission videos and pay in Qi. Its job is to measure one thing in public: **how fast the Qi price of an acceptable music video falls as the factory gains skill.**

## Starting point

| | Value | Source |
| --- | --- | --- |
| Baseline (n = 1) | ALL GREEN: 2,304 slop.cc credits for 2:24 (143.6 s), about $64 | Presser recap ledger: 1,160 first cut + 1,144 fixes |
| Tool price | $30 per 1,080 credits | 2026-10-20 purchase; the 1,800-credit pack is assumed to be the same rate |
| Next video (n = 2) | 1,440 credits, $40, at the same length | Prior learning rate 0.625 (64 → 40) |
| Process target | Fixes at most 25% of the first cut | Presser commitment. ALL GREEN's fixes were 99% |

The pool is in [`creators/leo/factories/music-video/commission-pool.json`](../creators/leo/factories/music-video/commission-pool.json). It has no miners yet. Add them with `POST /v1/commission-pools`, which accepts new miners and changed caps but not a changed price basis.

## How a commission runs

1. **Quote:** a miner in the pool asks for a video of a given length. The factory quotes the projected credits for that length, converted to USD, then to Qi at the latest sourced Qi quote, rounded up. The quote is valid for 24 hours. Each miner has a cap on open commissions.
2. **Pay:** the miner sends Qi to the factory, and we record the tx hash. Payment must be at least the quote, and a tx can pay only one commission. The Qi is held against the commission. Nothing checks the tx on-chain yet.
3. **Deliver:** the factory reports first-cut credits, fix credits, finished seconds and the render, plus operation receipts if it has them.
4. **Verdict:** the miner accepts with a quality score (0 to 1), or rejects with a reason. Accepting moves the Qi to the factory's earnings. Rejecting refunds the pool's refund share (100% by default) and the refund is confirmed by tx. Either way, the verdict is recorded as a customer-scored delivery, so it counts toward rewards and lifecycle milestones.

Pricing is a fixed quote. The factory keeps what it saves under its own projection and absorbs any overrun, so the incentive is to beat the curve.

## What gets measured

`GET /v1/commission-pools/music-video-pilot/learning` returns a sealed report with one row per accepted video, baseline first:

- **Credits per finished second:** the skill measure. Tool prices and Qi prices don't touch it.
- **Qi per finished second:** what miners actually paid.
- **Under-run:** credits quoted minus credits used.
- **Fix ratio:** fix credits as a share of first-cut credits, checked against the 25% target.
- **Change from the previous video**, split into three causes that add up to the total: skill (credits/s), tool price (USD per credit), and Qi price (USD per Qi). If Qi gets cheaper in dollars, miners pay more Qi for the same work. The report shows that as a Qi-price effect, not as the factory getting worse.

The curve is Wright's law (cost per finished second = c₁·n⁻ᵇ). Until three accepted points exist (baseline included), quotes use the prior rate of 0.625. After that, the curve is a least-squares fit, with the slope clamped so one outlier can't produce a wild quote. Rejected videos are listed in the notes and never become points on the curve.

## Open questions

- Who are the first miners, and what cap does each get?
- Whose Qi quote is the reference (exchange, oracle, a fixed pilot rate)?
- Should a refund be 100%, or should the miner share the cost of a rejected attempt?
- On-chain verification of payment and refund txs.
