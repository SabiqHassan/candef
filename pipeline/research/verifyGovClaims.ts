import { createReadStream } from "node:fs";
import type { Agreement } from "../../src/domain/schema/corpus";
import { readCsv } from "../ingest/gov/csv";
import { toContractRow, toGrantRow, validateHeader } from "../ingest/gov/tbs";
import type { ContractRow, GrantRow } from "../ingest/gov/tbs";
import { nameKey } from "./names";
import { locatorMatches, parseLocator } from "../ingest/gov/locators";

/** Only claim-bearing fields are needed; verification never changes research records. */
export type GovAgreement = Pick<
  Agreement,
  "id" | "evidence" | "externalIds" | "parties" | "disclosureRows" | "startOn"
>;
export interface CitedRefs {
  contracts: Set<string>;
  grants: Set<string>;
}
export interface RawRows {
  contracts: Map<string, ContractRow[]>;
  grants: Map<string, GrantRow[]>;
}
export interface Finding {
  agreementId: string;
  /** Empty for agreement-wide checks without a usable citation. */
  locator: string;
  /** Indexed claim path, or missingLocator / missingAgreementRows. */
  field: string;
  recorded: unknown;
  source: unknown;
}
export interface VerifyOptions {
  strictLocators?: boolean;
  /** IDs registered for the exact local CSV captures selected by the operator. */
  datasetSources?: Partial<Record<"contracts" | "grants", string>>;
}
interface Citation {
  locator: string;
  reference: string;
  amendment: number | null;
  valid: boolean;
  fields: Map<string, string> | null;
}

function kindOf(agreement: GovAgreement): "contracts" | "grants" | null {
  if (agreement.id.startsWith("agr_tbs_c_")) return "contracts";
  if (agreement.id.startsWith("agr_tbs_g_")) return "grants";
  return null;
}

function citations(agreement: GovAgreement): Citation[] {
  const kind = kindOf(agreement);
  const key = kind === "contracts" ? "reference_number" : "ref_number";
  return agreement.evidence
    .map((e) => e.locator)
    .flatMap((locator) => {
      const parts = parseLocator(locator);
      const reference = parts?.get(key);
      if (!kind || reference === undefined) return [];
      const amendment = parts?.get("amendment_number");
      const valid =
        amendment === undefined ||
        (/^\d+$/.test(amendment) && Number.isSafeInteger(Number(amendment)));
      return [
        {
          locator,
          reference,
          valid,
          fields: parts,
          amendment: amendment !== undefined && valid ? Number(amendment) : null,
        },
      ];
    });
}

/** Reference sets are dataset-specific; department/name checks happen during verification. */
export function collectCitedRefs(agreements: readonly GovAgreement[]): CitedRefs {
  const refs: CitedRefs = { contracts: new Set(), grants: new Set() };
  for (const agreement of agreements) {
    const kind = kindOf(agreement);
    if (kind) for (const citation of citations(agreement)) refs[kind].add(citation.reference);
  }
  return refs;
}

/** Each file is scanned once. Uncited rows are discarded before parsing or retention. */
export async function loadRawRows(
  contractsCsv: string,
  grantsCsv: string,
  refs: CitedRefs,
): Promise<RawRows> {
  const result: RawRows = { contracts: new Map(), grants: new Map() };
  async function scan<T>(
    path: string,
    kind: "contracts" | "grants",
    referenceColumn: string,
    parse: (row: Record<string, string>) => T,
    target: Map<string, T[]>,
  ) {
    const stream = createReadStream(path);
    try {
      for await (const row of readCsv(stream, (headers) => validateHeader(kind, headers))) {
        const reference = (row[referenceColumn] ?? "").trim();
        if (!refs[kind].has(reference)) continue;
        const entries = target.get(reference) ?? [];
        entries.push(parse(row));
        target.set(reference, entries);
      }
    } finally {
      stream.destroy();
    }
  }
  await scan(contractsCsv, "contracts", "reference_number", toContractRow, result.contracts);
  await scan(grantsCsv, "grants", "ref_number", toGrantRow, result.grants);
  return result;
}

// Exact decimal equality avoids both formatting mismatches and floating-point rounding.
function decimal(value: string | null): string | null {
  if (value === null) return null;
  const [integer = "", fraction = ""] = value.replace(/^[+]/, "").split(".");
  const negative = integer.startsWith("-");
  const whole = integer.replace(/^-/, "").replace(/^0+(?=\d)/, "");
  const tail = fraction.replace(/0+$/, "");
  return `${negative && (whole !== "0" || tail) ? "-" : ""}${whole}${tail ? `.${tail}` : ""}`;
}
function earliest(dates: (string | null)[]): string | null {
  return dates.filter((date): date is string => date !== null).sort()[0] ?? null;
}

/** Pure comparison of one imported TBS agreement against its cited, identity-matched rows.
 * No G/C type filter: O rows can be legitimate earlier history of a retyped grant.
 * Conflicting duplicate rows are reported as ambiguous rather than chosen by file order.
 */
export function verifyAgreement(
  agreement: GovAgreement,
  rawRows: RawRows,
  options: VerifyOptions = {},
): Finding[] {
  const kind = kindOf(agreement);
  if (!kind) return [];
  const findings: Finding[] = [];
  const cited = citations(agreement);
  if (cited.length !== agreement.evidence.length)
    findings.push({
      agreementId: agreement.id,
      locator: "",
      field: "invalidLocator",
      recorded: agreement.evidence.length,
      source: cited.length,
    });
  const locator = cited.map((c) => c.locator).join("; ");
  const add = (field: string, recorded: unknown, source: unknown, at = locator) => {
    findings.push({ agreementId: agreement.id, locator: at, field, recorded, source });
  };
  if (options.datasetSources?.[kind])
    agreement.evidence.forEach((e, i) => {
      if (e.sourceId !== options.datasetSources![kind])
        add(`evidence[${i}].sourceId`, e.sourceId, options.datasetSources![kind], e.locator);
    });
  const compare = (
    field: string,
    recorded: string | null,
    source: string | null,
    at = locator,
    money = false,
  ) => {
    if (money ? decimal(recorded) !== decimal(source) : recorded !== source)
      add(field, recorded, source, at);
  };
  const departments = agreement.parties
    .filter((p) => p.role === (kind === "contracts" ? "buyer" : "funder"))
    .map((p) => p.reportedName);
  const names = agreement.parties
    .filter((p) => p.role === (kind === "contracts" ? "prime" : "recipient"))
    .map((p) => nameKey(p.reportedName))
    .filter(Boolean);
  const procurementIds = agreement.externalIds
    .filter((e) => e.system === "tbs-contracts:procurement_id")
    .map((e) => e.value);
  const matches = cited.map((citation) => {
    const versioned = citation.fields?.has("locator_version");
    const referenced =
      kind === "contracts"
        ? (rawRows.contracts.get(citation.reference) ?? [])
        : (rawRows.grants.get(citation.reference) ?? []);
    const exact = referenced.filter((r) => citation.fields && locatorMatches(citation.fields, r));
    if ((versioned || options.strictLocators) && exact.length > 1)
      add("nonUniqueLocator", citation.locator, exact.length, citation.locator);
    const rows: (ContractRow | GrantRow)[] = !citation.valid
      ? []
      : versioned || options.strictLocators
        ? exact
        : kind === "contracts"
          ? (rawRows.contracts.get(citation.reference) ?? []).filter(
              (r) =>
                departments.includes(r.owner_org_title) &&
                (procurementIds.length
                  ? procurementIds.includes(r.procurement_id)
                  : names.includes(nameKey(r.vendor_name))),
            )
          : (rawRows.grants.get(citation.reference) ?? []).filter(
              (r) =>
                departments.includes(r.owner_org_title) &&
                names.includes(nameKey(r.recipient_legal_name)) &&
                (citation.amendment === null || citation.amendment === r.amendment_number),
            );
    if (!rows.length) add("missingLocator", citation.locator, null, citation.locator);
    return { citation, rows };
  });
  const allRows = [...new Set(matches.flatMap((m) => m.rows))];
  if (!allRows.length) add("missingAgreementRows", agreement.id, null);

  agreement.disclosureRows.forEach((disclosure, i) => {
    const amendment = /^amendment (\d+) \(.*\)$/.exec(disclosure.reportingPeriod);
    const versioned = matches.some((m) => m.citation.fields?.has("locator_version"));
    const positional = versioned ? matches.slice(i, i + 1) : matches;
    const candidates = positional.flatMap(({ citation, rows }) =>
      rows
        .filter((row) =>
          "reference_number" in row
            ? row.reporting_period === disclosure.reportingPeriod
            : amendment !== null && row.amendment_number === Number(amendment[1]),
        )
        .map((row) => ({ row, locator: citation.locator })),
    );
    const unique = versioned
      ? candidates
      : [...new Map(candidates.map((c) => [JSON.stringify(c.row), c])).values()];
    const field = `disclosureRows[${i}]`;
    if (!unique.length) {
      add(`${field}.missingRow`, disclosure.reportingPeriod, null);
      return;
    }
    if (unique.length > 1) {
      // Include only claim fields, never whole raw rows or source descriptions.
      add(`${field}.ambiguousRow`, disclosure.reportingPeriod, unique.length);
      return;
    }
    const { row, locator: at } = unique[0]!;
    const contract = "reference_number" in row;
    compare(
      `${field}.totalValue`,
      disclosure.totalValue,
      contract ? row.contract_value : row.agreement_value,
      at,
      true,
    );
    compare(
      `${field}.endOnAsStated`,
      disclosure.endOnAsStated,
      contract ? row.delivery_date : row.agreement_end_date,
      at,
    );
    if (contract) {
      if (versioned)
        compare(
          `${field}.originalValue`,
          disclosure.originalValue,
          row.original_value ?? row.contract_value,
          at,
          true,
        );
      compare(
        `${field}.instrument`,
        disclosure.instrument,
        row.instrument_type === "A" ? "amendment" : "original",
        at,
      );
      if (row.instrument_type === "A")
        compare(
          `${field}.amendmentValue`,
          disclosure.amendmentValue,
          row.amendment_value,
          at,
          true,
        );
    }
  });
  if (
    cited.some((c) => c.fields?.has("locator_version")) &&
    cited.length !== agreement.disclosureRows.length
  )
    add("citationRowCount", agreement.disclosureRows.length, cited.length);

  if (allRows.length) {
    for (const party of agreement.parties.filter((p) =>
      ["buyer", "funder", "prime", "recipient"].includes(p.role),
    )) {
      const reported = allRows.map((r) =>
        "reference_number" in r
          ? party.role === "buyer"
            ? r.owner_org_title || r.buyer_name
            : r.vendor_name
          : party.role === "funder"
            ? r.owner_org_title || r.owner_org
            : r.recipient_legal_name,
      );
      const supported =
        kind === "contracts" &&
        !cited.some((c) => c.fields?.has("locator_version")) &&
        party.role === "prime"
          ? reported.some((name) => nameKey(name) === nameKey(party.reportedName))
          : reported.includes(party.reportedName);
      if (!supported) add(`${party.role}.reportedName`, party.reportedName, [...new Set(reported)]);
    }
    if (kind === "contracts") {
      agreement.externalIds.forEach((external, i) => {
        if (
          external.system === "tbs-contracts:procurement_id" &&
          !(allRows as ContractRow[]).some((r) => r.procurement_id === external.value)
        )
          add(`externalIds[${i}].value`, external.value, [
            ...new Set((allRows as ContractRow[]).map((r) => r.procurement_id)),
          ]);
      });
      compare(
        "startOn",
        agreement.startOn,
        earliest((allRows as ContractRow[]).map((r) => r.contract_period_start)),
      );
    } else {
      const rows = allRows as GrantRow[];
      const originals = rows.filter((r) => r.amendment_number === 0);
      compare(
        "startOn",
        agreement.startOn,
        earliest((originals.length ? originals : rows).map((r) => r.agreement_start_date)),
      );
      agreement.externalIds.forEach((external, i) => {
        if (
          external.system === "tbs-grants:agreement_number" &&
          !rows.some((r) => r.agreement_number === external.value)
        )
          add(`externalIds[${i}].value`, external.value, [
            ...new Set(rows.map((r) => r.agreement_number)),
          ]);
      });
    }
  }
  return findings;
}

/** Pure corpus-level verification; use collectCitedRefs + loadRawRows for file IO. */
export function verifyCorpus(
  agreements: readonly GovAgreement[],
  rawRows: RawRows,
  options: VerifyOptions = {},
): {
  agreementsChecked: number;
  findings: Finding[];
} {
  const government = agreements.filter((agreement) => kindOf(agreement) !== null);
  return {
    agreementsChecked: government.length,
    findings: government.flatMap((a) => verifyAgreement(a, rawRows, options)),
  };
}
