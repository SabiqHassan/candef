/**
 * Verification clearance policy, draft 0.1 (docs/VERIFICATION_CLEARANCE.md).
 *
 * The policy is data: which class a claim belongs to, which checks a class needs before it can be
 * cleared without an individual owner decision, how unresolved work climbs the escalation ladder,
 * and when the ladder stops. Code and documentation both read it, so the rule text and the rule
 * engine cannot drift apart.
 *
 * NOTHING HERE APPROVES OR PUBLISHES. `POLICY_ACTIVE` is false and no code path reads it to write
 * research/. Clearance is a computed, read-only state in research-cache/clearance/. The owner's
 * apply step (apply-tiers) and the publication rules are unchanged until the owner approves a
 * policy version in DECISION_LOG.md.
 */

export const POLICY_VERSION = "clearance@1";
/**
 * Adopted by the owner (P-60, 2026-10-20). "Active" means batches are prepared with it; nothing
 * is approved until the owner runs `candef apply-clearance` in their own terminal.
 */
export const POLICY_ACTIVE = true;

/**
 * Risk classes. The class sets the bar, not a confidence number:
 * - K1 dataset record: a row in an official dataset is the original (federal contracts, grants).
 * - K2 simple sourced fact: one value with one right answer in an original document.
 * - K3 event: a dated event with amounts and parties (financing rounds, non-federal agreements).
 * - K4 consequential or judgement: identity, scope, structure, lineage, interpretation. Never
 *   cleared automatically; the system prepares the evidence and a recommendation.
 */
export type ClaimClass = "K1" | "K2" | "K3" | "K4";

export const CLASS_LABEL: Record<ClaimClass, string> = {
  K1: "dataset record",
  K2: "simple sourced fact",
  K3: "event (round or agreement)",
  K4: "consequential or judgement",
};

/**
 * Outcome states. Exactly one per record. `homework` is work the system can still do itself; it is
 * never shown to the owner as a decision.
 */
export type ClearanceState =
  | "cleared" // passed every check its class needs; no exception
  | "cleared_qc" // cleared, and drawn for the quality-control audit
  | "homework" // the ladder has an automated next step (re-run, link, read, research)
  | "needs_owner" // a genuine judgement or consequential uncertainty remains
  | "contradictory" // original sources disagree materially after the ladder
  | "insufficient" // cannot be verified with the evidence available; held, not published
  | "incorrect"; // evidence shows the record is wrong; held, correction drafted

export const STATE_LABEL: Record<ClearanceState, string> = {
  cleared: "Verified, no exception",
  cleared_qc: "Verified, drawn for the quality-control audit",
  homework: "Automated work outstanding (not a decision)",
  needs_owner: "Needs owner judgement",
  contradictory: "Contradictory sources",
  insufficient: "Insufficient evidence (held)",
  incorrect: "Evidence shows it is wrong (held)",
};

/**
 * Check IDs. Each check returns pass, fail or n/a with a reason (checks.ts, route.ts).
 * V-ev   evidence rule of the predicate passes (meetsEvidenceRule)
 * V-src  every evidence item cites a T1 or T2 source (official or first party)
 * V-copy each key value is found in a saved copy of a cited source, or in the cited dataset row
 * V-ent  the evidence is about this legal entity (anchored row, entity name in the copy, own site)
 * V-ind  an independent researcher's finding supports the value (not silence, not same researcher)
 * V-con  no unresolved contradiction: no independent finding gives a different value for the same
 *        entity and period, no CANDEF record disagrees, no reconciliation case is open
 * V-norm dates, currencies, amounts and disclosure sequences are well formed
 * V-dup  no likely duplicate (same company, amount and currency within 90 days)
 * V-row  government rows: exact row match, owner-approved identity anchor, roles (tier 1 rules)
 * V-time the evidence is not older than the legal entity it is attributed to
 */
export type CheckId =
  | "V-ev"
  | "V-src"
  | "V-copy"
  | "V-ent"
  | "V-ind"
  | "V-con"
  | "V-norm"
  | "V-dup"
  | "V-row"
  | "V-time";

/** Checks a class must pass to be cleared. K4 is never cleared, whatever its checks say. */
export const REQUIRED: Record<ClaimClass, CheckId[]> = {
  K1: ["V-ev", "V-row", "V-con", "V-norm"],
  K2: ["V-ev", "V-src", "V-copy", "V-ent", "V-ind", "V-con", "V-norm", "V-time"],
  K3: ["V-ev", "V-src", "V-copy", "V-ent", "V-ind", "V-con", "V-norm", "V-dup", "V-time"],
  K4: [],
};

/**
 * Original-authority rule: for a K2 fact whose value is found in a saved copy of an official
 * record (registry, filing, government dataset or publication, i.e. a T1 source), independent
 * corroboration (V-ind) is not required. An original official document outranks AI agreement;
 * the audit sample still covers these records.
 */
export const AUTHORITY_WAIVES_CORROBORATION: ReadonlySet<ClaimClass> = new Set(["K2"]);

/** The escalation ladder (section 4 of the policy document). */
export type LadderStep =
  | "1-deterministic" // re-run, re-link, recompute, row or copy check
  | "2-original-source" // read the original (verification read, find the original of a T3 claim)
  | "3-targeted-research" // a blind task for an independent researcher
  | "4-stronger-model" // an adjudication note by a stronger model (Opus), with evidence
  | "5-owner"; // a decision only the owner can make

/** Automated next actions. Each names its ladder step and its budget. */
export type HomeworkKind =
  | "rerun-worksheet"
  | "link-capture"
  | "verification-read"
  | "find-original"
  | "blind-task"
  | "inventory-task"
  | "read-contradicting-source"
  | "reread-copy"
  | "fix-record"
  | "adjudicate";

export const HOMEWORK: Record<
  HomeworkKind,
  { step: LadderStep; label: string; maxAttempts: number; whoRuns: string }
> = {
  "rerun-worksheet": {
    step: "1-deterministic",
    label: "Re-run the blind worksheet against the current record",
    maxAttempts: 1,
    whoRuns: "code (automatic)",
  },
  "link-capture": {
    step: "1-deterministic",
    label: "Link the evidence to the saved copy that already exists",
    maxAttempts: 1,
    whoRuns: "code (scripts/research/link-captures.ts)",
  },
  "verification-read": {
    step: "2-original-source",
    label:
      "Read the live page once, match the value, keep only hashes and the match offset (site forbids saved copies)",
    maxAttempts: 2,
    whoRuns: "Claude session (P-61; scripts/research/verification-read.ts)",
  },
  "find-original": {
    step: "2-original-source",
    label: "Find and capture the original source behind a secondary report",
    maxAttempts: 2,
    whoRuns: "Claude session",
  },
  "blind-task": {
    step: "3-targeted-research",
    label: "Targeted blind question to an independent researcher (any AI, owner pastes)",
    maxAttempts: 2,
    whoRuns: "external AI via task packet, or a Claude subagent",
  },
  "inventory-task": {
    step: "3-targeted-research",
    label:
      "Independent event inventory (every round, deal or agreement the researcher can document)",
    maxAttempts: 2,
    whoRuns: "external AI via task packet",
  },
  "read-contradicting-source": {
    step: "2-original-source",
    label: "Open the source a contradicting researcher cited and check what it says",
    maxAttempts: 1,
    whoRuns: "Claude session",
  },
  "reread-copy": {
    step: "2-original-source",
    label:
      "The saved copy exists but the matcher did not find the value: read the copy and record where it says it, or mark the value unsupported",
    maxAttempts: 1,
    whoRuns: "Claude session",
  },
  "fix-record": {
    step: "1-deterministic",
    label:
      "Correct a malformed proposed record (date, currency, tranche): the correction is a new proposed record",
    maxAttempts: 1,
    whoRuns: "Claude session",
  },
  adjudicate: {
    step: "4-stronger-model",
    label: "Adjudication note by a stronger model: evidence for each reading, recommendation",
    maxAttempts: 1,
    whoRuns: "Claude Opus session",
  },
};

/**
 * Stopping rule: when every homework item of a record has used its budget and the record still
 * fails, it becomes `insufficient` (held, listed, no decision asked) unless it is consequential,
 * in which case it becomes `needs_owner` with what was tried. Consequential = K4, or a K3 event
 * the company's financing or contract totals depend on.
 */
export const STOP_RULE =
  "Budget used up: K2 and K3 records are held as insufficient (listed, never published, no decision asked); K4 records go to the owner with the evidence gathered and what was tried.";

/** Quality-control sampling (qc.ts). */
export const QC = {
  /**
   * Calibration: while the policy is new (its first three batches), the sample is filled up to
   * `cap` with random records, as under tiers@1. After three clean batches the owner may lower it.
   */
  calibration: true,
  /** Random part: at least this many cleared records, or this fraction, whichever is larger. */
  randomMin: 10,
  randomFraction: 0.05,
  /** Risk-weighted additions, each capped. */
  highValueTop: 5, // cleared events with the largest amounts
  sameOriginMax: 5, // cleared records whose only corroboration rests on CANDEF's own source
  perResearcherMin: 2, // per researcher whose finding cleared a record (shared-model failures)
  authorityOnlyMax: 5, // cleared under the original-authority rule (no corroboration)
  cap: 30,
  /** One confirmed wrong record holds every cleared record of its class in the batch. */
  failure: "hold-class",
} as const;

/**
 * Method questions: records whose evidence is right but whose meaning depends on a rule CANDEF has
 * not defined. One owner answer per topic settles every such record, in every batch.
 */
export const DEFINITIONS = {
  founded_year: {
    question:
      "What does 'founded' mean? Several founding years are the date the current legal entity was incorporated or continued under a corporations act (registry 'governing legislation' date), not a statement of when the business started.",
    recommendation:
      "Define founded_year as the year the business started, from the company or an official history; when only a registry date exists, record it as the incorporation year and label it so. Until then these records stay uncleared.",
    locator:
      /governing legislation|certificate of (incorporation|continuance|amalgamation)|anniversary/i,
    /** Settled: the record needs a business-start source (system homework), or it is held. */
    decidedBy: "P-62",
    ruling:
      "P-62: founded_year is the year the business started; find the company's or an official history",
  },
  location: {
    question:
      "Can a headquarters or operating location rest only on a registered office (a legal address, often a law firm) or a press-release dateline?",
    recommendation:
      "No: require a first-party statement of where the company is or operates; a registered office or dateline may corroborate it but not carry it alone.",
    locator: /registered office|registered-office|dateline/i,
    decidedBy: "P-63",
    ruling:
      "P-63: find a first-party statement of where the company is or operates; if none exists, a registered office may stand (labelled), a dateline may not",
  },
} as const;

/** Decision group kinds for the owner queue (route.ts `groupKey`). */
export type GroupKind =
  | "identity" // legal entity, BN and postal anchors, legal-name history, rows they gate
  | "scope" // eligibility and primary classification
  | "structure" // ownership, acquisitions, lineage
  | "interpretation" // analyst descriptions and other CANDEF wording
  | "secondary-source" // records that rest on T3/T4 sources after the original was not found
  | "reconciliation" // amended, hand-merged or vanished government agreements
  | "conflict" // contradictory original sources
  | "correction" // records evidence shows are wrong
  | "definition" // a method question that settles many records at once (batch-wide)
  | "qc"; // the audit sample

export const GROUP_LABEL: Record<GroupKind, string> = {
  identity: "Who is this company, legally?",
  scope: "Company profile: scope, subsector and CANDEF's descriptions",
  structure: "Who owns it, and what did it buy or become?",
  interpretation: "CANDEF's own descriptions",
  "secondary-source": "Claims that rest on a secondary source",
  reconciliation: "Government agreements that need reconciling",
  conflict: "Original sources disagree",
  correction: "Records the evidence shows are wrong",
  definition: "Method questions (one answer settles many records)",
  qc: "Quality-control audit",
};
