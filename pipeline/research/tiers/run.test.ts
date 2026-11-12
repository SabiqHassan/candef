import { describe, expect, it } from "vitest";
import { corpus, ORG, DEPT } from "./fixture.test-helpers";
import { auditSample } from "./sample";
import { batchHash, type TierRecord } from "./rules";
import { scopeRecords } from "./run";

const rec = (id: string, orgId: string): TierRecord => ({
  id,
  kind: "assertion",
  orgId,
  hash: `h_${id}`,
  dependsOn: [],
  values: [],
  tier: 2,
  status: "pass",
  route: "",
  rules: [],
  sources: [],
});

describe("scoping a tiers batch to some companies", () => {
  const c = corpus();
  const records = [rec("a1", ORG), rec("a2", ORG), rec("d1", DEPT)];

  it("keeps all records when there is no scope", () => {
    expect(scopeRecords(records, c, undefined)).toHaveLength(3);
  });

  it("keeps only the chosen organizations, so the batch and its audit sample exclude the rest", () => {
    const scoped = scopeRecords(records, c, ["fict-alpha"]);
    expect(scoped.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(batchHash(scoped)).not.toBe(batchHash(records));
    for (const id of auditSample(scoped, batchHash(scoped))) expect(["a1", "a2"]).toContain(id);
  });

  it("refuses an unknown organization instead of silently auditing nothing", () => {
    expect(() => scopeRecords(records, c, ["no-such-org"])).toThrow(/unknown organization/);
  });
});
