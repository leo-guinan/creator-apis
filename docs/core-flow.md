# Core Flow: Question to Story

**Status:** architecture draft; not a deployed-system claim.

The core of Creator APIs is the curiosity journey. The implementation should make a user's exploration durable, forkable, attributable, and useful to downstream creation—without forcing every step through a model call.

## Lifecycle

```text
Question -> Context search -> Paths -> Explore/branch -> Notebook -> Story package
```

### 1. Open a curiosity session

The user supplies a question and chooses any relevant scope or privacy boundary. The session records its creator, creation time, visibility, and consent settings. A question is a starting point, not permission to publish it or use it commercially.

### 2. Search human context first

The curiosity engine searches authorized human sources and prior network knowledge before deciding whether additional model computation is useful. Search results must preserve source identity at the permitted level, provenance, recency where known, and limitations. If there is no useful human context, return that gap honestly; do not invent a human source to make the network look complete.

### 3. Offer multiple paths

Return several possible paths through perspectives, sources, contradictions, adjacent questions, and unresolved gaps. A path is a suggestion for exploration, not an expert verdict or an endorsement by the person whose work appears in it. Keep observed source content separate from generated interpretation.

### 4. Let the user steer and branch

The user can follow a path, ask a follow-up, compare perspectives, save a note, or branch the exploration. Preserve the relationship between a branch and the earlier question/path so another person can understand how the notebook developed. Ignored paths and failed searches may become useful aggregate learning signals, subject to privacy settings.

### 5. Build a notebook

A notebook gathers the question, branches, notes, source references, interpretations, disagreements, and unresolved items. It should be possible to share or continue a notebook only under explicit visibility and consent choices. Private source material does not become public merely because it informed an answer.

### 6. Shape a story package

When the user chooses to make something from the exploration, create a reviewable story package. It should retain links from narrative claims to contributing notes and permitted sources; mark uncertain or inferred claims; and identify people whose contributions need attribution or permission. The user approves the package before it crosses into a downstream production workflow.

### 7. Hand off to creative workflows

A movie workflow consumes an approved story package through the extension contract in [`extension-contract.md`](extension-contract.md). It can create an outline, script, storyboard, film, or other artifact. The movie workflow is independently implemented and versioned; it must return provenance, status, costs where measured, and the artifacts it actually produced.

### 8. Defer patronage and auctions

Patron unlocks and auctions are later economic mechanisms. Do not make an auction a dependency of the initial curiosity loop. Before enabling one, define the rights to the story and resulting film, the patron's actual entitlement, contributor consent, fee/tax/refund treatment, settlement, and the rules that return value through the provenance graph.

## Conceptual records

These are draft concepts, not a frozen schema:

- **CuriositySession:** initial question, owner, visibility/consent policy, lifecycle state.
- **Path:** a user-steerable direction, including its rationale, source references, and uncertainty.
- **ExplorationEvent:** a user or system action such as proposing, choosing, expanding, comparing, or setting aside a path.
- **NotebookItem:** a note, source, question, interpretation, contradiction, or gap, with provenance and visibility.
- **StoryPackage:** user-approved narrative inputs and provenance links, plus rights/consent status and unresolved issues.
- **CreationHandoff:** versioned request to an independent creative workflow and its returned status/artifact receipts.
- **LearningReceipt:** minimal evidence about source usefulness, branch choices, unresolved gaps, or model invocation; never a hidden claim of quality or a payout calculation.

Implementations should version contracts and preserve unknown values. Missing source consent, unknown provenance, or an unmeasured outcome must not be silently converted into permission, attribution, or success.

## Core invariants

1. Human knowledge is searched before unnecessary model computation; this is a system goal to measure, not an excuse to promise cost savings.
2. The user controls the exploration path and approves the story handoff.
3. Source, interpretation, and generated content remain distinguishable.
4. Provenance is carried forward through branches, notebooks, stories, and creation handoffs.
5. Retrieval is not endorsement, authorship, consent, or proof of usefulness.
6. No private source is published or used commercially without authorization.
7. Learning signals are privacy-bounded and are not compensation weights by default.
8. Movie workflows and patronage/auction mechanisms are extensions; neither defines the core curiosity protocol.
