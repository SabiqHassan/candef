/**
 * Search latency on the synthetic corpus: first query (builds the per-organization search text) and
 * steady state, against the previous contiguous-substring rule.  npx tsx bench/stress/probe-search.ts 10000
 */
import { compile } from "../../pipeline/compile/compile";
import { generateStressCorpus } from "../../pipeline/synthetic/stress";
import { emptyFilters, filterCompanies, indexSnapshot, normalize } from "../../src/domain";

const n = Number(process.argv[2] ?? 10000);
const snap = compile(generateStressCorpus({ companies: n }).corpus, {
  today: "2026-10-13",
}).snapshot!;
const ix = indexSnapshot(snap);
const oldSearch = (q: string) => {
  const needle = normalize(q);
  return ix.companies.filter((c) =>
    normalize(
      `${c.name} ${c.segment.value?.label ?? ""} ${c.segment.value?.sectorLabel ?? ""} ${c.hq.value?.city ?? ""}`,
    ).includes(needle),
  );
};
const time = (f: () => unknown, reps = 5) => {
  const t = performance.now();
  for (let i = 0; i < reps; i++) f();
  return +((performance.now() - t) / reps).toFixed(1);
};
const queries = ["ro", "rob", "robo", "robot sys", ix.companies[7]!.legalName.value ?? "x"];
console.log(`companies ${ix.companies.length}`);
console.log(
  "first new-search query (builds text) ms:",
  time(() => filterCompanies(ix, { ...emptyFilters, q: "r" }), 1),
);
for (const q of queries)
  console.log(
    JSON.stringify(q),
    "new",
    time(() => filterCompanies(ix, { ...emptyFilters, q })),
    "ms  old",
    time(() => oldSearch(q)),
    "ms  hits",
    filterCompanies(ix, { ...emptyFilters, q }).length,
  );
