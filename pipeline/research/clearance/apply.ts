/**
 * `candef apply-clearance` (P-60, docs/VERIFICATION_CLEARANCE.md section 8): OWNER ONLY.
 *
 * Turns the owner's answers in the exception queue into approvals and rejections:
 * - each answered decision group: "accept" applies the group's recommended action per record
 *   (shown on the card), "reject" rejects every record in it with the owner's note, any other
 *   answer leaves the records proposed;
 * - every cleared record, with basis `policy_clearance` (never "reviewed by the owner"), once the
 *   whole audit sample is answered; a "wrong" audit verdict holds every cleared record of that
 *   class; a cleared government row waits until its identity anchors are approved.
 *
 * It refuses when the clearance file, the policy version or any record changed since the queue
 * was made (a fresh run must reproduce the batch, every record hash and every state). The writer
 * is apply-tiers' (`applyTierPlan`): same review blocks, same all-or-nothing restore.
 *
 * Agents never call this on research/ (CLAUDE.md). Tests use fictional data only.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ReviewBasis } from "../../../src/domain/schema/corpus";
import { AuthoringError } from "../authoring";
import type { Decision } from "../decisions";
import type { TierApplyPlan } from "../tiers/apply";
import { POLICY_VERSION, type ClaimClass } from "./policy";
import type { ClearanceFile } from "./run";

const HEX64 = /^[0-9a-f]{64}$/;

export const AnswersFile = z
  .object({
    format: z.literal("candef-clearance-review"),
    prototype: z.boolean().optional(),
    batch: z.string().regex(HEX64),
    policy: z.string().max(40),
    exportedAt: z.string().max(40),
    answers: z.record(
      z.string().regex(/^[a-z-]+:[A-Za-z0-9_#.-]{1,200}$/),
      z
        .object({
          choice: z.enum([
            "accept",
            "alternative",
            "research",
            "unresolved",
            "reject",
            "correct",
            "wrong",
          ]),
          note: z.string().max(500).optional(),
          bulk: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type AnswersFile = z.infer<typeof AnswersFile>;

export function readAnswersFile(path: string): AnswersFile {
  const parsed = AnswersFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success)
    throw new AuthoringError(
      `answers file is not valid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return parsed.data;
}

export interface ClearanceApplyPlan extends TierApplyPlan {
  /** Cleared records not applied because an audit record of their class was marked wrong. */
  held: { id: string; cls: ClaimClass }[];
  /** Groups answered with something other than accept or reject: records stay proposed. */
  open: { key: string; choice: string; note: string | null }[];
  /** Groups with no answer. */
  unanswered: string[];
}

/** Checks the answers against a fresh run and sorts every record. Throws on any refusal. */
export function planClearanceApply(
  file: ClearanceFile,
  fresh: ClearanceFile,
  answers: AnswersFile,
): ClearanceApplyPlan {
  if (file.policy !== POLICY_VERSION || fresh.policy !== POLICY_VERSION)
    throw new AuthoringError(
      `the clearance file uses ${file.policy}; the current policy is ${POLICY_VERSION}. Run the clearance again.`,
    );
  if (answers.batch !== file.batch)
    throw new AuthoringError("these answers were exported from a different clearance batch");
  if (fresh.batch !== file.batch)
    throw new AuthoringError(
      "records, captures, returns or rules changed since the queue was made. Run the clearance again and answer the new queue.",
    );
  const freshById = new Map(fresh.records.map((r) => [r.id, r]));
  for (const r of file.records) {
    const f = freshById.get(r.id);
    if (!f || f.hash !== r.hash || f.state !== r.state)
      throw new AuthoringError(
        `record ${r.id} changed since the queue was made. Run the clearance again.`,
      );
  }
  const actions = (f: ClearanceFile) =>
    JSON.stringify(f.groups.map((g) => [g.key, g.actions]).sort());
  if (actions(fresh) !== actions(file))
    throw new AuthoringError(
      "the recommended actions changed since the queue was made. Run the clearance again.",
    );
  const known = new Set([...file.groups.map((g) => g.key), ...file.qc.map((q) => `qc:${q.id}`)]);
  const stray = Object.keys(answers.answers).filter((k) => !known.has(k));
  if (stray.length)
    throw new AuthoringError(`answers for unknown cards: ${stray.slice(0, 5).join(", ")}`);

  // The audit: every sampled record answered; a wrong one holds its class.
  const unanswered = file.qc.filter(
    (q) => !["correct", "wrong"].includes(answers.answers[`qc:${q.id}`]?.choice ?? ""),
  );
  if (unanswered.length)
    throw new AuthoringError(
      `the audit is incomplete: ${unanswered.length} sampled record(s) have no Correct or Wrong answer (${unanswered
        .slice(0, 5)
        .map((q) => q.id)
        .join(", ")})`,
    );
  const byId = new Map(file.records.map((r) => [r.id, r]));
  const wrongClasses = new Set(
    file.qc
      .filter((q) => answers.answers[`qc:${q.id}`]!.choice === "wrong")
      .map((q) => byId.get(q.id)!.cls),
  );

  const basis = (kind: ReviewBasis["kind"]): ReviewBasis => ({
    kind,
    rule: POLICY_VERSION,
    batch: file.batch,
  });
  const plan: ClearanceApplyPlan = {
    batch: [],
    approve: [],
    reject: [],
    waiting: [],
    skipped: [],
    held: [],
    open: [],
    unanswered: [],
  };
  const reject = (id: string, reason: string) => {
    const r = byId.get(id)!;
    const d: Decision = {
      id,
      kind: r.kind,
      hash: r.hash,
      decision: "reject",
      reason: reason.slice(0, 500),
      sourceOpened: true,
    };
    plan.reject.push(d);
  };

  // Groups: the owner's decisions (basis owner_judgement: the owner decided these records).
  for (const g of file.groups) {
    const a = answers.answers[g.key];
    if (!a) {
      plan.unanswered.push(g.key);
      continue;
    }
    if (a.choice === "accept") {
      for (const act of g.actions) {
        if (act.onAccept === "approve")
          plan.approve.push({ id: act.id, basis: basis("owner_judgement") });
        else if (act.onAccept === "reject")
          reject(
            act.id,
            a.note
              ? `${act.reason ?? ""} Owner: ${a.note}`
              : (act.reason ?? "rejected as recommended"),
          );
      }
    } else if (a.choice === "reject") {
      if (!a.note?.trim())
        throw new AuthoringError(`rejecting ${g.key} needs a reason in the note`);
      for (const id of g.records) reject(id, a.note);
    } else if (["alternative", "research", "unresolved"].includes(a.choice))
      plan.open.push({ key: g.key, choice: a.choice, note: a.note ?? null });
    else throw new AuthoringError(`${g.key}: "${a.choice}" is an audit answer, not a decision`);
  }

  // Cleared records: approved by the batch, with the policy basis.
  const approvedNow = new Set(plan.approve.map((x) => x.id));
  const rejectedNow = new Set(plan.reject.map((x) => x.id));
  for (const r of file.records) {
    if (r.state !== "cleared" && r.state !== "cleared_qc") continue;
    if (wrongClasses.has(r.cls)) {
      plan.held.push({ id: r.id, cls: r.cls });
      continue;
    }
    const open = r.conditionalOn.filter((id) => !approvedNow.has(id) || rejectedNow.has(id));
    if (open.length) plan.waiting.push({ id: r.id, anchors: open });
    else plan.batch.push({ id: r.id, basis: basis("policy_clearance") });
  }
  return plan;
}
