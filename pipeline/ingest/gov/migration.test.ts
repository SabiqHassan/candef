import { describe, expect, it } from "vitest";
import { planMigration, resolveAlias } from "./migration";
import { groupContracts, groupGrants } from "./group";
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
const grant = (ref: string, value: string) =>
  groupGrants(
    [
      {
        row: toGrantRow({
          ref_number: ref,
          amendment_number: "0",
          agreement_number: "fictional-number",
          recipient_legal_name: "Fictional Orbit",
          owner_org: "fictional",
          agreement_type: "C",
          agreement_value: value,
        }),
        match,
      },
    ],
    options,
  ).agreements[0]!;

describe("read-only migration planning", () => {
  it("does not refresh merged citations over a corrected agreement-level claim", () => {
    const a = grant("fictional-a", "250"),
      b = grant("fictional-b", "500");
    a.startOn = "2025-01-01";
    b.startOn = "2025-01-01";
    const merged = {
      ...a,
      evidence: [...a.evidence, ...b.evidence],
      disclosureRows: [...a.disclosureRows, ...b.disclosureRows],
    };
    const corrected = structuredClone(b);
    corrected.startOn = "2024-01-01";
    expect(planMigration([merged], [a, corrected]).changes[0]?.action).toBe("candidate");
  });
  it("holds a corrected fingerprint row reached through an old batch alias instead of adding it twice", () => {
    const make = (value: string) =>
      groupContracts(
        [
          {
            row: toContractRow({
              owner_org: "fictional",
              reference_number: "fictional-batch",
              vendor_name: "Fictional Orbit",
              contract_value: value,
              instrument_type: "C",
              reporting_period: "2025-2026-Q1",
            }),
            match,
          },
        ],
        options,
      );
    const first = make("100");
    const plan = planMigration([], first.agreements, first.identities);
    const correction = make("200");
    const next = planMigration(
      first.agreements,
      correction.agreements,
      correction.identities,
      plan.aliases,
    );
    expect(next.replacements).toEqual([]);
    expect(next.changes.some((c) => c.action === "candidate")).toBe(true);
  });
  it("holds a newly reported reference sharing a number with an existing-only agreement", () => {
    const existing = grant("fictional-old-reference", "250");
    const incoming = grant("fictional-new-reference", "500");
    const plan = planMigration([existing], [incoming]);
    expect(plan.replacements).toEqual([]);
    expect(plan.cases).toHaveLength(1);
    expect(
      plan.changes.some((c) => c.action === "candidate" && c.newIds.includes(incoming.id)),
    ).toBe(true);
  });
  it("does not refresh a hand merge if a row's nonamount claims changed", () => {
    const a = grant("fictional-a", "250"),
      b = grant("fictional-b", "500");
    const merged = {
      ...a,
      evidence: [...a.evidence, ...b.evidence],
      disclosureRows: [...a.disclosureRows, ...b.disclosureRows],
    };
    const changed = structuredClone(b);
    changed.disclosureRows[0]!.endOnAsStated = "2027-01-01";
    expect(planMigration([merged], [a, changed]).changes[0]?.action).toBe("candidate");
  });
  it("requires human reconciliation when an existing ID changes legal parties", () => {
    const a = grant("fictional-a", "250"),
      b = structuredClone(a);
    b.parties[1]!.orgId = "org_fictional_subsidiary";
    const plan = planMigration([a], [b]);
    expect(plan.replacements).toEqual([]);
    expect(plan.changes[0]?.action).toBe("candidate");
  });
  it("refreshes an existing researched merge and aliases all former components without re-proposing it", () => {
    const a = grant("fictional-a", "250"),
      b = grant("fictional-b", "500");
    const merged = {
      ...a,
      evidence: [
        { ...a.evidence[0]!, locator: "ref_number=fictional-a;amendment_number=0" },
        { ...b.evidence[0]!, locator: "ref_number=fictional-b;amendment_number=0" },
      ],
      disclosureRows: [...a.disclosureRows, ...b.disclosureRows],
    };
    const plan = planMigration([merged], [a, b]);
    expect(plan.changes[0]?.action).toBe("existing_merge");
    expect(plan.replacements).toHaveLength(1);
    expect(plan.replacements[0]?.id).toBe(merged.id);
    expect(resolveAlias(b.id, plan.aliases)).toEqual([merged.id]);
    expect(
      planMigration(plan.replacements, [a, b], [], plan.aliases).changes.every(
        (c) => c.action === "unchanged",
      ),
    ).toBe(true);
  });
  it("maps every old batch-based ID to all split contracts", () => {
    const result = groupContracts(
      ["100", "200"].map((value) => ({
        row: toContractRow({
          owner_org: "fictional",
          reference_number: "fictional-batch",
          vendor_name: "Fictional Orbit",
          contract_value: value,
          instrument_type: "C",
          reporting_period: "2025-2026-Q1",
        }),
        match,
      })),
      options,
    );
    const oldId = result.identities[0]!.legacyIds[0]!;
    const old = {
      ...result.agreements[0]!,
      id: oldId,
      evidence: result.agreements.flatMap((a) => a.evidence),
      disclosureRows: result.agreements.flatMap((a) => a.disclosureRows),
    };
    const plan = planMigration([old], result.agreements, result.identities);
    expect(plan.changes[0]?.action).toBe("split");
    expect(resolveAlias(oldId, plan.aliases)).toEqual(result.agreements.map((a) => a.id).sort());
    expect(plan.aliases.find((a) => a.from === oldId)?.to).toHaveLength(2);
  });
  it("flags reviewed records without copying or altering their approval", () => {
    const current = grant("fictional-a", "100");
    // A sentinel input simulates the presence of an owner block; no review-writing API is used.
    const reviewed = {
      ...current,
      review: { by: "fictional owner", at: "2026-01-01", hash: "fictional sentinel" },
    };
    const changed = { ...current, title: "Fictional updated title" };
    const plan = planMigration([reviewed], [changed]);
    expect(plan.reviewedIds).toEqual([current.id]);
    expect(plan.changes[0]?.blocked).toBe(true);
    expect(plan.replacements).toEqual([]);
    expect(reviewed.review.hash).toBe("fictional sentinel");
  });
  it("rejects alias cycles and preserves one-to-many mappings", () => {
    expect(() =>
      resolveAlias("a", [
        { from: "a", to: ["b"], reason: "fictional" },
        { from: "b", to: ["a"], reason: "fictional" },
      ]),
    ).toThrow(/cycle/);
  });
  it("holds unresolved duplicate numbers and reports existing records missing from new output", () => {
    const a = grant("fictional-a", "250"),
      b = grant("fictional-b", "500");
    const plan = planMigration([], [a, b]);
    expect(plan.replacements).toEqual([]);
    expect(plan.cases).toHaveLength(1);
    expect(planMigration([a], []).changes[0]?.action).toBe("missing");
  });
});
