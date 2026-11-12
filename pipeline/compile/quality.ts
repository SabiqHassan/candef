/**
 * Entity-resolution gate and data-quality checks (M3-C3, C4).
 *
 * Gate (fails the build): two live organizations that are evidently the same entity: a shared
 * registry identifier, or the same normalized name and kind. Resolve with `mergedInto` (same
 * entity) or `distinctFrom` (a recorded human decision that they differ).
 *
 * Checks (reported, never auto-fixed): patterns that usually mean double counting, misread values,
 * unsupported relationships or stale research. Each needs a human look; none changes the data.
 */
import type { Corpus, Organization, PredecessorValue } from "../../src/domain/schema/corpus";
import { isConsortiumName, nameKey } from "../research/names";

export interface GateFailure {
  gate: string;
  message: string;
  ids: string[];
}

export type QualityCheck =
  | "possible-duplicate-round"
  | "row-arithmetic"
  | "cross-dataset-duplicate"
  | "no-party-of-record-counterparty"
  | "stale-research"
  | "consortium-attribution";

export interface QualityIssue {
  check: QualityCheck;
  message: string;
  ids: string[];
}

const INACTIVE = new Set(["superseded", "retracted", "rejected"]);
const live = (a: { verification: string }) => !INACTIVE.has(a.verification);

function distinct(a: Organization, b: Organization): boolean {
  return !!(a.distinctFrom?.includes(b.id) || b.distinctFrom?.includes(a.id));
}

/** Gate: duplicate entities and broken merges. */
export function entityFailures(corpus: Corpus): GateFailure[] {
  const failures: GateFailure[] = [];
  const byId = new Map(corpus.organizations.map((o) => [o.id, o]));
  const badLineage = corpus.assertions.filter((a) => {
    if (!live(a) || a.predicate !== "predecessor_of") return false;
    const v = a.value as PredecessorValue;
    return (
      a.subjectId === v.orgId ||
      byId.get(a.subjectId)?.kind !== "company" ||
      byId.get(v.orgId)?.kind !== "company" ||
      !!byId.get(v.orgId)?.mergedInto
    );
  });
  if (badLineage.length)
    failures.push({
      gate: "lineage-endpoints",
      message: "Predecessor events require distinct existing company entities, not merged aliases",
      ids: badLineage.map((a) => a.id),
    });
  // Succession relates distinct legal entities: a cycle would make each entity its own ancestor.
  const lineage = corpus.assertions.filter((a) => live(a) && a.predicate === "predecessor_of");
  const outgoing = new Map<string, string[]>(),
    indegree = new Map<string, number>();
  for (const a of lineage) {
    const target = (a.value as PredecessorValue).orgId;
    outgoing.set(a.subjectId, [...(outgoing.get(a.subjectId) ?? []), target]);
    indegree.set(a.subjectId, indegree.get(a.subjectId) ?? 0);
    indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++)
    for (const target of outgoing.get(queue[i]!) ?? []) {
      const degree = indegree.get(target)! - 1;
      indegree.set(target, degree);
      if (degree === 0) queue.push(target);
    }
  if (queue.length < indegree.size)
    failures.push({
      gate: "lineage-cycle",
      message: "Corporate predecessor history must be acyclic",
      ids: lineage
        .filter(
          (a) =>
            (indegree.get((a.value as PredecessorValue).orgId) ?? 0) > 0 &&
            (indegree.get(a.subjectId) ?? 0) > 0,
        )
        .map((a) => a.id),
    });

  const badMerge = corpus.organizations.filter((o) => {
    if (!o.mergedInto) return false;
    const target = byId.get(o.mergedInto);
    return !target || target.id === o.id || !!target.mergedInto;
  });
  if (badMerge.length)
    failures.push({
      gate: "merge-target",
      message: "mergedInto must point to an existing organization that is not itself merged",
      ids: badMerge.map((o) => `${o.id}->${o.mergedInto}`),
    });

  // A merged organization is an alias. Records must be moved to the surviving organization
  // explicitly (approvals are hash-bound, so a merge never silently re-attributes reviewed facts).
  const merged = new Set(corpus.organizations.filter((o) => o.mergedInto).map((o) => o.id));
  if (merged.size) {
    const refs: string[] = [];
    for (const a of corpus.assertions)
      if (merged.has(a.subjectId)) refs.push(`${a.id}->${a.subjectId}`);
    for (const r of corpus.rounds) {
      if (merged.has(r.companyId)) refs.push(`${r.id}->${r.companyId}`);
      for (const p of r.participations)
        for (const id of [p.investorId, p.vehicleId])
          if (id && merged.has(id)) refs.push(`${r.id}->${id}`);
    }
    for (const g of corpus.agreements)
      for (const id of [...g.parties.map((p) => p.orgId), ...g.allocations.map((x) => x.orgId)])
        if (merged.has(id)) refs.push(`${g.id}->${id}`);
    for (const q of corpus.acquisitions)
      for (const id of [q.targetId, q.acquirerId]) if (merged.has(id)) refs.push(`${q.id}->${id}`);
    for (const r of corpus.research)
      if (merged.has(r.subjectId)) refs.push(`${r.id}->${r.subjectId}`);
    if (refs.length)
      failures.push({
        gate: "merged-reference",
        message:
          "Records still point at a merged organization; move them to the surviving one (and re-review)",
        ids: refs,
      });
  }

  const active = corpus.organizations.filter((o) => !o.mergedInto);
  const pairs = new Set<string>();
  const flag = (keyOf: (o: Organization) => string[], label: string) => {
    const seen = new Map<string, Organization>();
    for (const o of active)
      for (const key of keyOf(o)) {
        if (!key) continue;
        const prev = seen.get(key);
        if (prev && prev.id !== o.id && !distinct(prev, o)) {
          const pair = [prev.id, o.id].sort().join(" = ");
          if (!pairs.has(pair)) {
            pairs.add(pair);
            failures.push({
              gate: "duplicate-entities",
              message: `Possible duplicate organizations (${label}); merge with mergedInto or record distinctFrom`,
              ids: [prev.id, o.id],
            });
          }
        } else if (!prev) seen.set(key, o);
      }
  };

  const legalNames = new Map<string, string[]>();
  const registry = new Map<string, string[]>();
  for (const a of corpus.assertions) {
    if (!live(a)) continue;
    if (a.predicate === "legal_name" && typeof a.value === "string")
      legalNames.set(a.subjectId, [...(legalNames.get(a.subjectId) ?? []), a.value]);
    if (a.predicate === "registry_id") {
      const v = a.value as { system?: string; value?: string } | null;
      if (v?.system && v.value)
        registry.set(a.subjectId, [
          ...(registry.get(a.subjectId) ?? []),
          `${v.system}:${v.value.replace(/\s+/g, "")}`,
        ]);
    }
  }
  // A classification must name an existing taxonomy node; a typo would silently show "Unclassified".
  const taxonomy = new Set(corpus.taxonomy.map((t) => t.id));
  const badClass = corpus.assertions.filter(
    (a) => live(a) && a.predicate === "classified_as" && !taxonomy.has(String(a.value)),
  );
  if (badClass.length)
    failures.push({
      gate: "dangling-taxonomy",
      message:
        "classified_as names a taxonomy ID that does not exist (typo, or taxonomy.yaml missing)",
      ids: badClass.map((a) => `${a.id}->${String(a.value)}`),
    });

  // D-16: every inclusion needs a written dual-use rationale.
  const noRationale = corpus.assertions.filter((a) => {
    if (!live(a) || a.predicate !== "eligibility") return false;
    const v = a.value as { decision?: string; rationale?: string } | null;
    return v?.decision === "included" && (v.rationale ?? "").trim().length < 20;
  });
  if (noRationale.length)
    failures.push({
      gate: "eligibility-rationale",
      message: "An included company needs a written dual-use rationale citing evidence (D-16)",
      ids: noRationale.map((a) => a.id),
    });

  // D-17: no contact details anywhere (business addresses such as city or postal code are fine).
  const contact = corpus.assertions.filter((a) => live(a) && hasContactData(a.value));
  if (contact.length)
    failures.push({
      gate: "no-contact-data",
      message: "Contact details (email, phone, fax) are never stored (D-17)",
      ids: contact.map((a) => a.id),
    });

  flag((o) => registry.get(o.id) ?? [], "same registry identifier");
  flag(
    (o) => [
      ...new Set([o.name, ...(legalNames.get(o.id) ?? [])].map((n) => `${o.kind}|${nameKey(n)}`)),
    ],
    "same normalized name and kind",
  );
  return failures;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
/** True when a value carries personal contact data: an email/phone/fax key, or an email address. */
function hasContactData(value: unknown): boolean {
  if (typeof value === "string") return EMAIL.test(value);
  if (Array.isArray(value)) return value.some(hasContactData);
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([k, v]) => /e-?mail|phone|telephone|fax|mobile/i.test(k) || hasContactData(v),
    );
  return false;
}

const monthIndex = (d: string | null | undefined): number | null => {
  if (!d) return null;
  const [y, m] = d.split("-");
  return Number(y) * 12 + (m ? Number(m) - 1 : 6);
};

/** Data-quality checks; each issue lists the records a reviewer should open. */
export function qualityIssues(corpus: Corpus, today: string): QualityIssue[] {
  const issues: QualityIssue[] = [];

  // 1. Two live rounds of the same company and stage close in time, or citing the same source.
  // Pairs are compared within one company only (comparing every pair in the corpus was quadratic in
  // the whole corpus: bench/stress, 2026-10-14). The issue order is unchanged: i, then later j.
  const rounds = corpus.rounds.filter(live);
  const laterOfCompany = new Map<string, number[]>();
  rounds.forEach((r, i) => {
    const list = laterOfCompany.get(r.companyId);
    if (list) list.push(i);
    else laterOfCompany.set(r.companyId, [i]);
  });
  for (let i = 0; i < rounds.length; i++)
    for (const j of laterOfCompany.get(rounds[i]!.companyId)!) {
      if (j <= i) continue;
      const a = rounds[i]!;
      const b = rounds[j]!;
      const sameStage = a.stage !== null && a.stage === b.stage;
      const sameLabel =
        !!a.roundLabelAsStated &&
        a.roundLabelAsStated.toLowerCase() === b.roundLabelAsStated?.toLowerCase();
      if (!sameStage && !sameLabel) continue;
      const da = monthIndex(a.disclosures.map((d) => d.date).sort()[0]);
      const db = monthIndex(b.disclosures.map((d) => d.date).sort()[0]);
      const close = da !== null && db !== null && Math.abs(da - db) <= 6;
      const srcA = new Set(
        [...a.evidence, ...a.disclosures.flatMap((d) => d.evidence)].map((e) => e.sourceId),
      );
      const shared = [...b.evidence, ...b.disclosures.flatMap((d) => d.evidence)].some((e) =>
        srcA.has(e.sourceId),
      );
      if (close || shared)
        issues.push({
          check: "possible-duplicate-round",
          message: `Same company and ${sameStage ? "stage" : "label"}, ${close ? "within 6 months" : "citing the same source"}: one round recorded twice? Successive closes belong in one round's disclosures.`,
          ids: [a.id, b.id],
        });
    }

  const agreements = corpus.agreements.filter(live);
  for (const g of agreements) {
    // 2. Cumulative disclosure rows must add up: total = previous total + amendment delta.
    const bad: string[] = [];
    g.disclosureRows.forEach((row, k) => {
      if (row.totalValue === null) {
        bad.push(`${row.reportingPeriod}: total not stated`);
        return;
      }
      const total = Number(row.totalValue);
      if (total < 0) bad.push(`${row.reportingPeriod}: negative total`);
      const previous = g.disclosureRows[k - 1]?.totalValue ?? null;
      if (
        k === 0 ||
        row.instrument !== "amendment" ||
        row.amendmentValue === null ||
        previous === null
      )
        return;
      const expected = Number(previous) + Number(row.amendmentValue);
      // Values are rounded to cents independently, so allow one cent of difference.
      if (Math.abs(Math.round(expected * 100) - Math.round(total * 100)) > 1)
        bad.push(
          `${row.reportingPeriod}: total ${row.totalValue} ≠ previous + amendment (${expected.toFixed(2)})`,
        );
    });
    if (bad.length)
      issues.push({
        check: "row-arithmetic",
        message: `Disclosure rows do not add up (missing row, or a delta read as a total?): ${bad.join("; ")}`,
        ids: [g.id],
      });

    // 4. The counterparty must be a party of record; a name in a description is not a relationship.
    const counter = g.parties.filter((p) => p.role === "buyer" || p.role === "funder");
    if (counter.length && counter.every((p) => p.evidenceStrength !== "party_of_record"))
      issues.push({
        check: "no-party-of-record-counterparty",
        message: "Buyer or funder is only named in a description; no relationship edge is drawn",
        ids: [g.id],
      });

    // 6. A consortium string attributed to a single company without a disclosed allocation.
    for (const p of g.parties)
      if (
        (p.role === "prime" || p.role === "recipient") &&
        isConsortiumName(p.reportedName) &&
        !g.allocations.some((a) => a.orgId === p.orgId)
      )
        issues.push({
          check: "consortium-attribution",
          message: `"${p.reportedName}" names a group; attribute it as a consortium, not to one member`,
          ids: [g.id, p.orgId],
        });
  }

  // 3. The same contract identifier on two agreements (e.g. the TBS and CanadaBuys datasets).
  const byExternal = new Map<string, Set<string>>();
  // A program name (e.g. "tbs-grants:program") is shared by many agreements by design; it never
  // identifies one agreement, so it is not evidence of a duplicate.
  const identifiesOne = (system: string) => !/(^|:)program$/i.test(system);
  for (const g of agreements)
    for (const x of g.externalIds.filter((x) => identifiesOne(x.system))) {
      const contractLike = /procurement|contract|solicitation/i.test(x.system);
      const key = contractLike
        ? `contract:${x.value.trim().toUpperCase()}`
        : `${x.system}:${x.value}`;
      byExternal.set(key, new Set([...(byExternal.get(key) ?? []), g.id]));
    }
  for (const [key, ids] of byExternal)
    if (ids.size > 1)
      issues.push({
        check: "cross-dataset-duplicate",
        message: `Identifier ${key} appears on ${ids.size} agreements: one agreement reported twice (in one dataset or across two) must not be counted twice`,
        ids: [...ids],
      });

  // 5. Research whose review date has passed (content freshness, not link health).
  const latest = new Map<string, { at: string; next: string | null }>();
  for (const r of corpus.research) {
    const key = `${r.subjectId}:${r.topic}`;
    const prev = latest.get(key);
    if (!prev || r.at > prev.at) latest.set(key, { at: r.at, next: r.nextReview });
  }
  const stale = [...latest].filter(([, v]) => v.next !== null && v.next < today).map(([k]) => k);
  if (stale.length)
    issues.push({
      check: "stale-research",
      message: `${stale.length} research topic(s) are past their review date`,
      ids: stale,
    });

  return issues;
}
