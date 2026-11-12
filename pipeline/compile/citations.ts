/**
 * Claim-level citations (P-36, docs/CITATIONS.md).
 *
 * `toCitations` turns a record's evidence into snapshot citations (source + exact locator + how the
 * locator was obtained). `auditCitations` is the compile-time gate: it walks every published claim
 * container in a built snapshot and reports any that lacks a usable citation.
 *
 * The gate checks what a machine can check: a claim has at least one citation, each citation points
 * at a registered source with a URL, title and publisher, the locator is specific (not blank or
 * generic), and a locator that is only a related link never stands alone. It cannot check that the
 * source's text really supports the claim; that is the owner's review, helped by the exact locator.
 */
import type { Evidence } from "../../src/domain/schema/corpus";
import type { Citation, Snapshot } from "../../src/domain/schema/snapshot";

export function toCitations(evidence: Evidence[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const e of evidence) {
    const key = `${e.sourceId}\u0000${e.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceId: e.sourceId, locator: e.locator, quality: e.locatorQuality });
  }
  return out;
}

/** Locators that name nothing. A locator must say where in the source the claim is. */
const GENERIC_LOCATOR =
  /^(n\/?a|none|unknown|tbd|todo|page|the page|website|web ?site|site|source|link|url|document|record|text|body|-+|\.+)$/i;

export function isSpecificLocator(locator: string): boolean {
  const t = locator.trim();
  return t.length >= 2 && !GENERIC_LOCATOR.test(t);
}

export interface CitationFailure {
  claim: string;
  problem: string;
}

/** Every published claim container must carry usable citations. Returns one failure per problem. */
export function auditCitations(
  snap: Pick<Snapshot, "assertions" | "rounds" | "agreements" | "acquisitions" | "sources">,
): CitationFailure[] {
  const failures: CitationFailure[] = [];
  const check = (claim: string, citations: Citation[], opts: { required?: boolean } = {}) => {
    if (citations.length === 0) {
      if (opts.required !== false) failures.push({ claim, problem: "no citation" });
      return;
    }
    for (const c of citations) {
      const s = snap.sources[c.sourceId];
      if (!s) failures.push({ claim, problem: `cites unknown source ${c.sourceId}` });
      else {
        if (!s.url.trim()) failures.push({ claim, problem: `source ${c.sourceId} has no URL` });
        if (!s.title.trim() || !s.publisher.trim())
          failures.push({ claim, problem: `source ${c.sourceId} lacks a title or publisher` });
      }
      if (!isSpecificLocator(c.locator))
        failures.push({
          claim,
          problem: `locator "${c.locator}" does not say where in ${c.sourceId} the claim is`,
        });
    }
    if (citations.every((c) => c.quality === "related_link"))
      failures.push({ claim, problem: "only related-link evidence (never sufficient alone)" });
  };

  for (const a of Object.values(snap.assertions)) {
    // Superseded values are history, shown with their own evidence; they still need citations.
    check(`assertion ${a.id} (${a.label})`, a.evidence);
  }
  for (const r of snap.rounds) {
    if (r.verification !== "verified") continue;
    check(`round ${r.id}`, r.citations);
    for (const d of r.disclosures) check(`round ${r.id} disclosure ${d.id}`, d.citations);
    for (const p of r.participants)
      check(`round ${r.id} participant ${p.reportedName}`, p.citations);
  }
  for (const g of snap.agreements) {
    check(`agreement ${g.id}`, g.citations);
    for (const v of g.valueStatements) check(`agreement ${g.id} value statement`, v.citations);
    g.rows.forEach((row) => {
      if (row.citation) check(`agreement ${g.id} row ${row.reportingPeriod}`, [row.citation]);
    });
  }
  for (const q of snap.acquisitions) check(`acquisition ${q.id}`, q.citations);
  return failures;
}
