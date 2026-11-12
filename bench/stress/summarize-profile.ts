/**
 * Summarizes a V8 .cpuprofile (from `node --cpu-prof`) by self time and by inclusive time per
 * function, limited to repository code, so hotspots can be found without a GUI.
 *
 *   npx tsx bench/stress/summarize-profile.ts <file.cpuprofile> [top]
 */
import { readFileSync } from "node:fs";

interface Node {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
  hitCount?: number;
}
const [file, topArg] = process.argv.slice(2);
const prof = JSON.parse(readFileSync(file!, "utf8")) as {
  nodes: Node[];
  samples: number[];
  timeDeltas: number[];
};
const top = Number(topArg ?? 25);
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const selfUs = new Map<number, number>();
prof.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) ?? 0) + (prof.timeDeltas[i] ?? 0)));
const label = (n: Node) => {
  const url = n.callFrame.url.replace(/^.*CanadianDefenceIntelligence[\\/]/, "");
  return `${n.callFrame.functionName || "(anonymous)"} ${url}:${n.callFrame.lineNumber + 1}`;
};
const inclusive = new Map<number, number>();
const total = (id: number): number => {
  if (inclusive.has(id)) return inclusive.get(id)!;
  const n = byId.get(id)!;
  const t = (selfUs.get(id) ?? 0) + (n.children ?? []).reduce((s, c) => s + total(c), 0);
  inclusive.set(id, t);
  return t;
};
prof.nodes.forEach((n) => total(n.id));
const agg = (m: Map<number, number>) => {
  const out = new Map<string, number>();
  for (const [id, us] of m) {
    const n = byId.get(id)!;
    if (
      !/pipeline|src[\\/]|bench/.test(n.callFrame.url) ||
      n.callFrame.url.includes("node_modules")
    )
      continue;
    const k = label(n);
    out.set(k, (out.get(k) ?? 0) + us);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
};
const ms = (us: number) => `${(us / 1000).toFixed(0).padStart(7)} ms`;
console.log("== self time (repository code)");
for (const [k, v] of agg(selfUs)) console.log(ms(v), k);
console.log("== inclusive time (repository code; recursive frames counted per call site)");
for (const [k, v] of agg(inclusive)) console.log(ms(v), k);
