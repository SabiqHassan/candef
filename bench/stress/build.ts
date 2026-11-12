/**
 * Builds a SYNTHETIC stress snapshot (fictional; scale testing only) into the gitignored
 * `.stress/public/data/stress/` folder, which only `vite build --mode stress` serves.
 *
 *   npx tsx bench/stress/build.ts --companies 3000 [--seed 4242]
 *
 * Writes `.stress/build-metrics.json` (generation and compile time, snapshot size, record counts)
 * and `.stress/manifest.json` (ids of the hard cases, for the browser harness).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../../pipeline/compile/compile";
import { publishSnapshot } from "../../pipeline/publish";
import { generateStressCorpus } from "../../pipeline/synthetic/stress";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}

const companies = arg("companies", 3000);
const seed = arg("seed", 4242);
const root = join(process.cwd(), ".stress");
const outDir = join(root, "public", "data", "stress");
// One dataset at a time: never let snapshots from another size linger next to this one.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const { corpus, manifest } = generateStressCorpus({ companies, seed });
const t1 = performance.now();
const heapBefore = process.memoryUsage().heapUsed;
const result = compile(corpus, { today: "2026-10-13", thresholdCad: 100_000 });
const t2 = performance.now();
if (!result.ok || !result.snapshot) {
  for (const f of result.failures) console.error(`GATE FAILED [${f.gate}] ${f.message}`);
  process.exit(1);
}
const snap = result.snapshot;
if (!snap.meta.isDemo) throw new Error("A stress snapshot must be flagged as fictional (isDemo).");
const published = publishSnapshot(outDir, snap);
const t3 = performance.now();

const metrics = {
  companiesRequested: companies,
  seed,
  organizations: snap.organizations.length,
  universe: snap.coverage.inUniverse,
  rounds: snap.rounds.length,
  agreements: snap.agreements.length,
  assertions: Object.keys(snap.assertions).length,
  sources: Object.keys(snap.sources).length,
  edges: {
    capital: snap.graph.lenses.capital.edges.length,
    capitalBundles: snap.graph.lenses.capital.bundles.length,
    contracts: snap.graph.lenses.contracts.edges.length,
    contractBundles: snap.graph.lenses.contracts.bundles.length,
  },
  generateMs: Math.round(t1 - t0),
  compileMs: Math.round(t2 - t1),
  publishMs: Math.round(t3 - t2),
  compileHeapDeltaMB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e6),
  snapshotMB: +(published.bytes / 1e6).toFixed(2),
  snapshotGzipMB: +(published.gzipBytes / 1e6).toFixed(2),
};
writeFileSync(join(root, "build-metrics.json"), JSON.stringify(metrics, null, 2));
writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(metrics));
