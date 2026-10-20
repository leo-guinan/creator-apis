import { readFileSync } from "node:fs";
import { cardHash, stableHash, validateAgentCard, validatePressCorpsCard, validateStoryTemplate, type AgentCard, type BeatSpec, type LensId, type PressCorpsCard, type ReporterRights, type StoryDraft, type StoryTemplate } from "../../contracts/src/index.js";

/**
 * Creator-level press content. The cast file is the human-edited source of truth; agent cards and the
 * press-corps card are generated from it (scripts/export-press.ts) and travel to factories, which run them.
 */

export interface CastReporter {
  id: string; name: string; title: string; beat: string; lens: LensId; rights: ReporterRights; maxFollowups?: number; questionsPerBeat?: number;
  backstory: string; theoryOfWinning: string; voiceDirection: string; questioningStyle: string; signatureQuestion: string;
  voiceProfile?: string;
  voicePick?: { auditionId: string; candidate: number; sha256: string };
}
export interface Cast { creatorId: string; castDate: string; source: string; fictionBoundary: string; ensembleContract: string; corps: { id: string; version: number; name: string }; reporters: CastReporter[]; voicePickNote?: string; beats: BeatSpec[]; }

export const loadCast = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Cast;

export function agentCardFromCast(cast: Cast, r: CastReporter, version = 1): AgentCard {
  const base: AgentCard = {
    schema: "agent-card@1", id: r.id, version, name: r.name, title: r.title, role: "reporter",
    persona: { summary: `${r.title} (${r.beat}). ${r.backstory}`, theoryOfWinning: r.theoryOfWinning, voiceDirection: r.voiceDirection, backstory: r.backstory, questioningStyle: r.questioningStyle, beat: r.beat, signatureQuestion: r.signatureQuestion },
    press: { lens: r.lens, rights: r.rights, maxFollowups: r.maxFollowups, questionsPerBeat: r.questionsPerBeat },
    voiceProfiles: r.voiceProfile ? [{ provider: "clipping-lab", key: r.voiceProfile, note: "stable voice key; provider voice ids stay inside Clipping Lab" }] : undefined,
    assets: r.voicePick ? { voices: [{ id: r.voicePick.auditionId, kind: "voice", provider: "clipping-lab", providerRef: r.voicePick.auditionId, uri: `clipping-lab://auditions/${r.voicePick.auditionId}/audio.mp3`, sha256: r.voicePick.sha256, mime: "audio/mpeg", createdAt: cast.castDate, note: `audition candidate ${r.voicePick.candidate}; ${cast.voicePickNote ?? ""}`.trim() }] } : undefined,
    origin: { creatorId: cast.creatorId, createdAt: cast.castDate, source: cast.source },
    custody: []
  };
  const clean = JSON.parse(JSON.stringify(base)) as AgentCard;
  const card = { ...clean, custody: [{ location: `creator:${cast.creatorId}`, at: cast.castDate, by: cast.creatorId, reason: "cast", cardSha256: cardHash(clean) }] };
  const errors = validateAgentCard(card);
  if (errors.length) throw new Error(`cast reporter ${r.id}: ${errors.join("; ")}`);
  return card;
}

export function pressCorpsFromCast(cast: Cast): PressCorpsCard {
  const card: PressCorpsCard = { schema: "press-corps@1", id: cast.corps.id, version: cast.corps.version, name: cast.corps.name, creatorId: cast.creatorId, reporters: cast.reporters.map((r) => agentCardFromCast(cast, r)), beats: cast.beats };
  const errors = validatePressCorpsCard(card);
  if (errors.length) throw new Error(`press corps ${card.id}: ${errors.join("; ")}`);
  return card;
}

export function loadStoryTemplate(path: string): StoryTemplate {
  const t = JSON.parse(readFileSync(path, "utf8")) as StoryTemplate;
  const errors = validateStoryTemplate(t);
  if (errors.length) throw new Error(`story template ${path}: ${errors.join("; ")}`);
  return t;
}

// ---------------------------------------------------------------- stories live here

export interface StoryPackage {
  schema: "story-package@1";
  id: string;
  creatorId: string;
  draft: StoryDraft;
  draftSha256: string;
  status: "pending_approval" | "approved";
  /** Fictional cast and a real manager's on-record answers: what each party has agreed to. */
  rights: { fictionalCharacters: string; manager: { id: string; consent: "unknown" | "granted" | "refused" } };
  approvedBy?: string;
  approvedAt?: string;
  unresolved: string[];
}

/**
 * Wraps a factory's story draft into a creator-owned story package. Nothing leaves for production until the
 * creator approves it and the manager's consent is recorded; unknown consent stays unknown.
 */
export function packageStory(draft: StoryDraft, opts: { creatorId: string; managerId: string; fictionBoundary: string; managerConsent?: "granted" | "refused" }): StoryPackage {
  if (draft.schema !== "story-draft@1") throw new Error("expected a story-draft@1");
  const moments = draft.scenes.flatMap((s) => s.moments);
  const unresolved: string[] = [];
  for (const m of moments) if (!draft.provenance.includes(m.ref)) unresolved.push(`moment ${m.ref} is not in the draft's provenance`);
  if (!opts.managerConsent) unresolved.push(`manager ${opts.managerId} has not consented to their answers being used in a story`);
  if (opts.managerConsent === "refused") unresolved.push(`manager ${opts.managerId} refused consent`);
  const draftSha256 = stableHash(draft);
  return { schema: "story-package@1", id: `story_${draftSha256.slice(0, 16)}`, creatorId: opts.creatorId, draft, draftSha256, status: "pending_approval", rights: { fictionalCharacters: opts.fictionBoundary, manager: { id: opts.managerId, consent: opts.managerConsent ?? "unknown" } }, unresolved };
}

export function approveStory(pkg: StoryPackage, by: string, at = new Date().toISOString()): StoryPackage {
  if (by !== pkg.creatorId) throw new Error("only the creator can approve their story");
  if (stableHash(pkg.draft) !== pkg.draftSha256) throw new Error("draft changed after packaging; package it again");
  if (pkg.unresolved.length) throw new Error(`cannot approve with unresolved items: ${pkg.unresolved.join("; ")}`);
  return { ...pkg, status: "approved", approvedBy: by, approvedAt: at };
}
