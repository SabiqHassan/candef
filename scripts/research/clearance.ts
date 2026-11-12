/**
 * Runs the draft clearance policy over one cohort (read-only on research/).
 *
 *   npx tsx scripts/research/clearance.ts --cohort batch2 [--dir research] [--cache research-cache]
 *     [--skip-gov-rows] [--out research-cache/clearance] [--label name]
 *
 * Cohorts: batch1 (docs/verification/blind-v2-internal), batch2 (docs/verification/batch2),
 * batch3 (docs/verification/batch3), batch4 (docs/verification/batch4), any batchN, and radar
 * (docs/verification/radar: only the records listed in its records.json, P-68). Writes
 * clearance-<label>-<date>.{json,md} and queue-<label>-<date>.html. Nothing is approved, decided or published.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadResearchCorpus } from "../../pipeline/research/load";
import type { BlindCard } from "../../pipeline/research/blind";
import { clearanceMarkdown, runClearance } from "../../pipeline/research/clearance/run";
import { buildQueue } from "../../pipeline/research/clearance/queue";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const cohort = flag("cohort") ?? "batch2";
const COHORTS: Record<
  string,
  { cards: string; independence: string; returns: string; records?: string }
> = {
  batch1: {
    cards: "docs/verification/blind-v2-internal/cards.json",
    independence: "docs/verification/blind-v2-internal/independence.json",
    returns: "blind-verification/returns",
  },
  batch2: {
    cards: "docs/verification/batch2/cards.json",
    independence: "docs/verification/batch2/independence.json",
    returns: "blind-verification/batch2/returns",
  },
  batch3: {
    cards: "docs/verification/batch3/cards.json",
    independence: "docs/verification/batch3/independence.json",
    returns: "blind-verification/batch3/returns",
  },
  batch4: {
    cards: "docs/verification/batch4/cards.json",
    independence: "docs/verification/batch4/independence.json",
    returns: "blind-verification/batch4/returns",
  },
  // Rounds radar (P-68): new rounds only, listed by `scripts/research/radar.ts cohort --add`.
  radar: {
    cards: "docs/verification/radar/cards.json",
    independence: "docs/verification/radar/independence.json",
    returns: "blind-verification/radar/returns",
    records: "docs/verification/radar/records.json",
  },
};
const c =
  COHORTS[cohort] ??
  (/^batch\d+$/.test(cohort)
    ? {
        cards: `docs/verification/${cohort}/cards.json`,
        independence: `docs/verification/${cohort}/independence.json`,
        share: `docs/verification/${cohort}-share`,
        returns: `blind-verification/${cohort}/returns`,
      }
    : undefined);
if (!c) throw new Error(`unknown cohort ${cohort}`);
const dir = resolve(flag("dir") ?? "research");
const cache = resolve(flag("cache") ?? "research-cache");
const today = flag("today") ?? new Date().toISOString().slice(0, 10);
const label = flag("label") ?? cohort;
const out = resolve(flag("out") ?? join(cache, "clearance"));

const loaded = loadResearchCorpus(dir);
if (!loaded.corpus) throw new Error("research does not validate");
const cards = JSON.parse(readFileSync(resolve(c.cards), "utf8")) as BlindCard[];
const recordsFile = "records" in c && c.records ? resolve(c.records) : null;
const recordIds =
  recordsFile && existsSync(recordsFile)
    ? (JSON.parse(readFileSync(recordsFile, "utf8")) as { recordIds: string[] }).recordIds
    : null;
if (recordIds && recordIds.length === 0) throw new Error(`no records listed in ${recordsFile}`);
const file = await runClearance(loaded.corpus, {
  cacheDir: cache,
  today,
  cards,
  returnsDir: join(cache, c.returns),
  independenceFile: existsSync(resolve(c.independence)) ? resolve(c.independence) : null,
  planFile: flag("plan") ?? join(cache, "gov-linkage", "plan-post", "migration.json"),
  skipGovRows: args.includes("--skip-gov-rows"),
  ladderFile: join(out, "ladder.json"),
  cardsFile: resolve(c.cards),
  recordIds,
});
mkdirSync(out, { recursive: true });
const base = join(out, `clearance-${label}-${today}`);
file.fileName = `clearance-${label}-${today}.json`;
writeFileSync(`${base}.json`, JSON.stringify(file, null, 2));
writeFileSync(`${base}.md`, clearanceMarkdown(file));
writeFileSync(join(out, `queue-${label}-${today}.html`), buildQueue(file, loaded.corpus));
console.log(`clearance → ${base}.json (.md); queue → ${join(out, `queue-${label}-${today}.html`)}`);
console.log(JSON.stringify(file.workload));
console.log(JSON.stringify(file.counts));
