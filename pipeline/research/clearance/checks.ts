/**
 * Deterministic checks added by the clearance policy (policy section 5). Pure functions over the
 * corpus, saved copies and dataset rows; no AI, no network, no writes.
 *
 * - rowEvidence: what a cited federal dataset row says (recipient name, BN), for any record, not
 *   only agreements. A legal name or BN taken from a row is checked against the row itself.
 * - legalFormRisk: "PV Labs Inc." on a row and "PV Labs Ltd." in CANDEF have the same base name
 *   and a different legal element: a possible predecessor, successor or affiliate. Name matching
 *   that drops legal forms cannot see this, so it is flagged wherever a row is cited.
 * - entityInCopy: the saved copy that holds the value also names this entity.
 * - normalization and duplicate checks for rounds.
 */
import type {
  Assertion,
  Corpus,
  Evidence,
  FinancingRound,
  Organization,
} from "../../../src/domain/schema/corpus";
import { INACTIVE } from "../../compile/facts";
import { locatorMatches, parseLocator } from "../../ingest/gov/locators";
import type { ContractRow, GrantRow } from "../../ingest/gov/tbs";
import { businessNumberRoot, nameKey as govNameKey } from "../names";
import type { RawRows } from "../verifyGovClaims";
import { sigKey } from "../blind";
import { flat } from "./relate";

export const DATASETS = { contracts: "src_54baa50305c0", grants: "src_06a51c1749c5" };

type Row = ContractRow | GrantRow;
const isContract = (r: Row): r is ContractRow => "reference_number" in r;

/** The legal element of a name, by class: Inc. and Incorporated agree; Inc. and Ltd. do not. */
export function legalFormClass(name: string): string | null {
  const t = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/);
  const last = t.at(-1) ?? "";
  const cls: Record<string, string> = {
    INC: "inc",
    INCORPORATED: "inc",
    INCORPOREE: "inc",
    LTD: "ltd",
    LIMITED: "ltd",
    LTEE: "ltd",
    LIMITEE: "ltd",
    CORP: "corp",
    CORPORATION: "corp",
    LLC: "llc",
    ULC: "ulc",
    PLC: "plc",
  };
  return cls[last] ?? null;
}

/** Strips a trailing "(field_name)" hint from a dataset locator before parsing. */
export function rowLocator(locator: string): Map<string, string> | null {
  return parseLocator(locator.replace(/\s*\([a-z_]+\)\s*$/i, "").trim());
}

/** The dataset rows an evidence item cites (empty when it cites no dataset or rows are not loaded). */
export function citedDatasetRows(e: Evidence, rows: RawRows | null): Row[] {
  if (!rows) return [];
  const fields = rowLocator(e.locator);
  if (!fields) return [];
  if (e.sourceId === DATASETS.contracts) {
    // A reference number is reused by many departments: every other field in the locator
    // (procurement ID, owner organization, vendor) narrows it to the cited row.
    const ref = fields.get("reference_number");
    const pool = ref ? (rows.contracts.get(ref) ?? []) : [];
    return pool.filter((r) => locatorMatches(fields, r));
  }
  if (e.sourceId === DATASETS.grants) {
    const ref = fields.get("ref_number");
    const amend = fields.get("amendment_number");
    const pool = ref ? (rows.grants.get(ref) ?? []) : [];
    return amend === undefined ? pool : pool.filter((r) => String(r.amendment_number) === amend);
  }
  return [];
}

export const rowNames = (r: Row): string[] =>
  isContract(r)
    ? [r.vendor_name]
    : [r.recipient_legal_name, r.recipient_operating_name].filter((n): n is string => !!n);

export const rowBn = (r: Row): string | null =>
  isContract(r) ? null : businessNumberRoot(r.recipient_business_number);

/** Every name the entity is recorded under (display name and every live legal name). */
export function entityNames(corpus: Corpus, orgId: string): string[] {
  const org = corpus.organizations.find((o) => o.id === orgId);
  const legal = corpus.assertions
    .filter(
      (a) => a.subjectId === orgId && a.predicate === "legal_name" && !INACTIVE.has(a.verification),
    )
    .map((a) => String(a.value));
  return [org?.name, ...legal].filter((n): n is string => !!n);
}

export interface LegalFormRisk {
  rowName: string;
  entityName: string;
  reference: string;
}

/**
 * Rows cited by any evidence of a record whose recipient has this entity's base name but a
 * different legal element than every recorded legal name.
 */
export function legalFormRisks(
  evidence: Evidence[],
  rows: RawRows | null,
  names: string[],
): LegalFormRisk[] {
  const out: LegalFormRisk[] = [];
  const legal = names.filter((n) => legalFormClass(n));
  if (!legal.length) return out;
  for (const e of evidence)
    for (const row of citedDatasetRows(e, rows))
      for (const rn of rowNames(row).flatMap((n) => n.split("|"))) {
        const form = legalFormClass(rn);
        if (!form) continue;
        const sameBase = legal.filter((n) => govNameKey(n) === govNameKey(rn));
        if (sameBase.length && sameBase.every((n) => legalFormClass(n) !== form))
          out.push({
            rowName: rn.trim(),
            entityName: sameBase[0]!,
            reference: e.locator.replace(/\s*\([a-z_]+\)\s*$/i, ""),
          });
      }
  return out;
}

/**
 * V-copy for values taken from a dataset row: the row field named in the locator hint equals the
 * value (legal name by name key and legal element; BN by its 9-digit root).
 */
export function rowValueCheck(
  a: Assertion,
  rows: RawRows | null,
): { found: boolean; reason: string } | null {
  // Only a legal name or a business number can be carried by a row's own fields.
  if (a.predicate !== "legal_name" && a.predicate !== "registry_id") return null;
  const ev = a.evidence.filter(
    (e) => e.sourceId === DATASETS.contracts || e.sourceId === DATASETS.grants,
  );
  if (!ev.length) return null;
  const mixed = ev.length !== a.evidence.length;
  if (!rows) return mixed ? null : { found: false, reason: "dataset rows not loaded" };
  for (const e of ev) {
    const cited = citedDatasetRows(e, rows);
    if (!cited.length) return { found: false, reason: `no dataset row for ${e.locator}` };
    const v = a.value as { value?: string } | string;
    const ok = cited.every((row) => {
      if (a.predicate === "legal_name") {
        const want = String(v);
        return rowNames(row)
          .flatMap((n) => n.split("|"))
          .some(
            (n) =>
              govNameKey(n) === govNameKey(want) &&
              (legalFormClass(n) ?? legalFormClass(want)) ===
                (legalFormClass(want) ?? legalFormClass(n)),
          );
      }
      if (a.predicate === "registry_id")
        return rowBn(row) === businessNumberRoot((v as { value?: string }).value);
      return false;
    });
    // With other evidence beside the rows, a row that does not carry the value is not decisive:
    // the page-copy check decides. With rows alone it is a failure.
    if (!ok)
      return mixed
        ? null
        : { found: false, reason: `the cited row does not carry the value (${e.locator})` };
  }
  return { found: true, reason: `value equals the cited dataset row(s) (${ev.length})` };
}

/** V-ent for a saved copy: the copy names the entity (any recorded name, legal form ignored). */
export function entityInText(text: string, names: string[]): string | null {
  const t = flat(text);
  for (const n of names) {
    const k = flat(govNameKey(n));
    if (k.length >= 3 && t.includes(k)) return n;
  }
  return null;
}

/** First-party source: the evidence URL is on the company's own website. */
export function sameSite(url: string, website: string | null): boolean {
  if (!website) return false;
  try {
    const a = new URL(url).hostname.replace(/^www\./, "");
    const b = new URL(website).hostname.replace(/^www\./, "");
    return a === b || a.endsWith(`.${b}`);
  } catch {
    return false;
  }
}

const NAMED_CURRENCY = /US\$|USD|CA\$|C\$|CAD|CDN|€|EUR|£|GBP|\b(?:US|Canadian|euro|pound)\b/i;

const PARTIAL_DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/** V-norm for a round: dates, currencies, amounts and the disclosure sequence are well formed. */
export function roundNormalization(r: FinancingRound, today: string): string[] {
  const problems: string[] = [];
  const dated = [...r.disclosures].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of r.disclosures) {
    if (!PARTIAL_DATE.test(d.date)) problems.push(`${d.id}: date "${d.date}" is not a valid date`);
    else if (d.date > today) problems.push(`${d.id}: date ${d.date} is in the future`);
    if (d.amount.amount !== null) {
      if (Number(d.amount.amount) <= 0) problems.push(`${d.id}: amount is not positive`);
      // A source that writes a bare "$" leaves the currency unknown, and recording it as unknown
      // is correct (never assume CAD or USD). It is a problem only when the stated text names a
      // currency the record left out.
      if (d.amount.currency === "unknown" && NAMED_CURRENCY.test(d.amount.asStated))
        problems.push(
          `${d.id}: the stated amount "${d.amount.asStated}" names a currency but the record says unknown`,
        );
    }
  }
  if (r.disclosures.filter((d) => d.kind === "final").length > 1)
    problems.push("more than one final close");
  const cumulative = dated.filter(
    (d) => d.amountBasis === "cumulative_round_total" && d.amount.amount,
  );
  for (let i = 1; i < cumulative.length; i++)
    if (
      cumulative[i]!.amount.currency === cumulative[i - 1]!.amount.currency &&
      Number(cumulative[i]!.amount.amount) < Number(cumulative[i - 1]!.amount.amount)
    )
      problems.push(
        `cumulative total falls from ${cumulative[i - 1]!.amount.amount} to ${cumulative[i]!.amount.amount}: a tranche recorded as a round total?`,
      );
  return problems;
}

/** V-dup: another live round of the same company with an equal amount within 90 days. */
export function duplicateRounds(r: FinancingRound, corpus: Corpus): string[] {
  const keys = new Set(
    r.disclosures
      .map((d) =>
        d.amount.amount ? `${sigKey(Number(d.amount.amount))}${d.amount.currency}` : null,
      )
      .filter(Boolean),
  );
  const days = (s: string) =>
    Date.parse(s.length === 4 ? `${s}-07-01` : s.length === 7 ? `${s}-15` : s) / 864e5;
  const out: string[] = [];
  for (const o of corpus.rounds) {
    if (o.id === r.id || o.companyId !== r.companyId || INACTIVE.has(o.verification)) continue;
    for (const d of o.disclosures) {
      const k = d.amount.amount ? `${sigKey(Number(d.amount.amount))}${d.amount.currency}` : null;
      if (!k || !keys.has(k)) continue;
      const near = r.disclosures.some((x) => Math.abs(days(x.date) - days(d.date)) <= 90);
      if (near) out.push(`${o.id} has the same amount within 90 days`);
    }
  }
  return [...new Set(out)];
}

/** The company's website, from its `website` assertion. */
export function websiteOf(corpus: Corpus, org: Organization | undefined): string | null {
  if (!org) return null;
  const a = corpus.assertions.find(
    (x) => x.subjectId === org.id && x.predicate === "website" && !INACTIVE.has(x.verification),
  );
  const v = a?.value as string | { url?: string } | undefined;
  return typeof v === "string" ? v : (v?.url ?? null);
}
