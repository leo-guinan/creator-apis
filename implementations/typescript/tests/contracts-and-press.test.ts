import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { cardHash, receiptHashValid, validateAgentCard, validatePressCorpsCard, validateReceipt, validateStoryTemplate, type AgentCard, type OperationReceipt, type PressCorpsCard, type StoryDraft } from "../packages/contracts/src/index.js";
import { approveStory, loadCast, loadStoryTemplate, packageStory, pressCorpsFromCast } from "../packages/press/src/index.js";

const repo = resolve(process.cwd(), "../..");
const read = <T>(p: string) => JSON.parse(readFileSync(join(repo, p), "utf8")) as T;
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
(addFormats as unknown as (a: unknown) => void)(ajv);
for (const f of readdirSync(join(repo, "contracts")).filter((f) => f.endsWith(".schema.json"))) ajv.addSchema(read(`contracts/${f}`));
const check = (schemaId: string, value: unknown) => { const v = ajv.getSchema(`https://github.com/leo-guinan/creator-apis/contracts/${schemaId}`)!; const ok = v(value); return ok ? [] : (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`); };

test("examples and creator content validate against the JSON Schemas and the TypeScript validators", () => {
  const agent = read<AgentCard>("contracts/examples/agent-card.example.json");
  assert.deepEqual(check("agent-card.v1.schema.json", agent), []);
  assert.deepEqual(validateAgentCard(agent), []);
  const corps = read<PressCorpsCard>("creators/leo/press/press-corps.json");
  assert.deepEqual(check("press-corps.v1.schema.json", corps), []);
  assert.deepEqual(validatePressCorpsCard(corps), []);
  const template = read("creators/leo/press/story-templates/presser-episode.json");
  assert.deepEqual(check("story-template.v1.schema.json", template), []);
  assert.deepEqual(validateStoryTemplate(template as never), []);
  const receipt = read<OperationReceipt>("contracts/examples/operation-receipt.example.json");
  assert.deepEqual(check("operation-receipt.v1.schema.json", receipt), []);
  assert.deepEqual(validateReceipt(receipt), []);
});

test("schemas and validators both reject a reporter without a press block", () => {
  const agent = read<AgentCard>("contracts/examples/agent-card.example.json");
  const bad = { ...agent, press: undefined };
  assert.ok(check("agent-card.v1.schema.json", JSON.parse(JSON.stringify(bad))).length > 0);
  assert.ok(validateAgentCard(bad).some((e) => /press block/.test(e)));
});

test("receipt hashes are checked: any edit breaks them", () => {
  const receipt = read<OperationReceipt>("contracts/examples/operation-receipt.example.json");
  assert.ok(receiptHashValid(receipt));
  assert.match(validateReceipt({ ...receipt, energy: { ...receipt.energy, providerReportedWh: 40 } }).join(";"), /does not match/);
});

test("committed agent cards are exactly what the cast generates (no drift)", () => {
  const generated = pressCorpsFromCast(loadCast(join(repo, "creators/leo/press/cast.json")));
  assert.deepEqual(read("creators/leo/press/press-corps.json"), generated);
  for (const card of generated.reporters) {
    assert.deepEqual(read(`creators/leo/press/agents/${card.id}.agent.json`), card);
    assert.equal(card.custody[0].location, "creator:leo");
    assert.equal(card.custody[0].cardSha256, cardHash(card));
  }
});

test("the cast follows the bible: each beat maps to its lens, Graham can challenge anyone, voices are the first-ranked takes", () => {
  const corps = read<PressCorpsCard>("creators/leo/press/press-corps.json");
  const by = Object.fromEntries(corps.reporters.map((r) => [r.id, r]));
  assert.deepEqual(Object.fromEntries(corps.reporters.map((r) => [r.name, r.press!.lens])), { "Ari Chen": "scoreboard", "Mara Quinn": "film", "Darius Cole": "business", "June Park": "people", "Nia Brooks": "reproducibility", "Graham Pike": "skeptic" });
  assert.equal(by["graham-pike"].press!.rights.challengesOthers, true);
  assert.deepEqual(corps.reporters.map((r) => [r.id, r.assets!.voices![0].providerRef]), [["ari-chen", "audition_ari_fc6717c2928b"], ["mara-quinn", "audition_mara_1f944b4971a9"], ["darius-cole", "audition_darius_778711766bd6"], ["june-park", "audition_june_c47258af308d"], ["nia-brooks", "audition_nia_a688b66882fc"], ["graham-pike", "audition_graham_9375b9a83668"]]);
  assert.ok(corps.reporters.every((r) => r.voiceProfiles?.[0].provider === "clipping-lab"));
  assert.deepEqual(corps.beats.map((b) => b.id), ["open", "score", "tough", "film", "plan", "final"]);
});

const draft: StoryDraft = { schema: "story-draft@1", templateId: "presser-episode", templateVersion: 1, source: { schema: "press-record@1", id: "prs_x", hash: "b".repeat(64), factoryId: "f" }, title: "T", logline: "L", scenes: [{ id: "cold-open", title: "Cold open", moments: [{ kind: "exchange", ref: "exchange:q1", speaker: "Graham Pike", line: "Why should we believe you?", reply: "Trust me.", status: "undocumented", why: "no evidence" }] }], provenance: ["exchange:q1"] };

test("stories live with the creator: a package can't be approved until the manager consents", () => {
  const template = loadStoryTemplate(join(repo, "creators/leo/press/story-templates/presser-episode.json"));
  assert.equal(template.id, draft.templateId);
  const pending = packageStory(draft, { creatorId: "leo", managerId: "leo", fictionBoundary: "fictional reporters" });
  assert.equal(pending.rights.manager.consent, "unknown");
  assert.throws(() => approveStory(pending, "leo"), /has not consented/);
  const consented = packageStory(draft, { creatorId: "leo", managerId: "leo", fictionBoundary: "fictional reporters", managerConsent: "granted" });
  assert.throws(() => approveStory(consented, "someone-else"), /only the creator/);
  assert.throws(() => approveStory({ ...consented, draft: { ...draft, title: "edited" } }, "leo"), /draft changed/);
  assert.equal(approveStory(consented, "leo", "2026-10-20T00:00:00.000Z").status, "approved");
  assert.ok(packageStory({ ...draft, provenance: [] }, { creatorId: "leo", managerId: "leo", fictionBoundary: "x", managerConsent: "granted" }).unresolved.some((u) => /not in the draft's provenance/.test(u)));
});

test("cluster charters: everything configurable, invariants enforced", async () => {
  const { validateClusterCharter, validateCharterAmendment } = await import("../packages/contracts/src/index.js");
  const charter = read<import("../packages/contracts/src/index.js").ClusterCharter>("contracts/examples/cluster-charter.example.json");
  assert.deepEqual(check("cluster-charter.v1.schema.json", charter), []);
  assert.deepEqual(validateClusterCharter(charter), []);
  // A very different structure is fine: open, miner-free, no sponsorship burn, daily everything.
  const coop = { ...charter, id: "open-coop", members: { miners: [], factories: [{ factoryId: "f1", creatorId: "ana", sponsors: [] }] }, admission: { mode: "open" as const }, epochs: { ignition: "P1D", online: "P1D", production: "P1D", mature: "P1D" }, revenueMining: { ...charter.revenueMining, finderBps: 2000, burnBps: 0 } };
  assert.deepEqual(check("cluster-charter.v1.schema.json", coop), []);
  assert.deepEqual(validateClusterCharter(coop), []);
  // Invariants can't be configured away.
  assert.match(validateClusterCharter({ ...charter, quality: { ...charter.quality, acceptedSources: ["self"] } }).join(), /self-graded/);
  assert.match(validateClusterCharter({ ...charter, lifecycle: { ...charter.lifecycle, bountySplit: { factoryBps: 9000, sponsorBps: 2500, contributorsBps: 0, burnBps: 0 } } }).join(), /bounty split/);
  assert.match(validateClusterCharter({ ...charter, sponsorship: { ...charter.sponsorship, stages: { ...charter.sponsorship.stages, mature: { name: "m", minerBps: 5000, factoryBps: 5000, burnBps: 500 } } } }).join(), /stage mature/);
  assert.match(validateClusterCharter({ ...charter, amendments: { approvalBps: 5000, effectiveAfterEpochs: 0 } }).join(), /retroactively/);
  assert.match(validateClusterCharter({ ...charter, members: { ...charter.members, factories: [{ factoryId: "x", creatorId: "y", sponsors: ["miner:ghost"] }] } }).join(), /not a member miner/);
  // Amendments chain to the previous version and only take effect later.
  const { stableHash } = await import("../packages/contracts/src/index.js");
  const v2 = { ...charter, version: 2, previousVersionHash: stableHash(charter), effectiveFrom: "2026-11-02T00:00:00.000Z", revenueMining: { ...charter.revenueMining, finderBps: 5000 } };
  assert.deepEqual(validateCharterAmendment(charter, v2), []);
  assert.match(validateCharterAmendment(charter, { ...v2, effectiveFrom: "2026-10-01T00:00:00.000Z" }).join(), /after the version it replaces/);
  assert.match(validateCharterAmendment(charter, { ...v2, previousVersionHash: "0".repeat(64) }).join(), /hash of the previous version/);
});
