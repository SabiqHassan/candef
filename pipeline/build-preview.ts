/**
 * LOCAL PREVIEW ONLY (docs/OVERNIGHT_2026-10-15.md task 7): what the site would show if every
 * proposed record were approved, with each claim labelled by its tier result ("Unverified draft …").
 *
 *   npm run preview:local        (this script, then `vite build --mode localpreview`)
 *
 * Guards, so the preview can never be deployed or shared:
 * - simulated approvals happen in memory (`approvedCorpus`); research/ is never written;
 * - the snapshot is flagged `meta.preview` and `isDemo`, and is written only under `.preview/`
 *   (gitignored; `publishSnapshot` refuses a preview anywhere else);
 * - `--audience share`, or any output folder outside `.preview/`, is refused here;
 * - the beta release checker refuses any snapshot with `meta.preview`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compile } from "./compile/compile";
import { publishSnapshot } from "./publish";
import { approvedCorpus } from "./research/blind";
import { loadResearchCorpus } from "./research/load";
import type { TierRecord } from "./research/tiers/rules";
import type { TiersFile } from "./research/tiers/run";

const args = process.argv.slice(2);
if (args.includes("--audience"))
  throw new Error(
    "the local preview has no audience option: a share build of simulated approvals is refused",
  );
const outIndex = args.indexOf("--out");
const outDir = resolve(
  outIndex >= 0 ? args[outIndex + 1]! : join(".preview", "public", "data", "research"),
);
if (!outDir.split(/[\\/]/).includes(".preview"))
  throw new Error(`refusing to write the preview outside .preview/: ${outDir}`);

const today = new Date().toISOString().slice(0, 10);
const tiersDir = join("research-cache", "tiers");
const tiersFile = existsSync(tiersDir)
  ? readdirSync(tiersDir)
      .filter((f) => /^tiers-.*\.json$/.test(f))
      .sort()
      .at(-1)
  : undefined;
if (!tiersFile) throw new Error("no tiers file: run `npm run candef -- tiers` first");
const tiers = JSON.parse(readFileSync(join(tiersDir, tiersFile), "utf8")) as TiersFile;

/** The label each claim carries in the preview (VERIFICATION_TIERS.md section 9, last row). */
export function draftLabel(r: TierRecord): string {
  const failed = r.rules.filter((x) => x.result === "fail").map((x) => x.rule);
  switch (r.status) {
    case "pass":
      return `Unverified draft. Passes the tier ${r.tier} checks; applied only with the owner's batch and audit.`;
    case "conditional":
      return "Unverified draft. Tier 1: matches the dataset; waits for the owner to approve the identity anchor.";
    case "judgement":
      return `Unverified draft. Needs the owner's judgement (${r.route}).`;
    case "exception":
      return `Unverified draft. Exception: failed ${failed.join(", ")}; not published unless the owner approves it after checking.`;
  }
}

const loaded = loadResearchCorpus("research");
if (!loaded.corpus) throw new Error("research/ does not validate");
const draftLabels = Object.fromEntries(tiers.records.map((r) => [r.id, draftLabel(r)]));
// Records proposed after the tiers file was written still get a label.
for (const r of [
  ...loaded.corpus.assertions,
  ...loaded.corpus.rounds,
  ...loaded.corpus.agreements,
  ...loaded.corpus.acquisitions,
])
  if (r.verification === "proposed" && !draftLabels[r.id])
    draftLabels[r.id] =
      "Unverified draft. Not yet evaluated by the tier checks (added after the last tiers run).";

// `--companies <cards.json>`: simulate approval only for these companies (plus contextual
// organizations such as departments, investors and foreign parents). Universe companies outside
// the list keep their records proposed, so they drop out of the preview.
const companiesIndex = args.indexOf("--companies");
let only: Set<string> | undefined;
if (companiesIndex >= 0) {
  const c = loaded.corpus;
  const cards = JSON.parse(readFileSync(resolve(args[companiesIndex + 1]!), "utf8")) as {
    orgSlugs: string[];
  }[];
  const chosen = new Set(
    cards
      .flatMap((k) => k.orgSlugs)
      .map((s) => {
        const o = c.organizations.find((x) => x.slug === s);
        if (!o) throw new Error(`--companies: unknown organization ${s}`);
        return o.id;
      }),
  );
  const included = (orgId: string) =>
    c.assertions.some(
      (a) =>
        a.subjectId === orgId &&
        a.predicate === "eligibility" &&
        (a.value as { decision?: string }).decision === "included",
    );
  const left = new Set(
    c.organizations.filter((o) => !chosen.has(o.id) && included(o.id)).map((o) => o.id),
  );
  only = new Set([
    ...c.assertions.filter((a) => !left.has(a.subjectId)).map((a) => a.id),
    ...c.rounds.filter((r) => chosen.has(r.companyId)).map((r) => r.id),
    ...c.agreements
      .filter((g) => g.parties.some((p) => p.orgId && chosen.has(p.orgId)))
      .map((g) => g.id),
    ...c.acquisitions
      .filter((q) => chosen.has(q.acquirerId) || chosen.has(q.targetId))
      .map((q) => q.id),
  ]);
  console.log(`preview limited to ${chosen.size} organizations from ${args[companiesIndex + 1]}`);
}

const result = compile(approvedCorpus(loaded.corpus, today, only), {
  today,
  thresholdCad: 100_000,
  draftLabels,
});
if (!result.snapshot) {
  for (const f of result.failures)
    console.error(`GATE FAILED [${f.gate}] ${f.message}: ${f.ids.slice(0, 6).join(", ")}`);
  process.exit(1);
}
if (!result.snapshot.meta.preview)
  throw new Error("internal: the preview snapshot must be flagged");
const published = publishSnapshot(outDir, result.snapshot);
console.log(
  `preview snapshot → ${outDir}/${published.file} (${result.snapshot.coverage.inUniverse} companies; tiers ${tiers.batch.slice(0, 12)})`,
);
