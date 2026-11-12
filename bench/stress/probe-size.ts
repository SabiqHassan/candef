import { compile } from "../../pipeline/compile/compile";
import { generateDemoCorpus } from "../../pipeline/demo/generate";
const n = Number(process.argv[2] ?? 3000);
const s = compile(generateDemoCorpus({ companies: n }), { today: "2026-10-13" }).snapshot!;
const size = (v: unknown) => JSON.stringify(v).length;
const total = size(s);
const rows: [string, number][] = [];
for (const [k, v] of Object.entries(s)) rows.push([k, size(v)]);
for (const [k, v] of Object.entries(s.graph)) rows.push([`graph.${k}`, size(v)]);
for (const [k, v] of Object.entries(s.graph.lenses))
  for (const [k2, v2] of Object.entries(v)) rows.push([`graph.lenses.${k}.${k2}`, size(v2)]);
const org = s.organizations[0]!;
for (const [k, v] of Object.entries(org))
  rows.push([`org.${k} (x${s.organizations.length})`, size(v) * s.organizations.length]);
rows.sort((a, b) => b[1] - a[1]);
console.log(`total ${(total / 1e6).toFixed(1)} MB`);
for (const [k, v] of rows.slice(0, 30))
  console.log(
    `${(v / 1e6).toFixed(2).padStart(7)} MB  ${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`,
  );
