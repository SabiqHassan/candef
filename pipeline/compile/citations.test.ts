import { describe, expect, it } from "vitest";
import { generateDemoCorpus } from "../demo/generate";
import { auditCitations, isSpecificLocator, toCitations } from "./citations";
import { compile } from "./compile";
import { reviewHashFor } from "./hash";

const TODAY = "2026-10-13";

describe("citations (P-36)", () => {
  it("turns evidence into citations and drops exact duplicates", () => {
    expect(
      toCitations([
        { sourceId: "s1", locator: "table 2, row 4", locatorQuality: "body" },
        { sourceId: "s1", locator: "table 2, row 4", locatorQuality: "body" },
        { sourceId: "s1", locator: "headline", locatorQuality: "headline" },
      ]),
    ).toEqual([
      { sourceId: "s1", locator: "table 2, row 4", quality: "body" },
      { sourceId: "s1", locator: "headline", quality: "headline" },
    ]);
  });

  it("accepts specific locators and rejects ones that name nothing", () => {
    for (const ok of ["p. 4", "section 2.1", "reference_number=C-2024-01", "footer"]) {
      expect(isSpecificLocator(ok), ok).toBe(true);
    }
    for (const bad of ["", " ", "n/a", "N/A", "page", "website", "source", "-", "unknown", "x"]) {
      expect(isSpecificLocator(bad), bad).toBe(false);
    }
  });

  it("passes the demo corpus and reports nothing", () => {
    const result = compile(generateDemoCorpus({ companies: 20 }), { today: TODAY });
    expect(result.failures.filter((f) => f.gate === "citation-coverage")).toEqual([]);
    expect(result.ok).toBe(true);
    const snap = result.snapshot!;
    expect(auditCitations(snap)).toEqual([]);
    // Every published round, disclosure, participant, agreement and acquisition carries citations.
    const verified = snap.rounds.filter((r) => r.verification === "verified");
    expect(verified.length).toBeGreaterThan(0);
    expect(verified.every((r) => r.citations.length > 0)).toBe(true);
    expect(verified.flatMap((r) => r.disclosures).every((d) => d.citations.length > 0)).toBe(true);
    expect(verified.flatMap((r) => r.participants).every((p) => p.citations.length > 0)).toBe(true);
    expect(snap.agreements.every((g) => g.citations.length > 0)).toBe(true);
    expect(snap.acquisitions.every((q) => q.citations.length > 0)).toBe(true);
  });

  it("flags a claim with no citation, an unknown source, a generic locator and related-link-only evidence", () => {
    const snap = compile(generateDemoCorpus({ companies: 20 }), { today: TODAY }).snapshot!;
    const round = structuredClone(snap.rounds.find((r) => r.verification === "verified")!);
    const sourceId = Object.keys(snap.sources)[0]!;
    const base = {
      assertions: {},
      agreements: [],
      acquisitions: [],
      sources: snap.sources,
    };
    const run = (r: typeof round) => auditCitations({ ...base, rounds: [r] }).map((p) => p.problem);

    const none = structuredClone(round);
    none.citations = [];
    expect(run(none)).toContain("no citation");

    const unknown = structuredClone(round);
    unknown.citations = [{ sourceId: "src_nope", locator: "p. 1", quality: "body" }];
    expect(run(unknown).join("|")).toMatch(/unknown source src_nope/);

    const generic = structuredClone(round);
    generic.citations = [{ sourceId, locator: "n/a", quality: "body" }];
    expect(run(generic).join("|")).toMatch(/does not say where/);

    const related = structuredClone(round);
    related.citations = [{ sourceId, locator: "footer link", quality: "related_link" }];
    expect(run(related).join("|")).toMatch(/related-link evidence/);

    const noParticipantCitation = structuredClone(round);
    if (noParticipantCitation.participants[0]) {
      noParticipantCitation.participants[0].citations = [];
      const claims = auditCitations({ ...base, rounds: [noParticipantCitation] });
      expect(claims.some((p) => /participant/.test(p.claim) && p.problem === "no citation")).toBe(
        true,
      );
    }
  });

  it("fails the build, naming the claim, when a published claim has a generic locator", () => {
    const corpus = generateDemoCorpus({ companies: 20 });
    const firstBuild = compile(corpus, { today: TODAY }).snapshot!;
    const shown = firstBuild.rounds.find(
      (r) => r.verification === "verified" && r.disclosures.length,
    )!;
    const published = corpus.rounds.find((r) => r.id === shown.id)!;
    const disclosure = published.disclosures.find((d) => d.id === shown.disclosures[0]!.id)!;
    disclosure.evidence[0]!.locator = "n/a";
    // Re-sign the edited records the way an approval would, so they are still published.
    disclosure.review = { ...disclosure.review!, hash: reviewHashFor("disclosure", disclosure) };
    published.review = { ...published.review!, hash: reviewHashFor("round", published) };
    const result = compile(corpus, { today: TODAY });
    expect(result.ok).toBe(false);
    const gate = result.failures.find((f) => f.gate === "citation-coverage")!;
    expect(gate.ids?.some((id) => id.includes(published.id) && /does not say where/.test(id))).toBe(
      true,
    );
  });
});
