/**
 * Writes the first-10 tiers report (overnight task 4): per company, tier 1 and tier 2 passes, the
 * tier 3 items and every exception with its failed rule. Counts and record IDs only, no source text.
 *
 *   npx tsx scripts/research/tiers-report.ts <tiers.json> <out.md>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadResearchCorpus } from "../../pipeline/research/load";
import type { TierRecord } from "../../pipeline/research/tiers/rules";
import type { TiersFile } from "../../pipeline/research/tiers/run";

const [tiersPath, out] = process.argv.slice(2);
if (!tiersPath || !out) throw new Error("usage: tiers-report.ts <tiers.json> <out.md>");
const tiers = JSON.parse(readFileSync(tiersPath, "utf8")) as TiersFile;
const corpus = loadResearchCorpus("research").corpus!;
const cards = JSON.parse(
  readFileSync("docs/verification/blind-v2-internal/cards.json", "utf8"),
) as { card: string; name: string; orgSlugs: string[] }[];
const orgId = (slug: string) => corpus.organizations.find((o) => o.slug === slug)?.id;
const describe = (r: TierRecord) => {
  const a = corpus.assertions.find((x) => x.id === r.id);
  if (a) return a.predicate;
  if (r.kind === "round") return "financing round";
  if (r.kind === "acquisition") return "acquisition";
  return corpus.agreements.find((g) => g.id === r.id)?.family ?? r.kind;
};

const lines: string[] = [
  `# Tier results for the first 10 companies (${tiers.today})`,
  "",
  `Overnight task 4 (\`docs/OVERNIGHT_2026-10-15.md\`). Generated from the tiers file of ${tiers.today}, batch \`${tiers.batch}\` (${tiers.rules}). Record IDs and counts only; no source text. **Nothing is approved:** the owner applies a batch with \`apply-tiers\` (\`docs/REVIEW_WORKSPACE.md\`).`,
  "",
  `Inputs: worksheet ${tiers.inputs.worksheet ? "`" + tiers.inputs.worksheet.file.split(/[\\/]/).pop() + "`" : "none"}; reconciliation plan ${tiers.inputs.plan ? "`" + tiers.inputs.plan.hash.slice(0, 12) + "…`" : "none"}; dataset rows ${tiers.inputs.govRowsLoaded ? "loaded" : "not loaded"}.`,
  "",
  "**How to read it.** Tier 1 covers government agreements. *Conditional* means the record passes once the owner approves the company's identity anchor (BN or postal area); the anchors are listed per company. When the reconciliation plan still has pending changes, *T1 after migration* evaluates the plan's replacement content instead. Tier 2 needs a saved copy of every cited source (T2-b), so terms-silent sites keep most first-party facts out of tier 2 (owner question 3).",
  "",
  "## Summary",
  "",
  "| Card | Company | Records | T1 (pass / conditional / exception) | T1 after pending migration (conditional / pass / exception) | T2 pass | T2 exception | Tier 3 |",
  "| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |",
];
const sections: string[] = [];
const totals = { records: 0, t1p: 0, t1c: 0, t1e: 0, t2: 0, t2x: 0, t3: 0 };
for (const c of cards) {
  const ids = new Set(c.orgSlugs.map(orgId).filter(Boolean));
  const rs = tiers.records.filter((r) => ids.has(r.orgId));
  const n = (f: (r: TierRecord) => boolean) => rs.filter(f).length;
  const t1 = rs.filter((r) => r.tier === 1);
  const proj = (s: string) => t1.filter((r) => r.projected?.status === s).length;
  const now = (s: string) => t1.filter((r) => r.status === s).length;
  const anyProj = t1.some((r) => r.projected);
  lines.push(
    `| ${c.card} | ${c.name} | ${rs.length} | ${now("pass")} / ${now("conditional")} / ${now("exception")} | ${anyProj ? `${proj("conditional")} / ${proj("pass")} / ${proj("exception")}` : "none pending"} | ${n((r) => r.tier === 2 && r.status === "pass")} | ${n((r) => r.tier === 2 && r.status === "exception")} | ${n((r) => r.tier === 3)} |`,
  );
  totals.records += rs.length;
  totals.t1p += now("pass");
  totals.t1c += now("conditional");
  totals.t1e += now("exception");
  totals.t2 += n((r) => r.tier === 2 && r.status === "pass");
  totals.t2x += n((r) => r.tier === 2 && r.status === "exception");
  totals.t3 += n((r) => r.tier === 3);
  sections.push(`## ${c.card} ${c.name}`, "");
  const t3 = rs.filter((r) => r.tier === 3);
  sections.push(`**Tier 3 (owner judgement, ${t3.length}):**`, "");
  const byRoute = new Map<string, string[]>();
  for (const r of t3) byRoute.set(r.route, [...(byRoute.get(r.route) ?? []), `\`${r.id}\``]);
  for (const [route, list] of byRoute) sections.push(`- ${route}: ${list.join(", ")}`);
  sections.push("", "**Tier 2:**", "");
  for (const r of rs.filter((x) => x.tier === 2)) {
    const failed = r.rules.filter((x) => x.result === "fail");
    sections.push(
      `- \`${r.id}\` (${describe(r)}): ${r.status === "pass" ? "**pass**" : `exception, failed ${failed.map((x) => `${x.rule} (${x.reason.replace(/\|/g, "/")})`).join("; ")}`}`,
    );
  }
  const t1x = t1.filter((r) => (r.projected ?? r).status === "exception");
  if (t1x.length) {
    sections.push("", "**Tier 1 exceptions:**", "");
    for (const r of t1x) {
      const rules = (r.projected?.rules ?? r.rules).filter((x) => x.result === "fail");
      sections.push(
        `- \`${r.id}\`: ${rules.map((x) => `${x.rule} (${x.reason.replace(/\|/g, "/")})`).join("; ")}`,
      );
    }
  }
  const anchors = [
    ...new Set(
      t1.flatMap((r) =>
        (r.projected ?? r).status === "conditional"
          ? ((r.projected ?? r).rules
              .find((x) => x.rule === "T1-b")
              ?.reason.match(/asr_[0-9a-f]+/g) ?? [])
          : [],
      ),
    ),
  ];
  if (anchors.length)
    sections.push(
      "",
      `**Identity anchors that unlock tier 1:** ${anchors.map((a) => `\`${a}\``).join(", ")}`,
    );
  sections.push("");
}
lines.push(
  `| | **Total** | **${totals.records}** | **${totals.t1p} / ${totals.t1c} / ${totals.t1e}** | | **${totals.t2}** | **${totals.t2x}** | **${totals.t3}** |`,
  "",
  `Audit sample drawn for this batch: ${tiers.audit.length} record(s).`,
  "",
  ...sections,
);
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${out}`);
