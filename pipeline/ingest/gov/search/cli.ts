/**
 * grant-search: a VC-style question in, specific grants out, each with a one-sentence reason once
 * judged. Leads only: output goes to research-cache/grant-search/ and nowhere else; nothing is
 * written under research/.
 *
 *   npm run grant-search -- candidates --query "first-time grants to drone companies" --id drones \
 *     --first-since 2022-01-01 --out research-cache/grant-search/<run>
 *   npm run grant-search -- candidates --queries queries.json --out research-cache/grant-search/<run>
 *   (judge <run>/<id>/to-judge.json by hand into <run>/<id>/judged.json)
 *   npm run grant-search -- report --out research-cache/grant-search/<run>
 */
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { assertTriageOutputDir } from "../leads/triage";
import { writeReviewOutputs } from "../output";
import {
  planQuery,
  searchGrants,
  type Candidate,
  type QueryResult,
  type QuerySpec,
} from "./search";
import { ManualJudge, TO_JUDGE, toJudgeFile, type Judgement } from "./judge";

/** Only research-cache/grant-search/<run> (or deeper); resolved through links. */
export async function assertSearchOutputDir(root: string, output: string): Promise<string> {
  const physical = await assertTriageOutputDir(root, output);
  const cache = await assertTriageOutputDir(root, "research-cache/grant-search/x");
  const base = resolve(cache, "..");
  const rel = relative(base, physical);
  if (!rel || rel.startsWith("..") || rel.split(sep)[0] === "..")
    throw new Error("--out must be inside research-cache/grant-search/");
  return physical;
}

const md = (s: string | null | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
const money = (v: string | null) =>
  v === null ? "original row absent" : `CA$${Number(v).toLocaleString("en-CA")}`;

export function candidatesMarkdown(r: QueryResult): string {
  const lines = [
    `# Grant search: ${md(r.query)}`,
    "",
    `Leads only, never evidence. Topics: ${r.topics.join(", ")}. Filters: \`${JSON.stringify(r.filters)}\`.`,
    `Matched ${r.counts.matched} agreements (${r.counts.titleMatches} in the title); ${r.counts.afterFilters} after filters; ${r.counts.shown} shown.`,
    "",
    "| # | Recipient (as stated) | Place | Department / programme | Title | Original value | Start | Recipient's first grant | Match | Row locator |",
    "| ---: | --- | --- | --- | --- | ---: | --- | --- | --- | --- |",
    ...r.candidates.map(
      (c) =>
        `| ${c.rank} | ${md(c.recipient)} | ${md([c.city, c.province, c.postalArea].filter(Boolean).join(", "))} | ${md(c.department)}: ${md(c.programme)} | ${md(c.title)} | ${money(c.originalValue)} | ${c.startDate ?? ""} | ${c.recipientFirstGrant ?? ""} | ${c.matchIn}: ${md(c.matchedTerms.join(", "))} | \`${c.locator}\` |`,
    ),
    "",
  ];
  return lines.join("\n");
}

export function resultsMarkdown(
  r: QueryResult,
  judged: Map<string, Judgement>,
): { markdown: string; precision: number | null; yes: number; unsure: number } {
  const of = (c: Candidate) => judged.get(c.key)!;
  const yes = r.candidates.filter((c) => of(c).match === "yes");
  const unsure = r.candidates.filter((c) => of(c).match === "unsure");
  const precision = r.candidates.length ? yes.length / r.candidates.length : null;
  const row = (c: Candidate) =>
    `| ${c.rank} | ${md(c.recipient)} | ${md([c.city, c.province].filter(Boolean).join(", "))} | ${md(c.title)} | ${money(c.originalValue)} | ${c.startDate ?? ""} | ${c.recipientFirstGrant ?? ""} | ${md(of(c).reason)} | \`${c.locator}\` |`;
  const head =
    "| # | Recipient (as stated) | Place | Title | Original value | Start | First grant | Why it matches | Row locator |\n| ---: | --- | --- | --- | ---: | --- | --- | --- | --- |";
  const markdown = [
    `# Grant search results: ${md(r.query)}`,
    "",
    "Leads only, never evidence; each needs a person to read the row and the company's own sources.",
    `Judged ${r.candidates.length}: ${yes.length} yes, ${unsure.length} unsure, ${r.candidates.length - yes.length - unsure.length} no. Precision ${precision === null ? "n/a" : `${Math.round(precision * 100)}%`}.`,
    "",
    "## Matches",
    "",
    head,
    ...yes.map(row),
    "",
    "## Unsure",
    "",
    head,
    ...unsure.map(row),
    "",
  ].join("\n");
  return { markdown, precision, yes: yes.length, unsure: unsure.length };
}

function specFromFlags(v: Record<string, string | boolean | undefined>): QuerySpec {
  const list = (s: unknown) =>
    typeof s === "string" && s.trim() ? s.split(",").map((x) => x.trim()) : undefined;
  const num = (s: unknown) => (typeof s === "string" && s !== "" ? Number(s) : undefined);
  return {
    id: (v.id as string) ?? "query",
    query: v.query as string,
    topics: list(v.topics),
    terms: list(v.terms),
    limit: num(v.limit),
    filters: {
      firstSince: v["first-since"] as string | undefined,
      startSince: v["start-since"] as string | undefined,
      provinces: list(v.province),
      department: v.department as string | undefined,
      programme: v.programme as string | undefined,
      minValue: num(v.min),
      maxValue: num(v.max),
    },
  };
}

export async function runGrantSearch(args: string[], root = process.cwd()): Promise<number> {
  const [command, ...rest] = args;
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      grants: { type: "string", default: "research-cache/gov-data/2026-10-13/grants.csv" },
      queries: { type: "string" },
      query: { type: "string" },
      id: { type: "string" },
      topics: { type: "string" },
      terms: { type: "string" },
      "first-since": { type: "string" },
      "start-since": { type: "string" },
      province: { type: "string" },
      department: { type: "string" },
      programme: { type: "string" },
      min: { type: "string" },
      max: { type: "string" },
      limit: { type: "string" },
    },
    strict: true,
  });
  if (!values.out || (command !== "candidates" && command !== "report")) {
    console.log(
      "grant-search candidates (--query text [--id x --topics a,b --terms t --first-since YYYY-MM-DD --start-since --province ON,QC --department re --programme re --min n --max n --limit n] | --queries file.json) --out research-cache/grant-search/<run>\ngrant-search report --out research-cache/grant-search/<run>   (reads <run>/<id>/judged.json)\nLeads only; writes only under research-cache/grant-search/.",
    );
    return command ? 1 : 0;
  }
  const out = await assertSearchOutputDir(root, values.out);
  await mkdir(out, { recursive: true });

  if (command === "candidates") {
    const specs: QuerySpec[] = values.queries
      ? (JSON.parse(await readFile(resolve(root, values.queries), "utf8")) as QuerySpec[])
      : [specFromFlags(values)];
    if (!specs.length || specs.some((s) => !s.query)) throw new Error("Every query needs text");
    if (new Set(specs.map((s) => s.id)).size !== specs.length)
      throw new Error("Duplicate query id");
    const plans = specs.map(planQuery);
    const { results, stats } = await searchGrants(
      createReadStream(resolve(root, values.grants)),
      plans,
    );
    for (const r of results) {
      const dir = join(out, r.id);
      await mkdir(dir, { recursive: true });
      await writeReviewOutputs(dir, {
        "candidates.json": JSON.stringify(r, null, 2) + "\n",
        "candidates.md": candidatesMarkdown(r),
        [TO_JUDGE]: JSON.stringify(toJudgeFile(r.query, r.candidates), null, 2) + "\n",
      });
    }
    await writeReviewOutputs(out, {
      "run.json":
        JSON.stringify(
          {
            format: "candef-grant-search-run",
            version: 1,
            grants: relative(root, resolve(root, values.grants)),
            stats,
            queries: results.map((r) => ({
              id: r.id,
              query: r.query,
              topics: r.topics,
              counts: r.counts,
            })),
          },
          null,
          2,
        ) + "\n",
    });
    console.log(JSON.stringify({ stats, counts: results.map((r) => [r.id, r.counts]) }));
    return 0;
  }

  // report: every query folder with a judged file.
  const summary: {
    id: string;
    query: string;
    judged: number;
    yes: number;
    unsure: number;
    precision: number | null;
  }[] = [];
  for (const id of readdirSync(out).sort()) {
    const dir = join(out, id);
    if (!existsSync(join(dir, "candidates.json")) || !existsSync(join(dir, "judged.json")))
      continue;
    const r = JSON.parse(await readFile(join(dir, "candidates.json"), "utf8")) as QueryResult;
    const judged = await new ManualJudge(dir).judge(r.query, r.candidates);
    const res = resultsMarkdown(r, judged);
    await writeReviewOutputs(dir, {
      "results.json":
        JSON.stringify(
          {
            query: r.query,
            judge: "manual",
            precision: res.precision,
            results: r.candidates.map((c) => ({ ...c, judgement: judged.get(c.key) })),
          },
          null,
          2,
        ) + "\n",
      "results.md": res.markdown,
    });
    summary.push({
      id,
      query: r.query,
      judged: r.candidates.length,
      yes: res.yes,
      unsure: res.unsure,
      precision: res.precision,
    });
  }
  await writeReviewOutputs(out, { "summary.json": JSON.stringify(summary, null, 2) + "\n" });
  console.log(JSON.stringify(summary));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runGrantSearch(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`grant-search: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
