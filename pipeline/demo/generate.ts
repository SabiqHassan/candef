/**
 * Fictional demonstration corpus generator.
 *
 * Every organization, person, amount and source produced here is FICTIONAL. Sources use the
 * reserved `example.invalid` domain so no URL can resolve to a real page. The corpus is flagged
 * `isDemo`, and the compiler refuses to mix it with real research (gate `demo-isolation`).
 *
 * The fixture deliberately reproduces the hard patterns found in the M0.5 spike: tranched rounds,
 * firm-plus-fund participation, consortium agreements, cumulative amendment rows (including
 * negative amendments), grants vs procurement, undisclosed amounts, unconfirmed leads,
 * not-researched topics, disputed values, subsidiaries, acquisitions and public companies.
 */
import { sealDemoCorpus } from "../compile/hash";
import type {
  Acquisition,
  Agreement,
  Assertion,
  Corpus,
  Disclosure,
  DisclosureRow,
  Evidence,
  FinancingRound,
  Money,
  Organization,
  Participation,
  Program,
  Provenance,
  ResearchAttempt,
  Source,
  TaxonomyNode,
} from "../../src/domain/schema/corpus";

export interface DemoOptions {
  seed?: number;
  companies?: number;
}

/** Eligible segments (PRODUCT.md §1) with subsectors used for layout and filtering. */
export const DEMO_TAXONOMY: { id: string; label: string; definition: string; subs: string[] }[] = [
  {
    id: "cyber",
    label: "Cybersecurity",
    definition: "Cybersecurity and secure enterprise infrastructure.",
    subs: ["Identity and access", "Threat detection", "Secure infrastructure"],
  },
  {
    id: "comms",
    label: "Communications",
    definition: "Communications and networking.",
    subs: ["Secure networking", "Radio and spectrum", "Mesh and edge"],
  },
  {
    id: "space",
    label: "Space and earth observation",
    definition: "Space, satellites and earth observation.",
    subs: ["Satellite communications", "Earth observation", "Space hardware"],
  },
  {
    id: "logistics",
    label: "Logistics",
    definition: "Logistics and supply-chain technology.",
    subs: ["Supply-chain visibility", "Fleet and maintenance"],
  },
  {
    id: "sensors",
    label: "Sensors",
    definition: "Sensors and environmental monitoring with documented security applications.",
    subs: ["Maritime sensing", "Optical and RF sensing"],
  },
  {
    id: "robotics",
    label: "Robotics and automation",
    definition: "Non-weaponized robotics and industrial automation.",
    subs: ["Autonomous mobile robots", "Inspection robotics"],
  },
  {
    id: "materials",
    label: "Advanced materials",
    definition: "Advanced materials and manufacturing.",
    subs: ["Composites", "Additive manufacturing"],
  },
  {
    id: "resilience",
    label: "Infrastructure resilience",
    definition: "Critical-infrastructure resilience.",
    subs: ["Grid and energy resilience", "Industrial control security"],
  },
  {
    id: "emergency",
    label: "Emergency response",
    definition: "Emergency response and disaster-support technology.",
    subs: ["Incident coordination", "Search and rescue tech"],
  },
];

const PROVINCES: { province: string; cities: string[]; weight: number }[] = [
  { province: "ON", cities: ["Ottawa", "Toronto", "Waterloo", "Kanata", "Kingston"], weight: 38 },
  { province: "QC", cities: ["Montréal", "Québec City", "Sherbrooke"], weight: 20 },
  { province: "BC", cities: ["Vancouver", "Victoria", "Burnaby"], weight: 15 },
  { province: "AB", cities: ["Calgary", "Edmonton"], weight: 10 },
  { province: "NS", cities: ["Halifax", "Dartmouth"], weight: 6 },
  { province: "NL", cities: ["St. John's", "Mount Pearl"], weight: 4 },
  { province: "MB", cities: ["Winnipeg"], weight: 4 },
  { province: "NB", cities: ["Fredericton", "Moncton"], weight: 3 },
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDemoCorpus(options: DemoOptions = {}): Corpus {
  const rand = mulberry32(options.seed ?? 20261013);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const chance = (p: number) => rand() < p;
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const weighted = <T extends { weight: number }>(items: readonly T[]): T => {
    let r = rand() * items.reduce((s, i) => s + i.weight, 0);
    for (const item of items) if ((r -= item.weight) <= 0) return item;
    return items[items.length - 1]!;
  };

  const usedNames = new Set<string>();
  // Large pools so fictional names read as distinct at a glance (≈900 stems × endings).
  const syllA = [
    "Kor",
    "Vel",
    "Tes",
    "Hal",
    "Nor",
    "Ary",
    "Qui",
    "Bre",
    "Lum",
    "Sev",
    "Ost",
    "Mar",
    "Cal",
    "Dra",
    "Fen",
    "Gir",
    "Jas",
    "Kel",
    "Mir",
    "Pax",
    "Rho",
    "Sil",
    "Tor",
    "Ul",
    "Var",
    "Wen",
    "Yar",
    "Zel",
    "Bal",
    "Cor",
    "Ith",
    "Ner",
  ];
  const syllB = [
    "ane",
    "ix",
    "aric",
    "en",
    "ova",
    "eth",
    "ium",
    "ora",
    "and",
    "yte",
    "ion",
    "el",
    "ast",
    "ec",
    "ilo",
    "un",
    "ara",
    "ost",
    "ure",
    "iv",
    "esk",
    "olt",
    "am",
    "ith",
  ];
  const endings = ["a", "o", "ar", "is", "en", "um", "ex", "ia"];
  const coined = () => {
    // The two-syllable pool holds about 8,000 names. Large synthetic corpora (10,000+ companies)
    // exhaust it, so after repeated collisions a third syllable is added; small corpora never get
    // there, which keeps the demo output unchanged.
    for (let attempt = 0; ; attempt++) {
      const extra = attempt > 200 ? pick(syllB).toLowerCase() : "";
      const word = pick(syllA) + pick(syllB) + extra + (chance(0.35) ? pick(endings) : "");
      if (!usedNames.has(word)) {
        usedNames.add(word);
        return word;
      }
    }
  };

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_demo_${(++counter).toString(36).padStart(5, "0")}`;
  const today = "2026-10-13";

  const taxonomy: TaxonomyNode[] = DEMO_TAXONOMY.flatMap((sector) => [
    { id: `tax:${sector.id}`, parentId: null, label: sector.label, definition: sector.definition },
    ...sector.subs.map((sub, i) => ({
      id: `tax:${sector.id}.${i + 1}`,
      parentId: `tax:${sector.id}`,
      label: sub,
      definition: `${sub} (${sector.label.toLowerCase()}).`,
    })),
  ]);

  const sources: Source[] = [];
  const organizations: Organization[] = [];
  const assertions: Assertion[] = [];
  const rounds: FinancingRound[] = [];
  const agreements: Agreement[] = [];
  const acquisitions: Acquisition[] = [];
  const programs: Program[] = [];
  const research: ResearchAttempt[] = [];

  const newSource = (
    kind: Source["kind"],
    tier: Source["tier"],
    publisher: string,
    title: string,
    publishedOn: string | null,
    originGroup?: string,
    sourceBasis: Source["sourceBasis"] = "named",
  ) => {
    const id = nextId("src");
    sources.push({
      id,
      kind,
      tier,
      publisher,
      title,
      url: `https://example.invalid/demo/${id}`,
      publishedOn,
      retrievedAt: "2026-10-13T00:00:00Z",
      originGroup: originGroup ?? `og:${id}`,
      textSha256: null,
      sourceBasis,
    });
    return id;
  };

  const evidence = (sourceId: string, locator = "fictional record"): Evidence => ({
    sourceId,
    locator,
    locatorQuality: "body",
  });

  /** Verified provenance; the fixture review hash is stamped by `sealDemoCorpus` at the end. */
  const verified = (
    ev: Evidence[],
    epistemic: Provenance["epistemic"] = "sourced_fact",
  ): Provenance => ({
    epistemic,
    verification: "verified",
    evidence: ev,
    review: null,
    createdBy: "demo-generator",
  });
  const proposed = (ev: Evidence[]): Provenance => ({
    epistemic: "sourced_fact",
    verification: "proposed",
    evidence: ev,
    review: null,
    createdBy: "demo-generator",
  });

  const addAssertion = (
    subjectId: string,
    predicate: Assertion["predicate"],
    value: unknown,
    ev: Evidence[],
    extra: Partial<Assertion> = {},
    epistemic: Provenance["epistemic"] = "sourced_fact",
  ) => {
    const id = nextId("asr");
    assertions.push({
      id,
      subjectId,
      predicate,
      value,
      primary: false,
      validFrom: null,
      validTo: null,
      asOf: null,
      supersedes: null,
      ...verified(ev, epistemic),
      ...extra,
    });
    return id;
  };

  const money = (amount: number | null, currency = "CAD", asStated?: string): Money =>
    amount === null
      ? { amount: null, currency, disclosure: "undisclosed", asStated: asStated ?? "not disclosed" }
      : {
          amount: String(Math.round(amount)),
          currency,
          disclosure: "disclosed",
          asStated: asStated ?? `${currency} ${(amount / 1e6).toFixed(1)}M`,
        };

  const org = (kind: Organization["kind"], name: string): Organization => {
    const o: Organization = {
      id: nextId("org"),
      kind,
      slug: name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, ""),
      name,
      mergedInto: null,
      isDemo: true,
    };
    organizations.push(o);
    return o;
  };

  // ---- Institutions ---------------------------------------------------------------------------
  const registry = newSource(
    "registry",
    "T1",
    "Fictional Corporate Registry",
    "Registry extract",
    null,
  );
  const govDataset = newSource(
    "gov_dataset",
    "T1",
    "Fictional Proactive Disclosure Dataset",
    "Contracts and contributions",
    null,
  );

  const firmSuffix = ["Ventures", "Capital", "Partners", "Growth", "Innovation Partners"];
  const firms = Array.from({ length: 34 }, () => {
    const firm = org("investor_firm", `${coined()} ${pick(firmSuffix)}`);
    addAssertion(
      firm.id,
      "hq_location",
      { city: null, region: null, province: pick(PROVINCES).province, country: "CA" },
      [evidence(registry)],
    );
    const funds = chance(0.35)
      ? Array.from({ length: int(1, 2) }, (_, i) => {
          const fund = org("fund", `${firm.name} Fund ${["I", "II", "III"][i]}`);
          addAssertion(fund.id, "managed_by", firm.id, [evidence(registry)]);
          return fund;
        })
      : [];
    return { firm, funds, focus: pick(DEMO_TAXONOMY).id, foreign: false };
  });
  // Foreign investors appear as contextual entities (P-17) when they invest in Canadian companies.
  for (let i = 0; i < 6; i++) {
    const firm = org("investor_firm", `${coined()} ${pick(["Capital", "Ventures"])} (US)`);
    addAssertion(
      firm.id,
      "hq_location",
      { city: null, region: null, province: null, country: "US" },
      [evidence(registry)],
    );
    firms.push({ firm, funds: [], focus: pick(DEMO_TAXONOMY).id, foreign: true });
  }
  const govInvestors = [
    "Northern Development Bank",
    "Provincial Investment Corporation",
    "Crown Innovation Fund",
  ].map((n) => ({
    firm: org("government_body", `${n} (fictional)`),
    funds: [] as Organization[],
    focus: "",
    foreign: false,
  }));
  const corporateInvestors = Array.from({ length: 4 }, () => ({
    firm: org("corporate", `${coined()} Industries`),
    funds: [] as Organization[],
    focus: pick(DEMO_TAXONOMY).id,
    foreign: chance(0.5),
  }));
  const investors = [...firms, ...govInvestors, ...corporateInvestors];

  const deptNames = [
    "Department of Continental Security",
    "Federal Space Office",
    "Maritime Research Directorate",
    "National Infrastructure Agency",
    "Northern Operations Command",
    "Public Safety Readiness Office",
    "Federal Research Council",
    "Coastal Services Agency",
    "Digital Government Service",
    "Emergency Preparedness Agency",
    "Provincial Hydro Authority",
    "Regional Transit Commission",
  ];
  const counterparties = deptNames.map((n) => org("government_body", `${n} (fictional)`));
  const institutes = [
    "Northern Polytechnic",
    "Atlantic Ocean Institute",
    "Prairie Robotics Lab",
  ].map((n) => org("research_institution", `${n} (fictional)`));
  const programDefs = [
    ["Industrial Research Assistance (fictional)", 6],
    ["Defence Innovation Challenge (fictional)", 0],
    ["Strategic Innovation Contributions (fictional)", 2],
    ["Space Technology Development (fictional)", 1],
    ["Regional Defence Investment (fictional)", 0],
    ["Export Development Support (fictional)", 8],
  ] as const;
  for (const [name, funderIndex] of programDefs) {
    programs.push({ id: nextId("prg"), funderId: counterparties[funderIndex]!.id, name });
  }

  const acquirers = Array.from({ length: 6 }, (_, i) => {
    const a = org("corporate", `${coined()} ${pick(["Group", "Holdings", "Systems Corp."])}`);
    addAssertion(
      a.id,
      "hq_location",
      { city: null, region: null, province: null, country: i < 4 ? "US" : "GB" },
      [evidence(registry)],
    );
    return a;
  });

  // ---- Companies ------------------------------------------------------------------------------
  const companyCount = options.companies ?? 380;
  const companies: { org: Organization; sector: string; sub: string; profile: number }[] = [];
  const companySuffix = [
    "Systems",
    "Technologies",
    "Networks",
    "Robotics",
    "Labs",
    "Dynamics",
    "Analytics",
    "Materials",
    "Aerospace",
    "Security",
  ];

  for (let i = 0; i < companyCount; i++) {
    const sector = weighted(
      DEMO_TAXONOMY.map((s, idx) => ({ ...s, weight: [16, 12, 14, 8, 9, 10, 8, 9, 6][idx]! })),
    );
    const subIndex = int(1, sector.subs.length);
    const company = org("company", `${coined()} ${pick(companySuffix)}`);
    const profile = rand(); // 0 = early, 1 = mature
    companies.push({
      org: company,
      sector: sector.id,
      sub: `tax:${sector.id}.${subIndex}`,
      profile,
    });

    const press = newSource(
      "company_release",
      "T2",
      company.name,
      `${company.name} newsroom`,
      `${int(2016, 2026)}`,
    );
    if (chance(0.05)) {
      // Renamed legal entity: the earlier approved name is kept as history (supersession).
      const old = addAssertion(
        company.id,
        "legal_name",
        `${company.name} Technologies Ltd.`,
        [evidence(registry)],
        { verification: "superseded", asOf: "2019-06" },
      );
      addAssertion(company.id, "legal_name", `${company.name} Inc.`, [evidence(registry)], {
        supersedes: old,
        validFrom: "2022-04",
      });
    } else addAssertion(company.id, "legal_name", `${company.name} Inc.`, [evidence(registry)]);

    const place = weighted(PROVINCES);
    const city = pick(place.cities);
    const hqRoll = rand();
    if (hqRoll < 0.82) {
      addAssertion(
        company.id,
        "hq_location",
        { city, region: null, province: place.province, country: "CA" },
        [evidence(press, "about page")],
        { primary: true },
      );
    } else if (hqRoll < 0.88) {
      // Disputed city inside one metro (F-11): two verified values.
      addAssertion(
        company.id,
        "hq_location",
        { city, region: null, province: place.province, country: "CA" },
        [evidence(press, "headline")],
      );
      const otherCity = place.cities.find((x) => x !== city) ?? `${city} (east)`;
      addAssertion(
        company.id,
        "hq_location",
        { city: otherCity, region: null, province: place.province, country: "CA" },
        [
          evidence(
            newSource("company_release", "T2", company.name, "Investor deck", "2025"),
            "fictional investor deck, company slide",
          ),
        ],
      );
    } else if (hqRoll < 0.94) {
      // Province known from a registry, city not evidenced.
      addAssertion(
        company.id,
        "hq_location",
        { city: null, region: null, province: place.province, country: "CA" },
        [evidence(registry)],
      );
    } // else: HQ not researched

    if (chance(0.85)) addAssertion(company.id, "founded_year", int(2006, 2023), [evidence(press)]);
    addAssertion(
      company.id,
      "description",
      `Fictional ${DEMO_TAXONOMY.find((s) => s.id === sector.id)!.subs[subIndex - 1]!.toLowerCase()} company created for demonstration; no real-world counterpart.`,
      [evidence(press)],
      {},
      "analyst_interpretation",
    );
    addAssertion(
      company.id,
      "classified_as",
      `tax:${sector.id}.${subIndex}`,
      [evidence(press)],
      { primary: true },
      "analyst_interpretation",
    );
    if (chance(0.18)) {
      const other = pick(DEMO_TAXONOMY);
      addAssertion(
        company.id,
        "classified_as",
        `tax:${other.id}.1`,
        [evidence(press)],
        {},
        "analyst_interpretation",
      );
    }
    addAssertion(
      company.id,
      "eligibility",
      {
        decision: "included",
        rationale:
          "Fictional documented relationship with a security or defence-adjacent institution.",
      },
      [evidence(press)],
      {},
      "analyst_interpretation",
    );
    if (profile > 0.9 && chance(0.6)) {
      addAssertion(
        company.id,
        "public_listing",
        { exchange: pick(["TSX", "TSXV"]), ticker: company.name.slice(0, 3).toUpperCase() + "D" },
        [evidence(registry)],
      );
    }

    const topics = ["identity", "financing", "agreements", "eligibility"] as const;
    for (const topic of topics) {
      if (topic === "financing" && chance(0.12)) continue; // not researched
      if (topic === "agreements" && chance(0.08)) continue;
      research.push({
        id: nextId("res"),
        subjectId: company.id,
        topic,
        sourcesSearched: ["company newsroom", "fictional disclosure dataset"],
        outcome: "found",
        by: "demo-fixture",
        at: chance(0.1) ? "2025-02" : "2026-09",
        nextReview: chance(0.1) ? "2026-03" : "2027-03",
      });
    }
  }

  // ---- Financing rounds -----------------------------------------------------------------------
  const stages = ["seed", "series_a", "series_b", "series_c", "series_d_plus"] as const;
  const stageLabel: Record<string, string> = {
    seed: "Seed",
    series_a: "Series A",
    series_b: "Series B",
    series_c: "Series C",
    series_d_plus: "Series D",
  };
  const baseAmount: Record<string, number> = {
    seed: 2.5e6,
    series_a: 9e6,
    series_b: 24e6,
    series_c: 55e6,
    series_d_plus: 110e6,
  };

  for (const c of companies) {
    const financingResearched = research.some(
      (r) => r.subjectId === c.org.id && r.topic === "financing",
    );
    if (!financingResearched) continue;
    const roundCount = c.profile < 0.12 ? 0 : Math.min(5, 1 + Math.floor(c.profile * 4.2));
    if (roundCount === 0) {
      const att = research.find((r) => r.subjectId === c.org.id && r.topic === "financing")!;
      att.outcome = "none_found";
      continue;
    }
    const sectorInvestors = investors.filter((inv) => inv.focus === c.sector || inv.focus === "");
    let year = int(2015, 2020);
    for (let r = 0; r < roundCount; r++) {
      const stage = stages[r]!;
      year = Math.min(2026, year + int(1, 2));
      const usd = chance(0.2);
      const currency = usd ? "USD" : "CAD";
      const total = baseAmount[stage]! * (0.5 + rand());
      const undisclosed = chance(0.22);
      const og = `og:${c.org.id}:${stage}`;
      const release = newSource(
        "company_release",
        "T2",
        c.org.name,
        `${stageLabel[stage]} announcement`,
        `${year}-0${int(1, 9)}`,
        og,
      );
      const press = newSource(
        "news",
        "T3",
        pick(["Fictional Tech Daily", "Fictional Venture Wire"]),
        `${c.org.name} raises ${stageLabel[stage]}`,
        `${year}`,
        og,
      );
      // A few rounds are known only from independent reporting (drawn dashed; DESIGN encodings).
      const pressOnly = chance(0.06);
      const primary = pressOnly ? press : release;

      const disclosures: Disclosure[] = [];
      const pattern = rand();
      const disc = (
        date: string,
        kind: Disclosure["kind"],
        amount: Money,
        basis: Disclosure["amountBasis"],
        src: string,
      ): Disclosure => ({
        id: nextId("dis"),
        date,
        kind,
        amount,
        amountBasis: basis,
        amountNature: "unspecified",
        ...verified([evidence(src)]),
      });
      if (undisclosed) {
        disclosures.push(disc(`${year}-03`, "single", money(null, currency), "unknown", primary));
      } else if (pattern < 0.12) {
        // Tranched: first close then cumulative final (must NOT be summed).
        const first = total * 0.65;
        disclosures.push(
          disc(`${year}-02`, "first_close", money(first, currency), "incremental", press),
        );
        disclosures.push(
          disc(`${year}-11`, "final", money(total, currency), "cumulative_round_total", primary),
        );
      } else if (pattern < 0.17) {
        // Two incremental tranches, no cumulative statement: sum is valid.
        const a = total * 0.6;
        disclosures.push(
          disc(`${year}-02`, "first_close", money(a, currency), "incremental", primary),
        );
        disclosures.push(
          disc(`${year}-09`, "extension", money(total - a, currency), "incremental", press),
        );
      } else if (pattern < 0.2) {
        // Extension with unknown basis: must resolve to "unclear".
        disclosures.push(disc(`${year}-04`, "unknown", money(total, currency), "unknown", press));
        disclosures.push(
          disc(`${year + 1}-01`, "extension", money(total * 0.15, currency), "incremental", press),
        );
      } else {
        disclosures.push(
          disc(`${year}-05`, "single", money(total, currency), "cumulative_round_total", primary),
        );
      }

      const participations: Participation[] = [];
      const leadPool = sectorInvestors.length ? sectorInvestors : investors;
      const used = new Set<string>();
      const nParticipants = int(1, 4);
      for (let p = 0; p < nParticipants; p++) {
        const inv = p === 0 ? pick(leadPool) : pick(investors);
        if (used.has(inv.firm.id)) continue;
        used.add(inv.firm.id);
        const viaFund = inv.funds.length > 0 && chance(0.7) ? pick(inv.funds) : null;
        participations.push({
          reportedName: viaFund ? viaFund.name : inv.firm.name,
          investorId: inv.firm.id,
          vehicleId: viaFund?.id ?? null,
          role: p === 0 ? (chance(0.8) ? "lead" : "unknown") : "participant",
          disclosureIds: [],
          ...verified([evidence(primary)]),
        });
      }
      const unconfirmed = chance(0.07);
      rounds.push({
        id: nextId("fin"),
        companyId: c.org.id,
        eventState: chance(0.85) ? "closed" : "announced",
        roundLabelAsStated: stageLabel[stage]!,
        stage,
        instrument: "equity",
        proceeds: "primary",
        participantsCompleteness: chance(0.3) ? "partial_named" : "complete",
        disclosures,
        participations,
        ...(unconfirmed
          ? proposed([evidence(press)])
          : verified(pressOnly ? [evidence(press)] : [evidence(release), evidence(press)])),
      });
    }
  }

  // ---- Agreements -----------------------------------------------------------------------------
  const lognormal = (median: number, spread: number) =>
    median * Math.exp((rand() * 2 - 1) * spread);
  const procurementRow = (original: number, amendments: number[]) => {
    const rows: DisclosureRow[] = [
      {
        reportingPeriod: "2024-2025-Q1",
        instrument: "original" as const,
        originalValue: original.toFixed(2),
        amendmentValue: null,
        totalValue: original.toFixed(2),
        endOnAsStated: "2027-03-31",
      },
    ];
    let total = original;
    amendments.forEach((delta, i) => {
      total += delta;
      rows.push({
        reportingPeriod: `2025-2026-Q${i + 1}`,
        instrument: "amendment" as const,
        originalValue: original.toFixed(2),
        amendmentValue: delta.toFixed(2),
        totalValue: total.toFixed(2),
        endOnAsStated: i === amendments.length - 1 && chance(0.3) ? "2026-12-31" : "2027-03-31",
      });
    });
    return rows;
  };

  for (const c of companies) {
    if (!research.some((r) => r.subjectId === c.org.id && r.topic === "agreements")) continue;
    const nProcurement = chance(0.55) ? int(1, 4) : 0;
    for (let k = 0; k < nProcurement; k++) {
      const buyer = pick(counterparties);
      const small = chance(0.4);
      const original = small ? lognormal(40e3, 0.8) : lognormal(900e3, 1.6);
      const amendments = chance(0.3)
        ? Array.from({ length: int(1, 2) }, () =>
            chance(0.2) ? -original * 0.25 : original * (0.2 + rand() * 0.6),
          )
        : [];
      const id = nextId("agr");
      const rows = procurementRow(original, amendments);
      agreements.push({
        id,
        family: "procurement",
        type: chance(0.15) ? "call_up" : "contract_award",
        title: pick([
          "Engineering services",
          "Prototype evaluation",
          "Software licences",
          "Field trial support",
          "Sensor equipment",
          "Data services",
        ]),
        programId: null,
        groupId: null,
        externalIds: [
          { system: "demo-procurement-id", value: `DEMO-${id.slice(-5).toUpperCase()}` },
        ],
        parties: [
          {
            orgId: buyer.id,
            role: "buyer",
            evidenceStrength: "party_of_record",
            reportedName: buyer.name,
          },
          {
            orgId: c.org.id,
            role: "prime",
            evidenceStrength: "party_of_record",
            reportedName: `${c.org.name.toUpperCase()} INC.`,
          },
        ],
        currency: "CAD",
        disclosureRows: rows,
        valueStatements: [],
        allocations: [],
        repayability: null,
        announcedOn: `${int(2019, 2026)}-0${int(1, 9)}`,
        startOn: null,
        statusAsOf: { state: "unknown", asOf: today },
        ...verified([evidence(govDataset, `row ${id}`)]),
      });
    }
    const nGrants = chance(0.45) ? int(1, 2) : 0;
    for (let k = 0; k < nGrants; k++) {
      const program = pick(programs);
      const funder = organizations.find((o) => o.id === program.funderId)!;
      const value = lognormal(350e3, 1.3);
      const year = int(2019, 2026);
      // A few grants are known only from news coverage, not the disclosure dataset.
      const grantSource = chance(0.06)
        ? newSource(
            "news",
            "T3",
            pick(["Fictional Tech Daily", "Fictional Venture Wire"]),
            `${c.org.name} receives ${program.name} funding`,
            `${year}`,
          )
        : govDataset;
      const id = nextId("agr");
      agreements.push({
        id,
        family: "grant_contribution",
        type: chance(0.7) ? "contribution" : "grant",
        title: pick([
          "Technology demonstration",
          "Research collaboration",
          "Scale-up support",
          "Export readiness",
        ]),
        programId: program.id,
        groupId: null,
        externalIds: [{ system: "demo-gc-agreement", value: `GC-${id.slice(-5).toUpperCase()}` }],
        parties: [
          {
            orgId: funder.id,
            role: "funder",
            evidenceStrength: "party_of_record",
            reportedName: funder.name,
          },
          {
            orgId: c.org.id,
            role: "recipient",
            evidenceStrength: "party_of_record",
            reportedName: c.org.name,
          },
        ],
        currency: "CAD",
        disclosureRows: [],
        valueStatements: [
          {
            money: money(value),
            basis: { options: "unknown", taxes: "unknown", stage: "awarded" },
            evidence: [evidence(grantSource)],
          },
        ],
        allocations: [],
        repayability: pick(["non_repayable", "conditionally_repayable", "unknown"] as const),
        announcedOn: `${year}`,
        startOn: null,
        statusAsOf: { state: "unknown", asOf: today },
        ...verified([evidence(grantSource)]),
      });
    }
    if (chance(0.06)) {
      const partner = pick(institutes);
      const id = nextId("agr");
      const partnershipEvidence = [
        evidence(
          newSource("company_release", "T2", c.org.name, "Partnership announcement", "2025"),
          "fictional announcement, first paragraph",
        ),
      ];
      agreements.push({
        id,
        family: "partnership",
        type: chance(0.5) ? "mou" : "partnership",
        title: "Research partnership",
        programId: null,
        groupId: null,
        externalIds: [],
        parties: [
          {
            orgId: partner.id,
            role: "partner",
            evidenceStrength: "party_of_record",
            reportedName: partner.name,
          },
          {
            orgId: c.org.id,
            role: "partner",
            evidenceStrength: "party_of_record",
            reportedName: c.org.name,
          },
        ],
        currency: "CAD",
        disclosureRows: [],
        valueStatements: [
          {
            money: {
              amount: null,
              currency: "CAD",
              disclosure: "not_applicable",
              asStated: "no value (MOU)",
            },
            basis: { options: "unknown", taxes: "unknown", stage: "announced" },
            evidence: partnershipEvidence,
          },
        ],
        allocations: [],
        repayability: null,
        announcedOn: `${int(2021, 2026)}`,
        startOn: null,
        statusAsOf: { state: "unknown", asOf: today },
        ...verified(partnershipEvidence),
      });
    }
  }
  // Consortium agreements: one award, several recipients; allocations only sometimes disclosed.
  for (let k = 0; k < 10; k++) {
    const members = Array.from({ length: int(2, 3) }, () => pick(companies).org).filter(
      (m, i, arr) => arr.indexOf(m) === i,
    );
    const buyer = pick(counterparties);
    const total = lognormal(6e6, 0.6);
    const withAllocations = chance(0.4);
    const id = nextId("agr");
    const ev = [evidence(govDataset, `row ${id}`)];
    agreements.push({
      id,
      family: "procurement",
      type: "contract_award",
      title: "Consortium programme award",
      programId: null,
      groupId: null,
      externalIds: [{ system: "demo-procurement-id", value: `DEMO-${id.slice(-5).toUpperCase()}` }],
      parties: [
        {
          orgId: buyer.id,
          role: "buyer",
          evidenceStrength: "party_of_record",
          reportedName: buyer.name,
        },
        ...members.map((m, i) => ({
          orgId: m.id,
          role: (i === 0 ? "prime" : "member") as "prime" | "member",
          evidenceStrength: "party_of_record" as const,
          reportedName: m.name,
        })),
      ],
      currency: "CAD",
      disclosureRows: procurementRow(total, []),
      valueStatements: [
        {
          money: money(total * 1.3, "CAD", "up to (options included)"),
          basis: { options: "included", taxes: "included", stage: "maximum" },
          evidence: ev,
        },
      ],
      allocations: withAllocations
        ? members.map((m, i) => ({
            orgId: m.id,
            money: money(total * (i === 0 ? 0.6 : 0.4 / (members.length - 1))),
            evidence: ev,
          }))
        : [],
      repayability: null,
      announcedOn: `${int(2021, 2026)}`,
      startOn: null,
      statusAsOf: { state: "unknown", asOf: today },
      ...verified(ev),
    });
  }

  // Other transfer payments (source type O): a distinct family, never counted as a grant or a
  // purchase. Fixed ids and picks, so the random sequence and every other demo id stay unchanged.
  {
    const recipient = companies[0]!.org;
    const funder = organizations.find((o) => o.id === programs[0]!.funderId)!;
    const ev = [evidence(govDataset, "row other-transfer-1")];
    agreements.push({
      id: "agr_demo_other_transfer_1",
      family: "other_transfer",
      type: "other_transfer_payment",
      sourceClassification: {
        system: "demo-disclosure:agreement_type",
        code: "O",
        label: "Other transfer payment",
      },
      title: "Strategic technology programme",
      programId: programs[0]!.id,
      groupId: null,
      externalIds: [{ system: "demo-other-transfer", value: "OT-DEMO-1" }],
      parties: [
        {
          orgId: funder.id,
          role: "funder",
          evidenceStrength: "party_of_record",
          reportedName: funder.name,
        },
        {
          orgId: recipient.id,
          role: "recipient",
          evidenceStrength: "party_of_record",
          reportedName: recipient.name,
        },
      ],
      currency: "CAD",
      disclosureRows: [
        {
          reportingPeriod: "2024-2025-Q1",
          instrument: "original" as const,
          originalValue: "4000000.00",
          amendmentValue: null,
          totalValue: "4000000.00",
          endOnAsStated: "2027-03-31",
        },
      ],
      valueStatements: [],
      allocations: [],
      repayability: null,
      announcedOn: "2024",
      startOn: null,
      statusAsOf: { state: "unknown", asOf: today },
      ...verified(ev),
    });
  }

  // ---- Acquisitions ---------------------------------------------------------------------------
  const mature = companies.filter((c) => c.profile > 0.6);
  for (let k = 0; k < 12 && mature.length; k++) {
    const target = mature.splice(Math.floor(rand() * mature.length), 1)[0]!.org;
    const acquirer = chance(0.7) ? pick(acquirers) : pick(companies).org;
    if (acquirer.id === target.id) continue;
    const date = `${int(2021, 2026)}-0${int(1, 9)}`;
    const release = newSource(
      "counterparty_release",
      "T2",
      acquirer.name,
      `${acquirer.name} completes acquisition`,
      date,
    );
    const anonymous = chance(0.3);
    acquisitions.push({
      id: nextId("acq"),
      targetId: target.id,
      acquirerId: acquirer.id,
      history: [{ state: "completed", date }],
      consideration: chance(0.75)
        ? money(null, "USD", "terms not disclosed")
        : money(lognormal(80e6, 0.7), "USD"),
      reportedConsideration: anonymous
        ? [
            {
              money: money(lognormal(150e6, 0.5), "USD", "reportedly"),
              sourceBasis: "anonymous_sources",
            },
          ]
        : [],
      ...verified([evidence(release)]),
    });
    addAssertion(target.id, "subsidiary_of", acquirer.id, [evidence(release)], { validFrom: date });
  }

  return sealDemoCorpus(
    {
      schemaVersion: "0.3",
      isDemo: true,
      taxonomy,
      sources,
      organizations,
      assertions,
      rounds,
      agreements,
      acquisitions,
      programs,
      research,
    },
    today,
  );
}
