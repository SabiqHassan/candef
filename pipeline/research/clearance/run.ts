/**
 * `candef clearance`: runs the draft clearance policy over a cohort and writes
 * research-cache/clearance/clearance-<cohort>-<date>.{json,md} and the exception queue page.
 *
 * Read-only on research/. It approves nothing, writes no review block and no decisions file, and
 * publishes nothing. Its output is a proposal for the owner and the audit trail of every check.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus, Evidence } from "../../../src/domain/schema/corpus";
import {
  buildInventory,
  buildWorksheet,
  corroborationByRecord,
  intakePackage,
  type BlindCard,
  type ResearcherPackage,
  type Worksheet,
} from "../blind";
import { loadReads } from "../verificationRead";
import { collectCitedRefs, loadRawRows, type RawRows } from "../verifyGovClaims";
import { batchHash, evaluateTiers, type TierRecord } from "../tiers/rules";
import { loadTierInputs, scopeRecords } from "../tiers/run";
import { DATASETS, rowLocator } from "./checks";
import { cardCompleteness, type CardCompleteness } from "./completeness";
import { HOMEWORK, POLICY_ACTIVE, POLICY_VERSION, type ClearanceState } from "./policy";
import { cleanAuditBound, qcSample, type QcPick } from "./qc";
import { decisionGroups, routeRecords, type ClearanceRecord, type DecisionGroup } from "./route";

export interface ClearanceOptions {
  cacheDir: string;
  today: string;
  cards: BlindCard[];
  /** Folder of researcher returns (JSON packages); `original/` subfolders are skipped. */
  returnsDir: string;
  /** Researcher sessions exposed to CANDEF material (docs/verification/<cohort>/independence.json). */
  independenceFile: string | null;
  planFile?: string;
  skipGovRows?: boolean;
  /** research-cache/clearance/ladder.json: attempts per `recordId|homeworkKind`. */
  ladderFile?: string;
  /** Where the cards came from (stored so apply-clearance can re-run the same evaluation). */
  cardsFile?: string;
  /**
   * Only these records of the cards' organizations (the rounds radar's queue, P-68: new rounds
   * without the company's other records). Stored with the run, so apply-clearance re-runs the same set.
   */
  recordIds?: string[] | null;
}

/** Keeps only the listed records; no list keeps everything. */
export function limitToRecords<T extends { id: string }>(
  records: T[],
  recordIds: readonly string[] | null | undefined,
): T[] {
  if (!recordIds) return records;
  const keep = new Set(recordIds);
  return records.filter((r) => keep.has(r.id));
}

export interface WorkloadComparison {
  /** tiers@1: one card per tier 3 record and per exception, plus the audit sample. */
  old: { judgements: number; exceptions: number; audit: number; cards: number };
  /** clearance@0.1: owner decisions (grouped questions) plus audit checks. */
  now: {
    decisions: number;
    groups: number;
    /** Decisions in flagged or always-read groups (structure, conflicts, reconciliation). */
    attentionDecisions: number;
    /** Decisions whose recommendation can be accepted together after a skim. */
    bulkDecisions: number;
    /** Decisions a delegation rule (D1 identity triangulation, D2 agreed classification) would
     * settle if the owner approved those rules. Not active. */
    delegableDecisions: number;
    audit: number;
    total: number;
    /** If every outstanding homework item failed: K2/K3 become held (no decision), so only the
     * contradictions among them would add decisions. */
    worstCaseExtraDecisions: number;
  };
  reductionPct: number;
}

export interface ClearanceFile {
  format: "candef-clearance";
  policy: string;
  policyActive: boolean;
  today: string;
  generatedAt: string;
  batch: string;
  cohort: string[];
  /** The file name it is written under (shown in the queue's apply instruction). */
  fileName?: string;
  /** How this file was produced; apply-clearance re-runs exactly this. */
  run: Omit<ClearanceOptions, "cards" | "today" | "cardsFile"> & { cardsFile: string | null };
  inputs: {
    packages: number;
    researchers: string[];
    govRowsLoaded: boolean;
    worksheetRows: number;
  };
  counts: Record<string, number>;
  workload: WorkloadComparison;
  records: ClearanceRecord[];
  groups: DecisionGroup[];
  qc: QcPick[];
  completeness: CardCompleteness[];
  homework: { kind: string; step: string; count: number; whoRuns: string }[];
  /** The relation counts behind the old `inconsistent` signals (what they really were). */
  inconsistentRecheck: { claimId: string; label: string; relations: Record<string, number> }[];
}

/** Every JSON researcher package under a returns folder (`original/` copies skipped). */
export function loadPackages(dir: string): {
  packages: ResearcherPackage[];
  unusable: Map<string, Set<string>>;
  problems: string[];
} {
  const packages: ResearcherPackage[] = [];
  const unusable = new Map<string, Set<string>>();
  const problems: string[] = [];
  if (!existsSync(dir)) return { packages, unusable, problems: [`no returns folder ${dir}`] };
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? e.name === "original"
          ? []
          : walk(join(d, e.name))
        : e.name.endsWith(".json")
          ? [join(d, e.name)]
          : [],
    );
  const seen = new Set<string>();
  for (const file of walk(dir).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      problems.push(`${file}: ${(e as Error).message}`);
      continue;
    }
    const intake = intakePackage(raw);
    if (!intake.pkg) {
      problems.push(`${file}: ${intake.errors.slice(0, 3).join("; ")}`);
      continue;
    }
    const key = `${intake.pkg.researcher.id}|${intake.pkg.company.card_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unusable.set(key, new Set(intake.issues.map((i) => i.findingId)));
    packages.push(intake.pkg);
  }
  return { packages, unusable, problems };
}

/** Dataset references cited by any record's evidence (not only agreements), for row checks. */
function allCitedRefs(corpus: Corpus) {
  const refs = collectCitedRefs(corpus.agreements.filter((g) => /^agr_tbs_[cg]_/.test(g.id)));
  const ev: Evidence[] = [
    ...corpus.assertions.flatMap((a) => a.evidence),
    ...corpus.rounds.flatMap((r) => [...r.evidence, ...r.disclosures.flatMap((d) => d.evidence)]),
  ];
  for (const e of ev) {
    const f = rowLocator(e.locator);
    if (!f) continue;
    if (e.sourceId === DATASETS.contracts && f.get("reference_number"))
      refs.contracts.add(f.get("reference_number")!);
    if (e.sourceId === DATASETS.grants && f.get("ref_number"))
      refs.grants.add(f.get("ref_number")!);
  }
  return refs;
}

export async function runClearance(
  corpus: Corpus,
  options: ClearanceOptions,
): Promise<ClearanceFile> {
  const { today, cards } = options;
  const scope = [...new Set(cards.flatMap((c) => c.orgSlugs))];

  // Stage C input: a fresh worksheet, built now from the current records and every return, so a
  // record edited since the last worksheet is compared again instead of becoming an exception.
  const { packages, unusable } = loadPackages(options.returnsDir);
  const exposedJson =
    options.independenceFile && existsSync(options.independenceFile)
      ? (JSON.parse(readFileSync(options.independenceFile, "utf8")) as {
          exposed: { researcher: string; cards: string[] }[];
        })
      : { exposed: [] };
  const exposed = new Set(
    exposedJson.exposed.flatMap((e) => e.cards.map((c) => `${e.researcher}|${c}`)),
  );
  const inventory = buildInventory(corpus, cards, today);
  const worksheet: Worksheet = buildWorksheet(inventory, packages, unusable, exposed);

  const { inputs } = await loadTierInputs(corpus, {
    cacheDir: options.cacheDir,
    today,
    cards,
    skipGovRows: true,
    planFile: options.planFile,
  });
  inputs.corroboration = corroborationByRecord(worksheet, inventory);
  let rows: RawRows | null = null;
  if (!options.skipGovRows) {
    const sources = new Map(corpus.sources.map((s) => [s.id, s]));
    const csv = (id: string) => {
      const cap = sources
        .get(id)
        ?.captures?.filter((c) => /\.csv$/i.test(c.path))
        .at(-1);
      return cap ? join(options.cacheDir, cap.path) : null;
    };
    const contracts = csv(DATASETS.contracts);
    const grants = csv(DATASETS.grants);
    if (contracts && grants && existsSync(contracts) && existsSync(grants))
      rows = await loadRawRows(contracts, grants, allCitedRefs(corpus));
  }
  inputs.govRows = rows;
  const tiers: TierRecord[] = limitToRecords(
    scopeRecords(evaluateTiers(inputs), corpus, scope),
    options.recordIds,
  );
  const batch = batchHash(tiers);

  // ladder.json: per `recordId|homeworkKind`, a number of attempts, or { n, blocked, why }. A
  // blocked step (the site's terms forbid it, or its terms are unread) uses up its budget.
  const attempts = new Map<string, number>();
  if (options.ladderFile && existsSync(options.ladderFile))
    for (const [k, v] of Object.entries(
      JSON.parse(readFileSync(options.ladderFile, "utf8")) as Record<
        string,
        number | { n?: number; blocked?: boolean; why?: string }
      >,
    ))
      attempts.set(k, typeof v === "number" ? v : v.blocked ? 99 : (v.n ?? 0));

  const records = routeRecords({
    corpus,
    today,
    tiers,
    worksheet,
    inventory,
    packages,
    exposed,
    rows,
    readCapture: inputs.readCapture,
    reads: loadReads(options.cacheDir),
    cards,
    attempts,
  });
  const qc = qcSample(records, corpus, batch);
  const qcIds = new Set(qc.map((q) => q.id));
  for (const r of records) if (qcIds.has(r.id)) r.state = "cleared_qc";
  const groups = decisionGroups(records, corpus);

  const independent = (res: string, card: string) => !exposed.has(`${res}|${card}`);
  const completeness = cards.map((c) => cardCompleteness(corpus, c, packages, independent, null));

  const counts: Record<string, number> = { total: records.length };
  for (const r of records) {
    counts[`state_${r.state}`] = (counts[`state_${r.state}`] ?? 0) + 1;
    counts[`class_${r.cls}`] = (counts[`class_${r.cls}`] ?? 0) + 1;
    if (r.state === "cleared" || r.state === "cleared_qc")
      counts[r.conditionalOn.length ? "cleared_conditional" : "cleared_unconditional"] =
        (counts[r.conditionalOn.length ? "cleared_conditional" : "cleared_unconditional"] ?? 0) + 1;
    if (r.projected)
      counts[`projected_${r.projected}`] = (counts[`projected_${r.projected}`] ?? 0) + 1;
  }

  const oldJudgements = tiers.filter((t) => t.status === "judgement").length;
  const oldExceptions = tiers.filter((t) => t.status === "exception").length;
  const oldAudit = Math.min(
    30,
    tiers.filter((t) => t.status === "pass" || t.status === "conditional").length,
  );
  const decisions = groups.reduce((s, g) => s + g.decisions, 0);
  const worstCaseExtra = records.filter(
    (r) => r.state === "homework" && r.homework.some((h) => h.kind === "read-contradicting-source"),
  ).length;
  const oldCards = oldJudgements + oldExceptions + oldAudit;
  const nowTotal = decisions + qc.length;

  const hw = new Map<string, number>();
  for (const r of records) for (const h of r.homework) hw.set(h.kind, (hw.get(h.kind) ?? 0) + 1);

  // What the old `inconsistent` signals turn out to be, relation by relation.
  const inconsistentRecheck = worksheet.rows
    .filter((w) => w.signal === "inconsistent")
    .map((w) => {
      const rel: Record<string, number> = {};
      for (const r of records)
        for (const x of r.relations)
          if (x.claimId === w.claimId) rel[x.relation] = (rel[x.relation] ?? 0) + 1;
      return { claimId: w.claimId, label: `${w.entity}: ${w.label}`, relations: rel };
    });

  return {
    format: "candef-clearance",
    policy: POLICY_VERSION,
    policyActive: POLICY_ACTIVE,
    today,
    generatedAt: new Date().toISOString(),
    batch,
    cohort: cards.map((c) => c.card),
    run: {
      cacheDir: options.cacheDir,
      returnsDir: options.returnsDir,
      independenceFile: options.independenceFile,
      planFile: options.planFile,
      skipGovRows: options.skipGovRows ?? false,
      ladderFile: options.ladderFile,
      cardsFile: options.cardsFile ?? null,
      recordIds: options.recordIds ?? null,
    },
    inputs: {
      packages: packages.length,
      researchers: [...new Set(packages.map((p) => p.researcher.id))],
      govRowsLoaded: rows !== null,
      worksheetRows: worksheet.rows.length,
    },
    counts,
    workload: {
      old: {
        judgements: oldJudgements,
        exceptions: oldExceptions,
        audit: oldAudit,
        cards: oldCards,
      },
      now: {
        decisions,
        groups: groups.length,
        attentionDecisions: groups
          .filter((g) => !g.bulkAcceptable)
          .reduce((n, g) => n + g.decisions, 0),
        bulkDecisions: groups.filter((g) => g.bulkAcceptable).reduce((n, g) => n + g.decisions, 0),
        delegableDecisions: groups.reduce((n, g) => n + g.delegableDecisions, 0),
        audit: qc.length,
        total: nowTotal,
        worstCaseExtraDecisions: worstCaseExtra,
      },
      reductionPct: oldCards ? Math.round((100 * (oldCards - nowTotal)) / oldCards) : 0,
    },
    records,
    groups,
    qc,
    completeness,
    homework: [...hw.entries()].map(([kind, count]) => ({
      kind,
      count,
      step: HOMEWORK[kind as keyof typeof HOMEWORK].step,
      whoRuns: HOMEWORK[kind as keyof typeof HOMEWORK].whoRuns,
    })),
    inconsistentRecheck,
  };
}

export const fileHash = (s: string) => createHash("sha256").update(s).digest("hex");

/** A short Markdown summary: counts, workload, groups, homework. No source text. */
export function clearanceMarkdown(f: ClearanceFile): string {
  const state = (s: ClearanceState) => f.counts[`state_${s}`] ?? 0;
  const w = f.workload;
  const lines = [
    `# Clearance ${f.today} (${f.policy}, ${f.policyActive ? "adopted (P-60); applied only by the owner" : "draft, not active"})`,
    "",
    `Cohort ${f.cohort.join(", ")}. Batch \`${f.batch.slice(0, 12)}\`. ${f.records.length} review units; ${f.inputs.packages} researcher packages from ${f.inputs.researchers.join(", ")}. Read-only: nothing is approved or published.`,
    "",
    "## Workload",
    "",
    "| | Old (tiers@1) | New (clearance policy) |",
    "| --- | ---: | ---: |",
    `| Owner decisions | ${w.old.judgements + w.old.exceptions} (${w.old.judgements} judgements + ${w.old.exceptions} exceptions) | ${w.now.decisions} in ${w.now.groups} groups |`,
    `| of which need real reading (flagged, structure, conflicts, reconciliation) | all | ${w.now.attentionDecisions} |`,
    `| of which can be accepted together after a skim (unflagged identity and profile) | none | ${w.now.bulkDecisions} |`,
    `| would be settled by delegation rules D1/D2 if you approved them (not active) | n/a | ${w.now.delegableDecisions} |`,
    `| Audit checks | ${w.old.audit} | ${w.now.audit} |`,
    `| **Total** | **${w.old.cards}** | **${w.now.total}** (${w.reductionPct}% fewer) |`,
    "",
    `Worst case if every contradiction-check homework item failed: +${w.now.worstCaseExtraDecisions} decision(s). Other failed homework is held as insufficient, not sent to the owner.`,
    "",
    "## States",
    "",
    `- cleared: ${state("cleared")} (+${state("cleared_qc")} drawn for the audit); of all cleared, ${f.counts.cleared_conditional ?? 0} wait for the owner's identity confirmation`,
    `- homework (automated, not a decision): ${state("homework")}${f.counts.projected_cleared ? `, of which ${f.counts.projected_cleared} would clear after deterministic linking` : ""}`,
    `- needs owner: ${state("needs_owner")}; contradictory: ${state("contradictory")}; insufficient (held): ${state("insufficient")}; incorrect (held): ${state("incorrect")}`,
    "",
    "## Homework (the system's work, not the owner's)",
    "",
    ...f.homework.map((h) => `- ${h.kind} (${h.step}, ${h.whoRuns}): ${h.count}`),
    "",
    "## Decision groups",
    "",
    ...f.groups.map(
      (g) =>
        `- [${g.kind}] ${g.orgName}: ${g.decisions} decision(s), ${g.records.length} record(s)${g.unlocks ? `, unlocks ${g.unlocks}` : ""}${g.flags.length ? ` — FLAG: ${g.flags[0]}` : ""}`,
    ),
    "",
    "## Old 'inconsistent' signals, re-read",
    "",
    ...f.inconsistentRecheck.map(
      (i) =>
        `- ${i.label} (${i.claimId}): ${
          Object.entries(i.relations)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "no independent finding"
        }`,
    ),
    "",
    "## Completeness",
    "",
    ...f.completeness.flatMap((c) =>
      c.categories
        .filter((x) => x.category !== "government")
        .map(
          (x) =>
            `- ${c.card} ${x.category}: CANDEF ${x.candef}; ${x.status}${x.leads.length ? ` (${x.leads.length} lead(s))` : ""}${x.estimate ? `; estimate ${x.estimate.total} (${x.estimate.basis})` : ""}`,
        ),
    ),
    "",
    `Audit bound: a clean audit of ${f.qc.length} supports an error rate below ${((cleanAuditBound(f.qc.length) ?? 1) * 100).toFixed(0)}% (95%, rule of three) for this batch's cleared records.`,
  ];
  return lines.join("\n") + "\n";
}
