export type DatasetKind = "contracts" | "grants";
const required = {
  contracts: [
    "reference_number",
    "vendor_name",
    "contract_value",
    "instrument_type",
    "reporting_period",
  ],
  grants: [
    "ref_number",
    "amendment_number",
    "recipient_legal_name",
    "agreement_value",
    "agreement_type",
  ],
};
export function validateHeader(kind: DatasetKind, headers: string[]): void {
  const missing = required[kind].filter((column) => !headers.includes(column));
  if (missing.length) throw new Error(`${kind}: missing required columns: ${missing.join(", ")}`);
}

export function parseMoney(raw: string, column = "money"): string | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) throw new Error(`Invalid ${column}: ${raw}`);
  const unsigned = cleaned.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
  return (cleaned.startsWith("-") ? "-" : "") + unsigned;
}
export function parseDate(raw: string): string | null {
  const value = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? value
    : null;
}
const contractText = [
  "reference_number",
  "procurement_id",
  "vendor_name",
  "vendor_postal_code",
  "buyer_name",
  "description_en",
  "description_fr",
  "comments_en",
  "comments_fr",
  "instrument_type",
  "reporting_period",
  "owner_org",
  "owner_org_title",
] as const;
const contractDates = ["contract_date", "contract_period_start", "delivery_date"] as const;
const contractMoney = ["contract_value", "original_value", "amendment_value"] as const;
const grantText = [
  "ref_number",
  "agreement_type",
  "recipient_type",
  "recipient_business_number",
  "recipient_legal_name",
  "recipient_operating_name",
  "research_organization_name",
  "recipient_postal_code",
  "prog_name_en",
  "agreement_title_en",
  "agreement_number",
  "foreign_currency_type",
  "owner_org",
  "owner_org_title",
] as const;
const grantDates = ["amendment_date", "agreement_start_date", "agreement_end_date"] as const;
const grantMoney = ["agreement_value", "foreign_currency_value"] as const;
export interface SourceCells {
  sourceCells?: Record<string, string>;
}
export type ContractRow = SourceCells &
  Record<(typeof contractText)[number], string> &
  Record<(typeof contractDates)[number] | (typeof contractMoney)[number], string | null>;
export type GrantRow = SourceCells &
  Record<(typeof grantText)[number], string> &
  Record<(typeof grantDates)[number] | (typeof grantMoney)[number], string | null> & {
    amendment_number: number;
  };

function strings<T extends string>(
  record: Record<string, string>,
  columns: readonly T[],
): Record<T, string> {
  return Object.fromEntries(
    columns.map((column) => [column, (record[column] ?? "").trim()]),
  ) as Record<T, string>;
}
function parsed<T extends string>(
  record: Record<string, string>,
  columns: readonly T[],
  parse: (value: string, column: string) => string | null,
): Record<T, string | null> {
  return Object.fromEntries(
    columns.map((column) => [column, parse(record[column] ?? "", column)]),
  ) as Record<T, string | null>;
}
export function toContractRow(record: Record<string, string>): ContractRow {
  return {
    sourceCells: Object.fromEntries(
      [...contractText, ...contractDates, ...contractMoney].map((key) => [key, record[key] ?? ""]),
    ),
    ...strings(record, contractText),
    ...parsed(record, contractDates, parseDate),
    ...parsed(record, contractMoney, parseMoney),
  };
}
export function toGrantRow(record: Record<string, string>): GrantRow {
  const raw = (record.amendment_number ?? "").trim();
  const amendment_number = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(amendment_number))
    throw new Error(`Invalid amendment_number: ${raw}`);
  return {
    sourceCells: Object.fromEntries(
      [...grantText, ...grantDates, ...grantMoney, "amendment_number"].map((key) => [
        key,
        record[key] ?? "",
      ]),
    ),
    ...strings(record, grantText),
    ...parsed(record, grantDates, parseDate),
    ...parsed(record, grantMoney, parseMoney),
    amendment_number,
  };
}
