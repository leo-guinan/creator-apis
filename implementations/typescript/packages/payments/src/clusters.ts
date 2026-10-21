import { stableHash, validateClusterCharter, type ClusterCharter } from "../../contracts/src/index.js";
import { scoreDeliveries, type Delivery, type Standard } from "./rewards.js";

/**
 * Cluster epochs: mining of revenue.
 *
 * Each paid order a member factory wins is a block. Its set-aside (a share of margin) is split: a burn share,
 * then the finder (the factory that won it) keeps a share of the remainder, and the rest goes to the cluster pot.
 * The pot is split by workshares: standard-seconds of independently accepted work over a trailing window, so
 * factories that are producing but haven't won a customer yet still earn (Proportional Splitting, with revenue
 * playing the parent chain). Every parameter comes from the cluster's charter; the engine only enforces invariants.
 */

export type Phase = "ignition" | "online" | "production" | "mature";

export interface Win {
  /** The order id. A win counts in one cluster epoch, once. */
  id: string;
  factoryId: string;
  /** Hashed customer identity; used so repeat purchases by one customer from one factory don't farm finder bonuses. */
  customerKey: string;
  marginCents: number;
  /** Set aside at settlement. If absent, computed from the charter. */
  setAsideCents?: number;
  at: string;
}

export interface WinLine { id: string; factoryId: string; customerKey: string; marginCents: number; setAsideCents: number; burnCents: number; finderCents: number; potCents: number; finderEligible: boolean; note: string; }
export interface WorkshareLine { factoryId: string; epochScore: number; windowScore: number; weight: number; tenureEpochs: number; epochsSinceWin: number; eligible: boolean; reason: string; potCents: number; }
export interface ClusterEpoch {
  schema: "cluster-epoch@1";
  clusterId: string;
  charterVersion: number;
  charterHash: string;
  epoch: { id: string; start: string; end: string };
  members: { factories: string[]; miners: string[] };
  wins: WinLine[];
  workshares: WorkshareLine[];
  deliveryIds: string[];
  excluded: Array<{ id: string; kind: "win" | "delivery"; reason: string }>;
  pot: { fromWinsCents: number; rolloverInCents: number; distributedCents: number; rolloverOutCents: number };
  payouts: Array<{ factoryId: string; creatorId: string; finderCents: number; potCents: number; totalCents: number }>;
  burn: { cents: number; schedule: "per_epoch" | "ritual" };
  /** The standard outcome metrics every cluster publishes. null = not measurable from this epoch's inputs yet. */
  scoreboard: { acceptedOutcomes: number; acceptedOutcomesPerDollar: number | null; costPerAcceptedOutcomeCents: number | null; burnCents: number; winCount: number; activeFactories: number; timeToFirstLight: null; timeToSteadyState: null; survivalRate: null };
  previousEpochId?: string;
  previousEpochHash?: string;
  hash: string;
}

export interface ClusterEpochInput {
  charter: ClusterCharter;
  epoch: { id: string; start: string; end: string };
  wins: Win[];
  deliveries: Delivery[];
  /** Every delivery known, for resolving reuse royalties. */
  allDeliveries?: Delivery[];
  standards: Record<string, Standard>;
  /** Earlier epochs of this cluster, oldest first. Used for trailing workshares, tenure, no-win decay and chaining. */
  history?: ClusterEpoch[];
  phases?: Record<string, Phase>;
  /** Cost of each delivery, if known, for the scoreboard. */
  costCents?: Record<string, number>;
}

const bps = (amount: number, b: number) => Math.floor((amount * b) / 10_000);

export function closeClusterEpoch(input: ClusterEpochInput): ClusterEpoch {
  const { charter: c, epoch } = input;
  const errors = validateClusterCharter(c);
  if (errors.length) throw new Error(`invalid charter: ${errors.join("; ")}`);
  if (!(epoch.start <= epoch.end)) throw new Error("epoch start must not be after its end");
  const history = input.history ?? [];
  const last = history.at(-1);
  if (last && epoch.start <= last.epoch.end) throw new Error(`epoch ${epoch.id} overlaps ${last.epoch.id}`);
  for (const [i, h] of history.entries()) {
    if (h.clusterId !== c.id) throw new Error(`history epoch ${h.epoch.id} belongs to ${h.clusterId}`);
    if ((history[i - 1]?.hash ?? undefined) !== h.previousEpochHash) throw new Error(`history is not a chain at ${h.epoch.id}`);
  }
  const memberFactories = new Map(c.members.factories.map((f) => [f.factoryId, f]));
  const excluded: ClusterEpoch["excluded"] = [];
  const counted = new Set(history.flatMap((h) => [...h.wins.map((w) => `win:${w.id}`), ...h.deliveryIds.map((d) => `delivery:${d}`)]));
  const inEpoch = (at: string) => at >= epoch.start && at <= epoch.end;

  // Blocks: wins.
  const wins = [...input.wins].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)).filter((w) => {
    const reason = !memberFactories.has(w.factoryId) ? "factory is not a member" : !inEpoch(w.at) ? "outside the epoch" : counted.has(`win:${w.id}`) ? "already counted in an earlier epoch" : !(Number.isInteger(w.marginCents) && w.marginCents >= 0) ? "margin must be non-negative integer cents" : undefined;
    if (reason) excluded.push({ id: w.id, kind: "win", reason });
    return !reason;
  });
  const seenCustomer = new Set<string>();
  const winLines: WinLine[] = wins.map((w) => {
    const setAside = w.setAsideCents ?? bps(w.marginCents, c.revenueMining.setAsideBps);
    const burn = bps(setAside, c.revenueMining.burnBps);
    const rem = setAside - burn;
    const key = `${w.factoryId}|${w.customerKey}`;
    const finderEligible = !seenCustomer.has(key);
    seenCustomer.add(key);
    const finder = finderEligible ? bps(rem, c.revenueMining.finderBps) : 0;
    return { id: w.id, factoryId: w.factoryId, customerKey: w.customerKey, marginCents: w.marginCents, setAsideCents: setAside, burnCents: burn, finderCents: finder, potCents: rem - finder, finderEligible, note: finderEligible ? "finder share paid" : "repeat customer for this factory this epoch: no finder bonus, all to the pot" };
  });

  // Workshares: deliveries.
  const deliveries = input.deliveries.filter((d) => {
    const reason = !memberFactories.has(d.factoryId) ? "factory is not a member" : d.clusterId && d.clusterId !== c.id ? `attributed to cluster ${d.clusterId}` : !inEpoch(d.deliveredAt) ? "outside the epoch" : counted.has(`delivery:${d.id}`) ? "already counted in an earlier epoch" : undefined;
    if (reason) excluded.push({ id: d.id, kind: "delivery", reason });
    return !reason;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const scored = scoreDeliveries(deliveries, input.allDeliveries ?? input.deliveries, input.standards, { beta: c.rewardsCurve.beta, floor: c.rewardsCurve.floor, cap: c.rewardsCurve.cap, acceptedQualitySources: c.quality.acceptedSources, reuseRoyaltyFraction: 0.25 });
  const epochScore = new Map<string, number>();
  for (const s of scored) if (memberFactories.has(s.creditedFactoryId)) epochScore.set(s.creditedFactoryId, (epochScore.get(s.creditedFactoryId) ?? 0) + s.score);

  const windowSlice = c.revenueMining.workshareWindowEpochs > 1 ? history.slice(-(c.revenueMining.workshareWindowEpochs - 1)) : [];
  const wonNow = new Set(winLines.map((w) => w.factoryId));
  const workshares: WorkshareLine[] = [...memberFactories.keys()].sort().map((factoryId) => {
    const own = epochScore.get(factoryId) ?? 0;
    const windowScore = own + windowSlice.reduce((t, h) => t + (h.workshares.find((x) => x.factoryId === factoryId)?.epochScore ?? 0), 0);
    const tenureEpochs = history.filter((h) => h.members.factories.includes(factoryId)).length;
    let epochsSinceWin = 0;
    if (!wonNow.has(factoryId)) { epochsSinceWin = 1; for (const h of [...history].reverse()) { if (h.wins.some((w) => w.factoryId === factoryId)) break; epochsSinceWin += 1; } }
    const phase = input.phases?.[factoryId] ?? "production";
    const decay = c.revenueMining.noWinDecayEpochs && (phase === "production" || phase === "mature") ? 0.5 ** Math.floor(epochsSinceWin / c.revenueMining.noWinDecayEpochs) : 1;
    const eligible = tenureEpochs >= c.revenueMining.minTenureEpochs;
    const reason = !eligible ? `tenure ${tenureEpochs} of ${c.revenueMining.minTenureEpochs} epochs` : windowScore === 0 ? "no accepted work in the window" : decay < 1 ? `no win for ${epochsSinceWin} epochs: weight ×${decay}` : "eligible";
    return { factoryId, epochScore: own, windowScore, weight: eligible ? windowScore * decay : 0, tenureEpochs, epochsSinceWin, eligible, reason, potCents: 0 };
  });

  // Pot.
  const fromWins = winLines.reduce((t, w) => t + w.potCents, 0);
  const rolloverIn = last?.pot.rolloverOutCents ?? 0;
  const budget = fromWins + rolloverIn;
  const totalWeight = workshares.reduce((t, w) => t + w.weight, 0);
  const cap = c.revenueMining.perFactoryCapBps !== undefined ? bps(budget, c.revenueMining.perFactoryCapBps) : Number.POSITIVE_INFINITY;
  let distributed = 0;
  if (totalWeight > 0) for (const w of workshares) { w.potCents = Math.min(cap, Math.floor((budget * w.weight) / totalWeight)); distributed += w.potCents; }

  const payouts = [...memberFactories.values()].map((f) => {
    const finder = winLines.filter((w) => w.factoryId === f.factoryId).reduce((t, w) => t + w.finderCents, 0);
    const pot = workshares.find((w) => w.factoryId === f.factoryId)!.potCents;
    return { factoryId: f.factoryId, creatorId: f.creatorId, finderCents: finder, potCents: pot, totalCents: finder + pot };
  }).filter((p) => p.totalCents > 0).sort((a, b) => a.factoryId.localeCompare(b.factoryId));

  const burnCents = winLines.reduce((t, w) => t + w.burnCents, 0);
  const accepted = scored.filter((s) => s.score > 0).length;
  const costs = deliveries.map((d) => input.costCents?.[d.id]);
  const costKnown = deliveries.length > 0 && costs.every((x) => typeof x === "number");
  const totalCost = costKnown ? costs.reduce((t: number, x) => t + (x as number), 0) : 0;

  const body: Omit<ClusterEpoch, "hash"> = {
    schema: "cluster-epoch@1", clusterId: c.id, charterVersion: c.version, charterHash: stableHash(c), epoch,
    members: { factories: [...memberFactories.keys()].sort(), miners: c.members.miners.map((m) => m.id).sort() },
    wins: winLines, workshares, deliveryIds: deliveries.map((d) => d.id), excluded,
    pot: { fromWinsCents: fromWins, rolloverInCents: rolloverIn, distributedCents: distributed, rolloverOutCents: budget - distributed },
    payouts, burn: { cents: burnCents, schedule: c.token?.burnSchedule ?? "ritual" },
    scoreboard: { acceptedOutcomes: accepted, acceptedOutcomesPerDollar: costKnown && totalCost > 0 ? accepted / (totalCost / 100) : null, costPerAcceptedOutcomeCents: costKnown && accepted > 0 ? totalCost / accepted : null, burnCents, winCount: winLines.length, activeFactories: workshares.filter((w) => w.epochScore > 0 || wonNow.has(w.factoryId)).length, timeToFirstLight: null, timeToSteadyState: null, survivalRate: null },
    previousEpochId: last?.epoch.id, previousEpochHash: last?.hash
  };
  const clean = JSON.parse(JSON.stringify(body)) as Omit<ClusterEpoch, "hash">;
  return { ...clean, hash: stableHash(clean) };
}

export function clusterEpochHashValid(e: ClusterEpoch): boolean { const { hash, ...rest } = e; return stableHash(rest) === hash; }

/** Conservation: every cent of set-aside and rollover is either paid as finder share, paid from the pot, burned, or rolled over. */
export function clusterEpochReconciles(e: ClusterEpoch): boolean {
  const setAside = e.wins.reduce((t, w) => t + w.setAsideCents, 0);
  const finder = e.wins.reduce((t, w) => t + w.finderCents, 0);
  const paidPot = e.payouts.reduce((t, p) => t + p.potCents, 0);
  return setAside + e.pot.rolloverInCents === finder + paidPot + e.burn.cents + e.pot.rolloverOutCents && paidPot === e.pot.distributedCents;
}
