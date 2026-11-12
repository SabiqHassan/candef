import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Agreement } from "../../../src/domain/schema/corpus";
import { parseCsvText } from "./csv";
import { groupContracts, groupGrants } from "./group";
import { buildIndex, matchRecipient } from "./match";
import type { IndexEntity } from "./match";
import { toContractRow, toGrantRow } from "./tbs";
import { parseLocator } from "./locators";

const options = {
  sourceId: "src_fictional_testing",
  date: "2026-10-13",
  bodies: {
    "fictional-testing": "org_fictional_testing",
    "Fictional Department of Testing": "org_fictional_testing",
  },
};
async function fixture(name: string) {
  return parseCsvText(
    await readFile(new URL(`./__fixtures__/${name}.csv`, import.meta.url), "utf8"),
  );
}
const confirmed = {
  status: "confirmed" as const,
  orgId: "org_fictional_alpha",
  method: "name+postal",
  candidates: ["org_fictional_alpha"],
};

describe("agreement grouping", () => {
  it("retains contract running totals and signed deltas, with deterministic order and evidence", async () => {
    const rows = (await fixture("contracts")).map((r) => ({
      row: toContractRow(r),
      match: confirmed,
    }));
    const result = groupContracts([...rows].reverse(), options);
    const agreement = result.agreements[0]!;
    expect(Agreement.parse(agreement)).toEqual(agreement);
    expect(agreement.disclosureRows.map((r) => r.totalValue)).toEqual([
      "111.11",
      "133.33",
      "122.22",
    ]);
    expect(agreement.disclosureRows.map((r) => r.amendmentValue)).toEqual([
      null,
      "22.22",
      "-11.11",
    ]);
    expect(agreement.valueStatements).toEqual([]);
    expect(agreement.allocations).toEqual([]);
    expect(agreement).toMatchObject({
      epistemic: "sourced_fact",
      verification: "proposed",
      review: null,
      createdBy: "pipeline:tbs-import",
      family: "procurement",
      type: "contract_award",
      announcedOn: null,
      startOn: "2025-01-03",
      statusAsOf: { state: "unknown", asOf: "2026-10-13" },
    });
    expect(agreement.evidence.map((e) => parseLocator(e.locator)?.get("reference_number"))).toEqual(
      ["fictional-c0", "fictional-c1", "fictional-c2"],
    );
    expect(
      agreement.evidence.every(
        (e) => e.sourceId === options.sourceId && e.locatorQuality === "metadata",
      ),
    ).toBe(true);
    expect(agreement.id).toMatch(/^agr_tbs_c_[a-f0-9]{16}$/);
    expect(groupContracts(rows, options).agreements).toEqual(result.agreements);
  });
  it("retains all four grant replacement totals, never amendment deltas", async () => {
    const rows = (await fixture("grants")).map((r) => ({ row: toGrantRow(r), match: confirmed }));
    const agreement = groupGrants([...rows].reverse(), options).agreements[0]!;
    expect(Agreement.parse(agreement)).toEqual(agreement);
    expect(agreement.disclosureRows.map((r) => r.totalValue)).toEqual([
      "222.22",
      "233.33",
      "211.11",
      "244.44",
    ]);
    expect(
      agreement.disclosureRows.every(
        (r) => r.originalValue === "222.22" && r.amendmentValue === null,
      ),
    ).toBe(true);
    expect(agreement.disclosureRows[0]!.reportingPeriod).toBe("amendment 0 (2025-01-01)");
    expect(agreement.evidence[3]!.locator).toContain("ref_number=fictional-g;amendment_number=3;");
    expect(agreement).toMatchObject({
      type: "contribution",
      repayability: "unknown",
      currency: "CAD",
    });
    expect(agreement.externalIds.map((e) => e.system)).toEqual([
      "tbs-grants:ref_number",
      "tbs-grants:agreement_number",
      "tbs-grants:program",
    ]);
  });
  it("reports unmapped departments, skips O transfers and notes foreign currency", async () => {
    const contracts = (await fixture("contracts")).map((r) => ({
      row: toContractRow(r),
      match: confirmed,
    }));
    const unmapped = groupContracts(contracts, { ...options, bodies: {} });
    expect(unmapped.agreements).toEqual([]);
    expect(unmapped.unmappedDepartments).toEqual({ "fictional-testing": 3 });
    const raw = (await fixture("grants"))[0]!;
    const result = groupGrants(
      [
        { row: toGrantRow({ ...raw, agreement_type: "O" }), match: confirmed },
        {
          row: toGrantRow({
            ...raw,
            foreign_currency_type: "USD",
            foreign_currency_value: "333.33",
          }),
          match: confirmed,
        },
      ],
      options,
    );
    expect(result.skippedOtherGrants).toBe(1);
    expect(result.foreignCurrencyRows).toHaveLength(1);
    expect(result.agreements[0]!.disclosureRows[0]!.totalValue).toBe("222.22");
  });
  it("keeps earlier O rows as history of an agreement re-typed as a contribution, skips other O rows", async () => {
    const raw = (await fixture("grants"))[0]!;
    const mk = (n: number, type: string, title: string) => ({
      row: toGrantRow({
        ...raw,
        amendment_number: String(n),
        amendment_date: n ? `2025-0${n}-01` : "",
        agreement_type: type,
        agreement_title_en: title,
        agreement_value: "500",
      }),
      match: confirmed,
    });
    const history = groupGrants(
      [mk(2, "C", "fictional-agreement"), mk(0, "O", "A real project title"), mk(1, "O", "")],
      options,
    );
    expect(history.agreements).toHaveLength(1);
    const agreement = history.agreements[0]!;
    expect(agreement.type).toBe("contribution");
    expect(agreement.title).toBe("A real project title");
    expect(agreement.disclosureRows.map((r) => r.instrument)).toEqual([
      "original",
      "amendment",
      "amendment",
    ]);
    expect(history.skippedOtherGrants).toBe(0);
    const onlyOther = groupGrants([mk(0, "O", "x"), mk(1, "O", "x")], options);
    expect(onlyOther.agreements).toEqual([]);
    expect(onlyOther.skippedOtherGrants).toBe(2);
    const later = groupGrants([mk(0, "C", "x"), mk(1, "O", "x")], options);
    expect(later.agreements[0]!.disclosureRows).toHaveLength(1);
    expect(later.skippedOtherGrants).toBe(1);
  });
  it("produces no records from ambiguous, no-match or consortium rows", async () => {
    const raw = (await fixture("contracts"))[0]!;
    const entities: IndexEntity[] = [
      {
        orgId: "org_fictional_alpha",
        names: ["Fictional Alpha Bio Inc."],
        businessNumbers: [],
        postalFsas: ["Z1Z"],
      },
    ];
    const index = buildIndex(entities);
    const names = [
      "Fictional Alpha Bio Inc.",
      "Fictional Beta Clean Inc.",
      "Fictional Alpha in joint venture with Fictional Beta Inc.",
    ];
    const rows = names.map((name) => ({
      row: toContractRow({ ...raw, vendor_name: name }),
      match: matchRecipient({ names: [name], postal: null, businessNumber: null }, index),
    }));
    expect(groupContracts(rows, options).agreements).toEqual([]);
  });
  it("handles SOSA, missing money, buyer fallback, title truncation and warnings", async () => {
    const raw = (await fixture("contracts"))[0]!;
    const row = toContractRow({
      ...raw,
      owner_org: "",
      owner_org_title: "",
      procurement_id: "",
      description_en: "Fictional " + "x".repeat(210),
      instrument_type: "SOSA",
      contract_value: "",
      original_value: "",
    });
    const result = groupContracts([{ row, match: confirmed }], options);
    expect(Agreement.parse(result.agreements[0])).toMatchObject({
      type: "standing_offer",
      title: row.description_en.slice(0, 200),
    });
    // Integrator fix: a missing amount is null (not stated), never an empty string read as zero.
    expect(result.agreements[0]!.disclosureRows[0]!.totalValue).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    const bad = groupContracts(
      [
        {
          row: toContractRow({
            ...raw,
            instrument_type: "A",
            amendment_value: "",
            contract_value: "-1.23",
          }),
          match: confirmed,
        },
      ],
      options,
    );
    expect(bad.warnings.some((w) => w.reason.includes("negative"))).toBe(true);
    expect(bad.warnings.some((w) => w.reason.includes("amendment_value"))).toBe(true);
  });
  it("does not silently attribute a shared agreement key to the first of two confirmed recipients", async () => {
    const raw = (await fixture("contracts"))[0]!;
    const first = { row: toContractRow(raw), match: confirmed };
    const second = {
      row: toContractRow({ ...raw, vendor_name: "Fictional Beta Clean Inc." }),
      match: { ...confirmed, orgId: "org_fictional_beta", candidates: ["org_fictional_beta"] },
    };
    const result = groupContracts([first, second], options);
    expect(result.agreements).toEqual([]);
    expect(result.warnings[0]!.reason).toContain("conflicting confirmed recipients");
  });
  it("resolves exact buyer-name mappings even when an owner code is present", async () => {
    const rows = (await fixture("contracts")).map((r) => ({
      row: toContractRow(r),
      match: confirmed,
    }));
    const result = groupContracts(rows, {
      ...options,
      bodies: { "Fictional Department of Testing": "org_fictional_testing" },
    });
    expect(result.agreements).toHaveLength(1);
    expect(result.agreements[0]!.parties[0]!.orgId).toBe("org_fictional_testing");
    expect(result.agreements[0]!.id).toBe(groupContracts(rows, options).agreements[0]!.id);
    expect(result.unmappedDepartments).toEqual({});
  });
});
