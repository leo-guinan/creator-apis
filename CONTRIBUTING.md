# Contributing to Creator APIs

Creator APIs is the shared architecture for human-centered curiosity and downstream creation. Contributions should make the question-to-story flow easier to understand, implement, test, or extend while preserving provenance and human agency.

## Current contribution boundary

This repository is public but currently unlicensed. Public visibility does not grant permission to reuse, adapt, or redistribute its contents. Until licensing and contributor terms are established, open issues and discuss proposals; do not submit code or other material intended for incorporation into a distributed implementation.

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
