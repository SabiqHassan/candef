import { compile } from "../../pipeline/compile/compile";
import { generateDemoCorpus } from "../../pipeline/demo/generate";
import { generateStressCorpus } from "../../pipeline/synthetic/stress";
for (const n of (process.argv[2] ?? "2000,4000").split(",").map(Number)) {
  const t0 = performance.now();
  const demo = generateDemoCorpus({ companies: n, seed: 4242 });
  const t1 = performance.now();
  const { corpus } = generateStressCorpus({ companies: n });
  const t2 = performance.now();
  compile(corpus, { today: "2026-10-13" });
  const t3 = performance.now();
  console.log(
    JSON.stringify({
      n,
      demoGenMs: Math.round(t1 - t0),
      stressGenMs: Math.round(t2 - t1),
      compileMs: Math.round(t3 - t2),
      orgs: demo.organizations.length,
    }),
  );
}
