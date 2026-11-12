import { businessNumberRoot, isConsortiumName, nameKeys, postalFsa } from "../../research/names";

export interface IndexEntity {
  orgId: string;
  names: string[];
  businessNumbers: string[];
  postalFsas: string[];
}
export type MatchStatus = "confirmed" | "ambiguous" | "no_match" | "consortium";
export interface MatchResult {
  status: MatchStatus;
  orgId: string | null;
  method: string;
  candidates: string[];
}
export type RecipientIndex = Map<string, Map<string, IndexEntity>>;
export interface Recipient {
  names: string[];
  businessNumber: string | null;
  postal: string | null;
}

export function buildIndex(entities: IndexEntity[]): RecipientIndex {
  const index: RecipientIndex = new Map();
  const ids = new Set<string>();
  for (const entity of entities) {
    if (ids.has(entity.orgId)) throw new Error(`Duplicate index orgId: ${entity.orgId}`);
    ids.add(entity.orgId);
    for (const name of entity.names)
      for (const key of nameKeys(name)) {
        const entries = index.get(key) ?? new Map<string, IndexEntity>();
        entries.set(entity.orgId, entity);
        index.set(key, entries);
      }
  }
  return index;
}

export function matchRecipient(recipient: Recipient, index: RecipientIndex): MatchResult {
  const result = (
    status: MatchStatus,
    method: string,
    candidates: string[] = [],
    orgId: string | null = null,
  ): MatchResult => ({ status, method, candidates, orgId });
  if (recipient.names.some(isConsortiumName)) return result("consortium", "consortium");
  const entries = new Map<string, IndexEntity>();
  for (const name of recipient.names)
    for (const key of nameKeys(name)) {
      for (const [id, entity] of index.get(key) ?? []) entries.set(id, entity);
    }
  const candidates = [...entries.keys()].sort();
  if (!candidates.length) return result("no_match", "no_match");
  if (candidates.length > 1) return result("ambiguous", "multiple_candidates", candidates);
  const entity = entries.get(candidates[0]!)!;
  const bn = businessNumberRoot(recipient.businessNumber);
  if (recipient.businessNumber?.trim() && !bn)
    return result("ambiguous", "malformed_bn", candidates, entity.orgId);
  const roots = entity.businessNumbers.map(businessNumberRoot).filter((v) => v !== null);
  if (bn && roots.length) {
    if (roots.includes(bn)) return result("confirmed", "name+bn", candidates, entity.orgId);
    return result("ambiguous", "identifier_conflict", candidates, entity.orgId);
  }
  const fsa = postalFsa(recipient.postal);
  if (fsa && entity.postalFsas.some((value) => postalFsa(value) === fsa))
    return result("confirmed", "name+postal", candidates, entity.orgId);
  return result("ambiguous", "name_only", candidates, entity.orgId);
}

export function assertNegativeControl(
  index: RecipientIndex,
  matcher: typeof matchRecipient = matchRecipient,
): void {
  if (
    matcher({ names: ["Zzzxq Not A Company 12345"], businessNumber: null, postal: null }, index)
      .status !== "no_match"
  ) {
    throw new Error("Negative control failed: fabricated recipient matched");
  }
}

/** Shared counting for batch tests and the CLI's incremental magnitude accumulator. */
export function countMagnitude(result: MatchResult, counts: Map<string, number>): void {
  if (result.status !== "confirmed" && result.status !== "ambiguous") return;
  for (const id of new Set(result.orgId ? [result.orgId, ...result.candidates] : result.candidates))
    counts.set(id, (counts.get(id) ?? 0) + 1);
}
export function assertMagnitudeCounts(
  counts: Map<string, number>,
  totalRows: number,
  // Proportional, but capped: 2% of a 1.3M-row national file would allow 26k rows per company.
  maxPerOrg = Math.min(5000, Math.max(50, totalRows * 0.02)),
): void {
  for (const [id, count] of counts)
    if (count > maxPerOrg)
      throw new Error(`Magnitude gate failed: ${id} has ${count} rows (maximum ${maxPerOrg})`);
}
export function assertMagnitude(
  results: Iterable<MatchResult>,
  totalRows: number,
  maxPerOrg?: number,
): void {
  const counts = new Map<string, number>();
  for (const result of results) countMagnitude(result, counts);
  assertMagnitudeCounts(counts, totalRows, maxPerOrg);
}
