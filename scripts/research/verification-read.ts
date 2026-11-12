/**
 * One-time verification read (P-61): checks the records that cite a source against the live page
 * (or a page the owner saved) and keeps only hashes and match offsets, never text.
 *
 *   npx tsx scripts/research/verification-read.ts <sourceId> [--file <saved page or pdf>]
 *       [--dir research] [--cache research-cache]
 *
 * Writes research-cache/verification-reads/<sourceId>.json (gitignored). Read-only on research/.
 * robots.txt is respected; a page that refuses (HTTP 403, a block page) is reported, not bypassed.
 */
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { loadResearchCorpus } from "../../pipeline/research/load";
import { verificationRead } from "../../pipeline/research/verificationRead";

const args = process.argv.slice(2);
const flag = (n: string) =>
  args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined;
const sourceId = args.find((a) => a.startsWith("src_"));
if (!sourceId) {
  console.error("usage: verification-read.ts <sourceId> [--file <path>]");
  process.exit(1);
}
const loaded = loadResearchCorpus(resolve(flag("dir") ?? "research"));
if (!loaded.corpus) throw new Error("research/ does not validate");
const file = flag("file");
const ext = file ? extname(file).toLowerCase() : "";
const out = await verificationRead(loaded.corpus, sourceId, {
  cacheDir: resolve(flag("cache") ?? "research-cache"),
  file: file
    ? {
        bytes: readFileSync(resolve(file)),
        type:
          ext === ".pdf" ? "application/pdf" : /\.html?$/.test(ext) ? "text/html" : "text/plain",
      }
    : undefined,
});
console.log(
  `${out.url}\n  read ${out.readAt} (${out.method}), text sha256 ${out.textSha256.slice(0, 12)}…, ${out.textLength} chars`,
);
for (const [id, r] of Object.entries(out.records)) {
  const found = r.parts.filter((p) => p.found).length;
  console.log(
    `  ${id}: ${found}/${r.parts.length} value(s) found${r.parts
      .filter((p) => !p.found)
      .map((p) => `\n      NOT FOUND ${p.part} "${p.value}"`)
      .join("")}`,
  );
}
console.log(`  entity names on the page: ${JSON.stringify(out.entityNamed)}`);
