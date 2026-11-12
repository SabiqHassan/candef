import { describe, expect, it } from "vitest";
import { generateDemoCorpus } from "../demo/generate";
import { citationCoverage, formatCoverage } from "./coverage";

describe("citation coverage of the research corpus (P-36)", () => {
  it("counts every claim kind and finds no gaps in a clean corpus", () => {
    const c = citationCoverage(generateDemoCorpus({ companies: 20 }));
    expect(c.problems).toEqual([]);
    expect(c.cited).toBe(c.total);
    const kinds = c.kinds.map((k) => k.kind);
    for (const k of ["fact", "round", "round disclosure", "round participant", "agreement"])
      expect(kinds).toContain(k);
    expect(formatCoverage(c)).toMatch(/claims have a usable citation \(100\.0%\)/);
  });

  it("reports a claim with no citation, an unregistered source, a generic locator and related-link evidence", () => {
    const corpus = generateDemoCorpus({ companies: 20 });
    const [a, b, c, d] = corpus.assertions;
    a!.evidence = [];
    b!.evidence = [{ sourceId: "src_missing", locator: "page 2", locatorQuality: "body" }];
    c!.evidence = [{ ...c!.evidence[0]!, locator: "n/a" }];
    d!.evidence = [{ ...d!.evidence[0]!, locatorQuality: "related_link" }];
    const problems = citationCoverage(corpus).problems.map((p) => p.problem);
    expect(problems).toContain("no citation");
    expect(problems.join("|")).toMatch(/unregistered source src_missing/);
    expect(problems.join("|")).toMatch(/does not say where the claim is/);
    expect(problems).toContain("only related-link evidence");
  });

  it("reports rows without their own citation separately, not as uncited", () => {
    const corpus = generateDemoCorpus({ companies: 20 });
    const g = corpus.agreements.find((x) => x.disclosureRows.length > 1)!;
    g.evidence = [g.evidence[0]!];
    const c = citationCoverage(corpus);
    expect(c.problems).toEqual([]);
    expect(c.kinds.some((k) => k.kind === "agreement row (record-level citation)")).toBe(true);
  });
});
