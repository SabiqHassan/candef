/**
 * Builds the REAL research snapshot from research/ into public/data/research/ (M3-A3).
 * Usage: npm run data:research [-- --dir <research dir>] [-- --out <dir>]
 *
 * Only verified, hash-reviewed records are published (compiler); proposed records are validated
 * and counted but withheld. Writes D-03 trigger metrics next to the snapshot (M3-A5).
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compile } from "./compile/compile";
import { publishSnapshot, readPreviousPositions } from "./publish";
import { loadResearchCorpusUncached } from "./research/load";
import { researchBuildGates } from "./research/gates";
import { proposedRecordCount } from "./research/counts";
import { readTakedowns, takedownFailures } from "./research/takedown";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const researchDir = resolve(arg("--dir") ?? "research");
const outDir = resolve(arg("--out") ?? join("public", "data", "research"));
// D-21 section 8: "share" omits claims whose sources do not allow sharing outside the licence.
const audience = arg("--audience") ?? "private";
if (audience !== "private" && audience !== "share") {
  console.error(`--audience must be private or share (got ${audience})`);
  process.exit(1);
}
const today = new Date().toISOString().slice(0, 10);

const started = performance.now();
const loaded = loadResearchCorpusUncached(researchDir);
if (!loaded.corpus) {
  for (const i of loaded.issues) console.error(`${i.file}:${i.path}: ${i.message}`);
  console.error(`research corpus invalid: ${loaded.issues.length} problem(s)`);
  process.exit(1);
}
const gateFailures = [
  ...researchBuildGates(loaded.corpus),
  ...takedownFailures(loaded.corpus, readTakedowns(researchDir)),
];
for (const f of gateFailures)
  console.error(`GATE FAILED [${f.gate}] ${f.message}: ${f.ids.slice(0, 8).join(", ")}`);
if (gateFailures.length) process.exit(1);

const result = compile(loaded.corpus, {
  today,
  thresholdCad: 100_000,
  previousPositions: readPreviousPositions(outDir),
  audience,
});
const compileMs = Math.round(performance.now() - started);
for (const w of result.warnings) console.warn(`warning: ${w}`);
for (const q of result.quality)
  console.warn(`quality [${q.check}] ${q.message}: ${q.ids.slice(0, 6).join(", ")}`);
if (!result.ok || !result.snapshot) {
  for (const f of result.failures)
    console.error(`GATE FAILED [${f.gate}] ${f.message}: ${f.ids.slice(0, 8).join(", ")}`);
  process.exit(1);
}

const snap = result.snapshot;
const published = publishSnapshot(outDir, snap);
const corpus = loaded.corpus;
const metrics = {
  builtAt: snap.meta.builtAt,
  snapshot: published.file,
  compileMs,
  snapshotBytes: published.bytes,
  snapshotGzipBytes: published.gzipBytes,
  files: loaded.files,
  records: {
    organizations: corpus.organizations.length,
    sources: corpus.sources.length,
    assertions: corpus.assertions.length,
    rounds: corpus.rounds.length,
    agreements: corpus.agreements.length,
    acquisitions: corpus.acquisitions.length,
    research: corpus.research.length,
    proposed: proposedRecordCount(corpus),
  },
  published: {
    companies: snap.coverage.inUniverse,
    assertions: Object.keys(snap.assertions).length,
  },
  // ARCHITECTURE §3 triggers for introducing a database (measured, not guessed).
  d03Triggers: {
    compileOver60s: compileMs > 60_000,
    snapshotOver5MBGzip: published.gzipBytes > 5 * 1024 * 1024,
  },
};
writeFileSync(join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));
mkdirSync("research-cache/metrics", { recursive: true });
appendFileSync("research-cache/metrics/research-builds.jsonl", JSON.stringify(metrics) + "\n");

console.log(
  [
    `research snapshot ${published.file}`,
    `${metrics.records.organizations} organizations, ${metrics.records.proposed} proposed records (withheld until reviewed)`,
    `${metrics.published.companies} companies published`,
    `compile ${compileMs} ms, snapshot ${published.bytes} B (${published.gzipBytes} B gzip)`,
  ].join("\n"),
);
