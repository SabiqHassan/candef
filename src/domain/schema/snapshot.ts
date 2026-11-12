/**
 * Read-model snapshot consumed by the UI (DATA_SCHEMA §13, v0.3).
 * Produced only by the compiler. Every display field carries an explicit data state, so the UI can
 * never present missing, unconfirmed or undisclosed information as a fact.
 */
import type { Epistemic, Money, OrgKind, ResearchTopic, PredecessorValue } from "./corpus";

export const SNAPSHOT_SCHEMA_VERSION = "0.7.0";

/**
 * verified:       published, hash-valid human review, evidence meets the predicate rule
 * unconfirmed:    researched and something was reported, but not verified; the value is withheld
 * undisclosed:    the event is verified, the value was not disclosed
 * not_found:      researched (ledger entry) and nothing was found in the sources reviewed
 * not_researched: no research attempt on file
 * disputed:       conflicting verified values; all are shown with their sources
 * withheld:       verified, but no supporting source allows sharing it in this edition (share build)
 */
export type FieldState =
  | "verified"
  | "unconfirmed"
  | "undisclosed"
  | "not_found"
  | "not_researched"
  | "disputed"
  | "withheld";

export interface Fact<T> {
  value: T | null;
  state: FieldState;
  epistemic: Epistemic | null;
  assertionIds: string[];
  asOf: string | null;
  /** For `disputed`: every competing verified value. */
  alternatives?: { value: T; assertionIds: string[] }[];
  /** Earlier approved values replaced by supersession, newest first. Never the current value. */
  history?: { value: T; assertionIds: string[]; asOf: string | null; replacedOn: string | null }[];
}

export interface HqValue {
  city: string | null;
  region: string | null;
  province: string | null;
  country: string;
}

export interface SegmentRef {
  id: string;
  label: string;
  sectorId: string;
  sectorLabel: string;
}

export type OwnershipStatus = "independent" | "subsidiary" | "unknown";
export type OperatingStatus = "operating" | "acquired" | "discontinued";

export interface MoneyTotal {
  currency: string;
  amount: string;
}

export interface FinancingSummary {
  roundsKnown: number;
  roundsWithResolvedAmount: number;
  /** Verified rounds with a stated amount, including amounts that cannot be resolved for totals. */
  roundsWithStatedAmount?: number;
  /** Per currency, never converted. Sums only resolved primary rounds. */
  totals: MoneyTotal[];
  latestStage: string | null;
  latestRoundDate: string | null;
  flags: string[];
}

export interface ResearchState {
  state: "researched" | "not_researched" | "stale";
  lastAt: string | null;
  nextReview: string | null;
  outcome: "found" | "none_found" | "partial" | null;
}

export interface OrgView {
  id: string;
  slug: string;
  name: string;
  kind: OrgKind;
  isDemo: boolean;
  /** universe: Canadian-HQ eligible company; contextual: shown only to explain relationships. */
  scope: "universe" | "contextual";
  legalName: Fact<string>;
  hq: Fact<HqValue>;
  founded: Fact<number>;
  description: Fact<string>;
  segment: Fact<SegmentRef>;
  secondarySegments: SegmentRef[];
  listing: Fact<{ exchange: string; ticker: string }>;
  marketStatus: "public" | "private" | "unknown";
  ownership: {
    status: OwnershipStatus;
    parentId: string | null;
    since: string | null;
    parentIsForeign: boolean | null;
    history: { parentId: string; from: string | null; to: string | null }[];
    /** Evidence for the parent relationship (empty when independent or unknown). */
    assertionIds: string[];
    /**
     * State of the parent-company fact itself, so "no parent found" is never shown as a claim of
     * independence (0.6.x; optional for older snapshots).
     */
    parentState?: Fact<string>["state"];
    parentAsOf?: string | null;
  };
  operating: OperatingStatus;
  lineage?: (PredecessorValue & {
    direction: "predecessor_of" | "successor_of";
    assertionIds: string[];
  })[];
  eligibility: {
    decision: "included" | "excluded" | "pending" | "ambiguous";
    rationale: string | null;
    assertionIds: string[];
  } | null;
  managedBy: string | null;
  /** Evidence for the fund-to-manager link (P-36). Optional for older snapshots. */
  managedByAssertionIds?: string[];
  /** Verified registry identifiers (corporation number, business number…). Optional for older snapshots. */
  identifiers?: { system: string; value: string; assertionIds: string[] }[];
  financing: FinancingSummary | null;
  research: Partial<Record<ResearchTopic, ResearchState>>;
  /** Relative graph prominence (documented relationship count, compressed). */
  weight: number;
}

/**
 * One piece of evidence for one claim (P-36). `locator` says exactly where in the source the claim is
 * (page, section, table row, record reference); `quality` says how that locator was obtained.
 */
export interface Citation {
  sourceId: string;
  locator: string;
  quality: "body" | "headline" | "related_link" | "metadata";
}

export interface RoundView {
  id: string;
  companyId: string;
  label: string | null;
  stage: string | null;
  date: string | null;
  eventState: string;
  instrument: string;
  proceeds: string;
  resolved: {
    status: "resolved" | "unclear" | "undisclosed";
    money: Money | null;
    note: string | null;
  };
  disclosures: {
    id: string;
    date: string;
    kind: string;
    amount: Money;
    amountBasis: string;
    amountNature: string;
    citations: Citation[];
  }[];
  participants: {
    investorId: string;
    vehicleId: string | null;
    role: string;
    reportedName: string;
    citations: Citation[];
    /** Disclosures (tranches) this investor took part in, when the source says so. Optional for older snapshots. */
    disclosureIds?: string[];
  }[];
  participantsCompleteness: string;
  verification: string;
  epistemic: Epistemic;
  sourceIds: string[];
  /** Locator-level evidence for the round itself (disclosures and participants carry their own). */
  citations: Citation[];
}

export interface AttributionView {
  orgId: string;
  money: Money | null;
  basis: "allocation" | "sole_party" | "consortium_undisclosed" | "not_applicable";
}

export interface AgreementView {
  id: string;
  family: "procurement" | "grant_contribution" | "partnership" | "other_transfer";
  type: string;
  /** The source's own classification, verbatim (for example TBS agreement_type O). Null if none. */
  sourceClassification?: { system: string; code: string; label: string } | null;
  title: string;
  programName: string | null;
  counterpartyId: string | null;
  parties: { orgId: string; role: string; evidenceStrength: string; reportedName: string }[];
  /** Latest disclosure row total (T1), else first value statement. */
  currentValue: Money | null;
  originalValue: string | null;
  /** Currency of the disclosure rows (optional for older snapshots). Never assumed to be CAD. */
  currency?: string;
  valueBasis: string;
  valueStatements: { money: Money; basis: string; sourceIds: string[]; citations: Citation[] }[];
  rows: {
    reportingPeriod: string;
    instrument: string;
    amendmentValue: string | null;
    totalValue: string | null;
    endOnAsStated: string | null;
    /** The source row this disclosure row was read from, when the record keeps one citation per row. */
    citation: Citation | null;
  }[];
  attributions: AttributionView[];
  announcedOn: string | null;
  /** Start date as disclosed; shown when no announcement date is recorded. */
  startOn: string | null;
  status: { state: string; asOf: string };
  repayability: string | null;
  externalIds: { system: string; value: string }[];
  verification: string;
  epistemic: Epistemic;
  sourceIds: string[];
  citations: Citation[];
  /** CAD value used for the overview drawing threshold (P-16); null if not comparable. */
  thresholdValueCad: number | null;
}

export interface AcquisitionView {
  id: string;
  targetId: string;
  acquirerId: string;
  announcedOn: string | null;
  completedOn: string | null;
  consideration: Money;
  /** Count of anonymous-source reports withheld under P-18 (values never exposed). */
  withheldReports: number;
  sourceIds: string[];
  citations: Citation[];
}

export interface AssertionView {
  id: string;
  label: string;
  epistemic: Epistemic;
  verification: string;
  evidence: Citation[];
  review: { by: string; at: string } | null;
}

export interface SourceView {
  id: string;
  publisher: string;
  title: string;
  url: string;
  tier: string;
  kind: string;
  publishedOn: string | null;
  retrievedAt: string;
}

/**
 * When one record behind a relationship line happened (docs/TIME_VIEW.md). Dates are partial ISO
 * dates exactly as recorded; nothing is estimated. A null start means the record is undated.
 */
export interface TimelineEntry {
  recordId: string;
  /** The company end of the relationship; bundle thickness counts distinct companies. */
  companyId: string;
  /** Rounds: the investor's tranche date (else the round's first disclosure). Agreements: start date. */
  start: string | null;
  /** Agreements: latest disclosed end date, or null when not disclosed. Rounds: always null. */
  end: string | null;
  /** A financing round is a one-off event; an agreement runs over a period. */
  kind: "event" | "period";
  style: "solid" | "dashed";
  /** Procurement only: CAD value used for the P-16 drawing threshold. */
  valueCad: number | null;
}

export interface GraphEdgeView {
  id: string;
  source: string;
  target: string;
  kind: "capital" | "procurement" | "grant" | "bundle" | "lineage";
  /** Bundles only: which relationship family the aggregate summarizes (grants never read as customers). */
  family?: "capital" | "procurement" | "grant";
  /** Underlying round / agreement IDs; never drawn without at least one. */
  recordIds: string[];
  style: "solid" | "dashed";
  weight: number;
  /** Procurement only: maximum attributable CAD value across records (for the P-16 threshold). */
  valueCad: number | null;
  /** Single relationships: one dated entry per record (time view). Optional for older snapshots. */
  timeline?: TimelineEntry[];
  /** Bundles: the single relationships this aggregate summarizes (time view). Optional. */
  memberEdgeIds?: string[];
}

export interface GraphView {
  /** World positions; companies identical in every lens (D-07). */
  positions: Record<string, [number, number, number]>;
  anchors: { id: string; label: string; position: [number, number, number] }[];
  /** Subsector cluster anchors (Industry lens; labelled only when zoomed in). Optional. */
  subAnchors?: {
    id: string;
    label: string;
    sectorId: string;
    subsectorId: string;
    position: [number, number, number];
  }[];
  lenses: {
    capital: { institutionIds: string[]; edges: GraphEdgeView[]; bundles: GraphEdgeView[] };
    contracts: { institutionIds: string[]; edges: GraphEdgeView[]; bundles: GraphEdgeView[] };
    industry: { institutionIds: string[]; edges: GraphEdgeView[] };
  };
  layout: { method: string; version: string; distanceMeaning: string };
}

export interface CoverageView {
  isPilotSample: boolean;
  companiesDiscovered: number;
  /** Companies with a verified included/excluded decision (pending and ambiguous are not decided). */
  eligibilityDecided: number;
  /** Why discovered companies are outside the universe; the parts sum to discovered − inUniverse. */
  notInUniverse: { excluded: number; undecided: number; awaitingEvidence: number };
  /** Data-quality checks needing a human look, by check name (M3-C5). Optional for older snapshots. */
  quality?: Record<string, number>;
  inUniverse: number;
  researchedByTopic: Record<string, { researched: number; notResearched: number }>;
  financing: { roundsKnown: number; roundsWithResolvedAmount: number };
  agreements: {
    procurement: number;
    grants: number;
    partnerships: number;
    otherTransfers?: number;
  };
}

/**
 * How a published record was verified (docs/VERIFICATION_TIERS.md section 9), in plain words for
 * the citation card and the dossier's evidence list. `draft` appears only in the local preview.
 */
export interface VerificationView {
  kind:
    | "tier1_dataset_match"
    | "tier2_source_check"
    | "owner_judgement"
    | "owner_record"
    | "policy_clearance"
    | "licensed"
    | "draft";
  /** ISO date the check or review ran; null for drafts. */
  at: string | null;
  label: string;
}

export interface Snapshot {
  meta: {
    schemaVersion: string;
    snapshotVersion: string;
    builtAt: string;
    isDemo: boolean;
    contentHash: string;
    thresholdCad: number;
    /** "share" omits claims whose sources do not allow sharing (D-21 section 8). Absent = private. */
    audience?: "private" | "share";
    /** A local preview built from simulated approvals: never deployable. */
    preview?: boolean;
  };
  taxonomy: { id: string; parentId: string | null; label: string; definition: string }[];
  organizations: OrgView[];
  /** Old slug → surviving slug for merged organizations (optional). */
  redirects?: Record<string, string>;
  rounds: RoundView[];
  agreements: AgreementView[];
  acquisitions: AcquisitionView[];
  assertions: Record<string, AssertionView>;
  sources: Record<string, SourceView>;
  graph: GraphView;
  coverage: CoverageView;
  /** Per published record ID (assertion, round, agreement, acquisition). Optional for older snapshots. */
  verification?: Record<string, VerificationView>;
  /** Share build: records not shown in this edition, per organization. */
  withheldByOrg?: Record<string, number>;
}

export interface SnapshotManifest {
  current: string;
  schemaVersion: string;
  isDemo: boolean;
  builtAt: string;
  previous: string[];
}
