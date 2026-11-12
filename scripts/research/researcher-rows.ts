/**
 * Classifies the government rows that independent blind researchers attributed to the first-10
 * companies (worksheet "new findings", fields E01-E07) against CANDEF's records and the PR #1 linkage
 * output (overnight task 5). Read-only; prints counts and row references only.
 *
 *   npx tsx scripts/research/researcher-rows.ts [--md]
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Worksheet } from "../../pipeline/research/blind";
import { loadResearchCorpus } from "../../pipeline/research/load";

const CACHE = "research-cache/blind-verification";
const wsFile = readdirSync(CACHE)
  .filter((f) => /^worksheet-.*\.json$/.test(f))
  .sort()
  .at(-1)!;
const ws = JSON.parse(readFileSync(join(CACHE, wsFile), "utf8")) as Worksheet;
const independence = JSON.parse(
  readFileSync("docs/verification/blind-v2-internal/independence.json", "utf8"),
) as { exposed: { researcher: string; cards: string[] }[] };
const exposed = new Set(
  independence.exposed.flatMap((e) => e.cards.map((c) => `${e.researcher}|${c}`)),
);
const linkage = JSON.parse(
  readFileSync("research-cache/gov-linkage/import/linkage.json", "utf8"),
) as {
  decisions: {
    locator: string;
    outcome: string;
    method: string;
    orgId: string | null;
    candidates: string[];
    dataset: string;
  }[];
};
const corpus = loadResearchCorpus("research").corpus!;
const cards = JSON.parse(
  readFileSync("docs/verification/blind-v2-internal/cards.json", "utf8"),
) as {
  card: string;
  orgSlugs: string[];
}[];
const orgOfCard = new Map(
  cards.map((c) => [
    c.card,
    corpus.organizations.filter((o) => c.orgSlugs.includes(o.slug)).map((o) => o.id),
  ]),
);

/**
 * Row references in a finding. Record URLs give owner_org and reference; Perplexity's claims name
 * contracts by procurement ID ("Contract X to NAME (owner)") and grants by reference number
 * ("owner agreement REF to NAME under ...").
 */
function refsOf(
  origins: string[],
  claim: string,
): { dataset: "grants" | "contracts"; key: string; ref: string }[] {
  const out: { dataset: "grants" | "contracts"; key: string; ref: string }[] = [];
  for (const o of origins) {
    const m =
      /search\.open\.canada\.ca\/(grants|contracts)\/record\/([^,/]+)(?:%2c|,)([^,/]+)/i.exec(o);
    if (m)
      out.push({
        dataset: m[1]!.toLowerCase() as "grants" | "contracts",
        key: m[1]!.toLowerCase() === "grants" ? "ref_number" : "reference_number",
        ref: decodeURIComponent(m[3]!).toUpperCase(),
      });
  }
  const c = /^Contract (\S+) to .+? \(([a-z-]+)\)/.exec(claim);
  if (c) out.push({ dataset: "contracts", key: "procurement_id", ref: c[1]!.toUpperCase() });
  const g = /^([a-z-]+) agreement (\S+) to /.exec(claim);
  if (g) out.push({ dataset: "grants", key: "ref_number", ref: g[2]!.toUpperCase() });
  return out;
}

const cited = new Set<string>();
for (const g of corpus.agreements) {
  for (const e of g.evidence)
    for (const m of e.locator.matchAll(
      /(?:^|;)(ref_number|reference_number|procurement_id)=([^;]+)/g,
    ))
      cited.add(`${m[1]}=${decodeURIComponent(m[2]!).toUpperCase()}`);
  for (const x of g.externalIds)
    if (x.system === "tbs-contracts:procurement_id")
      cited.add(`procurement_id=${x.value.toUpperCase()}`);
}

type Row = {
  card: string;
  researcher: string;
  finding: string;
  dataset: string;
  ref: string;
  status: string;
};
const rows: Row[] = [];
const unparsed: string[] = [];
for (const f of ws.newFindings) {
  if (!/^E0[1-7]$/.test(f.fieldId) || exposed.has(`${f.researcher}|${f.card}`)) continue;
  const refs = refsOf(f.origins, f.claim);
  if (!refs.length) {
    unparsed.push(`${f.card} ${f.researcher} ${f.findingId}: ${f.origins.slice(0, 2).join(" ")}`);
    continue;
  }
  for (const r of refs) {
    let status: string;
    if (cited.has(`${r.key}=${r.ref}`)) status = "already a CANDEF record (alignment miss)";
    else {
      const ds = linkage.decisions.filter(
        (d) =>
          d.locator.toUpperCase().includes(`=${r.ref};`) ||
          d.locator.toUpperCase().includes(`=${encodeURIComponent(r.ref).toUpperCase()};`),
      );
      const mine = ds.filter((d) =>
        orgOfCard.get(f.card)!.some((o) => d.orgId === o || d.candidates.includes(o)),
      );
      if (mine.some((d) => d.outcome === "linked"))
        status = "linked by the importer (enters through the migration/import)";
      else if (mine.length)
        status = `held by the importer: ${[...new Set(mine.map((d) => d.method))].join("/")} (owner exception)`;
      else if (ds.length) status = "matched to another organization by the importer";
      else status = "not in the importer's retained rows (no name match to the company)";
    }
    rows.push({
      card: f.card,
      researcher: f.researcher,
      finding: f.findingId,
      dataset: r.dataset,
      ref: r.ref,
      status,
    });
  }
}
const key = (r: Row) => `${r.card}|${r.dataset}|${r.ref}`;
const unique = [...new Map(rows.map((r) => [key(r), r])).values()];
const counts: Record<string, number> = {};
for (const r of unique) counts[r.status] = (counts[r.status] ?? 0) + 1;
if (process.argv.includes("--md")) {
  console.log(`| Card | Dataset | Reference | Status |\n| --- | --- | --- | --- |`);
  for (const r of unique.sort((a, b) => key(a).localeCompare(key(b))))
    console.log(`| ${r.card} | ${r.dataset} | \`${r.ref}\` | ${r.status} |`);
} else {
  console.log(
    `findings rows ${rows.length}; unique rows ${unique.length}; findings without a parsable record URL ${unparsed.length}`,
  );
  console.log(counts);
  for (const u of unparsed.slice(0, 40)) console.log("  unparsed:", u);
}
