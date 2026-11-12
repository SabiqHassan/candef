import { compile } from "../../pipeline/compile/compile";
import { generateStressCorpus } from "../../pipeline/synthetic/stress";
const n = Number(process.argv[2] ?? 1000);
const t0 = performance.now();
const { corpus, manifest } = generateStressCorpus({ companies: n });
const t1 = performance.now();
const r = compile(corpus, { today: "2026-10-13" });
const t2 = performance.now();
console.log({
  ok: r.ok,
  failures: r.failures.map((f) => `${f.gate}: ${f.message} ${f.ids.slice(0, 3)}`),
  warnings: r.warnings.slice(0, 5),
});
const s = r.snapshot!;
const ids = new Set([
  ...Object.keys(s.assertions),
  ...s.rounds.map((x) => x.id),
  ...s.agreements.map((x) => x.id),
]);
console.log({
  genMs: Math.round(t1 - t0),
  compileMs: Math.round(t2 - t1),
  orgs: s.organizations.length,
  universe: s.coverage.inUniverse,
  leaked: manifest.unpublishable.filter((i) => ids.has(i)).length,
  unpublishable: manifest.unpublishable.length,
  renamed: manifest.renamed.length,
  twins: manifest.twins.length,
  disputed: manifest.disputedHq.length,
  other: manifest.otherTransfers.length,
  hubPortfolio: new Set(
    s.rounds
      .filter((x) => x.participants.some((p) => p.investorId === manifest.hubInvestor))
      .map((x) => x.companyId),
  ).size,
  hubAgreements: s.agreements.filter((g) =>
    g.parties.some((p) => p.orgId === manifest.hubDepartment),
  ).length,
  jsonMB: +(JSON.stringify(s).length / 1e6).toFixed(1),
});
