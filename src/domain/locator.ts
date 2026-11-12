/**
 * Readable display of Treasury Board row locators (BACKLOG item 1). Display only: a stored locator is
 * never rewritten. Contract form: `reference_number=…;procurement_id=…;vendor_name=…;owner_org=…;
 * locator_version=1;row_sha256=…`; grant form: `ref_number=…;amendment_number=…;agreement_number=…;
 * recipient_legal_name=…;owner_org=…;locator_version=1;row_sha256=…`. Older unversioned locators
 * (`ref_number=…;amendment_number=0 (prog_name_en)`) are decoded without URL-decoding; anything else
 * returns null so the caller shows the raw text. Browser-safe: no Node imports.
 */

import type { OrgView } from "./schema/snapshot";

export interface LocatorField {
  label: string;
  value: string;
}

export interface DecodedLocator {
  form: "contract" | "grant";
  fields: LocatorField[];
  /** The row's SHA-256 fingerprint, shown on demand. */
  fingerprint: string | null;
  raw: string;
}

/** Department name for a TBS `owner_org` code, when the corpus records one. */
export type DepartmentLookup = (code: string) => string | undefined;

const LABEL: Record<string, string> = {
  reference_number: "Reference number",
  ref_number: "Reference number",
  procurement_id: "Procurement ID",
  agreement_number: "Agreement number",
  vendor_name: "Vendor (as stated)",
  recipient_legal_name: "Recipient (as stated)",
  amendment_number: "Amendment number",
  owner_org: "Department",
};

const COLUMN: Record<string, string> = {
  prog_name_en: "programme name",
  agreement_title_en: "agreement title",
  agreement_start_date: "start date",
  agreement_end_date: "end date",
  agreement_value: "agreement value",
  description_en: "description",
  contract_value: "contract value",
  original_value: "original value",
  contract_date: "contract date",
  delivery_date: "delivery date",
};

/** Department names from published `tbs-owner-org` registry identifiers (unverified codes stay codes). */
export function departmentLookup(orgs: Iterable<OrgView>): DepartmentLookup {
  const names = new Map<string, string>();
  for (const o of orgs)
    for (const id of o.identifiers ?? [])
      if (id.system === "tbs-owner-org" && !names.has(id.value)) names.set(id.value, o.name);
  return (code) => names.get(code);
}

/** "C-2023-2024-Q2-00239" or "172-2025-2026-Q4-1040771" → "2023-2024, Q2" (TBS reference numbers embed it). */
export function reportingPeriod(reference: string): string | null {
  const m = /(?:^|-)(\d{4})-(\d{4})-Q([1-4])(?:-|$)/.exec(reference);
  return m && Number(m[2]) === Number(m[1]) + 1 ? `${m[1]}-${m[2]}, Q${m[3]}` : null;
}

export function decodeGovLocator(
  locator: string,
  departments: DepartmentLookup = () => undefined,
): DecodedLocator | null {
  const raw = locator;
  let body = locator.trim();
  // Older locators name the columns read in a trailing parenthesis.
  let columns: string | null = null;
  const paren = /\s+\(([^()]*)\)$/.exec(body);
  if (paren) {
    columns = paren[1]!;
    body = body.slice(0, paren.index);
  }
  const versioned = /(^|;)locator_version=/.test(body);
  const pairs: [string, string][] = [];
  for (const part of body.split(";")) {
    const at = part.indexOf("=");
    if (at < 1) return null;
    const key = part.slice(0, at).trim();
    let value = part.slice(at + 1).trim();
    if (pairs.some(([k]) => k === key)) return null;
    if (versioned) {
      try {
        value = decodeURIComponent(value);
      } catch {
        return null;
      }
    }
    pairs.push([key, value]);
  }
  const map = new Map(pairs);
  const form = map.has("reference_number") ? "contract" : map.has("ref_number") ? "grant" : null;
  if (!form) return null;
  if (versioned && map.get("locator_version") !== "1") return null;
  const fingerprint = map.get("row_sha256") ?? null;
  if (fingerprint !== null && !/^[a-f0-9]{64}$/.test(fingerprint)) return null;

  const fields: LocatorField[] = [];
  for (const [key, value] of pairs) {
    if (key === "locator_version" || key === "row_sha256") continue;
    if (key === "owner_org") {
      const name = departments(value);
      fields.push({ label: LABEL[key]!, value: name ? `${name} (${value})` : value });
      continue;
    }
    if (key === "amendment_number") {
      fields.push({ label: LABEL[key]!, value: value === "0" ? "0 (original agreement)" : value });
      continue;
    }
    fields.push({ label: LABEL[key] ?? key, value });
    if (key === "reference_number" || key === "ref_number") {
      const period = reportingPeriod(value);
      if (period) fields.push({ label: "Reporting period", value: period });
    }
  }
  if (columns !== null)
    fields.push({
      label: "Fields read",
      value: columns
        .split(/\s*,\s*/)
        .map((c) => COLUMN[c] ?? c)
        .join(", "),
    });
  return { form, fields, fingerprint, raw };
}
