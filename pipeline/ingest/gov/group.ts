import { createHash } from "node:crypto";
import { Agreement } from "../../../src/domain/schema/corpus";
import type { Evidence } from "../../../src/domain/schema/corpus";
import type { MatchResult } from "./match";
import type { ContractRow, GrantRow } from "./tbs";
import type { CanadaBuysRow } from "./canadabuys";
import { compare, rowFingerprint, rowLocator } from "./locators";
import { auditContractChain, auditGrantChain } from "./audit";
import type { AgreementIdentity } from "./identity";

export interface MatchedRow<T> {
  row: T;
  match: MatchResult;
}
export interface GroupOptions {
  bodies: Record<string, string>;
  sourceId: string;
  date: string;
}
export interface RowWarning {
  dataset: "contracts" | "grants" | "canadabuys";
  reference: string;
  reason: string;
}
export interface ForeignCurrencyRow {
  reference: string;
  amendmentNumber: number;
  currency: string;
  value: string | null;
}
export interface GroupResult {
  agreements: Agreement[];
  identities: AgreementIdentity[];
  unmappedDepartments: Record<string, number>;
  skippedOtherGrants: number;
  foreignCurrencyRows: ForeignCurrencyRow[];
  warnings: RowWarning[];
}
export function emptyGroupResult(): GroupResult {
  return {
    agreements: [],
    identities: [],
    unmappedDepartments: {},
    skippedOtherGrants: 0,
    foreignCurrencyRows: [],
    warnings: [],
  };
}
function groupKey(...parts: string[]): string {
  return JSON.stringify(parts);
}
function id(prefix: string, key: string): string {
  return prefix + createHash("sha256").update(key).digest("hex").slice(0, 16);
}
function evidence(sourceId: string, locator: string): Evidence {
  return { sourceId, locator, locatorQuality: "metadata" };
}
function common(options: GroupOptions, rows: Evidence[]) {
  return {
    epistemic: "sourced_fact" as const,
    verification: "proposed" as const,
    review: null,
    createdBy: "pipeline:tbs-import",
    evidence: rows,
    programId: null,
    groupId: null,
    currency: "CAD",
    valueStatements: [],
    allocations: [],
    statusAsOf: { state: "unknown" as const, asOf: options.date },
  };
}
function countUnmapped(result: GroupResult, department: string): void {
  // Define own properties so arbitrary department names cannot read Object.prototype.
  const count = Object.hasOwn(result.unmappedDepartments, department)
    ? result.unmappedDepartments[department]!
    : 0;
  Object.defineProperty(result.unmappedDepartments, department, {
    value: count + 1,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
function body(options: GroupOptions, department: string): string | null {
  return Object.hasOwn(options.bodies, department) ? options.bodies[department] || null : null;
}
function contractBody(options: GroupOptions, row: ContractRow): string | null {
  return body(options, row.owner_org) ?? body(options, row.buyer_name);
}
function add<T>(groups: Map<string, MatchedRow<T>[]>, key: string, row: MatchedRow<T>): void {
  const entries = groups.get(key) ?? [];
  entries.push(row);
  groups.set(key, entries);
}
function consistentRecipient<T>(
  entries: MatchedRow<T>[],
  result: GroupResult,
  dataset: RowWarning["dataset"],
  reference: string,
): boolean {
  if (new Set(entries.map((r) => r.match.orgId)).size === 1) return true;
  result.warnings.push({
    dataset,
    reference,
    reason: "group has conflicting confirmed recipients; no proposal emitted",
  });
  return false;
}
function uniqueRows<T extends ContractRow | GrantRow>(
  entries: MatchedRow<T>[],
  result: GroupResult,
  dataset: RowWarning["dataset"],
  reference: string,
): boolean {
  if (new Set(entries.map((e) => rowFingerprint(e.row))).size === entries.length) return true;
  result.warnings.push({
    dataset,
    reference,
    reason: "group has identical source rows; locator is not unique; no proposal emitted",
  });
  return false;
}

export function contractWarnings(row: ContractRow): RowWarning[] {
  const reasons: string[] = [];
  if (row.contract_value?.startsWith("-")) reasons.push("negative contract_value");
  if (row.instrument_type === "A" && row.amendment_value === null)
    reasons.push("amendment row has no amendment_value");
  if (row.contract_value === null)
    reasons.push("missing contract_value recorded as not stated (null), never as zero");
  return reasons.map((reason) => ({
    dataset: "contracts",
    reference: row.reference_number,
    reason,
  }));
}
export function grantForeignCurrency(row: GrantRow): ForeignCurrencyRow[] {
  return (row.foreign_currency_type && row.foreign_currency_type.toUpperCase() !== "CAD") ||
    row.foreign_currency_value !== null
    ? [
        {
          reference: row.ref_number,
          amendmentNumber: row.amendment_number,
          currency: row.foreign_currency_type,
          value: row.foreign_currency_value,
        },
      ]
    : [];
}
export function grantWarnings(row: GrantRow): RowWarning[] {
  return row.agreement_value === null
    ? [
        {
          dataset: "grants",
          reference: row.ref_number,
          reason: "missing agreement_value recorded as not stated (null), never as zero",
        },
      ]
    : [];
}

export function groupContracts(
  rows: Iterable<MatchedRow<ContractRow>>,
  options: GroupOptions,
): GroupResult {
  const result = emptyGroupResult();
  const groups = new Map<string, MatchedRow<ContractRow>[]>();
  for (const entry of rows) {
    const row = entry.row;
    result.warnings.push(...contractWarnings(row));
    if (entry.match.status !== "confirmed" || !entry.match.orgId) continue;
    const department = row.owner_org || row.buyer_name;
    if (!contractBody(options, row)) {
      countUnmapped(result, department);
      continue;
    }
    add(
      groups,
      row.procurement_id
        ? groupKey(department, row.procurement_id)
        : groupKey(department, "row-v1", rowFingerprint(row)),
      entry,
    );
  }
  for (const [key, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    entries.sort(
      (a, b) =>
        a.row.reporting_period.localeCompare(b.row.reporting_period) ||
        (a.row.contract_date ?? "").localeCompare(b.row.contract_date ?? "") ||
        compare(a.row.reference_number, b.row.reference_number) ||
        compare(rowFingerprint(a.row), rowFingerprint(b.row)),
    );
    const first = entries[0]!;
    const row = first.row;
    if (!consistentRecipient(entries, result, "contracts", row.reference_number)) continue;
    if (!uniqueRows(entries, result, "contracts", row.reference_number)) continue;
    result.warnings.push(
      ...auditContractChain(entries.map((e) => e.row)).map((issue) => ({
        dataset: "contracts" as const,
        reference: row.reference_number,
        reason: `group ${issue.code} at row ${issue.row}: ${issue.reason}`,
      })),
    );
    result.identities.push({
      id: id("agr_tbs_c_", key),
      legacyIds: [
        ...new Set(
          entries.map((e) =>
            id(
              "agr_tbs_c_",
              groupKey(
                e.row.owner_org || e.row.buyer_name,
                e.row.procurement_id || e.row.reference_number,
              ),
            ),
          ),
        ),
      ].sort(compare),
      rowIds: entries.map((e) => `contracts:${rowFingerprint(e.row)}`),
      key,
      reason: row.procurement_id
        ? "same department-scoped procurement identifier"
        : "no procurement identifier: separate source row; batch reference is not an agreement",
    });
    const title =
      entries.map((e) => e.row.description_en || e.row.comments_en).find(Boolean) || "Contract";
    result.agreements.push(
      Agreement.parse({
        ...common(
          options,
          entries.map((e) => evidence(options.sourceId, rowLocator("contracts", e.row))),
        ),
        id: id("agr_tbs_c_", key),
        family: "procurement",
        type: entries.some((e) => e.row.instrument_type === "SOSA")
          ? "standing_offer"
          : "contract_award",
        title: title.slice(0, 200),
        externalIds: [
          ...(row.procurement_id
            ? [{ system: "tbs-contracts:procurement_id", value: row.procurement_id }]
            : []),
          ...entries.map((e) => ({
            system: "tbs-contracts:reference_number",
            value: e.row.reference_number,
          })),
        ],
        parties: [
          {
            orgId: contractBody(options, row)!,
            role: "buyer",
            evidenceStrength: "party_of_record",
            reportedName: row.owner_org_title || row.buyer_name,
          },
          {
            orgId: first.match.orgId!,
            role: "prime",
            evidenceStrength: "party_of_record",
            reportedName: row.vendor_name,
          },
        ],
        disclosureRows: entries.map(({ row: r }) => ({
          reportingPeriod: r.reporting_period,
          instrument: r.instrument_type === "A" ? "amendment" : "original",
          originalValue: r.original_value ?? r.contract_value ?? null,
          amendmentValue: r.instrument_type === "A" ? r.amendment_value : null,
          totalValue: r.contract_value ?? null,
          endOnAsStated: r.delivery_date,
        })),
        repayability: null,
        announcedOn: null,
        startOn:
          entries
            .map((e) => e.row.contract_period_start)
            .filter((date): date is string => date !== null)
            .sort(compare)[0] ?? null,
      }),
    );
  }
  return result;
}

export function groupGrants(
  rows: Iterable<MatchedRow<GrantRow>>,
  options: GroupOptions,
): GroupResult {
  const result = emptyGroupResult();
  const groups = new Map<string, MatchedRow<GrantRow>[]>();
  for (const entry of rows) {
    const row = entry.row;
    result.foreignCurrencyRows.push(...grantForeignCurrency(row));
    result.warnings.push(...grantWarnings(row));
    if (entry.match.status !== "confirmed" || !entry.match.orgId) continue;
    if (row.agreement_type !== "G" && row.agreement_type !== "C" && row.agreement_type !== "O")
      throw new Error(`Unsupported agreement_type: ${row.agreement_type}`);
    if (!body(options, row.owner_org)) {
      countUnmapped(result, row.owner_org);
      continue;
    }
    add(
      groups,
      row.ref_number
        ? groupKey(row.owner_org, row.ref_number)
        : groupKey(row.owner_org, "row-v1", rowFingerprint(row)),
      entry,
    );
  }
  for (const [key, allEntries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    // "O" (other transfer payment) rows are not grants or contributions. They are kept only as earlier
    // history of an agreement that a later row re-types as G or C (ISED SIF projects do this); any other
    // O row is skipped.
    const typed = allEntries.filter((e) => e.row.agreement_type !== "O");
    if (typed.length === 0) {
      result.skippedOtherGrants += allEntries.length;
      continue;
    }
    const firstTyped = Math.min(...typed.map((e) => e.row.amendment_number));
    const typedNumbers = new Set(typed.map((e) => e.row.amendment_number));
    const earlierOther = allEntries.filter(
      (e) =>
        e.row.agreement_type === "O" &&
        e.row.amendment_number < firstTyped &&
        !typedNumbers.has(e.row.amendment_number),
    );
    result.skippedOtherGrants += allEntries.length - typed.length - earlierOther.length;
    const entries = [...earlierOther, ...typed];
    entries.sort(
      (a, b) =>
        a.row.amendment_number - b.row.amendment_number ||
        compare(a.row.amendment_date ?? "", b.row.amendment_date ?? "") ||
        compare(rowFingerprint(a.row), rowFingerprint(b.row)),
    );
    const first = entries[0]!;
    const row = first.row;
    const typeRow = entries.find((e) => e.row.agreement_type !== "O")!.row;
    if (!consistentRecipient(entries, result, "grants", row.ref_number)) continue;
    if (!uniqueRows(entries, result, "grants", row.ref_number)) continue;
    if (new Set(entries.map((e) => e.row.agreement_number).filter(Boolean)).size > 1) {
      result.warnings.push({
        dataset: "grants",
        reference: row.ref_number,
        reason: "group has conflicting agreement numbers under one reference; no proposal emitted",
      });
      continue;
    }
    if (new Set(typed.map((e) => e.row.agreement_type)).size > 1) {
      result.warnings.push({
        dataset: "grants",
        reference: row.ref_number,
        reason: "group changes agreement_type; no proposal emitted",
      });
      continue;
    }
    const original = entries.find((e) => e.row.amendment_number === 0)?.row;
    result.warnings.push(
      ...auditGrantChain(entries.map((e) => e.row)).map((issue) => ({
        dataset: "grants" as const,
        reference: row.ref_number,
        reason: `group ${issue.code} at row ${issue.row}: ${issue.reason}`,
      })),
    );
    result.identities.push({
      id: id("agr_tbs_g_", key),
      legacyIds: [id("agr_tbs_g_", groupKey(row.owner_org, row.ref_number))],
      rowIds: entries.map((e) => `grants:${rowFingerprint(e.row)}`),
      key,
      reason: row.ref_number
        ? "same department-scoped grant reference; duplicate agreement numbers require separate reconciliation"
        : "missing grant reference: separate source row",
    });
    result.agreements.push(
      Agreement.parse({
        ...common(
          options,
          entries.map((e) => evidence(options.sourceId, rowLocator("grants", e.row))),
        ),
        id: id("agr_tbs_g_", key),
        family: "grant_contribution",
        type: typeRow.agreement_type === "G" ? "grant" : "contribution",
        // Some amendment rows carry only the agreement number as the title; prefer a real title.
        title:
          entries
            .map((e) => e.row.agreement_title_en)
            .find((t) => t && t !== row.agreement_number) ||
          row.agreement_title_en ||
          row.prog_name_en,
        externalIds: [
          { system: "tbs-grants:ref_number", value: row.ref_number },
          ...[...new Set(entries.map((e) => e.row.agreement_number).filter(Boolean))].map(
            (value) => ({ system: "tbs-grants:agreement_number", value }),
          ),
          ...[...new Set(entries.map((e) => e.row.prog_name_en).filter(Boolean))].map((value) => ({
            system: "tbs-grants:program",
            value,
          })),
        ],
        parties: [
          {
            orgId: body(options, row.owner_org)!,
            role: "funder",
            evidenceStrength: "party_of_record",
            reportedName: row.owner_org_title || row.owner_org,
          },
          {
            orgId: first.match.orgId!,
            role: "recipient",
            evidenceStrength: "party_of_record",
            reportedName: row.recipient_legal_name,
          },
        ],
        disclosureRows: entries.map(({ row: r }) => ({
          reportingPeriod: `amendment ${r.amendment_number} (${r.amendment_date || r.agreement_start_date || ""})`,
          instrument: r.amendment_number === 0 ? "original" : "amendment",
          originalValue: original?.agreement_value ?? null,
          amendmentValue: null,
          totalValue: r.agreement_value ?? null,
          endOnAsStated: r.agreement_end_date,
        })),
        repayability: "unknown",
        announcedOn: null,
        startOn:
          original?.agreement_start_date ??
          entries
            .map((e) => e.row.agreement_start_date)
            .filter((d): d is string => d !== null)
            .sort(compare)[0] ??
          null,
      }),
    );
  }
  return result;
}

export interface CanadaBuysGroupResult extends GroupResult {
  skippedCancelledGroups: number;
}
export function groupCanadaBuys(
  rows: Iterable<MatchedRow<CanadaBuysRow>>,
  options: GroupOptions,
): CanadaBuysGroupResult {
  const result: CanadaBuysGroupResult = { ...emptyGroupResult(), skippedCancelledGroups: 0 };
  const groups = new Map<string, MatchedRow<CanadaBuysRow>[]>();
  for (const entry of rows) {
    if (entry.match.status !== "confirmed" || !entry.match.orgId) continue;
    const row = entry.row;
    if (!row.contractNumber && !row.referenceNumber) {
      result.warnings.push({
        dataset: "canadabuys",
        reference: "",
        reason: "group has no contract or reference number; no proposal emitted",
      });
      continue;
    }
    add(
      groups,
      groupKey(row.contractingEntityName, row.contractNumber || row.referenceNumber),
      entry,
    );
  }
  for (const [key, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    entries.sort(
      (a, b) =>
        a.row.amendmentNumber - b.row.amendmentNumber ||
        (a.row.amendmentDate ?? "").localeCompare(b.row.amendmentDate ?? "") ||
        a.row.referenceNumber.localeCompare(b.row.referenceNumber),
    );
    const latest = entries[entries.length - 1]!;
    const row = latest.row;
    if (row.status.toLowerCase() === "cancelled") {
      result.skippedCancelledGroups++;
      continue;
    }
    if (
      !consistentRecipient(entries, result, "canadabuys", row.contractNumber || row.referenceNumber)
    )
      continue;
    const buyer = body(options, row.contractingEntityName);
    if (!buyer) {
      for (const entry of entries) countUnmapped(result, entry.row.contractingEntityName);
      continue;
    }
    const originalValue =
      entries.find((entry) => entry.row.amendmentNumber === 0)?.row.contractAmount ?? null;
    const instrument = row.instrumentType.toLowerCase();
    result.agreements.push(
      Agreement.parse({
        ...common(
          options,
          entries.map(({ row: r }) =>
            evidence(
              options.sourceId,
              `contractNumber=${r.contractNumber};amendmentNumber=${r.amendmentNumber}`,
            ),
          ),
        ),
        createdBy: "pipeline:canadabuys-import",
        id: id("agr_cb_", key),
        family: "procurement",
        type:
          instrument.includes("standing offer") || instrument.includes("supply arrangement")
            ? "standing_offer"
            : instrument.includes("task authorization")
              ? "call_up"
              : "contract_award",
        title: (row.title || "Contract").slice(0, 200),
        externalIds: [
          ...(row.contractNumber
            ? [{ system: "canadabuys:contractNumber", value: row.contractNumber }]
            : []),
          ...[...new Set(entries.map((entry) => entry.row.solicitationNumber).filter(Boolean))].map(
            (value) => ({ system: "canadabuys:solicitationNumber", value }),
          ),
          ...[...new Set(entries.map((entry) => entry.row.referenceNumber).filter(Boolean))].map(
            (value) => ({ system: "canadabuys:referenceNumber", value }),
          ),
        ],
        parties: [
          {
            orgId: buyer,
            role: "buyer",
            evidenceStrength: "party_of_record",
            reportedName: row.contractingEntityName,
          },
          {
            orgId: latest.match.orgId!,
            role: "prime",
            evidenceStrength: "party_of_record",
            reportedName: row.supplierLegalName,
          },
        ],
        disclosureRows: entries.map(({ row: r }) => ({
          reportingPeriod: `amendment ${r.amendmentNumber} (${r.amendmentDate || r.contractAwardDate || ""})`,
          instrument: r.amendmentNumber === 0 ? "original" : "amendment",
          originalValue,
          amendmentValue: null,
          totalValue: r.totalContractValue,
          endOnAsStated: r.contractEndDate,
        })),
        currency: row.currency,
        announcedOn: null,
        startOn: row.contractStartDate,
        statusAsOf: {
          state:
            row.status.toLowerCase() === "active"
              ? "stated_active"
              : row.status.toLowerCase() === "expired"
                ? "stated_completed"
                : "unknown",
          asOf: options.date,
        },
        repayability: null,
      }),
    );
  }
  return result;
}
