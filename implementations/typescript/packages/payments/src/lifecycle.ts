import { stableHash, type ClusterCharter } from "../../contracts/src/index.js";
import type { Phase } from "./clusters.js";
import { scoreDeliveries, type Delivery, type QualitySource, type Standard } from "./rewards.js";

/**
 * The factory lifecycle. Phase is set by measurement, never declared:
 *   ignition → (First Light) → online → (Steady State) → production → (Lindy) → mature
 * and a factory that loses stability for long enough regresses to online. Milestones are one-time blocks with a
 * bounty split between the factory, its sponsoring miners, its contributors (by workshare) and a burn.
 */

export interface ProvingSet { id: string; clusterId: string; factoryId: string; version: number; inputHashes: string[]; registeredAt: string; hash: string; }
export interface ProvingRun { id: string; factoryId: string; provingSetId: string; inputHash: string; outputHash: string; passed: boolean; qualitySource: QualitySource; at: string; }
/** A sealed press record, summarized. The hash was verified against the full record when it was recorded. */
export interface PressEvidence { recordId: string; recordHash: string; factoryId: string; documentedRate: number; heldAt: string; }

export type MilestoneKind = "first_light" | "steady_state" | "lindy" | "lineage";
export interface Milestone {
  schema: "milestone@1";
  id: string;
  kind: MilestoneKind;
  clusterId: string;
  factoryId: string;
  /** For lineage: the child factory whose Steady State earned it. */
  childFactoryId?: string;
  epochId: string;
  achievedAt: string;
  evidence: Record<string, unknown>;
  bounty: { qiBase: number; factory: { payeeId: string; qiBase: number }; sponsors: Array<{ payeeId: string; qiBase: number }>; contributors: Array<{ payeeId: string; qiBase: number; score: number }>; burnQiBase: number };
  hash: string;
}

export interface LifecycleEpoch {
  schema: "lifecycle-epoch@1";
  clusterId: string;
  charterVersion: number;
  factoryId: string;
  epoch: { id: string; start: string; end: string };
  phaseBefore: Phase;
  phaseAfter: Phase;
  events: string[];
  attempts: { evaluated: number; accepted: number; excluded: Array<{ id: string; reason: string }>; attemptsPerKeeper: number | null };
  cumulativeAcceptedInputs: number;
  proving: { setId: string | null; setVersion: number | null; inputs: number; runs: number; coverage: number; passRate: number | null; agreement: number | null; stability: number | null; basis: "verdict" | "output_hash"; note: string };
  streaks: { stableEpochs: number; unstableEpochs: number; lindyEpochs: number };
  press: { bestDocumentedRate: number | null; recordIds: string[] };
  milestones: string[];
  previousHash?: string;
  hash: string;
}

export interface LifecycleInput {
  charter: ClusterCharter;
  factoryId: string;
  epoch: { id: string; start: string; end: string };
  /** All of this factory's deliveries known so far (cumulative counts look back; attempts use this epoch's). */
  deliveries: Delivery[];
  provingSets: ProvingSet[];
  provingRuns: ProvingRun[];
  press: PressEvidence[];
  standards: Record<string, Standard>;
  /** This factory's earlier lifecycle epochs in this cluster, oldest first. */
  history?: LifecycleEpoch[];
  /** Milestones already awarded to this factory in this cluster (any epoch). */
  awarded?: MilestoneKind[];
}

const seal = <T extends object>(body: T): T & { hash: string } => { const clean = JSON.parse(JSON.stringify(body)) as T; return { ...clean, hash: stableHash(clean) }; };
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); const m = Math.floor(v.length / 2); return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const inputKey = (d: Delivery) => d.inputHash ?? `delivery:${d.id}`;

export function sealProvingSet(p: Omit<ProvingSet, "hash">): ProvingSet {
  if (!p.inputHashes.length || new Set(p.inputHashes).size !== p.inputHashes.length) throw new Error("a proving set needs distinct inputs");
  return seal(p);
}

export function closeLifecycleEpoch(input: LifecycleInput): { record: LifecycleEpoch; milestones: Milestone[] } {
  const { charter: c, factoryId, epoch } = input;
  const member = c.members.factories.find((f) => f.factoryId === factoryId);
  if (!member) throw new Error(`${factoryId} is not a member of ${c.id}`);
  const history = input.history ?? [];
  const last = history.at(-1);
  if (last && epoch.start <= last.epoch.end) throw new Error(`epoch ${epoch.id} overlaps ${last.epoch.id}`);
  const lc = c.lifecycle;
  const independent = (s: QualitySource) => c.quality.acceptedSources.includes(s);
  const inEpoch = (at: string) => at >= epoch.start && at <= epoch.end;
  const keeps = (d: Delivery) => d.accepted && independent(d.qualitySource) && d.quality >= c.quality.defaultQ0;

  // Attempts: what the factory tried this epoch, counted only if it taught something.
  const excluded: LifecycleEpoch["attempts"]["excluded"] = [];
  const seenRejected = new Set<string>();
  let evaluated = 0, accepted = 0;
  for (const d of input.deliveries.filter((x) => x.factoryId === factoryId && inEpoch(x.deliveredAt)).sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt) || a.id.localeCompare(b.id))) {
    if (lc.maxAttemptsPerEpoch && evaluated >= lc.maxAttemptsPerEpoch) { excluded.push({ id: d.id, reason: "over the per-epoch attempt cap" }); continue; }
    if (keeps(d)) { evaluated += 1; accepted += 1; continue; }
    if (d.accepted) { excluded.push({ id: d.id, reason: "accepted, but quality isn't independent or is below q0" }); continue; }
    if (!d.rejectionReason) { excluded.push({ id: d.id, reason: "rejected without a recorded reason" }); continue; }
    if (seenRejected.has(inputKey(d))) { excluded.push({ id: d.id, reason: "repeat rejection on the same input" }); continue; }
    seenRejected.add(inputKey(d));
    evaluated += 1;
  }
  const attemptsPerKeeper = accepted ? evaluated / accepted : null;
  const cumulativeAcceptedInputs = new Set(input.deliveries.filter((d) => d.factoryId === factoryId && d.deliveredAt <= epoch.end && keeps(d)).map(inputKey)).size;

  // Proving set: same inputs every epoch, so stability is comparable.
  const set = [...input.provingSets].filter((s) => s.factoryId === factoryId && s.clusterId === c.id && s.registeredAt <= epoch.end).sort((a, b) => a.version - b.version).at(-1);
  const basis = lc.stabilityBasis ?? "verdict";
  let proving: LifecycleEpoch["proving"] = { setId: null, setVersion: null, inputs: 0, runs: 0, coverage: 0, passRate: null, agreement: null, stability: null, basis, note: "no proving set registered" };
  if (set) {
    const inSet = new Set(set.inputHashes);
    const runs = input.provingRuns.filter((r) => r.provingSetId === set.id && inSet.has(r.inputHash) && inEpoch(r.at) && independent(r.qualitySource));
    const byInput = new Map<string, ProvingRun[]>();
    for (const r of runs) byInput.set(r.inputHash, [...(byInput.get(r.inputHash) ?? []), r]);
    const coverage = byInput.size / set.inputHashes.length;
    const passRate = runs.length ? runs.filter((r) => r.passed).length / runs.length : null;
    const agreements = [...byInput.values()].filter((rs) => rs.length >= 2).map((rs) => { const counts = new Map<string, number>(); for (const r of rs) { const k = basis === "verdict" ? String(r.passed) : r.outputHash; counts.set(k, (counts.get(k) ?? 0) + 1); } return Math.max(...counts.values()) / rs.length; });
    const agreement = agreements.length ? agreements.reduce((t, x) => t + x, 0) / agreements.length : null;
    const minCoverage = lc.minProvingCoverage ?? 0.8;
    const note = coverage < minCoverage ? `proving run covered ${(coverage * 100).toFixed(0)}% of the set; ${(minCoverage * 100).toFixed(0)}% needed` : agreement === null ? "need at least two reruns of some inputs to measure agreement" : "measured";
    proving = { setId: set.id, setVersion: set.version, inputs: set.inputHashes.length, runs: runs.length, coverage, passRate, agreement, stability: note === "measured" && passRate !== null && agreement !== null ? passRate * agreement : null, basis, note };
  }

  const sameSet = last?.proving.setId === proving.setId;
  const stable = proving.stability !== null && proving.stability >= lc.steadyState.minStability;
  const streaks = { stableEpochs: stable ? (sameSet ? (last?.streaks.stableEpochs ?? 0) : 0) + 1 : 0, unstableEpochs: stable ? 0 : (last?.streaks.unstableEpochs ?? 0) + 1, lindyEpochs: 0 };
  const pressSoFar = input.press.filter((p) => p.factoryId === factoryId && p.heldAt <= epoch.end);
  const bestDocumentedRate = pressSoFar.length ? Math.max(...pressSoFar.map((p) => p.documentedRate)) : null;

  // Phase transitions.
  const awarded = new Set(input.awarded ?? []);
  const phaseBefore: Phase = last?.phaseAfter ?? "ignition";
  let phaseAfter: Phase = phaseBefore;
  const events: string[] = [];
  const reached: MilestoneKind[] = [];
  if (phaseBefore === "ignition") {
    const ok = !!set && set.registeredAt <= epoch.end && cumulativeAcceptedInputs >= lc.firstLight.minAccepted && (bestDocumentedRate ?? -1) >= lc.firstLight.minDocumentedRate;
    if (ok) { phaseAfter = "online"; events.push("first light: the factory is online"); if (!awarded.has("first_light")) reached.push("first_light"); }
  } else if (phaseBefore === "online") {
    if (streaks.stableEpochs >= lc.steadyState.consecutiveEpochs && attemptsPerKeeper !== null && attemptsPerKeeper <= lc.steadyState.maxAttemptsPerKeeper) {
      phaseAfter = "production";
      if (!awarded.has("steady_state")) { reached.push("steady_state"); events.push("steady state: stable output"); } else events.push("recovered steady state");
    }
  } else {
    if (streaks.unstableEpochs >= lc.steadyState.consecutiveEpochs) { phaseAfter = "online"; events.push(`regressed: ${streaks.unstableEpochs} epochs without stable output`); }
    else {
      streaks.lindyEpochs = stable ? (last?.streaks.lindyEpochs ?? 0) + 1 : last?.streaks.lindyEpochs ?? 0;
      if (phaseBefore === "production" && streaks.lindyEpochs >= lc.lindy.epochs && !awarded.has("lindy")) { phaseAfter = "mature"; reached.push("lindy"); events.push(`lindy: stable for ${streaks.lindyEpochs} epochs`); }
    }
  }

  const evidence = { cumulativeAcceptedInputs, provingSetHash: set?.hash, stability: proving.stability, stableEpochs: streaks.stableEpochs, attemptsPerKeeper, bestDocumentedRate, pressRecordIds: pressSoFar.map((p) => p.recordId), lindyEpochs: streaks.lindyEpochs };
  const milestones: Milestone[] = reached.map((kind) => buildMilestone(kind, c, factoryId, epoch, input, evidence));
  if (reached.includes("steady_state") && member.parentFactoryId) milestones.push(buildMilestone("lineage", c, member.parentFactoryId, epoch, input, { ...evidence, childFactoryId: factoryId }, factoryId));

  const record = seal<Omit<LifecycleEpoch, "hash">>({
    schema: "lifecycle-epoch@1", clusterId: c.id, charterVersion: c.version, factoryId, epoch, phaseBefore, phaseAfter, events,
    attempts: { evaluated, accepted, excluded, attemptsPerKeeper }, cumulativeAcceptedInputs, proving, streaks,
    press: { bestDocumentedRate, recordIds: pressSoFar.map((p) => p.recordId) }, milestones: milestones.map((m) => m.id), previousHash: last?.hash
  });
  return { record, milestones };
}

/** Splits a milestone bounty: factory, sponsoring miners (equally), contributors (by standard-seconds of accepted work), burn. Exact to the base unit. */
function buildMilestone(kind: MilestoneKind, c: ClusterCharter, factoryId: string, epoch: { id: string; end: string }, input: LifecycleInput, evidence: Record<string, unknown>, childFactoryId?: string): Milestone {
  const bounty = kind === "first_light" ? c.lifecycle.firstLight.bountyQiBase : kind === "steady_state" ? c.lifecycle.steadyState.bountyQiBase : kind === "lindy" ? c.lifecycle.lindy.bountyQiBase : c.lifecycle.lineage.bountyQiBase;
  const split = c.lifecycle.bountySplit;
  const subject = c.members.factories.find((f) => f.factoryId === (childFactoryId ?? factoryId))!;
  const recipient = c.members.factories.find((f) => f.factoryId === factoryId)!;
  const workFactory = childFactoryId ?? factoryId;
  const scored = scoreDeliveries(input.deliveries.filter((d) => d.factoryId === workFactory && d.deliveredAt <= epoch.end), input.deliveries, input.standards, { beta: c.rewardsCurve.beta, floor: c.rewardsCurve.floor, cap: c.rewardsCurve.cap, acceptedQualitySources: c.quality.acceptedSources, reuseRoyaltyFraction: 0.25 });
  const byOperator = new Map<string, number>();
  for (const s of scored) if (s.score > 0) byOperator.set(s.creditedTo, (byOperator.get(s.creditedTo) ?? 0) + s.score);
  const part = (b: number) => Math.floor((bounty * b) / 10_000);
  let factoryShare = part(split.factoryBps), sponsorPot = part(split.sponsorBps), contributorPot = part(split.contributorsBps);
  if (!subject.sponsors.length) { contributorPot += sponsorPot; sponsorPot = 0; }
  if (!byOperator.size) { factoryShare += contributorPot; contributorPot = 0; }
  const sponsors = subject.sponsors.map((id) => ({ payeeId: id, qiBase: Math.floor(sponsorPot / subject.sponsors.length) }));
  const total = [...byOperator.values()].reduce((t, x) => t + x, 0);
  const contributors = [...byOperator].sort(([a], [b]) => a.localeCompare(b)).map(([payeeId, score]) => ({ payeeId, score, qiBase: Math.floor((contributorPot * score) / total) }));
  const paid = factoryShare + sponsors.reduce((t, s) => t + s.qiBase, 0) + contributors.reduce((t, s) => t + s.qiBase, 0);
  const body = { schema: "milestone@1" as const, id: `ms_${c.id}_${factoryId}_${kind}${childFactoryId ? `_${childFactoryId}` : ""}`, kind, clusterId: c.id, factoryId, childFactoryId, epochId: epoch.id, achievedAt: epoch.end, evidence, bounty: { qiBase: bounty, factory: { payeeId: `creator:${recipient.creatorId}`, qiBase: factoryShare }, sponsors, contributors, burnQiBase: bounty - paid } };
  return seal(body);
}

/** Cluster-level lifecycle metrics for the standard scoreboard. */
export function lifecycleMetrics(histories: LifecycleEpoch[][], milestones: Milestone[]): { timeToFirstLightDays: number | null; timeToSteadyStateDays: number | null; survivalRate: number | null } {
  const days = (kind: MilestoneKind) => histories.flatMap((h) => { const m = milestones.find((x) => x.kind === kind && x.factoryId === h[0]?.factoryId && !x.childFactoryId); return m && h[0] ? [Math.round(((Date.parse(m.achievedAt) - Date.parse(h[0].epoch.start)) / 86_400_000) * 100) / 100] : []; });
  const fl = days("first_light"), ss = days("steady_state");
  const reachedSteady = histories.filter((h) => milestones.some((m) => m.kind === "steady_state" && m.factoryId === h[0]?.factoryId && !m.childFactoryId));
  return { timeToFirstLightDays: fl.length ? median(fl) : null, timeToSteadyStateDays: ss.length ? median(ss) : null, survivalRate: reachedSteady.length ? reachedSteady.filter((h) => ["production", "mature"].includes(h.at(-1)!.phaseAfter)).length / reachedSteady.length : null };
}

export const lifecycleEpochHashValid = (r: LifecycleEpoch) => { const { hash, ...rest } = r; return stableHash(rest) === hash; };
export const milestoneHashValid = (m: Milestone) => { const { hash, ...rest } = m; return stableHash(rest) === hash; };
