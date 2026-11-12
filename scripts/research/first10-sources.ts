/**
 * Lists every source behind the first-10 cohort's review units (docs/OVERNIGHT_2026-10-15.md task 1):
 * the units whose org is a card org, plus the records of the investors and parents they cite.
 * Read-only; prints a table of source id, kind, host, permission, capture count and units citing it.
 *
 *   npx tsx scripts/research/first10-sources.ts [--json | --md] [--cards <cohort cards.json>]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reviewUnits } from "../../pipeline/research/decisions";
import { loadResearchCorpus } from "../../pipeline/research/load";
import type { Corpus, Evidence } from "../../src/domain/schema/corpus";

const root = join(process.cwd(), "research");
// `--cards <file>` picks another cohort (batch 2: docs/verification/batch2/cards.json).
const cardsAt = process.argv.indexOf("--cards");
const cards = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      cardsAt > 0 ? process.argv[cardsAt + 1]! : "docs/verification/blind-v2-internal/cards.json",
    ),
    "utf8",
  ),
) as { card: string; orgSlugs: string[] }[];

export function cohortRecords(corpus: Corpus, slugs: string[], today: string) {
  const orgIds = new Set(
    corpus.organizations.filter((o) => slugs.includes(o.slug)).map((o) => o.id),
  );
  const units = reviewUnits(corpus, today).filter((u) => orgIds.has(u.orgId));
  return { orgIds, units };
}

/** Every evidence list on a record, including round disclosures and participations. */
export function evidenceOf(corpus: Corpus, id: string): Evidence[] {
  const a = corpus.assertions.find((x) => x.id === id);
  if (a) return a.evidence;
  const r = corpus.rounds.find((x) => x.id === id);
  if (r)
    return [
      ...r.evidence,
      ...r.disclosures.flatMap((d) => d.evidence),
      ...r.participations.flatMap((p) => p.evidence),
    ];
  const g = corpus.agreements.find((x) => x.id === id);
  if (g)
    return [
      ...g.evidence,
      ...g.valueStatements.flatMap((v) => v.evidence),
      ...g.allocations.flatMap((v) => v.evidence),
    ];
  const q = corpus.acquisitions.find((x) => x.id === id);
  if (q) return q.evidence;
  return [];
}

if (process.argv[1]?.endsWith("first10-sources.ts")) {
  const loaded = loadResearchCorpus(root);
  if (!loaded.corpus) throw new Error("research/ does not validate");
  const corpus = loaded.corpus;
  const today = new Date().toISOString().slice(0, 10);
  const { orgIds, units } = cohortRecords(
    corpus,
    cards.flatMap((c) => c.orgSlugs),
    today,
  );
  // Investors and parents referenced by cohort records: their own proposed facts are context.
  const linked = new Set<string>();
  for (const r of corpus.rounds.filter((x) => orgIds.has(x.companyId)))
    for (const p of r.participations) {
      linked.add(p.investorId);
      if (p.vehicleId) linked.add(p.vehicleId);
    }
  for (const a of corpus.assertions.filter(
    (x) => orgIds.has(x.subjectId) && ["subsidiary_of", "division_of"].includes(x.predicate),
  )) {
    const v = a.value as { orgId?: string } | string;
    const id = typeof v === "string" ? v : v?.orgId;
    if (id) linked.add(id);
  }
  for (const q of corpus.acquisitions.filter(
    (x) => orgIds.has(x.targetId) || orgIds.has(x.acquirerId),
  )) {
    linked.add(q.acquirerId);
    linked.add(q.targetId);
  }
  for (const id of orgIds) linked.delete(id);
  const linkedUnits = reviewUnits(corpus, today).filter(
    (u) => linked.has(u.orgId) && u.kind === "assertion",
  );
  const bySource = new Map<string, Set<string>>();
  for (const u of [...units, ...linkedUnits])
    for (const e of evidenceOf(corpus, u.id)) {
      if (!bySource.has(e.sourceId)) bySource.set(e.sourceId, new Set());
      bySource.get(e.sourceId)!.add(u.id);
    }
  const rows = [...bySource.entries()].map(([id, set]) => {
    const s = corpus.sources.find((x) => x.id === id)!;
    return {
      id,
      kind: s.kind,
      tier: s.tier,
      url: s.url,
      capture: s.permissions?.capture ?? "unknown",
      captures: s.captures?.length ?? 0,
      fingerprints: s.fingerprints?.length ?? 0,
      availability: s.availability ?? "unknown",
      units: set.size,
    };
  });
  rows.sort((a, b) => a.url.localeCompare(b.url));
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else if (process.argv.includes("--md")) {
    const state = (r: (typeof rows)[number]) =>
      r.captures ? "captured" : r.fingerprints ? `hashes only (capture ${r.capture})` : "none";
    console.log(
      "| Source | Kind | Tier | Capture permission | State | Availability | Records citing |",
    );
    console.log("| --- | --- | --- | --- | --- | --- | ---: |");
    for (const r of rows)
      console.log(
        `| \`${r.id}\` ${new URL(r.url).host} | ${r.kind} | ${r.tier} | ${r.capture} | ${state(r)} | ${r.availability} | ${r.units} |`,
      );
  } else {
    console.log(
      `cohort units ${units.length}; linked-org fact units ${linkedUnits.length}; sources ${rows.length}`,
    );
    for (const r of rows)
      console.log([r.id, r.kind, r.tier, r.capture, r.captures, r.units, r.url].join("\t"));
  }
}
