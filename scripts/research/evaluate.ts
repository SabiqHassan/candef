/**
 * Records Claude's primary-source evaluations of blind-verification claims
 * (docs/verification/blind-v2-internal/RECONCILIATION_PLAN.md section 5.3) in the gitignored
 * research-cache/blind-verification/evaluations.json, bound to each claim's CURRENT value hash.
 *
 *   npx tsx scripts/research/evaluate.ts rows <card> [--signal s] [--field F]   list claims to evaluate
 *   npx tsx scripts/research/evaluate.ts add <file.json>                           merge evaluations
 *   npx tsx scripts/research/evaluate.ts summary                                    counts by outcome
 *
 * The input file is an array of { claimId, outcome, note, sourcesRead?, basis?, proposal? }. Notes are
 * in Claude's words (no quotations). Nothing in research/ is changed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildInventory,
  Evaluation,
  EvaluationsFile,
  type BlindCard,
  type Worksheet,
} from "../../pipeline/research/blind";
import { loadResearchCorpus } from "../../pipeline/research/load";

const CACHE = join("research-cache", "blind-verification");
const FILE = join(CACHE, "evaluations.json");
const cards = JSON.parse(
  readFileSync("docs/verification/blind-v2-internal/cards.json", "utf8"),
) as BlindCard[];
const today = new Date().toISOString().slice(0, 10);

const load = (): EvaluationsFile =>
  existsSync(FILE)
    ? EvaluationsFile.parse(JSON.parse(readFileSync(FILE, "utf8")))
    : { version: 1, evaluations: {} };
const inventory = () => buildInventory(loadResearchCorpus("research").corpus!, cards, today);
const worksheet = (): Worksheet => {
  const f = readdirSync(CACHE)
    .filter((x) => /^worksheet-.*\.json$/.test(x))
    .sort()
    .at(-1)!;
  return JSON.parse(readFileSync(join(CACHE, f), "utf8")) as Worksheet;
};

const [cmd, arg] = process.argv.slice(2);
const flag = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (cmd === "rows") {
  const inv = new Map(inventory().items.map((i) => [i.claimId, i]));
  const done = load().evaluations;
  for (const r of worksheet().rows.filter(
    (x) =>
      x.card === arg &&
      (!flag("signal") || x.signal === flag("signal")) &&
      (!flag("field") || x.fieldId === flag("field")),
  )) {
    const cur = inv.get(r.claimId);
    const ev = done[r.claimId];
    const origins = [
      ...new Set(r.candidates.filter((c) => c.usable && c.independent).flatMap((c) => c.origins)),
    ];
    console.log(
      `${r.claimId} [${r.kind}/${r.signal}${cur && cur.valueHash !== r.valueHash ? "/CHANGED" : ""}${ev ? `/${ev.outcome}` : ""}] ${r.label}: ${r.value.slice(0, 150)}${origins.length ? ` | indep: ${origins.slice(0, 4).join(", ")}` : ""}`,
    );
  }
} else if (cmd === "add") {
  const input = JSON.parse(readFileSync(arg!, "utf8")) as (Partial<Evaluation> & {
    claimId: string;
  })[];
  const inv = new Map(inventory().items.map((i) => [i.claimId, i]));
  // A claim the evaluation itself made obsolete (an absence replaced by a new record) keeps the
  // worksheet's value hash: it documents the outcome for that worksheet.
  const ws = new Map(worksheet().rows.map((r) => [r.claimId, r]));
  const file = load();
  let n = 0;
  for (const e of input) {
    const item = inv.get(e.claimId) ?? ws.get(e.claimId);
    if (!item) throw new Error(`unknown claim ${e.claimId}`);
    file.evaluations[e.claimId] = Evaluation.parse({
      sourcesRead: [],
      ...e,
      valueHash: item.valueHash,
      at: today,
    });
    n++;
  }
  writeFileSync(FILE, JSON.stringify(file, null, 2));
  console.log(`${n} evaluation(s) recorded; ${Object.keys(file.evaluations).length} in total`);
} else if (cmd === "summary") {
  const inv = inventory();
  const ev = load().evaluations;
  const by: Record<string, Record<string, number>> = {};
  for (const it of inv.items) {
    const e = ev[it.claimId];
    const o = !e ? "not_yet_evaluated" : e.valueHash !== it.valueHash ? "stale" : e.outcome;
    by[it.card] ??= {};
    by[it.card]![o] = (by[it.card]![o] ?? 0) + 1;
  }
  console.log(JSON.stringify(by, null, 1));
} else {
  console.error("usage: evaluate.ts rows <card> | add <file.json> | summary");
  process.exit(1);
}
