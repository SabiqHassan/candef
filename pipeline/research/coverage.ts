/**
 * Citation coverage of the whole research corpus (P-36, docs/CITATIONS.md).
 *
 * The compile gate checks published claims; this checks every claim in `research/`, published or
 * not, so gaps show up while records are still proposed. It applies the same rules (a registered
 * source with a URL, title and publisher; a specific locator; related-link evidence never alone)
 * and reports counts per claim kind and the best source tier behind each claim.
 */
import type { Corpus, Evidence, Source } from "../../src/domain/schema/corpus";
import { isSpecificLocator } from "../compile/citations";

export interface CoverageProblem {
  kind: string;
  claim: string;
  problem: string;
}
export interface KindCoverage {
  kind: string;
  total: number;
  /** Claims with at least one usable citation and no problem. */
  cited: number;
  /** Claims whose best source tier is T1, T2, T3 or other (T4), counted among cited claims. */
  bestTier: Record<"T1" | "T2" | "T3" | "T4", number>;
}
export interface CitationCoverage {
  kinds: KindCoverage[];
  problems: CoverageProblem[];
  total: number;
  cited: number;
}

const TIER_RANK = { T1: 0, T2: 1, T3: 2, T4: 3 } as const;

export function citationCoverage(corpus: Corpus): CitationCoverage {
  const sources = new Map<string, Source>(corpus.sources.map((s) => [s.id, s]));
  const kinds = new Map<string, KindCoverage>();
  const problems: CoverageProblem[] = [];

  const claim = (kind: string, label: string, evidence: Evidence[]) => {
    const k = kinds.get(kind) ?? {
      kind,
      total: 0,
      cited: 0,
      bestTier: { T1: 0, T2: 0, T3: 0, T4: 0 },
    };
    kinds.set(kind, k);
    k.total++;
    const own: string[] = [];
    if (evidence.length === 0) own.push("no citation");
    for (const e of evidence) {
      const s = sources.get(e.sourceId);
      if (!s) own.push(`cites unregistered source ${e.sourceId}`);
      else {
        if (!s.url.trim()) own.push(`source ${e.sourceId} has no URL`);
        if (!s.title.trim() || !s.publisher.trim())
          own.push(`source ${e.sourceId} lacks a title or publisher`);
      }
      if (!isSpecificLocator(e.locator))
        own.push(`locator "${e.locator}" in ${e.sourceId} does not say where the claim is`);
    }
    if (evidence.length > 0 && evidence.every((e) => e.locatorQuality === "related_link"))
      own.push("only related-link evidence");
    for (const p of own) problems.push({ kind, claim: label, problem: p });
    if (own.length === 0) {
      k.cited++;
      const best = evidence
        .map((e) => sources.get(e.sourceId)!.tier)
        .sort(
          (a, b) => TIER_RANK[a as keyof typeof TIER_RANK] - TIER_RANK[b as keyof typeof TIER_RANK],
        )[0] as keyof typeof TIER_RANK;
      k.bestTier[best]++;
    }
  };

  const slug = new Map(corpus.organizations.map((o) => [o.id, o.slug]));
  for (const a of corpus.assertions)
    claim("fact", `${slug.get(a.subjectId) ?? a.subjectId} ${a.predicate} [${a.id}]`, a.evidence);
  for (const r of corpus.rounds) {
    const who = slug.get(r.companyId) ?? r.companyId;
    claim("round", `${who} ${r.id}`, r.evidence);
    for (const d of r.disclosures) claim("round disclosure", `${who} ${r.id} ${d.id}`, d.evidence);
    for (const p of r.participations)
      claim("round participant", `${who} ${r.id} ${p.reportedName}`, p.evidence);
  }
  for (const g of corpus.agreements) {
    claim("agreement", g.id, g.evidence);
    // Disclosure rows are individually cited when the record has one evidence entry per row (the
    // importer's layout). Otherwise a row rests on the record-level citations, reported separately
    // so the less precise case stays visible.
    const aligned = g.evidence.length === g.disclosureRows.length;
    g.disclosureRows.forEach((row, i) =>
      claim(
        aligned ? "agreement row" : "agreement row (record-level citation)",
        `${g.id} ${row.reportingPeriod}`,
        aligned ? [g.evidence[i]!] : g.evidence,
      ),
    );
    g.valueStatements.forEach((v, i) =>
      claim("agreement value statement", `${g.id} #${i + 1}`, v.evidence),
    );
    g.allocations.forEach((al, i) =>
      claim("agreement allocation", `${g.id} #${i + 1}`, al.evidence),
    );
  }
  for (const q of corpus.acquisitions) claim("acquisition", q.id, q.evidence);

  const list = [...kinds.values()];
  return {
    kinds: list,
    problems,
    total: list.reduce((n, k) => n + k.total, 0),
    cited: list.reduce((n, k) => n + k.cited, 0),
  };
}

export function formatCoverage(c: CitationCoverage, maxProblems = 40): string {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const lines = [
    `${pad("claim kind", 28)}${pad("claims", 9)}${pad("cited", 9)}${pad("best T1", 9)}${pad("best T2", 9)}${pad("best T3", 9)}`,
  ];
  for (const k of c.kinds)
    lines.push(
      `${pad(k.kind, 28)}${pad(k.total, 9)}${pad(k.cited, 9)}${pad(k.bestTier.T1, 9)}${pad(k.bestTier.T2, 9)}${pad(k.bestTier.T3 + k.bestTier.T4, 9)}`,
    );
  const pct = c.total ? ((c.cited / c.total) * 100).toFixed(1) : "100.0";
  lines.push(`\n${c.cited} of ${c.total} claims have a usable citation (${pct}%).`);
  if (c.problems.length) {
    lines.push(`\n${c.problems.length} problem(s):`);
    for (const p of c.problems.slice(0, maxProblems))
      lines.push(`  [${p.kind}] ${p.claim}: ${p.problem}`);
    if (c.problems.length > maxProblems)
      lines.push(`  … and ${c.problems.length - maxProblems} more`);
  }
  return lines.join("\n");
}
