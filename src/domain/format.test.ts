import { describe, expect, it } from "vitest";
import {
  compactNumber,
  formatAmount,
  formatMoney,
  formatPartialDate,
  formatTotals,
  formatFinancingSummary,
} from "./format";

describe("financing summary states", () => {
  it("distinguishes stated amounts excluded from totals from undisclosed rounds", () => {
    expect(
      formatFinancingSummary({
        totals: [],
        roundsKnown: 4,
        roundsWithResolvedAmount: 4,
        roundsWithStatedAmount: 4,
      }),
    ).toMatchObject({
      headline: "No total",
      note: expect.stringContaining("4 of 4 verified rounds state an amount"),
    });
    expect(
      formatFinancingSummary({
        totals: [],
        roundsKnown: 2,
        roundsWithResolvedAmount: 0,
        roundsWithStatedAmount: 0,
      }).headline,
    ).toBe("Undisclosed");
    expect(
      formatFinancingSummary({
        totals: [],
        roundsKnown: 1,
        roundsWithResolvedAmount: 0,
        roundsWithStatedAmount: 1,
      }).headline,
    ).toBe("No total");
  });
  it("keeps currency totals separate and explains the coverage", () => {
    const result = formatFinancingSummary({
      totals: [{ currency: "CAD", amount: "123000" }],
      roundsKnown: 2,
      roundsWithResolvedAmount: 1,
      roundsWithStatedAmount: 1,
    });
    expect(result.headline).toBe("CA$123K");
    expect(result.note).toContain("1 of 2 verified rounds state an amount");
  });
});

describe("money formatting", () => {
  it("always labels the currency, including CAD", () => {
    expect(formatAmount("12500000", "CAD")).toBe("CA$12.5M");
    expect(formatAmount(-250000, "CAD")).toBe("-CA$250K");
    expect(formatAmount("92000000", "USD")).toBe("US$92M");
    expect(formatAmount(5000, "unknown")).toBe("5K (currency not stated)");
  });
  it("never shows a number for undisclosed money", () => {
    expect(formatMoney(null)).toBe("Undisclosed");
    expect(
      formatMoney({
        amount: null,
        currency: "CAD",
        disclosure: "undisclosed",
        asStated: "not disclosed",
      }),
    ).toBe("Undisclosed");
  });
});

describe("money formatting, further cases", () => {
  const money = (
    disclosure: "approximate" | "not_applicable" | "disclosed",
    amount: string | null,
  ) => ({
    amount,
    currency: "CAD" as const,
    disclosure,
    asStated: "",
  });
  it("marks approximate amounts and never invents a value for non-monetary agreements", () => {
    expect(formatMoney(money("approximate", "2000000"))).toBe("≈ CA$2M");
    expect(formatMoney(money("not_applicable", null))).toBe("No monetary value");
    expect(formatMoney(money("disclosed", null))).toBe("Undisclosed");
  });
  it("lists totals per currency joined with +, never converting", () => {
    expect(
      formatTotals([
        { currency: "CAD", amount: "173600000" },
        { currency: "USD", amount: "1500000" },
      ]),
    ).toBe("CA$173.6M + US$1.5M");
    expect(formatTotals([])).toBe("");
  });
  it("falls back to the currency code when the currency is not a valid ISO code", () => {
    expect(formatAmount(1500, "ZZ")).toBe("ZZ 1.5K");
  });
  it("compacts numbers", () => {
    expect(compactNumber(0)).toBe("0");
    expect(compactNumber(1234)).toBe("1.2K");
    expect(compactNumber(2_500_000)).toBe("2.5M");
  });
});

describe("partial dates", () => {
  it("keeps the precision the source gave", () => {
    expect(formatPartialDate("2024")).toBe("2024");
    expect(formatPartialDate("2024-03")).toBe("Mar 2024");
    expect(formatPartialDate("2024-03-12")).toBe("12 Mar 2024");
    expect(formatPartialDate("2024-03-02")).toBe("2 Mar 2024");
  });
  it("says so when there is no date, instead of guessing", () => {
    expect(formatPartialDate(null)).toBe("Date not stated");
    expect(formatPartialDate("")).toBe("Date not stated");
  });
  it("shows an out-of-range month as given rather than failing", () => {
    expect(formatPartialDate("2024-13")).toBe("13 2024");
  });
});

describe("money disclosed as a range", () => {
  it("reads as an upper bound", () => {
    expect(
      formatMoney({
        amount: "23000000",
        currency: "unknown",
        disclosure: "range",
        asStated: "up to $23 million",
      }),
    ).toBe("up to 23M (currency not stated)");
  });
});
