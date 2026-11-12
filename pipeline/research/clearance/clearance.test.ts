/**
 * Clearance policy tests. Every company, name, number and amount here is fictional.
 * The adversarial cases are the point: unanimous but unsupported AI answers, an AI contradicting
 * an official record, harmless wording differences, incomplete lists, entity confusion through a
 * legal element, tranches recorded as totals, duplicates, and judgement records that must never
 * clear.
 */
import { describe, expect, it } from "vitest";
import type { Corpus } from "../../../src/domain/schema/corpus";
import type { Inventory, InventoryItem, Worksheet } from "../blind";
import type { TierRecord } from "../tiers/rules";
import { fact, ORG, round, source } from "../tiers/fixture.test-helpers";
import { duplicateRounds, legalFormClass, legalFormRisks, roundNormalization } from "./checks";
import { chapman, sameEvent } from "./completeness";
import { QC } from "./policy";
import { qcSample } from "./qc";
import { formOf, nameKey, relate, type ClaimView, type FindingView } from "./relate";
import { decisionGroups, routeRecords, type ClearanceRecord, type RouteInputs } from "./route";
import { ingestAnswer, packageFromAnswer, promptBody } from "./tasks";

const claim = (fieldId: string, tokens: string[], over: Partial<ClaimView> = {}): ClaimView => ({
  fieldId,
  tokens,
  entityKeys: new Set(["fictionalalpha"]),
  siblingKeys: new Set(),
  entityForms: new Map([["fictionalalpha", new Set(["inc"])]]),
  historical: false,
  ...over,
});
const finding = (text: string, over: Partial<FindingView> = {}): FindingView => ({
  status: "found",
  text,
  entityName: null,
  finding: null,
  ...over,
});

describe("relate: telling wording, incompleteness, other entities and real conflicts apart", () => {
  it("treats a differently formatted amount as support", () => {
    expect(relate(claim("C02", ["~920e5"]), finding("The Series A raised US$92 million."))).toBe(
      "supports",
    );
    expect(
      relate(claim("A04", ["12345678"]), finding("Corporation number 1234567-8, active.")),
    ).toBe("supports");
  });
  it("calls a list that omits one investor silent, not a contradiction", () => {
    expect(
      relate(claim("C03", ["northwindcapital"]), finding("Investors included Bluefin Ventures.")),
    ).toBe("silent");
    expect(relate(claim("D01", ["northwindcapital"]), finding("Counterparty: Example Bank."))).toBe(
      "silent",
    );
  });
  it("recognizes another legal entity, including the same name with a different legal element", () => {
    expect(
      relate(
        claim("A04", ["12345678"]),
        finding("Fictional Alpha Engineering Inc. is corporation 7654321."),
      ),
    ).toBe("other_entity");
    expect(
      relate(claim("A02", ["fictionalalphainc"]), finding("The company is Fictional Alpha Ltd.")),
    ).toBe("other_entity");
    expect(formOf("Fictional Alpha Ltd.")).toBe("ltd");
    expect(nameKey("Fictional Alpha Inc.")).toBe("fictionalalpha");
  });
  it("recognizes another period", () => {
    expect(
      relate(
        claim("A02", ["oldnamecorp"], { historical: true }),
        finding("The current legal name is Fictional Alpha Inc."),
      ),
    ).not.toBe("contradicts");
  });
  it("flags a real conflict: a different founding year for the same entity", () => {
    expect(
      relate(claim("A08", ["2015"]), finding("Fictional Alpha was founded in 2012 in Ottawa.")),
    ).toBe("contradicts");
  });
  it("does not read an incorporation or registry anniversary date as a founding year", () => {
    expect(relate(claim("A08", ["2015"]), finding("The registry anniversary date is 2017."))).toBe(
      "silent",
    );
    expect(relate(claim("A08", ["2015"]), finding("It was incorporated federally in 2018."))).toBe(
      "silent",
    );
  });
  it("never turns a judgement field without a comparable value into a disagreement", () => {
    expect(relate(claim("B06", []), finding("The company appears eligible."))).toBe("silent");
    expect(relate(claim("B01", ["taxspaceeo"]), finding("Best fit: tax:sensors.optical"))).toBe(
      "judgement_differs",
    );
  });
  it("ignores not-found findings", () => {
    expect(relate(claim("A08", ["2015"]), finding("Nothing found.", { status: "not_found" }))).toBe(
      "no_finding",
    );
  });
});

describe("completeness", () => {
  it("matches events by amount, or by date at the precision both sides have", () => {
    expect(
      sameEvent(
        { when: "2021-06", amounts: ["~600e5"], label: "" },
        { when: "2021", amounts: ["~600e5"], label: "" },
      ),
    ).toBe(true);
    expect(
      sameEvent(
        { when: "2021-06", amounts: [], label: "" },
        { when: "2021", amounts: [], label: "" },
      ),
    ).toBe(true);
    expect(
      sameEvent(
        { when: "2021-06", amounts: ["~600e5"], label: "" },
        { when: "2021-06", amounts: ["~500e5"], label: "" },
      ),
    ).toBe(false);
  });
  it("estimates unseen events from two overlapping inventories", () => {
    // Both list 3, all 3 shared: no evidence of unseen events beyond 3.
    expect(chapman(3, 3, 3)).toBe(3);
    // Little overlap: probably more events than anyone found.
    expect(chapman(4, 4, 1)).toBeGreaterThan(4);
  });
});

describe("deterministic checks", () => {
  it("compares legal elements by class", () => {
    expect(legalFormClass("Fictional Alpha Incorporated")).toBe("inc");
    expect(legalFormClass("FICTIONAL ALPHA LTÉE")).toBe("ltd");
    expect(legalFormClass("Fictional Alpha")).toBeNull();
  });
  it("flags a cited row naming the predecessor (same name, different legal element)", () => {
    const rows = {
      contracts: new Map([
        [
          "C-FICT-1",
          [{ reference_number: "C-FICT-1", vendor_name: "FICTIONAL ALPHA INC." } as never],
        ],
      ]),
      grants: new Map(),
    };
    const risks = legalFormRisks(
      [
        {
          sourceId: "src_54baa50305c0",
          locator: "reference_number=C-FICT-1",
          locatorQuality: "metadata",
        },
      ],
      rows,
      ["Fictional Alpha", "Fictional Alpha Ltd."],
    );
    expect(risks).toHaveLength(1);
    expect(risks[0]!.rowName).toBe("FICTIONAL ALPHA INC.");
  });
  it("catches a tranche recorded as the round total, a missing currency, two finals and a future date", () => {
    const r = round("fin_fict", "src_a");
    r.disclosures = [
      {
        ...r.disclosures[0]!,
        id: "d1",
        date: "2024-01-10",
        kind: "first_close",
        amount: { ...r.disclosures[0]!.amount, amount: "10000000" },
      },
      {
        ...r.disclosures[0]!,
        id: "d2",
        date: "2024-06-10",
        kind: "final",
        amount: { ...r.disclosures[0]!.amount, amount: "4000000" },
      },
      {
        ...r.disclosures[0]!,
        id: "d3",
        date: "2099-01-01",
        kind: "final",
        amount: { ...r.disclosures[0]!.amount, currency: "unknown", asStated: "$12 million" },
      },
    ];
    const p = roundNormalization(r, "2026-10-20").join(" | ");
    expect(p).toMatch(/tranche/);
    expect(p).not.toMatch(/currency/); // d3's bare "$" with an unknown currency is legitimate
    const named = round("fin_named", "src_a");
    named.disclosures = [
      {
        ...named.disclosures[0]!,
        amount: { ...named.disclosures[0]!.amount, currency: "unknown", asStated: "US$12 million" },
      },
    ];
    expect(roundNormalization(named, "2026-10-20").join(" ")).toMatch(/names a currency/);
    expect(p).toMatch(/more than one final/);
    expect(p).toMatch(/future/);
  });
  it("finds a likely duplicate round", () => {
    const a = round("fin_a", "src_a");
    const b = { ...round("fin_b", "src_a") };
    b.disclosures = [{ ...b.disclosures[0]!, date: "2024-06-20" }];
    const corpus = { rounds: [a, b] } as unknown as Corpus;
    expect(duplicateRounds(a, corpus)[0]).toMatch(/fin_b/);
  });
});

// ---- Routing scenarios ----------------------------------------------------------------------

function corpusWith(over: Partial<Corpus>): Corpus {
  return {
    schemaVersion: "0.3",
    isDemo: true,
    taxonomy: [],
    sources: [],
    organizations: [
      {
        id: ORG,
        kind: "company",
        slug: "fict-alpha",
        name: "Fictional Alpha",
        mergedInto: null,
        isDemo: true,
      },
    ],
    assertions: [],
    rounds: [],
    agreements: [],
    acquisitions: [],
    programs: [],
    research: [],
    ...over,
  } as Corpus;
}

function tierRecord(
  id: string,
  kind: TierRecord["kind"],
  over: Partial<TierRecord> = {},
): TierRecord {
  return {
    id,
    kind,
    orgId: ORG,
    hash: "h".repeat(64),
    tier: 2,
    status: "pass",
    route: "all rules passed",
    rules: [
      { rule: "T2-a", result: "pass", reason: "T1/T2" },
      { rule: "T2-b", result: "pass", reason: "captured" },
      { rule: "T2-c", result: "pass", reason: "found" },
      { rule: "T2-d", result: "pass", reason: "evidence rule" },
      { rule: "T2-f", result: "pass", reason: "no dispute" },
    ],
    dependsOn: [],
    sources: [],
    values: [
      {
        part: "value",
        kind: "year",
        value: "2015",
        found: true,
        sourceId: "src_reg",
        captureId: "cap_src_reg",
        offset: 10,
      },
    ],
    ...over,
  };
}

function item(recordId: string, fieldId: string, value: string): InventoryItem {
  return {
    claimId: `X01:${fieldId}:${recordId}`,
    card: "X01",
    orgSlug: "fict-alpha",
    entity: "Fictional Alpha",
    fieldId,
    kind: "base",
    label: fieldId,
    value,
    valueHash: "v",
    recordIds: [recordId],
    matchKeys: [],
    shownIn: [],
    publishes: true,
    note: null,
    citations: [],
    outcome: "not_yet_evaluated",
  };
}

function inputs(
  corpus: Corpus,
  tiers: TierRecord[],
  items: InventoryItem[],
  cands: Record<string, { researcher: string; claim: string; sameAsCandefSource?: boolean }[]>,
  captureText = "Fictional Alpha Inc. was founded in 2015.",
): RouteInputs {
  const ws: Worksheet = {
    generatedAt: "",
    inventoryGeneratedAt: "",
    packages: [],
    newFindings: [],
    rows: items.map((it) => ({
      claimId: it.claimId,
      card: it.card,
      fieldId: it.fieldId,
      kind: "base",
      entity: it.entity,
      label: it.label,
      value: it.value,
      valueHash: "v",
      candidates: (cands[it.claimId] ?? []).map((c, i) => ({
        usable: true,
        independent: true,
        researcher: c.researcher,
        findingId: `F${i}`,
        status: "found",
        claim: c.claim,
        origins: [],
        sameAsCandefSource: c.sameAsCandefSource ?? false,
        score: 1,
      })),
      distinctIndependentOrigins: 1,
      signal: "consistent",
      outcome: "not_yet_evaluated",
      evaluation: null,
    })),
  };
  const inv = { items } as Inventory;
  return {
    corpus,
    today: "2026-10-20",
    tiers,
    worksheet: ws,
    inventory: inv,
    packages: [],
    exposed: new Set(),
    rows: null,
    readCapture: () => captureText.toLowerCase(),
    reads: new Map(),
    cards: [
      {
        card: "X01",
        name: "Fictional Alpha",
        website: "https://alpha.invalid/",
        orgSlugs: ["fict-alpha"],
      },
    ],
    attempts: new Map(),
  };
}

const stateOf = (rs: ClearanceRecord[], id: string) => rs.find((r) => r.id === id)!.state;

describe("routing scenarios", () => {
  const reg = source("src_reg", { tier: "T1", kind: "registry" });
  const page = source("src_page", {
    tier: "T2",
    kind: "company_site" as never,
    url: "https://alpha.invalid/about",
  });

  it("clears a founding year found in a saved first-party copy and confirmed by an independent researcher", () => {
    const a = fact("asr_founded", "founded_year", 2015, "src_page");
    const corpus = corpusWith({ sources: [page], assertions: [a] });
    const it1 = item("asr_founded", "A08", "2015");
    const rs = routeRecords(
      inputs(
        corpus,
        [
          tierRecord("asr_founded", "assertion", {
            values: [
              {
                part: "value",
                kind: "year",
                value: "2015",
                found: true,
                sourceId: "src_page",
                captureId: "cap_src_page",
                offset: 1,
              },
            ],
          }),
        ],
        [it1],
        { [it1.claimId]: [{ researcher: "R-x", claim: "It says it was founded in 2015." }] },
      ),
    );
    expect(stateOf(rs, "asr_founded")).toBe("cleared");
  });

  it("does not clear unanimous AI agreement when the saved copy does not hold the value", () => {
    const a = fact("asr_founded", "founded_year", 2015, "src_page");
    const corpus = corpusWith({ sources: [page], assertions: [a] });
    const it1 = item("asr_founded", "A08", "2015");
    const t = tierRecord("asr_founded", "assertion", {
      rules: [
        { rule: "T2-a", result: "pass", reason: "" },
        { rule: "T2-b", result: "pass", reason: "" },
        { rule: "T2-c", result: "fail", reason: 'not found in a cited capture: value "2015"' },
        { rule: "T2-d", result: "pass", reason: "" },
      ],
      values: [
        {
          part: "value",
          kind: "year",
          value: "2015",
          found: false,
          sourceId: null,
          captureId: null,
          offset: null,
        },
      ],
    });
    const rs = routeRecords(
      inputs(corpus, [t], [it1], {
        [it1.claimId]: [
          { researcher: "R-x", claim: "Founded in 2015." },
          { researcher: "R-y", claim: "Founded 2015." },
        ],
      }),
    );
    expect(stateOf(rs, "asr_founded")).not.toBe("cleared");
    expect(rs[0]!.homework.map((h) => h.kind)).toContain("reread-copy");
  });

  it("lets a saved official record outweigh an AI that cites no official source", () => {
    const a = fact(
      "asr_reg",
      "registry_id",
      { system: "corporations-canada", value: "1234567-8" },
      "src_reg",
    );
    const corpus = corpusWith({ sources: [reg], assertions: [a] });
    const it1 = item(
      "asr_reg",
      "A04",
      JSON.stringify({ system: "corporations-canada", value: "1234567-8" }),
    );
    const t = tierRecord("asr_reg", "assertion", {
      values: [
        {
          part: "value",
          kind: "identifier",
          value: "1234567-8",
          found: true,
          sourceId: "src_reg",
          captureId: "cap_src_reg",
          offset: 1,
        },
      ],
    });
    const rs = routeRecords(
      inputs(
        corpus,
        [t],
        [it1],
        { [it1.claimId]: [{ researcher: "R-x", claim: "Its corporation number is 9999999." }] },
        "Corporate name: Fictional Alpha Inc. Corporation number: 1234567-8",
      ),
    );
    expect(stateOf(rs, "asr_reg")).toBe("cleared");
    expect(rs[0]!.checks.find((c) => c.id === "V-con")!.reason).toMatch(/cite no official source/);
  });

  it("never clears a judgement record, however strong its evidence", () => {
    const a = fact("asr_elig", "eligibility", { decision: "included", rationale: "x" }, "src_reg", {
      epistemic: "analyst_interpretation",
    });
    const corpus = corpusWith({ sources: [reg], assertions: [a] });
    const rs = routeRecords(
      inputs(
        corpus,
        [
          tierRecord("asr_elig", "assertion", {
            tier: 3,
            status: "judgement",
            route: "CANDEF assessment (eligibility)",
            rules: [],
          }),
        ],
        [],
        {},
      ),
    );
    expect(stateOf(rs, "asr_elig")).toBe("needs_owner");
    expect(decisionGroups(rs, corpus)[0]!.kind).toBe("scope");
  });

  it("holds a value whose copy names a different legal element of the same name for the owner (entity question)", () => {
    const a = fact(
      "asr_city",
      "hq_location",
      { city: "Ottawa", province: "ON", country: "CA" },
      "src_page",
    );
    const legal = fact("asr_legal", "legal_name", "Fictional Alpha Ltd.", "src_reg");
    const corpus = corpusWith({ sources: [page, reg], assertions: [a, legal] });
    const t = tierRecord("asr_city", "assertion", {
      values: [
        {
          part: "city",
          kind: "city",
          value: "Ottawa",
          found: true,
          sourceId: "src_page",
          captureId: "cap_src_page",
          offset: 1,
        },
      ],
    });
    // The copy names only "Other Corp", not Fictional Alpha, and is not the company's site.
    const other = { ...page, url: "https://news.invalid/story" };
    const rs = routeRecords(
      inputs(
        { ...corpus, sources: [other, reg] },
        [t],
        [],
        {},
        "Other Corp opened an office in Ottawa.",
      ),
    );
    expect(stateOf(rs, "asr_city")).toBe("needs_owner");
    expect(rs[0]!.group?.kind).toBe("identity");
  });

  it("sends a founding year taken only from a registry incorporation date to one method question", () => {
    const a = fact("asr_founded", "founded_year", 2015, "src_reg");
    a.evidence = [
      {
        sourceId: "src_reg",
        locator: "overview, governing legislation date",
        locatorQuality: "body",
        captureId: "cap_src_reg",
      },
    ];
    const corpus = corpusWith({ sources: [reg], assertions: [a] });
    const rs = routeRecords(
      inputs(
        corpus,
        [tierRecord("asr_founded", "assertion")],
        [],
        {},
        "corporate name: fictional alpha inc. status: active governing legislation: 2015-03-01",
      ),
    );
    // P-62 settled it: the system looks for a business-start source; no question for the owner.
    expect(stateOf(rs, "asr_founded")).toBe("homework");
    expect(rs[0]!.homework.find((h) => h.kind === "find-original")!.reason).toMatch(/P-62/);
    expect(decisionGroups(rs, corpus)).toHaveLength(0);
  });

  it("lets a registered office stand as a location only after the search for a first-party statement (P-63)", () => {
    const loc = (locator: string) => {
      const a = fact(
        "asr_loc",
        "operations_location",
        { city: "Ottawa", province: "ON", country: "CA" },
        "src_reg",
      );
      a.evidence = [
        { sourceId: "src_reg", locator, locatorQuality: "body", captureId: "cap_src_reg" },
      ];
      return a;
    };
    const t = tierRecord("asr_loc", "assertion", {
      values: [
        {
          part: "city",
          kind: "city",
          value: "Ottawa",
          found: true,
          sourceId: "src_reg",
          captureId: "cap_src_reg",
          offset: 1,
        },
      ],
    });
    const text =
      "corporate name: fictional alpha inc. status: active registered office address 1 main st ottawa on";
    const cands = (it: InventoryItem) => ({
      [it.claimId]: [{ researcher: "R-x", claim: "Its office is in Ottawa." }],
    });
    const it1 = item("asr_loc", "A07", JSON.stringify({ city: "Ottawa" }));
    // Before the search: homework.
    const before = routeRecords(
      inputs(
        corpusWith({ sources: [reg], assertions: [loc("registered office address")] }),
        [t],
        [it1],
        cands(it1),
        text,
      ),
    );
    expect(stateOf(before, "asr_loc")).toBe("homework");
    // Search done, nothing first-party found: the registered office stands, labelled.
    const inp = inputs(
      corpusWith({ sources: [reg], assertions: [loc("registered office address")] }),
      [t],
      [it1],
      cands(it1),
      text,
    );
    inp.attempts.set("asr_loc|find-original", 2);
    const after = routeRecords(inp);
    expect(stateOf(after, "asr_loc")).toBe("cleared");
    expect(after[0]!.flags.join(" ")).toMatch(/registered office/);
    // A dateline never stands alone: held once the search is done.
    const inp2 = inputs(
      corpusWith({ sources: [reg], assertions: [loc("dateline")] }),
      [t],
      [it1],
      cands(it1),
      text,
    );
    inp2.attempts.set("asr_loc|find-original", 2);
    expect(stateOf(routeRecords(inp2), "asr_loc")).toBe("insufficient");
  });

  it("does not accept a registry page about another corporation (a predecessor) as this entity's evidence", () => {
    const a = fact(
      "asr_reg",
      "registry_id",
      { system: "corporations-canada", value: "1234567-8" },
      "src_reg",
    );
    const corpus = corpusWith({ sources: [reg], assertions: [a] });
    const t = tierRecord("asr_reg", "assertion", {
      values: [
        {
          part: "value",
          kind: "identifier",
          value: "1234567-8",
          found: true,
          sourceId: "src_reg",
          captureId: "cap_src_reg",
          offset: 1,
        },
      ],
    });
    const rs = routeRecords(
      inputs(
        corpus,
        [t],
        [],
        {},
        "corporate name: fictional alpha sonar systems inc. status: inactive corporation number: 1234567-8",
      ),
    );
    expect(stateOf(rs, "asr_reg")).toBe("needs_owner");
    expect(rs[0]!.checks.find((c) => c.id === "V-ent")!.reason).toMatch(/another corporation/);
  });

  it("clears a value on a no-copy site through a matching one-time read (P-61), and not once the record changes", () => {
    const nocopy = source("src_nocopy", {
      tier: "T2",
      url: "https://alpha.invalid/about",
      permissions: { capture: "denied" } as never,
    });
    const a = fact("asr_founded", "founded_year", 2015, "src_nocopy");
    const corpus = corpusWith({ sources: [nocopy], assertions: [a] });
    const t = tierRecord("asr_founded", "assertion", {
      rules: [
        { rule: "T2-a", result: "pass", reason: "" },
        { rule: "T2-b", result: "fail", reason: "src_nocopy: capture permission denied" },
        { rule: "T2-c", result: "fail", reason: 'not found in a cited capture: value "2015"' },
        { rule: "T2-d", result: "pass", reason: "" },
      ],
      values: [
        {
          part: "value",
          kind: "year",
          value: "2015",
          found: false,
          sourceId: null,
          captureId: null,
          offset: null,
        },
      ],
    });
    const it1 = item("asr_founded", "A08", "2015");
    const cands = { [it1.claimId]: [{ researcher: "R-x", claim: "Founded in 2015." }] };
    const withRead = (hash: string) => {
      const inp = inputs(corpus, [t], [it1], cands);
      inp.reads = new Map([
        [
          "src_nocopy",
          {
            format: "candef-verification-read",
            version: 1,
            sourceId: "src_nocopy",
            url: "https://alpha.invalid/about",
            readAt: "2026-10-20T00:00:00Z",
            method: "http",
            httpStatus: 200,
            rawSha256: "a".repeat(64),
            textSha256: "b".repeat(64),
            textLength: 100,
            entityNamed: { [ORG]: "Fictional Alpha" },
            records: {
              asr_founded: {
                hash,
                parts: [{ part: "value", kind: "year", value: "2015", found: true, offset: 5 }],
              },
            },
          },
        ],
      ]);
      return inp;
    };
    const none = routeRecords(inputs(corpus, [t], [it1], cands));
    expect(stateOf(none, "asr_founded")).toBe("homework");
    expect(none[0]!.homework.map((h) => h.kind)).toContain("verification-read");
    const ok = routeRecords(withRead(t.hash));
    expect(stateOf(ok, "asr_founded")).toBe("cleared");
    expect(ok[0]!.checks.find((c) => c.id === "V-copy")!.reason).toMatch(/one-time read/);
    expect(ok[0]!.homework).toHaveLength(0);
    // A read of an older version of the record does not count.
    expect(stateOf(routeRecords(withRead("f".repeat(64))), "asr_founded")).toBe("homework");
  });

  it("does not count a dataset row against the saved-copy check of a page that holds the value", () => {
    const dataset = source("src_06a51c1749c5", {
      kind: "gov_dataset",
      tier: "T1",
      captures: [],
      url: "https://open.canada.ca/data/grants",
    });
    const a = fact(
      "asr_city",
      "hq_location",
      { city: "Ottawa", province: "ON", country: "CA" },
      "src_page",
    );
    a.evidence.push({
      sourceId: "src_06a51c1749c5",
      locator: "ref_number=X (recipient_postal_code)",
      locatorQuality: "metadata",
    });
    const corpus = corpusWith({ sources: [page, dataset], assertions: [a] });
    const t = tierRecord("asr_city", "assertion", {
      rules: [
        { rule: "T2-a", result: "pass", reason: "" },
        { rule: "T2-b", result: "fail", reason: "src_06a51c1749c5: evidence names no capture" },
        { rule: "T2-c", result: "pass", reason: "2 key value(s) found in cited captures" },
        { rule: "T2-d", result: "pass", reason: "" },
      ],
      values: [
        {
          part: "city",
          kind: "city",
          value: "Ottawa",
          found: true,
          sourceId: "src_page",
          captureId: "cap_src_page",
          offset: 1,
        },
        {
          part: "province",
          kind: "province",
          value: "ON",
          found: true,
          sourceId: "src_page",
          captureId: "cap_src_page",
          offset: 9,
        },
      ],
    });
    const it1 = item("asr_city", "A06", JSON.stringify({ city: "Ottawa", province: "ON" }));
    const cands = { [it1.claimId]: [{ researcher: "R-x", claim: "Headquartered in Ottawa." }] };
    const ok = routeRecords(
      inputs(corpus, [t], [it1], cands, "Fictional Alpha is based in Ottawa, ON."),
    );
    expect(ok[0]!.checks.find((c) => c.id === "V-copy")!.result).toBe("pass");
    // A page source that fails still fails the check.
    const t2 = {
      ...t,
      rules: t.rules.map((r) =>
        r.rule === "T2-b" ? { ...r, reason: "src_page: capture permission denied" } : r,
      ),
    };
    const bad = routeRecords(inputs(corpus, [t2], [it1], {}));
    expect(bad[0]!.checks.find((c) => c.id === "V-copy")!.result).toBe("fail");
  });

  it("turns a missing independent check into system homework, not an owner decision", () => {
    const a = fact("asr_founded", "founded_year", 2015, "src_page");
    const corpus = corpusWith({ sources: [page], assertions: [a] });
    const rs = routeRecords(
      inputs(
        corpus,
        [
          tierRecord("asr_founded", "assertion", {
            values: [
              {
                part: "value",
                kind: "year",
                value: "2015",
                found: true,
                sourceId: "src_page",
                captureId: "cap_src_page",
                offset: 1,
              },
            ],
          }),
        ],
        [],
        {},
      ),
    );
    expect(stateOf(rs, "asr_founded")).toBe("homework");
    expect(rs[0]!.homework[0]!.kind).toBe("blind-task");
    expect(decisionGroups(rs, corpus)).toHaveLength(0);
  });

  it("holds a record once its homework budget is used up, without asking the owner", () => {
    const a = fact("asr_founded", "founded_year", 2015, "src_page");
    const corpus = corpusWith({ sources: [page], assertions: [a] });
    const inp = inputs(
      corpus,
      [
        tierRecord("asr_founded", "assertion", {
          values: [
            {
              part: "value",
              kind: "year",
              value: "2015",
              found: true,
              sourceId: "src_page",
              captureId: "cap_src_page",
              offset: 1,
            },
          ],
        }),
      ],
      [],
      {},
    );
    inp.attempts.set("asr_founded|blind-task", 2);
    const rs = routeRecords(inp);
    expect(stateOf(rs, "asr_founded")).toBe("insufficient");
    expect(decisionGroups(rs, corpus)).toHaveLength(0);
  });
});

describe("quality-control sample", () => {
  it("is deterministic for a seed and fills the calibration cap", () => {
    const recs = Array.from(
      { length: 60 },
      (_, i) =>
        ({
          id: `r${i}`,
          state: "cleared",
          cls: i % 2 ? "K1" : "K2",
          checks: [],
          relations: [],
          conditionalOn: [],
        }) as unknown as ClearanceRecord,
    );
    const corpus = corpusWith({});
    const a = qcSample(recs, corpus, "seed").map((p) => p.id);
    const b = qcSample(recs, corpus, "seed").map((p) => p.id);
    expect(a).toEqual(b);
    expect(a).toHaveLength(QC.cap);
    expect(qcSample(recs, corpus, "other").map((p) => p.id)).not.toEqual(a);
  });
});

describe("bring-your-own-AI tasks", () => {
  const pkg = {
    package_version: "candef-blind-v2",
    researcher: {
      id: "R-TOOL-20261020",
      model_or_tool: "Fictional model",
      browsing: true,
      limitations: [],
    },
    company: {
      card_id: "X01",
      name_as_given: "Fictional Alpha",
      website_as_given: "https://alpha.invalid/",
    },
    entities: [],
    findings: [],
  };
  it("reads a package split into PART blocks", () => {
    const s = JSON.stringify(pkg);
    const text = `PART 1 OF 2\n\`\`\`json\n${s.slice(0, 40)}\n\`\`\`\nPART 2 OF 2\n\`\`\`json\n${s.slice(40)}\n\`\`\``;
    expect(packageFromAnswer(text)).toMatchObject({ package_version: "candef-blind-v2" });
  });
  it("stamps the researcher ID from the tool name and refuses Claude", () => {
    const text = "```json\n" + JSON.stringify(pkg) + "\n```";
    const ok = ingestAnswer(text, "Gemini", "2026-10-20", "X01");
    expect(ok.researcherId).toBe("R-gemini-20261020");
    expect(ok.card).toBe("X01");
    expect(ingestAnswer(text, "Claude", "2026-10-20", null).ok).toBe(false);
    expect(ingestAnswer(text, "Gemini", "2026-10-20", "X02").errors[0]).toMatch(/card X01/);
  });
  it("drops an old run header from a reused prompt", () => {
    expect(promptBody("# Run instructions\nold\n<!-- Generated by x -->\nbody")).toBe(
      "<!-- Generated by x -->\nbody",
    );
  });
});
