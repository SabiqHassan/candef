/**
 * Builds the FICTIONAL demo snapshot into public/data/demo/.
 * Usage: npm run data:demo
 *
 * Output: snapshot.<hash>.json (content-addressed, immutable) + manifest.json (atomic pointer,
 * keeps the previous snapshots for rollback; ARCHITECTURE §8).
 */
import { join } from "node:path";
import { compile } from "./compile/compile";
import { generateDemoCorpus } from "./demo/generate";
import { publishSnapshot, readPreviousPositions } from "./publish";

const outDir = join(process.cwd(), "public", "data", "demo");
// Keep company positions stable across rebuilds (D-07), but only within one layout version.
const previousPositions = readPreviousPositions(outDir);

const corpus = generateDemoCorpus();
const result = compile(corpus, { today: "2026-10-13", thresholdCad: 100_000, previousPositions });
for (const w of result.warnings) console.warn(`warning: ${w}`);
if (!result.ok || !result.snapshot) {
  for (const f of result.failures)
    console.error(
      `GATE FAILED [${f.gate}] ${f.message}: ${f.ids.slice(0, 8).join(", ")}${f.ids.length > 8 ? " …" : ""}`,
    );
  process.exit(1);
}
const snap = result.snapshot;
const { file } = publishSnapshot(outDir, snap);

const c = snap.coverage;
console.log(
  [
    `demo snapshot ${file}`,
    `${c.inUniverse} companies in universe (${c.companiesDiscovered} discovered), ${snap.organizations.length - c.inUniverse} contextual orgs`,
    `${c.financing.roundsKnown} verified rounds (${c.financing.roundsWithResolvedAmount} with resolved amount)`,
    `${c.agreements.procurement} contracts, ${c.agreements.grants} grants, ${c.agreements.partnerships} partnerships`,
    `edges: capital ${snap.graph.lenses.capital.edges.length}, bundles ${snap.graph.lenses.capital.bundles.length}, contracts ${snap.graph.lenses.contracts.edges.length}, gov bundles ${snap.graph.lenses.contracts.bundles.length}`,
  ].join("\n"),
);
