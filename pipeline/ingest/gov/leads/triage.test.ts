import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyHeldRow,
  assertTriageOutputDir,
  triageHeldRows,
  type HeldRow,
  type ResearchProfile,
} from "./triage";
import { toContractRow } from "../tbs";
import { rowLocator } from "../locators";

const profile: ResearchProfile = {
  orgId: "org_fictional_aster",
  slug: "fictional-aster",
  name: "Fictional Aster Ltd.",
  legalNames: ["Fictional Aster Ltd."],
  foundedYears: [2019],
  provinces: ["ON"],
  cities: ["Ottawa"],
  postalAreas: ["K1A"],
  locations: [{ province: "ON", city: "Ottawa", postalArea: "K1A" }],
  departments: ["fictional-dept"],
  programmes: ["Fictional Technology Programme"],
};
const row: HeldRow = {
  dataset: "grants",
  locator: "fictional row 1",
  name: "Fictional Aster Inc.",
  startOn: "2024-03-01",
  date: "2024-03-01",
  dateBasis: "start",
  value: "12345",
  currency: "CAD",
  province: "ON",
  city: "Ottawa",
  postalArea: null,
  department: "fictional-dept",
  programme: "Fictional Technology Programme",
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("held government rows are triage, never acceptance", () => {
  it("compares bilingual and explicit parenthetical name variants without rejecting the same entity", () => {
    expect(
      classifyHeldRow({ ...row, name: "Fictional Aster Ltd.|Fictional Aster Ltd." }, profile)
        .verdict,
    ).toBe("plausible");
    expect(classifyHeldRow({ ...row, name: "Fictional Aster Ltd. (FA)" }, profile).verdict).toBe(
      "plausible",
    );
  });
  it("never turns missing data at a second recorded location into a hard mismatch", () => {
    const multi = {
      ...profile,
      provinces: ["ON", "BC"],
      cities: ["Ottawa", "Vancouver"],
      locations: [
        { province: "ON", city: "Ottawa", postalArea: "K1A" },
        { province: "BC", city: "Vancouver", postalArea: null },
      ],
    };
    expect(
      classifyHeldRow({ ...row, province: "BC", city: "Vancouver", postalArea: "V6B" }, multi)
        .verdict,
    ).toBe("plausible");
    expect(
      classifyHeldRow(
        { ...row, province: "AB" },
        {
          ...multi,
          provinces: ["ON"],
          locations: [multi.locations[0]!, { province: null, city: "Vancouver", postalArea: null }],
        },
      ).verdict,
    ).toBe("plausible");
  });
  it("rejects only hard chronology, location and legal-name contradictions", () => {
    expect(classifyHeldRow({ ...row, startOn: "2018-12-31" }, profile)).toMatchObject({
      verdict: "clearly_not",
      reasons: expect.arrayContaining([expect.stringContaining("before")]),
    });
    expect(classifyHeldRow({ ...row, startOn: "2019-01-01" }, profile).verdict).toBe("plausible");
    expect(classifyHeldRow({ ...row, province: "BC" }, profile).reasons).toContainEqual(
      expect.stringContaining("province"),
    );
    expect(classifyHeldRow({ ...row, postalArea: "V6B" }, profile).verdict).toBe("clearly_not");
    expect(classifyHeldRow({ ...row, name: "Fictional Other Ltd." }, profile).verdict).toBe(
      "clearly_not",
    );
    expect(
      classifyHeldRow({ ...row, startOn: "2018-01-01" }, { ...profile, foundedYears: [2017, 2019] })
        .verdict,
    ).toBe("plausible");
  });
  it("lists corroboration and missing anchors for plausible rows", () => {
    const result = classifyHeldRow(row, profile);
    expect(result.verdict).toBe("plausible");
    expect(result.supports).toContainEqual(expect.stringContaining("city"));
    expect(result.supports).toContainEqual(expect.stringContaining("province"));
    expect(result.supports).toContainEqual(expect.stringContaining("department"));
    expect(result.supports).toContainEqual(expect.stringContaining("programme"));
    expect(result.missing).toContainEqual(expect.stringContaining("anchor"));
  });
  it("uses unknown when records cannot judge; an award date is not a start date", () => {
    expect(
      classifyHeldRow(
        { ...row, startOn: null, date: "2010-01-01", dateBasis: "award" },
        { ...profile, foundedYears: [], provinces: [], cities: [], postalAreas: [] },
      ).verdict,
    ).toBe("unknown");
    expect(classifyHeldRow(row, { ...profile, legalNames: [] }).verdict).toBe("unknown");
    expect(classifyHeldRow({ ...row, province: "Ontario" }, profile).verdict).toBe("plausible");
  });
  it("refuses outputs outside research-cache including traversal", async () => {
    const root = mkdtempSync(join(tmpdir(), "candef-triage-"));
    roots.push(root);
    mkdirSync(join(root, "research-cache"));
    await expect(assertTriageOutputDir(root, join(root, "research-cache", "triage"))).resolves.toBe(
      join(root, "research-cache", "triage"),
    );
    for (const dir of [
      root,
      join(root, "research"),
      join(root, "research-cache-other"),
      join(root, "research-cache", "..", "research"),
    ])
      await expect(assertTriageOutputDir(root, dir)).rejects.toThrow(/research-cache/);
  });
  it("reads only exact locators, skips individuals, preserves inputs and orders deterministically", async () => {
    const root = mkdtempSync(join(tmpdir(), "candef-triage-"));
    roots.push(root);
    const cache = join(root, "research-cache");
    mkdirSync(cache);
    const raw = {
      reference_number: "FICT-001",
      procurement_id: "FICT-P1",
      vendor_name: "Fictional Aster Ltd.",
      vendor_postal_code: "",
      owner_org: "fictional-dept",
      instrument_type: "C",
      reporting_period: "2024-2025-Q1",
      contract_period_start: "2024-03-01",
      contract_value: "12345",
      original_value: "12345",
    };
    const parsed = toContractRow(raw);
    const locator = rowLocator("contracts", parsed);
    const columns = Object.keys(raw);
    const csv = [columns.join(","), columns.map((k) => raw[k as keyof typeof raw]).join(",")].join(
      "\n",
    );
    writeFileSync(join(cache, "contracts.csv"), csv);
    writeFileSync(
      join(cache, "grants.csv"),
      "ref_number,amendment_number,recipient_legal_name,agreement_value,agreement_type,recipient_type\nFICT-PERSON,0,Fictional Individual,123,G,P\n",
    );
    const candidates = [
      { dataset: "contracts" as const, locator, method: "name_only", candidates: [profile.orgId] },
      {
        dataset: "grants" as const,
        locator: "ref_number=FICT-PERSON",
        method: "name_only",
        candidates: [profile.orgId],
      },
    ];
    const before = JSON.stringify(candidates);
    const options = {
      root,
      contracts: join(cache, "contracts.csv"),
      grants: join(cache, "grants.csv"),
      candidates,
      profiles: [profile],
      out: join(cache, "triage"),
    };
    const result = await triageHeldRows(options);
    expect(result.inputCandidates).toBe(2);
    expect(result.skippedIndividualCandidates).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      locator,
      verdict: "plausible",
      value: "12345",
      name: "Fictional Aster Ltd.",
    });
    expect(readFileSync(join(options.out, "triage.md"), "utf8")).not.toContain(
      "Fictional Individual",
    );
    expect(JSON.stringify(candidates)).toBe(before);
    expect(readFileSync(options.contracts, "utf8")).toBe(csv);
    const reverse = await triageHeldRows({ ...options, candidates: [...candidates].reverse() });
    expect(reverse).toEqual(result);
    const missing = await triageHeldRows({
      ...options,
      candidates: [{ ...candidates[0]!, locator: locator.replace("FICT-P1", "FICT-P2") }],
    });
    expect(missing.rows[0]).toMatchObject({ verdict: "unknown", name: null });
  });
});
