/**
 * Owner review decisions (docs/REVIEW_WORKSPACE.md).
 *
 * The workspace (workspace.ts) shows every proposed record as a REVIEW UNIT with a content hash; the
 * owner exports approve/reject decisions to a JSON file; `candef apply-decisions` (OWNER ONLY) plans
 * and applies them. A decision is applied only while the record still has the hash the owner saw.
 *
 * Agents never call `applyDecisions` on research/. Tests use temporary synthetic corpora only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Corpus, FinancingRound, Provenance } from "../../src/domain/schema/corpus";
import { canonicalJson, reviewHashFor, sha256 } from "../compile/hash";
import { AuthoringError } from "./authoring";
import { loadResearchCorpusUncached } from "./load";
import { approvableIds, rejectRecords, reviewRecords } from "./review";

export type UnitKind = "assertion" | "round" | "agreement" | "acquisition";

export interface ReviewUnit {
  id: string;
  kind: UnitKind;
  /** The organization the claim is about (fact subject, round company, recipient, target). */
  orgId: string;
  /** What an approval binds to; for a round it also covers its disclosures and participants. */
  hash: string;
  /** False when approving would be refused (evidence rule); the unit can still be rejected. */
  approvable: boolean;
}

type Rec = Provenance & Record<string, unknown>;

/** The content hash of a unit, recomputed identically at export and at apply time. */
export function unitHash(kind: UnitKind, record: Rec): string {
  if (kind !== "round") return reviewHashFor(kind, record);
  const r = record as unknown as FinancingRound & Rec;
  return sha256(
    canonicalJson([
      reviewHashFor("round", r),
      ...r.disclosures.map((d) => reviewHashFor("disclosure", d as unknown as Rec)),
      ...r.participations.map((p) => reviewHashFor("participation", p as unknown as Rec)),
    ]),
  );
}

const proposed = (r: Provenance) => r.verification === "proposed";

/** Every proposed record, as the units the owner decides on. */
export function reviewUnits(corpus: Corpus, today: string): ReviewUnit[] {
  const approvable = new Set(
    corpus.organizations.flatMap((o) => approvableIds(corpus, o.id, today)),
  );
  const unit = (kind: UnitKind, record: Rec & { id: string }, orgId: string): ReviewUnit => ({
    id: record.id,
    kind,
    orgId,
    hash: unitHash(kind, record),
    approvable: approvable.has(record.id),
  });
  return [
    ...corpus.assertions
      .filter(proposed)
      .map((a) => unit("assertion", a as unknown as Rec & { id: string }, a.subjectId)),
    ...corpus.rounds
      .filter(proposed)
      .map((r) => unit("round", r as unknown as Rec & { id: string }, r.companyId)),
    ...corpus.agreements.filter(proposed).map((g) => {
      const party =
        g.parties.find((p) => p.role === "recipient" || p.role === "prime") ?? g.parties[0];
      return unit("agreement", g as unknown as Rec & { id: string }, party?.orgId ?? "");
    }),
    ...corpus.acquisitions
      .filter(proposed)
      .map((q) => unit("acquisition", q as unknown as Rec & { id: string }, q.targetId)),
  ];
}

/** Fingerprint of a workspace: which units, at which content, on which day. */
export function workspaceFingerprint(units: ReviewUnit[], generatedAt: string): string {
  return sha256(canonicalJson({ generatedAt, units: units.map((u) => [u.id, u.hash]) }));
}

const HEX64 = /^[0-9a-f]{64}$/;
export const MAX_DECISIONS = 20_000;

export const Decision = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_:#.-]{1,200}$/),
    kind: z.enum(["assertion", "round", "agreement", "acquisition"]),
    hash: z.string().regex(HEX64),
    decision: z.enum(["approve", "reject"]),
    reason: z.string().max(500).optional(),
    /** Whether the owner opened at least one of the unit's sources or captures in the workspace. */
    sourceOpened: z.boolean(),
  })
  .strict();
export type Decision = z.infer<typeof Decision>;

export const DecisionsFile = z
  .object({
    format: z.literal("candef-review-decisions"),
    version: z.literal(1),
    workspace: z
      .object({ fingerprint: z.string().regex(HEX64), generatedAt: z.string().max(40) })
      .strict(),
    exportedAt: z.string().max(40),
    decisions: z.array(Decision).max(MAX_DECISIONS),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const d of f.decisions) {
      if (seen.has(d.id))
        ctx.addIssue({ code: "custom", message: `two decisions for ${d.id}; export again` });
      seen.add(d.id);
      if (d.decision === "reject" && !d.reason?.trim())
        ctx.addIssue({ code: "custom", message: `rejecting ${d.id} needs a reason` });
    }
  });
export type DecisionsFile = z.infer<typeof DecisionsFile>;

/** An audit verdict on a record drawn into a tiers batch's audit sample (VERIFICATION_TIERS.md 5). */
export const AuditVerdict = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_:#.-]{1,200}$/),
    hash: z.string().regex(HEX64),
    verdict: z.enum(["confirm", "wrong"]),
    reason: z.string().max(500).optional(),
    sourceOpened: z.boolean(),
  })
  .strict();
export type AuditVerdict = z.infer<typeof AuditVerdict>;

/**
 * Version 2: decisions exported from a workspace built with a tiers batch. The owner's tier 3 and
 * exception decisions, plus the audit verdicts. Only `apply-tiers` reads it.
 */
export const TierDecisionsFile = z
  .object({
    format: z.literal("candef-review-decisions"),
    version: z.literal(2),
    workspace: z
      .object({ fingerprint: z.string().regex(HEX64), generatedAt: z.string().max(40) })
      .strict(),
    tiers: z.object({ batch: z.string().regex(HEX64) }).strict(),
    exportedAt: z.string().max(40),
    decisions: z.array(Decision).max(MAX_DECISIONS),
    audit: z.array(AuditVerdict).max(1000),
  })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    for (const d of [...f.decisions, ...f.audit]) {
      if (seen.has(d.id))
        ctx.addIssue({ code: "custom", message: `two entries for ${d.id}; export again` });
      seen.add(d.id);
    }
    for (const d of f.decisions)
      if (d.decision === "reject" && !d.reason?.trim())
        ctx.addIssue({ code: "custom", message: `rejecting ${d.id} needs a reason` });
    for (const a of f.audit)
      if (a.verdict === "wrong" && !a.reason?.trim())
        ctx.addIssue({ code: "custom", message: `marking ${a.id} wrong needs a reason` });
  });
export type TierDecisionsFile = z.infer<typeof TierDecisionsFile>;

function readJson(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (text.length > 10_000_000) throw new AuthoringError("decisions file is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new AuthoringError("decisions file is not valid JSON");
  }
}

/** Reads and strictly validates a version 2 (tiers) decisions file (untrusted input). */
export function readTierDecisionsFile(path: string): TierDecisionsFile {
  const parsed = TierDecisionsFile.safeParse(readJson(path));
  if (!parsed.success)
    throw new AuthoringError(
      `tier decisions file is not valid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  return parsed.data;
}

/** Reads and strictly validates a decisions file (untrusted input). */
export function readDecisionsFile(path: string): DecisionsFile {
  const json = readJson(path);
  if ((json as { version?: unknown })?.version === 2)
    throw new AuthoringError(
      "this decisions file comes from a tiers workspace; apply it with `candef apply-tiers`",
    );
  const parsed = DecisionsFile.safeParse(json);
  if (!parsed.success)
    throw new AuthoringError(
      `decisions file is not valid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  return parsed.data;
}

export interface DecisionPlan {
  approve: Decision[];
  reject: Decision[];
  /** Approvals whose sources were never opened in the workspace (need a second confirmation). */
  unopened: Decision[];
  /** Record edited since the workspace was generated: the owner did not see this content. */
  stale: Decision[];
  unknown: Decision[];
  notProposed: Decision[];
  /** Approvals of records that fail their evidence rule. */
  refused: Decision[];
}

/** Sorts each decision into what will happen to it. Nothing is written. */
export function planDecisions(corpus: Corpus, file: DecisionsFile, today: string): DecisionPlan {
  const plan: DecisionPlan = {
    approve: [],
    reject: [],
    unopened: [],
    stale: [],
    unknown: [],
    notProposed: [],
    refused: [],
  };
  const units = new Map(reviewUnits(corpus, today).map((u) => [u.id, u]));
  const all = new Map<string, Rec>([
    ...corpus.assertions.map((a) => [a.id, a as unknown as Rec] as const),
    ...corpus.rounds.map((r) => [r.id, r as unknown as Rec] as const),
    ...corpus.agreements.map((g) => [g.id, g as unknown as Rec] as const),
    ...corpus.acquisitions.map((q) => [q.id, q as unknown as Rec] as const),
  ]);
  for (const d of file.decisions) {
    const record = all.get(d.id);
    const unit = units.get(d.id);
    if (!record) plan.unknown.push(d);
    else if (!unit) plan.notProposed.push(d);
    else if (unit.kind !== d.kind || unit.hash !== d.hash) plan.stale.push(d);
    else if (d.decision === "reject") plan.reject.push(d);
    else if (!unit.approvable) plan.refused.push(d);
    else if (!d.sourceOpened) plan.unopened.push(d);
    else plan.approve.push(d);
  }
  return plan;
}

export interface ApplyRequest {
  reviewer: string;
  at: string;
  /** Approve the unopened approvals too (the owner typed the second confirmation). */
  includeUnopened: boolean;
}

/**
 * OWNER ONLY. Re-plans against the current research/ (so nothing changed between planning and
 * writing), then approves and rejects. All touched files are restored if anything fails.
 */
export function applyDecisions(
  root: string,
  file: DecisionsFile,
  req: ApplyRequest,
): { approved: string[]; rejected: string[]; plan: DecisionPlan } {
  const loaded = loadResearchCorpusUncached(root);
  if (!loaded.corpus)
    throw new AuthoringError("research/ does not validate; run `candef validate`");
  const plan = planDecisions(loaded.corpus, file, req.at);
  const approve = [...plan.approve, ...(req.includeUnopened ? plan.unopened : [])].map((d) => d.id);
  const reject = plan.reject.map((d) => d.id);
  const files = new Set(
    [...approve, ...reject]
      .map((id) => loaded.origins.get(id)?.file)
      .filter((f): f is string => !!f),
  );
  const originals = new Map([...files].map((f) => [f, readFileSync(join(root, f), "utf8")]));
  try {
    const approved = approve.length
      ? reviewRecords(root, { ids: approve, reviewer: req.reviewer, at: req.at }).reviewed
      : [];
    const rejected = reject.length
      ? rejectRecords(root, {
          ids: reject,
          reviewer: req.reviewer,
          at: req.at,
          reasons: Object.fromEntries(plan.reject.map((d) => [d.id, d.reason ?? ""])),
        }).rejected
      : [];
    return { approved, rejected, plan };
  } catch (e) {
    for (const [f, text] of originals) writeFileSync(join(root, f), text);
    throw e;
  }
}
