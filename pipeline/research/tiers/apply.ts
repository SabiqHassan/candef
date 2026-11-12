/**
 * `candef apply-tiers` (docs/VERIFICATION_TIERS.md section 6): OWNER ONLY.
 *
 * Applies one tiers batch: the owner's tier 3 and exception decisions, then every tier 1 and tier 2
 * pass, each approval carrying its basis (section 6.1). It refuses when anything changed since the
 * tiers file was written (records, captures, worksheet, plan or rule version: the batch hash), when
 * the decisions were exported from another batch, and when the audit sample is incomplete or has
 * any "wrong" verdict.
 *
 * Agents never call `applyTierPlan` on research/ (CLAUDE.md). Tests use temporary fictional
 * corpora only. The CLI additionally requires an interactive terminal and a typed confirmation.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewBasis } from "../../../src/domain/schema/corpus";
import { AuthoringError } from "../authoring";
import type { Decision, TierDecisionsFile } from "../decisions";
import { loadResearchCorpus } from "../load";
import { rejectRecords, reviewRecords } from "../review";
import { RULES_VERSION, type TierRecord } from "./rules";
import type { TiersFile } from "./run";

export interface TierApplyPlan {
  /** Passed tier 1 or 2 (or conditional with every anchor approved): approved by the batch. */
  batch: { id: string; basis: ReviewBasis }[];
  /** The owner's approvals of tier 3 items and exceptions. */
  approve: { id: string; basis: ReviewBasis }[];
  reject: Decision[];
  /** Conditional tier 1 records left out because an anchor was not approved. */
  waiting: { id: string; anchors: string[] }[];
  /** Owner decisions skipped: record changed, unknown, or not shown for a decision. */
  skipped: { id: string; why: string }[];
}

/**
 * Checks the batch and decisions against a fresh evaluation and sorts every record into what will
 * happen to it. Throws on any refusal. Nothing is written.
 */
export function planTierApply(
  tiers: TiersFile,
  fresh: { batch: string; records: TierRecord[] },
  file: TierDecisionsFile,
): TierApplyPlan {
  if (tiers.rules !== RULES_VERSION)
    throw new AuthoringError(
      `the tiers file uses ${tiers.rules}; the current rules are ${RULES_VERSION}. Run candef tiers again.`,
    );
  if (file.tiers.batch !== tiers.batch)
    throw new AuthoringError("these decisions were exported from a different tiers batch");
  if (fresh.batch !== tiers.batch)
    throw new AuthoringError(
      "records, captures, the worksheet, the plan or the rules changed since the tiers file was written. Run candef tiers again and review the new batch.",
    );
  const byId = new Map(fresh.records.map((r) => [r.id, r]));

  // The audit: every sampled record confirmed, at the content the owner saw.
  const verdicts = new Map(file.audit.map((a) => [a.id, a]));
  const wrong = file.audit.filter((a) => a.verdict === "wrong");
  if (wrong.length)
    throw new AuthoringError(
      `the audit found ${wrong.length} wrong record(s) (${wrong.map((a) => a.id).join(", ")}): the whole batch is refused. Fix and test the failing rule, then run candef tiers again.`,
    );
  const missing = tiers.audit.filter((id) => verdicts.get(id)?.verdict !== "confirm");
  if (missing.length)
    throw new AuthoringError(
      `the audit is incomplete: ${missing.length} sampled record(s) are not confirmed (${missing.slice(0, 5).join(", ")})`,
    );
  for (const id of tiers.audit)
    if (verdicts.get(id)!.hash !== byId.get(id)?.hash)
      throw new AuthoringError(`audit record ${id} changed after it was checked`);
  const extra = file.audit.filter((a) => !tiers.audit.includes(a.id));
  if (extra.length)
    throw new AuthoringError(`audit verdicts for records outside the sample: ${extra[0]!.id}`);

  const plan: TierApplyPlan = { batch: [], approve: [], reject: [], waiting: [], skipped: [] };
  const basis = (kind: ReviewBasis["kind"]): ReviewBasis => ({
    kind,
    rule: RULES_VERSION,
    batch: tiers.batch,
  });
  const rejected = new Set<string>();
  for (const d of file.decisions) {
    const r = byId.get(d.id);
    if (!r) plan.skipped.push({ id: d.id, why: "not a proposed record" });
    else if (r.hash !== d.hash || r.kind !== d.kind)
      plan.skipped.push({ id: d.id, why: "record changed since the workspace" });
    else if (r.status !== "judgement" && r.status !== "exception")
      plan.skipped.push({ id: d.id, why: "passed its tier; decided by the batch" });
    else if (d.decision === "reject") {
      plan.reject.push(d);
      rejected.add(d.id);
    } else
      plan.approve.push({
        id: d.id,
        basis: basis(r.status === "judgement" ? "owner_judgement" : "owner_record"),
      });
  }
  const approvedNow = new Set(plan.approve.map((a) => a.id));
  for (const r of fresh.records) {
    if (r.status === "pass")
      plan.batch.push({
        id: r.id,
        basis: basis(r.tier === 1 ? "tier1_dataset_match" : "tier2_source_check"),
      });
    else if (r.status === "conditional") {
      const open = r.dependsOn.filter((a) => !approvedNow.has(a) || rejected.has(a));
      if (open.length) plan.waiting.push({ id: r.id, anchors: open });
      else plan.batch.push({ id: r.id, basis: basis("tier1_dataset_match") });
    }
  }
  return plan;
}

export interface TierApplyRequest {
  reviewer: string;
  at: string;
}

/**
 * OWNER ONLY. Writes the plan: approvals with their basis, rejections with the owner's reasons. All
 * touched files are restored if anything fails.
 */
export function applyTierPlan(
  root: string,
  plan: TierApplyPlan,
  req: TierApplyRequest,
): { approved: string[]; rejected: string[] } {
  const loaded = loadResearchCorpus(root);
  if (!loaded.corpus)
    throw new AuthoringError("research/ does not validate; run `candef validate`");
  const approvals = [...plan.approve, ...plan.batch];
  const ids = [...approvals.map((a) => a.id), ...plan.reject.map((d) => d.id)];
  const files = new Set(
    ids.map((id) => loaded.origins.get(id)?.file).filter((f): f is string => !!f),
  );
  const originals = new Map([...files].map((f) => [f, readFileSync(join(root, f), "utf8")]));
  try {
    const approved = approvals.length
      ? reviewRecords(root, {
          ids: approvals.map((a) => a.id),
          reviewer: req.reviewer,
          at: req.at,
          bases: Object.fromEntries(approvals.map((a) => [a.id, a.basis])),
        }).reviewed
      : [];
    const rejected = plan.reject.length
      ? rejectRecords(root, {
          ids: plan.reject.map((d) => d.id),
          reviewer: req.reviewer,
          at: req.at,
          reasons: Object.fromEntries(plan.reject.map((d) => [d.id, d.reason ?? ""])),
        }).rejected
      : [];
    return { approved, rejected };
  } catch (e) {
    for (const [f, text] of originals) writeFileSync(join(root, f), text);
    throw e;
  }
}
