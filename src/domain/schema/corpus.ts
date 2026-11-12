/**
 * Research corpus schema (DATA_SCHEMA v0.3, implemented subset).
 *
 * The corpus is what researchers author (or, for demo builds, what the fixture generator emits).
 * The compiler validates it, applies integrity gates and resolution rules, and produces the
 * read-model snapshot (`snapshot.ts`). The UI never reads the corpus directly.
 */
import { z } from "zod";
import { isHttpUrl } from "../url";

export const PartialDate = z
  .string()
  .regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "PartialDate must be YYYY, YYYY-MM or YYYY-MM-DD");
export type PartialDate = z.infer<typeof PartialDate>;

export const Epistemic = z.enum([
  "sourced_fact",
  "analyst_interpretation",
  "model_classification",
  "estimate",
  "demo",
]);
export type Epistemic = z.infer<typeof Epistemic>;

export const Verification = z.enum([
  "proposed",
  "verified",
  "rejected",
  "disputed",
  "superseded",
  "retracted",
]);
export type Verification = z.infer<typeof Verification>;

export const Tier = z.enum(["T1", "T2", "T3", "T4"]);

/** Per-source rights (D-15). `unknown` is treated as denied everywhere. */
export const Permission = z.enum(["allowed", "denied", "unknown"]);
export const SourcePermissions = z.object({
  capture: Permission.default("unknown"),
  retainInternal: Permission.default("unknown"),
  quoteInternal: Permission.default("unknown"),
  redistributeExcerpt: Permission.default("unknown"),
  /** Scripted or bulk collection (robots.txt and terms), distinct from a one-off capture. */
  automatedCollection: Permission.default("unknown"),
  /** e.g. the Open Government Licence – Canada requires attribution. */
  attributionRequired: z.boolean().nullable().default(null),
  /**
   * Whether claims derived from this source may appear in the share build (D-21 section 8). Absent
   * means the default for the source kind: allowed for public sources, denied for
   * `licensed_database` until the owner confirms the licence allows it.
   */
  shareDerivedData: Permission.optional(),
  /** What terms or licence were read: name, URL. */
  basis: z.string().nullable().default(null),
  termsReviewedAt: z.string().nullable().default(null),
});
export type SourcePermissions = z.infer<typeof SourcePermissions>;

/** An immutable retrieval of a source, stored in research-cache/ (never in Git) (D-15, F-39). */
export const Capture = z.object({
  id: z.string(),
  retrievedAt: z.string(),
  method: z.enum(["http", "browser", "manual"]),
  httpStatus: z.number().int().nullable().default(null),
  /** SHA-256 of the stored bytes (integrity). */
  rawSha256: z.string(),
  /** SHA-256 of normalized visible text (change detection). */
  textSha256: z.string().nullable(),
  /** Path relative to research-cache/. */
  path: z.string(),
});
export type Capture = z.infer<typeof Capture>;

/**
 * Hashes of a retrieval whose bytes were NOT kept (D-15 "hashes only"): used when the source's terms
 * do not allow keeping a copy. Detects later changes; is not a capture and never satisfies a rule
 * that needs a saved copy (VERIFICATION_TIERS.md T2-b).
 */
export const Fingerprint = z.object({
  id: z.string(),
  retrievedAt: z.string(),
  httpStatus: z.number().int().nullable().default(null),
  rawSha256: z.string(),
  textSha256: z.string().nullable(),
});
export type Fingerprint = z.infer<typeof Fingerprint>;

export const Source = z.object({
  id: z.string(),
  kind: z.enum([
    "registry",
    "gov_dataset",
    "gov_disclosure",
    "filing",
    "patent_office",
    "company_release",
    "counterparty_release",
    "investor_release",
    "advisor_disclosure",
    "news",
    /** A licensed commercial database such as PitchBook (D-21 section 7): tier T3. */
    "licensed_database",
    "other",
  ]),
  tier: Tier,
  publisher: z.string(),
  title: z.string(),
  url: z
    .string()
    .refine(isHttpUrl, { message: "a source URL must be a web address (http or https)" }),
  publishedOn: PartialDate.nullable(),
  retrievedAt: z.string(),
  originGroup: z.string(),
  textSha256: z.string().nullable(),
  /** Anonymous-source reporting is never publishable as fact for money (P-18). */
  sourceBasis: z.enum(["named", "anonymous_sources"]).default("named"),
  // Optional (added in M3; absent = every permission unknown, no captures, availability unknown).
  permissions: SourcePermissions.optional(),
  captures: z.array(Capture).optional(),
  fingerprints: z.array(Fingerprint).optional(),
  availability: z.enum(["ok", "moved", "unavailable", "unknown"]).optional(),
  lastCheckedAt: z.string().nullable().optional(),
});
export type Source = z.infer<typeof Source>;

export const Evidence = z.object({
  sourceId: z.string(),
  locator: z.string(),
  locatorQuality: z.enum(["body", "headline", "related_link", "metadata"]).default("body"),
  /** The capture the locator was read in, when one exists (binds evidence to a version). */
  captureId: z.string().nullable().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

/**
 * How an approval was reached (D-21 section 6.1). Absent on older reviews, which means
 * `owner_record`: the owner checked the record against its source.
 */
export const ReviewBasis = z.object({
  kind: z.enum([
    "tier1_dataset_match",
    "tier2_source_check",
    "owner_judgement",
    "owner_record",
    /** Passed the verification policy's checks (P-60); the owner accepted the batch. */
    "policy_clearance",
  ]),
  /** Rule set and version, e.g. "tiers@1". */
  rule: z.string(),
  /** SHA-256 of the tiers file the batch was applied from; null for a one-off owner review. */
  batch: z.string().nullable(),
});
export type ReviewBasis = z.infer<typeof ReviewBasis>;

export const Review = z.object({
  by: z.string(),
  at: z.string(),
  /** SHA-256 over the canonical assertion content at review time; any edit invalidates it. */
  hash: z.string(),
  /** The owner's reason, on rejections written by `candef apply-decisions`. */
  note: z.string().max(500).optional(),
  basis: ReviewBasis.optional(),
});
export type Review = z.infer<typeof Review>;

/** Common provenance envelope for every assertion-bearing record. */
export const Provenance = z.object({
  epistemic: Epistemic,
  verification: Verification,
  evidence: z.array(Evidence),
  review: Review.nullable(),
  createdBy: z.string(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Money = z.object({
  /** Decimal string; never a float. null when undisclosed / not applicable. */
  amount: z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .nullable(),
  currency: z.string().regex(/^[A-Z]{3}$|^unknown$/),
  disclosure: z.enum(["disclosed", "undisclosed", "approximate", "range", "not_applicable"]),
  asStated: z.string(),
});
export type Money = z.infer<typeof Money>;

export const OrgKind = z.enum([
  "company",
  "investor_firm",
  "fund",
  "government_body",
  "research_institution",
  "corporate",
  "other",
]);
export type OrgKind = z.infer<typeof OrgKind>;

export const Organization = z.object({
  id: z.string(),
  kind: OrgKind,
  slug: z.string(),
  name: z.string(),
  mergedInto: z.string().nullable().default(null),
  /** Recorded human decision: these look alike (name/identifier) but are different entities. */
  distinctFrom: z.array(z.string()).optional(),
  /** Fixture records carry `demo` so they can never leak into a non-demo build. */
  isDemo: z.boolean(),
});
export type Organization = z.infer<typeof Organization>;

/** Atomic facts about an organization. `value` shape depends on `predicate`. */
export const Predicate = z.enum([
  "legal_name",
  "hq_location",
  "founded_year",
  "description",
  "classified_as",
  "eligibility",
  "public_listing",
  "subsidiary_of",
  "predecessor_of",
  "division_of",
  "managed_by",
  "operations_location",
  "website",
  "role_held",
  /** { system, value }: e.g. cra-bn (business number), corporations-canada (corporation number). */
  "registry_id",
  /** Company-stated cumulative total ("raised $40M to date", F-15): shown as stated, never summed. */
  "total_raised_as_stated",
]);
export type Predicate = z.infer<typeof Predicate>;

export const PredecessorValue = z.strictObject({
  orgId: z.string().min(1),
  event: z.enum(["amalgamation", "name_change", "reorganization", "other"]),
  date: PartialDate,
});
export type PredecessorValue = z.infer<typeof PredecessorValue>;

export const Assertion = Provenance.extend({
  id: z.string(),
  subjectId: z.string(),
  predicate: Predicate,
  value: z.unknown(),
  primary: z.boolean().default(false),
  validFrom: PartialDate.nullable().default(null),
  validTo: PartialDate.nullable().default(null),
  asOf: PartialDate.nullable().default(null),
  supersedes: z.string().nullable().default(null),
}).superRefine((assertion, ctx) => {
  if (assertion.predicate !== "predecessor_of") return;
  const parsed = PredecessorValue.safeParse(assertion.value);
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      ctx.addIssue({ code: "custom", path: ["value", ...issue.path], message: issue.message });
});
export type Assertion = z.infer<typeof Assertion>;

export const Disclosure = Provenance.extend({
  id: z.string(),
  date: PartialDate,
  kind: z.enum(["first_close", "extension", "final", "single", "unknown"]),
  amount: Money,
  amountBasis: z.enum(["cumulative_round_total", "incremental", "unknown"]),
  /** Amount committed vs funds received, when the source distinguishes (P-19). */
  amountNature: z.enum(["committed", "received", "unspecified"]).default("unspecified"),
});
export type Disclosure = z.infer<typeof Disclosure>;

export const Participation = Provenance.extend({
  reportedName: z.string(),
  /** Economic investor for roll-up (firm), never the fund (P-19: no firm + fund double count). */
  investorId: z.string(),
  vehicleId: z.string().nullable().default(null),
  role: z.enum(["lead", "co_lead", "participant", "unknown"]),
  disclosureIds: z.array(z.string()).default([]),
});
export type Participation = z.infer<typeof Participation>;

export const FinancingRound = Provenance.extend({
  id: z.string(),
  companyId: z.string(),
  eventState: z.enum(["announced", "closed", "reported", "unknown"]),
  roundLabelAsStated: z.string().nullable(),
  stage: z
    .enum(["pre_seed", "seed", "series_a", "series_b", "series_c", "series_d_plus", "growth"])
    .nullable(),
  instrument: z.enum([
    "equity",
    "convertible",
    "safe",
    "venture_debt",
    "mixed",
    "public_offering",
    "private_placement",
    "unknown",
  ]),
  proceeds: z.enum(["primary", "secondary", "mixed", "unknown"]),
  participantsCompleteness: z.enum(["complete", "partial_named", "unknown"]),
  disclosures: z.array(Disclosure),
  participations: z.array(Participation),
  /**
   * Valuation estimates that the company did not disclose (PitchBook's or anyone's; D-21 section 7).
   * Private build only, labelled as estimates; never in totals, headline metrics or sorting, and
   * never compiled into the share build. Disclosed valuations are not estimates.
   */
  valuationEstimates: z
    .array(
      z.object({
        money: Money,
        /** Who estimated it, e.g. "PitchBook". */
        estimator: z.string(),
        asOf: PartialDate.nullable(),
        evidence: z.array(Evidence),
      }),
    )
    .optional(),
});
export type FinancingRound = z.infer<typeof FinancingRound>;

export const AgreementParty = z.object({
  orgId: z.string(),
  role: z.enum(["buyer", "funder", "prime", "subcontractor", "recipient", "partner", "member"]),
  evidenceStrength: z.enum(["party_of_record", "named_in_description"]),
  reportedName: z.string(),
});
export type AgreementParty = z.infer<typeof AgreementParty>;

export const ValueBasis = z.object({
  options: z.enum(["included", "excluded", "unknown"]),
  taxes: z.enum(["included", "excluded", "unknown"]),
  stage: z.enum(["announced", "awarded", "amended", "realized", "maximum"]),
});
export type ValueBasis = z.infer<typeof ValueBasis>;

/** Decimal money string ("1234.56", "-25000"); never a float, never an empty string. */
const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "expected a decimal string like 1234.56");

export const DisclosureRow = z.object({
  /** Verbatim disclosure row (cumulative); rows ordered by reporting period (F-18). */
  reportingPeriod: z.string(),
  instrument: z.enum(["original", "amendment"]),
  /** null when the disclosure does not state it (never coerced to 0). */
  originalValue: DecimalString.nullable(),
  amendmentValue: DecimalString.nullable(),
  totalValue: DecimalString.nullable(),
  endOnAsStated: PartialDate.nullable(),
});
export type DisclosureRow = z.infer<typeof DisclosureRow>;

export const Agreement = Provenance.extend({
  id: z.string(),
  /**
   * Procurement contracts and grants are distinct relationship families (P-16). `other_transfer` is
   * a third, separate family for payments a source files as "other transfer payments" (TBS grants
   * type O): neither a grant or contribution nor a purchase, so it is never merged into either.
   */
  family: z.enum(["procurement", "grant_contribution", "partnership", "other_transfer"]),
  type: z.enum([
    "contract_award",
    "standing_offer",
    "call_up",
    "grant",
    "contribution",
    "challenge_award",
    "pilot",
    "mou",
    "partnership",
    "other_transfer_payment",
  ]),
  /**
   * The source's own classification of the agreement, kept verbatim next to our family so that
   * nothing is lost when several source codes map to one family (for example TBS agreement_type
   * G, C or O: `{ system: "tbs-grants:agreement_type", code: "O", label: "Other transfer payment" }`).
   */
  sourceClassification: z
    .object({ system: z.string(), code: z.string(), label: z.string() })
    .nullable()
    .optional(),
  title: z.string(),
  programId: z.string().nullable(),
  groupId: z.string().nullable(),
  externalIds: z.array(z.object({ system: z.string(), value: z.string() })),
  parties: z.array(AgreementParty),
  currency: z.string(),
  disclosureRows: z.array(DisclosureRow),
  valueStatements: z.array(
    z.object({ money: Money, basis: ValueBasis, evidence: z.array(Evidence) }),
  ),
  allocations: z.array(z.object({ orgId: z.string(), money: Money, evidence: z.array(Evidence) })),
  repayability: z
    .enum(["non_repayable", "repayable", "conditionally_repayable", "unknown"])
    .nullable(),
  announcedOn: PartialDate.nullable(),
  startOn: PartialDate.nullable(),
  statusAsOf: z.object({
    state: z.enum(["stated_active", "stated_completed", "unknown"]),
    asOf: PartialDate,
  }),
});
export type Agreement = z.infer<typeof Agreement>;

export const Acquisition = Provenance.extend({
  id: z.string(),
  targetId: z.string(),
  acquirerId: z.string(),
  history: z.array(
    z.object({
      state: z.enum(["agreement_announced", "completed", "terminated"]),
      date: PartialDate,
    }),
  ),
  consideration: Money,
  reportedConsideration: z.array(
    z.object({ money: Money, sourceBasis: z.enum(["named", "anonymous_sources"]) }),
  ),
});
export type Acquisition = z.infer<typeof Acquisition>;

export const ResearchTopic = z.enum([
  "identity",
  "financing",
  "agreements",
  "patents",
  "people",
  "eligibility",
]);
export type ResearchTopic = z.infer<typeof ResearchTopic>;

export const ResearchAttempt = z.object({
  id: z.string(),
  subjectId: z.string(),
  topic: ResearchTopic,
  sourcesSearched: z.array(z.string()),
  outcome: z.enum(["found", "none_found", "partial"]),
  by: z.string(),
  at: PartialDate,
  nextReview: PartialDate.nullable(),
});
export type ResearchAttempt = z.infer<typeof ResearchAttempt>;

export const TaxonomyNode = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  label: z.string(),
  definition: z.string(),
});
export type TaxonomyNode = z.infer<typeof TaxonomyNode>;

export const Program = z.object({ id: z.string(), funderId: z.string(), name: z.string() });
export type Program = z.infer<typeof Program>;

export const Corpus = z.object({
  schemaVersion: z.literal("0.3"),
  isDemo: z.boolean(),
  taxonomy: z.array(TaxonomyNode),
  sources: z.array(Source),
  organizations: z.array(Organization),
  assertions: z.array(Assertion),
  rounds: z.array(FinancingRound),
  agreements: z.array(Agreement),
  acquisitions: z.array(Acquisition),
  programs: z.array(Program),
  research: z.array(ResearchAttempt),
});
export type Corpus = z.infer<typeof Corpus>;
