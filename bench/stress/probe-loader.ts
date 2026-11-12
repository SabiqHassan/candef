/**
 * Research-loader scale probe: writes the SYNTHETIC stress corpus as a research folder (YAML, one
 * file per organization and per source) under the gitignored `.stress/research/`, then times what
 * `candef validate` does: load, gates, compile. Everything is written `proposed` with no review, as
 * agent-written research is. The fixture gate must refuse it (fictional URLs): that is checked too.
 *
 *   npx tsx bench/stress/probe-loader.ts 3000
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { compile } from "../../pipeline/compile/compile";
import { researchBuildGates } from "../../pipeline/research/gates";
import { loadResearchCorpus } from "../../pipeline/research/load";
import { generateStressCorpus } from "../../pipeline/synthetic/stress";

const n = Number(process.argv[2] ?? 3000);
const root = join(process.cwd(), ".stress", "research");
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "orgs"), { recursive: true });
mkdirSync(join(root, "sources"), { recursive: true });

const { corpus } = generateStressCorpus({ companies: n });
const unreviewed = <T extends { review: unknown; verification: string }>(r: T): T => ({
  ...r,
  review: null,
  verification: r.verification === "verified" ? "proposed" : r.verification,
});
const t0 = performance.now();
writeFileSync(join(root, "taxonomy.yaml"), stringify(corpus.taxonomy));
writeFileSync(join(root, "programs.yaml"), stringify(corpus.programs));
for (const s of corpus.sources) writeFileSync(join(root, "sources", `${s.id}.yaml`), stringify(s));
const firstCompanyParty = (parties: { orgId: string; role: string }[]) =>
  parties.find((p) => ["prime", "recipient", "member", "partner"].includes(p.role))?.orgId;
let bytes = 0;
for (const o of corpus.organizations) {
  const { isDemo: _demo, ...org } = o;
  void _demo;
  const doc = {
    org,
    facts: corpus.assertions
      .filter((a) => a.subjectId === o.id)
      .map((a) => {
        const { subjectId: _s, ...rest } = unreviewed(a);
        void _s;
        return rest;
      }),
    rounds: corpus.rounds
      .filter((r) => r.companyId === o.id)
      .map((r) => {
        const { companyId: _c, ...rest } = unreviewed(r);
        void _c;
        return {
          ...rest,
          disclosures: r.disclosures.map(unreviewed),
          participations: r.participations.map(unreviewed),
        };
      }),
    agreements: corpus.agreements
      .filter((g) => firstCompanyParty(g.parties) === o.id)
      .map(unreviewed),
    research: corpus.research
      .filter((x) => x.subjectId === o.id)
      .map((x) => {
        const { subjectId: _s, id: _i, ...rest } = x;
        void _s;
        void _i;
        return rest;
      }),
  };
  const text = stringify(doc);
  bytes += text.length;
  writeFileSync(join(root, "orgs", `${o.slug}.yaml`), text);
}
const t1 = performance.now();
const loaded = loadResearchCorpus(root);
const t2 = performance.now();
const gates = loaded.corpus ? researchBuildGates(loaded.corpus) : [];
const t3 = performance.now();
const compiled = loaded.corpus ? compile(loaded.corpus, { today: "2026-10-13" }) : null;
const t4 = performance.now();
console.log(
  JSON.stringify({
    companies: n,
    files: loaded.files,
    yamlMB: +(bytes / 1e6).toFixed(1),
    writeMs: Math.round(t1 - t0),
    loadMs: Math.round(t2 - t1),
    gatesMs: Math.round(t3 - t2),
    compileMs: Math.round(t4 - t3),
    loadIssues: loaded.issues.length,
    firstIssues: loaded.issues.slice(0, 3).map((i) => `${i.file}:${i.path}: ${i.message}`),
    fixtureGateRefused: gates.some((g) => g.gate === "no-fixture-data"),
    publishedCompanies: compiled?.snapshot?.coverage.inUniverse ?? null,
  }),
);
