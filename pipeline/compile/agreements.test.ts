import { describe, expect, it } from "vitest";
import { DisclosureRow, type Agreement } from "../../src/domain/schema/corpus";
import { assertMagnitudeCounts } from "../ingest/gov/match";
import { currentValue } from "./agreements";

const row = (totalValue: string | null): Agreement["disclosureRows"][number] => ({
  reportingPeriod: "2025-2026-Q1",
  instrument: "original",
  originalValue: totalValue,
  amendmentValue: null,
  totalValue,
  endOnAsStated: null,
});

describe("missing disclosure amounts are gaps, never zero (integrator fix to M3-D)", () => {
  it("the schema rejects an empty string or a non-decimal as money", () => {
    expect(DisclosureRow.safeParse(row("")).success).toBe(false);
    expect(DisclosureRow.safeParse(row("$1,000")).success).toBe(false);
    expect(DisclosureRow.safeParse(row(null)).success).toBe(true);
    expect(DisclosureRow.safeParse(row("-25000.50")).success).toBe(true);
  });
  it("a latest row without a total yields an undisclosed value", () => {
    const g = { currency: "CAD", disclosureRows: [row("100.00"), row(null)], valueStatements: [] };
    const v = currentValue(g as unknown as Agreement);
    expect(v.money).toMatchObject({ amount: null, disclosure: "undisclosed" });
  });
});

describe("import magnitude gate default", () => {
  it("is proportional for small files but capped at 5000 rows per organization", () => {
    const counts = new Map([["org_x", 5001]]);
    expect(() => assertMagnitudeCounts(counts, 1_300_000)).toThrow(/Magnitude gate failed/);
    expect(() => assertMagnitudeCounts(new Map([["org_x", 60]]), 100)).toThrow();
    expect(() => assertMagnitudeCounts(new Map([["org_x", 50]]), 100)).not.toThrow();
  });
});
