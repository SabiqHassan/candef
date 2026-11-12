import { describe, expect, it } from "vitest";
import { auditContractChain, auditGrantChain, decimalSum } from "./audit";
import { reconcileNumbers } from "./identity";
import { groupGrants } from "./group";
import { toContractRow, toGrantRow } from "./tbs";
const match = {
  status: "confirmed" as const,
  orgId: "org_fictional",
  candidates: ["org_fictional"],
  method: "name+bn",
};
const options = {
  bodies: { fictional: "org_fictional_buyer" },
  sourceId: "src_fictional",
  date: "2026-10-14",
};
const grant = (ref: string, program: string, value: string) =>
  groupGrants(
    [
      {
        row: toGrantRow({
          ref_number: ref,
          amendment_number: "0",
          agreement_number: "fictional-number",
          recipient_legal_name: "Fictional Orbit Inc.",
          owner_org: "fictional",
          agreement_type: "C",
          agreement_start_date: "2025-01-01",
          agreement_value: value,
          prog_name_en: program,
        }),
        match,
      },
    ],
    options,
  ).agreements[0]!;

describe("agreement economics and duplicate numbers", () => {
  it("checks signed deltas using exact decimal arithmetic beyond JS integer precision", () => {
    expect(decimalSum(["9007199254740993.01", "-0.02"])).toBe("9007199254740992.99");
    const rows = [
      toContractRow({
        instrument_type: "C",
        contract_value: "100.01",
        reporting_period: "2025-2026-Q1",
      }),
      toContractRow({
        instrument_type: "A",
        contract_value: "90",
        amendment_value: "-10.01",
        reporting_period: "2025-2026-Q2",
      }),
    ];
    expect(auditContractChain(rows)).toEqual([]);
    rows[1]!.contract_value = "91";
    expect(auditContractChain(rows).some((x) => x.code === "arithmetic_mismatch")).toBe(true);
  });
  it("does not turn incomplete or tied sequences into asserted arithmetic", () => {
    expect(
      auditContractChain([
        toContractRow({ instrument_type: "A", contract_value: "1", amendment_value: "1" }),
      ]).some((x) => x.code === "missing_original"),
    ).toBe(true);
    const rows = [
      toGrantRow({ amendment_number: "0", agreement_value: "100", agreement_type: "O" }),
      toGrantRow({ amendment_number: "2", agreement_value: "150", agreement_type: "C" }),
    ];
    expect(auditGrantChain(rows).map((x) => x.code)).toContain("amendment_gap");
    expect(auditGrantChain(rows).some((x) => x.code === "arithmetic_mismatch")).toBe(false);
  });
  it("withholds shared-number candidates and distinguishes possible revisions from components without summing", () => {
    const a = grant("fictional-a", "Fictional Program", "250");
    const b = grant("fictional-b", "Fictional Program", "500");
    const revised = reconcileNumbers([a, b]);
    expect(revised.agreements).toEqual([]);
    expect(revised.cases[0]?.classification).toBe("revised_total_candidate");
    const c = grant("fictional-c", "Fictional Other Program", "700");
    expect(reconcileNumbers([a, c]).cases[0]?.classification).toBe("separate_component_candidate");
    expect(reconcileNumbers([a, b])).toEqual(reconcileNumbers([b, a]));
  });
  it("does not collide agreement numbers across departments or recipients", () => {
    const a = grant("fictional-a", "Fictional Program", "250");
    const b = grant("fictional-b", "Fictional Program", "500");
    b.parties[0]!.orgId = "org_fictional_other_department";
    expect(reconcileNumbers([a, b]).agreements).toHaveLength(2);
  });
});
