import { describe, expect, it } from "vitest";
import { businessNumberRoot, isConsortiumName, nameKey, nameKeys, postalFsa } from "./names";

describe("name normalization (exact-match keys)", () => {
  it("removes legal forms, punctuation, accents and case", () => {
    expect(nameKey("Acme Robotics Inc.")).toBe("ACME ROBOTICS");
    expect(nameKey("ACME ROBOTICS INC")).toBe("ACME ROBOTICS");
    expect(nameKey("Acme Robotics Ltée")).toBe("ACME ROBOTICS");
    expect(nameKey("Acme Robotics Corporation Ltd.")).toBe("ACME ROBOTICS");
    expect(nameKey("Systèmes Énergie Québec")).toBe("SYSTEMES ENERGIE QUEBEC");
    expect(nameKey("The Acme Group")).toBe("ACME GROUP");
  });
  it("unifies & and AND but keeps the remaining words", () => {
    expect(nameKey("Smith & Jones Ltd")).toBe(nameKey("Smith and Jones Limited"));
  });
  it("never reduces a name to nothing and never strips a suffix-only name", () => {
    expect(nameKey("Inc.")).toBe("INC");
    expect(nameKey("  ")).toBe("");
  });
  it("does not merge different companies that share a suffix", () => {
    expect(nameKey("Mediphage Bioceuticals, Inc.")).not.toBe(nameKey("Dr. Clean Inc."));
  });
  it("splits bilingual English|French legal names into variants", () => {
    expect(nameKeys("Acme Robotics Inc.|Robotique Acme Inc.")).toEqual([
      "ACME ROBOTICS",
      "ROBOTIQUE ACME",
    ]);
    expect(nameKeys("ACME INC|Acme Inc.")).toEqual(["ACME"]);
    // A parenthetical trade name adds a variant without the parenthetical (never replaces the original).
    expect(nameKeys("Acme Robotics Inc. (ARI)")).toEqual([
      "ACME ROBOTICS INC ARI",
      "ACME ROBOTICS",
    ]);
    expect(nameKeys("Acme (Canada) Ltd.")).toEqual(["ACME CANADA", "ACME"]);
  });
});

describe("consortium detection", () => {
  it("flags joint ventures and multi-party names", () => {
    expect(
      isConsortiumName("Adirondack in joint venture with Amita, ARTemp and the AIM Group Inc."),
    ).toBe(true);
    expect(isConsortiumName("Alpha Inc. and Beta Ltd.")).toBe(true);
    expect(isConsortiumName("Alpha-Beta JV")).toBe(true);
    expect(isConsortiumName("Coentreprise Gamma Delta")).toBe(true);
  });
  it("does not flag a single company whose name contains 'and'", () => {
    expect(isConsortiumName("Smith and Jones Ltd.")).toBe(false);
    expect(isConsortiumName("Research and Development Co.")).toBe(false);
  });
});

describe("identifiers", () => {
  it("extracts the 9-digit business-number root", () => {
    expect(businessNumberRoot("123456789RC0001")).toBe("123456789");
    expect(businessNumberRoot("123 456 789")).toBe("123456789");
    expect(businessNumberRoot("12345")).toBeNull();
    expect(businessNumberRoot(null)).toBeNull();
  });
  it("treats placeholder business numbers as absent", () => {
    for (const filler of ["0", "N/A", "NONE", "none", "1000037535", "000000000", "999999999RC0001"])
      expect(businessNumberRoot(filler), filler).toBeNull();
    expect(businessNumberRoot("000000001")).toBe("000000001");
  });
  it("extracts a postal forward sortation area", () => {
    expect(postalFsa("k1a 0b1")).toBe("K1A");
    expect(postalFsa("K1A")).toBe("K1A");
    expect(postalFsa("12345")).toBeNull();
  });
});
