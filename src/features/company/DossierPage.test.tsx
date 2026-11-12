import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Routes, Route } from "react-router";
import { generateDemoCorpus } from "../../../pipeline/demo/generate";
import { sealDemoCorpus } from "../../../pipeline/compile/hash";
import { compile } from "../../../pipeline/compile/compile";
import { indexSnapshot, type SnapshotIndex } from "../../domain";
import { DossierPage } from "./DossierPage";
import { CompanyCard } from "../explorer/CompanyCard";
import type { Corpus } from "../../domain/schema/corpus";
import { foreignFixture } from "../../../pipeline/compile/foreign.test-helpers";
import { MethodologyPage } from "../methodology/MethodologyPage";

let index: SnapshotIndex;
let fixtureCorpus: Corpus;
vi.mock("../../app/DataContext", () => ({ useData: () => index }));

beforeEach(() => {
  const corpus = generateDemoCorpus({ companies: 5 });
  for (const round of corpus.rounds) round.proceeds = "unknown";
  fixtureCorpus = corpus;
  const result = compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" });
  if (!result.snapshot) throw new Error(JSON.stringify(result.failures));
  index = indexSnapshot(result.snapshot);
});

describe("company financing summaries", () => {
  it("does not attribute foreign other-transfer agreements to Treasury Board", () => {
    const { corpus, agreement, companyId } = foreignFixture();
    agreement.family = "other_transfer";
    agreement.type = "other_transfer_payment";
    const result = compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" });
    expect(result.failures).toEqual([]);
    index = indexSnapshot(result.snapshot!);
    const org = index.org.get(companyId)!;
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/company/${org.slug}`]}>
        <Routes>
          <Route path="/company/:slug" element={<DossierPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(
      html.slice(html.indexOf('id="government"'), html.indexOf('id="corporate"')),
    ).not.toContain("Treasury Board");
  });
  it("keeps an excluded predecessor contextual and displays its actual eligibility", () => {
    const [predecessor, successor] = index.companies;
    const eligibility = fixtureCorpus.assertions.find(
      (a) => a.subjectId === predecessor!.id && a.predicate === "eligibility",
    )!;
    eligibility.value = { ...(eligibility.value as object), decision: "excluded" };
    fixtureCorpus.assertions.push({
      ...eligibility,
      id: "asr_fictional_excluded_predecessor",
      predicate: "predecessor_of",
      value: { orgId: successor!.id, event: "reorganization", date: "2014" },
      epistemic: "sourced_fact",
      verification: "verified",
      review: null,
    });
    const result = compile(sealDemoCorpus(fixtureCorpus, "2026-10-16"), { today: "2026-10-16" });
    expect(result.failures).toEqual([]);
    index = indexSnapshot(result.snapshot!);
    expect(index.org.get(predecessor!.id)?.scope).toBe("contextual");
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/company/${predecessor!.slug}`]}>
        <Routes>
          <Route path="/company/:slug" element={<DossierPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain("Excluded.");
  });
  it("explains weapons scope and keeps a weapons-primary company eligible", () => {
    const company = index.companies[0]!;
    const eligibility = fixtureCorpus.assertions.find(
      (a) => a.subjectId === company.id && a.predicate === "eligibility",
    )!;
    eligibility.value = {
      ...(eligibility.value as object),
      exclusion_check: {
        weapons_primary: true,
        notes: "Fictional publicly documented weapons business",
      },
    };
    const result = compile(sealDemoCorpus(fixtureCorpus, "2026-10-16"), { today: "2026-10-16" });
    expect(result.snapshot!.organizations.find((o) => o.id === company.id)?.scope).toBe("universe");
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MethodologyPage />
      </MemoryRouter>,
    );
    expect(html).toContain("Weapons manufacturers are in scope");
  });
  it("labels documented foreign government agreements and filters by jurisdiction", () => {
    const { corpus, companyId } = foreignFixture();
    const result = compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" });
    expect(result.failures).toEqual([]);
    index = indexSnapshot(result.snapshot!);
    const org = index.org.get(companyId)!;
    const render = (scope: string) =>
      renderToStaticMarkup(
        <MemoryRouter initialEntries={[`/company/${org.slug}?government=${scope}`]}>
          <Routes>
            <Route path="/company/:slug" element={<DossierPage />} />
          </Routes>
        </MemoryRouter>,
      );
    const html = render("foreign");
    expect(html).toContain("Foreign government");
    expect(html).toContain("(US)");
    expect(html).toContain("US$123.5K");
    expect(html.slice(html.indexOf("(US)"), html.indexOf("(US)") + 800)).toContain(
      "data-source-chip",
    );
    expect(render("canadian")).toContain("No agreements match this jurisdiction");
  });
  it("lists a government row locator as labelled fields in the Sources section", () => {
    const { corpus, agreement, companyId } = foreignFixture();
    const sha = "c".repeat(64);
    agreement.evidence = [
      {
        sourceId: "src_fictional_foreign",
        locator: `ref_number=999-2025-2026-Q3-0001;amendment_number=0;agreement_number=0001;recipient_legal_name=FICTIONAL%20ASTER%20LTD.;owner_org=fict-dept;locator_version=1;row_sha256=${sha}`,
        locatorQuality: "metadata",
      },
    ];
    const result = compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" });
    expect(result.failures).toEqual([]);
    index = indexSnapshot(result.snapshot!);
    const org = index.org.get(companyId)!;
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/company/${org.slug}`]}>
        <Routes>
          <Route path="/company/:slug" element={<DossierPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const sources = html.slice(html.indexOf('id="sources"'));
    expect(sources).toContain('data-row-locator="grant"');
    expect(sources).toContain("FICTIONAL ASTER LTD.");
    expect(sources).toContain("2025-2026, Q3");
    expect(sources).toContain(`<summary>Row fingerprint</summary><code>${sha}</code>`);
    expect(sources).not.toContain("recipient_legal_name=");
  });
  it("hides jurisdiction labels and the filter while no counterparty has a cited country", () => {
    const { corpus, companyId } = foreignFixture();
    corpus.assertions = corpus.assertions.filter((a) => a.id !== "asr_fictional_foreign_country");
    const result = compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" });
    expect(result.failures).toEqual([]);
    index = indexSnapshot(result.snapshot!);
    const org = index.org.get(companyId)!;
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/company/${org.slug}?government=foreign`]}>
        <Routes>
          <Route path="/company/:slug" element={<DossierPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain("Fictional orbital research award");
    expect(html).not.toContain("Government jurisdiction not established");
    expect(html).not.toContain("government-jurisdiction");
  });
  it("renders corporate lineage and its citations in both company dossiers", () => {
    const [predecessor, successor] = index.companies;
    const base = fixtureCorpus.assertions.find((a) => a.subjectId === predecessor!.id)!;
    fixtureCorpus.assertions.push({
      ...base,
      id: "asr_fictional_history",
      subjectId: predecessor!.id,
      predicate: "predecessor_of",
      value: { orgId: successor!.id, event: "amalgamation", date: "2014" },
      verification: "verified",
      review: null,
    });
    const result = compile(sealDemoCorpus(fixtureCorpus, "2026-10-16"), { today: "2026-10-16" });
    expect(result.failures).toEqual([]);
    index = indexSnapshot(result.snapshot!);
    for (const [company, direction, name] of [
      [predecessor!, "Predecessor of", successor!.name],
      [successor!, "Successor of", predecessor!.name],
    ] as const) {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={[`/company/${company.slug}`]}>
          <Routes>
            <Route path="/company/:slug" element={<DossierPage />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(html).toContain(direction);
      expect(html).toContain(name);
      expect(html).toContain("(amalgamation, 2014)");
      expect(html.slice(html.indexOf(direction), html.indexOf(direction) + 800)).toContain(
        "data-source-chip",
      );
    }
  });
  it("renders stated but unclassified amounts with their citations on the card and dossier", () => {
    const org = index.snap.organizations.find(
      (o) => o.scope === "universe" && (o.financing?.roundsWithStatedAmount ?? 0) > 0,
    )!;
    const dossier = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/company/${org.slug}`]}>
        <Routes>
          <Route path="/company/:slug" element={<DossierPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const card = renderToStaticMarkup(
      <MemoryRouter>
        <CompanyCard
          org={org}
          lens="capital"
          onClose={() => {}}
          onSelect={() => {}}
          onFocus={() => {}}
        />
      </MemoryRouter>,
    );
    for (const html of [dossier, card]) {
      expect(html).toContain("No total");
      expect(html).toContain("verified rounds state an amount");
      expect(html).not.toContain("Undisclosed disclosed");
      const summary = html.slice(html.indexOf("No total"), html.indexOf("No total") + 1500);
      expect(summary).toContain("data-source-chip");
    }
  });
});
