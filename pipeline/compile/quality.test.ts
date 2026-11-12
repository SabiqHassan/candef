import { describe, expect, it } from "vitest";
import type {
  Agreement,
  Assertion,
  Corpus,
  FinancingRound,
  Organization,
} from "../../src/domain/schema/corpus";
import { entityFailures, qualityIssues } from "./quality";

const TODAY = "2026-10-13";
const prov = {
  epistemic: "sourced_fact" as const,
  verification: "proposed" as const,
  evidence: [{ sourceId: "s1", locator: "p1", locatorQuality: "body" as const }],
  review: null,
  createdBy: "test",
};
const org = (id: string, name: string, extra: Partial<Organization> = {}): Organization => ({
  id,
  kind: "company",
  slug: id,
  name,
  mergedInto: null,
  isDemo: false,
  ...extra,
});
const fact = (subjectId: string, predicate: Assertion["predicate"], value: unknown): Assertion => ({
  id: `${subjectId}:${predicate}:${JSON.stringify(value)}`,
  subjectId,
  predicate,
  value,
  primary: false,
  validFrom: null,
  validTo: null,
  asOf: null,
  supersedes: null,
  ...prov,
});
const corpus = (c: Partial<Corpus>): Corpus => ({
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
  ...c,
});
const round = (
  id: string,
  stage: FinancingRound["stage"],
  date: string,
  src = "s1",
): FinancingRound => ({
  id,
  companyId: "co",
  eventState: "announced",
  roundLabelAsStated: null,
  stage,
  instrument: "equity",
  proceeds: "primary",
  participantsCompleteness: "unknown",
  disclosures: [
    {
      id: `${id}_d`,
      date,
      kind: "single",
      amount: { amount: null, currency: "CAD", disclosure: "undisclosed", asStated: "n/d" },
      amountBasis: "unknown",
      amountNature: "unspecified",
      ...prov,
      evidence: [{ sourceId: src, locator: "p1", locatorQuality: "body" }],
    },
  ],
  participations: [],
  ...prov,
  evidence: [{ sourceId: src, locator: "p1", locatorQuality: "body" }],
});
const agreement = (id: string, extra: Partial<Agreement> = {}): Agreement => ({
  id,
  family: "procurement",
  type: "contract_award",
  title: "Services",
  programId: null,
  groupId: null,
  externalIds: [],
  parties: [
    { orgId: "dept", role: "buyer", evidenceStrength: "party_of_record", reportedName: "Dept" },
    { orgId: "co", role: "prime", evidenceStrength: "party_of_record", reportedName: "Co Inc." },
  ],
  currency: "CAD",
  disclosureRows: [],
  valueStatements: [],
  allocations: [],
  repayability: null,
  announcedOn: "2025",
  startOn: null,
  statusAsOf: { state: "unknown", asOf: TODAY },
  ...prov,
  ...extra,
});
const checks = (c: Corpus) => qualityIssues(c, TODAY).map((q) => q.check);

describe("entity-resolution gate", () => {
  it("fails two live organizations with the same normalized legal name and kind", () => {
    const c = corpus({
      organizations: [org("a", "Alpha Robotics"), org("b", "ALPHA ROBOTICS INC.")],
    });
    expect(entityFailures(c).map((f) => f.gate)).toEqual(["duplicate-entities"]);
  });
  it("fails a shared registry identifier even when names differ", () => {
    const c = corpus({
      organizations: [org("a", "Alpha"), org("b", "Beta")],
      assertions: [
        fact("a", "registry_id", { system: "cra-bn", value: "123456789" }),
        fact("b", "registry_id", { system: "cra-bn", value: "123 456 789" }),
      ],
    });
    expect(entityFailures(c)[0]?.message).toMatch(/same registry identifier/);
  });
  it("passes when resolved by mergedInto or a recorded distinctFrom decision", () => {
    expect(
      entityFailures(
        corpus({ organizations: [org("a", "Alpha"), org("b", "Alpha Inc.", { mergedInto: "a" })] }),
      ),
    ).toEqual([]);
    expect(
      entityFailures(
        corpus({
          organizations: [org("a", "Alpha"), org("b", "Alpha Inc.", { distinctFrom: ["a"] })],
        }),
      ),
    ).toEqual([]);
  });
  it("does not confuse different kinds with the same name", () => {
    expect(
      entityFailures(
        corpus({ organizations: [org("a", "Northstar"), org("b", "Northstar", { kind: "fund" })] }),
      ),
    ).toEqual([]);
  });
  it("fails a classification that names a missing taxonomy node", () => {
    const c = corpus({
      taxonomy: [{ id: "tax:space", parentId: null, label: "Space", definition: "" }],
      organizations: [org("a", "Alpha")],
      assertions: [fact("a", "classified_as", "tax:spcae")],
    });
    expect(entityFailures(c)).toEqual([
      expect.objectContaining({
        gate: "dangling-taxonomy",
        ids: ['a:classified_as:"tax:spcae"->tax:spcae'],
      }),
    ]);
    c.assertions[0] = fact("a", "classified_as", "tax:space");
    expect(entityFailures(c)).toEqual([]);
  });
  it("fails an inclusion without a real dual-use rationale (D-16)", () => {
    const c = corpus({
      organizations: [org("a", "Alpha")],
      assertions: [fact("a", "eligibility", { decision: "included", rationale: "dual use" })],
    });
    expect(entityFailures(c).map((f) => f.gate)).toEqual(["eligibility-rationale"]);
    c.assertions[0] = fact("a", "eligibility", {
      decision: "included",
      rationale: "Documented secure-communications contract with a defence department.",
    });
    expect(entityFailures(c)).toEqual([]);
    c.assertions[0] = fact("a", "eligibility", { decision: "excluded", rationale: "" });
    expect(entityFailures(c)).toEqual([]);
  });
  it("fails any contact detail but allows business addresses (D-17)", () => {
    const withValue = (value: unknown) =>
      corpus({ organizations: [org("a", "Alpha")], assertions: [fact("a", "role_held", value)] });
    expect(
      entityFailures(withValue({ name: "A. Person", title: "CEO", email: "x@example.org" })).map(
        (f) => f.gate,
      ),
    ).toEqual(["no-contact-data"]);
    expect(
      entityFailures(withValue({ name: "A. Person", title: "CEO", phone: "555" })).map(
        (f) => f.gate,
      ),
    ).toEqual(["no-contact-data"]);
    expect(
      entityFailures(withValue("reach her at someone@example.org")).map((f) => f.gate),
    ).toEqual(["no-contact-data"]);
    expect(entityFailures(withValue({ name: "A. Person", title: "CEO" }))).toEqual([]);
    const hq = corpus({
      organizations: [org("a", "Alpha")],
      assertions: [
        fact("a", "hq_location", {
          city: "Ottawa",
          province: "ON",
          country: "CA",
          postalCode: "K1A 0B1",
        }),
      ],
    });
    expect(entityFailures(hq)).toEqual([]);
  });
  it("fails while records still point at a merged organization", () => {
    const c = corpus({
      organizations: [org("a", "Alpha"), org("b", "Alpha Old", { mergedInto: "a" })],
      assertions: [fact("b", "legal_name", "Alpha Old Inc.")],
    });
    expect(entityFailures(c)).toEqual([
      expect.objectContaining({ gate: "merged-reference", ids: [expect.stringMatching(/->b$/)] }),
    ]);
    c.assertions[0] = fact("a", "legal_name", "Alpha Old Inc.");
    expect(entityFailures(c)).toEqual([]);
  });
  it("never publishes a merged organization and records a redirect for its old address", async () => {
    const { compile } = await import("./compile");
    const c = corpus({
      organizations: [org("a", "Alpha"), org("b", "Alpha Old", { mergedInto: "a" })],
    });
    const snap = compile(c, { today: TODAY }).snapshot!;
    expect(snap.organizations.map((o) => o.id)).not.toContain("b");
    expect(snap.redirects).toEqual({ b: "a" });
    expect(snap.coverage.companiesDiscovered).toBe(1);
  });
  it("fails a merge into a missing or merged organization", () => {
    const c = corpus({
      organizations: [
        org("a", "A1", { mergedInto: "missing" }),
        org("b", "B1", { mergedInto: "c" }),
        org("c", "C1", { mergedInto: "d" }),
        org("d", "D1"),
      ],
    });
    expect(entityFailures(c)[0]).toMatchObject({
      gate: "merge-target",
      ids: ["a->missing", "b->c"],
    });
  });
});

describe("data-quality checks", () => {
  it("flags the same stage recorded twice within six months, not rounds years apart", () => {
    expect(
      checks(
        corpus({
          rounds: [round("r1", "seed", "2024-01", "s1"), round("r2", "seed", "2024-05", "s2")],
        }),
      ),
    ).toEqual(["possible-duplicate-round"]);
    expect(
      checks(
        corpus({
          rounds: [round("r1", "seed", "2020-01", "s1"), round("r2", "seed", "2023-05", "s2")],
        }),
      ),
    ).toEqual([]);
    expect(
      checks(
        corpus({
          rounds: [round("r1", "seed", "2020-01", "same"), round("r2", "seed", "2023-05", "same")],
        }),
      ),
    ).toEqual(["possible-duplicate-round"]);
  });

  const rows = (totals: [string, string | null, string][]) =>
    totals.map(([period, amendment, total], i) => ({
      reportingPeriod: period,
      instrument: (i === 0 ? "original" : "amendment") as "original" | "amendment",
      originalValue: totals[0]![2],
      amendmentValue: amendment,
      totalValue: total,
      endOnAsStated: null,
    }));
  it("accepts running totals (including a negative amendment and one-cent rounding)", () => {
    const g = agreement("g1", {
      disclosureRows: rows([
        ["Q1", null, "100000.00"],
        ["Q2", "50000.00", "150000.00"],
        ["Q3", "-25000.00", "125000.01"],
      ]),
    });
    expect(checks(corpus({ agreements: [g] }))).toEqual([]);
  });
  it("flags a delta read as a total, a missing row, and a negative total", () => {
    const misread = agreement("g2", {
      disclosureRows: rows([
        ["Q1", null, "100000.00"],
        ["Q2", "50000.00", "50000.00"],
      ]),
    });
    const negative = agreement("g3", { disclosureRows: rows([["Q1", null, "-5.00"]]) });
    expect(checks(corpus({ agreements: [misread, negative] }))).toEqual([
      "row-arithmetic",
      "row-arithmetic",
    ]);
  });
  it("flags the same contract number arriving from two datasets", () => {
    const a = agreement("tbs", {
      externalIds: [{ system: "tbs-contracts:procurement_id", value: "W1234-5" }],
    });
    const b = agreement("cb", {
      externalIds: [{ system: "canadabuys:contractNumber", value: "w1234-5 " }],
    });
    expect(checks(corpus({ agreements: [a, b] }))).toEqual(["cross-dataset-duplicate"]);
  });
  it("never treats a shared program name as a duplicate identifier (real-data regression)", () => {
    const program = { system: "tbs-grants:program", value: "Fictional Research Program" };
    const a = agreement("g-a", { externalIds: [program] });
    const b = agreement("g-b", { externalIds: [program] });
    expect(checks(corpus({ agreements: [a, b] }))).toEqual([]);
    const number = { system: "tbs-grants:agreement_number", value: "123" };
    const c = agreement("g-c", { externalIds: [program, number] });
    const d = agreement("g-d", { externalIds: [number] });
    expect(checks(corpus({ agreements: [c, d] }))).toEqual(["cross-dataset-duplicate"]);
  });
  it("flags a counterparty that is only named in a description", () => {
    const g = agreement("g4");
    g.parties[0] = { ...g.parties[0]!, evidenceStrength: "named_in_description" };
    expect(checks(corpus({ agreements: [g] }))).toEqual(["no-party-of-record-counterparty"]);
  });
  it("flags a consortium string attributed to one company unless an allocation is disclosed", () => {
    const g = agreement("g5");
    g.parties[1] = { ...g.parties[1]!, reportedName: "Alpha Inc. in joint venture with Beta Ltd." };
    expect(checks(corpus({ agreements: [g] }))).toEqual(["consortium-attribution"]);
    g.allocations = [
      {
        orgId: "co",
        money: { amount: "10", currency: "CAD", disclosure: "disclosed", asStated: "$10" },
        evidence: [],
      },
    ];
    expect(checks(corpus({ agreements: [g] }))).toEqual([]);
  });
  it("reports research topics past their review date, using the latest attempt", () => {
    const attempt = (at: string, nextReview: string) => ({
      id: at,
      subjectId: "co",
      topic: "financing" as const,
      sourcesSearched: [],
      outcome: "found" as const,
      by: "t",
      at,
      nextReview,
    });
    expect(checks(corpus({ research: [attempt("2025-01-01", "2026-01")] }))).toEqual([
      "stale-research",
    ]);
    expect(
      checks(
        corpus({ research: [attempt("2025-01-01", "2026-01"), attempt("2026-09-01", "2027-03")] }),
      ),
    ).toEqual([]);
  });
});

describe("total_raised_as_stated (F-15)", () => {
  it("is accepted but never enters computed financing totals", async () => {
    const { compile } = await import("./compile");
    const { generateDemoCorpus } = await import("../demo/generate");
    const c = generateDemoCorpus({ companies: 20 });
    const before = compile(c, { today: TODAY }).snapshot!;
    const company = before.organizations.find(
      (o) => o.scope === "universe" && o.financing?.totals.length,
    )!;
    const sealedSource = c.assertions.find((a) => a.subjectId === company.id)!;
    c.assertions.push({
      ...sealedSource,
      id: "stated_total",
      predicate: "total_raised_as_stated",
      value: {
        money: { amount: "999000000", currency: "CAD", disclosure: "disclosed", asStated: "$999M" },
      },
    });
    const after = compile(c, { today: TODAY });
    expect(after.ok).toBe(true);
    const org = after.snapshot!.organizations.find((o) => o.id === company.id)!;
    expect(org.financing!.totals).toEqual(company.financing!.totals);
  });
});
