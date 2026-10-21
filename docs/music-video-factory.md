# Music video factory: the first commission pool

The first pilot is a music video factory with a small pool of miners who commission videos and pay in Qi. Its job is to measure one thing in public: **how fast the Qi price of an acceptable music video falls as the factory gains skill.**

## Starting point

| | Value | Source |
| --- | --- | --- |
| Baseline (n = 1) | ALL GREEN: 2,304 slop.cc credits for 2:24 (143.6 s), about $64 | Presser recap ledger: 1,160 first cut + 1,144 fixes |
| Tool price | $30 per 1,080 credits | 2026-10-20 purchase; the 1,800-credit pack is assumed to be the same rate |
| Next video (n = 2) | 1,440 credits, $40, at the same length | Prior learning rate 0.625 (64 → 40) |
| Process target | Fixes at most 25% of the first cut | Presser commitment. ALL GREEN's fixes were 99% |
| Pricing | Stake: actual cost + 10% of the projected cost, rest returned or burned | Pool setting `pricing: "stake"` |

The pool is in [`creators/leo/factories/music-video/commission-pool.json`](../creators/leo/factories/music-video/commission-pool.json). It has no miners yet. Add them with `POST /v1/commission-pools`, which accepts new miners and changed caps but not a changed price basis.

## How a commission runs

1. **Quote:** a miner in the pool asks for a video of a given length. The factory projects the credits for that length, converts them to USD, then to Qi at the latest sourced Qi quote, rounded up. The minimum stake is that projected cost plus the 10% margin. The quote is valid for 24 hours. Each miner has a cap on open commissions.
2. **Stake:** the miner sends at least the minimum stake (more is fine, since it's a ceiling) and says whether unused stake comes **back** or is **burned**. We record the tx hash, and a tx can fund only one commission. The Qi is held against the commission. Nothing checks the tx on-chain yet.
3. **Deliver:** the factory reports first-cut credits, fix credits, finished seconds and the render, plus operation receipts if it has them.
4. **Verdict:** the miner accepts with a quality score (0 to 1), or rejects with a reason. The verdict is recorded as a customer-scored delivery, so it counts toward rewards and lifecycle milestones. Then the stake settles:

| | Factory takes | Rest of the stake |
| --- | --- | --- |
| Accepted | actual cost + 10% of the **projected** cost | returned, or burned, as the miner chose |
| Rejected (reason required) | actual cost, no margin | returned, or burned |
| Cost + margin is more than the stake | the whole stake; the factory absorbs the shortfall | nothing |

Actual cost is the credits used, at the tool price and the Qi rate locked at quote time, so the miner carries no Qi price risk while the job runs. Returns and burns are confirmed by tx (`/refund`, `/burn`).

**Why the margin is on the projection, not the actual cost.** With 10% of actual cost, every improvement would cut the factory's profit on that video, which pays it to stay slow. With 10% of the projection, beating the curve lowers what the miner pays without touching the margin. The margin still falls over time, because the projection falls as accepted videos come in. That's the deflation miners are funding. `marginBasis: "actual"` is available if you want the plain version.

**Float.** Open stakes are Qi committed to work that hasn't had a verdict. The report shows it as `float` (open commissions and Qi held). It's demand the factory can plan its learning around. It is not money the factory can spend or lend: it belongs to the miner until the verdict.

The older fixed-quote mode is still there (`pricing: "fixed_quote"`): the miner pays the projection, and the factory keeps savings and absorbs overruns.

## What gets measured

`GET /v1/commission-pools/music-video-pilot/learning` returns a sealed report with one row per accepted video, baseline first:

- **Credits per finished second:** the skill measure. Tool prices and Qi prices don't touch it.
- **Qi per finished second:** what miners actually paid. Under a stake that's actual cost + margin, so it tracks skill directly.
- **Margin, float, and stake totals:** staked, charged, margin, returned, burned, shortfall.
- **Under-run:** credits quoted minus credits used.
- **Fix ratio:** fix credits as a share of first-cut credits, checked against the 25% target.
- **Change in cost from the previous video**, split into three causes that add up to the total: skill (credits/s), tool price (USD per credit), and Qi price (USD per Qi). If Qi gets cheaper in dollars, miners pay more Qi for the same work. The report shows that as a Qi-price effect, not as the factory getting worse.

The curve is Wright's law (cost per finished second = c₁·n⁻ᵇ). Until three accepted points exist (baseline included), quotes use the prior rate of 0.625. After that, the curve is a least-squares fit, with the slope clamped so one outlier can't produce a wild quote. Rejected videos are listed in the notes and never become points on the curve.

## Open questions

- Who are the first miners, and what cap does each get?
- Whose Qi quote is the reference (exchange, oracle, a fixed pilot rate)?
- Where does a burn go: Qi converted to QUAI and burned, a burn address, or the factory token once it exists? The ledger records the burn tx either way.
- Custody: holding miners' stakes and returning the remainder is custody of their funds. This needs legal review before anyone outside the pilot stakes.
- On-chain verification of payment and refund txs.
