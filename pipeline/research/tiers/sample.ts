/**
 * Audit sample (docs/VERIFICATION_TIERS.md section 5): a reproducible random sample of the records
 * that passed tiers 1 and 2, seeded by the batch hash so nobody can choose it by hand.
 *
 * Size: the smaller of 30 and the number of passing records. At least 10 from each tier when that
 * many are available; within a tier, records are drawn round-robin across companies.
 */
import { createHash } from "node:crypto";
import type { TierRecord } from "./rules";

export const AUDIT_SIZE = 30;
export const PER_TIER_MINIMUM = 10;

/** Deterministic stream of 32-bit integers from a seed (SHA-256 in counter mode). */
function stream(seed: string): () => number {
  let counter = 0;
  let buffer: Buffer = Buffer.alloc(0);
  return () => {
    if (buffer.length < 4) {
      buffer = createHash("sha256").update(`${seed}:${counter++}`).digest();
    }
    const n = buffer.readUInt32BE(0);
    buffer = buffer.subarray(4);
    return n;
  };
}

function shuffle<T>(items: T[], next: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** One record per company in turn (companies and records in seeded random order). */
function spread(records: TierRecord[], next: () => number): TierRecord[] {
  const byOrg = new Map<string, TierRecord[]>();
  for (const r of records.slice().sort((x, y) => (x.id < y.id ? -1 : 1)))
    byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r]);
  const queues = shuffle([...byOrg.keys()].sort(), next).map((org) =>
    shuffle(byOrg.get(org)!, next),
  );
  const out: TierRecord[] = [];
  while (queues.some((q) => q.length))
    for (const q of queues) {
      const r = q.shift();
      if (r) out.push(r);
    }
  return out;
}

/** The audit sample's record IDs, in draw order. Conditional tier 1 passes are eligible. */
export function auditSample(
  records: TierRecord[],
  batch: string,
  size = AUDIT_SIZE,
  perTier = PER_TIER_MINIMUM,
): string[] {
  const eligible = records.filter(
    (r) => (r.tier === 1 || r.tier === 2) && (r.status === "pass" || r.status === "conditional"),
  );
  const n = Math.min(size, eligible.length);
  const next = stream(batch);
  const t1 = spread(
    eligible.filter((r) => r.tier === 1),
    next,
  );
  const t2 = spread(
    eligible.filter((r) => r.tier === 2),
    next,
  );
  const picked: TierRecord[] = [
    ...t1.slice(0, Math.min(perTier, t1.length)),
    ...t2.slice(0, Math.min(perTier, t2.length)),
  ];
  // Fill the rest from both tiers alternately, keeping the company spread within each.
  const rest1 = t1.slice(picked.filter((r) => r.tier === 1).length);
  const rest2 = t2.slice(picked.filter((r) => r.tier === 2).length);
  while (picked.length < n && (rest1.length || rest2.length)) {
    const from = rest1.length && (!rest2.length || next() % 2 === 0) ? rest1 : rest2;
    picked.push(from.shift()!);
  }
  return picked.slice(0, n).map((r) => r.id);
}
