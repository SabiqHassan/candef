/**
 * Owner approval and rejection (M3-B5, docs/REVIEW_WORKSPACE.md): writes hash-bound review blocks
 * into research/ YAML.
 *
 * OWNER ONLY. Agents (Claude, Codex, subagents) must never call this on research/ (CLAUDE.md).
 * The `candef review` CLI additionally requires an interactive terminal and a typed confirmation.
 * Tests exercise this function only on temporary synthetic corpora.
 *
 * Guarantees:
 *   - the review hash is computed by the same function the compiler uses (`reviewHashFor`);
 *   - a round is approved together with its disclosures and participations;
 *   - records that would fail their evidence rule are refused (approving them publishes nothing);
 *   - after writing, the corpus is re-loaded and every new review must validate, or all edited
 *     files are restored and the call fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, parseDocument, type Document } from "yaml";
import type { Corpus, Provenance, ReviewBasis } from "../../src/domain/schema/corpus";
import { FactIndex } from "../compile/facts";
import { hasIntactReview, hasValidReview, reviewHashFor, type ReviewedKind } from "../compile/hash";
import { AuthoringError } from "./authoring";
import { loadResearchCorpus, type Origin } from "./load";

/** Reviewer names that must never sign an approval. */
export const NOT_A_REVIEWER = /^(demo-fixture|agent:|pipeline:)|claude|codex|gemini|gpt|bot\b/i;

export interface ReviewRequest {
  ids: string[];
  reviewer: string;
  /** ISO date of the review. */
  at: string;
  /** How each approval was reached (D-21), by record ID; a round's basis covers its parts. */
  bases?: Record<string, ReviewBasis>;
}

interface Target {
  kind: ReviewedKind;
  record: Provenance & Record<string, unknown>;
  origin: Origin;
  /** Participations have no ID: located by their round and position. */
  roundId?: string;
  index?: number;
}

/**
 * Proposed records about one organization that could be approved as they stand: facts passing their
 * evidence rule, and rounds, agreements (as recipient or prime) and acquisitions that cite evidence.
 * Shared by the review report and `candef review --org`, so both always list the same IDs.
 */
export function approvableIds(corpus: Corpus, orgId: string, today: string): string[] {
  const facts = new FactIndex(corpus, today);
  const sources = new Set(corpus.sources.map((s) => s.id));
  const cited = (r: Provenance) =>
    r.evidence.length > 0 && r.evidence.every((e) => sources.has(e.sourceId));
  const proposed = (r: Provenance) => r.verification === "proposed";
  return [
    ...corpus.assertions
      .filter((a) => a.subjectId === orgId && proposed(a) && facts.meetsEvidenceRule(a))
      .map((a) => a.id),
    ...corpus.rounds
      .filter((r) => r.companyId === orgId && proposed(r) && cited(r))
      .map((r) => r.id),
    ...corpus.agreements
      .filter(
        (g) =>
          proposed(g) &&
          cited(g) &&
          g.parties.some(
            (p) => p.orgId === orgId && (p.role === "prime" || p.role === "recipient"),
          ),
      )
      .map((g) => g.id),
    ...corpus.acquisitions
      .filter((q) => q.targetId === orgId && proposed(q) && cited(q))
      .map((q) => q.id),
  ];
}

export function reviewRecords(root: string, req: ReviewRequest): { reviewed: string[] } {
  return writeReviews(root, req, "verified");
}

export interface RejectRequest extends ReviewRequest {
  /** The owner's reason per record ID (required, at most 500 characters). */
  reasons: Record<string, string>;
}

/**
 * OWNER ONLY, like `reviewRecords`: marks records `rejected` with a hash-bound review carrying the
 * owner's reason. Rejected records are never published and stay in research/ as history. A round is
 * rejected together with its disclosures and participations.
 */
export function rejectRecords(root: string, req: RejectRequest): { rejected: string[] } {
  for (const id of req.ids) {
    const reason = req.reasons[id]?.trim();
    if (!reason) throw new AuthoringError(`rejecting ${id} needs a reason`);
    if (reason.length > 500)
      throw new AuthoringError(`the reason for ${id} is over 500 characters`);
  }
  return { rejected: writeReviews(root, req, "rejected").reviewed };
}

function checkReviewer(reviewer: string) {
  if (!reviewer.trim() || NOT_A_REVIEWER.test(reviewer))
    throw new AuthoringError(`"${reviewer}" cannot sign reviews; approvals are the owner's`);
}

function writeReviews(
  root: string,
  req: ReviewRequest | RejectRequest,
  outcome: "verified" | "rejected",
): { reviewed: string[] } {
  checkReviewer(req.reviewer);
  const loaded = loadResearchCorpus(root);
  if (!loaded.corpus)
    throw new AuthoringError("research/ does not validate; run `candef validate`");
  const corpus = loaded.corpus;
  const facts = new FactIndex(corpus, req.at);
  const reasons = "reasons" in req ? req.reasons : {};

  const targets: (Target & { note?: string; basis?: ReviewBasis })[] = [];
  for (const id of req.ids) {
    const origin = loaded.origins.get(id);
    const assertion = corpus.assertions.find((a) => a.id === id);
    const round = corpus.rounds.find((r) => r.id === id);
    const agreement = corpus.agreements.find((g) => g.id === id);
    const acquisition = corpus.acquisitions.find((q) => q.id === id);
    if (!origin || !(assertion || round || agreement || acquisition))
      throw new AuthoringError(`unknown or unreviewable record ${id}`);
    const note = outcome === "rejected" ? reasons[id]!.trim() : undefined;
    const basis = outcome === "verified" ? req.bases?.[id] : undefined;
    if (assertion) {
      // Only approvals need the evidence rule; a claim can always be rejected.
      if (outcome === "verified" && !facts.meetsEvidenceRule(assertion))
        throw new AuthoringError(
          `${id} fails its evidence rule (missing source, related-link only, anonymous source, or city-level HQ without first-party evidence); approving it would publish nothing`,
        );
      targets.push({ kind: "assertion", record: assertion, origin, note, basis });
    } else if (round) {
      targets.push({ kind: "round", record: round, origin, note, basis });
      round.disclosures.forEach((d, j) =>
        targets.push({
          kind: "disclosure",
          record: d,
          origin: { ...origin, path: [...origin.path, "disclosures", j] },
          note,
          basis,
        }),
      );
      round.participations.forEach((p, j) =>
        targets.push({
          kind: "participation",
          record: p,
          origin: { ...origin, path: [...origin.path, "participations", j] },
          roundId: round.id,
          index: j,
          note,
          basis,
        }),
      );
    } else if (agreement)
      targets.push({ kind: "agreement", record: agreement, origin, note, basis });
    else if (acquisition)
      targets.push({ kind: "acquisition", record: acquisition, origin, note, basis });
  }
  if (outcome === "verified")
    for (const t of targets)
      if (t.record.evidence.length === 0 && t.record.epistemic === "sourced_fact")
        throw new AuthoringError(`a ${t.kind} in ${t.origin.file} has no evidence`);

  const docs = new Map<string, { original: string; doc: Document }>();
  for (const t of targets) {
    if (!docs.has(t.origin.file)) {
      const original = readFileSync(join(root, t.origin.file), "utf8");
      docs.set(t.origin.file, { original, doc: parseDocument(original) });
    }
    const { doc } = docs.get(t.origin.file)!;
    const node = doc.getIn(t.origin.path, true);
    if (!isMap(node))
      throw new AuthoringError(`${t.origin.file}:${t.origin.path.join(".")} is not a mapping`);
    const hash = reviewHashFor(t.kind, { ...t.record, verification: outcome });
    node.set("verification", outcome);
    node.set(
      "review",
      doc.createNode({
        by: req.reviewer,
        at: req.at,
        hash,
        ...(t.note === undefined ? {} : { note: t.note }),
        ...(t.basis ? { basis: t.basis } : {}),
      }),
    );
  }
  for (const [file, { doc }] of docs) writeFileSync(join(root, file), doc.toString());

  // Post-condition: the reloaded corpus must carry exactly the reviews just written.
  const after = loadResearchCorpus(root).corpus;
  const reloaded = (t: Target): unknown => {
    if (!after) return undefined;
    if (t.kind === "participation")
      return after.rounds.find((r) => r.id === t.roundId)?.participations[t.index!];
    const id = (t.record as { id?: string }).id;
    return [
      ...after.assertions,
      ...after.rounds,
      ...after.rounds.flatMap((r) => r.disclosures),
      ...after.agreements,
      ...after.acquisitions,
    ].find((r) => r.id === id);
  };
  const ok = targets.every((t) => {
    const rec = reloaded(t) as (Provenance & Record<string, unknown>) | undefined;
    if (!rec) return false;
    return outcome === "verified"
      ? hasValidReview(t.kind, rec)
      : rec.verification === "rejected" && hasIntactReview(t.kind, rec);
  });
  if (!ok) {
    for (const [file, { original }] of docs) writeFileSync(join(root, file), original);
    throw new AuthoringError(
      "a written review did not validate after reload; all edits were reverted",
    );
  }
  return {
    reviewed: targets.map(
      (t) => (t.record as { id?: string }).id ?? `${t.origin.file}:${t.origin.path.join(".")}`,
    ),
  };
}
