import { describe, expect, it } from "vitest";
import { inspectLocal, lookup, newRows, parseQueries, periodKey } from "./discovery";
import { discoverResource } from "./resources";
import { columnsFor, locatorFor } from "./rows";
import type { SearchPort } from "./client";

const contract = (extra: Record<string, string> = {}) => ({
  reference_number: "FICTIONAL-1",
  vendor_name: "Fictional Aster Inc.",
  contract_value: "20.00",
  instrument_type: "C",
  reporting_period: "2026-2027-Q1",
  owner_org: "fictional-dept",
  ...extra,
});
const grant = (extra: Record<string, string> = {}) => ({
  ref_number: "FICTIONAL-G1",
  amendment_number: "0",
  recipient_type: "O",
  recipient_legal_name: "Fictional Aster Inc.",
  recipient_business_number: "123456789RC0001",
  agreement_value: "10.00",
  agreement_type: "G",
  owner_org: "fictional-dept",
  ...extra,
});
async function* csv(rows: Record<string, string>[]) {
  const headers = [...new Set(rows.flatMap(Object.keys))];
  yield "\uFEFF" + headers.join(",") + "\r\n";
  for (const row of rows)
    yield headers.map((h) => '"' + (row[h] ?? "").replaceAll('"', '""') + '"').join(",") + "\r\n";
}
function port(rows: Record<string, unknown>[]): SearchPort {
  return {
    search: async (_id, options) => ({
      total: rows.length,
      fields: [],
      records: rows
        .map((row, i) => ({ ...row, _id: i + 1 }))
        .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 1000)),
    }),
  };
}
describe("discovery leads", () => {
  it("streams the newest period and reports grants without a period as unsupported", async () => {
    const local = await inspectLocal(
      "contracts",
      csv([contract(), contract({ reporting_period: "2026-2027-Q3" })]),
    );
    expect(local).toMatchObject({
      rows: 2,
      newestPeriod: "2026-2027-Q3",
      hasReportingPeriod: true,
    });
    expect(await inspectLocal("grants", csv([grant()]))).toMatchObject({
      hasReportingPeriod: false,
      newestPeriod: null,
    });
    expect(() => periodKey("2026-2028-Q1")).toThrow(/period/i);
  });
  it("reports undated local rows while computing the newest nonblank period", async () => {
    expect(
      await inspectLocal("contracts", csv([contract({ reporting_period: "" }), contract()])),
    ).toMatchObject({ rows: 2, blankReportingPeriods: 1, newestPeriod: "2026-2027-Q1" });
    const local = await inspectLocal("contracts", csv([contract({ reporting_period: "" })]));
    expect(await newRows(port([]), "fictional", "contracts", local, "2026-2027-Q1")).toMatchObject({
      status: "unsupported",
      complete: false,
    });
  });
  it("stops at the local newest period and emits only department counts and existing-format locators", async () => {
    const local = await inspectLocal("contracts", csv([contract()]));
    const newest = contract({
      reference_number: "FICTIONAL-2",
      reporting_period: "2026-2027-Q2",
      contact_email: "forbidden@example.invalid",
    });
    const result = await newRows(
      port([newest, contract()]),
      "fictional",
      "contracts",
      local,
      "2025-2026-Q4",
      { limit: 1, maxPages: 3 },
    );
    expect(result).toMatchObject({
      complete: true,
      matched: 1,
      counts: [{ department: "fictional-dept", period: "2026-2027-Q2", count: 1 }],
    });
    expect(result.leads[0]!.locator).toContain("reference_number=FICTIONAL-2;");
    expect(result.leads[0]!.locator).toMatch(/row_sha256=[a-f0-9]{64}/);
    expect(JSON.stringify(result)).not.toContain("forbidden");
    expect(result.threshold).toBe("2026-2027-Q1");
  });
  it("does not infer a grants period and reports unparseable local periods", async () => {
    const local = await inspectLocal("grants", csv([grant()]));
    const result = await newRows(port([]), "fictional", "grants", local, "2026-2027-Q1");
    expect(result).toMatchObject({ status: "unsupported", complete: false });
    expect(
      await inspectLocal("contracts", csv([contract({ reporting_period: "bad" })])),
    ).toMatchObject({ invalidReportingPeriods: 1, newestPeriod: null });
  });
  it("matches normalized names exactly, BN roots strictly, excludes individuals, compares complete fingerprints", async () => {
    const old = grant();
    const changed = grant({ agreement_value: "11.00" });
    const malformed = grant({
      ref_number: "FICTIONAL-BAD",
      recipient_business_number: "1234567890",
    });
    const person = grant({ recipient_type: "P", recipient_legal_name: "Fictional Person" });
    const queries = parseQueries([
      "fictional aster ltd",
      "123456789",
      "1234567890",
      "Fictional Person",
      "Aster",
    ]);
    const result = await lookup(
      port([old, changed, malformed, person]),
      "fictional",
      "grants",
      csv([old]),
      queries,
    );
    expect(result.queries[0]).toMatchObject({
      apiMatches: 2,
      alreadyInLocal: 1,
      notInLocal: [{ locator: locatorFor("grants", changed) }],
    });
    expect(result.queries[1]).toMatchObject({ apiMatches: 2, alreadyInLocal: 1 });
    expect(result.queries[2]).toMatchObject({ status: "invalid", apiMatches: 0 });
    expect(result.queries[3]!.apiMatches).toBe(0);
    expect(result.queries[4]!.apiMatches).toBe(0);
    expect(result.invalidBusinessNumberRows).toBe(1);
    expect(result.skippedIndividuals).toBe(1);
  });
  it("does not lose duplicate rows when comparing row counts, and caps retained lookup output", async () => {
    const row = grant();
    const result = await lookup(
      port([row, row]),
      "fictional",
      "grants",
      csv([row]),
      parseQueries(["123456789"]),
      { limit: 1, maxPages: 1 },
    );
    expect(result).toMatchObject({ complete: false, total: 2 });
    expect(result.queries[0]).toMatchObject({ apiMatches: 1, alreadyInLocal: 1, notInLocal: [] });
  });
  it("hashes only importer source cells, preserves raw cell formatting, rejects missing fields", () => {
    const row = contract();
    expect(locatorFor("contracts", row)).toBe(
      locatorFor("contracts", { ...row, _id: 42, contact_email: "forbidden" }),
    );
    expect(locatorFor("contracts", row)).not.toBe(
      locatorFor("contracts", { ...row, contract_value: "20" }),
    );
  });
  it("discovers via package_show and rejects ambiguous or missing fingerprint fields", async () => {
    const fields = [...columnsFor("contracts"), "_id"].map((id) => ({ id, type: "text" }));
    const client = {
      packageShow: async () => ({
        id: "fictional-package",
        title: "Proactive Publication - Contracts",
        resources: [{ id: "fictional-resource", datastore_active: true }],
      }),
      ...port([]),
      search: async () => ({ fields, records: [], total: 4 }),
    };
    expect(await discoverResource(client, "contracts", "fictional-package")).toMatchObject({
      id: "fictional-resource",
      total: 4,
    });
    client.search = async () => ({ fields: [], records: [], total: 4 });
    await expect(discoverResource(client, "contracts", "fictional-package")).rejects.toThrow(
      /schema|fields/i,
    );
  });
  it("never treats a malformed API BN as a normalized name match and reports invalid inputs", async () => {
    const bad = grant({ recipient_business_number: "letters123456789" });
    const result = await lookup(
      port([bad]),
      "fictional",
      "grants",
      csv([bad]),
      parseQueries(["Fictional Aster", { businessNumber: "1234567890" }]),
    );
    expect(result.invalidBusinessNumberRows).toBe(1);
    expect(result.invalidLocalBusinessNumberRows).toBe(1);
    expect(result.queries.map((q) => q.apiMatches)).toEqual([0, 0]);
    expect(() => parseQueries([123456789])).toThrow(/numeric JSON/);
  });
  it("detects repeated IDs, invalid periods and count changes without claiming a complete scan", async () => {
    const local = await inspectLocal("contracts", csv([contract()]));
    await expect(
      newRows(
        port([contract({ reporting_period: "invalid" })]),
        "fictional",
        "contracts",
        local,
        "2026-2027-Q1",
      ),
    ).rejects.toThrow(/period/);
    const duplicate: SearchPort = {
      search: async () => ({ total: 2, fields: [], records: [{ ...grant(), _id: 1 }] }),
    };
    await expect(
      lookup(duplicate, "fictional", "grants", csv([grant()]), parseQueries(["Fictional Aster"]), {
        limit: 1,
        maxPages: 2,
      }),
    ).rejects.toThrow(/repeated/);
  });
  it("preserves partial new-row counts when the page cap is reached", async () => {
    const local = await inspectLocal("contracts", csv([contract()]));
    const result = await newRows(
      port([
        contract({ reporting_period: "2026-2027-Q2" }),
        contract({ reporting_period: "2026-2027-Q2" }),
      ]),
      "fictional",
      "contracts",
      local,
      "2026-2027-Q1",
      { limit: 1, maxPages: 1 },
    );
    expect(result).toMatchObject({ complete: false, matched: 1, total: 2, pages: 1 });
  });
  it("keeps incomplete local period coverage visible even when the API scan finishes", async () => {
    const local = await inspectLocal(
      "contracts",
      csv([contract(), contract({ reporting_period: "" }), contract({ reporting_period: "bad" })]),
    );
    const result = await newRows(port([]), "fictional", "contracts", local, "2026-2027-Q1");
    expect(result).toMatchObject({
      complete: false,
      apiScanComplete: true,
      localPeriodsComplete: false,
    });
  });
});
