import { describe, expect, it } from "vitest";
import type { TierRecord } from "./rules";
import { auditSample } from "./sample";

const rec = (
  id: string,
  tier: 1 | 2 | 3,
  orgId: string,
  status: TierRecord["status"] = "pass",
): TierRecord => ({
  id,
  kind: tier === 1 ? "agreement" : "assertion",
  orgId,
  hash: id,
  tier,
  status,
  route: "",
  rules: [],
  dependsOn: [],
  sources: [],
  values: [],
});

const many = (tier: 1 | 2, n: number, orgs: number) =>
  Array.from({ length: n }, (_, i) => rec(`t${tier}_${i}`, tier, `org_${i % orgs}`));

describe("audit sample", () => {
  it("is reproducible from the batch hash and changes with it", () => {
    const records = [...many(1, 50, 5), ...many(2, 50, 5)];
    expect(auditSample(records, "batch-a")).toEqual(auditSample(records, "batch-a"));
    expect(auditSample(records, "batch-a")).not.toEqual(auditSample(records, "batch-b"));
  });
  it("draws the smaller of 30 and the number of passes, at least 10 per tier", () => {
    const records = [...many(1, 200, 4), ...many(2, 12, 3), rec("x", 3, "org_0", "judgement")];
    const s = auditSample(records, "seed");
    expect(s).toHaveLength(30);
    expect(s.filter((id) => id.startsWith("t2_")).length).toBeGreaterThanOrEqual(10);
    expect(s.filter((id) => id.startsWith("t1_")).length).toBeGreaterThanOrEqual(10);
    expect(s).not.toContain("x");
    expect(auditSample(many(2, 7, 2), "seed")).toHaveLength(7);
  });
  it("spreads draws across companies and skips exceptions", () => {
    const records = [...many(2, 40, 10), rec("bad", 2, "org_1", "exception")];
    const s = auditSample(records, "seed", 10, 10);
    const orgs = new Set(s.map((id) => records.find((r) => r.id === id)!.orgId));
    expect(orgs.size).toBe(10);
    expect(s).not.toContain("bad");
  });
  it("includes conditional tier 1 records (they are applied with the batch)", () => {
    const records = [rec("c1", 1, "org_a", "conditional")];
    expect(auditSample(records, "seed")).toEqual(["c1"]);
  });
});
