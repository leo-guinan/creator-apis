# Creators and factories

Stories live at the creator level. Operations live in the factory. Agents move between them.

| Lives in Creator APIs (this repo) | Lives in Internet Factories |
|---|---|
| Personas, casts, press corps setups (`creators/<id>/press/`) | The operations that make and use them: create reporter, press corps, voice, image, story |
| Story templates and approved story packages | Press conference lenses, grading, sealed press records |
| Who gets paid and how (payments, Qi rewards) | Runs, costs, energy readings, operation receipts |

The contracts between them are in [`/contracts`](../contracts/README.md): `agent-card@1`, `press-corps@1`, `story-template@1`, `operation-receipt@1`. Both repos hash with the same canonical JSON, so a card or receipt sealed in one verifies in the other; a cross-repo test in Internet Factories checks this.

## An agent's trip

```
creators/leo/press/cast.json  ──export──▶  agent-card@1 (custody: creator:leo)
        moveAgent → factory:presser         the factory imports it, runs create-voice; version +1, voice asset added
        moveAgent → creator:leo             custody shows the card changed in the factory
```

## A story's trip

```
factory: press conference → sealed press-record@1
factory: create-story(creator's story-template@1, record) → story-draft@1 (provenance back to the record)
creator: packageStory(draft) → story-package@1, pending approval until the manager consents
creator: approveStory → ready for a creative workflow (see extension-contract.md)
```

## Leo's press corps

`creators/leo/press/cast.json` is the source of truth, edited by hand. Persona text comes from the Press Corps Character Bible v1 in Clipping Lab. Voices reference Clipping Lab voice keys, plus Leo's first-ranked audition take per reporter, recorded by hash. Run `pnpm export:press` in `implementations/typescript` to regenerate the agent cards and `press-corps.json`; a test fails if they drift.

| Reporter | Title | Lens |
|---|---|---|
| Ari Chen | The Scorekeeper | scoreboard |
| Mara Quinn | The Film Analyst | film |
| Darius Cole | The Business Reporter | business |
| June Park | The Human Story | people |
| Nia Brooks | The Systems Reporter | reproducibility |
| Graham Pike | The Investigator | skeptic (may challenge anyone) |
