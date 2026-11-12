/**
 * Rounds radar (P-68, docs/RADAR.md). Leads only: the sweep never writes to research/.
 *
 *   npx tsx scripts/research/radar.ts sweep [--since YYYY-MM-DD] [--until YYYY-MM-DD]
 *       [--only sec-form-d,gc-news] [--max-sec 2500] [--max-pages 150] [--dry-run]
 *       [--federal-index <leads.jsonl>] [--dir research] [--cache research-cache]
 *   npx tsx scripts/research/radar.ts status
 *   npx tsx scripts/research/radar.ts cohort [--add <recordId> ...] [--sync]
 *
 * sweep  reads the enabled sources since the last sweep and writes
 *        research-cache/radar/<stamp>/leads.{json,md}.
 * status prints the last sweeps and where the next one starts.
 * cohort manages docs/verification/radar/{cards,records}.json, the owner's radar review queue:
 *        --add lists new proposed records (rounds) for the queue; --sync drops records that are no
 *        longer proposed (decided by the owner) and cards left without records. Then run
 *        `npx tsx scripts/research/clearance.ts --cohort radar`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadResearchCorpus } from "../../pipeline/research/load";
import type { BlindCard } from "../../pipeline/research/blind";
import { addDays, loadState, sweep } from "../../pipeline/research/radar/sweep";

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = resolve(flag("dir") ?? "research");
const cache = resolve(flag("cache") ?? "research-cache");
// Local calendar date (an evening sweep in Canada is already "tomorrow" in UTC).
const today = flag("today") ?? new Date().toLocaleDateString("en-CA");

const COHORT_DIR = resolve("docs/verification/radar");
const CARDS = resolve(COHORT_DIR, "cards.json");
const RECORDS = resolve(COHORT_DIR, "records.json");

/** Default lead index: the shared cache, then the grant-ask worktree next to this one. */
function defaultFederalIndex(): string | null {
  const candidates = [
    resolve(cache, "grant-ask/index/leads.jsonl"),
    resolve("../candef-wt-ask/research-cache/grant-ask/index/leads.jsonl"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function corpusOrThrow() {
  const loaded = loadResearchCorpus(dir);
  if (!loaded.corpus) throw new Error("research/ does not validate; run `candef validate` first");
  return loaded.corpus;
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

async function main(): Promise<number> {
  if (command === "sweep") {
    const corpus = corpusOrThrow();
    const federalIndexFile = flag("federal-index") ?? defaultFederalIndex();
    const result = await sweep({
      corpus,
      cacheDir: cache,
      today,
      since: flag("since"),
      until: flag("until"),
      only: flag("only")?.split(","),
      maxSecRequests: flag("max-sec") ? Number(flag("max-sec")) : undefined,
      maxPages: flag("max-pages") ? Number(flag("max-pages")) : undefined,
      federalIndexFile,
      dryRun: args.includes("--dry-run"),
      log: (m) => console.log(m),
    });
    const count = (rel: string, kind?: string) =>
      result.leads.filter((l) => l.relevance === rel && (!kind || l.kind === kind)).length;
    console.log(
      `\nLeads: ${count("existing", "private_round")} round(s) at CANDEF companies, ${count("existing") - count("existing", "private_round")} announcement(s) naming CANDEF companies, ${count("candidate", "private_round")} new Canadian filer(s), ${count("candidate") - count("candidate", "private_round")} in-scope announcement(s). ${result.stats.requests} requests.`,
    );
    if (!federalIndexFile)
      console.log("(No federal lead index found: new filers are not checked for federal rows.)");
    console.log(
      result.dir ? `Lead list: ${resolve(result.dir, "leads.md")}` : "(dry run: nothing written)",
    );
    return 0;
  }

  if (command === "status") {
    const s = loadState(cache);
    console.log(
      `Form D: last complete index day ${s.sec.lastCompleteDate ?? "none"}; next sweep starts ${s.sec.lastCompleteDate ? addDays(s.sec.lastCompleteDate, 1) : "7 days back"}.`,
    );
    console.log(`Government news: last read ${s.gcnews.lastRunDate ?? "never"}.`);
    console.log(
      `Filers cached: ${Object.keys(s.sec.ciks).length}; filings seen: ${s.sec.seen.length}.`,
    );
    for (const w of s.sweeps.slice(-5))
      console.log(`  ${w.at}: ${w.leads} lead(s) (${w.since} to ${w.until}) -> ${w.dir}`);
    return 0;
  }

  if (command === "cohort") {
    const corpus = corpusOrThrow();
    const cards: BlindCard[] = existsSync(CARDS) ? JSON.parse(readFileSync(CARDS, "utf8")) : [];
    const records: { note?: string; recordIds: string[] } = existsSync(RECORDS)
      ? JSON.parse(readFileSync(RECORDS, "utf8"))
      : { recordIds: [] };
    // Record id -> owning organization and state (rounds, assertions, agreements).
    const owner = new Map<string, { orgId: string; verification: string }>();
    for (const r of corpus.rounds)
      owner.set(r.id, { orgId: r.companyId, verification: r.verification });
    for (const a of corpus.assertions)
      owner.set(a.id, { orgId: a.subjectId, verification: a.verification });
    const slugOf = new Map(corpus.organizations.map((o) => [o.id, o]));
    const add = args.includes("--add")
      ? args.slice(args.indexOf("--add") + 1).filter((a) => !a.startsWith("--"))
      : [];
    for (const id of add) {
      const rec = owner.get(id);
      if (!rec) throw new Error(`unknown record ${id}`);
      if (rec.verification !== "proposed")
        throw new Error(`${id} is ${rec.verification}, not proposed`);
      if (!records.recordIds.includes(id)) records.recordIds.push(id);
    }
    let dropped: string[] = [];
    if (args.includes("--sync")) {
      dropped = records.recordIds.filter((id) => owner.get(id)?.verification !== "proposed");
      records.recordIds = records.recordIds.filter((id) => !dropped.includes(id));
    }
    // One card per organization that still has a listed record.
    const orgIds = [...new Set(records.recordIds.map((id) => owner.get(id)!.orgId))];
    let last = Math.max(0, ...cards.map((c) => Number(/^R(\d+)/.exec(c.card)?.[1] ?? 0)));
    const next: BlindCard[] = orgIds.map((orgId) => {
      const org = slugOf.get(orgId)!;
      const prev = cards.find((c) => c.orgSlugs.includes(org.slug));
      return (
        prev ?? {
          card: `R${String(++last).padStart(2, "0")}-${org.slug}`,
          name: org.name,
          website: "(radar cohort: new records only)",
          orgSlugs: [org.slug],
        }
      );
    });
    if (add.length || args.includes("--sync")) {
      writeJson(CARDS, next);
      writeJson(RECORDS, {
        note:
          records.note ??
          "Rounds radar review list (P-68): proposed records added by radar runs, shown in the radar queue (clearance --cohort radar). Managed by scripts/research/radar.ts cohort.",
        recordIds: records.recordIds,
      });
      if (!existsSync(resolve(COHORT_DIR, "independence.json")))
        writeJson(resolve(COHORT_DIR, "independence.json"), {
          note: "No blind researchers for the radar cohort: rounds are checked at their primary sources.",
          reviewed: "not applicable",
          exposed: [],
        });
    }
    console.log(
      `Radar review list: ${records.recordIds.length} record(s) across ${next.length} compan(ies).`,
    );
    if (dropped.length) console.log(`Dropped (no longer proposed): ${dropped.join(", ")}`);
    for (const c of next) console.log(`  ${c.card}: ${c.name}`);
    return 0;
  }

  console.error("usage: radar.ts sweep | status | cohort [--add <recordId> ...] [--sync]");
  return 1;
}

process.exitCode = await main();
