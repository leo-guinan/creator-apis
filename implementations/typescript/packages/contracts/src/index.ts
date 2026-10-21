import { createHash } from "node:crypto";

/**
 * Shared contracts between Creator APIs (content, payments) and Internet Factories (operations).
 * The language-neutral JSON Schemas live in /contracts at the repository root; these types mirror them.
 * Hashing is byte-for-byte the same as the Internet Factories runtime (sorted-key JSON, sha256), so a
 * receipt sealed in a factory verifies here.
 */

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
/** sha256 of the JSON-normalized value (undefined fields dropped), matching how factories seal records and receipts. */
export const stableHash = (value: unknown) => createHash("sha256").update(canonicalize(value === undefined ? null : JSON.parse(JSON.stringify(value)))).digest("hex");

// ---------------------------------------------------------------- agents and press

export type LensId = "scoreboard" | "film" | "business" | "people" | "reproducibility" | "skeptic";
export const LENSES: LensId[] = ["scoreboard", "film", "business", "people", "reproducibility", "skeptic"];
export interface ReporterRights { mayChallenge: boolean; challengesOthers?: boolean; refusesUnevidencedWins?: boolean; }
export interface CustodyHop { location: string; at: string; by: string; reason?: string; cardSha256: string; }
export interface AssetRef { id: string; kind: "voice" | "image"; provider: string; providerRef?: string; uri: string; sha256: string; mime: string; createdAt: string; receiptId?: string; note?: string; }
export interface VoiceProfile { provider: string; key: string; note?: string; }

export interface AgentCard {
  schema: "agent-card@1";
  id: string;
  version: number;
  name: string;
  title?: string;
  role: string;
  persona: { summary: string; theoryOfWinning?: string; voiceDirection?: string; backstory?: string; questioningStyle?: string; beat?: string; signatureQuestion?: string };
  press?: { lens: LensId; rights: ReporterRights; maxFollowups?: number; questionsPerBeat?: number; color?: string };
  voiceProfiles?: VoiceProfile[];
  assets?: { voices?: AssetRef[]; images?: AssetRef[] };
  origin: { creatorId: string; createdAt: string; source?: string };
  custody: CustodyHop[];
}

export type BeatKind = "statement" | "questions" | "commitments" | "final";
export interface BeatSpec { id: string; name: string; kind: BeatKind; minutes: number; reporters: string[]; defaultShot?: string; }
export interface PressCorpsCard { schema: "press-corps@1"; id: string; version: number; name: string; creatorId: string; reporters: AgentCard[]; beats: BeatSpec[]; }

export type AnswerStatus = "documented" | "partial" | "undocumented" | "contradicted" | "declined";
export interface StoryScene { id: string; title: string; from: "statement" | "scoreboard" | "beat" | "commitments"; beatId?: string; pick: "all" | "highlights"; max?: number; }
export interface StoryTemplate { schema: "story-template@1"; id: string; version: number; creatorId: string; source: "press-record@1"; title: string; logline: string; scenes: StoryScene[]; highlightOrder: AnswerStatus[]; }
export interface StoryMoment { kind: "statement" | "exchange" | "scoreboard" | "commitment"; ref: string; speaker?: string; line: string; reply?: string; status?: string; why: string; }
export interface StoryDraft { schema: "story-draft@1"; templateId: string; templateVersion: number; source: { schema: "press-record@1"; id: string; hash: string; factoryId: string }; title: string; logline: string; scenes: Array<{ id: string; title: string; moments: StoryMoment[] }>; provenance: string[]; }

// ---------------------------------------------------------------- operations and energy

export type EnergySource = "measured" | "provider_reported" | "estimated" | "unknown";
export interface EnergyTotals { measuredWh: number; providerReportedWh: number; estimatedWh: number; unknownSteps: number; methods: string[]; }
export type Hosting = "platform" | "operator" | "provider";
export interface OperationReceipt {
  schema: "operation-receipt@1";
  id: string;
  operation: string;
  factoryId: string;
  runId: string;
  status: "completed" | "failed" | "rejected";
  operatorId: string;
  creatorId?: string;
  orderRef?: string;
  artifact?: { id: string; sha256: string; schema: string };
  costUsd: number;
  energy: EnergyTotals;
  hosting: Hosting;
  startedAt: string;
  finishedAt: string;
  sha256: string;
}

export function receiptHashValid(receipt: OperationReceipt): boolean { const { sha256, ...rest } = receipt; return stableHash(rest) === sha256; }

// ---------------------------------------------------------------- validation

const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const isoish = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const hex64 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const cardHash = (card: AgentCard) => { const { custody: _c, ...content } = card; return stableHash(content); };

export function validateAgentCard(card: AgentCard): string[] {
  const e: string[] = [];
  if (!card || typeof card !== "object") return ["agent card must be an object"];
  if (card.schema !== "agent-card@1") e.push("schema must be agent-card@1");
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(card.id ?? "")) e.push("id must be a lowercase slug");
  if (!Number.isInteger(card.version) || card.version < 1) e.push("version must be a positive integer");
  if (!nonEmpty(card.name)) e.push("name is required");
  if (!nonEmpty(card.role)) e.push("role is required");
  if (!nonEmpty(card.persona?.summary)) e.push("persona.summary is required");
  if (!nonEmpty(card.origin?.creatorId) || !isoish(card.origin?.createdAt)) e.push("origin.creatorId and origin.createdAt are required");
  if (!Array.isArray(card.custody) || !card.custody.length) e.push("custody must start with the origin location");
  for (const hop of card.custody ?? []) if (!/^(creator|factory):[A-Za-z0-9._-]+$/.test(hop.location ?? "") || !isoish(hop.at) || !nonEmpty(hop.by) || !hex64(hop.cardSha256)) e.push(`invalid custody hop ${JSON.stringify(hop)}`);
  if (card.role === "reporter" && !card.press) e.push("a reporter needs a press block (lens and rights)");
  if (card.press && (!LENSES.includes(card.press.lens) || typeof card.press.rights?.mayChallenge !== "boolean")) e.push("press needs a known lens and rights.mayChallenge");
  for (const a of [...(card.assets?.voices ?? []), ...(card.assets?.images ?? [])]) if (!nonEmpty(a.uri) || !hex64(a.sha256)) e.push(`asset ${a.id} needs a uri and sha256`);
  return e;
}

export function validatePressCorpsCard(corps: PressCorpsCard): string[] {
  const e: string[] = [];
  if (corps?.schema !== "press-corps@1") e.push("schema must be press-corps@1");
  if (!nonEmpty(corps?.id) || !Number.isInteger(corps?.version)) e.push("id and integer version are required");
  const ids = new Set<string>();
  for (const r of corps?.reporters ?? []) { e.push(...validateAgentCard(r).map((x) => `${r?.id}: ${x}`)); if (!r.press) e.push(`${r.id}: not a reporter`); if (ids.has(r.id)) e.push(`duplicate reporter ${r.id}`); ids.add(r.id); }
  if (!corps?.reporters?.length) e.push("at least one reporter is required");
  if (!corps?.beats?.length) e.push("at least one beat is required");
  for (const b of corps?.beats ?? []) {
    if (!["statement", "questions", "commitments", "final"].includes(b.kind)) e.push(`beat ${b.id} has unknown kind ${b.kind}`);
    for (const rid of b.reporters ?? []) if (!ids.has(rid)) e.push(`beat ${b.id} references unknown reporter ${rid}`);
    if ((b.kind === "questions" || b.kind === "final") && !b.reporters?.length) e.push(`beat ${b.id} needs at least one reporter`);
  }
  return e;
}

export function validateStoryTemplate(t: StoryTemplate): string[] {
  const e: string[] = [];
  if (t?.schema !== "story-template@1") e.push("schema must be story-template@1");
  if (t?.source !== "press-record@1") e.push("only press-record@1 sources are supported");
  if (!nonEmpty(t?.id) || !Number.isInteger(t?.version)) e.push("id and integer version are required");
  if (!t?.scenes?.length) e.push("at least one scene is required");
  for (const s of t?.scenes ?? []) if (s.from === "beat" && !s.beatId) e.push(`scene ${s.id} reads a beat but names no beatId`);
  return e;
}

export function validateReceipt(r: OperationReceipt): string[] {
  const e: string[] = [];
  if (r?.schema !== "operation-receipt@1") e.push("schema must be operation-receipt@1");
  for (const k of ["id", "operation", "factoryId", "runId", "operatorId"] as const) if (!nonEmpty(r?.[k])) e.push(`${k} is required`);
  if (!["completed", "failed", "rejected"].includes(r?.status)) e.push("status is invalid");
  if (!["platform", "operator", "provider"].includes(r?.hosting)) e.push("hosting is invalid");
  if (!Number.isFinite(r?.costUsd) || r.costUsd < 0) e.push("costUsd must be a non-negative number");
  const en = r?.energy;
  if (!en || [en.measuredWh, en.providerReportedWh, en.estimatedWh].some((x) => !Number.isFinite(x) || x < 0) || !Number.isInteger(en.unknownSteps)) e.push("energy totals are invalid");
  if (!isoish(r?.startedAt) || !isoish(r?.finishedAt)) e.push("startedAt and finishedAt are required");
  if (!hex64(r?.sha256)) e.push("sha256 is required");
  else if (!e.length && !receiptHashValid(r)) e.push("sha256 does not match the receipt contents");
  return e;
}

// ---------------------------------------------------------------- clusters

type Bps = number;
interface SplitStage { name: string; minerBps: Bps; factoryBps: Bps; burnBps: Bps; }
/** A cluster is a collection of miners and factories that governs itself. Everything here is configurable; the protocol invariants are enforced by validateClusterCharter. */
export interface ClusterCharter {
  schema: "cluster-charter@1";
  id: string;
  version: number;
  name: string;
  effectiveFrom: string;
  previousVersionHash?: string;
  members: { miners: Array<{ id: string; qiAddress?: string; quaiAddress?: string }>; factories: Array<{ factoryId: string; creatorId: string; sponsors: string[] }> };
  admission: { mode: "open" | "invite" | "stake" | "vote"; minStakeQiBase?: number; approvalBps?: Bps };
  exit: { noticeEpochs: number };
  epochs: { ignition: string; online: string; production: string; mature: string };
  quality: { acceptedSources: Array<"customer" | "network_evaluator" | "press_documented" | "self">; defaultQ0: number };
  rewardsCurve: { beta: number; floor: number; cap: number; minSamples: number };
  lifecycle: {
    firstLight: { minAccepted: number; minDocumentedRate: number; bountyQiBase: number };
    steadyState: { minStability: number; consecutiveEpochs: number; maxAttemptsPerKeeper: number; bountyQiBase: number };
    lindy: { epochs: number; bountyQiBase: number };
    lineage: { bountyQiBase: number };
    bountySplit: { factoryBps: Bps; sponsorBps: Bps; contributorsBps: Bps; burnBps: Bps };
  };
  sponsorship: { returnRateBps: Bps; paybackMultiple: number; stages: { beforePayback: SplitStage; afterPayback: SplitStage; mature: SplitStage }; burnCurve: { baseBps: Bps; bpsPerDoubling: Bps; maxBps: Bps }; demandSubsidy: boolean };
  revenueMining: { setAsideBps: Bps; burnBps: Bps; finderBps: Bps; workshareWindowEpochs: number; minTenureEpochs: number; perFactoryCapBps?: Bps; noWinDecayEpochs?: number };
  token?: { symbol?: string; contract?: string; burnDestination?: string; burnSchedule: "per_epoch" | "ritual" };
  amendments: { approvalBps: Bps; effectiveAfterEpochs: number };
}

/** The outcome metrics every cluster publishes, whatever its charter, so clusters can be compared. */
export const STANDARD_OUTCOME_METRICS = ["accepted_outcomes_per_dollar", "time_to_first_light", "time_to_steady_state", "survival_rate", "burn_per_epoch", "cost_per_accepted_outcome"] as const;

/**
 * Protocol invariants a charter can't override. The JSON Schema checks shape; this checks the rules that keep
 * outcomes honest and comparable: no self-graded quality, splits that divide exactly what came in, no retroactive
 * amendments, and members that exist.
 */
export function validateClusterCharter(c: ClusterCharter): string[] {
  const e: string[] = [];
  if (c?.schema !== "cluster-charter@1") return ["schema must be cluster-charter@1"];
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(c.id ?? "")) e.push("id must be a lowercase slug");
  if (!Number.isInteger(c.version) || c.version < 1) e.push("version must be a positive integer");
  if (Number.isNaN(Date.parse(c.effectiveFrom))) e.push("effectiveFrom must be a date");
  if (c.version > 1 && !c.previousVersionHash) e.push("amended charters must link the previous version's hash");
  const miners = new Set<string>();
  for (const m of c.members?.miners ?? []) { if (miners.has(m.id)) e.push(`duplicate miner ${m.id}`); miners.add(m.id); }
  const factories = new Set<string>();
  for (const f of c.members?.factories ?? []) { if (factories.has(f.factoryId)) e.push(`duplicate factory ${f.factoryId}`); factories.add(f.factoryId); for (const s of f.sponsors) if (!miners.has(s)) e.push(`factory ${f.factoryId} names sponsor ${s}, who is not a member miner`); }
  if (!miners.size && !factories.size) e.push("a cluster needs at least one member");
  if (!c.quality?.acceptedSources?.length) e.push("at least one independent quality source is required");
  if (c.quality?.acceptedSources?.includes("self")) e.push("invariant: self-graded quality can never count");
  const sum = (o: Record<string, unknown>, keys: string[]) => keys.reduce((t, k) => t + Number(o[k] ?? 0), 0);
  const split = c.lifecycle?.bountySplit;
  if (split && sum(split, ["factoryBps", "sponsorBps", "contributorsBps", "burnBps"]) !== 10_000) e.push("invariant: milestone bounty split must sum to 10000 bps");
  for (const [name, st] of Object.entries(c.sponsorship?.stages ?? {})) if (sum(st as unknown as Record<string, unknown>, ["minerBps", "factoryBps", "burnBps"]) !== 10_000) e.push(`invariant: sponsorship stage ${name} must sum to 10000 bps`);
  const bc = c.sponsorship?.burnCurve;
  if (bc && bc.baseBps > bc.maxBps) e.push("burn curve base exceeds its max");
  const rm = c.revenueMining;
  if (rm && [rm.setAsideBps, rm.burnBps, rm.finderBps].some((x) => !Number.isInteger(x) || x < 0 || x > 10_000)) e.push("revenue mining shares must be 0..10000 bps");
  const rc = c.rewardsCurve;
  if (rc && !(rc.floor > 0 && rc.floor <= 1 && rc.cap >= 1)) e.push("reward curve needs 0 < floor ≤ 1 ≤ cap");
  if (!(c.amendments?.effectiveAfterEpochs >= 1)) e.push("invariant: amendments take effect at least one epoch later (never retroactively)");
  if (c.admission?.mode === "stake" && !c.admission.minStakeQiBase) e.push("stake admission needs minStakeQiBase");
  return e;
}

/** Checks a new charter version against the one it replaces. */
export function validateCharterAmendment(previous: ClusterCharter, next: ClusterCharter): string[] {
  const e = validateClusterCharter(next);
  if (next.id !== previous.id) e.push("an amendment can't change the cluster id");
  if (next.version !== previous.version + 1) e.push(`version must be ${previous.version + 1}`);
  if (next.previousVersionHash !== stableHash(previous)) e.push("previousVersionHash must be the hash of the previous version");
  if (!(Date.parse(next.effectiveFrom) > Date.parse(previous.effectiveFrom))) e.push("invariant: an amendment must take effect after the version it replaces");
  return e;
}
