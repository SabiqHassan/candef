/**
 * Writes the lead-search data file the site loads.
 *
 *   npm run leads:data -- --index <dir> --out public/data/research/leads.json --data-date 2026-10-13 [--tiers A]
 *   npm run leads:data -- --demo --out public/data/demo/leads.json
 *
 * `--index` is the folder `npm run grant-ask -- index` wrote (it holds search.jsonl); default
 * research-cache/grant-ask/index, or the CANDEF_LEADS_INDEX environment variable. Without an index
 * the real file is simply not written and the build ships without a leads page.
 * Nothing is written under research/.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { demoLeadsFile } from "./siteDemo";
import { buildLeadsFile, readSearchDocs } from "./siteExport";

const { values: v } = parseArgs({
  options: {
    index: { type: "string" },
    out: { type: "string" },
    "data-date": { type: "string" },
    tiers: { type: "string" },
    demo: { type: "boolean" },
  },
});
const out = resolve(
  v.out ?? (v.demo ? "public/data/demo/leads.json" : "public/data/research/leads.json"),
);

async function main() {
  let file;
  if (v.demo) file = demoLeadsFile();
  else {
    const indexDir = resolve(
      v.index ?? process.env.CANDEF_LEADS_INDEX ?? "research-cache/grant-ask/index",
    );
    if (!existsSync(join(indexDir, "search.jsonl"))) {
      console.log(`no lead index at ${indexDir}; the leads page will be absent from this build`);
      return;
    }
    const tiers = (v.tiers ?? "A").split(",") as ("A" | "B" | "C" | "D")[];
    file = buildLeadsFile(await readSearchDocs(indexDir), {
      dataDate: v["data-date"] ?? "unknown",
      tiers,
      isDemo: false,
    });
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(file));
  console.log(`${file.meta.count} leads (tiers ${file.meta.tiers.join("")}) → ${out}`);
}
await main();
