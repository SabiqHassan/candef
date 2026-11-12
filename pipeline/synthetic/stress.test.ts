import { describe, expect, it } from "vitest";
import { compile } from "../compile/compile";
import { generateStressCorpus } from "./stress";

const TODAY = "2026-10-13";

describe("synthetic stress corpus", () => {
  const { corpus, manifest } = generateStressCorpus({ companies: 400, seed: 7 });
  const result = compile(corpus, { today: TODAY });
  const snap = result.snapshot!;

  it("is fictional, flagged and compiles", () => {
    expect(result.ok).toBe(true);
    expect(corpus.isDemo).toBe(true);
    expect(snap.meta.isDemo).toBe(true);
    expect(corpus.sources.every((s) => s.url.startsWith("https://example.invalid/"))).toBe(true);
    expect(corpus.organizations.every((o) => o.isDemo)).toBe(true);
  });

  it("is reproducible from its seed", () => {
    const again = generateStressCorpus({ companies: 400, seed: 7 });
    expect(again.manifest).toEqual(manifest);
    expect(again.corpus.assertions.length).toBe(corpus.assertions.length);
  });

  it("never publishes a proposed or rejected record, except a proposed round as a bare placeholder", () => {
    expect(manifest.unpublishable.length).toBeGreaterThan(10);
    const published = new Set([
      ...Object.keys(snap.assertions),
      ...snap.agreements.map((g) => g.id),
    ]);
    expect(manifest.unpublishable.filter((id) => published.has(id))).toEqual([]);
    const statusOf = new Map(corpus.rounds.map((r) => [r.id, r.verification]));
    for (const r of snap.rounds) {
      const status = statusOf.get(r.id);
      expect(["verified", "proposed"]).toContain(status);
      if (status === "proposed")
        expect(r).toMatchObject({ label: null, participants: [], disclosures: [], sourceIds: [] });
    }
  });

  it("leaks nothing of an unpublishable record anywhere in the serialized snapshot", () => {
    const text = JSON.stringify(snap);
    // Proposed rounds are published as bare placeholders (their id only), by design.
    const placeholders = new Set(
      corpus.rounds.filter((r) => r.verification === "proposed").map((r) => r.id),
    );
    expect(manifest.leakMarkers.length).toBeGreaterThan(3);
    expect(manifest.leakMarkers.filter((m) => text.includes(m))).toEqual([]);
    expect(
      manifest.unpublishable.filter((id) => !placeholders.has(id) && text.includes(id)),
    ).toEqual([]);
    // The titles of sources cited only by unpublishable records are not published either.
    const citedByPublished = new Set(
      Object.values(snap.assertions).flatMap((a) => a.evidence.map((e) => e.sourceId)),
    );
    const orphanTitles = new Set(manifest.leakMarkers);
    for (const s of corpus.sources)
      if (orphanTitles.has(s.title)) expect(citedByPublished.has(s.id)).toBe(false);
  });

  it("the scanner would notice a leak (mutation check)", () => {
    const leaked = structuredClone(snap);
    leaked.organizations[0]!.description.value = "Proposedville was here";
    const text = JSON.stringify(leaked);
    expect(manifest.leakMarkers.some((m) => text.includes(m))).toBe(true);
  });

  it("keeps a renamed company's earlier legal name as history", () => {
    expect(manifest.renamed.length).toBeGreaterThan(0);
    const org = snap.organizations.find((o) => o.id === manifest.renamed[0])!;
    expect(org.legalName.history?.length).toBeGreaterThan(0);
  });

  it("keeps near-identical names as separate companies", () => {
    expect(manifest.twins.length).toBeGreaterThan(0);
    const byId = new Map(snap.organizations.map((o) => [o.id, o]));
    const published = manifest.twins.filter(([a, b]) => byId.has(a) && byId.has(b));
    // A twin publishes only when its own evidence does; at least one pair must, as two companies.
    expect(published.length).toBeGreaterThan(0);
    for (const [a, b] of published) {
      expect(byId.get(a)!.slug).not.toBe(byId.get(b)!.slug);
      expect(byId.get(a)!.name).not.toBe(byId.get(b)!.name);
    }
    expect(result.failures.filter((f) => f.gate.includes("duplicate"))).toEqual([]);
  });

  it("shows conflicting approved headquarters as disputed, never as one value", () => {
    expect(manifest.disputedHq.length).toBeGreaterThan(0);
    for (const id of manifest.disputedHq) {
      const org = snap.organizations.find((o) => o.id === id);
      if (org) expect(org.hq.state).toBe("disputed");
    }
  });

  it("lists other transfer payments without drawing them", () => {
    const drawn = new Set(
      [...snap.graph.lenses.contracts.edges, ...snap.graph.lenses.contracts.bundles].flatMap(
        (e) => e.recordIds,
      ),
    );
    expect(manifest.otherTransfers.length).toBeGreaterThan(0);
    for (const id of manifest.otherTransfers) {
      expect(snap.agreements.some((g) => g.id === id)).toBe(true);
      expect(drawn.has(id)).toBe(false);
    }
  });

  it("contains hub organizations with very many relationships", () => {
    const hubRounds = snap.rounds.filter((r) =>
      r.participants.some((p) => p.investorId === manifest.hubInvestor),
    );
    expect(hubRounds.length).toBeGreaterThan(80);
    const hubAgreements = snap.agreements.filter(
      (g) => g.counterpartyId === manifest.hubDepartment,
    );
    expect(hubAgreements.length).toBeGreaterThan(80);
  });

  it("cannot be compiled as real research: its fixture approvals are refused", () => {
    const real = compile({ ...corpus, isDemo: false }, { today: TODAY });
    expect(real.ok).toBe(false);
  });
});
