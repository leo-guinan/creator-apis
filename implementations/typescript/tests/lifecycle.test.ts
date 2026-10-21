import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { stableHash, type ClusterCharter } from "../packages/contracts/src/index.js";
import { closeLifecycleEpoch, computeStandards, CreatorPayments, defaultRewardConfig, FakeGateway, lifecycleEpochHashValid, lifecycleMetrics, milestoneHashValid, sealProvingSet, Store, type Delivery, type LifecycleEpoch, type Milestone, type MilestoneKind, type PressEvidence, type ProvingRun } from "../packages/payments/src/index.js";

const repo = resolve(process.cwd(), "../..");
const example = JSON.parse(readFileSync(join(repo, "contracts/examples/cluster-charter.example.json"), "utf8")) as ClusterCharter;
const charter: ClusterCharter = {
  ...example, id: "lc", effectiveFrom: "2026-09-01T00:00:00.000Z",
  members: { miners: [{ id: "miner:rig" }], factories: [{ factoryId: "a", creatorId: "ana", sponsors: ["miner:rig"] }, { factoryId: "b", creatorId: "bo", sponsors: [], parentFactoryId: "a" }] },
  lifecycle: { ...example.lifecycle, firstLight: { minAccepted: 3, minDocumentedRate: 0.5, bountyQiBase: 10_000 }, steadyState: { minStability: 0.85, consecutiveEpochs: 2, maxAttemptsPerKeeper: 2, bountyQiBase: 100_000 }, lindy: { epochs: 2, bountyQiBase: 50_000 }, lineage: { bountyQiBase: 40_000 }, maxAttemptsPerEpoch: 50, minProvingCoverage: 0.75, stabilityBasis: "verdict" },
  revenueMining: { ...example.revenueMining, minTenureEpochs: 0 }
};
const standards = computeStandards([], {}, defaultRewardConfig({ declaredStandards: { "create-voice": 60 } }));
const day = (i: number) => new Date(Date.parse("2026-09-07T00:00:00.000Z") + i * 86_400_000).toISOString();
const E = (i: number) => ({ id: `e${i}`, start: day(7 * i), end: new Date(Date.parse(day(7 * i + 7)) - 1).toISOString() });
const mid = (i: number) => day(7 * i + 3);
let n = 0;
const d = (factoryId: string, i: number, over: Partial<Delivery> = {}): Delivery => { const k = ++n; return { id: `d${k}`, factoryId, operatorPayeeId: `operator:${factoryId}`, operation: "create-voice", inputHash: `in${k}`, submittedAt: mid(i), deliveredAt: new Date(Date.parse(mid(i)) + 60_000).toISOString(), accepted: true, quality: 0.9, qualitySource: "customer", ...over }; };
const set = (factoryId: string, version = 1, inputs = ["p1", "p2", "p3", "p4"]) => sealProvingSet({ id: `ps_${factoryId}_v${version}`, clusterId: "lc", factoryId, version, inputHashes: inputs, registeredAt: day(0) });
const runs = (factoryId: string, i: number, passes: boolean[][], setId = `ps_${factoryId}_v1`): ProvingRun[] => passes.flatMap((perInput, j) => perInput.map((passed, r) => ({ id: `pr_${factoryId}_${i}_${j}_${r}`, factoryId, provingSetId: setId, inputHash: `p${j + 1}`, outputHash: `o${j}${r}`, passed, qualitySource: "network_evaluator" as const, at: mid(i) })));
const allPass = [[true, true], [true, true], [true, true], [true, true]];
const press = (factoryId: string, i: number, rate: number): PressEvidence => ({ recordId: `prs_${factoryId}_${i}`, recordHash: "a".repeat(64), factoryId, documentedRate: rate, heldAt: mid(i) });

/** Runs a factory through epochs, carrying history and awarded milestones like the service does. */
function run(factoryId: string, epochs: Array<{ deliveries: Delivery[]; runs: ProvingRun[]; press?: PressEvidence[]; sets?: ReturnType<typeof set>[] }>, extraDeliveries: Delivery[] = []) {
  const history: LifecycleEpoch[] = []; const milestones: Milestone[] = []; let deliveries: Delivery[] = [...extraDeliveries]; let pressSoFar: PressEvidence[] = []; let sets = [set(factoryId)];
  epochs.forEach((e, i) => {
    deliveries = [...deliveries, ...e.deliveries]; pressSoFar = [...pressSoFar, ...(e.press ?? [])]; if (e.sets) sets = e.sets;
    const out = closeLifecycleEpoch({ charter, factoryId, epoch: E(i), deliveries, provingSets: sets, provingRuns: e.runs, press: pressSoFar, standards, history: [...history], awarded: milestones.filter((m) => !m.childFactoryId && m.factoryId === factoryId).map((m) => m.kind) });
    history.push(out.record); milestones.push(...out.milestones);
  });
  return { history, milestones };
}

test("attempts count only when they teach: reasons required, repeats and self-grading excluded", () => {
  const ds = [d("a", 0), d("a", 0), d("a", 0, { accepted: false, rejectionReason: "off-voice", inputHash: "x" }), d("a", 0, { accepted: false, rejectionReason: "again", inputHash: "x" }), d("a", 0, { accepted: false }), d("a", 0, { qualitySource: "self" })];
  const { record } = closeLifecycleEpoch({ charter, factoryId: "a", epoch: E(0), deliveries: ds, provingSets: [], provingRuns: [], press: [], standards });
  assert.deepEqual([record.attempts.evaluated, record.attempts.accepted, record.attempts.attemptsPerKeeper], [3, 2, 1.5]);
  assert.deepEqual(record.attempts.excluded.map((x) => x.reason).sort(), ["accepted, but quality isn't independent or is below q0", "rejected without a recorded reason", "repeat rejection on the same input"]);
});

test("stability on the proving set: pass rate × agreement, measured only with enough coverage and reruns", () => {
  const close = (r: ProvingRun[], basis: "verdict" | "output_hash" = "verdict") => closeLifecycleEpoch({ charter: { ...charter, lifecycle: { ...charter.lifecycle, stabilityBasis: basis } }, factoryId: "a", epoch: E(0), deliveries: [], provingSets: [set("a")], provingRuns: r, press: [], standards }).record.proving;
  const mixed = close(runs("a", 0, [[true, true], [true, false], [true, true], [false, false]]));
  assert.deepEqual([mixed.passRate, mixed.agreement, mixed.stability], [5 / 8, 0.875, (5 / 8) * 0.875]);
  assert.match(close(runs("a", 0, [[true, true], [true, true]])).note, /covered 50%/);
  assert.match(close(runs("a", 0, [[true], [true], [true], [true]])).note, /two reruns/);
  assert.equal(close(runs("a", 0, allPass), "output_hash").agreement, 0.5, "different outputs disagree on output_hash basis");
});

test("the full path: ignition → First Light → Steady State → Lindy, with bounties split exactly", () => {
  const work = (i: number) => [d("a", i), d("a", i), d("a", i), d("a", i, { accepted: false, rejectionReason: "pacing" })];
  const { history, milestones } = run("a", [
    { deliveries: work(0), runs: runs("a", 0, allPass) },
    { deliveries: work(1), runs: runs("a", 1, allPass), press: [press("a", 1, 0.6)] },
    { deliveries: work(2), runs: runs("a", 2, allPass) },
    { deliveries: work(3), runs: runs("a", 3, allPass) },
    { deliveries: work(4), runs: runs("a", 4, allPass) }
  ]);
  assert.deepEqual(history.map((h) => [h.phaseBefore, h.phaseAfter]), [["ignition", "ignition"], ["ignition", "online"], ["online", "production"], ["production", "production"], ["production", "mature"]]);
  assert.equal(history[0].events.length, 0, "no press conference yet, so no First Light");
  assert.deepEqual(milestones.map((m) => [m.kind, m.epochId]), [["first_light", "e1"], ["steady_state", "e2"], ["lindy", "e4"]]);
  for (const m of milestones) {
    const b = m.bounty;
    assert.equal(b.factory.qiBase + b.sponsors.reduce((t, s) => t + s.qiBase, 0) + b.contributors.reduce((t, s) => t + s.qiBase, 0) + b.burnQiBase, b.qiBase, `${m.kind} splits exactly`);
    assert.ok(milestoneHashValid(m));
  }
  const ss = milestones.find((m) => m.kind === "steady_state")!;
  assert.deepEqual([ss.bounty.factory.payeeId, ss.bounty.sponsors[0].payeeId, ss.bounty.contributors[0].payeeId], ["creator:ana", "miner:rig", "operator:a"]);
  assert.ok(history.every(lifecycleEpochHashValid));
  assert.equal(history[3].previousHash, history[2].hash);
});

test("a sponsored child reaching Steady State earns its parent the Lineage bounty", () => {
  const work = (i: number) => [d("b", i), d("b", i), d("b", i)];
  const { milestones } = run("b", [
    { deliveries: work(0), runs: runs("b", 0, allPass), press: [press("b", 0, 0.9)], sets: [set("b")] },
    { deliveries: work(1), runs: runs("b", 1, allPass) }
  ]);
  const lineage = milestones.find((m) => m.kind === "lineage")!;
  assert.deepEqual([lineage.factoryId, lineage.childFactoryId, lineage.bounty.factory.payeeId], ["a", "b", "creator:ana"]);
  assert.equal(lineage.bounty.sponsors.length, 0, "b has no sponsors: their share goes to b's contributors");
  assert.equal(lineage.bounty.contributors[0].payeeId, "operator:b");
});

test("losing stability regresses a factory; recovering doesn't pay the bounty twice; a new proving set resets the streak", () => {
  const work = (i: number) => [d("a", i), d("a", i), d("a", i)];
  const shaky = [[true, false], [false, true], [true, false], [false, true]];
  const { history, milestones } = run("a", [
    { deliveries: work(0), runs: runs("a", 0, allPass), press: [press("a", 0, 0.6)] },
    { deliveries: work(1), runs: runs("a", 1, allPass) },
    { deliveries: work(2), runs: runs("a", 2, shaky) },
    { deliveries: work(3), runs: runs("a", 3, shaky) },
    { deliveries: work(4), runs: runs("a", 4, allPass) },
    { deliveries: work(5), runs: runs("a", 5, allPass) }
  ]);
  assert.deepEqual(history.map((h) => h.phaseAfter), ["online", "production", "production", "online", "online", "production"]);
  assert.match(history[3].events[0], /regressed/);
  assert.equal(history[5].events[0], "recovered steady state");
  assert.equal(milestones.filter((m) => m.kind === "steady_state").length, 1);
  const reset = run("a", [
    { deliveries: work(0), runs: runs("a", 0, allPass), press: [press("a", 0, 0.6)] },
    { deliveries: work(1), runs: runs("a", 1, allPass, "ps_a_v2"), sets: [set("a"), set("a", 2)] }
  ]);
  assert.equal(reset.history[1].streaks.stableEpochs, 1, "a new proving set version starts the streak over");
});

test("lifecycle metrics: median days to First Light and Steady State, survival", () => {
  const h = (f: string, phase: LifecycleEpoch["phaseAfter"]) => [{ factoryId: f, epoch: E(0), phaseAfter: phase } as LifecycleEpoch];
  const ms = (f: string, kind: MilestoneKind, i: number) => ({ factoryId: f, kind, achievedAt: E(i).end } as Milestone);
  const m = lifecycleMetrics([h("a", "production"), h("b", "online")], [ms("a", "first_light", 1), ms("a", "steady_state", 3), ms("b", "first_light", 3), ms("b", "steady_state", 4)]);
  assert.equal(m.timeToFirstLightDays, (14 + 28) / 2);
  assert.equal(m.survivalRate, 0.5, "b reached Steady State but regressed");
});

test("service: the full epoch close pays graduations in Qi, feeds phases to the cluster, and builds the ritual agenda", async () => {
  const gateway = new FakeGateway();
  const store = new Store();
  let now = new Date("2026-09-10T00:00:00.000Z");
  const payments = new CreatorPayments(gateway, store, { publicUrl: "https://x.test", rewards: defaultRewardConfig({ declaredStandards: { "create-voice": 60 } }), now: () => now });
  for (const id of ["creator:ana", "creator:bo", "miner:rig", "operator:a", "operator:b"]) await payments.registerPayee({ id, kind: id.split(":")[0] as "creator", displayName: id, email: "x@example.com", qiAddress: "0x0080000000000000000000000000000000000001" });
  payments.registerCharter(charter);
  const ps = payments.registerProvingSet("lc", "a", ["p1", "p2", "p3", "p4"]);
  assert.throws(() => payments.registerProvingSet("lc", "zz", ["p1"]), /not a member/);
  for (const r of runs("a", 0, allPass, ps.id)) payments.recordProvingRun(r);
  assert.throws(() => payments.recordProvingRun({ ...runs("a", 0, allPass, ps.id)[0], id: "bad", inputHash: "nope" }), /not in the proving set/);
  for (const x of [d("a", 0), d("a", 0), d("a", 0)]) payments.recordDelivery(x);
  const body = { schema: "press-record@1", id: "prs_1", factoryId: "a", heldAt: mid(0), summary: { documentedRate: 0.75 } };
  payments.recordPressRecord({ ...body, hash: stableHash(body) });
  assert.throws(() => payments.recordPressRecord({ ...body, summary: { documentedRate: 1 }, hash: stableHash(body) }), /hash does not match/);

  now = new Date("2026-09-20T00:00:00.000Z");
  const out = payments.closeEpoch("lc", E(0));
  assert.deepEqual(out.milestones.map((m) => [m.kind, m.factoryId]), [["first_light", "a"]]);
  assert.equal(out.clusterEpoch.workshares.find((w) => w.factoryId === "a")!.epochScore, 180);
  assert.deepEqual(out.lifecycle.map((r) => [r.factoryId, r.phaseAfter]), [["a", "online"], ["b", "ignition"]]);
  assert.equal(out.clusterEpoch.scoreboard.timeToFirstLightDays, 7);
  assert.equal(payments.closeEpoch("lc", E(0)).clusterEpoch, out.clusterEpoch, "closing again returns the same records");

  const agenda = payments.ritualAgenda("lc", "e0");
  assert.deepEqual(agenda.beats.map((b) => b.beat), ["graduation", "scoreboard", "results", "burn"]);
  const batch = payments.exportQiBatch();
  assert.ok(batch.payouts.some((p) => p.payeeId === "miner:rig"), "the sponsoring miner is paid its share of the graduation in Qi");
  payments.confirmMilestoneBurn(out.milestones[0].id, `0x${"ef".repeat(32)}`);
  assert.equal(store.balance("qi:burn_reserve", "qi_base"), 0);
  for (const e of store.state.journal) assert.equal(e.postings.filter((p) => p.currency === "qi_base").reduce((t, p) => t + p.amount, 0), 0, e.id);
});
