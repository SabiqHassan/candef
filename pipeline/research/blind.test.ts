import { describe, expect, it } from "vitest";
import type { Corpus } from "../../src/domain/schema/corpus";
import { generateDemoCorpus } from "../demo/generate";
import {
  type BlindCard,
  type ResearcherPackage as Pkg,
  buildInventory,
  buildWorksheet,
  digitsKey,
  leakCheck,
  amountsInText,
  intakePackage,
  originOf,
  ResearcherPackage,
  sigKey,
  simulateApproved,
} from "./blind";
import { BLIND_FIELDS, SNAPSHOT_FIELD_MAP } from "./blindFields";

const TODAY = "2026-10-14";

/** A fictional corpus shaped like real research: every record proposed, no review blocks. */
function proposedCorpus(): Corpus {
  const c = generateDemoCorpus({ companies: 40, seed: 7 });
  const unreview = <T extends { verification: string; review: unknown }>(r: T): T => ({
    ...r,
    verification: r.verification === "verified" ? "proposed" : r.verification,
    review: null,
  });
  return {
    ...c,
    assertions: c.assertions.map(unreview),
    rounds: c.rounds.map((r) =>
      unreview({
        ...r,
        disclosures: r.disclosures.map(unreview),
        participations: r.participations.map(unreview),
      }),
    ),
    agreements: c.agreements.map(unreview),
    acquisitions: c.acquisitions.map(unreview),
  };
}

const corpus = proposedCorpus();
const withRounds = corpus.organizations.find(
  (o) => o.kind === "company" && corpus.rounds.filter((r) => r.companyId === o.id).length >= 2,
)!;
const withAgreements = corpus.organizations.find(
  (o) =>
    o.kind === "company" &&
    o.id !== withRounds.id &&
    corpus.agreements.some((g) => g.parties.some((p) => p.orgId === o.id)),
)!;
const cards: BlindCard[] = [
  {
    card: "C01",
    name: withRounds.name,
    website: "https://example.invalid/a",
    orgSlugs: [withRounds.slug],
  },
  {
    card: "C02",
    name: withAgreements.name,
    website: "https://example.invalid/b",
    orgSlugs: [withAgreements.slug],
  },
];

describe("blind verification inventory", () => {
  const before = JSON.stringify(corpus);
  const inv = buildInventory(corpus, cards, TODAY);

  it("accounts for every record about the selected companies", () => {
    const ids = new Set(inv.items.flatMap((i) => i.recordIds));
    const selected = new Set([withRounds.id, withAgreements.id]);
    const expected = [
      ...corpus.assertions.filter((a) => selected.has(a.subjectId)).map((a) => a.id),
      ...corpus.research.filter((r) => selected.has(r.subjectId)).map((r) => r.id),
      ...corpus.rounds
        .filter((r) => selected.has(r.companyId))
        .flatMap((r) => [
          r.id,
          ...r.disclosures.map((d) => d.id),
          ...r.participations.map((_, i) => `${r.id}#p${i}`),
        ]),
      ...corpus.agreements
        .filter((g) => g.parties.some((p) => selected.has(p.orgId)))
        .map((g) => g.id),
      ...corpus.acquisitions
        .filter((q) => selected.has(q.targetId) || selected.has(q.acquirerId))
        .map((q) => q.id),
    ];
    expect(expected.length).toBeGreaterThan(10);
    expect(expected.filter((id) => !ids.has(id))).toEqual([]);
    // Every agreement disclosure row is its own claim.
    for (const g of corpus.agreements.filter((x) => x.parties.some((p) => selected.has(p.orgId))))
      g.disclosureRows.forEach((_, i) =>
        expect(inv.items.some((it) => it.claimId.endsWith(`${g.id}:row${i}`))).toBe(true),
      );
  });

  it("computes the derived displays from an in-memory approval that never touches the corpus", () => {
    expect(inv.simulation.ok).toBe(true);
    expect(JSON.stringify(corpus)).toBe(before);
    expect(corpus.assertions.every((a) => a.verification !== "verified" && a.review === null)).toBe(
      true,
    );
    const derived = inv.items
      .filter((i) => i.card === "C01" && i.kind === "derived")
      .map((i) => i.fieldId);
    expect(derived).toEqual(expect.arrayContaining(["X01", "X02", "X03", "X08", "X09"]));
    expect(inv.items.every((i) => i.outcome === "not_yet_evaluated")).toBe(true);
  });

  it("maps every claim to a catalogued field (or the research ledger)", () => {
    const known = new Set([...BLIND_FIELDS.map((f) => f.id), "LEDGER"]);
    expect(inv.items.filter((i) => !known.has(i.fieldId))).toEqual([]);
  });

  it("leak check finds values however they are formatted, and respects the allow-list", () => {
    const amount = inv.items.find((i) => i.fieldId === "C02" && /"amount":"\d{5,}/.test(i.value))!;
    const raw = /"amount":"(\d+)/.exec(amount.value)![1]!;
    const formatted = Number(raw).toLocaleString("en-CA");
    const investor = inv.items.find((i) => i.fieldId === "D01" && i.kind === "base")!.entity;
    const hits = leakCheck(
      [
        {
          file: "clean.md",
          text: `Research ${cards[0]!.name} at ${cards[0]!.website}. Report amounts as stated.`,
        },
        { file: "leaky.md", text: `Round of $${formatted} led by ${investor}.` },
      ],
      inv,
      cards.flatMap((c) => [c.name, c.website]),
    );
    expect(hits.filter((h) => h.file === "clean.md")).toEqual([]);
    expect(hits.map((h) => h.file)).toContain("leaky.md");
    expect(hits.some((h) => digitsKey(h.token) === digitsKey(raw))).toBe(true);
    expect(hits.some((h) => h.token === investor)).toBe(true);
    expect(leakCheck([{ file: "x", text: investor }], inv, [investor])).toEqual([]);
  });
});

describe("leak check word matching", () => {
  const stub = {
    leakTokens: [
      { token: "OMERS", claimId: "c1" },
      { token: "Garage Capital", claimId: "c2" },
    ],
    items: [],
  } as unknown as Parameters<typeof leakCheck>[1];
  it("does not flag a value that only appears inside a longer word", () => {
    const hits = leakCheck([{ file: "x", text: "Report customers and Omersfield." }], stub, []);
    expect(hits).toEqual([]);
  });
  it("still flags a whole-word or whole-phrase appearance, in any case or punctuation", () => {
    const hits = leakCheck(
      [{ file: "x", text: "Round with OMERS-led syndicate and garage   capital." }],
      stub,
      [],
    );
    expect(hits.map((h) => h.token).sort()).toEqual(["Garage Capital", "OMERS"]);
  });
});

describe("researcher packages and the worksheet", () => {
  const inv = buildInventory(corpus, cards, TODAY);
  const agreement = corpus.agreements.find((g) =>
    g.parties.some((p) => p.orgId === withAgreements.id),
  )!;
  const key = agreement.externalIds[0]?.value ?? agreement.disclosureRows[0]!.totalValue!;
  const cited = inv.items.find(
    (i) =>
      i.claimId ===
      `C02:${agreement.family === "procurement" ? "E01" : agreement.family === "grant_contribution" ? "E02" : agreement.family === "other_transfer" ? "E03" : "E07"}:${agreement.id}`,
  )!;

  const pkg = (findings: unknown[]): unknown => ({
    package_version: "candef-blind-v2",
    researcher: { id: "R-test-1", model_or_tool: "test", browsing: true, limitations: [] },
    company: { card_id: "C02", name_as_given: cards[1]!.name, website_as_given: cards[1]!.website },
    entities: [{ entity_id: "E1", legal_name: null, role: "operating_company" }],
    findings,
  });
  const source = (url: string) => ({ url, locator: "row", quote: null });

  it("refuses a found claim without a source and a not_found claim without a search record", () => {
    const bad = ResearcherPackage.safeParse(
      pkg([
        {
          finding_id: "F1",
          field_id: "A02",
          status: "found",
          claim: "x",
          sources: [],
          confidence: "high",
        },
        {
          finding_id: "F2",
          field_id: "C04",
          status: "not_found",
          claim: "y",
          sources: [],
          confidence: "low",
        },
      ]),
    );
    expect(bad.success).toBe(false);
    const messages = bad.success ? "" : bad.error.issues.map((i) => i.message).join(" | ");
    expect(messages).toMatch(/needs a source/);
    expect(messages).toMatch(/places searched/);
    // Field IDs outside the catalogue are refused (the shape check reports them first).
    const unknown = ResearcherPackage.safeParse(
      pkg([
        {
          finding_id: "F3",
          field_id: "Z99",
          status: "found",
          claim: "z",
          sources: [source("https://a.test")],
          confidence: "low",
        },
      ]),
    );
    expect(unknown.success).toBe(false);
  });

  it("aligns event findings by identifier, flags shared sources, and keeps unmatched findings as new", () => {
    const candefUrl = cited.citations[0]?.url ?? "https://example.invalid/none";
    const parsed = ResearcherPackage.parse(
      pkg([
        {
          finding_id: "F1",
          field_id: cited.fieldId,
          status: "found",
          claim: "matching agreement",
          identifiers: [{ system: "id", value: key }],
          money: [{ amount: agreement.disclosureRows.at(-1)?.totalValue ?? null, currency: "CAD" }],
          sources: [source(candefUrl.replace("https://", "http://www.") + "/")],
          confidence: "medium",
        },
        {
          finding_id: "F2",
          field_id: "E06",
          status: "found",
          claim: "Additional: a foreign award",
          sources: [source("https://other.test/award")],
          confidence: "low",
        },
      ]),
    ) as Pkg;
    const ws = buildWorksheet(inv, [parsed]);
    expect(ws.rows).toHaveLength(inv.items.length);
    expect(ws.rows.every((r) => r.outcome === "not_yet_evaluated")).toBe(true);
    const row = ws.rows.find((r) => r.claimId === cited.claimId)!;
    expect(row.candidates.map((c) => c.findingId)).toContain("F1");
    if (cited.citations[0]?.url) expect(row.candidates[0]!.sameAsCandefSource).toBe(true);
    expect(ws.newFindings.map((f) => f.findingId)).toEqual(["F2"]);
  });

  it("treats copies of one page as one origin", () => {
    expect(originOf("https://www.example.org/news/a/?utm=1#x")).toBe(
      originOf("http://example.org/news/a"),
    );
  });
});

describe("catalogue coverage of the product", () => {
  it("accounts for every snapshot field that can describe a company", () => {
    const { snapshot } = simulateApproved(generateDemoCorpus({ companies: 120, seed: 3 }), TODAY);
    expect(snapshot).not.toBeNull();
    const keys = (prefix: string, objects: object[]) =>
      [...new Set(objects.flatMap((o) => Object.keys(o)))].map((k) => `${prefix}.${k}`);
    const present = [
      ...keys("org", snapshot!.organizations),
      ...keys("round", snapshot!.rounds),
      ...keys("agreement", snapshot!.agreements),
      ...keys("acquisition", snapshot!.acquisitions),
    ];
    expect(snapshot!.acquisitions.length).toBeGreaterThan(0);
    // The owner froze the blind prompts; new product fields are inventoried separately here.
    const inventory = {
      ...SNAPSHOT_FIELD_MAP,
      "org.lineage": "Documented succession events; outside the fixed blind rubric",
    };
    expect(present.filter((k) => !(k in inventory))).toEqual([]);
  });
});

describe("intake of returned packages", () => {
  const base = {
    package_version: "candef-blind-v2",
    researcher: { id: "R-x", model_or_tool: "x", browsing: true, limitations: [] },
    company: { card_id: "C01", name_as_given: "n", website_as_given: "w" },
    entities: [],
  };

  it("normalizes format variants in memory, logs them, and never changes the input", () => {
    const raw = {
      ...base,
      findings: [
        {
          finding_id: "F1",
          field_id: "C02",
          status: "found",
          claim: "Round of US$30 million",
          money: [{ amount: 30000000, currency: null }],
          sources: [{ url: "https://a.test/x", locator: "p1", source_type: "press_release" }],
          links_to: "F2",
          confidence: "high",
        },
        {
          finding_id: "F2",
          field_id: "C04",
          status: "not_found",
          claim: "none",
          searched: ["site"],
          confidence: "low",
        },
      ],
    };
    const before = JSON.stringify(raw);
    const intake = intakePackage(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(intake.errors).toEqual([]);
    expect(intake.pkg!.findings[0]!.sources[0]!.source_type).toBe("first_party");
    expect(intake.pkg!.findings[0]!.money![0]).toMatchObject({
      amount: "30000000",
      currency: "unknown",
    });
    expect(intake.notes.join(" ")).toMatch(/press_release/);
    expect(intake.issues).toEqual([]);
  });

  it("reshapes the batch-2 variants: money object, null identifiers, odd contradictions", () => {
    const raw = {
      ...base,
      entities: [
        {
          entity_id: "E1",
          legal_name: "X Inc.",
          role: "operating_company",
          identifiers: [
            { system: "cra-bn", value: 123456789 },
            { system: "bn", value: null },
          ],
        },
      ],
      findings: [
        {
          finding_id: "F1",
          field_id: "C02",
          status: "found",
          claim: "Acquired for an undisclosed price",
          money: { amount: null, currency: null, as_stated: "undisclosed" },
          identifiers: [
            { system: "procurement_id", value: "W7701-1" },
            { system: "reference_number", value: null },
          ],
          contradictions: [
            "Current team page names a different CEO.",
            {
              issue: "contract value",
              version_1: "CAD 2.2M",
              version_2: "CAD 2.3M",
              assessment: "open",
            },
            { claim: "kept as given", sources: [] },
          ],
          sources: [{ url: "https://a.test/x", locator: "p1", source_type: "first_party" }],
          confidence: "high",
        },
      ],
    };
    const before = JSON.stringify(raw);
    const intake = intakePackage(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(intake.errors).toEqual([]);
    const f = intake.pkg!.findings[0]!;
    expect(f.money).toEqual([{ amount: null, currency: "unknown", as_stated: "undisclosed" }]);
    expect(f.identifiers).toEqual([{ system: "procurement_id", value: "W7701-1" }]);
    expect(intake.pkg!.entities[0]!.identifiers).toEqual([
      { system: "cra-bn", value: "123456789" },
    ]);
    expect(f.contradictions![0]).toMatchObject({
      claim: "Current team page names a different CEO.",
    });
    expect(f.contradictions![1]!.claim).toBe("contract value | CAD 2.2M | CAD 2.3M");
    expect(f.contradictions![2]!.claim).toBe("kept as given");
    expect(intake.notes.join(" ")).toMatch(/identifier without a value dropped/);
  });

  it("sets aside findings under unknown fields (keeping their text) and defaults a missing confidence only for not_researched", () => {
    const intake = intakePackage({
      ...base,
      findings: [
        {
          finding_id: "F1",
          field_id: "E2",
          status: "found",
          claim: "A foreign agency awarded a contract",
          sources: [],
          confidence: "high",
        },
        { finding_id: "F2", field_id: "C03", status: "not_researched", claim: "n/a", sources: [] },
      ],
    });
    expect(intake.errors).toEqual([]);
    expect(intake.pkg!.findings.map((f) => f.finding_id)).toEqual(["F2"]);
    expect(intake.pkg!.findings[0]!.confidence).toBe("low");
    expect(intake.notes.join(" ")).toMatch(/F1 set aside.*"E2".*foreign agency/);
    const missing = intakePackage({
      ...base,
      findings: [{ finding_id: "F3", field_id: "C03", status: "found", claim: "x", sources: [] }],
    });
    expect(missing.pkg).toBeNull();
  });

  it("does not crash on malformed entries, it reports them as schema errors", () => {
    const intake = intakePackage({
      ...base,
      findings: [
        {
          finding_id: "F1",
          field_id: "C02",
          status: "found",
          claim: "x",
          sources: ["bad"],
          money: [7],
        },
      ],
    });
    expect(intake.pkg).toBeNull();
    expect(intake.errors.length).toBeGreaterThan(0);
  });

  it("accepts judgements and cross-references without their own source, flags other unsourced claims", () => {
    const intake = intakePackage({
      ...base,
      findings: [
        {
          finding_id: "F1",
          field_id: "B06",
          status: "found",
          claim: "Included",
          sources: [],
          confidence: "medium",
        },
        {
          finding_id: "F2",
          field_id: "E04",
          status: "found",
          claim: "Same award as F007",
          sources: [],
          confidence: "medium",
        },
        {
          finding_id: "F3",
          field_id: "A02",
          status: "found",
          claim: "Legal name X Inc.",
          sources: [],
          confidence: "high",
        },
      ],
    });
    expect(intake.issues.map((i) => i.findingId)).toEqual(["F3"]);
  });

  it("reads rounded and worded amounts", () => {
    expect(sigKey(402505000)).toBe(amountsInText("a $402.5 million offering").map(sigKey)[0]);
    expect(amountsInText("US$30 million").map(sigKey)).toContain(sigKey(30_000_000));
  });
});
