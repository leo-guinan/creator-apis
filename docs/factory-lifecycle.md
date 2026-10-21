# Factory lifecycle: sponsorship, mining of revenue, and graduation

**Status:** mostly built. The time-based Qi pool ([`operator-rewards.md`](operator-rewards.md)), cluster charters, cluster epochs, the lifecycle and graduations are implemented. Sponsorship splits and the token contract are still spec. See "Built vs not" at the end. Everything here builds on it. All numbers are placeholders to argue over, not decisions.

A new factory has a double problem: nobody trusts it, and it isn't producing enough to learn. This spec covers how a miner bootstraps a factory through that period, how a cluster of factories shares lumpy revenue the way a mining pool shares blocks, and how the network celebrates a factory coming of age, publicly and checkably, so others want to play and win.

The principle throughout: **relationships are the unit, and every relationship produces sealed, recomputable records.**

**Clusters are the unit of organization.** A cluster is a collection of miners and factories that governs itself through a charter (section 5). Every number in this spec is a *default* a cluster can change. The protocol fixes only the invariants that keep outcomes honest and comparable, so networks can structure themselves however they like and compete on results.

---

## 1. Lifecycle

A factory's phase is set by measurement, never by declaration or by the calendar.

| Phase | What's happening | Ends when |
|---|---|---|
| **Ignition** | High-volume attempts, most discarded. The factory is learning. | First Light |
| **Online** | It can produce accepted work; stability is rising | Steady State |
| **Production** | Stable, independently accepted output; revenue | Release criteria |
| **Mature** | Durable output and burn; funds new ignitions | — |

### Measuring learning

- **Attempts per keeper:** evaluated attempts ÷ independently accepted artifacts, per epoch. Its slope is the learning rate.
- **Proving set:** a fixed set of inputs the factory regenerates every epoch, kept out of normal work. **Stability** is the share of proving-set reruns that pass independent quality, multiplied by how much they agree with each other (the reproducibility lens, "same input, different outputs", made into a graduation test). Using the same inputs every epoch makes progress comparable across epochs.

An attempt only counts if it was evaluated and rejected with a recorded reason, on a distinct input, within a per-epoch cap. Stability only counts alongside independent acceptance and varied inputs, so a factory can't "stabilize" by producing the same trivial output every time.

---

## 2. Graduations: milestone blocks

| Milestone | Meaning | Criteria (placeholders) | Bounty |
|---|---|---|---|
| **First Light** | The factory comes online | Proving set registered; ≥ 10 independently accepted artifacts on distinct inputs; first press conference held with ≥ 50% documented answers | Small |
| **Steady State** | Stable output | Proving-set stability ≥ 0.85 for 3 consecutive epochs; attempts per keeper ≤ 2 | Large |
| **Lindy** | It lasts | Steady State maintained for 12 epochs | Medium |
| **Lineage** | It bootstraps another factory | A factory it sponsored reaches Steady State | Large, shared down the line |

Milestones are one-time **milestone blocks**. Each bounty is split by proportional splitting (section 5): the factory, its sponsoring miner, every contributor in proportion to their workshares, and a burn share executed at the ceremony.

First Light pays little and Steady State pays a lot. That way, creating factories just to collect First Light isn't worth it. A factory that reaches First Light and then dies costs its miner reputation.

---

## 3. Blocks by phase of life

Block cadence lengthens, and what's rewarded shifts, as a factory matures:

| Phase | Cadence | A block rewards | Paid from |
|---|---|---|---|
| Ignition | daily | **Effort:** evaluated attempts, as workshares | Sponsoring miner; cluster pot |
| Online | weekly | **Learning:** stability gains on the proving set; falling attempts per keeper | Cluster pot; early revenue |
| Production | weekly revenue blocks; monthly burn | **Revenue:** paid orders (finder + workshares) | Revenue set-aside |
| Mature | monthly / quarterly | **Durability:** sustained output and burn | Revenue; contributes to the pot that funds new ignitions |

Short, frequent, low-variance rewards keep a young factory alive while it learns. Long, larger blocks reward a mature factory for lasting. Mature factories fund the pot that bootstraps new ones.

---

## 4. Sponsorship: miners bootstrap factories

A miner stakes reputation on a factory and funnels energy into it, over-paying for early work so the factory survives long enough to learn. When the factory is steady, the miner keeps a smaller ongoing stake and moves on to bootstrap the next one. The miner's yield moves up a level: it keeps mining for Qi, but its returns come from a portfolio of graduated factories rather than from hashing alone.

### Flows

1. **Miner covers operating costs in Qi.** These are measured at the standard-time rate, not actual time, so the factory gains nothing by padding costs. During Ignition the miner also pays for evaluated attempts at a premium.
2. **Factory return.** A configurable share of fiat margin (placeholder: 20%) is converted to QUAI. The rest stays fiat with the creator. No margin means no return; that's the miner's risk.
3. **Three-way split of the return:** miner, factory and incinerator.

### The split moves over time

- **The miner's share tapers after payback.** It's large until the miner has recovered a set multiple (placeholder: 1.5×) of the Qi it put in, valued at the on-chain Qi↔QUAI rate when each payment was made. After that it steps down to a small ongoing share.
- **The burn grows as the factory gains energy.** Here energy means cumulative standard-seconds earned: `burn = min(max, base + k·log₂(cumulative standard hours))`.
- **The factory gets the rest.** Its share grows as the miner's tapers.

| Stage | Miner | Factory | Burn |
|---|---|---|---|
| Ignition / Online | 60% | 35% | 5% |
| After payback | 20% | 70% | 10% |
| Mature | 15% | 65% | 20% |

### Reputation stake

A factory borrows its miner's reputation, which solves its trust problem. Each miner builds a sealed portfolio record:
- factories bootstrapped;
- time to First Light and to Steady State;
- how many survived;
- how much each has burned since.

A failed or dishonest factory lands on its miner's record. Reputation is tied to a Qi address's history so it can't be thrown away and restarted. If the miner also holds a locked position in the cluster token (section 6), misconduct can burn that stake.

### Optional demand subsidy

A miner may subsidize customer prices during the ramp, so real jobs, which teach more than synthetic ones, flow in. This touches Stripe pricing and needs the legal review in section 9.

---

## 5. Clusters: mining of revenue

A **cluster** is a collection of miners and factories. It decides its own structure in a `cluster-charter@1` ([schema](../contracts/cluster-charter.v1.schema.json)):
- who can join and how;
- the epoch cadence for each phase;
- graduation criteria and bounties;
- sponsorship terms;
- the revenue-mining split;
- the reward curve;
- which quality sources count;
- its token and burn;
- how the charter itself changes.

Clusters then compete on outcomes. Miners and factories can leave for a better-run cluster, the way miners switch pools, which keeps charters honest.

### Fixed by the protocol (not configurable)

These keep outcomes trustworthy and comparable across clusters:

1. **Sealed, recomputable records.** Every epoch, milestone, sponsorship and split is sealed, chained, and deterministic from its inputs.
2. **No self-graded quality.** A charter can choose its quality sources, but `self` is never one of them.
3. **Each delivery counts once.** A factory may belong to several clusters, but an accepted delivery is attributed to exactly one.
4. **No retroactive changes.** Charter amendments take effect from a future epoch, never a past one.
5. **No negative payouts, nothing from nowhere.** Splits only divide what came in. Anything unpaid rolls over, and a declared burn is executed and its transaction recorded.
6. **Standard outcome metrics.** Every cluster publishes the same scoreboard, so clusters can be compared:
   - accepted outcomes per dollar of total work (the win condition from the deck);
   - time to First Light and to Steady State;
   - survival rate;
   - burn per epoch;
   - cost per accepted outcome.

### Configurable (charter defaults shown in this spec)

Everything else, including:
- membership and admission;
- exit notice;
- phase cadences;
- milestone thresholds and bounties;
- sponsorship return rate, payback multiple and split schedule;
- burn curve;
- set-aside, burn and finder shares;
- workshare window, tenure, caps and decay;
- reward curve constants;
- token and burn destination;
- amendment rules.

A cluster can be miner-led, run like a co-op, invite-only, open, or specialized in one kind of factory. The protocol doesn't care, as long as the invariants hold.

### Mining of revenue

Revenue is lumpy: which factory wins a customer is as unpredictable as who finds a block. A cluster pools that variance the way a mining pool does. It uses the mechanism from Quai's own research: Proportional Splitting splits each block height's reward among the block and its workshares in proportion to their work. Fiat revenue plays the role that the parent chain plays in SOAP.

| Mining | Factory cluster |
|---|---|
| Finding a block | Winning a paid customer order |
| Workshare | Accepted artifact meeting q₀, scored in standard-seconds |
| Difficulty | The standard t₀ for each kind of work |
| Pool operator | The cluster, as its charter defines it |
| SOAP buy-and-burn | Revenue set-aside buys the cluster token, burned at the ritual |

### Each epoch

1. Every win sets aside a share of its margin (placeholder: 20%).
2. A burn share comes off the top (placeholder: 20%).
3. Of each win's remainder, the **finder** keeps the majority (placeholder: 60%); the rest goes to the cluster pot.
4. The pot is split by workshares: standard-seconds of independently accepted work over a trailing window, PPLNS-style.

**Example:** A sells $1,000, C sells $300, B and D sell nothing; $260 is set aside.

| | Work share | Finder | Pot | Total |
|---|---|---|---|---|
| A | 40% | $96 | $33 | $129 |
| B (ramping) | 30% | — | $25 | $25 |
| C | 20% | $29 | $17 | $46 |
| D | 10% | — | $8 | $8 |
| Burned | | | | $52 |

B earns before it has won a customer. The cluster funds its ramp alongside its miner.

### Anti-gaming

- **Pool hopping:** trailing-window workshares and a minimum tenure before pot eligibility.
- **Workshare farming:** independent quality, a per-factory cap, and a threshold high enough that junk doesn't count.
- **Wash sales:** the finder bonus stays below the cost of faking a sale (Stripe fees plus burn). Implemented rule: a repeat customer earns a factory no second finder bonus in the same epoch; that set-aside goes entirely to the pot.
- **Free riders:** workshare weight decays after a long stretch with no wins, except during Ignition.

---

## 6. Tokens and layers

| Layer | Unit | Job |
|---|---|---|
| Energy | Qi | Operating costs; time to create |
| Commerce | fiat | Customers pay creators; creator margin |
| Routing | QUAI | Mining rewards; sponsorship returns; optional network-wide burn |
| Cluster | cluster token | A market on the cluster's future; bought and burned from revenue and mining |

**One token per cluster, not per factory.** That puts liquidity in one place and means the burn benefits everyone who worked in the cluster. Factory reputation stays off-token, in sealed records.

The token contract follows Quai Axe's guarantees:
- no owner;
- no pause;
- a fixed fee written into the contract;
- no withdrawal of burn funds;
- anyone can trigger a burn batch.

Each cluster's split schedule is fixed at launch. One audited template is deployed per cluster with only parameters changed, rather than custom contracts. Burns run in scheduled batches to limit price manipulation in thin pools.

Miners can direct hashpower to a cluster's mining contract, Quai Axe style. Part of each mined reward then funds the cluster's operations, part buys and burns the cluster token, and the rest goes back to the miner. Sponsorship becomes literally visible on-chain.

---

## 7. The ritual

Epochs close at the Monday press conference:

1. **Graduations open the show.** The press corps covers each factory's path, every number read from sealed records.
2. Last week's commitments are scored.
3. The cluster's epoch results go on screen: blocks, finders, workshares, pot.
4. **The burn executes on air** and its transaction hash is read out.

Every graduation also produces a story. A graduation story template turns the factory's sealed records into its origin story via `create-story`. That's content for the show and for recruiting: here's how this factory came online, with receipts.

**Leaderboards**, all from sealed records: fastest to First Light, fastest to Steady State, most burned, best bootstrapping miners, longest lineages.

The rule that keeps celebration honest: **every celebrated number is recomputable from sealed records.** Winners are worth copying because their wins can be checked.

---

## 8. Records

Each is sealed (sha256 of sorted-key JSON), chained to its predecessor, and deterministic from its inputs, like `press-record@1` and `reward-period@1`:

| Record | Per | Contains |
|---|---|---|
| `lifecycle-epoch@1` | factory × epoch | Attempts, accepted, attempts per keeper, proving-set results and stability, phase, any milestone reached |
| `sponsorship@1` | miner × factory × epoch | Qi paid (tx hashes), margin, return, conversion rate, split and why (payback progress, burn level), QUAI tx hashes; signed by both parties |
| `cluster-charter@1` | cluster × version | Members, every configurable parameter, amendment rules; each version effective from a stated epoch |
| `cluster-epoch@1` | cluster × epoch | Wins (blocks), finder shares, workshares by factory, pot split, burn amount and tx hash |
| `milestone@1` | factory × milestone | Criteria met, the evidence for each, bounty split, burn tx hash, story package id |
| `miner-portfolio@1` | miner | Running record of sponsorships, graduations, survivals, burns |

---

## 9. Risks

- **Securities law.** Revenue shares paid for capital, pooling revenue across businesses, and buying and burning a token with business revenue all look investment-like. Mining-funded burns (the Quai Axe pattern) are cleaner than revenue-funded ones. Get securities counsel before any real money or token moves.
- **Miner capture.** Cap sponsorships per miner, or slow the taper for miners with many sponsorships.
- **Price over signal.** Token price will swing on hype. Reputation, graduation and leaderboards use sealed records only, never price.
- **Contract risk.** One audited template; no owner; no upgradeability that could redirect burns.
- **Tax treatment** of Qi, QUAI and token flows isn't addressed here.

## 10. Open questions

1. **What counts as a block?** Paid orders only, or also milestones? This spec includes milestones as their own block type.
2. ~~Who forms clusters?~~ Settled: any collection of miners and factories, self-governed by a charter.
3. **Proving sets:** who selects them, and how are they kept from leaking into training?
4. **Where independent quality comes from:** customer acceptance, network evaluators, or press-conference documentation. Each needs an attestation format.
5. **Payback valuation:** Qi→QUAI rate at payment time versus at payback time.
6. **Burn destination:** a canonical unspendable QUAI address, or derive and publish one.

## Charter settings for the lifecycle

`lifecycle.maxAttemptsPerEpoch` caps the attempts that count. `lifecycle.minProvingCoverage` (default 0.8) is the share of the proving set that must be rerun for stability to be measured. `lifecycle.stabilityBasis` is `verdict` by default, meaning reruns agree on pass/fail, which suits generative work; `output_hash` requires identical outputs, for deterministic work. A member factory can name a `parentFactoryId`; the parent earns the Lineage bounty when the child reaches Steady State.

## Built vs not

| Piece | Status |
|---|---|
| Standards, speed curve, time-based Qi pool with sections, sealed periods | Built (`rewards.ts`) |
| Operation receipts with energy, press conferences, story drafts | Built (Internet Factories) |
| Lifecycle epochs: attempts that count, proving-set stability (verdict or output-hash agreement, coverage), phases with regression and recovery | Built (`lifecycle.ts`, `closeLifecycleEpoch`) |
| Graduations: First Light, Steady State, Lindy, Lineage; bounties split exactly between factory, sponsors, contributors (by workshare) and burn, paid in Qi | Built |
| Full epoch close, verified press records as evidence, lifecycle scoreboard metrics, ritual agenda | Built (`closeEpoch`, `/v1/clusters/:id/close`, `/agenda`) |
| Sponsorship records and splits | Not built |
| Cluster charter: schema and validator for the invariants | Built (`contracts/cluster-charter.v1.schema.json`, `validateClusterCharter`) |
| Cluster epochs: finder share, trailing-window workshares, tenure, no-win decay, per-factory cap, repeat-customer rule, rollover, burn, sealed chain | Built (`clusters.ts`, `closeClusterEpoch`) |
| Cluster set-aside at settlement, epoch payouts, burn confirmation | Built (service + `/v1/clusters` routes) |
| Cluster token contract | Not built; needs audit and legal review first |

Sources: [Proportional Splitting (Aumayr, Avarikioti, Karakostas, Kreder, Shastry)](https://arxiv.org/abs/2503.10185) · [SOAP press release](https://www.theblock.co/press-releases/376064/quai-network-launches-soap-to-reshape-proof-of-work-economics) · [Quai Axe](https://www.quaiaxe.com/)
