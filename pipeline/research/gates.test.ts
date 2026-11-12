import { describe, expect, it } from "vitest";
import type { Corpus } from "../../src/domain/schema/corpus";
import { generateDemoCorpus } from "../demo/generate";
import { researchBuildGates } from "./gates";

const empty = (): Corpus => ({
  schemaVersion: "0.3",
  isDemo: false,
  taxonomy: [],
  sources: [],
  organizations: [],
  assertions: [],
  rounds: [],
  agreements: [],
  acquisitions: [],
  programs: [],
  research: [],
});

describe("research build gates (no fixture data in a real build)", () => {
  it("passes an empty real corpus", () => {
    expect(researchBuildGates(empty())).toEqual([]);
  });
  it("fails the demo corpus on every fixture marker", () => {
    const messages = researchBuildGates(generateDemoCorpus({ companies: 30 })).map(
      (f) => f.message,
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        "Corpus is marked demo",
        "Organizations marked demo",
        "Sources pointing at fixture URLs",
        "Records carrying a fixture review",
      ]),
    );
  });
  it("catches a single fixture approval smuggled into a real corpus", () => {
    const demo = generateDemoCorpus({ companies: 30 });
    const c = empty();
    c.assertions.push({ ...demo.assertions.find((a) => a.review)!, epistemic: "sourced_fact" });
    const failures = researchBuildGates(c);
    expect(failures.map((f) => f.message)).toEqual(["Records carrying a fixture review"]);
  });
});
