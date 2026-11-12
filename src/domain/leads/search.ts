/**
 * Filters and ranking for the lead search, shared by the command line (pipeline) and the site.
 * Pure: no file, network, React or model. The same query over the same documents gives the same
 * order. A company's government rows are passed in; how a row maps to topic tags is injected
 * (`lineTags`): the pipeline derives them from keyword lists, the site reads precomputed tags.
 */
import {
  docTerms,
  expandQuery,
  makeScorer,
  matchedFields,
  type DocTerms,
  type RankLine,
} from "./rank";
import type { TagId } from "./vocabulary";

/** The lead search query as plain types (the zod schema for tools and the command line is query.ts). */
export interface LeadQuery {
  text?: string;
  tags?: TagId[];
  tiers: ("A" | "B" | "C" | "D")[];
  provinces?: string[];
  firstSeenAfter?: string;
  firstGrantAfter?: string;
  firstTimeGrantRecipient?: boolean;
  maxTotalValue?: number;
  departments?: string[];
  programmes?: string[];
  categories?: string[];
  programmeSince?: string;
  limit: number;
}

/** A query with the defaults filled in (tier A, twenty results). */
export const withDefaults = (q: Partial<LeadQuery> = {}): LeadQuery => ({
  tiers: ["A"],
  limit: 20,
  ...q,
});

export interface LeadLine extends RankLine {
  kind: "grant" | "contract";
  date: string;
  department: string;
  ownerOrg: string;
  value: number;
  ref: string;
}

/** What the filters and the ranking read of one company. */
export interface SearchableLead {
  key: string;
  name: string;
  otherNames: string[];
  provinces: string[];
  tier: string;
  tags: string[];
  firstDate: string | null;
  lastDate: string | null;
  firstGrantDate: string | null;
  firstTimeGrantRecipient: boolean;
  grantValue: number;
  contractValue: number;
  judgeSaidNo: boolean;
  reason: string;
  tierEvidence: { rule: string }[];
  lines: LeadLine[];
}

const PROVINCE_NAMES: Record<string, string> = {
  ontario: "ON",
  quebec: "QC",
  québec: "QC",
  "british columbia": "BC",
  alberta: "AB",
  manitoba: "MB",
  saskatchewan: "SK",
  "nova scotia": "NS",
  "new brunswick": "NB",
  "newfoundland and labrador": "NL",
  newfoundland: "NL",
  "prince edward island": "PE",
  pei: "PE",
  yukon: "YT",
  "northwest territories": "NT",
  nunavut: "NU",
};
const PROVINCE_GROUPS: Record<string, string[]> = {
  atlantic: ["NB", "NS", "PE", "NL"],
  prairies: ["AB", "SK", "MB"],
  territories: ["YT", "NT", "NU"],
};

export function expandProvinces(input: string[]): Set<string> {
  const out = new Set<string>();
  for (const p of input) {
    const k = p.trim().toLowerCase();
    if (PROVINCE_GROUPS[k]) PROVINCE_GROUPS[k]!.forEach((c) => out.add(c));
    else out.add(PROVINCE_NAMES[k] ?? p.trim().toUpperCase());
  }
  return out;
}

export const normProvince = (p: string) => PROVINCE_NAMES[p.toLowerCase()] ?? p.toUpperCase();
const fromDate = (d: string) => (d.length === 4 ? `${d}-01-01` : d);

/** Abbreviations people type, mapped to the words in the stored programme names. */
export const PROGRAMME_ALIASES: Record<string, string[]> = {
  ideas: ["innovation for defence excellence and security"],
  diana: ["defence innovation accelerator", "diana"],
  irap: ["industrial research assistance"],
  rdii: ["regional defence investment"],
  sadi: ["strategic aerospace and defence"],
};

export function programmeMatches(stored: string, wanted: string): boolean {
  const s = stored.toLowerCase();
  const w = wanted.trim().toLowerCase();
  return s.includes(w) || (PROGRAMME_ALIASES[w] ?? []).some((a) => s.includes(a));
}

export const TIER_FACTOR = { A: 1, D: 0.6, B: 0.45, C: 0.35 } as const;

/** How strong the rule evidence is: structured or category rules > medium category > defence text alone. */
export function ruleStrength(row: Pick<SearchableLead, "tier" | "tierEvidence">): number {
  if (row.tier !== "A") return 1;
  const rules = new Set(row.tierEvidence.map((e) => e.rule[0]));
  if (rules.has("1") || rules.has("2") || rules.has("5")) return 1;
  if (rules.has("3")) return 0.9;
  return 0.8;
}

export function passes(
  d: SearchableLead,
  q: LeadQuery,
  lineTags: (l: LeadLine) => readonly string[],
): boolean {
  if (!q.tiers.includes(d.tier as "A")) return false;
  if (q.tags?.length && !q.tags.some((t) => d.tags.includes(t))) return false;
  if (q.provinces?.length) {
    const want = expandProvinces(q.provinces);
    if (!d.provinces.some((p) => want.has(normProvince(p)))) return false;
  }
  if (q.firstSeenAfter && !(d.firstDate && d.firstDate >= fromDate(q.firstSeenAfter))) return false;
  if (q.firstGrantAfter && !(d.firstGrantDate && d.firstGrantDate >= fromDate(q.firstGrantAfter)))
    return false;
  if (
    q.firstTimeGrantRecipient !== undefined &&
    d.firstTimeGrantRecipient !== q.firstTimeGrantRecipient
  )
    return false;
  if (q.maxTotalValue !== undefined && d.grantValue + d.contractValue > q.maxTotalValue)
    return false;
  const depMatch = (l: LeadLine, x: string) => {
    const n = x.toLowerCase();
    return l.department.toLowerCase().includes(n) || l.ownerOrg.toLowerCase() === n;
  };
  if (q.categories?.length) {
    // One contract row must satisfy the category and, when given, the department.
    const ok = d.lines.some(
      (l) =>
        l.kind === "contract" &&
        q.categories!.some((c) => l.description.toLowerCase().includes(c.toLowerCase())) &&
        (!q.departments?.length || q.departments.some((x) => depMatch(l, x))),
    );
    if (!ok) return false;
  } else if (q.departments?.length) {
    if (!d.lines.some((l) => q.departments!.some((x) => depMatch(l, x)))) return false;
  }
  if (q.programmes?.length) {
    const since = q.programmeSince ? fromDate(q.programmeSince) : "";
    // With tags too, the same grant row must carry the tag (cyber work funded by that programme).
    const ok = d.lines.some(
      (l) =>
        l.kind === "grant" &&
        (!since || l.date >= since) &&
        q.programmes!.some((p) => programmeMatches(l.programme, p)) &&
        (!q.tags?.length || lineTags(l).some((t) => (q.tags as string[]).includes(t))),
    );
    if (!ok) return false;
  }
  return true;
}

export interface Ranked<D> {
  d: D;
  score: number;
  matched: ReturnType<typeof matchedFields>;
}

/** The search-term index of one company (name x3, project title x2, the rest x1). */
export const termsOf = (d: SearchableLead): DocTerms =>
  docTerms(d.name, d.otherNames, d.reason, d.lines);

/**
 * Every company that passes the filters (and, with text, matches it), best first. The caller takes
 * the first `limit`. `termsFor` lets a caller cache each company's term index.
 */
export function rankLeads<D extends SearchableLead>(
  docs: readonly D[],
  q: LeadQuery,
  termsFor: (d: D) => DocTerms,
  lineTags: (l: LeadLine) => readonly string[],
): Ranked<D>[] {
  const candidates = docs.filter((d) => passes(d, q, lineTags));
  const query = q.text ? expandQuery(q.text) : [];
  let scored: Ranked<D>[];
  if (query.length) {
    const terms = candidates.map((d) => termsFor(d));
    const scorer = makeScorer(query, terms);
    scored = [];
    candidates.forEach((d, i) => {
      const rel = scorer.score(terms[i]!);
      if (rel <= 0) return;
      const f = TIER_FACTOR[d.tier as "A"] * ruleStrength(d) * (d.judgeSaidNo ? 0.9 : 1);
      scored.push({ d, score: rel * f, matched: matchedFields(query, terms[i]!) });
    });
  } else {
    // No text: tier and rule strength first; among equals, more kinds of rule evidence and more money rank higher.
    scored = candidates.map((d) => {
      const kinds = new Set(d.tierEvidence.map((e) => e.rule[0])).size;
      const money = Math.log10(1 + d.grantValue + d.contractValue);
      return {
        d,
        score:
          TIER_FACTOR[d.tier as "A"] *
          ruleStrength(d) *
          (d.judgeSaidNo ? 0.9 : 1) *
          (1 + 0.05 * Math.min(kinds, 4) + 0.01 * money),
        matched: [],
      };
    });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (b.d.lastDate ?? "").localeCompare(a.d.lastDate ?? "") ||
      (a.d.key < b.d.key ? -1 : 1),
  );
  return scored;
}
