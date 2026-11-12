/**
 * Bring-your-own-AI verification tasks (pipeline/research/clearance/tasks.ts).
 *
 *   npx tsx scripts/research/verify-tasks.ts make --cohort batch2 [--clearance <file>]
 *       writes research-cache/verify-tasks/<cohort>/outbox/T-<date>-<card>.md (paste-ready
 *       prompts), README.md and claude-worklist.md
 *   npx tsx scripts/research/verify-tasks.ts ingest --cohort batch2 --tool gemini <answer.md ...>
 *       validates each saved answer, files it as researcher R-<tool>-<date> in the cohort's
 *       returns folder (original kept), then run scripts/research/clearance.ts again
 *
 * Nothing is sent anywhere: the owner pastes the prompts and saves the answers.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import type { BlindCard } from "../../pipeline/research/blind";
import { loadResearchCorpus } from "../../pipeline/research/load";
import { buildTaskPackets, ingestAnswer } from "../../pipeline/research/clearance/tasks";
import type { ClearanceFile } from "../../pipeline/research/clearance/run";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const cohort = flag("cohort") ?? "batch2";
const cache = resolve(flag("cache") ?? "research-cache");
const today = flag("today") ?? new Date().toISOString().slice(0, 10);
const COHORTS: Record<string, { cards: string; share: string; returns: string }> = {
  batch1: {
    cards: "docs/verification/blind-v2-internal/cards.json",
    share: "docs/verification/blind-v2-share",
    returns: "blind-verification/returns",
  },
  batch2: {
    cards: "docs/verification/batch2/cards.json",
    share: "docs/verification/batch2-share",
    returns: "blind-verification/batch2/returns",
  },
  batch3: {
    cards: "docs/verification/batch3/cards.json",
    share: "docs/verification/batch3-share",
    returns: "blind-verification/batch3/returns",
  },
  batch4: {
    cards: "docs/verification/batch4/cards.json",
    share: "docs/verification/batch4-share",
    returns: "blind-verification/batch4/returns",
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
const base = join(cache, "verify-tasks", cohort);

if (command === "make") {
  const clearanceDir = join(cache, "clearance");
  const file =
    flag("clearance") ??
    readdirSync(clearanceDir)
      .filter((f) => f.startsWith(`clearance-${cohort}-`) && f.endsWith(".json"))
      .sort()
      .map((f) => join(clearanceDir, f))
      .at(-1);
  if (!file)
    throw new Error(`no clearance file for ${cohort}: run scripts/research/clearance.ts first`);
  const clearance = JSON.parse(readFileSync(file, "utf8")) as ClearanceFile;
  const cards = JSON.parse(readFileSync(resolve(c.cards), "utf8")) as BlindCard[];
  const loaded = loadResearchCorpus(resolve(flag("dir") ?? "research"));
  const slug = new Map((loaded.corpus?.organizations ?? []).map((o) => [o.id, o.slug]));
  const promptFor = (card: string) => {
    for (const p of [
      join(c.share, "chatgpt", `${card}.md`),
      join(c.share, "assignments", `${card}.md`),
    ])
      if (existsSync(p)) return readFileSync(p, "utf8");
    return null;
  };
  const { packets, claudeWork, missingPrompts } = buildTaskPackets(
    clearance,
    cards,
    promptFor,
    (id) => slug.get(id) ?? null,
    today,
  );
  mkdirSync(join(base, "outbox"), { recursive: true });
  mkdirSync(join(base, "inbox"), { recursive: true });
  for (const p of packets) writeFileSync(join(base, "outbox", p.file), p.text);
  writeFileSync(join(base, "claude-worklist.md"), claudeWork);
  writeFileSync(
    join(base, "README.md"),
    [
      `# Verification tasks for you to run in any AI (${cohort}, ${today})`,
      "",
      "Each file in `outbox/` is one complete prompt for one company. It contains no CANDEF findings (it is the leak-checked blind prompt with a short focus header).",
      "",
      "1. Open a **fresh chat with memory off** in any AI tool **other than Claude** (Claude is CANDEF's own researcher, so it cannot check itself). Good choices: a tool not already listed under 'Already researched by' below.",
      '2. Paste the **whole file**. If the tool asks questions, answer: "Follow the instructions in the prompt; research only the company on the card." Reply `continue` if the JSON stops partway.',
      "3. Copy the whole answer into a text file in `inbox/`, named like `T-...-B05__gemini.md` (task, two underscores, the tool's short name).",
      "4. Tell Claude, or run: `npx tsx scripts/research/verify-tasks.ts ingest --cohort " +
        cohort +
        " --tool <tool> inbox/<file>`.",
      "",
      "| Task | Card | Fields | Completeness | Already researched by |",
      "| --- | --- | --- | --- | --- |",
      ...packets.map(
        (p) =>
          `| ${p.taskId} | ${p.card} | ${p.fields.join(" ")} | ${p.inventory ? "yes" : "no"} | ${p.usedTools.join(", ") || "nobody"} |`,
      ),
      "",
      missingPrompts.length
        ? `No blind prompt exists yet for: ${missingPrompts.join(", ")} (generate them with blind-verification.ts package).`
        : "",
    ].join("\n"),
  );
  console.log(
    `${packets.length} task prompt(s) → ${join(base, "outbox")}; Claude worklist → ${join(base, "claude-worklist.md")}`,
  );
  if (missingPrompts.length) console.log(`no prompt for: ${missingPrompts.join(", ")}`);
} else if (command === "ingest") {
  const tool = flag("tool");
  // Positional arguments: everything after the command that is neither a flag nor a flag's value.
  const files = args
    .slice(1)
    .filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] ?? "").startsWith("--"));
  if (!tool || !files.length) {
    console.error("usage: ingest --cohort <c> --tool <name> <answer.md ...>");
    process.exit(1);
  }
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const expect = basename(f).match(/T-\d{8}-([A-Z]\d{2})/)?.[1] ?? null;
    const r = ingestAnswer(text, tool, today, expect);
    if (!r.ok) {
      console.log(`${basename(f)}: NOT INGESTED: ${r.errors.join("; ")}`);
      continue;
    }
    const dir = join(cache, c.returns, r.researcherId);
    mkdirSync(join(dir, "original"), { recursive: true });
    copyFileSync(f, join(dir, "original", basename(f)));
    writeFileSync(join(dir, `${r.researcherId}__${r.card}.json`), r.json!);
    console.log(
      `${basename(f)}: card ${r.card} → ${r.researcherId} (${r.findings} findings)${r.notes.length ? `; ${r.notes.join("; ")}` : ""}`,
    );
  }
  console.log("Next: npx tsx scripts/research/clearance.ts --cohort " + cohort);
} else {
  console.error("usage: verify-tasks.ts make | ingest");
  process.exit(1);
}
