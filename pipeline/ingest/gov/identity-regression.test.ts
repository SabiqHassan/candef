import { describe, expect, it } from "vitest";
import { businessNumberRoot } from "../../research/names";
import { groupContracts } from "./group";
import { toContractRow } from "./tbs";

// Fictional regression probes: no research records are used by this suite.
const options = {
  bodies: { fictional: "org_fictional_department" },
  sourceId: "src_fictional",
  date: "2026-10-14",
};
const match = {
  status: "confirmed" as const,
  orgId: "org_fictional_company",
  candidates: ["org_fictional_company"],
  method: "name+postal",
};
const row = (value: string) =>
  toContractRow({
    reference_number: "fictional-batch",
    owner_org: "fictional",
    vendor_name: "Fictional Orbit Inc.",
    contract_value: value,
    instrument_type: "C",
    reporting_period: "2025-2026-Q1",
    is_demo: "true",
  });

describe("government identity regressions", () => {
  it("never merges unrelated contracts with a shared batch reference and blank procurement IDs", () => {
    expect(
      groupContracts(
        [
          { row: row("100"), match },
          { row: row("200"), match },
        ],
        options,
      ).agreements,
    ).toHaveLength(2);
  });
  it("rejects malformed 13-digit business numbers instead of truncating them", () => {
    expect(businessNumberRoot("1234567890001")).toBeNull();
    expect(businessNumberRoot("letters123456789")).toBeNull();
    expect(businessNumberRoot("123456789RC0002")).toBe("123456789");
  });
  it("makes equal-period histories deterministic regardless of input order", () => {
    const a = { row: { ...row("100"), procurement_id: "fictional-contract" }, match };
    const b = { row: { ...row("200"), procurement_id: "fictional-contract" }, match };
    expect(groupContracts([a, b], options)).toEqual(groupContracts([b, a], options));
  });
});
