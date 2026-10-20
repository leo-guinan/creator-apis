/**
 * Qi: Quai Network's energy-denominated, UTXO-based token. Facts used here, and where they come from:
 *  - 3 decimal places: quais.js `formatQi`/`parseQi` use 3 decimals. We store integer base units (0.001 Qi).
 *  - Qi-ledger addresses: quais.js `isQiAddress` checks the high bit of the address's second byte.
 *  - There is no published fixed kWh-per-Qi peg. Qi issuance scales linearly with difficulty, so each Qi is meant to
 *    represent roughly constant energy, and the protocol converts QUAI<->Qi at market rate. So energy is priced with an
 *    explicit, timestamped quote (Qi per kWh, USD per Qi) that names its source. No quote, no Qi.
 */
export const QI_DECIMALS = 3;
export const QI_BASE_PER_QI = 10 ** QI_DECIMALS;

export function isQiAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  return (parseInt(address.substring(4, 6), 16) & 0x80) === 0x80;
}

export const formatQi = (base: number) => `${(base / QI_BASE_PER_QI).toFixed(QI_DECIMALS)} Qi`;

export interface EnergyQuote {
  id: string;
  /** Qi paid per kWh of operating energy. */
  qiPerKwh: number;
  /** USD value of one Qi, used to deduct the energy cost from fiat revenue. */
  usdPerQi: number;
  /** Where the numbers came from (an exchange, a published rate, a governance decision). */
  source: string;
  observedAt: string;
}

export function validateQuote(q: EnergyQuote | undefined, now: Date, maxAgeHours: number): string[] {
  if (!q) return ["no energy quote"];
  const e: string[] = [];
  if (!(q.qiPerKwh > 0) || !Number.isFinite(q.qiPerKwh)) e.push("qiPerKwh must be positive");
  if (!(q.usdPerQi > 0) || !Number.isFinite(q.usdPerQi)) e.push("usdPerQi must be positive");
  if (!q.source?.trim()) e.push("quote must name its source");
  const age = (now.getTime() - Date.parse(q.observedAt)) / 3_600_000;
  if (Number.isNaN(age)) e.push("observedAt must be a date");
  else if (age > maxAgeHours) e.push(`quote is ${age.toFixed(1)}h old; limit is ${maxAgeHours}h`);
  else if (age < -0.1) e.push("quote is from the future");
  return e;
}

/** Converts energy to Qi base units (rounded down: never overpay) and the USD cents that Qi is worth at the quote. */
export function priceEnergy(wh: number, quote: EnergyQuote): { qiBase: number; usdCents: number } {
  const qiBase = Math.floor((wh / 1000) * quote.qiPerKwh * QI_BASE_PER_QI);
  return { qiBase, usdCents: Math.round((qiBase / QI_BASE_PER_QI) * quote.usdPerQi * 100) };
}
