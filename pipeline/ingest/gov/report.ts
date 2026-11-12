import type { ForeignCurrencyRow, RowWarning } from "./group";
import type { MatchResult, MatchStatus, Recipient } from "./match";
import type { DatasetKind } from "./tbs";
import { canonical, compare } from "./locators";
export type ReportDataset = DatasetKind | "canadabuys";

export interface CanadaBuysReport {
  rowsRead: number;
  countsByContractStatus: Record<string, number>;
  countsByMatchStatus: Record<MatchStatus, number>;
  skippedCancelledGroups: number;
  currencyCadPerPspcDocumentation: number;
  taxes: "included";
  amendmentDeltas: "not_derived";
  endUserEntities: Record<string, number>;
  restructuring: string;
}
export function createCanadaBuysReport(): CanadaBuysReport {
  return {
    rowsRead: 0,
    countsByContractStatus: {},
    countsByMatchStatus: { confirmed: 0, ambiguous: 0, no_match: 0, consortium: 0 },
    skippedCancelledGroups: 0,
    currencyCadPerPspcDocumentation: 0,
    taxes: "included",
    amendmentDeltas: "not_derived",
    endUserEntities: {},
    restructuring:
      "The 2026 restructuring removed standing-offer call-ups, task authorizations, catalogue purchases and placeholder suppliers, and fixed duplicated amounts. Older files may contain these rows; the operator's source ID identifies the file used.",
  };
}

export interface ReportRow {
  dataset: ReportDataset;
  reference: string;
  name: string;
  names: string[];
  businessNumber: string | null;
  postal: string | null;
  reason: string;
  candidateOrgIds: string[];
}
export interface MatchReport {
  importDate: string;
  rowsRead: number;
  rowsByDataset: Record<DatasetKind, number> & { canadabuys?: number };
  countsByStatus: Record<MatchStatus, number>;
  countsByMethod: Record<string, number>;
  confirmedRowsPerOrg: Record<string, number>;
  ambiguousRows: ReportRow[];
  ambiguousRowsOmitted: number;
  consortiumRows: ReportRow[];
  unmappedDepartments: Record<string, number>;
  skippedOtherGrants: number;
  /** Rows whose recipient is an individual or sole proprietorship (recipient_type P); D-17. */
  skippedIndividualGrants: number;
  foreignCurrencyRows: ForeignCurrencyRow[];
  warnings: RowWarning[];
  valueBasis: { options: "unknown"; taxes: "unknown" };
  proposedAgreements: number;
  canadaBuys?: CanadaBuysReport;
}
export function createReport(date: string): MatchReport {
  return {
    importDate: date,
    rowsRead: 0,
    rowsByDataset: { contracts: 0, grants: 0 },
    countsByStatus: { confirmed: 0, ambiguous: 0, no_match: 0, consortium: 0 },
    countsByMethod: {},
    confirmedRowsPerOrg: {},
    ambiguousRows: [],
    ambiguousRowsOmitted: 0,
    consortiumRows: [],
    unmappedDepartments: {},
    skippedOtherGrants: 0,
    skippedIndividualGrants: 0,
    foreignCurrencyRows: [],
    warnings: [],
    valueBasis: { options: "unknown", taxes: "unknown" },
    proposedAgreements: 0,
  };
}
export function increment(record: Record<string, number>, key: string, amount = 1): void {
  const count = Object.hasOwn(record, key) ? record[key]! : 0;
  Object.defineProperty(record, key, {
    value: count + amount,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
export function recordMatch(
  report: MatchReport,
  dataset: ReportDataset,
  reference: string,
  recipient: Recipient,
  match: MatchResult,
): void {
  report.rowsRead++;
  increment(report.rowsByDataset, dataset);
  report.countsByStatus[match.status]++;
  increment(report.countsByMethod, match.method);
  if (match.status === "confirmed" && match.orgId)
    increment(report.confirmedRowsPerOrg, match.orgId);
  if (match.status !== "ambiguous" && match.status !== "consortium") return;
  const detail: ReportRow = {
    dataset,
    reference,
    name: recipient.names[0] ?? "",
    ...recipient,
    reason: match.method,
    candidateOrgIds: match.candidates,
  };
  if (match.status === "consortium") report.consortiumRows.push(detail);
  else {
    report.ambiguousRows.push(detail);
    report.ambiguousRows.sort((a, b) => compare(canonical(a), canonical(b)));
    if (report.ambiguousRows.length > 200) {
      report.ambiguousRows.pop();
      report.ambiguousRowsOmitted++;
    }
  }
}
export function sortReport(report: MatchReport): void {
  for (const rows of [
    report.ambiguousRows,
    report.consortiumRows,
    report.foreignCurrencyRows,
    report.warnings,
  ])
    rows.sort((a, b) => compare(canonical(a), canonical(b)));
}
function cell(value: unknown): string {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
}
function table(headers: string[], rows: unknown[][]): string {
  if (!rows.length) return "None.\n";
  return (
    [headers, headers.map(() => "---"), ...rows]
      .map((row) => `| ${row.map(cell).join(" | ")} |`)
      .join("\n") + "\n"
  );
}
function countTable(counts: Record<string, number>): string {
  return table(
    ["Key", "Rows"],
    Object.entries(counts).sort(([a], [b]) => compare(a, b)),
  );
}
function details(rows: ReportRow[]): string {
  return table(
    ["Dataset", "Reference", "Name(s)", "BN", "Postal", "Reason", "Candidates"],
    rows.map((r) => [
      r.dataset,
      r.reference,
      r.names.join("; "),
      r.businessNumber,
      r.postal,
      r.reason,
      r.candidateOrgIds.join(", "),
    ]),
  );
}
export function renderReport(report: MatchReport): string {
  return (
    [
      report.canadaBuys ? "# Government import match report" : "# TBS import match report",
      `Import date: ${report.importDate}`,
      `Rows read: ${report.rowsRead}`,
      `Contracts: ${report.rowsByDataset.contracts}; grants: ${report.rowsByDataset.grants}`,
      `Proposed agreements: ${report.proposedAgreements}`,
      report.canadaBuys
        ? "All proposals require human review. TBS options and taxes: unknown. Values are row totals; they are never summed. Foreign currency is reported without conversion."
        : "All proposals require human review. Options and taxes: unknown. Values are row totals; they are never summed. Foreign currency is reported without conversion.",
      ...(report.canadaBuys
        ? [
            "## CanadaBuys",
            `CanadaBuys rows read: ${report.canadaBuys.rowsRead}`,
            "### Contract status counts",
            countTable(report.canadaBuys.countsByContractStatus),
            "### Match status counts",
            countTable(report.canadaBuys.countsByMatchStatus),
            `Cancelled groups skipped: ${report.canadaBuys.skippedCancelledGroups}`,
            `Rows with currency CAD per PSPC documentation: ${report.canadaBuys.currencyCadPerPspcDocumentation}`,
            "Taxes are included in contractAmount per the PSPC data dictionary. Amendment deltas are not derived: amendmentValue stays null because amendment contractAmount semantics are undocumented. Original values come only from amendment 000; total values come only from totalContractValue.",
            report.canadaBuys.restructuring,
            "### End-user entities (report only)",
            countTable(report.canadaBuys.endUserEntities),
          ]
        : []),
      "## Counts by status",
      countTable(report.countsByStatus),
      "## Counts by method",
      countTable(report.countsByMethod),
      "## Confirmed rows per organization",
      countTable(report.confirmedRowsPerOrg),
      "## Ambiguous rows (up to 200)",
      `Omitted details: ${report.ambiguousRowsOmitted}`,
      details(report.ambiguousRows),
      "## Consortium rows",
      details(report.consortiumRows),
      "## Unmapped departments (confirmed rows)",
      countTable(report.unmappedDepartments),
      "## Skipped other transfer payments",
      `O (other) rows seen: ${report.skippedOtherGrants} (kept only as earlier history of a later G or C row)`,
      "## Individual recipients (never matched, never listed; D-17)",
      `Rows with recipient_type P skipped: ${report.skippedIndividualGrants}`,
      "## Foreign-currency rows",
      table(
        ["Reference", "Amendment", "Currency", "Foreign value"],
        report.foreignCurrencyRows.map((r) => [
          r.reference,
          r.amendmentNumber,
          r.currency,
          r.value,
        ]),
      ),
      "## Warnings",
      table(
        ["Dataset", "Reference", "Reason"],
        report.warnings.map((r) => [r.dataset, r.reference, r.reason]),
      ),
    ].join("\n\n") + "\n"
  );
}
