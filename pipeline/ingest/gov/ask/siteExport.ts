/**
 * Exports the lead index to the static file the site's lead search reads
 * (`public/data/<dataset>/leads.json`, src/domain/leads/siteData.ts).
 *
 * Real data: the tier-A leads from `research-cache/grant-ask/index/search.jsonl` (the index built
 * by `npm run grant-ask -- index`). Demo data: a few FICTIONAL companies (never real ones) so the
 * demo build and the end-to-end tests have something to search. Neither touches `research/`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LEADS_FILE_VERSION,
  LEADS_LABEL,
  type LeadsFile,
  type SiteLead,
  type SiteLine,
} from "../../../../src/domain/leads/siteTypes";
import { LeadsFileSchema } from "../../../../src/domain/leads/siteData";
import { TAG_IDS, type TagId } from "../../../../src/domain/leads/vocabulary";
import { normProvince } from "../../../../src/domain/leads/search";
import type { LeadRow } from "./leadIndex";
import type { ProfileLine } from "./profiles";
import { lineTagIds } from "./tags";

export type ExportDoc = LeadRow & { lines: ProfileLine[] };

const PROVINCES = new Set([
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
]);
const MAX_LINES = 10;
const trim = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

export const SOURCES = [
  "Treasury Board of Canada Secretariat, Proactive Disclosure: Grants and Contributions",
  "Treasury Board of Canada Secretariat, Proactive Disclosure: Contracts over $10,000",
];
export const LICENCE = "Open Government Licence – Canada";

/** One index row as a site lead: the stored rows trimmed, provinces as codes, tags per row. */
export function siteLead(d: ExportDoc): SiteLead {
  const lines: SiteLine[] = d.lines.slice(0, MAX_LINES).map((l) => ({
    kind: l.kind,
    date: l.date,
    department: l.department,
    ownerOrg: l.ownerOrg,
    programme: l.programme,
    title: trim(l.title, 140),
    description: trim(l.description, 200),
    value: Math.round(l.value),
    ref: l.ref,
    tags: lineTagIds(l),
  }));
  return {
    key: d.key,
    name: d.name,
    otherNames: d.otherNames.slice(0, 3),
    businessNumber: d.businessNumber,
    cities: [...new Set(d.cities)].slice(0, 3),
    provinces: [...new Set(d.provinces.map(normProvince).filter((p) => PROVINCES.has(p)))],
    tier: d.tier as SiteLead["tier"],
    tags: d.tags.filter((t): t is TagId => (TAG_IDS as readonly string[]).includes(t)),
    firstDate: d.firstDate,
    lastDate: d.lastDate,
    firstGrantDate: d.firstGrantDate,
    firstTimeGrantRecipient: d.firstTimeGrantRecipient,
    grantAgreements: d.grantAgreements,
    grantCount: d.grantCount,
    contractCount: d.contractCount,
    grantValue: Math.round(d.grantValue),
    contractValue: Math.round(d.contractValue),
    dndContractValue: Math.round(d.dndContractValue),
    csaValue: Math.round(d.csaValue),
    reason: trim(d.reason, 220),
    judgeSaidNo: d.judgeSaidNo,
    tierEvidence: d.tierEvidence
      .filter((e) => e.line === null || e.line < MAX_LINES)
      .map((e) => ({ rule: e.rule, line: e.line })),
    lines,
  };
}

export function buildLeadsFile(
  docs: Iterable<ExportDoc>,
  opts: { dataDate: string; tiers: ("A" | "B" | "C" | "D")[]; isDemo: boolean; now?: Date },
): LeadsFile {
  const leads = [...docs]
    .filter((d) => opts.tiers.includes(d.tier as "A"))
    .map(siteLead)
    // Stable order: by key, so the same index always writes the same file.
    .sort((a, b) => (a.key < b.key ? -1 : 1));
  return LeadsFileSchema.parse({
    format: "candef-leads",
    version: LEADS_FILE_VERSION,
    label: LEADS_LABEL,
    meta: {
      dataDate: opts.dataDate,
      generatedAt: (opts.now ?? new Date()).toISOString(),
      tiers: opts.tiers,
      count: leads.length,
      isDemo: opts.isDemo,
      sources: SOURCES,
      licence: LICENCE,
    },
    leads,
  });
}

/** Reads tier rows of the index's `search.jsonl` (every company that is not tier "out"). */
export async function readSearchDocs(indexDir: string): Promise<ExportDoc[]> {
  const text = await readFile(join(indexDir, "search.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ExportDoc);
}
