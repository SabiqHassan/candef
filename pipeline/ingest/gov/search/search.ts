/**
 * Grant search, candidate stage (owner design 2026-10-16; no AI here). One streaming pass over the
 * Treasury Board grants and contributions file answers several queries at once. Everything it
 * returns is a lead for a person to check, never evidence, and it writes nothing under research/.
 *
 * Rules: individuals (recipient_type P) are skipped entirely; by default only for-profit rows (F)
 * in Canada (or with no country stated) are candidates; an agreement is the set of rows sharing
 * department and reference number, valued at its original row (amendment 0), never the amendments;
 * a recipient's first federal grant is the earliest start date of any of its non-individual rows in
 * the whole file, looked up by business number root and by normalized legal name (the earlier
 * wins); the recipient's own name is removed from titles before matching (some programmes title an
 * agreement with the company name); title and programme matches rank above description-only ones.
 */
import { nameKey, businessNumberRoot, postalFsa } from "../../../research/names";
import { readCsv } from "../csv";
import { toGrantRow } from "../tbs";
import { rowLocator } from "../locators";
import { TOPICS } from "./synonyms";

/** Lower case, accents and typographic apostrophes removed, whitespace collapsed. */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word alternation; `*` after a word allows any word ending ("aeronef* sans pilote"). */
export function termPattern(terms: string[]): RegExp | null {
  const parts = [...new Set(terms.map(fold).filter(Boolean))]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((t) => t.split("*").map(escape).join("[\\p{L}\\p{N}'-]*"));
  return parts.length
    ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join("|")})(?![\\p{L}\\p{N}])`, "gu")
    : null;
}

export interface Filters {
  /** Recipient's first federal grant (whole file) on or after this date (YYYY-MM-DD). */
  firstSince?: string;
  /** Agreement start on or after this date. */
  startSince?: string;
  /** Two-letter province or territory codes. */
  provinces?: string[];
  /** Case-insensitive pattern on department code or name. */
  department?: string;
  /** Case-insensitive pattern on programme name. */
  programme?: string;
  minValue?: number;
  maxValue?: number;
  /** Recipient types to keep (default ["F"], for-profit). "P" is always skipped. */
  recipientTypes?: string[];
  /** Recipient countries to keep (default ["CA", ""]: Canada or not stated). */
  countries?: string[];
  /**
   * Case-insensitive pattern on programme names to drop (default "Canada Summer Jobs": student
   * wage subsidies whose titles are business names, never a technology lead). "" keeps everything.
   */
  excludeProgramme?: string;
}

export interface QuerySpec {
  id: string;
  query: string;
  /** Topic ids from the synonym table; when absent they are chosen from the query's words. */
  topics?: string[];
  /** Topics that must also be mentioned somewhere (title, description or programme). */
  require?: string[];
  /** Extra strong terms. */
  terms?: string[];
  filters?: Filters;
  limit?: number;
  /** Agreements shown per recipient (default 1; the rest are counted). */
  perRecipient?: number;
}

export interface Plan {
  spec: QuerySpec;
  topics: string[];
  strong: RegExp | null;
  weak: RegExp | null;
  exclude: RegExp | null;
  programme: RegExp | null;
  require: RegExp[];
}

const topicTerms = (id: string) => {
  const t = TOPICS[id];
  if (!t) throw new Error(`Unknown topic: ${id}`);
  return t;
};

export function planQuery(spec: QuerySpec): Plan {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(spec.id))
    throw new Error(`Query id must be lower-case letters, digits or dashes: ${spec.id}`);
  const q = fold(spec.query);
  const topics =
    spec.topics ??
    Object.entries(TOPICS)
      .filter(([, t]) => termPattern(t.triggers)?.test(q))
      .map(([id]) => id);
  const pick = (k: "terms" | "weak" | "exclude" | "programmes") =>
    topics.flatMap((t) => topicTerms(t)[k] ?? []);
  const strong = termPattern([...pick("terms"), ...(spec.terms ?? [])]);
  if (!strong) throw new Error(`Query "${spec.query}" selects no topic or term`);
  return {
    spec,
    topics,
    strong,
    weak: termPattern(pick("weak")),
    exclude: termPattern(pick("exclude")),
    programme: termPattern(pick("programmes")),
    require: (spec.require ?? []).map((id) => {
      const t = topicTerms(id);
      return termPattern([...t.terms, ...(t.weak ?? [])])!;
    }),
  };
}

export interface MatchInput {
  titleEn: string;
  titleFr?: string;
  description?: string;
  programme?: string;
  /** Recipient names, removed from the titles before matching. */
  names?: string[];
}
export type MatchWhere = "title" | "programme" | "title-weak" | "description";
export interface Match {
  where: MatchWhere;
  terms: string[];
}
export const TIER: Record<MatchWhere, number> = {
  title: 3,
  programme: 3,
  "title-weak": 2,
  description: 1,
};

const hits = (re: RegExp | null, text: string) =>
  re ? [...text.matchAll(re)].map((m) => m[0]) : [];

function withoutNames(title: string, names: string[]): string {
  let t = title;
  for (const n of names.map(fold).filter((n) => n.length >= 4)) t = t.split(n).join(" ");
  return t;
}

/**
 * Strong terms count in either title (then the programme name, then the description); weak terms
 * only in the English title; an exclusion anywhere vetoes; every required topic must be mentioned.
 */
export function matchText(plan: Plan, input: MatchInput): Match | null {
  const names = input.names ?? [];
  const en = withoutNames(fold(input.titleEn), names);
  const fr = withoutNames(fold(input.titleFr ?? ""), names);
  const d = fold(input.description ?? "");
  const p = fold(input.programme ?? "");
  const all = [en, fr, d, p];
  if (plan.exclude && all.some((x) => hits(plan.exclude, x).length)) return null;
  if (plan.require.some((re) => !all.some((x) => hits(re, x).length))) return null;
  const found = (where: MatchWhere, terms: string[]): Match | null =>
    terms.length ? { where, terms: [...new Set(terms)].sort() } : null;
  return (
    found("title", [...hits(plan.strong, en), ...hits(plan.strong, fr)]) ??
    found("programme", hits(plan.programme, p)) ??
    found("title-weak", hits(plan.weak, en)) ??
    found("description", hits(plan.strong, d))
  );
}

export interface Candidate {
  rank: number;
  key: string;
  matchIn: MatchWhere;
  matchedTerms: string[];
  recipient: string;
  operatingName: string | null;
  recipientType: string;
  recipientKey: string;
  businessNumberRoot: string | null;
  city: string | null;
  province: string | null;
  postalArea: string | null;
  department: string;
  departmentCode: string;
  programme: string;
  title: string;
  description: string;
  /** Original agreement value (amendment 0), CAD as stated; null when the original row is absent. */
  originalValue: string | null;
  originalRowInFile: boolean;
  amendments: number;
  startDate: string | null;
  endDate: string | null;
  recipientFirstGrant: string | null;
  recipientAgreements: number;
  recipientOriginalTotal: string;
  recipientLatestGrant: string | null;
  recipientProgrammes: string[];
  /** Other agreements of the same recipient that also match (not shown separately). */
  otherMatchingAgreements: number;
  /** Treasury Board row locator (importer format) of the original row, else the earliest amendment. */
  locator: string;
}

export interface QueryResult {
  id: string;
  query: string;
  topics: string[];
  require: string[];
  filters: Filters;
  counts: {
    matched: number;
    titleMatches: number;
    afterFilters: number;
    recipients: number;
    shown: number;
  };
  candidates: Candidate[];
}

export interface SearchStats {
  rows: number;
  individualsSkipped: number;
  invalidRows: number;
  recipients: number;
}

interface AgreementInfo {
  minAmendment: number;
  value: string | null;
  original: boolean;
  locator: string;
  rows: number;
  start: string | null;
  end: string | null;
}
interface RecipientInfo {
  latest: string | null;
  agreements: Set<string>;
  total: bigint; // cents, originals only
  programmes: Map<string, number>;
}
type HitFields = Pick<
  Candidate,
  | "key"
  | "recipient"
  | "operatingName"
  | "recipientType"
  | "recipientKey"
  | "businessNumberRoot"
  | "city"
  | "province"
  | "postalArea"
  | "department"
  | "departmentCode"
  | "programme"
  | "title"
  | "description"
>;
interface Hit {
  match: Match;
  fields: HitFields;
  nameKey: string | null;
  country: string;
}

const ALLOWLIST = Object.keys(toGrantRow({ amendment_number: "0" }).sourceCells!);
const EXTRA = [
  "recipient_country",
  "recipient_province",
  "recipient_city",
  "agreement_title_fr",
  "description_en",
  "description_fr",
  "expected_results_en",
];
const COLUMNS = new Set([...ALLOWLIST, ...EXTRA]);

const cents = (value: string | null): bigint => {
  if (!value) return 0n;
  const [whole, frac = ""] = value.replace(/^-/, "").split(".");
  const c = BigInt(whole!) * 100n + BigInt((frac + "00").slice(0, 2));
  return value.startsWith("-") ? -c : c;
};
const dollars = (c: bigint) => {
  const sign = c < 0n ? "-" : "";
  const a = c < 0n ? -c : c;
  return `${sign}${a / 100n}.${String(a % 100n).padStart(2, "0")}`;
};
const minDate = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);
const maxDate = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);
/** "Bedford|Bedford" (bilingual cell) → "Bedford"; distinct parts are kept. */
const place = (raw: string | undefined) =>
  [
    ...new Set(
      (raw ?? "")
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].join(" / ") || null;

/** One pass over the grants CSV for every plan. */
export async function searchGrants(
  input: AsyncIterable<string | Buffer> | Iterable<string | Buffer>,
  plans: Plan[],
): Promise<{ results: QueryResult[]; stats: SearchStats }> {
  const stats: SearchStats = { rows: 0, individualsSkipped: 0, invalidRows: 0, recipients: 0 };
  const recipients = new Map<string, RecipientInfo>();
  const firstBy = new Map<string, string>(); // "bn:…" and "name:…" keys
  const agreements = new Map<string, AgreementInfo>();
  const hitsByPlan = plans.map(() => new Map<string, Hit>());
  const allowedTypes = new Set(plans.flatMap((p) => p.spec.filters?.recipientTypes ?? ["F"]));

  for await (const record of readCsv(input as AsyncIterable<string | Buffer>, undefined, (h) =>
    COLUMNS.has(h),
  )) {
    stats.rows++;
    const type = (record.recipient_type ?? "").trim();
    if (type === "P") {
      stats.individualsSkipped++;
      continue;
    }
    let row;
    try {
      row = toGrantRow(record);
    } catch {
      stats.invalidRows++;
      continue;
    }
    const bn = businessNumberRoot(row.recipient_business_number);
    const name = nameKey(row.recipient_legal_name) || null;
    if (!bn && !name) continue;
    const recipientKey = bn ? `bn:${bn}` : `name:${name}`;
    const key = `${row.owner_org}|${row.ref_number || rowLocator("grants", row)}`;
    const start = row.agreement_start_date;

    for (const k of [bn && `bn:${bn}`, name && `name:${name}`])
      if (k && start) firstBy.set(k, minDate(firstBy.get(k) ?? null, start)!);
    let r = recipients.get(recipientKey);
    if (!r) {
      r = { latest: null, agreements: new Set(), total: 0n, programmes: new Map() };
      recipients.set(recipientKey, r);
    }
    r.latest = maxDate(r.latest, start);
    if (row.amendment_number === 0 && !r.agreements.has(key)) {
      r.agreements.add(key);
      r.total += cents(row.agreement_value);
      if (row.prog_name_en)
        r.programmes.set(row.prog_name_en, (r.programmes.get(row.prog_name_en) ?? 0) + 1);
    }
    if (!allowedTypes.has(type)) continue;

    const a = agreements.get(key);
    if (!a || row.amendment_number < a.minAmendment) {
      agreements.set(key, {
        minAmendment: row.amendment_number,
        value: row.agreement_value,
        original: row.amendment_number === 0,
        locator: rowLocator("grants", row),
        rows: (a?.rows ?? 0) + 1,
        start: minDate(a?.start ?? null, start),
        end: maxDate(a?.end ?? null, row.agreement_end_date),
      });
    } else {
      a.rows++;
      a.start = minDate(a.start, start);
      a.end = maxDate(a.end, row.agreement_end_date);
    }

    const input: MatchInput = {
      titleEn: row.agreement_title_en,
      titleFr: record.agreement_title_fr ?? "",
      description: [
        record.description_en ?? "",
        record.description_fr ?? "",
        record.expected_results_en ?? "",
      ].join(" ‖ "),
      programme: row.prog_name_en,
      names: [
        ...row.recipient_legal_name.split("|"),
        ...row.recipient_operating_name.split("|"),
      ].map((s) => s.trim()),
    };
    plans.forEach((plan, i) => {
      if (!(plan.spec.filters?.recipientTypes ?? ["F"]).includes(type)) return;
      const match = matchText(plan, input);
      if (!match) return;
      const prior = hitsByPlan[i]!.get(key);
      if (prior && TIER[prior.match.where] >= TIER[match.where]) return;
      hitsByPlan[i]!.set(key, {
        match,
        nameKey: name,
        country: (record.recipient_country ?? "").trim().toUpperCase(),
        fields: {
          key,
          recipient: row.recipient_legal_name,
          operatingName: row.recipient_operating_name || null,
          recipientType: type,
          recipientKey,
          businessNumberRoot: bn,
          city: place(record.recipient_city),
          province: (record.recipient_province ?? "").trim() || null,
          postalArea: postalFsa(row.recipient_postal_code),
          department: row.owner_org_title,
          departmentCode: row.owner_org,
          programme: row.prog_name_en,
          title: row.agreement_title_en || (record.agreement_title_fr ?? "").trim(),
          description: (record.description_en || record.description_fr || "").trim().slice(0, 600),
        },
      });
    });
  }
  stats.recipients = recipients.size;

  const results = plans.map((plan, i): QueryResult => {
    const f = plan.spec.filters ?? {};
    const dept = f.department ? new RegExp(f.department, "i") : null;
    const prog = f.programme ? new RegExp(f.programme, "i") : null;
    const excludeProg = (f.excludeProgramme ?? "Canada Summer Jobs") || null;
    const dropProg = excludeProg ? new RegExp(excludeProg, "i") : null;
    const countries = f.countries ?? ["CA", ""];
    const hits = [...hitsByPlan[i]!.values()];
    const all = hits.map((h): Candidate & { country: string } => {
      const a = agreements.get(h.fields.key)!;
      const r = recipients.get(h.fields.recipientKey)!;
      const bnKey = h.fields.businessNumberRoot ? `bn:${h.fields.businessNumberRoot}` : null;
      const nmKey = h.nameKey ? `name:${h.nameKey}` : null;
      return {
        rank: 0,
        matchIn: h.match.where,
        matchedTerms: h.match.terms,
        ...h.fields,
        country: h.country,
        originalValue: a.original ? a.value : null,
        originalRowInFile: a.original,
        amendments: a.rows - 1,
        startDate: a.start,
        endDate: a.end,
        recipientFirstGrant: minDate(
          bnKey ? (firstBy.get(bnKey) ?? null) : null,
          nmKey ? (firstBy.get(nmKey) ?? null) : null,
        ),
        recipientAgreements: r.agreements.size,
        recipientOriginalTotal: dollars(r.total),
        recipientLatestGrant: r.latest,
        recipientProgrammes: [...r.programmes]
          .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
          .slice(0, 5)
          .map(([p]) => p),
        otherMatchingAgreements: 0,
        locator: a.locator,
      };
    });
    const value = (c: Candidate) => Number(c.originalValue ?? NaN);
    const kept = all.filter(
      (c) =>
        countries.includes(c.country) &&
        (!f.firstSince ||
          (c.recipientFirstGrant !== null && c.recipientFirstGrant >= f.firstSince)) &&
        (!f.startSince || (c.startDate !== null && c.startDate >= f.startSince)) &&
        (!f.provinces?.length || (c.province !== null && f.provinces.includes(c.province))) &&
        (!dept || dept.test(c.departmentCode) || dept.test(c.department)) &&
        (!prog || prog.test(c.programme)) &&
        (!dropProg || !dropProg.test(c.programme)) &&
        (f.minValue === undefined || value(c) >= f.minValue) &&
        (f.maxValue === undefined || value(c) <= f.maxValue),
    );
    kept.sort(
      (a, b) =>
        TIER[b.matchIn] - TIER[a.matchIn] ||
        (b.startDate ?? "").localeCompare(a.startDate ?? "") ||
        a.locator.localeCompare(b.locator),
    );
    const per = plan.spec.perRecipient ?? 1;
    const byRecipient = new Map<string, (Candidate & { country: string })[]>();
    for (const c of kept)
      byRecipient.set(c.recipientKey, [...(byRecipient.get(c.recipientKey) ?? []), c]);
    const grouped = kept.filter((c) => byRecipient.get(c.recipientKey)!.indexOf(c) < per);
    const shown = grouped.slice(0, plan.spec.limit ?? 200).map((c, n) => {
      const { country: _country, ...rest } = c;
      void _country;
      return {
        ...rest,
        rank: n + 1,
        otherMatchingAgreements: Math.max(0, byRecipient.get(c.recipientKey)!.length - per),
      };
    });
    return {
      id: plan.spec.id,
      query: plan.spec.query,
      topics: plan.topics,
      require: plan.spec.require ?? [],
      filters: f,
      counts: {
        matched: all.length,
        titleMatches: all.filter((c) => TIER[c.matchIn] === 3).length,
        afterFilters: kept.length,
        recipients: byRecipient.size,
        shown: shown.length,
      },
      candidates: shown,
    };
  });
  return { results, stats };
}
