import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toContractRow, toGrantRow } from "../ingest/gov/tbs";
import {
  collectCitedRefs,
  loadRawRows,
  verifyAgreement,
  verifyCorpus,
  type GovAgreement,
  type RawRows,
} from "./verifyGovClaims";

// All names, identifiers and amounts here are synthetic; no disclosure data is needed.
const contract = (overrides: Record<string, string> = {}) =>
  toContractRow({
    reference_number: "SYN-C1",
    procurement_id: "SYN-P1",
    owner_org_title: "Fictional Department A",
    vendor_name: "Fictional Alpha Inc.",
    reporting_period: "2025-2026-Q1",
    contract_value: "250000.0",
    instrument_type: "A",
    amendment_value: "50000",
    contract_period_start: "2025-01-01",
    delivery_date: "2026-01-01",
    ...overrides,
  });
const grant = (overrides: Record<string, string> = {}) =>
  toGrantRow({
    ref_number: "SYN-G1",
    owner_org_title: "Fictional Department A",
    recipient_legal_name: "Fictional Alpha Inc.",
    agreement_number: "SYN-AGR1",
    amendment_number: "0",
    agreement_type: "C",
    agreement_value: "250000.0",
    agreement_start_date: "2025-01-01",
    agreement_end_date: "2026-01-01",
    ...overrides,
  });
function agreement(kind: "c" | "g" = "c"): GovAgreement {
  return {
    id: `agr_tbs_${kind}_synthetic`,
    evidence: [
      {
        sourceId: "src_synthetic",
        locatorQuality: "metadata",
        locator: kind === "c" ? "reference_number=SYN-C1" : "ref_number=SYN-G1;amendment_number=0",
      },
    ],
    externalIds: [
      kind === "c"
        ? { system: "tbs-contracts:procurement_id", value: "SYN-P1" }
        : { system: "tbs-grants:agreement_number", value: "SYN-AGR1" },
    ],
    parties: [
      {
        orgId: "org_synthetic_department",
        role: kind === "c" ? "buyer" : "funder",
        evidenceStrength: "party_of_record",
        reportedName: "Fictional Department A",
      },
      {
        orgId: "org_synthetic_company",
        role: kind === "c" ? "prime" : "recipient",
        evidenceStrength: "party_of_record",
        reportedName: "Fictional Alpha Inc.",
      },
    ],
    disclosureRows: [
      {
        reportingPeriod: kind === "c" ? "2025-2026-Q1" : "amendment 0 (2025-01-01)",
        instrument: kind === "c" ? "amendment" : "original",
        originalValue: "200000",
        amendmentValue: kind === "c" ? "50000.0" : null,
        totalValue: "250000",
        endOnAsStated: "2026-01-01",
      },
    ],
    startOn: "2025-01-01",
  };
}
function raw(contracts = [contract()], grants = [grant()]): RawRows {
  return {
    contracts: new Map([["SYN-C1", contracts]]),
    grants: new Map([["SYN-G1", grants]]),
  };
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("government claim verification", () => {
  it.each(["c", "g"] as const)("passes clean %s claims despite numeric formatting", (kind) => {
    expect(verifyAgreement(agreement(kind), raw())).toEqual([]);
  });

  it.each(["c", "g"] as const)("reports the exact wrong %s total and end date", (kind) => {
    const a = agreement(kind);
    a.disclosureRows[0]!.totalValue = "1";
    a.disclosureRows[0]!.endOnAsStated = "2027-01-01";
    expect(verifyAgreement(a, raw())).toEqual([
      {
        agreementId: a.id,
        locator: a.evidence[0]!.locator,
        field: "disclosureRows[0].totalValue",
        recorded: "1",
        source: "250000.0",
      },
      {
        agreementId: a.id,
        locator: a.evidence[0]!.locator,
        field: "disclosureRows[0].endOnAsStated",
        recorded: "2027-01-01",
        source: "2026-01-01",
      },
    ]);
  });

  it("checks raw instrument and amendment value even when the recorded instrument is wrong", () => {
    const a = agreement();
    a.disclosureRows[0]!.instrument = "original";
    a.disclosureRows[0]!.amendmentValue = "7";
    expect(verifyAgreement(a, raw()).map((f) => f.field)).toEqual([
      "disclosureRows[0].instrument",
      "disclosureRows[0].amendmentValue",
    ]);
  });

  it.each(["c", "g"] as const)(
    "separately reports missing %s locator, disclosure and agreement rows",
    (kind) => {
      expect(verifyAgreement(agreement(kind), raw([], [])).map((f) => f.field)).toEqual([
        "missingLocator",
        "missingAgreementRows",
        "disclosureRows[0].missingRow",
      ]);
    },
  );

  it.each(["c", "g"] as const)(
    "does not cross-match %s reference collisions between departments",
    (kind) => {
      const rows = raw(
        [contract({ owner_org_title: "Fictional Department B" })],
        [grant({ owner_org_title: "Fictional Department B" })],
      );
      expect(
        verifyAgreement(agreement(kind), rows).some((f) => f.field === "missingAgreementRows"),
      ).toBe(true);
      rows.contracts.get("SYN-C1")!.push(contract());
      rows.grants.get("SYN-G1")!.push(grant());
      expect(verifyAgreement(agreement(kind), rows)).toEqual([]);
    },
  );

  it("requires procurement id when supplied, otherwise uses normalized vendor name", () => {
    const a = agreement();
    const rows = raw([
      contract({ procurement_id: "OTHER", vendor_name: "fictional alpha incorporated" }),
    ]);
    expect(verifyAgreement(a, rows).some((f) => f.field === "missingAgreementRows")).toBe(true);
    a.externalIds = [];
    expect(verifyAgreement(a, rows)).toEqual([]);
    rows.contracts.get("SYN-C1")![0]!.vendor_name = "Fictional Unrelated Inc.";
    expect(verifyAgreement(a, rows).some((f) => f.field === "missingAgreementRows")).toBe(true);
  });

  it("requires normalized grant recipient identity and separately checks the exact reported name", () => {
    const rows = raw([], [grant({ recipient_legal_name: "fictional alpha incorporated" })]);
    expect(verifyAgreement(agreement("g"), rows).map((f) => f.field)).toEqual([
      "recipient.reportedName",
    ]);
    rows.grants.get("SYN-G1")![0]!.recipient_legal_name = "Fictional Unrelated Inc.";
    expect(
      verifyAgreement(agreement("g"), rows).some((f) => f.field === "missingAgreementRows"),
    ).toBe(true);
  });

  it("accepts O history preceding C and takes the start from amendment zero", () => {
    const a = agreement("g");
    a.evidence.push({
      sourceId: "src_synthetic",
      locatorQuality: "metadata",
      locator: "ref_number=SYN-G1;amendment_number=1",
    });
    a.disclosureRows.push({
      ...a.disclosureRows[0]!,
      reportingPeriod: "amendment 1 (2025-02-01)",
      instrument: "amendment",
    });
    const rows = raw(
      [],
      [
        grant({ agreement_type: "O" }),
        grant({ amendment_number: "1", agreement_start_date: "2024-01-01" }),
      ],
    );
    expect(verifyAgreement(a, rows)).toEqual([]);
    a.startOn = "2024-01-01";
    expect(verifyAgreement(a, rows).map((f) => f.field)).toEqual(["startOn"]);
  });

  it("uses earliest contract start and earliest grant start without amendment zero", () => {
    const c = agreement();
    c.evidence.push({
      sourceId: "src_synthetic",
      locatorQuality: "metadata",
      locator: "reference_number=SYN-C2",
    });
    const rows = raw();
    rows.contracts.set("SYN-C2", [
      contract({
        reference_number: "SYN-C2",
        reporting_period: "2025-2026-Q2",
        contract_period_start: "2024-01-01",
      }),
    ]);
    expect(verifyAgreement(c, rows).find((f) => f.field === "startOn")?.source).toBe("2024-01-01");
    const g = agreement("g");
    g.evidence[0]!.locator = "ref_number=SYN-G1;amendment_number=2";
    g.disclosureRows[0]!.reportingPeriod = "amendment 2 (2025-01-01)";
    expect(verifyAgreement(g, raw([], [grant({ amendment_number: "2" })]))).toEqual([]);
  });

  it("checks every grant agreement number and does not reuse a different amendment", () => {
    const a = agreement("g");
    a.externalIds.push({ system: "tbs-grants:agreement_number", value: "WRONG" });
    a.disclosureRows[0]!.reportingPeriod = "amendment 1 (2025-01-01)";
    expect(verifyAgreement(a, raw()).map((f) => f.field)).toEqual([
      "disclosureRows[0].missingRow",
      "externalIds[1].value",
    ]);
  });

  it("distinguishes unstated money from zero and compares large decimals exactly", () => {
    const a = agreement();
    a.disclosureRows[0]!.totalValue = "0";
    expect(verifyAgreement(a, raw([contract({ contract_value: "" })]))[0]!.source).toBeNull();
    a.disclosureRows[0]!.totalValue = "9007199254740993.00";
    expect(verifyAgreement(a, raw([contract({ contract_value: "9007199254740993" })]))).toEqual([]);
    expect(
      verifyAgreement(a, raw([contract({ contract_value: "9007199254740992" })])),
    ).toHaveLength(1);
  });

  it("reports ambiguous disclosure rows rather than choosing the first", () => {
    expect(
      verifyAgreement(agreement(), raw([contract(), contract({ contract_value: "1" })])).map(
        (f) => f.field,
      ),
    ).toContain("disclosureRows[0].ambiguousRow");
  });

  it("matches each contract reporting period independently", () => {
    const a = agreement();
    a.disclosureRows.push({
      ...a.disclosureRows[0]!,
      reportingPeriod: "2025-2026-Q2",
      totalValue: "300000",
    });
    const rows = raw([
      contract(),
      contract({ reporting_period: "2025-2026-Q2", contract_value: "300000" }),
    ]);
    expect(verifyAgreement(a, rows)).toEqual([]);
    rows.contracts.get("SYN-C1")!.pop();
    expect(verifyAgreement(a, rows).map((f) => f.field)).toEqual(["disclosureRows[1].missingRow"]);
  });

  it("does not broaden an invalid amendment locator into a reference-only match", () => {
    const a = agreement("g");
    a.evidence[0]!.locator = "ref_number=SYN-G1;amendment_number=invalid";
    expect(verifyAgreement(a, raw()).map((f) => f.field)).toContain("missingLocator");
  });

  it("streams synthetic CSV files, retains cited references only and combines corpus findings", async () => {
    const root = mkdtempSync(join(tmpdir(), "candef-verify-"));
    roots.push(root);
    const contracts = join(root, "contracts.csv");
    const grants = join(root, "grants.csv");
    writeFileSync(
      contracts,
      "reference_number,vendor_name,contract_value,instrument_type,reporting_period\nUNUSED,Unused,broken,A,Q1\nSYN-C1,Fictional Alpha Inc.,250000,A,2025-2026-Q1\n",
    );
    writeFileSync(
      grants,
      "ref_number,amendment_number,recipient_legal_name,agreement_value,agreement_type\nUNUSED,broken,Unused,broken,O\nSYN-G1,0,Fictional Alpha Inc.,250000,O\n",
    );
    const agreements = [agreement(), agreement("g"), { ...agreement(), id: "agr_other" }];
    const refs = collectCitedRefs(agreements);
    expect([...refs.contracts]).toEqual(["SYN-C1"]);
    expect([...refs.grants]).toEqual(["SYN-G1"]);
    const rows = await loadRawRows(contracts, grants, refs);
    expect([...rows.contracts.keys()]).toEqual(["SYN-C1"]);
    expect([...rows.grants.keys()]).toEqual(["SYN-G1"]);
    expect(rows.grants.get("SYN-G1")![0]!.agreement_type).toBe("O");
    expect(verifyCorpus(agreements, raw())).toEqual({ agreementsChecked: 2, findings: [] });
  });
});

describe("standalone government verifier CLI", () => {
  const cli = resolve("pipeline/research/verify-gov-claims-cli.ts");
  const tsx = resolve("node_modules/tsx/dist/cli.mjs");
  function run(root: string, args: string[] = []) {
    const result = spawnSync(process.execPath, [tsx, cli, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    });
    if (result.error) throw result.error;
    return result;
  }
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "candef-verify-cli-"));
    roots.push(root);
    mkdirSync(join(root, "research", "orgs"), { recursive: true });
    const a = agreement();
    writeFileSync(
      join(root, "research", "orgs", "synthetic.yaml"),
      JSON.stringify({
        org: {
          id: "org_synthetic_company",
          kind: "company",
          slug: "synthetic",
          name: "Fictional Alpha",
        },
        defaults: { createdBy: "test:synthetic" },
        agreements: [
          {
            ...a,
            family: "procurement",
            type: "contract_award",
            title: "Synthetic test agreement",
            programId: null,
            groupId: null,
            currency: "CAD",
            valueStatements: [],
            allocations: [],
            repayability: null,
            announcedOn: null,
            statusAsOf: { state: "unknown", asOf: "2026-01-01" },
          },
        ],
      }),
    );
    return root;
  }
  function dataset(root: string, date: string, total = "250000") {
    const dir = join(root, "research-cache", "gov-data", date);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "contracts.csv"),
      `reference_number,procurement_id,owner_org_title,vendor_name,reporting_period,contract_value,instrument_type,amendment_value,contract_period_start,delivery_date\nSYN-C1,SYN-P1,Fictional Department A,Fictional Alpha Inc.,2025-2026-Q1,${total},A,50000,2025-01-01,2026-01-01\n`,
    );
    writeFileSync(
      join(dir, "grants.csv"),
      "ref_number,amendment_number,recipient_legal_name,agreement_value,agreement_type\n",
    );
    return dir;
  }
  it("skips absent data with one line and exit zero", () => {
    const result = run(fixture());
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.stdout).toContain("skipped");
  });
  it("chooses newest dated folder and exits one with counts and findings", () => {
    const root = fixture();
    dataset(root, "2026-01-01");
    dataset(root, "2026-02-01", "1");
    const result = run(root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("agreements checked: 1; findings: 1");
    expect(result.stdout).toContain('"field":"disclosureRows[0].totalValue"');
  });
  it("honors --data and exits zero on a clean dataset", () => {
    const root = fixture();
    const data = dataset(root, "2026-01-01");
    dataset(root, "2026-02-01", "1");
    const result = run(root, ["--data", data]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agreements checked: 1; findings: 0");
  });
});
