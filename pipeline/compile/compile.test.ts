import { describe, expect, it } from "vitest";
import type {
  Agreement,
  Corpus,
  Disclosure,
  FinancingRound,
  Provenance,
} from "../../src/domain/schema/corpus";
import { generateDemoCorpus } from "../demo/generate";
import { attributions, currentValue } from "./agreements";
import { compile } from "./compile";
import { resolveRoundAmount, rollUpParticipants } from "./financing";
import { hasValidReview, reviewHashFor, sealDemoCorpus } from "./hash";

const TODAY = "2026-10-13";
const ev = (sourceId = "src_a") => [{ sourceId, locator: "p1", locatorQuality: "body" as const }];
const prov = (verification: Provenance["verification"] = "verified"): Provenance => ({
  epistemic: "sourced_fact",
  verification,
  evidence: ev(),
  review: null,
  createdBy: "test",
});
const disc = (
  date: string,
  kind: Disclosure["kind"],
  amount: string | null,
  basis: Disclosure["amountBasis"],
  currency = "CAD",
): Disclosure => ({
  id: `d_${date}_${kind}`,
  date,
  kind,
  amount:
    amount === null
      ? { amount: null, currency, disclosure: "undisclosed", asStated: "n/d" }
      : { amount, currency, disclosure: "disclosed", asStated: amount },
  amountBasis: basis,
  amountNature: "unspecified",
  ...prov(),
});

/** Minimal valid corpus: one Canadian company with evidenced HQ, classification and eligibility. */
function baseCorpus(): Corpus {
  const assertion = (
    id: string,
    predicate: Corpus["assertions"][number]["predicate"],
    value: unknown,
    primary = false,
  ) => ({
    id,
    subjectId: "org_co",
    predicate,
    value,
    primary,
    validFrom: null,
    validTo: null,
    asOf: null,
    supersedes: null,
    ...prov(),
  });
  return {
    schemaVersion: "0.3",
    isDemo: true,
    taxonomy: [
      { id: "tax:space", parentId: null, label: "Space", definition: "" },
      { id: "tax:space.1", parentId: "tax:space", label: "EO", definition: "" },
    ],
    sources: [
      {
        id: "src_a",
        kind: "company_release",
        tier: "T2",
        publisher: "Co",
        title: "t",
        url: "https://example.invalid/a",
        publishedOn: null,
        retrievedAt: TODAY,
        originGroup: "og1",
        textSha256: null,
        sourceBasis: "named",
      },
      {
        id: "src_anon",
        kind: "news",
        tier: "T3",
        publisher: "Paper",
        title: "t",
        url: "https://example.invalid/b",
        publishedOn: null,
        retrievedAt: TODAY,
        originGroup: "og2",
        textSha256: null,
        sourceBasis: "anonymous_sources",
      },
    ],
    organizations: [
      { id: "org_co", kind: "company", slug: "co", name: "Co", mergedInto: null, isDemo: true },
      {
        id: "org_firm",
        kind: "investor_firm",
        slug: "firm",
        name: "Firm",
        mergedInto: null,
        isDemo: true,
      },
      {
        id: "org_fund",
        kind: "fund",
        slug: "fund",
        name: "Firm Fund I",
        mergedInto: null,
        isDemo: true,
      },
      {
        id: "org_gov",
        kind: "government_body",
        slug: "gov",
        name: "Gov",
        mergedInto: null,
        isDemo: true,
      },
    ],
    assertions: [
      assertion(
        "a1",
        "hq_location",
        { city: "Ottawa", region: null, province: "ON", country: "CA" },
        true,
      ),
      assertion("a2", "classified_as", "tax:space.1", true),
      assertion("a3", "eligibility", {
        decision: "included",
        rationale: "Documented contract with a defence research agency (fixture).",
      }),
    ],
    rounds: [],
    agreements: [],
    acquisitions: [],
    programs: [],
    research: [],
  };
}

const run = (c: Corpus) => compile(sealDemoCorpus(c, TODAY), { today: TODAY });

describe("financing resolution (P-19)", () => {
  it("never adds successive closes of one round when a cumulative total exists", () => {
    const r = resolveRoundAmount([
      disc("2020-09", "first_close", "30000000", "incremental", "USD"),
      disc("2021-07", "final", "45000000", "cumulative_round_total", "USD"),
    ]);
    expect(r.status).toBe("resolved");
    expect(r.money?.amount).toBe("45000000");
  });
  it("sums incremental tranches only when all are disclosed in one currency", () => {
    expect(
      resolveRoundAmount([
        disc("2020-01", "first_close", "6000000", "incremental"),
        disc("2020-06", "extension", "4000000", "incremental"),
      ]).money?.amount,
    ).toBe("10000000");
    expect(
      resolveRoundAmount([
        disc("2020-01", "first_close", "6000000", "incremental"),
        disc("2020-06", "extension", "4000000", "incremental", "USD"),
      ]).status,
    ).toBe("unclear");
    expect(
      resolveRoundAmount([
        disc("2020-01", "first_close", "6000000", "incremental"),
        disc("2020-06", "extension", null, "incremental"),
      ]).status,
    ).toBe("unclear");
  });
  it("resolves an extension with unknown basis as unclear", () => {
    expect(
      resolveRoundAmount([
        disc("2020-04", "unknown", "45000000", "unknown"),
        disc("2021-01", "extension", "6600000", "incremental"),
      ]).status,
    ).toBe("unclear");
  });
  it("flags tranches that exceed the stated round total", () => {
    const r = resolveRoundAmount([
      disc("2020-01", "first_close", "50000000", "incremental"),
      disc("2020-06", "final", "45000000", "cumulative_round_total"),
    ]);
    expect(r.status).toBe("unclear");
  });
  it("reports undisclosed, not zero, when no amount is disclosed", () => {
    const r = resolveRoundAmount([disc("2020-01", "single", null, "unknown")]);
    expect(r).toMatchObject({ status: "undisclosed", money: null });
  });
  it("counts a firm and its fund as one economic investor", () => {
    const round: FinancingRound = {
      id: "fin1",
      companyId: "org_co",
      eventState: "closed",
      roundLabelAsStated: "Series A",
      stage: "series_a",
      instrument: "equity",
      proceeds: "primary",
      participantsCompleteness: "complete",
      disclosures: [],
      participations: [
        {
          reportedName: "Firm Fund I",
          investorId: "org_firm",
          vehicleId: "org_fund",
          role: "lead",
          disclosureIds: [],
          ...prov(),
        },
        {
          reportedName: "Firm",
          investorId: "org_firm",
          vehicleId: null,
          role: "participant",
          disclosureIds: [],
          ...prov(),
        },
      ],
      ...prov(),
    };
    const sealed = sealDemoCorpus({ ...baseCorpus(), rounds: [round] }, TODAY).rounds[0]!;
    const people = rollUpParticipants(sealed);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      investorId: "org_firm",
      vehicleId: "org_fund",
      role: "lead",
    });
  });
});

describe("agreement resolution (P-16, P-19)", () => {
  const agreement = (over: Partial<Agreement>): Agreement => ({
    id: "agr1",
    family: "procurement",
    type: "contract_award",
    title: "t",
    programId: null,
    groupId: null,
    externalIds: [],
    parties: [
      { orgId: "org_gov", role: "buyer", evidenceStrength: "party_of_record", reportedName: "Gov" },
      {
        orgId: "org_co",
        role: "prime",
        evidenceStrength: "party_of_record",
        reportedName: "CO INC",
      },
    ],
    currency: "CAD",
    disclosureRows: [],
    valueStatements: [],
    allocations: [],
    repayability: null,
    announcedOn: "2024",
    startOn: null,
    statusAsOf: { state: "unknown", asOf: TODAY },
    ...prov(),
    ...over,
  });
  it("uses the latest cumulative disclosure row, including negative amendments", () => {
    const g = agreement({
      disclosureRows: [
        {
          reportingPeriod: "Q1",
          instrument: "original",
          originalValue: "45843621.80",
          amendmentValue: null,
          totalValue: "45843621.80",
          endOnAsStated: null,
        },
        {
          reportingPeriod: "Q2",
          instrument: "amendment",
          originalValue: "45843621.80",
          amendmentValue: "-12154000.00",
          totalValue: "33689621.80",
          endOnAsStated: null,
        },
      ],
    });
    expect(currentValue(g)).toMatchObject({
      money: { amount: "33689621.80" },
      basis: "amended_total",
    });
  });
  it("never attributes a consortium total to a member without a disclosed allocation", () => {
    const g = agreement({
      disclosureRows: [
        {
          reportingPeriod: "Q1",
          instrument: "original",
          originalValue: "6000000",
          amendmentValue: null,
          totalValue: "6000000",
          endOnAsStated: null,
        },
      ],
      parties: [
        {
          orgId: "org_gov",
          role: "buyer",
          evidenceStrength: "party_of_record",
          reportedName: "Gov",
        },
        { orgId: "org_co", role: "prime", evidenceStrength: "party_of_record", reportedName: "Co" },
        {
          orgId: "org_co2",
          role: "member",
          evidenceStrength: "party_of_record",
          reportedName: "Co2",
        },
      ],
    });
    const a = attributions(g, new Set(["org_co", "org_co2"]));
    expect(a.map((x) => x.basis)).toEqual(["consortium_undisclosed", "consortium_undisclosed"]);
    expect(a.every((x) => x.money === null)).toBe(true);
  });
  it("draws grants as a separate relationship kind from procurement", () => {
    const c = baseCorpus();
    c.programs = [{ id: "prg", funderId: "org_gov", name: "Program" }];
    c.agreements = [
      agreement({
        id: "g_contract",
        disclosureRows: [
          {
            reportingPeriod: "Q1",
            instrument: "original",
            originalValue: "500000",
            amendmentValue: null,
            totalValue: "500000",
            endOnAsStated: null,
          },
        ],
      }),
      agreement({
        id: "g_grant",
        family: "grant_contribution",
        type: "contribution",
        programId: "prg",
        parties: [
          {
            orgId: "org_gov",
            role: "funder",
            evidenceStrength: "party_of_record",
            reportedName: "Gov",
          },
          {
            orgId: "org_co",
            role: "recipient",
            evidenceStrength: "party_of_record",
            reportedName: "Co",
          },
        ],
        valueStatements: [
          {
            money: { amount: "200000", currency: "CAD", disclosure: "disclosed", asStated: "200k" },
            basis: { options: "unknown", taxes: "unknown", stage: "awarded" },
            evidence: ev(),
          },
        ],
      }),
    ];
    const snap = run(c).snapshot!;
    const kinds = snap.graph.lenses.contracts.edges.map((e) => e.kind).sort();
    expect(kinds).toEqual(["grant", "procurement"]);
    expect(snap.graph.lenses.contracts.edges.find((e) => e.kind === "grant")?.valueCad).toBeNull();
  });
  it("keeps other transfer payments apart from grants and procurement, and keeps the source's own classification", () => {
    const c = baseCorpus();
    c.agreements = [
      agreement({
        id: "g_contract",
        disclosureRows: [
          {
            reportingPeriod: "Q1",
            instrument: "original",
            originalValue: "500000",
            amendmentValue: null,
            totalValue: "500000",
            endOnAsStated: null,
          },
        ],
      }),
      agreement({
        id: "g_other",
        family: "other_transfer",
        type: "other_transfer_payment",
        sourceClassification: {
          system: "tbs-grants:agreement_type",
          code: "O",
          label: "Other transfer payment",
        },
        parties: [
          {
            orgId: "org_gov",
            role: "funder",
            evidenceStrength: "party_of_record",
            reportedName: "Gov",
          },
          {
            orgId: "org_co",
            role: "recipient",
            evidenceStrength: "party_of_record",
            reportedName: "Co",
          },
        ],
        disclosureRows: [
          {
            reportingPeriod: "amendment 0 (2019-08-01)",
            instrument: "original",
            originalValue: "20000000.0",
            amendmentValue: null,
            totalValue: "20000000.0",
            endOnAsStated: "2025-12-31",
          },
        ],
      }),
    ];
    const snap = run(c).snapshot!;
    const view = snap.agreements.find((g) => g.id === "g_other")!;
    expect(view.family).toBe("other_transfer");
    expect(view.sourceClassification).toEqual({
      system: "tbs-grants:agreement_type",
      code: "O",
      label: "Other transfer payment",
    });
    // A procurement view carries no classification, and nothing is counted as a grant.
    expect(snap.agreements.find((g) => g.id === "g_contract")!.sourceClassification).toBeNull();
    expect(snap.coverage.agreements).toMatchObject({
      procurement: 1,
      grants: 0,
      otherTransfers: 1,
    });
    // Not drawn: an other-transfer line would read as a grant or a contract.
    expect(snap.graph.lenses.contracts.edges.map((e) => e.kind)).toEqual(["procurement"]);
    expect(view.thresholdValueCad).toBeNull();
    expect(view.currentValue).toMatchObject({ amount: "20000000.0", currency: "CAD" });
  });
  it("binds the source classification into the review hash, and leaves older hashes unchanged", () => {
    const base = agreement({ id: "h1" });
    const withClass = agreement({
      id: "h1",
      sourceClassification: { system: "tbs-grants:agreement_type", code: "O", label: "Other" },
    });
    const nullClass = agreement({ id: "h1", sourceClassification: null });
    const hash = (g: Agreement) => reviewHashFor("agreement", g);
    expect(hash(nullClass)).toBe(hash(base));
    expect(hash(withClass)).not.toBe(hash(base));
  });
  it("shows the program name published with an imported grant when no program record exists", () => {
    const c = baseCorpus();
    c.agreements = [
      agreement({
        id: "g_imported",
        family: "grant_contribution",
        type: "contribution",
        programId: null,
        externalIds: [{ system: "tbs-grants:program", value: "Innovation Networks" }],
        parties: [
          {
            orgId: "org_gov",
            role: "funder",
            evidenceStrength: "party_of_record",
            reportedName: "Gov",
          },
          {
            orgId: "org_co",
            role: "recipient",
            evidenceStrength: "party_of_record",
            reportedName: "Co",
          },
        ],
      }),
    ];
    const snap = run(c).snapshot!;
    expect(snap.agreements.find((g) => g.id === "g_imported")?.programName).toBe(
      "Innovation Networks",
    );
  });
});

describe("states and integrity gates", () => {
  it("never publishes a rejected or retracted round, and shows a proposed one only as a bare placeholder", () => {
    const c = baseCorpus();
    const round = (id: string, verification: Provenance["verification"]): FinancingRound => ({
      id,
      companyId: "org_co",
      eventState: "reported",
      roundLabelAsStated: "Series Z",
      stage: "series_b",
      instrument: "equity",
      proceeds: "primary",
      participantsCompleteness: "complete",
      disclosures: [],
      participations: [
        {
          reportedName: "Firm",
          investorId: "org_firm",
          vehicleId: null,
          role: "lead",
          disclosureIds: [],
          ...prov(verification),
        },
      ],
      ...prov(verification),
    });
    c.rounds = [
      round("r_proposed", "proposed"),
      round("r_rejected", "rejected"),
      round("r_retracted", "retracted"),
    ];
    const snap = run(c).snapshot!;
    expect(snap.rounds.map((r) => r.id)).toEqual(["r_proposed"]);
    const placeholder = snap.rounds[0]!;
    expect(placeholder).toMatchObject({
      label: null,
      stage: null,
      participants: [],
      disclosures: [],
      sourceIds: [],
      resolved: { status: "unclear", money: null },
    });
  });
  it("withholds the value of an unverified (proposed) assertion", () => {
    const c = baseCorpus();
    c.assertions.push({
      id: "a4",
      subjectId: "org_co",
      predicate: "founded_year",
      value: 2015,
      primary: false,
      validFrom: null,
      validTo: null,
      asOf: null,
      supersedes: null,
      ...prov("proposed"),
    });
    const org = run(c).snapshot!.organizations.find((o) => o.id === "org_co")!;
    expect(org.founded).toMatchObject({ state: "unconfirmed", value: null });
  });
  it("lists secondary classifications once and never repeats the primary segment", () => {
    const org = (c: Corpus) => run(c).snapshot!.organizations.find((o) => o.id === "org_co")!;
    const single = baseCorpus();
    single.assertions[1]!.primary = false;
    expect(org(single).segment.value?.id).toBe("tax:space.1");
    expect(org(single).secondarySegments).toEqual([]);

    const multi = baseCorpus();
    multi.taxonomy.push({
      id: "tax:space.2",
      parentId: "tax:space",
      label: "Satcom",
      definition: "",
    });
    const extra = (id: string, value: string) => ({
      ...multi.assertions[1]!,
      id,
      value,
      primary: false,
    });
    multi.assertions.push(
      extra("a5", "tax:space.2"),
      extra("a6", "tax:space.2"),
      extra("a7", "tax:space.1"),
    );
    expect(org(multi).segment.value?.id).toBe("tax:space.1");
    expect(org(multi).secondarySegments.map((s) => s.id)).toEqual(["tax:space.2"]);
  });
  it("distinguishes not researched from researched-but-not-found", () => {
    const c = baseCorpus();
    let org = run(c).snapshot!.organizations.find((o) => o.id === "org_co")!;
    expect(org.founded.state).toBe("not_researched");
    // No parent on file is reported by research state, never as a claim of independence.
    expect(org.ownership).toMatchObject({ parentState: "not_researched", parentId: null });
    c.research.push({
      id: "r1",
      subjectId: "org_co",
      topic: "identity",
      sourcesSearched: ["site"],
      outcome: "none_found",
      by: "test",
      at: "2026-09",
      nextReview: "2027-03",
    });
    org = run(c).snapshot!.organizations.find((o) => o.id === "org_co")!;
    expect(org.founded.state).toBe("not_found");
    expect(org.ownership).toMatchObject({ parentState: "not_found", parentAsOf: "2026-09" });
  });
  it("invalidates an approval when the approved assertion changes", () => {
    const sealed = sealDemoCorpus(baseCorpus(), TODAY);
    const a = sealed.assertions[0]!;
    expect(hasValidReview("assertion", a)).toBe(true);
    const edited = {
      ...a,
      value: { city: "Toronto", region: null, province: "ON", country: "CA" },
    };
    expect(hasValidReview("assertion", edited)).toBe(false);
    // An edited HQ falls back to "unconfirmed" and the company leaves the universe.
    const result = compile(
      { ...sealed, assertions: [edited, ...sealed.assertions.slice(1)] },
      { today: TODAY },
    );
    expect(result.snapshot!.organizations.some((o) => o.id === "org_co")).toBe(false);
  });
  it("never publishes money that rests on anonymous sources", () => {
    const c = baseCorpus();
    const anon = {
      ...disc("2020-01", "single", "99000000", "cumulative_round_total"),
      evidence: ev("src_anon"),
    };
    c.rounds = [
      {
        id: "fin1",
        companyId: "org_co",
        eventState: "closed",
        roundLabelAsStated: "Series A",
        stage: "series_a",
        instrument: "equity",
        proceeds: "primary",
        participantsCompleteness: "complete",
        disclosures: [anon],
        participations: [],
        ...prov(),
      },
    ];
    const round = run(c).snapshot!.rounds[0]!;
    expect(round.resolved.status).toBe("undisclosed");
    expect(JSON.stringify(round)).not.toContain("99000000");
  });
  it("requires first-party or filing evidence for a city-level headquarters", () => {
    const c = baseCorpus();
    c.assertions[0] = { ...c.assertions[0]!, evidence: ev("src_anon") };
    expect(run(c).snapshot!.organizations.some((o) => o.id === "org_co")).toBe(false);
  });
  it("fails the build when demo and real records are mixed", () => {
    const c = baseCorpus();
    c.isDemo = false;
    const result = compile(c, { today: TODAY });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain("demo-isolation");
  });
  it("fails the build on references to unknown organizations", () => {
    const c = baseCorpus();
    c.assertions.push({ ...c.assertions[0]!, id: "a9", subjectId: "org_missing" });
    expect(run(c).failures.map((f) => f.gate)).toContain("dangling-ids");
  });
  it("fails the build when evidence cites a source that is not on file", () => {
    const c = baseCorpus();
    c.assertions.push({
      ...c.assertions[0]!,
      id: "a_unsourced",
      evidence: ev("src_never_captured"),
    });
    const result = compile(c, { today: TODAY });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain("evidence-sources");
  });
  it("fails the build on a corpus that does not match the schema", () => {
    const c = baseCorpus() as unknown as Record<string, unknown>;
    c.schemaVersion = "0.2";
    const result = compile(c as unknown as Corpus, { today: TODAY });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.gate)).toContain("schema");
  });
});

describe("supersession history (DATA_SCHEMA §7)", () => {
  const renamed = () => {
    const c = baseCorpus();
    const base = c.assertions[0]!;
    c.assertions.push(
      {
        ...base,
        id: "ln_old",
        predicate: "legal_name",
        value: "Old Name Ltd.",
        asOf: "2019-06",
        verification: "superseded",
      },
      {
        ...base,
        id: "ln_new",
        predicate: "legal_name",
        value: "New Name Inc.",
        supersedes: "ln_old",
      },
    );
    return c;
  };
  const legalName = (c: Corpus) =>
    run(c).snapshot!.organizations.find((o) => o.id === "org_co")!.legalName;

  it("shows the current value and keeps the replaced one as history with its evidence", () => {
    const c = renamed();
    const result = run(c);
    const ln = result.snapshot!.organizations.find((o) => o.id === "org_co")!.legalName;
    expect(ln.state).toBe("verified");
    expect(ln.value).toBe("New Name Inc.");
    expect(ln.history?.map((h) => h.value)).toEqual(["Old Name Ltd."]);
    expect(result.snapshot!.assertions.ln_old?.verification).toBe("superseded");
  });
  it("never shows a superseded value whose content changed after review", () => {
    const sealed = sealDemoCorpus(renamed(), TODAY);
    const old = sealed.assertions.find((a) => a.id === "ln_old")!;
    old.value = "Edited After Review Ltd.";
    const ln = compile(sealed, { today: TODAY }).snapshot!.organizations.find(
      (o) => o.id === "org_co",
    )!.legalName;
    expect(ln.value).toBe("New Name Inc.");
    expect(ln.history ?? []).toEqual([]);
  });
  it("never presents a superseded value as current, even when it is the only one", () => {
    const c = renamed();
    c.assertions = c.assertions.filter((a) => a.id !== "ln_new");
    const ln = legalName(c);
    expect(ln.value).toBeNull();
    expect(ln.state).not.toBe("verified");
  });
});

describe("edge evidence style", () => {
  const roundWith = (sourceIds: string[]): FinancingRound => ({
    id: `fin_${sourceIds.join("_")}`,
    companyId: "org_co",
    eventState: "closed",
    roundLabelAsStated: "Seed",
    stage: "seed",
    instrument: "equity",
    proceeds: "primary",
    participantsCompleteness: "complete",
    disclosures: [],
    participations: [
      {
        reportedName: "Firm",
        investorId: "org_firm",
        vehicleId: null,
        role: "lead",
        disclosureIds: [],
        ...prov(),
      },
    ],
    ...prov(),
    evidence: sourceIds.map((s) => ({
      sourceId: s,
      locator: "p1",
      locatorQuality: "body" as const,
    })),
  });
  const withNews = () => {
    const c = baseCorpus();
    c.sources.push({
      id: "src_news",
      kind: "news",
      tier: "T3",
      publisher: "Paper",
      title: "t",
      url: "https://example.invalid/n",
      publishedOn: null,
      retrievedAt: TODAY,
      originGroup: "og3",
      textSha256: null,
      sourceBasis: "named",
    });
    return c;
  };
  it("is solid when a record has a first-party source, even alongside independent reporting", () => {
    const c = withNews();
    c.rounds = [roundWith(["src_a", "src_news"])];
    expect(run(c).snapshot!.graph.lenses.capital.edges[0]!.style).toBe("solid");
  });
  it("is dashed when a record rests on independent reporting only", () => {
    const c = withNews();
    c.rounds = [roundWith(["src_news"])];
    expect(run(c).snapshot!.graph.lenses.capital.edges[0]!.style).toBe("dashed");
  });
});

describe("time view timelines", () => {
  it("dates each investor to its own tranche and links bundles to their member lines", () => {
    const c = baseCorpus();
    c.organizations.push({
      id: "org_late",
      kind: "investor_firm",
      slug: "late",
      name: "Late Firm",
      mergedInto: null,
      isDemo: true,
    });
    const first = disc("2020-06-01", "first_close", "29000000", "cumulative_round_total");
    const extension = disc("2020-09-22", "extension", "5000000", "incremental");
    const participation = (investorId: string, disclosureIds: string[]) => ({
      reportedName: investorId,
      investorId,
      vehicleId: null,
      role: "participant" as const,
      disclosureIds,
      ...prov(),
    });
    c.rounds = [
      {
        id: "fin_c",
        companyId: "org_co",
        eventState: "closed",
        roundLabelAsStated: "Series C",
        stage: "series_c",
        instrument: "equity",
        proceeds: "primary",
        participantsCompleteness: "complete",
        disclosures: [first, extension],
        participations: [
          participation("org_firm", [first.id]),
          participation("org_late", [extension.id]),
        ],
        ...prov(),
      },
    ];
    const snap = run(c).snapshot!;
    const { edges, bundles } = snap.graph.lenses.capital;
    const startOf = (investor: string) =>
      edges.find((e) => e.source === investor)!.timeline![0]!.start;
    expect(startOf("org_firm")).toBe("2020-06-01");
    expect(startOf("org_late")).toBe("2020-09-22");
    expect(
      snap.rounds[0]!.participants.find((p) => p.investorId === "org_late")!.disclosureIds,
    ).toEqual([extension.id]);
    for (const b of bundles) {
      expect(b.memberEdgeIds!.length).toBe(b.weight);
      for (const id of b.memberEdgeIds!) expect(edges.some((e) => e.id === id)).toBe(true);
    }
  });
});

describe("layout stability", () => {
  it("keeps existing positions but moves a company whose classification changed", async () => {
    const { layoutUniverse } = await import("./layout");
    const sectors = [
      { id: "tax:a", label: "A", subsectorIds: ["tax:a.1"] },
      { id: "tax:b", label: "B", subsectorIds: ["tax:b.1"] },
    ];
    const first = layoutUniverse({
      sectors,
      companies: [
        { id: "x", sectorId: "tax:a", subsectorId: "tax:a.1" },
        { id: "y", sectorId: "tax:a", subsectorId: "tax:a.1" },
      ],
    });
    const second = layoutUniverse({
      sectors,
      companies: [
        { id: "x", sectorId: "tax:a", subsectorId: "tax:a.1" },
        { id: "y", sectorId: "tax:b", subsectorId: "tax:b.1" },
        { id: "z", sectorId: "tax:a", subsectorId: "tax:a.1" },
      ],
      previous: first.companies,
    });
    expect(second.companies.x).toEqual(first.companies.x);
    expect(second.companies.y).not.toEqual(first.companies.y);
    expect(second.companies.z).not.toEqual(second.companies.x);
  });
  it("leaves all existing positions unchanged after adding 100 companies (M1 acceptance)", async () => {
    const { layoutUniverse } = await import("./layout");
    const sectors = ["a", "b", "c"].map((s) => ({
      id: `tax:${s}`,
      label: s,
      subsectorIds: [`tax:${s}.1`, `tax:${s}.2`],
    }));
    const company = (i: number) => {
      const s = ["a", "b", "c"][i % 3]!;
      return { id: `co_${i}`, sectorId: `tax:${s}`, subsectorId: `tax:${s}.${(i % 2) + 1}` };
    };
    const base = Array.from({ length: 300 }, (_, i) => company(i));
    const first = layoutUniverse({ sectors, companies: base });
    const grown = [...base, ...Array.from({ length: 100 }, (_, i) => company(300 + i))];
    const second = layoutUniverse({
      sectors,
      companies: [...grown].reverse(), // input order must not matter
      previous: first.companies,
    });
    for (const c of base) expect(second.companies[c.id]).toEqual(first.companies[c.id]);
    const taken = new Set(base.map((c) => second.companies[c.id]!.join(",")));
    for (let i = 300; i < 400; i++) {
      expect(second.companies[`co_${i}`]).toBeDefined();
      expect(taken.has(second.companies[`co_${i}`]!.join(","))).toBe(false);
    }
  });
});

describe("demo snapshot invariants", () => {
  const snap = compile(generateDemoCorpus(), { today: TODAY }).snapshot!;
  it("builds a fictional universe with every record flagged demo", () => {
    expect(snap.meta.isDemo).toBe(true);
    expect(snap.organizations.every((o) => o.isDemo)).toBe(true);
    expect(
      Object.values(snap.sources).every((s) => s.url.startsWith("https://example.invalid/")),
    ).toBe(true);
  });
  it("places every universe company identically for all lenses and backs every edge", () => {
    const companies = snap.organizations.filter((o) => o.scope === "universe");
    expect(companies.every((o) => snap.graph.positions[o.id])).toBe(true);
    const edges = [
      ...snap.graph.lenses.capital.edges,
      ...snap.graph.lenses.capital.bundles,
      ...snap.graph.lenses.contracts.edges,
    ];
    expect(edges.every((e) => e.recordIds.length > 0)).toBe(true);
  });
  it("accounts for every discovered company outside the universe, by reason", () => {
    const c = snap.coverage;
    const n = c.notInUniverse;
    expect(n.excluded + n.undecided + n.awaitingEvidence).toBe(
      c.companiesDiscovered - c.inUniverse,
    );
    expect(c.eligibilityDecided).toBeLessThanOrEqual(c.companiesDiscovered);
    expect(c.eligibilityDecided).toBe(c.companiesDiscovered - n.undecided);
  });
  it("exercises independent-reporting-only (dashed) edges in both relationship lenses", () => {
    expect(snap.graph.lenses.capital.edges.some((e) => e.style === "dashed")).toBe(true);
    expect(snap.graph.lenses.contracts.edges.some((e) => e.style === "dashed")).toBe(true);
  });
  it("bundles government relationships per family and never mixes grants with procurement", () => {
    const bundles = snap.graph.lenses.contracts.bundles;
    expect(bundles.length).toBeGreaterThan(0);
    const agreementFamily = new Map(snap.agreements.map((g) => [g.id, g.family]));
    for (const b of bundles) {
      expect(b.target.startsWith("anchor:")).toBe(true);
      const expected = b.family === "procurement" ? "procurement" : "grant_contribution";
      expect(b.recordIds.every((id) => agreementFamily.get(id) === expected)).toBe(true);
    }
  });
  it("includes an other-transfer agreement that is listed but never drawn", () => {
    const view = snap.agreements.find((g) => g.family === "other_transfer");
    expect(view).toBeTruthy();
    expect(view!.sourceClassification?.code).toBe("O");
    const drawn = new Set(
      [...snap.graph.lenses.contracts.edges, ...snap.graph.lenses.contracts.bundles].flatMap(
        (e) => e.recordIds,
      ),
    );
    expect(drawn.has(view!.id)).toBe(false);
    expect(snap.coverage.agreements.otherTransfers).toBe(1);
  });
  it("keeps positions stable when the previous layout is supplied", () => {
    const positions = Object.fromEntries(
      Object.entries(snap.graph.positions).filter(([id]) => !id.includes(":")),
    );
    const again = compile(generateDemoCorpus({ companies: 400 }), {
      today: TODAY,
      previousPositions: positions,
    }).snapshot!;
    for (const id of Object.keys(positions).slice(0, 50)) {
      if (again.graph.positions[id]) expect(again.graph.positions[id]).toEqual(positions[id]);
    }
  });
});

describe("verification basis and the share build (D-21)", () => {
  const licensed = (c: Corpus) => {
    c.sources.push({
      ...c.sources[0]!,
      id: "src_pb",
      kind: "licensed_database",
      tier: "T3",
      publisher: "Fictional Licensed DB",
      url: "https://example.invalid/pb",
      originGroup: "og_pb",
    });
    c.assertions.push({
      ...c.assertions[0]!,
      id: "a_founded",
      predicate: "founded_year",
      value: 2015,
      primary: false,
      evidence: [{ sourceId: "src_pb", locator: "profile, founded", locatorQuality: "body" }],
    });
    return c;
  };

  it("labels each published record with how it was verified", () => {
    const sealed = sealDemoCorpus(baseCorpus(), TODAY);
    const a1 = sealed.assertions.find((a) => a.id === "a1")!;
    a1.review = {
      ...a1.review!,
      basis: { kind: "tier2_source_check", rule: "tiers@1", batch: null },
    };
    const snap = compile(sealed, { today: TODAY }).snapshot!;
    expect(snap.verification?.a1).toMatchObject({ kind: "tier2_source_check", at: TODAY });
    expect(snap.verification?.a1?.label).toMatch(/^Confirmed in Co's t; independently re-found/);
    // A review without a basis is an owner record.
    const other = Object.entries(snap.verification ?? {}).find(([id]) => id !== "a1")!;
    expect(other[1].kind).toBe("owner_record");
    expect(snap.meta.audience).toBeUndefined();
  });

  it("withholds a claim whose only sources are licensed, and says so in the share build", () => {
    const sealed = sealDemoCorpus(licensed(baseCorpus()), TODAY);
    const priv = compile(sealed, { today: TODAY }).snapshot!;
    const share = compile(sealed, { today: TODAY, audience: "share" }).snapshot!;
    const org = (s: typeof priv) => s.organizations.find((o) => o.id === "org_co")!;
    expect(org(priv).founded).toMatchObject({ state: "verified", value: 2015 });
    expect(priv.verification?.a_founded?.kind).toBe("licensed");
    expect(org(share).founded).toMatchObject({ state: "withheld", value: null });
    expect(share.meta.audience).toBe("share");
    expect(share.withheldByOrg).toEqual({ org_co: 1 });
    expect(share.assertions.a_founded).toBeUndefined();
    // Public sources are shared by default; an explicit denial withholds them too.
    sealed.sources[0]!.permissions = {
      capture: "unknown",
      retainInternal: "unknown",
      quoteInternal: "unknown",
      redistributeExcerpt: "unknown",
      automatedCollection: "unknown",
      attributionRequired: null,
      basis: null,
      termsReviewedAt: null,
      shareDerivedData: "denied",
    };
    const denied = compile(sealed, { today: TODAY, audience: "share" }).snapshot;
    expect(denied?.organizations.find((o) => o.id === "org_co")).toBeUndefined();
  });

  it("marks a preview and shows draft labels instead of a basis", () => {
    const sealed = sealDemoCorpus(baseCorpus(), TODAY);
    const snap = compile(sealed, {
      today: TODAY,
      draftLabels: { a1: "Unverified draft" },
    }).snapshot!;
    expect(snap.meta.preview).toBe(true);
    expect(snap.verification?.a1).toEqual({ kind: "draft", at: null, label: "Unverified draft" });
  });
});

describe("rule (b): a single value with a past validTo is history, not a dispute", () => {
  const withNames = (oldValidTo: string | null) => {
    const c = baseCorpus();
    const base = c.assertions[0]!;
    c.assertions.push(
      {
        ...base,
        id: "a_name_now",
        predicate: "legal_name",
        value: "Co Robotics Inc.",
        primary: false,
      },
      {
        ...base,
        id: "a_name_old",
        predicate: "legal_name",
        value: "Co Sonar Inc.",
        primary: false,
        validTo: oldValidTo,
      },
    );
    return compile(sealDemoCorpus(c, TODAY), { today: TODAY }).snapshot!.organizations.find(
      (o) => o.id === "org_co",
    )!.legalName;
  };
  it("shows the current name and lists the former one with its end date", () => {
    const f = withNames("2017-09-20");
    expect(f.state).toBe("verified");
    expect(f.value).toBe("Co Robotics Inc.");
    expect(f.history).toEqual([
      {
        value: "Co Sonar Inc.",
        assertionIds: ["a_name_old"],
        asOf: null,
        replacedOn: "2017-09-20",
      },
    ]);
  });
  it("still reports a dispute when neither value has ended", () => {
    expect(withNames(null).state).toBe("disputed");
  });
});

describe("defect 4: acquisitions by a universe company are published", () => {
  it("lists a non-universe target on the acquirer's side, behind the same review gate", () => {
    const c = baseCorpus();
    c.organizations.push({
      id: "org_tgt",
      kind: "company",
      slug: "tgt",
      name: "Target Co",
      mergedInto: null,
      isDemo: true,
    });
    c.acquisitions.push({
      id: "acq_co_tgt",
      targetId: "org_tgt",
      acquirerId: "org_co",
      history: [{ state: "completed", date: "2021-08-03" }],
      consideration: { amount: null, currency: "unknown", disclosure: "undisclosed", asStated: "" },
      reportedConsideration: [],
      ...prov(),
    });
    const snap = compile(sealDemoCorpus(c, TODAY), { today: TODAY }).snapshot!;
    expect(snap.acquisitions.map((q) => q.id)).toContain("acq_co_tgt");
    expect(snap.organizations.find((o) => o.id === "org_tgt")).toBeDefined();
    // Unreviewed, it stays out.
    const unreviewed = compile(
      {
        ...sealDemoCorpus(c, TODAY),
        acquisitions: c.acquisitions.map((q) => ({ ...q, review: null })),
      },
      { today: TODAY },
    ).snapshot!;
    expect(unreviewed.acquisitions.map((q) => q.id)).not.toContain("acq_co_tgt");
  });
});
