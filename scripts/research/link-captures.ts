/**
 * Sets `captureId` on evidence items that cite the given sources, pointing at each source's latest
 * capture (docs/OVERNIGHT_2026-10-15.md task 1 step 3). Run only after checking that the record's
 * values were read in that capture. Evidence already bound to a capture is left alone. Government
 * dataset sources are refused: their agreements are bound through the registered dataset capture
 * (tier 1, T1-a) and are rewritten by the pending Codex migration.
 *
 *   npx tsx scripts/research/link-captures.ts <sourceId…> [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, visit } from "yaml";
import { loadResearchCorpus } from "../../pipeline/research/load";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const ids = args.filter((a) => !a.startsWith("--"));
const corpus = loadResearchCorpus("research").corpus;
if (!corpus) throw new Error("research/ does not validate");
const latest = new Map<string, string>();
for (const id of ids) {
  const s = corpus.sources.find((x) => x.id === id);
  if (!s) throw new Error(`unknown source ${id}`);
  if (s.kind === "gov_dataset") throw new Error(`${id} is a government dataset; see the header`);
  const cap = s.captures?.at(-1);
  if (!cap) throw new Error(`${id} has no capture`);
  latest.set(id, cap.id);
}
const dir = join("research", "orgs");
let total = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
  const file = join(dir, f);
  const doc = parseDocument(readFileSync(file, "utf8"));
  let n = 0;
  visit(doc, {
    // `src: ["sourceId#locator"]` strings: insert `@captureId` after the source id.
    Scalar(_, node) {
      if (typeof node.value !== "string") return;
      const m = /^(src_[0-9a-f]+)#/.exec(node.value);
      if (!m || !latest.has(m[1]!)) return;
      node.value = `${m[1]}@${latest.get(m[1]!)}${node.value.slice(m[1]!.length)}`;
      n++;
    },
    // Object form `{ source, locator }`.
    Map(_, node) {
      const sid = node.get("source");
      if (typeof sid !== "string" || !latest.has(sid) || node.get("capture")) return;
      node.set("capture", latest.get(sid));
      n++;
    },
  });
  if (!n) continue;
  total += n;
  console.log(`${f}: ${n} evidence items`);
  if (!dry) writeFileSync(file, doc.toString());
}
console.log(`${total} evidence items ${dry ? "would be" : ""} linked`);
