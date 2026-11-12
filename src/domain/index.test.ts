import { describe, expect, it } from "vitest";
import { compareNames } from ".";

describe("compareNames", () => {
  it("orders numbers naturally and ignores case and accents", () => {
    expect(["Unit 10", "unit 2", "Unit 1"].sort(compareNames)).toEqual([
      "Unit 1",
      "unit 2",
      "Unit 10",
    ]);
    expect(compareNames("Éclair Systems", "eclair systems")).toBe(0);
    expect(["Zeta", "alpha", "Beta"].sort(compareNames)).toEqual(["alpha", "Beta", "Zeta"]);
  });
});
