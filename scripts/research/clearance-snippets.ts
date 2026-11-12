/**
 * Audit aid: for every cleared K2/K3 record of a clearance file, prints the claim and the text of
 * the saved copy around each matched value, so a reviewer can check the value is stated as the
 * claim says (and not on the page for another reason). Read-only; output goes to stdout.
 *
 *   npx tsx scripts/research/clearance-snippets.ts --clearance <file> [--dir research] [--cache research-cache]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadResearchCorpus } from "../../pipeline/research/load";
import { evaluateTiers } from "../../pipeline/research/tiers/rules";
import { loadTierInputs } from "../../pipeline/research/tiers/run";
import type { ClearanceFile } from "../../pipeline/research/clearance/run";

const args = process.argv.slice(2);
const flag = (n: string) =>
  args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined;
const file = JSON.parse(readFileSync(resolve(flag("clearance")!), "utf8")) as ClearanceFile;
const corpus = loadResearchCorpus(resolve(flag("dir") ?? "research")).corpus!;
const cache = resolve(flag("cache") ?? "research-cache");
const { inputs } = await loadTierInputs(corpus, {
  cacheDir: cache,
  today: file.today,
  cards: [],
  skipGovRows: true,
});
const tiers = new Map(evaluateTiers(inputs).map((t) => [t.id, t]));
const cleared = file.records.filter(
  (r) => (r.state === "cleared" || r.state === "cleared_qc") && (r.cls === "K2" || r.cls === "K3"),
);
for (const r of cleared) {
  console.log(`\n### ${r.orgName} | ${r.id} | ${r.predicate ?? r.kind} | ${r.state}`);
  const t = tiers.get(r.id);
  for (const v of t?.values ?? []) {
    if (!v.found || !v.sourceId || !v.captureId || v.offset === null) {
      console.log(`  ${v.part} "${v.value}": ${v.found ? "found (dataset row)" : "NOT FOUND"}`);
      continue;
    }
    const text = inputs.readCapture(v.sourceId, v.captureId) ?? "";
    console.log(
      `  ${v.part} "${v.value}" @${v.offset}: …${text.slice(Math.max(0, v.offset - 140), v.offset + 120).replace(/\s+/g, " ")}…`,
    );
  }
  if (!t?.values.length) console.log(`  (no copy values; ${r.basis})`);
}
