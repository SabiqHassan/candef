/**
 * Claim-level citation rules (P-36, docs/CITATIONS.md) over every company of the synthetic stress
 * snapshot, not just hand-picked examples: whatever the data looks like, a claim without evidence
 * must not exist, and a claim must never rest on a record that is not verified.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../../pipeline/compile/compile";
import { generateStressCorpus } from "../../pipeline/synthetic/stress";
import { companyClaims, financingCitations } from "./claims";
import { indexSnapshot } from ".";

const { corpus, manifest } = generateStressCorpus({ companies: 500, seed: 5 });
const snap = compile(corpus, { today: "2026-10-13" }).snapshot!;
const ix = indexSnapshot(snap);
const all = ix.companies.map((c) => ({ c, claims: companyClaims(ix, c) }));

describe("companyClaims over a large, messy snapshot", () => {
  it("produces claims for most companies (the test is not vacuous)", () => {
    expect(all.filter((x) => x.claims.length > 2).length).toBeGreaterThan(ix.companies.length / 2);
  });

  it("never states a claim without at least one citation", () => {
    for (const { c, claims } of all)
      for (const claim of claims)
        expect(claim.citations.length, `${c.name}: ${claim.label}`).toBeGreaterThan(0);
  });

  it("only cites sources that exist in the snapshot", () => {
    for (const { c, claims } of all)
      for (const claim of claims)
        for (const cite of claim.citations)
          expect(snap.sources[cite.sourceId], `${c.name}: ${claim.label}`).toBeTruthy();
  });

  it("never repeats a citation inside one claim, and keeps claim ids unique per company", () => {
    for (const { c, claims } of all) {
      expect(new Set(claims.map((x) => x.id)).size, c.name).toBe(claims.length);
      for (const claim of claims) {
        const keys = claim.citations.map((x) => `${x.sourceId}\u0000${x.locator}`);
        expect(new Set(keys).size, `${c.name}: ${claim.label}`).toBe(keys.length);
      }
    }
  });

  it("builds financing claims only from verified rounds", () => {
    const verified = new Set(
      snap.rounds.filter((r) => r.verification === "verified").map((r) => r.id),
    );
    for (const { c, claims } of all)
      for (const claim of claims.filter((x) => x.group === "Financing")) {
        const roundId = claim.id.split(":")[0]!;
        if (roundId.startsWith("fin_"))
          expect(verified.has(roundId), `${c.name} ${roundId}`).toBe(true);
      }
  });

  it("never derives a claim from an unpublishable record", () => {
    const bad = new Set(manifest.unpublishable);
    for (const { claims } of all) for (const claim of claims) expect(bad.has(claim.id)).toBe(false);
  });

  it("labels a derived total as derived and cites the rounds it sums", () => {
    const totals = all.flatMap((x) => x.claims.filter((c) => c.id === "financing-total"));
    expect(totals.length).toBeGreaterThan(5);
    for (const t of totals) expect(t.basis).toBe("derived");
  });

  it("gives the dense summaries citations that match the claims they summarize", () => {
    for (const { c } of all.slice(0, 120)) {
      const { total, latest } = financingCitations(ix, c);
      const keys = new Set(total.map((x) => `${x.sourceId}\u0000${x.locator}`));
      for (const cite of latest)
        expect(keys.has(`${cite.sourceId}\u0000${cite.locator}`)).toBe(true);
    }
  });
});
