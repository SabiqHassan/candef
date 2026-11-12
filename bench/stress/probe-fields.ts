import { readFileSync, readdirSync } from "node:fs";
const dir = ".stress/public/data/stress";
const file = readdirSync(dir).find((f) => f.startsWith("snapshot."))!;
const s = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
const size = (v: unknown) => (v === undefined ? 0 : JSON.stringify(v).length);
const total = size(s);
function fields(label: string, list: Record<string, unknown>[]) {
  const acc = new Map<string, number>();
  for (const x of list)
    for (const [k, v] of Object.entries(x)) acc.set(k, (acc.get(k) ?? 0) + size(v));
  const rows = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`${label} (${list.length})`);
  for (const [k, v] of rows)
    console.log(
      `  ${(v / 1e6).toFixed(2).padStart(6)} MB ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`,
    );
}
console.log(`total ${(total / 1e6).toFixed(1)} MB`);
fields("rounds", s.rounds);
fields("agreements", s.agreements);
fields("capital edges", s.graph.lenses.capital.edges);
fields("contract edges", s.graph.lenses.contracts.edges);
fields("organizations", s.organizations);
fields("assertions", Object.values(s.assertions));
fields("sources", Object.values(s.sources));
// citations everywhere
let cites = 0,
  citeCount = 0;
JSON.stringify(s, (k, v) => {
  if (k === "citations" && Array.isArray(v)) {
    cites += size(v);
    citeCount += v.length;
  }
  return v;
});
console.log(
  `all citations arrays: ${(cites / 1e6).toFixed(2)} MB (${((100 * cites) / total).toFixed(1)}%), ${citeCount} entries`,
);
