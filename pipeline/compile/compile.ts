/**
 * Corpus → Snapshot compiler. Validation, integrity gates, resolution and layout.
 * A gate failure means the snapshot must not be published (`CompileResult.ok === false`).
 */
import { Corpus as CorpusSchema } from "../../src/domain/schema/corpus";
import type { Corpus, Organization, PredecessorValue } from "../../src/domain/schema/corpus";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type AcquisitionView,
  type AgreementView,
  type AssertionView,
  type CoverageView,
  type GraphEdgeView,
  type HqValue,
  type OrgView,
  type RoundView,
  type SegmentRef,
  type Snapshot,
  type VerificationView,
} from "../../src/domain/schema/snapshot";
import { agreementEntry, roundEntry } from "../../src/domain/time";
import { buildAgreementView } from "./agreements";
import { auditCitations, toCitations } from "./citations";
import { FactIndex } from "./facts";
import { verificationView } from "./verification";
import { buildRoundView, totalsByCurrency } from "./financing";
import { canonicalJson, hasValidReview, sha256, withReviewHashCache } from "./hash";
import {
  DISTANCE_MEANING,
  LAYOUT_VERSION,
  layoutInstitutions,
  layoutUniverse,
  type Vec3,
} from "./layout";

/** Verification states that end a record: never published, not even as a placeholder. */
const CLOSED_STATES = new Set(["rejected", "retracted", "superseded"]);

import { entityFailures, qualityIssues, type GateFailure, type QualityIssue } from "./quality";

export type { GateFailure, QualityIssue };

export interface CompileOptions {
  today: string;
  thresholdCad?: number;
  previousPositions?: Record<string, Vec3>;
  /** "share": omit claims whose supporting sources do not allow sharing (D-21 section 8). */
  audience?: "private" | "share";
  /**
   * Local preview only (docs/OVERNIGHT_2026-10-15.md task 7): per record ID, the label shown instead
   * of a verification basis ("Unverified draft…"). Marks the snapshot as a preview.
   */
  draftLabels?: Record<string, string>;
}

/** Whether a source allows sharing derived claims: explicit permission, else public by default. */
export function sourceAllowsSharing(s: Corpus["sources"][number] | undefined): boolean {
  if (!s) return false;
  const p = s.permissions?.shareDerivedData;
  return p ? p === "allowed" : s.kind !== "licensed_database";
}

export interface CompileResult {
  ok: boolean;
  failures: GateFailure[];
  warnings: string[];
  /** Data-quality checks (never block the build; each needs a human look). */
  quality: QualityIssue[];
  snapshot: Snapshot | null;
}

export const PREDICATE_LABEL: Record<string, string> = {
  legal_name: "Legal name",
  hq_location: "Headquarters",
  founded_year: "Founded",
  description: "Description",
  classified_as: "Classification",
  eligibility: "Eligibility",
  public_listing: "Public listing",
  subsidiary_of: "Parent company",
  predecessor_of: "Corporate predecessor event",
  managed_by: "Managed by",
  registry_id: "Registry identifier",
  total_raised_as_stated: "Total raised (as stated by the company)",
};

export function compile(input: unknown, options: CompileOptions): CompileResult {
  return withReviewHashCache(() => compileUncached(input, options));
}

function compileUncached(input: unknown, options: CompileOptions): CompileResult {
  const failures: GateFailure[] = [];
  const warnings: string[] = [];
  const parsed = CorpusSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      failures: [
        {
          gate: "schema",
          message: parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
          ids: [],
        },
      ],
      warnings,
      quality: [],
      snapshot: null,
    };
  }
  const base: Corpus = parsed.data;
  const threshold = options.thresholdCad ?? 100_000;
  const sources = new Map(base.sources.map((s) => [s.id, s]));
  // ---- Share build (D-21 section 8): drop records no supporting source allows sharing --------
  const audience = options.audience ?? "private";
  const shareable = (ev: { sourceId: string }[]) =>
    ev.some((e) => sourceAllowsSharing(sources.get(e.sourceId)));
  const withheld = new Set<string>();
  const withheldByOrg: Record<string, number> = {};
  const withhold = (id: string, orgId: string | undefined) => {
    withheld.add(id);
    if (orgId) withheldByOrg[orgId] = (withheldByOrg[orgId] ?? 0) + 1;
  };
  if (audience === "share") {
    for (const a of base.assertions) if (!shareable(a.evidence)) withhold(a.id, a.subjectId);
    for (const r of base.rounds)
      if (
        !shareable([
          ...r.evidence,
          ...r.disclosures.flatMap((d) => d.evidence),
          ...r.participations.flatMap((p) => p.evidence),
        ])
      )
        withhold(r.id, r.companyId);
    for (const g of base.agreements)
      if (!shareable([...g.evidence, ...g.valueStatements.flatMap((v) => v.evidence)]))
        withhold(g.id, g.parties.find((p) => p.role === "prime" || p.role === "recipient")?.orgId);
    for (const q of base.acquisitions) if (!shareable(q.evidence)) withhold(q.id, q.targetId);
  }
  const corpus: Corpus =
    audience === "share"
      ? {
          ...base,
          rounds: base.rounds.filter((r) => !withheld.has(r.id)),
          agreements: base.agreements.filter((g) => !withheld.has(g.id)),
          acquisitions: base.acquisitions.filter((q) => !withheld.has(q.id)),
        }
      : base;
  const orgs = new Map(corpus.organizations.map((o) => [o.id, o]));

  // ---- Gates on the input -------------------------------------------------------------------
  const mixed = corpus.organizations.filter((o) => o.isDemo !== corpus.isDemo);
  if (mixed.length)
    failures.push({
      gate: "demo-isolation",
      message: "Demo and real records mixed in one corpus",
      ids: mixed.map((o) => o.id),
    });
  if (!corpus.isDemo) {
    const fixtureReviews = [
      ...corpus.assertions,
      ...corpus.rounds,
      ...corpus.agreements,
      ...corpus.acquisitions,
    ].filter((r) => r.review?.by === "demo-fixture");
    if (fixtureReviews.length)
      failures.push({
        gate: "demo-isolation",
        message: "Fixture review stamps in a non-demo corpus",
        ids: fixtureReviews.map((r) => r.id),
      });
  }
  const refs: [string, string][] = [
    ...corpus.assertions.map((a) => [a.id, a.subjectId] as [string, string]),
    ...corpus.rounds.flatMap((r) => [
      [r.id, r.companyId] as [string, string],
      ...r.participations.flatMap((p) => [
        [r.id, p.investorId] as [string, string],
        ...(p.vehicleId ? [[r.id, p.vehicleId] as [string, string]] : []),
      ]),
    ]),
    ...corpus.agreements.flatMap((g) => g.parties.map((p) => [g.id, p.orgId] as [string, string])),
    ...corpus.acquisitions.flatMap(
      (q) =>
        [
          [q.id, q.targetId],
          [q.id, q.acquirerId],
        ] as [string, string][],
    ),
  ];
  failures.push(...entityFailures(corpus));
  const quality = qualityIssues(corpus, options.today);
  const dangling = refs.filter(([, id]) => !orgs.has(id));
  if (dangling.length)
    failures.push({
      gate: "dangling-ids",
      message: "References to unknown organizations",
      ids: dangling.map(([rec, id]) => `${rec}->${id}`),
    });
  const evidenceIds = [
    ...corpus.assertions,
    ...corpus.rounds,
    ...corpus.agreements,
    ...corpus.acquisitions,
  ].flatMap((r) => r.evidence.map((e) => [r.id, e.sourceId] as const));
  const missingSources = evidenceIds.filter(([, s]) => !sources.has(s));
  if (missingSources.length)
    failures.push({
      gate: "evidence-sources",
      message: "Evidence cites unknown sources",
      ids: missingSources.map(([r, s]) => `${r}->${s}`),
    });
  // Evidence bound to a capture must name a capture registered on that source.
  const allEvidence = [
    ...corpus.assertions.map((a) => [a.id, a.evidence] as const),
    ...corpus.rounds.flatMap((r) => [
      [r.id, r.evidence] as const,
      ...r.disclosures.map((d) => [d.id, d.evidence] as const),
      ...r.participations.map((p) => [`${r.id}:${p.investorId}`, p.evidence] as const),
    ]),
    ...corpus.agreements.flatMap((g) => [
      [g.id, g.evidence] as const,
      ...g.valueStatements.map((v) => [g.id, v.evidence] as const),
      ...g.allocations.map((v) => [g.id, v.evidence] as const),
    ]),
    ...corpus.acquisitions.map((q) => [q.id, q.evidence] as const),
  ];
  const badCaptures = allEvidence.flatMap(([id, ev]) =>
    ev
      .filter(
        (e) =>
          e.captureId &&
          sources.has(e.sourceId) &&
          !sources.get(e.sourceId)!.captures?.some((c) => c.id === e.captureId),
      )
      .map((e) => `${id}->${e.sourceId}@${e.captureId}`),
  );
  if (badCaptures.length)
    failures.push({
      gate: "evidence-captures",
      message: "Evidence names a capture that its source does not have",
      ids: badCaptures,
    });

  const facts = new FactIndex(corpus, options.today, withheld);
  const taxonomy = new Map(corpus.taxonomy.map((t) => [t.id, t]));
  const segmentRef = (taxId: string): SegmentRef | null => {
    const node = taxonomy.get(taxId);
    if (!node) return null;
    const sector = node.parentId ? taxonomy.get(node.parentId)! : node;
    return { id: node.id, label: node.label, sectorId: sector.id, sectorLabel: sector.label };
  };

  // ---- Universe membership --------------------------------------------------------------------
  const isUniverse = (o: Organization): boolean => {
    if (o.kind !== "company" || o.mergedInto) return false;
    const hq = facts.fact<HqValue>(o.id, "hq_location");
    const elig = facts.fact<{ decision: string }>(o.id, "eligibility");
    const seg = facts.fact<string>(o.id, "classified_as");
    // Eligibility requires an evidenced Canadian HQ (country at minimum) and a classification.
    const hqCountry =
      hq.state === "verified"
        ? hq.value?.country
        : hq.state === "disputed"
          ? hq.alternatives?.[0]?.value.country
          : null;
    return (
      elig.state === "verified" &&
      elig.value?.decision === "included" &&
      hqCountry === "CA" &&
      seg.state === "verified"
    );
  };
  const universe = corpus.organizations.filter(isUniverse);
  const universeIds = new Set(universe.map((o) => o.id));
  const pendingCompanies = corpus.organizations.filter(
    (o) => o.kind === "company" && !o.mergedInto && !universeIds.has(o.id),
  );

  // ---- Records --------------------------------------------------------------------------------
  // An unverified (proposed) round is published only as a content-free "reported, not yet
  // verified" placeholder. A rejected, retracted or superseded round is not a lead and is never
  // published at all (found by the synthetic stress corpus, 2026-10-14).
  const rounds: RoundView[] = corpus.rounds
    .filter((r) => universeIds.has(r.companyId) && !CLOSED_STATES.has(r.verification))
    .map((r) => buildRoundView(r, sources));
  const programName = new Map(corpus.programs.map((p) => [p.id, p.name]));
  const agreements: AgreementView[] = corpus.agreements
    .map((g) =>
      buildAgreementView(
        g,
        universeIds,
        g.programId
          ? (programName.get(g.programId) ?? null)
          : // Government imports keep the program as published (TBS prog_name_en) on the record.
            (g.externalIds.find((x) => x.system === "tbs-grants:program")?.value ?? null),
      ),
    )
    .filter((g): g is AgreementView => g !== null && g.attributions.length > 0);
  const lineage = corpus.assertions.filter(
    (a) =>
      a.predicate === "predecessor_of" &&
      facts.publishable(a) &&
      (universeIds.has(a.subjectId) || universeIds.has((a.value as PredecessorValue).orgId)),
  );
  const acquisitions: AcquisitionView[] = corpus.acquisitions
    // Defect 4 (SELECTION.md): an acquisition is published when either side is in the universe, so an
    // acquirer's dossier lists the companies it bought. Same review gate as before.
    .filter(
      (q) =>
        hasValidReview("acquisition", q) &&
        (universeIds.has(q.targetId) || universeIds.has(q.acquirerId)),
    )
    .map((q) => ({
      id: q.id,
      targetId: q.targetId,
      acquirerId: q.acquirerId,
      announcedOn: q.history.find((h) => h.state === "agreement_announced")?.date ?? null,
      completedOn: q.history.find((h) => h.state === "completed")?.date ?? null,
      // Anonymous-source prices are never exposed (P-18); only their count, for transparency.
      consideration: q.consideration,
      withheldReports: q.reportedConsideration.filter((r) => r.sourceBasis === "anonymous_sources")
        .length,
      sourceIds: q.evidence.map((e) => e.sourceId),
      citations: toCitations(q.evidence),
    }));

  // ---- Contextual organizations: only those that explain a published relationship ------------
  const contextual = new Set<string>();
  for (const a of lineage)
    for (const id of [a.subjectId, (a.value as PredecessorValue).orgId])
      if (!universeIds.has(id)) contextual.add(id);
  for (const r of rounds)
    for (const p of r.participants) {
      contextual.add(p.investorId);
      if (p.vehicleId) contextual.add(p.vehicleId);
    }
  for (const g of agreements)
    for (const p of g.parties) if (!universeIds.has(p.orgId)) contextual.add(p.orgId);
  for (const q of acquisitions)
    for (const id of [q.acquirerId, q.targetId]) if (!universeIds.has(id)) contextual.add(id);
  for (const id of [...contextual]) {
    const managed = facts.fact<string>(id, "managed_by");
    if (managed.state === "verified" && managed.value) contextual.add(managed.value);
  }

  // ---- Org views ------------------------------------------------------------------------------
  const assertionsOut: Record<string, AssertionView> = {};
  const assertionById = new Map(corpus.assertions.map((a) => [a.id, a]));
  const recordAssertions = (ids: string[]) => {
    for (const id of ids) {
      const a = assertionById.get(id);
      if (!a || assertionsOut[id] || !(facts.publishable(a) || facts.isHistory(a))) continue;
      assertionsOut[id] = {
        id,
        label: PREDICATE_LABEL[a.predicate] ?? a.predicate,
        epistemic: a.epistemic,
        verification: a.verification === "superseded" ? "superseded" : "verified",
        evidence: toCitations(a.evidence),
        review: a.review ? { by: a.review.by, at: a.review.at } : null,
      };
    }
  };

  const roundsByCompany = new Map<string, RoundView[]>();
  for (const r of rounds)
    roundsByCompany.set(r.companyId, [...(roundsByCompany.get(r.companyId) ?? []), r]);
  const relationshipCount = new Map<string, number>();
  const bump = (id: string, n = 1) =>
    relationshipCount.set(id, (relationshipCount.get(id) ?? 0) + n);
  for (const r of rounds)
    if (r.verification === "verified") {
      bump(r.companyId);
      for (const p of r.participants) bump(p.investorId);
    }
  for (const g of agreements) {
    for (const a of g.attributions) bump(a.orgId);
    if (g.counterpartyId) bump(g.counterpartyId);
  }

  const orgView = (o: Organization, scope: OrgView["scope"]): OrgView => {
    const history = lineage
      .flatMap((a) => {
        const v = a.value as PredecessorValue;
        if (a.subjectId !== o.id && v.orgId !== o.id) return [];
        recordAssertions([a.id]);
        return [
          {
            ...v,
            orgId: a.subjectId === o.id ? v.orgId : a.subjectId,
            direction:
              a.subjectId === o.id ? ("predecessor_of" as const) : ("successor_of" as const),
            assertionIds: [a.id],
          },
        ];
      })
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date) || a.assertionIds[0]!.localeCompare(b.assertionIds[0]!),
      );
    const legalName = facts.fact<string>(o.id, "legal_name");
    const hq = facts.fact<HqValue>(o.id, "hq_location");
    const founded = facts.fact<number>(o.id, "founded_year");
    const description = facts.fact<string>(o.id, "description");
    const segment = facts.fact<SegmentRef>(
      o.id,
      "classified_as",
      (v) =>
        segmentRef(v as string) ?? {
          id: String(v),
          label: "Unclassified",
          sectorId: "",
          sectorLabel: "Unclassified",
        },
    );
    const listing = facts.fact<{ exchange: string; ticker: string }>(o.id, "public_listing");
    const parent = facts.fact<string>(o.id, "subsidiary_of");
    const eligibility = facts.fact<{
      decision: "included" | "excluded" | "pending" | "ambiguous";
      rationale: string;
    }>(o.id, "eligibility");
    const managedBy = facts.fact<string>(o.id, "managed_by");
    const identifiers = facts
      .values<{ system: string; value: string }>(o.id, "registry_id")
      .filter(({ value }) => typeof value?.system === "string" && typeof value.value === "string");
    recordAssertions(identifiers.map(({ assertion }) => assertion.id));
    const withHistory = (f: { assertionIds: string[]; history?: { assertionIds: string[] }[] }) => [
      ...f.assertionIds,
      ...(f.history ?? []).flatMap((h) => h.assertionIds),
    ];
    recordAssertions(
      [
        legalName,
        hq,
        founded,
        description,
        segment,
        listing,
        parent,
        eligibility,
        managedBy,
      ].flatMap(withHistory),
    );
    const parentAssertion =
      parent.state === "verified"
        ? facts.values<string>(o.id, "subsidiary_of")[0]?.assertion
        : undefined;
    const parentHq = parent.value ? facts.fact<HqValue>(parent.value, "hq_location") : null;
    // Every other classification, once each; never the one already shown as the segment.
    const secondary = [
      ...new Set(
        facts
          .values<string>(o.id, "classified_as")
          .filter((v) => !segment.assertionIds.includes(v.assertion.id))
          .map((v) => v.value)
          .filter((taxId) => taxId !== segment.value?.id),
      ),
    ]
      .map(segmentRef)
      .filter((s): s is SegmentRef => !!s);
    const companyRounds = roundsByCompany.get(o.id) ?? [];
    const verifiedRounds = companyRounds.filter((r) => r.verification === "verified");
    const latest = [...verifiedRounds].sort((a, b) =>
      (a.date ?? "") < (b.date ?? "") ? 1 : -1,
    )[0];
    const research = Object.fromEntries(
      (["identity", "financing", "agreements", "eligibility"] as const).map((t) => [
        t,
        facts.researchState(o.id, t),
      ]),
    );
    const acquired = acquisitions.find((q) => q.targetId === o.id);
    const flags: string[] = [];
    if (companyRounds.some((r) => r.verification !== "verified"))
      flags.push(
        `${companyRounds.filter((r) => r.verification !== "verified").length} reported round(s) not yet verified`,
      );
    if (verifiedRounds.some((r) => r.resolved.status === "unclear"))
      flags.push("Some round amounts are unclear and excluded from totals");
    const totals = totalsByCurrency(verifiedRounds);
    if (totals.length > 1) flags.push("Totals shown per currency; not converted");
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      kind: o.kind,
      isDemo: o.isDemo,
      scope,
      legalName,
      hq,
      founded,
      description,
      segment,
      secondarySegments: secondary,
      listing,
      marketStatus:
        listing.state === "verified"
          ? "public"
          : o.kind === "company"
            ? facts.researchState(o.id, "identity").state === "not_researched"
              ? "unknown"
              : "private"
            : "unknown",
      ownership: {
        status:
          parent.state === "verified"
            ? "subsidiary"
            : o.kind === "company"
              ? "independent"
              : "unknown",
        parentId: parent.value,
        since: parentAssertion?.validFrom ?? null,
        assertionIds: parent.state === "verified" ? parent.assertionIds : [],
        parentState: parent.state,
        parentAsOf: parent.asOf,
        parentIsForeign:
          parentHq && parentHq.state === "verified" ? parentHq.value?.country !== "CA" : null,
        history: parentAssertion
          ? [
              {
                parentId: parent.value!,
                from: parentAssertion.validFrom,
                to: parentAssertion.validTo,
              },
            ]
          : [],
      },
      operating: acquired ? "acquired" : "operating",
      eligibility:
        eligibility.state === "verified" && eligibility.value
          ? {
              decision: eligibility.value.decision,
              rationale: eligibility.value.rationale,
              assertionIds: eligibility.assertionIds,
            }
          : null,
      lineage: history,
      managedBy: managedBy.state === "verified" ? managedBy.value : null,
      managedByAssertionIds: managedBy.state === "verified" ? managedBy.assertionIds : [],
      identifiers: identifiers.map(({ value, assertion }) => ({
        system: value.system,
        value: value.value,
        assertionIds: [assertion.id],
      })),
      financing:
        o.kind === "company"
          ? {
              roundsKnown: verifiedRounds.length,
              roundsWithStatedAmount: verifiedRounds.filter((r) =>
                r.disclosures.some((d) => d.amount.amount !== null),
              ).length,
              roundsWithResolvedAmount: verifiedRounds.filter(
                (r) => r.resolved.status === "resolved",
              ).length,
              totals,
              latestStage: latest?.label ?? null,
              latestRoundDate: latest?.date ?? null,
              flags,
            }
          : null,
      research,
      weight: Math.min(3, 0.8 + Math.log2(1 + (relationshipCount.get(o.id) ?? 0)) * 0.45),
    };
  };

  const organizations: OrgView[] = [
    ...universe.map((o) => orgView(o, "universe")),
    ...[...contextual]
      .map((id) => orgs.get(id))
      .filter((o): o is Organization => !!o && !universeIds.has(o.id))
      .map((o) => orgView(o, "contextual")),
  ];

  // ---- Layout and graph edges -----------------------------------------------------------------
  const sectors = corpus.taxonomy
    .filter((t) => t.parentId === null)
    .map((s) => ({
      id: s.id,
      label: s.label,
      subsectorIds: corpus.taxonomy.filter((t) => t.parentId === s.id).map((t) => t.id),
    }));
  const viewById = new Map(organizations.map((v) => [v.id, v]));
  const companySegments = universe.flatMap((o) => {
    const seg = viewById.get(o.id)?.segment.value;
    if (!seg) {
      warnings.push(`${o.id}: classification refers to an unknown taxonomy node; not placed`);
      return [];
    }
    return [{ id: o.id, sectorId: seg.sectorId, subsectorId: seg.id }];
  });
  const sectorOf = new Map(companySegments.map((c) => [c.id, c.sectorId]));
  const uni = layoutUniverse({
    sectors,
    subsectorLabels: Object.fromEntries(
      corpus.taxonomy.filter((t) => t.parentId !== null).map((t) => [t.id, t.label]),
    ),
    companies: companySegments,
    previous: options.previousPositions,
  });

  // A record is "primary" if at least one official or first-party source supports it; an edge is
  // dashed only when some underlying record rests on independent reporting alone.
  const evidenceStyle = (sourceIds: string[]): "solid" | "dashed" =>
    sourceIds.some((s) => ["T1", "T2"].includes(sources.get(s)?.tier ?? "")) ? "solid" : "dashed";
  const lineageEdges: GraphEdgeView[] = lineage.map((a) => {
    const v = a.value as PredecessorValue;
    const style = evidenceStyle(a.evidence.map((e) => e.sourceId));
    return {
      id: `lineage:${a.id}`,
      source: a.subjectId,
      target: v.orgId,
      kind: "lineage",
      recordIds: [a.id],
      style,
      weight: 1,
      valueCad: null,
      timeline: [
        {
          recordId: a.id,
          companyId: universeIds.has(a.subjectId) ? a.subjectId : v.orgId,
          start: v.date,
          end: null,
          kind: "event",
          style,
          valueCad: null,
        },
      ],
    };
  });

  const capitalPairs = new Map<string, GraphEdgeView>();
  for (const r of rounds) {
    if (r.verification !== "verified") continue;
    for (const p of r.participants) {
      const key = `${p.investorId}|${r.companyId}`;
      const e = capitalPairs.get(key) ?? {
        id: `cap:${key}`,
        source: p.investorId,
        target: r.companyId,
        kind: "capital" as const,
        recordIds: [],
        style: "solid" as const,
        weight: 0,
        valueCad: null,
        timeline: [],
      };
      const style = evidenceStyle(r.sourceIds);
      e.recordIds.push(r.id);
      e.weight++;
      e.timeline!.push(roundEntry(r, p.investorId, style));
      if (style === "dashed") e.style = "dashed";
      capitalPairs.set(key, e);
    }
  }
  const bundlePairs = new Map<string, GraphEdgeView>();
  for (const e of capitalPairs.values()) {
    const sector = sectorOf.get(e.target);
    if (!sector) continue;
    const key = `${e.source}|${sector}`;
    const b = bundlePairs.get(key) ?? {
      id: `bun:${key}`,
      source: e.source,
      target: `anchor:${sector}`,
      kind: "bundle" as const,
      family: "capital" as const,
      recordIds: [],
      style: "solid" as const,
      weight: 0,
      valueCad: null,
      memberEdgeIds: [],
    };
    b.recordIds.push(...e.recordIds);
    b.memberEdgeIds!.push(e.id);
    b.weight++;
    bundlePairs.set(key, b);
  }
  const agreementPairs = new Map<string, GraphEdgeView>();
  for (const g of agreements) {
    // Partnerships (M1-B) and other transfer payments: dossier and institution panel only. The
    // network draws procurement and grants; an other-transfer line would read as one of them.
    if (!g.counterpartyId || g.family === "partnership" || g.family === "other_transfer") continue;
    for (const a of g.attributions) {
      const kind = g.family === "procurement" ? "procurement" : "grant";
      const key = `${kind}|${g.counterpartyId}|${a.orgId}`;
      const e = agreementPairs.get(key) ?? {
        id: `agr:${key}`,
        source: g.counterpartyId,
        target: a.orgId,
        kind,
        recordIds: [],
        style: "solid" as const,
        weight: 0,
        valueCad: kind === "procurement" ? 0 : null,
        timeline: [],
      };
      const style = evidenceStyle(g.sourceIds);
      e.recordIds.push(g.id);
      e.weight++;
      e.timeline!.push(agreementEntry(g, a.orgId, style));
      if (style === "dashed") e.style = "dashed";
      if (kind === "procurement") e.valueCad = Math.max(e.valueCad ?? 0, g.thresholdValueCad ?? 0);
      agreementPairs.set(key, e);
    }
  }

  // Government-lens bundles: counterparty → sector, split by family so a grant never reads as a
  // paying-customer relationship (P-16). Drawn at overview/region zoom in place of single edges.
  const contractBundles = new Map<string, GraphEdgeView>();
  for (const e of agreementPairs.values()) {
    const sector = sectorOf.get(e.target);
    if (!sector) continue;
    const family = e.kind === "procurement" ? "procurement" : "grant";
    const key = `${family}|${e.source}|${sector}`;
    const b = contractBundles.get(key) ?? {
      id: `bun:${key}`,
      source: e.source,
      target: `anchor:${sector}`,
      kind: "bundle" as const,
      family,
      recordIds: [],
      style: "solid" as const,
      weight: 0,
      valueCad: family === "procurement" ? 0 : null,
      memberEdgeIds: [],
    };
    for (const r of e.recordIds) if (!b.recordIds.includes(r)) b.recordIds.push(r);
    b.memberEdgeIds!.push(e.id);
    b.weight++;
    if (family === "procurement") b.valueCad = Math.max(b.valueCad ?? 0, e.valueCad ?? 0);
    contractBundles.set(key, b);
  }

  const relatedSectors = (edges: Iterable<GraphEdgeView>) => {
    const m = new Map<string, Map<string, number>>();
    for (const e of edges) {
      const sector = sectorOf.get(e.target);
      if (!sector) continue;
      const inner = m.get(e.source) ?? new Map<string, number>();
      inner.set(sector, (inner.get(sector) ?? 0) + 1);
      m.set(e.source, inner);
    }
    return m;
  };
  const capitalInst = layoutInstitutions(relatedSectors(capitalPairs.values()), uni.sectorCenters);
  const contractInst = layoutInstitutions(
    relatedSectors(agreementPairs.values()),
    uni.sectorCenters,
  );
  const positions: Record<string, Vec3> = { ...uni.companies };
  const lineageSectors = new Map<string, Map<string, number>>();
  for (const e of lineageEdges) {
    const sector = sectorOf.get(e.source) ?? sectorOf.get(e.target);
    if (!sector) continue;
    for (const id of [e.source, e.target])
      if (!universeIds.has(id)) lineageSectors.set(id, new Map([[sector, 1]]));
  }
  const lineageInst = layoutInstitutions(lineageSectors, uni.sectorCenters);
  for (const [id, p] of Object.entries(lineageInst)) positions[`industry:${id}`] = p;
  // Institutions may appear in both lenses at different positions; key by lens.
  for (const [id, p] of Object.entries(capitalInst)) positions[`capital:${id}`] = p;
  for (const [id, p] of Object.entries(contractInst)) positions[`contracts:${id}`] = p;

  const allEdges = [
    ...capitalPairs.values(),
    ...bundlePairs.values(),
    ...agreementPairs.values(),
    ...contractBundles.values(),
    ...lineageEdges,
  ];
  const unbacked = allEdges.filter((e) => e.recordIds.length === 0);
  if (unbacked.length)
    failures.push({
      gate: "edges-backed",
      message: "Edges without a backing record",
      ids: unbacked.map((e) => e.id),
    });

  // ---- Coverage -------------------------------------------------------------------------------
  const companiesAll = corpus.organizations.filter((o) => o.kind === "company" && !o.mergedInto);
  const decisionOf = (id: string) => {
    const f = facts.fact<{ decision: string }>(id, "eligibility");
    return f.state === "verified" ? f.value?.decision : undefined;
  };
  const researchedByTopic: CoverageView["researchedByTopic"] = {};
  for (const topic of ["identity", "financing", "agreements", "eligibility"] as const) {
    const researched = universe.filter(
      (o) => facts.researchState(o.id, topic).state !== "not_researched",
    ).length;
    researchedByTopic[topic] = { researched, notResearched: universe.length - researched };
  }
  const coverage: CoverageView = {
    isPilotSample: true,
    companiesDiscovered: companiesAll.length,
    eligibilityDecided: companiesAll.filter((o) =>
      ["included", "excluded"].includes(decisionOf(o.id) ?? ""),
    ).length,
    notInUniverse: {
      excluded: pendingCompanies.filter((o) => decisionOf(o.id) === "excluded").length,
      undecided: pendingCompanies.filter(
        (o) => !["included", "excluded"].includes(decisionOf(o.id) ?? ""),
      ).length,
      // Included in principle, but HQ or classification evidence is not yet verified.
      awaitingEvidence: pendingCompanies.filter((o) => decisionOf(o.id) === "included").length,
    },
    inUniverse: universe.length,
    researchedByTopic,
    quality: Object.fromEntries(
      [...new Set(quality.map((q) => q.check))].map((check) => [
        check,
        quality.filter((q) => q.check === check).reduce((n, q) => n + q.ids.length, 0),
      ]),
    ),
    financing: {
      roundsKnown: rounds.filter((r) => r.verification === "verified").length,
      roundsWithResolvedAmount: rounds.filter((r) => r.resolved.status === "resolved").length,
    },
    agreements: {
      procurement: agreements.filter((g) => g.family === "procurement").length,
      grants: agreements.filter((g) => g.family === "grant_contribution").length,
      partnerships: agreements.filter((g) => g.family === "partnership").length,
      otherTransfers: agreements.filter((g) => g.family === "other_transfer").length,
    },
  };
  if (pendingCompanies.length)
    warnings.push(
      `${pendingCompanies.length} companies not in the universe (eligibility or HQ evidence pending)`,
    );

  // ---- Sources actually cited by published content --------------------------------------------
  const cited = new Set<string>([
    ...Object.values(assertionsOut).flatMap((a) => a.evidence.map((e) => e.sourceId)),
    ...rounds.flatMap((r) => r.sourceIds),
    ...agreements.flatMap((g) => [
      ...g.sourceIds,
      ...g.valueStatements.flatMap((v) => v.sourceIds),
    ]),
    ...acquisitions.flatMap((q) => q.sourceIds),
  ]);
  const sourcesOut: Snapshot["sources"] = {};
  for (const id of cited) {
    const s = sources.get(id);
    if (s)
      sourcesOut[id] = {
        id,
        publisher: s.publisher,
        title: s.title,
        url: s.url,
        tier: s.tier,
        kind: s.kind,
        publishedOn: s.publishedOn,
        retrievedAt: s.retrievedAt,
      };
  }

  // ---- Claim-level citation gate (P-36): every published claim needs a usable citation --------
  const citationProblems = auditCitations({
    assertions: assertionsOut,
    rounds,
    agreements,
    acquisitions,
    sources: sourcesOut,
  });
  if (citationProblems.length)
    failures.push({
      gate: "citation-coverage",
      message: "Published claims lack usable citations (docs/CITATIONS.md)",
      ids: citationProblems.map((p) => `${p.claim}: ${p.problem}`),
    });

  // Old addresses of merged organizations redirect to the surviving one (DATA_SCHEMA §5).
  const redirects = Object.fromEntries(
    corpus.organizations
      .filter((o) => o.mergedInto && orgs.get(o.mergedInto) && !orgs.get(o.mergedInto)!.mergedInto)
      .map((o) => [o.slug, orgs.get(o.mergedInto!)!.slug]),
  );

  const body = {
    taxonomy: corpus.taxonomy,
    organizations,
    ...(Object.keys(redirects).length ? { redirects } : {}),
    rounds,
    agreements,
    acquisitions,
    assertions: assertionsOut,
    sources: sourcesOut,
    graph: {
      positions,
      anchors: uni.anchors,
      subAnchors: uni.subAnchors,
      lenses: {
        capital: {
          institutionIds: Object.keys(capitalInst),
          edges: [...capitalPairs.values()],
          bundles: [...bundlePairs.values()],
        },
        contracts: {
          institutionIds: Object.keys(contractInst),
          edges: [...agreementPairs.values()],
          bundles: [...contractBundles.values()],
        },
        industry: { institutionIds: Object.keys(lineageInst), edges: lineageEdges },
      },
      layout: {
        method: "taxonomy-shells + institution-shell",
        version: LAYOUT_VERSION,
        distanceMeaning: DISTANCE_MEANING,
      },
    },
    coverage,
  };
  // ---- How each published record was verified (VERIFICATION_TIERS.md section 9) -------------
  const verification: Record<string, VerificationView> = {};
  type VerificationInput = {
    review: Corpus["assertions"][number]["review"];
    evidence: { sourceId: string; locator: string }[];
    kind: string;
  };
  const evidenceOf = new Map<string, VerificationInput>([
    ...corpus.assertions.map(
      (a) =>
        [a.id, { review: a.review, evidence: a.evidence, kind: "assertion" }] as [
          string,
          VerificationInput,
        ],
    ),
    ...corpus.rounds.map(
      (r) =>
        [
          r.id,
          {
            review: r.review,
            evidence: [...r.evidence, ...r.disclosures.flatMap((d) => d.evidence)],
            kind: "round",
          },
        ] as [string, VerificationInput],
    ),
    ...corpus.agreements.map(
      (g) =>
        [
          g.id,
          {
            review: g.review,
            evidence: g.evidence,
            kind: g.id.startsWith("agr_tbs_c_")
              ? "contracts"
              : g.id.startsWith("agr_tbs_g_")
                ? "grants"
                : "agreement",
          },
        ] as [string, VerificationInput],
    ),
    ...corpus.acquisitions.map(
      (q) =>
        [q.id, { review: q.review, evidence: q.evidence, kind: "acquisition" }] as [
          string,
          VerificationInput,
        ],
    ),
  ]);
  const publishedIds = [
    ...Object.keys(assertionsOut),
    ...rounds.filter((r) => r.verification === "verified").map((r) => r.id),
    ...agreements.filter((g) => g.verification === "verified").map((g) => g.id),
    ...acquisitions.map((q) => q.id),
  ];
  for (const id of publishedIds) {
    const draft = options.draftLabels?.[id];
    if (draft) {
      verification[id] = { kind: "draft", at: null, label: draft };
      continue;
    }
    const rec = evidenceOf.get(id);
    if (!rec?.review) continue;
    verification[id] = verificationView(rec.review, rec.evidence, rec.kind, sources);
  }

  // The hash covers the verification labels and the edition too, so a label-only change gets a new
  // snapshot file name (no stale cached copy).
  const contentHash = sha256(
    canonicalJson({ body, verification, audience, withheldByOrg, preview: !!options.draftLabels }),
  ).slice(0, 16);
  const snapshot: Snapshot = {
    meta: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      snapshotVersion: contentHash,
      builtAt: new Date().toISOString(),
      isDemo: corpus.isDemo,
      contentHash,
      thresholdCad: threshold,
      ...(audience === "share" ? { audience } : {}),
      ...(options.draftLabels ? { preview: true } : {}),
    },
    ...body,
    ...(Object.keys(verification).length ? { verification } : {}),
    ...(audience === "share" ? { withheldByOrg } : {}),
  };
  return {
    ok: failures.length === 0,
    failures,
    warnings,
    quality,
    snapshot: failures.length === 0 ? snapshot : null,
  };
}
