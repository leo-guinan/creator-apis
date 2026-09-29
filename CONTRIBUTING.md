# Contributing to Creator APIs

Creator APIs is the shared architecture for human-centered curiosity and downstream creation. Contributions should make the question-to-story flow easier to understand, implement, test, or extend while preserving provenance and human agency.

## License and contribution terms

The current original repository material is dedicated under CC0 1.0 Universal; attribution is not required. By submitting a contribution, you agree to dedicate the contribution under CC0 1.0 Universal to the extent possible under law, and confirm that you have the rights needed to do so. Do not submit third-party, private, or archive material unless the necessary rights and permissions are already cleared.

CC0 does not grant patent or trademark rights. Provenance and contributor rewards in deployed systems are separate from rights in this repository's architecture and code.

## What to propose

Useful early contributions include:

- clarifying the curiosity-session lifecycle;
- proposing portable branch, notebook, and provenance contracts;
- specifying source privacy, consent, attribution, or correction flows;
- adding independent creative workflow adapter proposals;
- providing fixture examples and falsifiers for contract behavior;
- describing how a workflow maps an approved story package into a movie-making step.

The core should stay small. Specialized movie tooling, model adapters, interfaces, and future patronage mechanisms belong behind stable extension seams rather than in the core engine by default.

## Proposal checklist

For an architecture change, explain:

1. The user problem and the part of the flow affected.
2. The proposed contract or extension point.
3. Which human contributions and source rights are involved.
4. What data the implementation must see, store, or emit.
5. How provenance and uncertainty are preserved.
6. What can fail and the observation that would falsify the proposal.
7. Whether model calls, spending, publication, or other external actions occur.
8. A small fixture or example another implementation can use to check compatibility.

Do not include private conversations, credentials, raw archive exports, or personal data in issues or pull requests. Do not imply a contributor endorses a path merely because their work is referenced. Make uncertainty and consent boundaries explicit.
