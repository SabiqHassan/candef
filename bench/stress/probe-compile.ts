import { gzipSync } from "node:zlib";
import { compile } from "../../pipeline/compile/compile";
import { generateDemoCorpus } from "../../pipeline/demo/generate";
import { indexSnapshot } from "../../src/domain/index";

for (const n of (process.argv[2] ?? "380,1000,3000").split(",").map(Number)) {
  const t0 = performance.now();
  const corpus = generateDemoCorpus({ companies: n });
  const t1 = performance.now();
  const r = compile(corpus, { today: "2026-10-13" });
  const t2 = performance.now();
  const json = JSON.stringify(r.snapshot);
  const t3 = performance.now();
  const ix = indexSnapshot(JSON.parse(json));
  const t4 = performance.now();
  const s = r.snapshot!;
  console.log(
    JSON.stringify({
      companies: n,
      orgs: s.organizations.length,
      rounds: s.rounds.length,
      agreements: s.agreements.length,
      assertions: Object.keys(s.assertions).length,
      sources: Object.keys(s.sources).length,
      capitalEdges: s.graph.lenses.capital.edges.length,
      contractEdges: s.graph.lenses.contracts.edges.length,
      generateMs: Math.round(t1 - t0),
      compileMs: Math.round(t2 - t1),
      stringifyMs: Math.round(t3 - t2),
      parseAndIndexMs: Math.round(t4 - t3),
      jsonMB: +(json.length / 1e6).toFixed(2),
      gzipMB: +(gzipSync(json).length / 1e6).toFixed(2),
      heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
      ok: r.ok,
    }),
  );
  void ix;
}
