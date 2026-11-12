import { describe, expect, it } from "vitest";
import { toContractRow, toGrantRow, validateHeader } from "./tbs";

describe("TBS parsing", () => {
  it("keeps money as exact signed decimal strings and trims text", () => {
    const row = toContractRow({
      reference_number: " fictional-c ",
      vendor_name: " Fictional Alpha ",
      contract_value: " $ 9,007,199,254,740,993.12 ",
      original_value: "",
      amendment_value: "-$ 11.11",
      contract_date: "2025-02-28",
      delivery_date: "2025-02-30",
      owner_org: " fictional-testing ",
      instrument_type: "A",
    });
    expect(row).toMatchObject({
      reference_number: "fictional-c",
      vendor_name: "Fictional Alpha",
      contract_value: "9007199254740993.12",
      original_value: null,
      amendment_value: "-11.11",
      contract_date: "2025-02-28",
      delivery_date: null,
      owner_org: "fictional-testing",
    });
  });
  it("parses amendment numbers and dates without coercing missing or invalid amounts to zero", () => {
    expect(
      toGrantRow({
        amendment_number: " 3 ",
        agreement_value: " +001.20 ",
        amendment_date: "2024-02-29",
      }),
    ).toMatchObject({ amendment_number: 3, agreement_value: "1.20", amendment_date: "2024-02-29" });
    expect(toGrantRow({ amendment_number: "0" }).agreement_value).toBeNull();
    expect(() => toGrantRow({ amendment_number: "1.5" })).toThrow(/amendment_number/);
    expect(() => toContractRow({ contract_value: "not money" })).toThrow(/contract_value/);
  });
  it("lists all missing required headers and permits unknown columns", () => {
    expect(() => validateHeader("contracts", ["vendor_name"])).toThrow(
      /reference_number.*contract_value.*instrument_type.*reporting_period/,
    );
    expect(() => validateHeader("grants", [])).toThrow(
      /ref_number.*amendment_number.*recipient_legal_name.*agreement_value.*agreement_type/,
    );
    expect(() =>
      validateHeader("contracts", [
        "reference_number",
        "vendor_name",
        "contract_value",
        "instrument_type",
        "reporting_period",
        "fictional_extra",
      ]),
    ).not.toThrow();
  });
});
