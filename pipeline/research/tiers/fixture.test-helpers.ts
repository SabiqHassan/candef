/**
 * A small fictional corpus for the tier tests. Every name, number and amount is invented.
 * Not a test file itself (no `describe`); imported by rules, sample and apply tests.
 */
import type {
  Agreement,
  Assertion,
  Corpus,
  FinancingRound,
  Source,
} from "../../../src/domain/schema/corpus";
import { rowLocator } from "../../ingest/gov/locators";
import { toGrantRow, type GrantRow } from "../../ingest/gov/tbs";
import type { ClaimSignal } from "../blind";
import type { RawRows } from "../verifyGovClaims";
import { normalize } from "./match";
import type { TierInputs } from "./rules";

export const ORG = "org_fict_alpha";
export const DEPT = "org_fict_dept";
export const DATASET = "src_fict_grants";

const prov = (evidence: Assertion["evidence"]) => ({
  epistemic: "sourced_fact" as const,
  verification: "proposed" as const,
  evidence,
  review: null,
  createdBy: "test",
});

export function source(id: string, over: Partial<Source> = {}): Source {
  return {
    id,
    kind: "registry",
    tier: "T1",
    publisher: "Fictional Registry",
    title: "Fictional page",
    url: `https://example.invalid/${id}`,
    publishedOn: null,
    retrievedAt: "2026-10-15T00:00:00Z",
    originGroup: `og:${id}`,
    textSha256: null,
    sourceBasis: "named",
    permissions: {
      capture: "allowed",
      retainInternal: "allowed",
      quoteInternal: "allowed",
      redistributeExcerpt: "allowed",
      automatedCollection: "unknown",
      attributionRequired: null,
      basis: "fictional",
      termsReviewedAt: "2026-10-15",
    },
    captures: [
      {
        id: `cap_${id}`,
        retrievedAt: "2026-10-15T00:00:00Z",
        method: "http",
        httpStatus: 200,
        rawSha256: "a".repeat(64),
        textSha256: "b".repeat(64),
        path: `captures/${id}.html`,
      },
    ],
    ...over,
  };
}

export function fact(
  id: string,
  predicate: Assertion["predicate"],
  value: unknown,
  src: string,
  over: Partial<Assertion> = {},
): Assertion {
  return {
    id,
    subjectId: ORG,
    predicate,
    value,
    primary: false,
    validFrom: null,
    validTo: null,
    asOf: null,
    supersedes: null,
    ...prov([
      { sourceId: src, locator: "overview", locatorQuality: "body", captureId: `cap_${src}` },
    ]),
    ...over,
  };
}

export function grantRow(over: Record<string, string> = {}): GrantRow {
  return toGrantRow({
    ref_number: "FICT-G1",
    owner_org: "fict",
    owner_org_title: "Fictional Department",
    recipient_legal_name: "Fictional Alpha Inc.",
    recipient_business_number: "123456789RC0001",
    recipient_postal_code: "K1A 0B1",
    agreement_number: "FICT-AGR1",
    amendment_number: "0",
    agreement_type: "C",
    agreement_value: "250000.0",
    agreement_start_date: "2025-01-01",
    agreement_end_date: "2026-01-01",
    ...over,
  });
}

export function grantAgreement(row: GrantRow, id = "agr_tbs_g_fict1"): Agreement {
  return {
    id,
    family: "grant_contribution",
    type: "contribution",
    title: "Fictional contribution",
    programId: null,
    groupId: null,
    externalIds: [{ system: "tbs-grants:agreement_number", value: row.agreement_number }],
    parties: [
      {
        orgId: DEPT,
        role: "funder",
        evidenceStrength: "party_of_record",
        reportedName: row.owner_org_title,
      },
      {
        orgId: ORG,
        role: "recipient",
        evidenceStrength: "party_of_record",
        reportedName: row.recipient_legal_name,
      },
    ],
    currency: "CAD",
    disclosureRows: [
      {
        reportingPeriod: `amendment 0 (${row.agreement_start_date})`,
        instrument: "original",
        originalValue: null,
        amendmentValue: null,
        totalValue: row.agreement_value,
        endOnAsStated: row.agreement_end_date,
      },
    ],
    valueStatements: [],
    allocations: [],
    repayability: null,
    announcedOn: null,
    startOn: row.agreement_start_date,
    statusAsOf: { state: "unknown", asOf: "2026-10-15" },
    ...prov([
      { sourceId: DATASET, locator: rowLocator("grants", row), locatorQuality: "metadata" },
    ]),
  };
}

export function round(id: string, src: string): FinancingRound {
  const ev = [
    {
      sourceId: src,
      locator: "first paragraph",
      locatorQuality: "body" as const,
      captureId: `cap_${src}`,
    },
  ];
  return {
    id,
    companyId: ORG,
    eventState: "closed",
    roundLabelAsStated: "Series A",
    stage: "series_a",
    instrument: "equity",
    proceeds: "primary",
    participantsCompleteness: "partial_named",
    disclosures: [
      {
        id: `${id}_d1`,
        date: "2024-05-02",
        kind: "single",
        amount: {
          amount: "12000000",
          currency: "USD",
          disclosure: "disclosed",
          asStated: "US$12 million",
        },
        amountBasis: "cumulative_round_total",
        amountNature: "unspecified",
        ...prov(ev),
      },
    ],
    participations: [
      {
        reportedName: "Fictional Ventures",
        investorId: "org_fict_vc",
        vehicleId: null,
        role: "lead",
        disclosureIds: [],
        ...prov(ev),
      },
    ],
    ...prov(ev),
  };
}

export function corpus(over: Partial<Corpus> = {}): Corpus {
  return {
    schemaVersion: "0.3",
    isDemo: false,
    taxonomy: [],
    sources: [
      source("src_fict_reg"),
      source("src_fict_pr", { kind: "company_release", tier: "T2" }),
      source(DATASET, { kind: "gov_dataset" }),
    ],
    organizations: [
      {
        id: ORG,
        kind: "company",
        slug: "fict-alpha",
        name: "Fictional Alpha",
        mergedInto: null,
        isDemo: false,
      },
      {
        id: DEPT,
        kind: "government_body",
        slug: "fict-dept",
        name: "Fictional Department",
        mergedInto: null,
        isDemo: false,
      },
      {
        id: "org_fict_vc",
        kind: "investor_firm",
        slug: "fict-vc",
        name: "Fictional Ventures",
        mergedInto: null,
        isDemo: false,
      },
    ],
    assertions: [],
    rounds: [],
    agreements: [],
    acquisitions: [],
    programs: [],
    research: [],
    ...over,
  };
}

export const consistent = (claimId: string): ClaimSignal => ({
  claimId,
  fieldId: "A01",
  signal: "consistent",
  stale: false,
  contradictory: false,
  researchers: ["R-fict"],
  origins: ["example.invalid/x"],
});

export function inputs(
  c: Corpus,
  over: Partial<TierInputs> & { pages?: Record<string, string>; rows?: GrantRow[] } = {},
): TierInputs {
  const pages = over.pages ?? {};
  const rows: RawRows = { contracts: new Map(), grants: new Map() };
  for (const r of over.rows ?? [])
    rows.grants.set(r.ref_number, [...(rows.grants.get(r.ref_number) ?? []), r]);
  return {
    corpus: c,
    today: "2026-10-15",
    readCapture: (sourceId) => (pages[sourceId] === undefined ? null : normalize(pages[sourceId]!)),
    govRows: rows,
    datasetSources: { contracts: "src_fict_contracts", grants: DATASET },
    corroboration: new Map(),
    plan: {
      version: 1,
      inputHash: "x",
      hash: "y",
      changes: [],
      replacements: [],
      aliases: [],
      reviewedIds: [],
      cases: [],
    },
    ...over,
  };
}
