# Creator APIs

> **Reward people, not models.**

Creator APIs is the infrastructure layer for human-centered AI workflows. It puts a curiosity engine between a person's question and additional model computation: first look for what people already know, then help the user explore, and call a frontier model when it adds value.

The underlying principle is economic as well as technical. Models are downstream of human activity: language, research, experience, interpretation, and culture. Models can help transform that activity, but they are not its origin. We believe the maximum share of the value created should accrue to the humans whose contributions made it possible.

## One system, two layers

- **Creator APIs — infrastructure:** human-context discovery, branching exploration, model routing, learning signals, provenance, and eventually value flow back to contributors.
- **Enchanted Notebook — experience:** a person starts with a question and follows paths until the exploration becomes a story worth making.

Enchanted Notebook is the first product intended to make Creator APIs tangible. It should feel like curiosity becoming an adventure, not like another model picker. Creator APIs powers the experience and remains available as infrastructure for other products and agents.

## The core flow

```text
Question
  -> Curiosity Engine
  -> Human Knowledge Graph
  -> Relevant perspectives and possible paths
  -> User-led branching exploration
  -> Notebook that preserves sources, choices, and connections
  -> Story package ready for a creative workflow
  -> (extension) Movie workflow
  -> (later) Patron unlock or auction
  -> (later) Provenance-based value flowing back through the network
```

The engine should surface multiple promising perspectives—including disagreement and gaps—rather than pretend there is always one authoritative answer. Exploration stays user-steered. Frontier model calls are optional and downstream of the human-context search.

## From curiosity to a movie

A notebook can remain an exploration, be shared so others can continue it, or be shaped into a narrative. A movie is a further compression of what the community discovered—not the only valuable outcome.

Movie creation is an extension seam, not a prerequisite for the curiosity engine. The core architecture must give independent contributors a clear, provenance-preserving handoff so they can build story-to-film workflows without reimplementing question capture, branching exploration, notebook state, or source attribution.

Patronage comes later. A public movie unlock or auction could let someone fund a story's next step; the provenance graph could then support rewards flowing back to the people whose work helped create value. Auctions, prices, payouts, and film-financing demand are future hypotheses—not capabilities or economics claimed by this repository.

## What belongs here

This is the shared architecture and protocol home—not the Enchanted Notebook application and not a catalog of every specialized workflow. It should define:

1. The curiosity-session lifecycle and branching exploration model.
2. Common provenance and contribution records.
3. Stable, versioned contracts between the engine, user experiences, models, and downstream creation workflows.
4. Extension points and conformance examples so different teams can implement compatible search, story, and movie workflows.
5. Evidence and privacy requirements for learning signals and future value flows.

See:

- [`docs/core-flow.md`](docs/core-flow.md) — the end-to-end question-to-story flow and its states.
- [`docs/extension-contract.md`](docs/extension-contract.md) — the draft handoff boundary for downstream creative workflows, including movies.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to propose architecture and implementations.

## Architecture status

This repository begins as a public architecture draft. The documents describe the intended system and seams; they do not assert that a complete knowledge graph, production curiosity engine, OpenAI-compatible endpoint, movie workflow, auction, or reward-settlement system is currently deployed. Each implementation must report what is tested, what is live, and what remains unknown.

## Reuse and contribution status

The repository's current original architecture, specifications, examples, and documentation are dedicated to the public domain under **CC0 1.0 Universal**. Reuse, modification, and commercial application do not require attribution. The value is not ownership of the architecture; it is in deploying and applying it to build trust systems in the world.

The product itself should still preserve provenance for human work used in real deployments so value can be directed to contributors. That is a property of the running system and its agreements, not a restriction on reusing this code or architecture. CC0 does not grant patent or trademark rights or clear rights held by third parties. See [`LICENSE`](LICENSE) and the [full CC0 legal code](https://creativecommons.org/publicdomain/zero/1.0/legalcode).
