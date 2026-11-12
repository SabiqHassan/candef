/**
 * The claims shown for a company, each with its citations (P-36, docs/CITATIONS.md).
 *
 * A pure view over the snapshot: it invents nothing. It is used where a dense view (a list row, the
 * dossier's source table) needs one place that answers "what is claimed here and what supports it".
 */
import type { SnapshotIndex } from "./index";
import { formatMoney, formatPartialDate, formatTotals } from "./format";
import type { Citation, OrgView } from "./schema/snapshot";

/** How a claim relates to its evidence (see docs/CITATIONS.md). */
export type ClaimBasis = "sourced" | "interpretation" | "derived";

export interface ClaimRef {
  id: string;
  group: "Identity" | "Ownership" | "Financing" | "Government";
  label: string;
  value: string;
  basis: ClaimBasis;
  citations: Citation[];
  /** The records behind the claim (for their verification basis); empty for derived claims. */
  recordIds: string[];
}

export function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter((c) => {
    const k = `${c.sourceId}\u0000${c.locator}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Citations behind a set of assertions, and whether any of them is an analyst interpretation. */
export function assertionCitations(
  ix: SnapshotIndex,
  assertionIds: string[],
): { citations: Citation[]; basis: ClaimBasis } {
  const list = assertionIds.map((id) => ix.snap.assertions[id]).filter(Boolean);
  return {
    citations: dedupe(list.flatMap((a) => a!.evidence)),
    basis: list.some((a) => a!.epistemic === "analyst_interpretation")
      ? "interpretation"
      : "sourced",
  };
}

export function companyClaims(ix: SnapshotIndex, org: OrgView): ClaimRef[] {
  const claims: ClaimRef[] = [];
  const fact = (
    id: string,
    group: ClaimRef["group"],
    label: string,
    value: string | null,
    assertionIds: string[],
  ) => {
    if (value === null) return;
    const { citations, basis } = assertionCitations(ix, assertionIds);
    if (citations.length)
      claims.push({ id, group, label, value, basis, citations, recordIds: assertionIds });
  };
  fact("legalName", "Identity", "Legal name", org.legalName.value, org.legalName.assertionIds);
  const hq = org.hq.value;
  fact(
    "hq",
    "Identity",
    "Headquarters",
    hq ? [hq.city, hq.province, hq.country].filter(Boolean).join(", ") : null,
    org.hq.assertionIds,
  );
  fact(
    "founded",
    "Identity",
    "Founded",
    org.founded.value === null ? null : String(org.founded.value),
    org.founded.assertionIds,
  );
  const seg = org.segment.value;
  fact(
    "segment",
    "Identity",
    "Classification",
    seg ? `${seg.sectorLabel}: ${seg.label}` : null,
    org.segment.assertionIds,
  );
  fact(
    "listing",
    "Identity",
    "Listing",
    org.listing.value ? `${org.listing.value.exchange}: ${org.listing.value.ticker}` : null,
    org.listing.assertionIds,
  );
  if (org.eligibility)
    fact(
      "eligibility",
      "Identity",
      "Eligibility",
      org.eligibility.decision === "included" ? "Included" : org.eligibility.decision,
      org.eligibility.assertionIds,
    );
  if (org.ownership.parentId)
    fact(
      "ownership",
      "Ownership",
      "Parent company",
      ix.org.get(org.ownership.parentId)?.name ?? "Parent organization",
      org.ownership.assertionIds,
    );

  const rounds = (ix.roundsByCompany.get(org.id) ?? []).filter(
    (r) => r.verification === "verified",
  );
  for (const event of org.lineage ?? [])
    fact(
      `lineage:${event.assertionIds.join(":")}`,
      "Ownership",
      event.direction === "predecessor_of" ? "Predecessor of" : "Successor of",
      `${ix.org.get(event.orgId)?.name ?? "Company"} (${event.event.replaceAll("_", " ")}, ${formatPartialDate(event.date)})`,
      event.assertionIds,
    );
  for (const r of rounds) {
    const when = formatPartialDate(r.date);
    const label = `${r.label ?? "Round"}, ${when}`;
    if (r.citations.length)
      claims.push({
        id: `${r.id}:round`,
        group: "Financing",
        label,
        value: r.resolved.money ? formatMoney(r.resolved.money) : "Amount not stated",
        basis: r.epistemic === "analyst_interpretation" ? "interpretation" : "sourced",
        citations: dedupe([...r.citations, ...r.disclosures.flatMap((d) => d.citations)]),
        recordIds: [r.id],
      });
    const investors = r.participants.flatMap((p) => p.citations);
    if (investors.length)
      claims.push({
        id: `${r.id}:investors`,
        group: "Financing",
        label: `${label}: investors`,
        value: r.participants
          .map((p) => ix.org.get(p.investorId)?.name ?? p.reportedName)
          .join(", "),
        basis: "sourced",
        citations: dedupe(investors),
        recordIds: [r.id],
      });
  }
  if (rounds.length && org.financing?.totals.length)
    claims.push({
      id: "financing-total",
      group: "Financing",
      label: "Disclosed capital (sum across rounds)",
      value: formatTotals(org.financing.totals),
      basis: "derived",
      citations: dedupe(rounds.flatMap((r) => r.citations)),
      recordIds: [],
    });

  for (const g of ix.agreementsByOrg.get(org.id) ?? []) {
    claims.push({
      id: g.id,
      group: "Government",
      label: g.title,
      value: g.currentValue ? formatMoney(g.currentValue) : "Value not stated",
      basis: g.epistemic === "analyst_interpretation" ? "interpretation" : "sourced",
      citations: g.citations,
      recordIds: [g.id],
    });
    const counterparty = g.counterpartyId ? ix.org.get(g.counterpartyId) : undefined;
    if (counterparty?.kind === "government_body" && counterparty.hq.state === "verified")
      fact(
        `${g.id}:jurisdiction`,
        "Government",
        "Government counterparty country",
        counterparty.hq.value?.country ?? null,
        counterparty.hq.assertionIds,
      );
  }
  for (const q of ix.snap.acquisitions.filter(
    (x) => x.targetId === org.id || x.acquirerId === org.id,
  ))
    claims.push({
      id: q.id,
      group: "Ownership",
      label: q.targetId === org.id ? "Acquired by" : "Acquired",
      value: `${ix.org.get(q.targetId === org.id ? q.acquirerId : q.targetId)?.name ?? "Organization"}, completed ${formatPartialDate(q.completedOn)}`,
      basis: "sourced",
      citations: q.citations,
      recordIds: [q.id],
    });
  return claims;
}

/** Citations behind the dense summaries (list rows, card metrics): the total and the latest round. */
export function financingCitations(
  ix: SnapshotIndex,
  org: OrgView,
): { total: Citation[]; latest: Citation[] } {
  const rounds = (ix.roundsByCompany.get(org.id) ?? []).filter(
    (r) => r.verification === "verified",
  );
  const dated = rounds
    .filter((r) => r.date)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const latest = dated[0] ?? rounds[0];
  return {
    total: dedupe(rounds.flatMap((r) => r.citations)),
    latest: latest ? dedupe(latest.citations) : [],
  };
}
