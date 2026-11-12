import { createReadStream } from "node:fs";
import { readCsv } from "./csv";
import { contractLink, grantLink, linkRows } from "./linkage";
import type { LinkInput, LinkDecision } from "./linkage";
import { matchRecipient, countMagnitude } from "./match";
import type { Recipient, RecipientIndex } from "./match";
import { contractWarnings, grantWarnings, grantForeignCurrency } from "./group";
import type { MatchedRow } from "./group";
import { recordMatch } from "./report";
import type { MatchReport } from "./report";
import { toContractRow, toGrantRow, validateHeader } from "./tbs";
import type { ContractRow, GrantRow } from "./tbs";

export interface TbsFile {
  kind: "contracts" | "grants";
  path: string;
}
type Retained =
  | { kind: "contracts"; row: ContractRow; input: LinkInput; counted: boolean }
  | { kind: "grants"; row: GrantRow; input: LinkInput; counted: boolean };
async function* records(file: TbsFile) {
  let headerSeen = false;
  for await (const record of readCsv(createReadStream(file.path), (h) => {
    validateHeader(file.kind, h);
    headerSeen = true;
  }))
    yield record;
  if (!headerSeen) validateHeader(file.kind, []);
}
function recipient(kind: TbsFile["kind"], r: Record<string, string>): Recipient {
  return kind === "contracts"
    ? { names: [r.vendor_name ?? ""], postal: r.vendor_postal_code ?? null, businessNumber: null }
    : {
        names: [r.recipient_legal_name ?? "", r.recipient_operating_name ?? ""].filter(Boolean),
        postal: r.recipient_postal_code ?? null,
        businessNumber: r.recipient_business_number ?? null,
      };
}
function retain(kind: TbsFile["kind"], raw: Record<string, string>, counted: boolean): Retained {
  if (kind === "contracts") {
    const row = toContractRow(raw);
    return { kind, row, input: contractLink(row), counted };
  }
  const row = toGrantRow(raw);
  return { kind, row, input: grantLink(row), counted };
}
function rawKeys(kind: TbsFile["kind"], r: Record<string, string>): string[] {
  const department =
    (r.owner_org ?? "").trim() || (kind === "contracts" ? (r.buyer_name ?? "").trim() : "");
  if (!department) return [];
  return kind === "contracts"
    ? r.procurement_id?.trim()
      ? [JSON.stringify(["contracts", department, r.procurement_id.trim()])]
      : []
    : [
        ["grants-ref", r.ref_number],
        ["grants-number", r.agreement_number],
      ].flatMap(([type, id]) =>
        id?.trim() ? [JSON.stringify([type, department, id.trim()])] : [],
      );
}

/** Two streaming passes, retaining only name candidates and collisions on their agreement keys. */
export async function scanTbs(
  files: TbsFile[],
  index: RecipientIndex,
  report: MatchReport,
  magnitude: Map<string, number>,
): Promise<{
  contracts: MatchedRow<ContractRow>[];
  grants: MatchedRow<GrantRow>[];
  decisions: LinkDecision[];
  sourceRows: { rowId: string; cells: Record<string, string> }[];
}> {
  const retained: Retained[] = [];
  const keys = new Set<string>();
  for (const file of files)
    for await (const raw of records(file)) {
      if (file.kind === "grants" && raw.recipient_type?.trim() === "P") {
        report.rowsRead++;
        report.rowsByDataset.grants++;
        report.skippedIndividualGrants++;
        continue;
      }
      const rec = recipient(file.kind, raw),
        match = matchRecipient(rec, index);
      if (match.candidates.length) {
        const entry = retain(file.kind, raw, false);
        retained.push(entry);
        entry.input.keys.forEach((k) => keys.add(k));
      } else
        recordMatch(
          report,
          file.kind,
          (raw[file.kind === "contracts" ? "reference_number" : "ref_number"] ?? "").trim(),
          rec,
          match,
        );
      if (file.kind === "contracts") report.warnings.push(...contractWarnings(toContractRow(raw)));
      else {
        const row = toGrantRow(raw);
        report.warnings.push(...grantWarnings(row));
        report.foreignCurrencyRows.push(...grantForeignCurrency(row));
        if (row.agreement_type === "O") report.skippedOtherGrants++;
      }
    }
  // Inspect unknown names sharing selected keys, including earlier rows. They can veto but never acquire a company.
  if (keys.size)
    for (const file of files)
      for await (const raw of records(file)) {
        if (file.kind === "grants" && raw.recipient_type?.trim() === "P") continue;
        if (!rawKeys(file.kind, raw).some((k) => keys.has(k))) continue;
        if (matchRecipient(recipient(file.kind, raw), index).candidates.length) continue;
        retained.push(retain(file.kind, raw, true));
      }
  const decisions = linkRows(
    retained.map((r) => r.input),
    index,
  );
  const byRow = new Map(decisions.map((d) => [d.rowId, d]));
  const contracts: MatchedRow<ContractRow>[] = [],
    grants: MatchedRow<GrantRow>[] = [];
  for (const entry of retained) {
    const match = byRow.get(entry.input.rowId)!;
    if (!entry.counted) {
      recordMatch(report, entry.kind, entry.input.reference, entry.input.recipient, match);
      countMagnitude(match, magnitude);
    }
    if (match.status !== "confirmed") continue;
    if (entry.kind === "contracts") contracts.push({ row: entry.row, match });
    else grants.push({ row: entry.row, match });
  }
  return {
    contracts,
    grants,
    decisions,
    sourceRows: retained
      .map((e) => ({ rowId: e.input.rowId, cells: e.row.sourceCells! }))
      .sort((a, b) => (a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0)),
  };
}
