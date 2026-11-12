/**
 * SYNTHETIC STRESS CORPUS: fictional data for scale and robustness testing only.
 *
 * Builds on the demo generator (so every organization, source and amount is fictional, sources use
 * the reserved `example.invalid` domain and the corpus is flagged `isDemo`), then layers the hard
 * cases a real corpus will contain at scale:
 *
 * - renamed companies (a superseded legal name kept as history) and near-identical names declared
 *   distinct (`distinctFrom`);
 * - ownership that changes over time (a parent link that ended, then a new parent);
 * - conflicting evidence (two approved headquarters values, shown as "Sources disagree");
 * - duplicate evidence (the same source and locator cited twice);
 * - incomplete records (undisclosed amounts, unknown currencies, disclosure rows without a total);
 * - records that must never publish: `proposed` and `rejected` assertions, rounds and agreements;
 * - other transfer payments (a distinct agreement family);
 * - hub organizations: one investor in a large share of all rounds and one department with
 *   agreements across a large share of companies.
 *
 * Approvals here are synthetic fixture reviews from `sealDemoCorpus` (reviewer "demo-fixture"); they
 * are not owner approvals, and the compiler refuses them outside demo/synthetic builds.
 *
 * Output never goes to public/: `bench/stress/build.ts` writes it under the gitignored `.stress/`
 * folder, which only the `stress` Vite mode serves.
 */
import { sealDemoCorpus } from "../compile/hash";
import { generateDemoCorpus } from "../demo/generate";
import type {
  Agreement,
  Assertion,
  Corpus,
  Evidence,
  FinancingRound,
  Organization,
  Provenance,
} from "../../src/domain/schema/corpus";

export interface StressOptions {
  companies: number;
  seed?: number;
}

/** Ids of the records that must never reach a published snapshot (checked by tests). */
export interface StressManifest {
  unpublishable: string[];
  /**
   * Distinctive text that appears only in unpublishable records and in the titles of sources cited
   * only by them. None of it may appear anywhere in a published snapshot.
   */
  leakMarkers: string[];
  renamed: string[];
  twins: [string, string][];
  disputedHq: string[];
  hubInvestor: string;
  hubDepartment: string;
  otherTransfers: string[];
  /** Companies with hundreds of agreements (large suppliers): the heaviest dossiers. */
  heavyCompanies: string[];
}

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

const TODAY = "2026-10-13";

export function generateStressCorpus(options: StressOptions): {
  corpus: Corpus;
  manifest: StressManifest;
} {
  const seed = options.seed ?? 4242;
  const base = generateDemoCorpus({ companies: options.companies, seed });
  const rand = mulberry32(seed + 1);
  const chance = (p: number) => rand() < p;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  let counter = 0;
  const id = (prefix: string) => `${prefix}_stress_${(++counter).toString(36).padStart(6, "0")}`;

  const organizations = [...base.organizations];
  const assertions = [...base.assertions];
  const rounds = [...base.rounds];
  const agreements = [...base.agreements];
  const sources = [...base.sources];
  const manifest: StressManifest = {
    unpublishable: [],
    leakMarkers: [
      "Proposedville",
      "Series Z (unreviewed)",
      "Unreviewed contract lead",
      "Unreviewed lead",
      "Rejected lead",
      "Unreviewed financing lead",
    ],
    renamed: [],
    twins: [],
    disputedHq: [],
    hubInvestor: "",
    hubDepartment: "",
    otherTransfers: [],
    heavyCompanies: [],
  };

  const source = (
    title: string,
    kind: Corpus["sources"][number]["kind"] = "company_release",
    tier: Corpus["sources"][number]["tier"] = "T2",
  ) => {
    const s = {
      ...base.sources[0]!,
      id: id("src"),
      kind,
      tier,
      publisher: "Synthetic publisher",
      title: `${title} (synthetic)`,
      url: `https://example.invalid/stress/${counter}`,
      originGroup: `og:stress-${counter}`,
    };
    sources.push(s);
    return s.id;
  };
  const ev = (sourceId: string, locator = "synthetic record"): Evidence[] => [
    { sourceId, locator, locatorQuality: "body" },
  ];
  const prov = (verification: Provenance["verification"], evidence: Evidence[]): Provenance => ({
    epistemic: "sourced_fact",
    verification,
    evidence,
    review: null,
    createdBy: "stress-generator",
  });
  const assertion = (
    subjectId: string,
    predicate: Assertion["predicate"],
    value: unknown,
    verification: Provenance["verification"],
    evidence: Evidence[],
    extra: Partial<Assertion> = {},
  ): Assertion => {
    const a: Assertion = {
      id: id("asr"),
      subjectId,
      predicate,
      value,
      primary: false,
      validFrom: null,
      validTo: null,
      asOf: null,
      supersedes: null,
      ...prov(verification, evidence),
      ...extra,
    };
    assertions.push(a);
    if (verification !== "verified" && verification !== "superseded")
      manifest.unpublishable.push(a.id);
    return a;
  };

  const assertionsOf = new Map<string, Assertion[]>();
  for (const a of base.assertions)
    (assertionsOf.get(a.subjectId) ?? assertionsOf.set(a.subjectId, []).get(a.subjectId)!).push(a);
  const companies = base.organizations.filter((o) => o.kind === "company");
  const included = companies.filter((c) =>
    (assertionsOf.get(c.id) ?? []).some(
      (a) =>
        a.predicate === "eligibility" &&
        (a.value as { decision?: string }).decision === "included" &&
        a.verification === "verified",
    ),
  );
  const investors = base.organizations.filter((o) => o.kind === "investor_firm");
  const departments = base.organizations.filter((o) => o.kind === "government_body");

  // ---- Renamed companies: the old legal name is superseded history, the new one is current ----
  for (const c of included) {
    if (!chance(0.05)) continue;
    const current = (assertionsOf.get(c.id) ?? []).find(
      (a) => a.predicate === "legal_name" && a.verification === "verified",
    );
    if (!current) continue;
    const oldName = `${String(current.value).replace(/ Inc\.$/, "")} Systems Ltd.`;
    const old = assertion(
      c.id,
      "legal_name",
      oldName,
      "superseded",
      ev(source("Registry extract", "registry", "T1")),
      {
        validTo: "2021-06",
      },
    );
    const idx = assertions.indexOf(current);
    assertions[idx] = { ...current, supersedes: old.id, validFrom: "2021-06" };
    manifest.renamed.push(c.id);
  }

  // ---- Near-identical names declared distinct ----------------------------------------------
  const twinsWanted = Math.max(2, Math.round(included.length * 0.01));
  for (let i = 0; i < twinsWanted; i++) {
    const original = pick(included);
    const twin: Organization = {
      ...original,
      id: id("org"),
      slug: `${original.slug}-tech`,
      name: `${original.name} Tech`,
      distinctFrom: [original.id],
    };
    if (organizations.some((o) => o.slug === twin.slug)) continue;
    organizations.push(twin);
    const s = source("Company website");
    for (const a of assertionsOf.get(original.id) ?? [])
      if (
        a.verification === "verified" &&
        ["eligibility", "classified_as", "hq_location", "legal_name", "description"].includes(
          a.predicate,
        )
      )
        assertion(
          twin.id,
          a.predicate,
          a.predicate === "legal_name" ? `${String(a.value)} Tech` : a.value,
          "verified",
          ev(s, `section ${a.predicate}`),
          { primary: a.primary, epistemic: a.epistemic },
        );
    const idx = organizations.indexOf(original);
    organizations[idx] = { ...original, distinctFrom: [twin.id] };
    manifest.twins.push([original.id, twin.id]);
  }

  // ---- Ownership that changes over time ------------------------------------------------------
  const parents = base.organizations.filter((o) => o.kind === "corporate");
  if (parents.length >= 2)
    for (const c of included) {
      if (!chance(0.02)) continue;
      const [first, second] = [pick(parents), pick(parents)];
      if (first.id === second.id) continue;
      assertion(c.id, "subsidiary_of", first.id, "verified", ev(source("Parent release")), {
        validFrom: "2016",
        validTo: "2020-03",
      });
      assertion(c.id, "subsidiary_of", second.id, "verified", ev(source("Acquirer release")), {
        validFrom: "2020-03",
      });
    }

  // ---- Conflicting and duplicate evidence ----------------------------------------------------
  for (const c of included) {
    if (chance(0.03)) {
      const hq = (assertionsOf.get(c.id) ?? []).find(
        (a) => a.predicate === "hq_location" && a.verification === "verified",
      );
      if (hq) {
        const v = hq.value as { city?: string | null };
        assertion(
          c.id,
          "hq_location",
          { ...(hq.value as object), city: `${v.city ?? "Unknown"} East` },
          "verified",
          ev(source("Company profile page"), "address block"),
        );
        manifest.disputedHq.push(c.id);
      }
    }
    if (chance(0.03)) {
      const s = source("Company newsroom");
      assertion(c.id, "description", "Synthetic description cited twice.", "verified", [
        ...ev(s, "para 1"),
        ...ev(s, "para 1"),
      ]);
    }
  }

  // ---- Records that must never publish -------------------------------------------------------
  for (const c of included) {
    if (chance(0.05))
      assertion(
        c.id,
        "hq_location",
        { city: "Proposedville", region: null, province: "ON", country: "CA" },
        "proposed",
        ev(source("Unreviewed lead")),
      );
    if (chance(0.02))
      assertion(c.id, "founded_year", 1901, "rejected", ev(source("Rejected lead")));
    if (chance(0.03)) {
      const r: FinancingRound = {
        id: id("fin"),
        companyId: c.id,
        eventState: "reported",
        roundLabelAsStated: "Series Z (unreviewed)",
        stage: null,
        instrument: "unknown",
        proceeds: "unknown",
        participantsCompleteness: "unknown",
        disclosures: [],
        participations: [],
        ...prov(chance(0.5) ? "proposed" : "rejected", ev(source("Unreviewed financing lead"))),
      };
      rounds.push(r);
      manifest.unpublishable.push(r.id);
    }
  }

  // ---- Hubs: one investor in many rounds, one department with many agreements ---------------
  const hub = investors[0];
  if (hub) {
    manifest.hubInvestor = hub.id;
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i]!;
      if (r.verification !== "verified" || !chance(0.3)) continue;
      if (r.participations.some((p) => p.investorId === hub.id)) continue;
      rounds[i] = {
        ...r,
        participations: [
          ...r.participations,
          {
            reportedName: hub.name,
            investorId: hub.id,
            vehicleId: null,
            role: "participant",
            disclosureIds: [],
            ...prov("verified", r.evidence),
          },
        ],
      };
    }
  }
  const hubDept = departments[0];
  if (hubDept) {
    manifest.hubDepartment = hubDept.id;
    const s = source("Disclosure dataset (hub department)", "gov_dataset", "T1");
    for (const c of included) {
      if (!chance(0.5)) continue;
      const g: Agreement = {
        id: id("agr"),
        family: chance(0.5) ? "procurement" : "grant_contribution",
        type: "contract_award",
        title: "Hub department agreement",
        programId: null,
        groupId: null,
        externalIds: [{ system: "stress-ref", value: `HUB-${counter}` }],
        parties: [
          {
            orgId: hubDept.id,
            role: "buyer",
            evidenceStrength: "party_of_record",
            reportedName: hubDept.name,
          },
          { orgId: c.id, role: "prime", evidenceStrength: "party_of_record", reportedName: c.name },
        ],
        currency: "CAD",
        disclosureRows: [
          {
            reportingPeriod: "2025-2026-Q1",
            instrument: "original",
            originalValue: String(50_000 + Math.floor(rand() * 900_000)),
            amendmentValue: null,
            // Some rows state no total: a gap, never a zero.
            totalValue: chance(0.05) ? null : String(50_000 + Math.floor(rand() * 900_000)),
            endOnAsStated: "2027-03-31",
          },
        ],
        valueStatements: [],
        allocations: [],
        repayability: null,
        announcedOn: "2025",
        startOn: null,
        statusAsOf: { state: "unknown", asOf: TODAY },
        ...prov("verified", ev(s, `row ${counter}`)),
      };
      if (g.family === "grant_contribution") {
        g.type = "contribution";
        g.parties[0] = { ...g.parties[0]!, role: "funder" };
        g.parties[1] = { ...g.parties[1]!, role: "recipient" };
      }
      agreements.push(g);
    }
  }

  // ---- Heavy companies: large suppliers with hundreds of agreements across departments -------
  if (departments.length)
    for (const c of included.slice(0, 3)) {
      manifest.heavyCompanies.push(c.id);
      const s = source("Disclosure dataset (large supplier)", "gov_dataset", "T1");
      for (let k = 0; k < 300; k++) {
        const dept = departments[k % departments.length]!;
        const amended = k % 4 === 0;
        agreements.push({
          id: id("agr"),
          family: "procurement",
          type: "contract_award",
          title: `Support services task ${k + 1}`,
          programId: null,
          groupId: null,
          externalIds: [{ system: "stress-ref", value: `HEAVY-${counter}` }],
          parties: [
            {
              orgId: dept.id,
              role: "buyer",
              evidenceStrength: "party_of_record",
              reportedName: dept.name,
            },
            {
              orgId: c.id,
              role: "prime",
              evidenceStrength: "party_of_record",
              reportedName: c.name,
            },
          ],
          currency: "CAD",
          disclosureRows: [
            {
              reportingPeriod: `20${10 + (k % 15)}-Q1`,
              instrument: "original",
              originalValue: String(25_000 + k * 1_000),
              amendmentValue: null,
              totalValue: String(25_000 + k * 1_000),
              endOnAsStated: null,
            },
            ...(amended
              ? [
                  {
                    reportingPeriod: `20${10 + (k % 15)}-Q3`,
                    instrument: "amendment" as const,
                    originalValue: String(25_000 + k * 1_000),
                    amendmentValue: "-5000",
                    totalValue: String(20_000 + k * 1_000),
                    endOnAsStated: null,
                  },
                ]
              : []),
          ],
          valueStatements: [],
          allocations: [],
          repayability: null,
          announcedOn: `20${10 + (k % 15)}`,
          startOn: null,
          statusAsOf: { state: "unknown", asOf: TODAY },
          ...prov("verified", [
            { sourceId: s, locator: `row ${counter}-a`, locatorQuality: "metadata" },
            ...(amended
              ? [{ sourceId: s, locator: `row ${counter}-b`, locatorQuality: "metadata" as const }]
              : []),
          ]),
        });
      }
    }

  // ---- Other transfer payments and unpublishable agreements ---------------------------------
  for (const c of included) {
    if (chance(0.02) && hubDept) {
      const g: Agreement = {
        id: id("agr"),
        family: "other_transfer",
        type: "other_transfer_payment",
        sourceClassification: {
          system: "stress:agreement_type",
          code: "O",
          label: "Other transfer payment",
        },
        title: "Synthetic other transfer",
        programId: null,
        groupId: null,
        externalIds: [],
        parties: [
          {
            orgId: hubDept.id,
            role: "funder",
            evidenceStrength: "party_of_record",
            reportedName: hubDept.name,
          },
          {
            orgId: c.id,
            role: "recipient",
            evidenceStrength: "party_of_record",
            reportedName: c.name,
          },
        ],
        currency: "CAD",
        disclosureRows: [
          {
            reportingPeriod: "amendment 0 (2024-04-01)",
            instrument: "original",
            originalValue: "2500000",
            amendmentValue: null,
            totalValue: "2500000",
            endOnAsStated: "2027-03-31",
          },
        ],
        valueStatements: [],
        allocations: [],
        repayability: "unknown",
        announcedOn: null,
        startOn: "2024-04-01",
        statusAsOf: { state: "unknown", asOf: TODAY },
        ...prov("verified", ev(source("Other transfer disclosure"))),
      };
      agreements.push(g);
      manifest.otherTransfers.push(g.id);
    }
    if (chance(0.02) && hubDept) {
      const g: Agreement = {
        ...agreements[agreements.length - 1]!,
        id: id("agr"),
        family: "procurement",
        type: "contract_award",
        sourceClassification: null,
        title: "Unreviewed contract lead",
        parties: [
          {
            orgId: hubDept.id,
            role: "buyer",
            evidenceStrength: "party_of_record",
            reportedName: hubDept.name,
          },
          { orgId: c.id, role: "prime", evidenceStrength: "party_of_record", reportedName: c.name },
        ],
        ...prov(chance(0.5) ? "proposed" : "rejected", ev(source("Unreviewed contract lead"))),
      };
      agreements.push(g);
      manifest.unpublishable.push(g.id);
    }
  }

  return {
    corpus: sealDemoCorpus(
      { ...base, organizations, assertions, rounds, agreements, sources },
      TODAY,
    ),
    manifest,
  };
}
