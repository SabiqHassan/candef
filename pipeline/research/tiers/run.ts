/**
 * `candef tiers` (docs/VERIFICATION_TIERS.md section 6, step 1): evaluates every proposed record,
 * draws the audit sample and writes research-cache/tiers/tiers-<date>.{json,md}. Read-only on
 * research/; agents may run it. Applying a batch is `apply-tiers`, owner only (apply.ts).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus, Source } from "../../../src/domain/schema/corpus";
import { sha256 } from "../../compile/hash";
import type { MigrationPlan } from "../../ingest/gov/migration";
import {
  buildInventory,
  corroborationByRecord,
  type BlindCard,
  type ClaimSignal,
  type Worksheet,
} from "../blind";
import { visibleText } from "../capture";
import { collectCitedRefs, loadRawRows, type RawRows } from "../verifyGovClaims";
import { normalize } from "./match";
import { batchHash, evaluateTiers, RULES_VERSION, type TierInputs, type TierRecord } from "./rules";
import { auditSample } from "./sample";

/** The registered TBS dataset sources (research/sources). */
export const DATASET_SOURCES = { contracts: "src_54baa50305c0", grants: "src_06a51c1749c5" };

export interface TiersFile {
  format: "candef-tiers";
  version: 1;
  rules: string;
  today: string;
  generatedAt: string;
  /** Binds the batch: rules, records, statuses and evidence hashes (rules.ts `batchHash`). */
  batch: string;
  inputs: {
    worksheet: { file: string; sha256: string } | null;
    plan: { file: string; hash: string } | null;
    datasets: { contracts: string | null; grants: string | null };
    govRowsLoaded: boolean;
  };
  counts: Record<string, number>;
  /** Record IDs of the audit sample, in draw order. */
  audit: string[];
  records: TierRecord[];
  /**
   * Present when the batch covers only some companies (`candef tiers --companies`): the batch, the
   * audit sample and `apply-tiers` all use exactly these organizations (by slug).
   */
  scope?: { orgSlugs: string[] };
}

const sha256File = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Reads a capture's text for matching. The text hash must equal the registered `textSha256`, so an
 * edited or replaced file is never read as the capture. PDFs and other binaries use a `.txt` sidecar
 * (their extracted text) whose hash is the registered text hash.
 */
export function captureReader(corpus: Corpus, cacheDir: string): TierInputs["readCapture"] {
  const sources = new Map(corpus.sources.map((s) => [s.id, s]));
  const memo = new Map<string, string | null>();
  return (sourceId, captureId) => {
    const key = `${sourceId}@${captureId}`;
    if (memo.has(key)) return memo.get(key)!;
    let text: string | null = null;
    const cap = sources.get(sourceId)?.captures?.find((c) => c.id === captureId);
    if (cap?.textSha256 && !/\.(csv)$/i.test(cap.path)) {
      const path = join(cacheDir, cap.path);
      const html = /\.html?$/i.test(path);
      const textPath = html || /\.(txt|json|md)$/i.test(path) ? path : `${path}.txt`;
      if (existsSync(textPath)) {
        const raw = readFileSync(textPath, "utf8");
        const visible = html ? visibleText(raw) : raw;
        if (sha256(visible) === cap.textSha256) text = normalize(visible);
      }
    }
    memo.set(key, text);
    return text;
  };
}

function latestFile(dir: string, re: RegExp): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => re.test(f))
    .sort();
  return files.length ? join(dir, files.at(-1)!) : null;
}

/** The latest capture of a dataset source that is a file in the cache. */
function datasetCapture(source: Source | undefined, cacheDir: string): string | null {
  const cap = source?.captures?.filter((c) => /\.csv$/i.test(c.path)).at(-1);
  return cap && existsSync(join(cacheDir, cap.path)) ? join(cacheDir, cap.path) : null;
}

export interface TierRunOptions {
  cacheDir: string;
  today: string;
  cards: BlindCard[];
  /** Skip scanning the multi-gigabyte dataset captures (tier 1 then fails T1-a with a reason). */
  skipGovRows?: boolean;
  /** Reconciliation plan (default research-cache/gov-linkage/plan/migration.json when present). */
  planFile?: string;
  /** Limit the batch (and so the audit sample) to these organization slugs. */
  scope?: readonly string[];
}

/** The records of the organizations in `orgSlugs` (all records when there is no scope). */
export function scopeRecords(
  records: TierRecord[],
  corpus: Corpus,
  orgSlugs: readonly string[] | undefined,
): TierRecord[] {
  if (!orgSlugs) return records;
  const ids = new Set(
    orgSlugs.map((slug) => {
      const org = corpus.organizations.find((o) => o.slug === slug);
      if (!org) throw new Error(`tiers scope: unknown organization ${slug}`);
      return org.id;
    }),
  );
  return records.filter((r) => ids.has(r.orgId));
}

/** Gathers every input `evaluateTiers` needs, from research-cache/. */
export async function loadTierInputs(
  corpus: Corpus,
  options: TierRunOptions,
): Promise<{ inputs: TierInputs; meta: TiersFile["inputs"] }> {
  const { cacheDir, today } = options;
  const sources = new Map(corpus.sources.map((s) => [s.id, s]));
  const contracts = datasetCapture(sources.get(DATASET_SOURCES.contracts), cacheDir);
  const grants = datasetCapture(sources.get(DATASET_SOURCES.grants), cacheDir);

  const planFile = options.planFile ?? join(cacheDir, "gov-linkage", "plan", "migration.json");
  // reconcile-cli writes { hash, plan, … }; a bare plan is accepted too.
  const planJson = existsSync(planFile)
    ? (JSON.parse(readFileSync(planFile, "utf8")) as { hash?: string; plan?: MigrationPlan })
    : null;
  const plan = planJson ? (planJson.plan ?? (planJson as unknown as MigrationPlan)) : null;

  let govRows: RawRows | null = null;
  if (!options.skipGovRows && contracts && grants) {
    const tbs = [...corpus.agreements, ...(plan?.replacements ?? [])].filter((g) =>
      /^agr_tbs_[cg]_/.test(g.id),
    );
    govRows = await loadRawRows(contracts, grants, collectCitedRefs(tbs));
  }

  const wsFile = latestFile(join(cacheDir, "blind-verification"), /^worksheet-.*\.json$/);
  let corroboration: Map<string, ClaimSignal[]> | null = null;
  if (wsFile) {
    const ws = JSON.parse(readFileSync(wsFile, "utf8")) as Worksheet;
    corroboration = corroborationByRecord(ws, buildInventory(corpus, options.cards, today));
  }

  return {
    inputs: {
      corpus,
      today,
      readCapture: captureReader(corpus, cacheDir),
      govRows,
      datasetSources: DATASET_SOURCES,
      corroboration,
      plan,
    },
    meta: {
      worksheet: wsFile ? { file: wsFile, sha256: sha256File(wsFile) } : null,
      plan: plan ? { file: planFile, hash: planJson?.hash ?? plan.hash } : null,
      datasets: { contracts, grants },
      govRowsLoaded: govRows !== null,
    },
  };
}

export function countsOf(records: TierRecord[]): Record<string, number> {
  const counts: Record<string, number> = { total: records.length };
  for (const r of records) {
    const k = `tier${r.tier}_${r.status}`;
    counts[k] = (counts[k] ?? 0) + 1;
    if (r.projected) {
      const p = `tier1_projected_${r.projected.status}`;
      counts[p] = (counts[p] ?? 0) + 1;
    }
  }
  return counts;
}

/** Evaluates, samples and returns the tiers file (nothing is written). */
export async function runTiers(corpus: Corpus, options: TierRunOptions): Promise<TiersFile> {
  const { inputs, meta } = await loadTierInputs(corpus, options);
  const records = scopeRecords(evaluateTiers(inputs), corpus, options.scope);
  const batch = batchHash(records);
  return {
    format: "candef-tiers",
    version: 1,
    rules: RULES_VERSION,
    today: options.today,
    generatedAt: new Date().toISOString(),
    batch,
    inputs: meta,
    counts: countsOf(records),
    audit: auditSample(records, batch),
    records,
    ...(options.scope ? { scope: { orgSlugs: [...options.scope] } } : {}),
  };
}

/** A short Markdown summary for the cache folder: counts and record IDs, no source text. */
export function tiersMarkdown(file: TiersFile, orgName: (id: string) => string): string {
  const byOrg = new Map<string, TierRecord[]>();
  for (const r of file.records) byOrg.set(r.orgId, [...(byOrg.get(r.orgId) ?? []), r]);
  const n = (list: TierRecord[], tier: number, status: string) =>
    list.filter((r) => r.tier === tier && r.status === status).length;
  const lines = [
    `# Tiers ${file.today} (${file.rules})`,
    "",
    `Batch \`${file.batch}\`. Read-only evaluation; nothing is approved until the owner runs \`apply-tiers\`.`,
    "",
    "| Organization | T1 pass | T1 conditional | T1 exception | T2 pass | T2 exception | Tier 3 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...[...byOrg.entries()]
      .sort((a, b) => orgName(a[0]).localeCompare(orgName(b[0])))
      .map(
        ([org, list]) =>
          `| ${orgName(org)} | ${n(list, 1, "pass")} | ${n(list, 1, "conditional")} | ${n(list, 1, "exception")} | ${n(list, 2, "pass")} | ${n(list, 2, "exception")} | ${n(list, 3, "judgement")} |`,
      ),
    "",
    `## Audit sample (${file.audit.length})`,
    "",
    ...file.audit.map((id) => `- \`${id}\``),
    "",
    "## Exceptions",
    "",
    ...file.records
      .filter((r) => r.status === "exception")
      .map(
        (r) =>
          `- \`${r.id}\` (${orgName(r.orgId)}, tier ${r.tier}): ${r.rules
            .filter((x) => x.result === "fail")
            .map((x) => `${x.rule}: ${x.reason}`)
            .join(" | ")}`,
      ),
  ];
  return lines.join("\n") + "\n";
}
