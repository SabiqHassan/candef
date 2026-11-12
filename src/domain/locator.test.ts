import { describe, expect, it } from "vitest";
import { decodeGovLocator, reportingPeriod } from "./locator";

const SHA = "a".repeat(64);
const departments = (code: string) =>
  code === "fict-dept" ? "Fictional Department of Testing" : undefined;

describe("government row locators (display only)", () => {
  it("decodes a versioned contract locator into labelled fields", () => {
    const raw = `reference_number=C-2023-2024-Q2-00001;procurement_id=FICT-001%2F002;vendor_name=Fictional%20Aster%20Ltd.;owner_org=fict-dept;locator_version=1;row_sha256=${SHA}`;
    const d = decodeGovLocator(raw, departments)!;
    expect(d.form).toBe("contract");
    expect(d.fields).toEqual([
      { label: "Reference number", value: "C-2023-2024-Q2-00001" },
      { label: "Reporting period", value: "2023-2024, Q2" },
      { label: "Procurement ID", value: "FICT-001/002" },
      { label: "Vendor (as stated)", value: "Fictional Aster Ltd." },
      { label: "Department", value: "Fictional Department of Testing (fict-dept)" },
    ]);
    expect(d.fingerprint).toBe(SHA);
    expect(d.raw).toBe(raw);
  });

  it("decodes a versioned grant locator and keeps unknown department codes", () => {
    const d = decodeGovLocator(
      `ref_number=999-2025-2026-Q4-12345;amendment_number=0;agreement_number=12345;recipient_legal_name=FICTIONAL%20BOREAL%20INC.;owner_org=unknown-org;locator_version=1;row_sha256=${SHA}`,
      departments,
    )!;
    expect(d.form).toBe("grant");
    expect(d.fields).toContainEqual({ label: "Amendment number", value: "0 (original agreement)" });
    expect(d.fields).toContainEqual({
      label: "Recipient (as stated)",
      value: "FICTIONAL BOREAL INC.",
    });
    expect(d.fields).toContainEqual({ label: "Department", value: "unknown-org" });
    expect(d.fields).toContainEqual({ label: "Reporting period", value: "2025-2026, Q4" });
  });

  it("reads older unversioned locators without URL-decoding and names the columns read", () => {
    const d = decodeGovLocator(
      "ref_number=999-2026-2027-Q1-015;amendment_number=2 (prog_name_en)",
    )!;
    expect(d.fingerprint).toBeNull();
    expect(d.fields).toEqual([
      { label: "Reference number", value: "999-2026-2027-Q1-015" },
      { label: "Reporting period", value: "2026-2027, Q1" },
      { label: "Amendment number", value: "2" },
      { label: "Fields read", value: "programme name" },
    ]);
    expect(decodeGovLocator("reference_number=C-100%")!.fields[0]!.value).toBe("C-100%");
  });

  it("falls back to raw text for anything it does not recognise", () => {
    for (const raw of [
      "opening paragraph (round, lead)",
      "Total value of contract",
      "contract_number=FICT-1;locator_version=1",
      `reference_number=C-1;locator_version=2;row_sha256=${SHA}`,
      "reference_number=C-1;row_sha256=not-a-hash",
      "reference_number=C-1;reference_number=C-2",
      "reference_number=%E0%A4%A;locator_version=1",
    ])
      expect(decodeGovLocator(raw)).toBeNull();
  });

  it("derives a reporting period only from a fiscal-year pair", () => {
    expect(reportingPeriod("TC-2023-2024-Q4-00001")).toBe("2023-2024, Q4");
    expect(reportingPeriod("GC-2015-Q1-00001")).toBeNull();
    expect(reportingPeriod("C-2023-2025-Q1-00001")).toBeNull();
  });
});
