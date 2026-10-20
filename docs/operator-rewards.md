# Operator rewards: energy in Qi, margin in fiat

**Status:** settlement math, Qi pricing, payout export and confirmation are implemented and tested. Qi is never sent by this service; payouts are exported for signing elsewhere. The energy-to-Qi rate is an open governance question (below).

A factory operator runs a creator's factory on their own hardware. The question this answers: *how much energy does it take to keep operating, and who pays for it?*

1. **Every operation reports its energy.** Factories emit `operation-receipt@1` with energy totalled by evidence class: `measured`, `provider_reported`, `estimated` (only with a declared method), and a count of steps with no reading. Nothing is converted silently; unknown energy earns nothing.
2. **Energy is paid in Qi.** Qi is Quai Network's energy-denominated token, so the cost of operating is settled in a unit that tracks energy rather than dollars.
3. **What's left is paid in fiat.** After fees, royalties and energy, the margin goes out through Stripe by the offer's shares. The operator can hold a share of margin as well as being reimbursed for energy.

```
operator energy (Wh, accepted evidence)  ×  quote.qiPerKwh / 1000   →  Qi owed (rounded down to 0.001 Qi)
Qi owed  ×  quote.usdPerQi                                          →  USD deducted from the sale before margin
```

If the sale can't cover the energy, the operator is paid what it can cover, and the rest is recorded as unfunded energy. That's the signal that this offer is priced below its operating cost.

## What we know about Qi, and what we don't

| Fact | Source |
|---|---|
| Qi has 3 decimal places | quais.js `formatQi`/`parseQi` (3 decimals) |
| Qi uses a UTXO ledger; Qi-ledger addresses have the high bit of the second byte set | qu.ai "What is QI"; quais.js `isQiAddress` |
| Qi issuance is linear in difficulty, so each Qi represents roughly constant energy | docs.qu.ai Qi emissions |
| QUAI↔Qi convert at market rate through a miner-disciplined controller | qu.ai "What is QI" |
| **There is no published fixed kWh-per-Qi peg** | none of the above names one |

So the rate is an explicit **energy quote**: `{ qiPerKwh, usdPerQi, source, observedAt }`. A quote must name its source and be under 24 hours old (configurable) to be used. Settlement refuses to guess.

## Open questions

1. **Who sets `qiPerKwh`?** Options: derive it from network difficulty and a reference hash rate per joule; take the market QUAI/Qi rate times a declared regional energy price; or make it a published governance parameter that changes on a schedule. Each one makes a different claim about what "energy" means. Until one is chosen, quotes are recorded manually with their source.
2. **Where does the Qi come from?** Settlement reserves the USD value (`qi:reserve`) and records the Qi owed (`qi:obligations`). Buying or mining that Qi and holding it is a treasury decision outside this service.
3. **How much should estimated energy count?** Today estimates with a declared method count fully. A stricter policy accepts only measured and provider-reported energy (`acceptEnergy` setting), which pays nothing until operators meter their hardware.
4. **Tax and regulatory treatment** of Qi payouts isn't addressed here. Get advice before paying anyone in Qi.

## Operator statement

`GET /v1/operators/operator:<id>/statement?from=…&to=…` reports, for the period:
- operations run, by hosting
- energy by evidence class, energy reimbursed, energy left unfunded
- Qi earned and still owed; fiat margin, provider reimbursements and fiat still owed
- energy cost as a share of revenue on the operator's orders, and completed operations per kWh

Those last two answer "how much energy do they keep operating with": lower energy share and more operations per kWh mean a more efficient factory.

## Paying out

1. `POST /v1/payouts/qi/export` returns a batch of `{to, amount, energyWh}` for every Qi payout with a Qi-ledger address on file. Others wait for an address.
2. Sign and send with your Quai wallet (the service holds no keys).
3. `POST /v1/payouts/<id>/confirm` with the transaction hash closes the obligation in the ledger.
