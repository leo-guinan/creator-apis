# Extension Contract: From Story Package to Creative Workflow

**Status:** draft boundary for implementations and proposals; no canonical JSON schema has been frozen.

Creator APIs owns the question-to-notebook-to-story path. Specialized workflows should plug in after the user approves a story package, rather than reimplementing the curiosity engine. Movie generation is the first motivating example, not the only permitted extension.

## Boundary

```text
Creator APIs core
  approved StoryPackage + explicit user request
          |
          v
versioned CreativeWorkflow adapter
          |
          v
outline / script / storyboard / film / other artifact + receipts
```

The adapter must not receive raw private source material by default. The handoff contains only the approved material and references needed for the specific workflow. A source reference is not authorization to fetch or reuse the source; rights and consent status travel explicitly.

## Draft input

A conforming request should carry, at minimum:

- `request_id`: stable id for retries and readback;
- `contract_version`: version of the handoff contract;
- `workflow_id` and `workflow_version`;
- `story_package_id` and content hash;
- `user_intent`: requested artifact and constraints;
- `source_provenance`: references and permitted attribution metadata;
- `rights_status`: known permissions, unknowns, and any required clearances;
- `consent_status`: explicit status per included contribution;
- `privacy_policy`: disclosure boundary for inputs and outputs;
- `external_actions_allowed`: explicit boolean; false by default;
- `budget` and `deadline`: optional, with units and currency explicit.

A workflow must refuse or return `needs_clearance` when required rights, consent, or provenance are missing. It may not turn unknown into permission.

## Draft output

A conforming response should include:

- request and workflow IDs/versions;
- state: `accepted`, `rejected`, `needs_clearance`, `running`, `partial`, `succeeded`, or `failed`;
- artifact references and content hashes for outputs actually produced;
- an output-to-input provenance map where feasible;
- contributors and attribution requirements, distinguished from inferred influence;
- model/provider details only when actually used;
- measured cost, currency, and evidence source, or `unknown`;
- timestamps and retry/idempotency status;
- errors, unresolved rights, and limitations;
- external actions actually taken, separately from actions requested.

A generated script is not a finished movie. A submitted generation request is not an accepted or paid artifact. A cost estimate is not a charge. Keep these states distinct.

## Conformance and contribution seams

Implementations may independently provide:

- story-to-outline or story-to-script transformation;
- storyboard and production planning;
- image, audio, or video generation orchestration;
- human review and revision workflows;
- rights and provenance tooling;
- a later patron unlock or auction adapter.

Each implementation should include:

1. A mapping from the common request to its own input contract.
2. A mapping from its actual result to the common response.
3. Fixtures for success, partial result, failure, missing rights/consent, and retry.
4. A privacy and external-side-effect statement.
5. A falsifier: a concrete observation that would show the adapter is not preserving the contract.
6. Receipts distinguishing provider acceptance, artifact creation, public availability, payment, and readback.

The auction adapter is deliberately outside the initial core contract. Before it is implemented, define what is being auctioned, who holds the rights, what the patron receives, how proceeds are settled, and how contributor rewards are calculated and verified. Do not infer those terms from the provenance graph alone.

## Open questions for the architecture

These are intentionally unresolved until implementers and users test the core flow:

- What is the minimal portable representation of a branch and its provenance?
- Which source identifiers can be exposed without violating privacy or consent?
- How should a story package express mixed or disputed rights?
- Which outcomes should be measured first, and which can be observed without retaining question text?
- What does a user need to review before a story may leave the Notebook for production?
