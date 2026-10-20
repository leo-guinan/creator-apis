# Contracts

Language-neutral JSON Schemas (draft 2020-12) for what moves between Creator APIs and factories. CC0, like the rest of the repository.

| Schema | What it is |
|---|---|
| [`agent-card.v1`](agent-card.v1.schema.json) | A portable agent (e.g. a reporter) with persona, press lens and rights, voices, and a custody trail |
| [`press-corps.v1`](press-corps.v1.schema.json) | A creator's reporters plus the run of show |
| [`story-template.v1`](story-template.v1.schema.json) | How a creator turns a sealed press record into a story draft |
| [`operation-receipt.v1`](operation-receipt.v1.schema.json) | What a factory operation did, cost and used in energy; decides how it gets paid |

**Hashing.** Hashes are sha256 over sorted-key JSON with undefined fields dropped (`canonicalize` in `implementations/typescript/packages/contracts`). A card's `cardSha256` excludes its `custody`; a receipt's `sha256` covers every other field.

**Examples** in [`examples/`](examples) validate against the schemas in the TypeScript test suite.
