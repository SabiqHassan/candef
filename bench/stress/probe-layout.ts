// Cluster separation by scale: share of companies whose nearest other company is in another sector
// (0% = sectors perfectly separated) and in another subsector.
import { compile } from "../../pipeline/compile/compile";
import { generateStressCorpus } from "../../pipeline/synthetic/stress";
for (const n of (process.argv[2] ?? "380,3000,10000").split(",").map(Number)) {
  const s = compile(generateStressCorpus({ companies: n }).corpus, {
    today: "2026-10-13",
  }).snapshot!;
  const cos = s.organizations.filter(
    (o) => o.scope === "universe" && s.graph.positions[o.id] && o.segment.value,
  );
  const pts = cos.map((o) => ({
    p: s.graph.positions[o.id]!,
    sector: o.segment.value!.sectorId,
    sub: o.segment.value!.id,
  }));
  const sample = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 1500)) === 0);
  let otherSector = 0,
    otherSub = 0;
  for (const a of sample) {
    let best = Infinity,
      nb = a;
    for (const b of pts) {
      if (b === a) continue;
      const d = (a.p[0] - b.p[0]) ** 2 + (a.p[1] - b.p[1]) ** 2 + (a.p[2] - b.p[2]) ** 2;
      if (d < best) {
        best = d;
        nb = b;
      }
    }
    if (nb.sector !== a.sector) otherSector++;
    if (nb.sub !== a.sub) otherSub++;
  }
  console.log(
    JSON.stringify({
      companies: pts.length,
      nearestInOtherSectorPct: +((100 * otherSector) / sample.length).toFixed(1),
      nearestInOtherSubsectorPct: +((100 * otherSub) / sample.length).toFixed(1),
    }),
  );
}
