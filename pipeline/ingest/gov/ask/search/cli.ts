/**
 * Leads search command line. Reads the lead index built by `npm run grant-ask -- index`; makes no
 * network call, except `ask`, which calls a model provider and refuses without a key.
 *
 *   npm run leads -- search [--text "drone"] [--tags uas_drones,space] [--tiers A,B] [--provinces QC,atlantic]
 *        [--first-seen-after 2022] [--first-grant-after 2022] [--first-time] [--max-total-value 100000]
 *        [--departments "National Defence"] [--programmes IDEaS] [--programme-since 2023] [--categories radar,ammunition]
 *        [--limit 20] [--json | --md]
 *   npm run leads -- get <company key> [--json | --md]   (write "~" for "|" in keys on Windows)
 *   npm run leads -- tools                     JSON tool schemas (API mode)
 *   npm run leads -- render <answer.json>      check an answer's citations and write <answer>.md
 *   npm run leads -- ask "<question>"          API mode (needs a key; see docs/LEADS_SEARCH.md)
 */
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { answerMd, cardMd, money } from "./card";
import { checkAnswerCitations, defaultPaths, getCompany, LeadStore, searchLeads } from "./index";
import { Answer, SearchQuery } from "./schema";
import { toolDefs } from "./tools";

const list = (s: string | undefined) =>
  s
    ? s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    : undefined;

export function queryFromFlags(
  v: Record<string, string | boolean | undefined>,
): z.input<typeof SearchQuery> {
  const q: Record<string, unknown> = {};
  const s = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  if (s("text")) q.text = s("text");
  if (s("tags")) q.tags = list(s("tags"));
  if (s("tiers")) q.tiers = list(s("tiers"));
  if (s("provinces")) q.provinces = list(s("provinces"));
  if (s("first-seen-after")) q.firstSeenAfter = s("first-seen-after");
  if (s("first-grant-after")) q.firstGrantAfter = s("first-grant-after");
  if (v["first-time"] === true) q.firstTimeGrantRecipient = true;
  if (s("max-total-value")) q.maxTotalValue = Number(s("max-total-value"));
  if (s("departments")) q.departments = list(s("departments"));
  if (s("programmes")) q.programmes = list(s("programmes"));
  if (s("categories")) q.categories = list(s("categories"));
  if (s("programme-since")) q.programmeSince = s("programme-since");
  if (s("limit")) q.limit = Number(s("limit"));
  return q as z.input<typeof SearchQuery>;
}

export async function main(
  argv: string[],
  root = process.cwd(),
  out: (s: string) => void = (s) => console.log(s),
): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values: v, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      text: { type: "string" },
      tags: { type: "string" },
      tiers: { type: "string" },
      provinces: { type: "string" },
      "first-seen-after": { type: "string" },
      "first-grant-after": { type: "string" },
      "first-time": { type: "boolean", default: false },
      "max-total-value": { type: "string" },
      departments: { type: "string" },
      programmes: { type: "string" },
      categories: { type: "string" },
      "programme-since": { type: "string" },
      limit: { type: "string" },
      json: { type: "boolean", default: false },
      md: { type: "boolean", default: false },
      config: { type: "string" },
      out: { type: "string" },
    },
  });
  const store = new LeadStore(defaultPaths(root));

  if (cmd === "tools") {
    out(JSON.stringify(toolDefs(), null, 2));
    return 0;
  }
  if (cmd === "search") {
    const r = await searchLeads(store, queryFromFlags(v));
    if (v.json) out(JSON.stringify(r, null, 2));
    else if (v.md)
      out(
        [`${r.total} matches, showing ${r.cards.length}`, "", ...r.cards.map(cardMd)].join("\n\n"),
      );
    else {
      out(`${r.total} matches, showing ${r.cards.length}`);
      r.cards.forEach((c, i) => {
        const tot = c.totals.grantValue + c.totals.contractValue;
        out(
          `${String(i + 1).padStart(2)}. [${c.tier}] ${c.name} | ${c.location} | first seen ${c.firstSeen ?? "?"} | ${money(tot)} | ${c.tags.slice(0, 4).join(",")} | score ${c.score}\n    key ${c.key}${c.matchedOn.length ? ` | matched: ${[...new Set(c.matchedOn.flatMap((m) => m.terms))].slice(0, 6).join(",")}` : ""}`,
        );
      });
    }
    return 0;
  }
  if (cmd === "get") {
    const key = positionals[0];
    if (!key) throw new Error("usage: get <company key>");
    // On Windows a "|" in a key is eaten by npm.cmd, so "~" is accepted in its place.
    const c = (await getCompany(store, key)) ?? (await getCompany(store, key.replaceAll("~", "|")));
    if (!c) {
      out(`no company with key ${key}`);
      return 1;
    }
    if (v.md) out(cardMd(c.card));
    else out(JSON.stringify(v.json ? c : { card: c.card, lines: c.lines }, null, 2));
    return 0;
  }
  if (cmd === "render") {
    const file = positionals[0];
    if (!file) throw new Error("usage: render <answer.json>");
    const parsed = Answer.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) {
      out(`answer does not match the Answer shape:\n${z.prettifyError(parsed.error)}`);
      return 1;
    }
    const problems = await checkAnswerCitations(store, parsed.data);
    if (problems.length) {
      out(`citation problems:\n- ${problems.join("\n- ")}`);
      return 1;
    }
    const target = v.out ?? file.replace(/\.json$/i, ".md");
    await writeFile(target, answerMd(parsed.data));
    out(
      `ok: ${parsed.data.leads.length} leads, citations checked against the stored rows; wrote ${target}`,
    );
    return 0;
  }
  if (cmd === "ask") {
    const question = positionals.join(" ").trim();
    if (!question) throw new Error('usage: ask "<question>"');
    const { askCommand } = await import("./askCommand");
    return askCommand(store, root, question, v.config, out);
  }
  throw new Error("commands: search, get, tools, render, ask");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
