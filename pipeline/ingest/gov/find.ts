/**
 * Researcher lookup over the TBS proactive-disclosure CSVs (discovery, not matching).
 *
 *   npx tsx pipeline/ingest/gov/find.ts --name "kepler" [--name "…"] \
 *     [--contracts <contracts.csv>] [--grants <grants.csv>] [--owner dnd-mdn] [--program "defence"] [--json <out>]
 *
 * Prints every row whose vendor/recipient name contains one of the given names (case, accents and
 * punctuation ignored), with the row locator (`reference_number` / `ref_number` + amendment) a
 * researcher cites after reading the row. `--owner` and `--program` narrow by department code or
 * program-name substring and also work without `--name` (candidate discovery).
 *
 * A substring hit is NOT a match: the same name can be another company. Attach a row to an
 * organization only after checking the name AND a second identifier (postal code or BN).
 * Contact columns do not exist in these two datasets; nothing is written to Git.
 */
import { createReadStream, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readCsv } from "./csv";
import { rowLocator } from "./locators";
import { toContractRow, toGrantRow } from "./tbs";

export const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const CONTRACT_COLUMNS = [
  "reference_number",
  "procurement_id",
  "vendor_name",
  "vendor_postal_code",
  "owner_org",
  "contract_date",
  "contract_period_start",
  "delivery_date",
  "contract_value",
  "original_value",
  "amendment_value",
  "description_en",
  "solicitation_procedure",
  "number_of_bids",
  "instrument_type",
  "country_of_vendor",
  "reporting_period",
] as const;

const GRANT_COLUMNS = [
  "ref_number",
  "amendment_number",
  "amendment_date",
  "agreement_type",
  "recipient_type",
  "recipient_business_number",
  "recipient_legal_name",
  "recipient_operating_name",
  "recipient_city",
  "recipient_province",
  "recipient_postal_code",
  "owner_org",
  "prog_name_en",
  "agreement_title_en",
  "agreement_value",
  "foreign_currency_type",
  "foreign_currency_value",
  "agreement_start_date",
  "agreement_end_date",
] as const;

export interface FindQuery {
  names: string[];
  owner?: string;
  program?: string;
}

export interface FindHit {
  dataset: "contracts" | "grants";
  locator: string;
  row: Record<string, string>;
}

/** True when the row's name fields contain any query name and it passes the optional filters. */
export function rowMatches(
  dataset: FindHit["dataset"],
  row: Record<string, string>,
  q: FindQuery,
): boolean {
  // Individuals and sole proprietorships are people, not companies (D-17): never listed.
  if (dataset === "grants" && row.recipient_type === "P") return false;
  if (q.owner && row.owner_org !== q.owner) return false;
  if (q.program && !norm(row.prog_name_en ?? "").includes(norm(q.program))) return false;
  if (!q.names.length) return true;
  const names =
    dataset === "contracts"
      ? [row.vendor_name ?? ""]
      : [row.recipient_legal_name ?? "", row.recipient_operating_name ?? ""];
  const hay = names.map(norm).join(" | ");
  return q.names.some((n) => hay.includes(norm(n)));
}

export const locatorOf = (dataset: FindHit["dataset"], row: Record<string, string>) =>
  dataset === "contracts"
    ? rowLocator(dataset, toContractRow(row))
    : rowLocator(dataset, toGrantRow(row));

export async function find(
  dataset: FindHit["dataset"],
  input: AsyncIterable<string | Buffer>,
  q: FindQuery,
): Promise<FindHit[]> {
  const keep = new Set<string>(dataset === "contracts" ? CONTRACT_COLUMNS : GRANT_COLUMNS);
  const hits: FindHit[] = [];
  for await (const row of readCsv(input))
    if (rowMatches(dataset, row, q))
      hits.push({
        dataset,
        locator: locatorOf(dataset, row),
        row: Object.fromEntries(Object.entries(row).filter(([key]) => keep.has(key))),
      });
  return hits;
}

function summary(h: FindHit): string {
  const r = h.row;
  return h.dataset === "contracts"
    ? `${r.reference_number} | ${r.vendor_name} | ${r.vendor_postal_code || "-"} | ${r.owner_org} | ${r.contract_date} | value ${r.contract_value || "-"} (orig ${r.original_value || "-"}, amend ${r.amendment_value || "-"}) | ${r.description_en}`
    : `${r.ref_number}#${r.amendment_number} | ${r.agreement_type} | ${r.recipient_legal_name}${r.recipient_operating_name ? ` (${r.recipient_operating_name})` : ""} | BN ${r.recipient_business_number || "-"} | ${r.recipient_city}, ${r.recipient_province} ${r.recipient_postal_code || "-"} | ${r.owner_org} | ${r.prog_name_en} | ${r.agreement_value} ${r.foreign_currency_type || ""} | ${r.agreement_start_date}→${r.agreement_end_date}`;
}

if (process.argv[1]?.endsWith("find.ts")) {
  const { values } = parseArgs({
    options: {
      name: { type: "string", multiple: true, default: [] },
      contracts: { type: "string" },
      grants: { type: "string" },
      owner: { type: "string" },
      program: { type: "string" },
      json: { type: "string" },
    },
  });
  const q: FindQuery = { names: values.name, owner: values.owner, program: values.program };
  if (!q.names.length && !q.owner && !q.program) {
    console.error("give at least one --name, --owner or --program");
    process.exit(1);
  }
  const hits: FindHit[] = [];
  if (values.contracts)
    hits.push(...(await find("contracts", createReadStream(values.contracts), q)));
  if (values.grants) hits.push(...(await find("grants", createReadStream(values.grants), q)));
  for (const h of hits) console.log(`${h.dataset}: ${summary(h)}`);
  console.log(
    `${hits.length} rows (discovery only: confirm name AND postal code or BN before use)`,
  );
  if (values.json) writeFileSync(values.json, JSON.stringify(hits, null, 2));
}
