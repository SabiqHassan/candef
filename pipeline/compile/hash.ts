/**
 * Review binding (DATA_SCHEMA §3, P-19): an approval is a hash over the canonical content of the
 * record it approves. The compiler recomputes the hash; any edit after review invalidates it.
 *
 * `canonicalContent` is the single definition of "what was approved" for each record type.
 */
import { createHash } from "node:crypto";
import type {
  Acquisition,
  Agreement,
  Assertion,
  Corpus,
  Disclosure,
  FinancingRound,
  Participation,
  Provenance,
} from "../../src/domain/schema/corpus";

/** JSON with recursively sorted keys, so semantically equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type ReviewedKind =
  "assertion" | "round" | "disclosure" | "participation" | "agreement" | "acquisition";

export function canonicalContent(
  kind: ReviewedKind,
  record: Provenance & Record<string, unknown>,
): unknown {
  const ev = record.evidence;
  const epistemic = record.epistemic;
  switch (kind) {
    case "assertion": {
      const a = record as unknown as Assertion;
      return {
        kind,
        epistemic,
        subjectId: a.subjectId,
        predicate: a.predicate,
        value: a.value,
        primary: a.primary,
        validFrom: a.validFrom,
        validTo: a.validTo,
        ev,
      };
    }
    case "round": {
      const r = record as unknown as FinancingRound;
      return {
        kind,
        epistemic,
        companyId: r.companyId,
        eventState: r.eventState,
        label: r.roundLabelAsStated,
        stage: r.stage,
        instrument: r.instrument,
        proceeds: r.proceeds,
        completeness: r.participantsCompleteness,
        ev,
      };
    }
    case "disclosure": {
      const d = record as unknown as Disclosure;
      return {
        kind,
        epistemic,
        date: d.date,
        dkind: d.kind,
        amount: d.amount,
        basis: d.amountBasis,
        nature: d.amountNature,
        ev,
      };
    }
    case "participation": {
      const p = record as unknown as Participation;
      return {
        kind,
        epistemic,
        reportedName: p.reportedName,
        investorId: p.investorId,
        vehicleId: p.vehicleId,
        role: p.role,
        ev,
      };
    }
    case "agreement": {
      const g = record as unknown as Agreement;
      return {
        kind,
        epistemic,
        family: g.family,
        type: g.type,
        // Only when present, so the hash of every record without one is unchanged.
        ...(g.sourceClassification ? { sourceClassification: g.sourceClassification } : {}),
        title: g.title,
        parties: g.parties,
        rows: g.disclosureRows,
        statements: g.valueStatements,
        allocations: g.allocations,
        repayability: g.repayability,
        ev,
      };
    }
    case "acquisition": {
      const q = record as unknown as Acquisition;
      return {
        kind,
        epistemic,
        targetId: q.targetId,
        acquirerId: q.acquirerId,
        history: q.history,
        consideration: q.consideration,
        reported: q.reportedConsideration,
        ev,
      };
    }
  }
}

/**
 * Content hashes memoised for the duration of one compile (see `withReviewHashCache`). The compiler
 * checks the same record many times (every fact, view and gate); recomputing the canonical hash each
 * time was the largest compile cost at scale (bench/stress, 2026-10-14). Outside a compile there is
 * no cache: review tools and tests always recompute.
 */
let hashCache: WeakMap<object, Map<ReviewedKind, string>> | null = null;

/**
 * Runs `fn` with review hashes memoised per record object. Only safe while records are not
 * modified, which holds inside `compile` (it works on its own parsed copy of the corpus).
 */
export function withReviewHashCache<T>(fn: () => T): T {
  const previous = hashCache;
  hashCache = new WeakMap();
  try {
    return fn();
  } finally {
    hashCache = previous;
  }
}

export function reviewHashFor(
  kind: ReviewedKind,
  record: Provenance & Record<string, unknown>,
): string {
  if (!hashCache) return sha256(canonicalJson(canonicalContent(kind, record)));
  let byKind = hashCache.get(record);
  if (!byKind) hashCache.set(record, (byKind = new Map()));
  const hit = byKind.get(kind);
  if (hit !== undefined) return hit;
  const hash = sha256(canonicalJson(canonicalContent(kind, record)));
  byKind.set(kind, hash);
  return hash;
}

/** True only for a verified record whose review hash matches its current content. */
export function hasValidReview(
  kind: ReviewedKind,
  record: Provenance & Record<string, unknown>,
): boolean {
  return (
    record.verification === "verified" &&
    record.review !== null &&
    record.review.hash === reviewHashFor(kind, record)
  );
}

/**
 * True when a record's review still matches its content, whatever its current state. Used only to
 * show a superseded value as history; a current value always needs `hasValidReview`.
 */
export function hasIntactReview(
  kind: ReviewedKind,
  record: Provenance & Record<string, unknown>,
): boolean {
  return record.review !== null && record.review.hash === reviewHashFor(kind, record);
}

/**
 * DEMO ONLY: stamp a fixture review on every record marked `verified`. Real corpora are reviewed
 * exclusively by the owner via the review CLI; the compiler refuses sealed records outside demo
 * builds (gate `demo-isolation` + reviewer check).
 */
export function sealDemoCorpus(corpus: Corpus, at: string): Corpus {
  if (!corpus.isDemo) throw new Error("sealDemoCorpus may only be used on demo corpora");
  const seal = <T extends Provenance & Record<string, unknown>>(kind: ReviewedKind, record: T): T =>
    // Superseded fixtures were verified when approved, so they carry a review too.
    record.verification === "verified" || record.verification === "superseded"
      ? { ...record, review: { by: "demo-fixture", at, hash: reviewHashFor(kind, record) } }
      : record;
  return {
    ...corpus,
    assertions: corpus.assertions.map((a) => seal("assertion", a)),
    rounds: corpus.rounds.map((r) =>
      seal("round", {
        ...r,
        disclosures: r.disclosures.map((d) => seal("disclosure", d)),
        participations: r.participations.map((p) => seal("participation", p)),
      }),
    ),
    agreements: corpus.agreements.map((g) => seal("agreement", g)),
    acquisitions: corpus.acquisitions.map((q) => seal("acquisition", q)),
  };
}
