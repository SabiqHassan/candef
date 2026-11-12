import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Agreement } from "../../../src/domain/schema/corpus";
import { columns, toCanadaBuysRow, validateHeader } from "./canadabuys";
import { parseCsvText, readCsv } from "./csv";
import { groupCanadaBuys } from "./group";
import { buildIndex, matchRecipient } from "./match";

const options = {
  sourceId: "src_fictional_canadabuys",
  date: "2026-10-13",
  bodies: { "Fictional Department of Testing": "org_fictional_testing" },
};
const confirmed = {
  status: "confirmed" as const,
  orgId: "org_fictional_alpha",
  method: "name+postal",
  candidates: ["org_fictional_alpha"],
};
async function fixture() {
  return parseCsvText(
    await readFile(new URL("./__fixtures__/canadabuys.csv", import.meta.url), "utf8"),
  );
}

describe("CanadaBuys parsing and grouping", () => {
  it("validates bilingual required headers while allowing older optional columns to be absent", async () => {
    const raw = (await fixture())[0]!;
    expect(() => validateHeader(Object.keys(raw))).not.toThrow();
    for (const key of [
      "contractNumber",
      "amendmentNumber",
      "supplierLegalName",
      "totalContractValue",
      "contractingEntityName",
    ] as const)
      expect(() =>
        validateHeader(Object.keys(raw).filter((header) => header !== columns[key])),
      ).toThrow(/missing required columns/);
    const minimal = Object.fromEntries(
      [
        "contractNumber",
        "amendmentNumber",
        "supplierLegalName",
        "totalContractValue",
        "contractingEntityName",
      ].map((key) => {
        const header = columns[key as keyof typeof columns];
        return [header, raw[header]!];
      }),
    );
    expect(() => validateHeader(Object.keys(minimal))).not.toThrow();
    expect(toCanadaBuysRow(minimal)).toMatchObject({
      instrumentType: "",
      amendmentType: "",
      currency: "CAD",
      currencyDefaulted: true,
    });
  });
  it("parses exact money, calendar dates and integer amendments, preserving the legal name verbatim", async () => {
    const raw = (await fixture())[0]!;
    const row = toCanadaBuysRow({
      ...raw,
      [columns.contractAmount]: " $9,007,199,254,740,993.01 ",
      [columns.totalContractValue]: "",
      [columns.amendmentDate]: "2025-02-30",
      [columns.supplierLegalName]: " Fictional Alpha Bio Inc. ",
    });
    expect(row).toMatchObject({
      contractAmount: "9007199254740993.01",
      totalContractValue: null,
      amendmentDate: null,
      amendmentNumber: 0,
      supplierLegalName: " Fictional Alpha Bio Inc. ",
    });
    expect(toCanadaBuysRow({ ...raw, [columns.contractAmount]: "" }).contractAmount).toBeNull();
    for (const value of ["", "-1", "1.5", "9007199254740992"])
      expect(() => toCanadaBuysRow({ ...raw, [columns.amendmentNumber]: value })).toThrow(
        /amendmentNumber/,
      );
  });
  it("discards excluded CSV values and never accesses contact properties in the row parser", async () => {
    async function* input() {
      yield 'contractNumber-numeroContrat,contactInfoName-private\nFictional-1,"Fictional secret, with a quote "" and newline\ncontinued"\n';
    }
    const selected = [];
    for await (const row of readCsv(
      input(),
      undefined,
      (header) => header === columns.contractNumber,
    ))
      selected.push(row);
    expect(selected).toEqual([{ [columns.contractNumber]: "Fictional-1" }]);
    const raw = new Proxy((await fixture())[0]!, {
      get(target, key: string) {
        if (key.startsWith("contactInfo")) throw new Error("Contact data accessed");
        return target[key];
      },
      ownKeys() {
        throw new Error("Raw record enumerated");
      },
    });
    expect(() => toCanadaBuysRow(raw)).not.toThrow();
  });
  it("keeps cumulative totals and null deltas across 000/001/002, with deterministic IDs and provenance", async () => {
    const rows = (await fixture())
      .slice(0, 3)
      .map((raw) => ({ row: toCanadaBuysRow(raw), match: confirmed }));
    const result = groupCanadaBuys([...rows].reverse(), options);
    const agreement = result.agreements[0]!;
    expect(Agreement.parse(agreement)).toEqual(agreement);
    expect(agreement.disclosureRows.map((row) => row.totalValue)).toEqual([
      "111.11",
      "133.33",
      "122.22",
    ]);
    expect(
      agreement.disclosureRows.every(
        (row) => row.originalValue === "111.11" && row.amendmentValue === null,
      ),
    ).toBe(true);
    expect(agreement.disclosureRows.map((row) => row.reportingPeriod)).toEqual([
      "amendment 0 (2025-01-02)",
      "amendment 1 (2025-02-01)",
      "amendment 2 (2025-03-01)",
    ]);
    expect(agreement.disclosureRows[2]!.endOnAsStated).toBe("2026-03-01");
    expect(agreement).toMatchObject({
      family: "procurement",
      type: "contract_award",
      title: "Fictional latest title",
      currency: "CAD",
      announcedOn: null,
      startOn: "2025-01-03",
      statusAsOf: { state: "stated_completed", asOf: options.date },
      createdBy: "pipeline:canadabuys-import",
      verification: "proposed",
      review: null,
      valueStatements: [],
      allocations: [],
    });
    expect(agreement.id).toBe(
      "agr_cb_" +
        createHash("sha256")
          .update(JSON.stringify(["Fictional Department of Testing", "Fictional-CB-1"]))
          .digest("hex")
          .slice(0, 16),
    );
    expect(agreement.externalIds).toEqual([
      { system: "canadabuys:contractNumber", value: "Fictional-CB-1" },
      { system: "canadabuys:solicitationNumber", value: "Fictional-sol-1" },
      { system: "canadabuys:referenceNumber", value: "Fictional-ref-0" },
      { system: "canadabuys:referenceNumber", value: "Fictional-ref-1" },
    ]);
    expect(agreement.evidence).toEqual(
      [0, 1, 2].map((n) => ({
        sourceId: options.sourceId,
        locator: `contractNumber=Fictional-CB-1;amendmentNumber=${n}`,
        locatorQuality: "metadata",
      })),
    );
    expect(groupCanadaBuys(rows, options).agreements).toEqual(result.agreements);
  });
  it("uses the latest status and instrument, sorts amendment dates, and skips cancelled groups", async () => {
    const raw = (await fixture())[0]!;
    const original = { row: toCanadaBuysRow(raw), match: confirmed };
    const amendment = (date: string, status: string) => ({
      row: toCanadaBuysRow({
        ...raw,
        [columns.amendmentNumber]: "001",
        [columns.amendmentDate]: date,
        [columns.status]: status,
      }),
      match: confirmed,
    });
    const cancelled = groupCanadaBuys(
      [amendment("2025-03-01", "Cancelled"), original, amendment("2025-02-01", "Active")],
      options,
    );
    expect(cancelled.agreements).toEqual([]);
    expect(cancelled.skippedCancelledGroups).toBe(1);
    const active = groupCanadaBuys(
      [original, amendment("2025-02-01", "Cancelled"), amendment("2025-03-01", "Active")],
      options,
    );
    expect(Agreement.parse(active.agreements[0]).statusAsOf.state).toBe("stated_active");
    for (const [instrument, type] of [
      ["STANDING OFFER", "standing_offer"],
      ["Supply Arrangement", "standing_offer"],
      ["Task Authorization", "call_up"],
      ["Contract", "contract_award"],
      ["", "contract_award"],
    ]) {
      const latest = {
        row: toCanadaBuysRow({
          ...raw,
          [columns.amendmentNumber]: "002",
          [columns.instrumentType]: instrument!,
          [columns.title]: "Fictional " + "x".repeat(210),
        }),
        match: confirmed,
      };
      const agreement = Agreement.parse(groupCanadaBuys([latest, original], options).agreements[0]);
      expect(agreement.type).toBe(type);
      expect(agreement.title).toHaveLength(200);
    }
  });
  it("handles missing original money, reference fallback, unknown status and an exact unmapped buyer", async () => {
    const raw = (await fixture())[0]!;
    const row = toCanadaBuysRow({
      ...raw,
      [columns.contractNumber]: "",
      [columns.amendmentNumber]: "001",
      [columns.contractAmount]: "",
      [columns.totalContractValue]: "",
      [columns.status]: "",
      [columns.title]: "",
    });
    const agreement = Agreement.parse(
      groupCanadaBuys([{ row, match: confirmed }], options).agreements[0],
    );
    expect(agreement.title).toBe("Contract");
    expect(agreement.disclosureRows[0]).toMatchObject({
      originalValue: null,
      amendmentValue: null,
      totalValue: null,
    });
    expect(agreement.statusAsOf.state).toBe("unknown");
    expect(agreement.externalIds).not.toContainEqual({
      system: "canadabuys:contractNumber",
      value: "",
    });
    const unmapped = groupCanadaBuys([{ row, match: confirmed }], {
      ...options,
      bodies: { "fictional department of testing": "org_fictional_testing" },
    });
    expect(unmapped.agreements).toEqual([]);
    expect(unmapped.unmappedDepartments).toEqual({ "Fictional Department of Testing": 1 });
  });
  it("confirms legal or operating names with postal and excludes unconfirmed/consortium rows", async () => {
    const index = buildIndex([
      {
        orgId: "org_fictional_alpha",
        names: ["Fictional Alpha Bio Inc."],
        businessNumbers: [],
        postalFsas: ["Z1Z"],
      },
    ]);
    const raw = (await fixture())[0]!;
    const entries = [
      raw,
      {
        ...raw,
        [columns.supplierLegalName]: "Fictional Different Legal",
        [columns.supplierOperatingName]: "Fictional Alpha Bio Inc.",
      },
      { ...raw, [columns.supplierPostal]: "" },
      {
        ...raw,
        [columns.supplierLegalName]: "Fictional Alpha in joint venture with Fictional Beta Inc.",
      },
    ].map((record) => {
      const row = toCanadaBuysRow(record);
      return {
        row,
        match: matchRecipient(
          {
            names: [row.supplierLegalName, row.supplierOperatingName].filter((name) => name.trim()),
            businessNumber: null,
            postal: row.supplierPostal,
          },
          index,
        ),
      };
    });
    expect(entries.map((entry) => entry.match.status)).toEqual([
      "confirmed",
      "confirmed",
      "ambiguous",
      "consortium",
    ]);
    expect(entries[0]!.match.method).toBe("name+postal");
    expect(groupCanadaBuys(entries.slice(2), options).agreements).toEqual([]);
    const agreement = Agreement.parse(groupCanadaBuys([entries[1]!], options).agreements[0]);
    expect(agreement.parties[1]!.reportedName).toBe("Fictional Different Legal");
  });
});
