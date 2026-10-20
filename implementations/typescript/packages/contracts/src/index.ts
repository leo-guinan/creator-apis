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
