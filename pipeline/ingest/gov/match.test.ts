import { describe, expect, it } from "vitest";
import { assertMagnitude, assertNegativeControl, buildIndex, matchRecipient } from "./match";

const entity = {
  orgId: "org_fictional_alpha",
  names: ["Fictional Alpha Bio Inc.", "Fictional Biologie Alpha Ltée"],
  businessNumbers: ["123456789RC0001"],
  postalFsas: ["Z1Z"],
};
const index = buildIndex([entity]);
const match = (
  names: string[],
  businessNumber: string | null = null,
  postal: string | null = null,
) => matchRecipient({ names, businessNumber, postal }, index);
describe("exact recipient matching", () => {
  it("avoids the Inc. trap and requires a second identifier", () => {
    expect(match(["Fictional Beta Clean Inc."]).status).toBe("no_match");
    expect(match(entity.names)).toMatchObject({ status: "ambiguous", method: "name_only" });
  });
  it("confirms BN roots and postal FSAs", () => {
    expect(match(entity.names, "123456789RP9999")).toMatchObject({
      status: "confirmed",
      method: "name+bn",
    });
    expect(match(entity.names, null, "z1z 9z9")).toMatchObject({
      status: "confirmed",
      method: "name+postal",
    });
  });
  it("prioritizes a conflicting BN over matching postal", () => {
    expect(match(entity.names, "987654321", "Z1Z")).toMatchObject({
      status: "ambiguous",
      method: "identifier_conflict",
    });
  });
  it("never resolves shared names using identifiers", () => {
    const shared = buildIndex([entity, { ...entity, orgId: "org_fictional_other" }]);
    expect(
      matchRecipient({ names: entity.names, businessNumber: "123456789", postal: "Z1Z" }, shared),
    ).toMatchObject({ status: "ambiguous", method: "multiple_candidates", orgId: null });
  });
  it("matches bilingual names exactly", () => {
    expect(
      match(["Fictional Unlisted Inc.|Fictional Biologie Alpha Ltée"], "123456789").status,
    ).toBe("confirmed");
  });
  it("blocks consortium names even if another alias matches", () => {
    expect(
      match(
        ["Fictional Alpha in joint venture with Fictional Beta Inc.", ...entity.names],
        "123456789",
      ).status,
    ).toBe("consortium");
  });
  it("runs the negative control and catches a broken matcher", () => {
    expect(() => assertNegativeControl(index)).not.toThrow();
    expect(() =>
      assertNegativeControl(index, () => ({
        status: "confirmed",
        orgId: entity.orgId,
        candidates: [entity.orgId],
        method: "broken",
      })),
    ).toThrow(/negative control/i);
  });
  it("counts ambiguous candidates in the magnitude gate", () => {
    const result = match(entity.names);
    expect(() => assertMagnitude([result, result], 2, 1)).toThrow(/magnitude/i);
    expect(() =>
      assertMagnitude(
        Array.from({ length: 51 }, () => result),
        100,
      ),
    ).toThrow(/magnitude/i);
    expect(() =>
      assertMagnitude(
        [{ ...result, orgId: null, candidates: [entity.orgId, "org_fictional_other"] }],
        1,
        0,
      ),
    ).toThrow(/magnitude/i);
  });
});
