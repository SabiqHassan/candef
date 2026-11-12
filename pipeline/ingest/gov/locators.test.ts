import { describe, expect, it } from "vitest";
import { groupContracts, groupGrants } from "./group";
import { rowLocator, parseLocator, rowFingerprint } from "./locators";
import { toContractRow, toGrantRow } from "./tbs";
import { verifyAgreement } from "../../research/verifyGovClaims";

const match = {
  status: "confirmed" as const,
  orgId: "org_fictional",
  candidates: ["org_fictional"],
  method: "name+postal",
};
const options = {
  bodies: { fictional: "org_fictional_buyer" },
  sourceId: "src_fictional",
  date: "2026-10-14",
};
const contract = (total: string) =>
  toContractRow({
    reference_number: "fictional;batch=1",
    procurement_id: "fictional-p",
    owner_org: "fictional",
    owner_org_title: "Fictional department",
    vendor_name: "Fictional Orbit; Incorporated",
    contract_value: total,
    instrument_type: "C",
    reporting_period: "2025-2026-Q1",
  });

describe("source-row identity", () => {
  it("does not discard a wrong field in a strict legacy locator", () => {
    const row = contract("100");
    const a = groupContracts([{ row, match }], options).agreements[0]!;
    // Use a simple reference so this exercises legacy field matching, not URL encoding.
    const simple = toContractRow({ ...row.sourceCells, reference_number: "fictional-batch" });
    a.evidence[0]!.locator = "reference_number=fictional-batch;procurement_id=fictional-wrong";
    expect(
      verifyAgreement(
        a,
        { contracts: new Map([[simple.reference_number, [simple]]]), grants: new Map() },
        { strictLocators: true },
      ).some((f) => f.field === "missingLocator"),
    ).toBe(true);
  });
  it("binds citations to the selected dataset source", () => {
    const row = contract("100");
    const a = groupContracts([{ row, match }], options).agreements[0]!;
    const raw = { contracts: new Map([[row.reference_number, [row]]]), grants: new Map() };
    expect(
      verifyAgreement(a, raw, { datasetSources: { contracts: "src_fictional_other" } }).some(
        (f) => f.field === "evidence[0].sourceId",
      ),
    ).toBe(true);
  });
  it("checks claimed parties and identifiers even when the row fingerprint resolves", () => {
    const row = contract("100");
    const a = groupContracts([{ row, match }], options).agreements[0]!;
    a.parties[0]!.reportedName = "Fictional Other Department";
    a.parties[1]!.reportedName = "Fictional Other Vendor";
    a.externalIds[0]!.value = "fictional-wrong";
    const fields = verifyAgreement(a, {
      contracts: new Map([[row.reference_number, [row]]]),
      grants: new Map(),
    }).map((f) => f.field);
    expect(fields).toContain("buyer.reportedName");
    expect(fields).toContain("prime.reportedName");
    expect(fields).toContain("externalIds[0].value");
  });
  it("can resolve blank batch references by fingerprint and rejects uncited extra evidence", () => {
    const row = toContractRow({ ...contract("100").sourceCells, reference_number: "" });
    const a = groupContracts([{ row, match }], options).agreements[0]!;
    const raw = { contracts: new Map([["", [row]]]), grants: new Map() };
    expect(verifyAgreement(a, raw)).toEqual([]);
    a.evidence.push({ ...a.evidence[0]!, locator: "unrecognized" });
    expect(verifyAgreement(a, raw).some((f) => f.field === "invalidLocator")).toBe(true);
  });
  it("uses the earliest stated contract start across periods", () => {
    const rows = [
      toContractRow({ ...contract("100").sourceCells, contract_period_start: "2025-05-01" }),
      toContractRow({
        ...contract("200").sourceCells,
        reporting_period: "2025-2026-Q2",
        contract_period_start: "2025-04-01",
      }),
    ];
    const a = groupContracts(
      rows.map((row) => ({ row, match })),
      options,
    ).agreements[0]!;
    expect(a.startOn).toBe("2025-04-01");
  });
  it("encodes human-checkable fields and hashes original allowed cells", () => {
    const row = contract("100");
    const fields = parseLocator(rowLocator("contracts", row))!;
    expect(fields.get("reference_number")).toBe("fictional;batch=1");
    expect(fields.get("vendor_name")).toBe("Fictional Orbit; Incorporated");
    expect(fields.get("row_sha256")).toBe(rowFingerprint(row));
    expect(parseLocator("reference_number=x;reference_number=y")).toBeNull();
    expect(
      parseLocator(`vendor_name=%xx;locator_version=1;row_sha256=${"a".repeat(64)}`),
    ).toBeNull();
  });
  it("checks each same-period disclosure against its positional citation", () => {
    const rows = [contract("100"), contract("200")];
    const a = groupContracts(
      rows.map((row) => ({ row, match })),
      options,
    ).agreements[0]!;
    const raw = { contracts: new Map([[rows[0]!.reference_number, rows]]), grants: new Map() };
    expect(verifyAgreement(a, raw)).toEqual([]);
    a.disclosureRows.reverse();
    expect(verifyAgreement(a, raw).filter((f) => f.field.endsWith(".totalValue"))).toHaveLength(2);
  });
  it("refuses identical duplicate source rows instead of pretending their locator is unique", () => {
    const row = contract("100");
    expect(
      groupContracts(
        [
          { row, match },
          { row, match },
        ],
        options,
      ).agreements,
    ).toEqual([]);
    const a = groupContracts([{ row, match }], options).agreements[0]!;
    const findings = verifyAgreement(a, {
      contracts: new Map([[row.reference_number, [row, row]]]),
      grants: new Map(),
    });
    expect(findings.some((f) => f.field === "nonUniqueLocator")).toBe(true);
  });
  it("also disambiguates grants repeated under one reference/amendment", () => {
    const row = toGrantRow({
      ref_number: "fictional-g",
      amendment_number: "0",
      recipient_legal_name: "Fictional Orbit",
      agreement_type: "C",
      owner_org: "fictional",
      agreement_value: "100",
    });
    const a = groupGrants([{ row, match }], options).agreements[0]!;
    expect(a.evidence[0]!.locator).toContain("row_sha256=");
  });
});
