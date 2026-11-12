/**
 * Blind independent verification, version 2 (docs/verification/blind-v2-internal/RECONCILIATION_PLAN.md).
 *
 *   npx tsx scripts/research/blind-verification.ts package     # shareable prompts + schema + template, then leak check
 *   npx tsx scripts/research/blind-verification.ts inventory   # PRIVATE inventory -> research-cache/blind-verification/
 *   npx tsx scripts/research/blind-verification.ts worksheet   # validate returns, align with the inventory
 *
 * Read-only on research/: nothing here approves, edits or publishes a record. The private inventory
 * and worksheets go to the gitignored research-cache/ (they hold research values and, once returns
 * arrive, researchers' short quotes); only the shareable package is written under docs/.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { format, resolveConfig } from "prettier";
import { parse } from "yaml";
import { z } from "zod";
import { loadResearchCorpus } from "../../pipeline/research/load";
import {
  applyEvaluations,
  EvaluationsFile,
  type BlindCard,
  type Inventory,
  buildInventory,
  buildWorksheet,
  leakCheck,
  intakePackage,
  ResearcherPackage,
} from "../../pipeline/research/blind";
import { BLIND_FIELDS, CATEGORIES } from "../../pipeline/research/blindFields";
import { looksStripped, repairStripped, vocabularyOf } from "../../pipeline/research/blindRepair";

const root = process.cwd();
const SHARE = join(root, "docs", "verification", "blind-v2-share");
const INTERNAL = join(root, "docs", "verification", "blind-v2-internal");
const today = new Date().toISOString().slice(0, 10);

// `--cohort batchN` (N from 2) switches every command to that cohort (docs/verification/<cohort>/cards.json);
// its prompts go to docs/verification/<cohort>-share, its returns, inventory and evaluations to
// research-cache/blind-verification/<cohort> and its exposure list to <cohort>/independence.json. The
// worksheet is written next to the first cohort's (suffix -<cohort>) so `candef tiers` finds it.
// Without the flag: the first 10 (blind v2).
type Cohort = `batch${number}`;
const isCohort = (c: string | undefined): c is Cohort => /^batch([2-9]|[1-9]\d+)$/.test(c ?? "");
const cohortAt = process.argv.indexOf("--cohort");
const cohortArg = cohortAt >= 0 ? process.argv[cohortAt + 1] : undefined;
if (cohortAt >= 0 && !isCohort(cohortArg)) {
  console.error("--cohort must look like batch2, batch3, batch5, ...");
  process.exit(1);
}
const COHORT = cohortAt >= 0 ? (cohortArg as Cohort) : null;
const COHORT_NUMBER = COHORT ? COHORT.slice("batch".length) : "";
const CACHE_ROOT = join(root, "research-cache", "blind-verification");
const CACHE = COHORT ? join(CACHE_ROOT, COHORT) : CACHE_ROOT;
const RETURNS = join(CACHE, "returns");
const INDEPENDENCE = COHORT
  ? join(root, "docs", "verification", COHORT, "independence.json")
  : join(INTERNAL, "independence.json");
const WORKSHEET = `worksheet-${today}${COHORT ? `-${COHORT}` : ""}`;
const COHORT_SHARE = join(root, "docs", "verification", `${COHORT ?? "none"}-share`);
const cards = JSON.parse(
  readFileSync(
    COHORT
      ? join(root, "docs", "verification", COHORT, "cards.json")
      : join(INTERNAL, "cards.json"),
    "utf8",
  ),
) as BlindCard[];

function loadCorpus() {
  const loaded = loadResearchCorpus(join(root, "research"));
  if (!loaded.corpus) {
    console.error("research/ does not load; run `npm run candef -- validate`.");
    process.exit(1);
  }
  return loaded.corpus;
}

const write = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
};
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

// ---- Shareable package --------------------------------------------------------------------------

function cardBlock(c: BlindCard): string {
  return [
    `### Card ${c.card}`,
    "",
    `- **Name to research:** ${c.name}`,
    `- **Website:** ${c.website}`,
    "- **Scope:** research the business operated under this name and website. Identify every legal entity of its corporate group that appears in the evidence (operating company, parent, subsidiaries, divisions, predecessors) and attribute each finding to the specific entity. The name and website are given only to identify the business; they are not claims to verify or to rely on.",
  ].join("\n");
}

function fieldInventory(only?: ReadonlySet<string>): string {
  const out = [
    "## 9. Field inventory",
    "",
    only
      ? `Research the fields listed below (your focus: see the run instructions). For every field ID not listed here (${BLIND_FIELDS.filter(
          (f) => !only.has(f.id),
        )
          .map((f) => f.id)
          .join(
            ", ",
          )}), add exactly one finding with status \`not_researched\` and notes "outside round-2 focus". 'Shown in CANDEF' says where the product uses a field; 'Status' says whether CANDEF shows it today.`
      : "Research every field. 'Shown in CANDEF' says where the product uses it; 'Status' says whether CANDEF shows it today (`displayed`), stores it without showing it (`stored`), plans it (`planned`), or uses it to attribute other facts (`context`). All of them are in scope.",
  ];
  for (const [cat, title] of Object.entries(CATEGORIES)) {
    const fields = BLIND_FIELDS.filter((f) => f.category === cat && (!only || only.has(f.id)));
    if (!fields.length) continue;
    out.push(
      "",
      `### ${cat}. ${title}`,
      "",
      "| ID | Field | Research question | What to report | Shown in CANDEF | Status |",
      "| -- | ----- | ----------------- | -------------- | --------------- | ------ |",
      ...fields.map(
        (f) =>
          `| ${f.id} | ${cell(f.title)} | ${cell(f.question)} | ${cell(f.report + (f.rule ? ` **Rule:** ${f.rule}` : ""))} | ${cell(f.shownIn.join("; ") || "not shown yet")} | ${f.display} |`,
      ),
    );
  }
  return out.join("\n");
}

function taxonomy(): string {
  const nodes = parse(readFileSync(join(root, "research", "taxonomy.yaml"), "utf8")) as {
    id: string;
    parentId: string | null;
    label: string;
    definition: string;
  }[];
  const out = [
    "## 10. CANDEF taxonomy (for B01 and B02)",
    "",
    "Choose subsector IDs (the indented entries). The list is CANDEF's category system, not a hint about this company.",
  ];
  for (const s of nodes.filter((n) => n.parentId === null)) {
    out.push("", `- **${s.label}** (\`${s.id}\`): ${s.definition}`);
    for (const sub of nodes.filter((n) => n.parentId === s.id))
      out.push(`  - \`${sub.id}\` ${sub.label}: ${sub.definition}`);
  }
  return out.join("\n");
}

const ELIGIBILITY = `## 11. CANDEF eligibility rule (for B06)

A company is **included** only if both are documented:

1. **Canadian headquarters**, from a registry record, a filing or a first-party statement. Legal domicile alone is not enough.
2. **Classification** into at least one taxonomy subsector, with a written dual-use rationale: documented relevance to defence, security, public safety or critical infrastructure. Fitting a segment is not enough, and neither is general environmental monitoring or a speculative defence application.

Further rules:

- Companies whose **primary business is weapons, munitions or lethal systems are in scope** (since 2026-10-16) and are not excluded for that reason: record what the evidence shows, at company level, and answer the weapons check (B05) plainly. Do not give build or use instructions.
- Foreign-owned Canadian-headquartered subsidiaries, acquired companies and public companies can be included and are labelled as such. A subsidiary is assessed on its own: a parent's eligibility, financing or contracts are never inherited.
- A documented defence or security **program** relationship (for example an award under a defence innovation program) can support inclusion, but it is distinct from a defence **contract or customer** relationship: say which kind your evidence shows, and whether it is current or historical.
- Use **pending** when the evidence is incomplete, and **ambiguous** when the evidence conflicts or the scope question needs a human decision.`;

const TEMPLATE = (c: BlindCard | null) => ({
  package_version: "candef-blind-v2",
  researcher: {
    id: "R-<tool>-<yyyymmdd>-<n>",
    model_or_tool: "<model or tool name and version>",
    started_at: "<ISO date-time>",
    finished_at: "<ISO date-time>",
    browsing: true,
    limitations: ["<anything you could not access or check>"],
  },
  company: {
    card_id: c?.card ?? "<card id>",
    name_as_given: c?.name ?? "<name on the card>",
    website_as_given: c?.website ?? "<website on the card>",
  },
  entities: [
    {
      entity_id: "E1",
      legal_name: "<exact legal name>",
      role: "operating_company | parent | subsidiary | division | predecessor | other",
      jurisdiction: "<federal | province | foreign country>",
      identifiers: [{ system: "<corporation-number | cra-bn | ticker | ...>", value: "<value>" }],
      notes: null,
    },
  ],
  findings: [
    {
      finding_id: "F001",
      field_id: "A02",
      entity_id: "E1",
      status: "found",
      claim: "<one specific sentence, e.g. 'The legal name of E1 is Example Widgets Inc.'>",
      value: { legal_name: "<value>" },
      sources: [
        {
          url: "<original source URL>",
          title: "<page or document title>",
          publisher: "<publisher>",
          published_on: "<YYYY | YYYY-MM | YYYY-MM-DD | null>",
          accessed_on: "<YYYY-MM-DD>",
          source_type: "registry",
          locator: "<section, table row, PDF page or dataset row fields>",
          quote: "<at most 30 words, verbatim>",
          same_origin_as: [],
        },
      ],
      confidence: "high",
      confidence_reason: "<why>",
      contradictions: [],
      notes: null,
    },
    {
      finding_id: "F002",
      field_id: "E01",
      entity_id: "E1",
      status: "found",
      claim:
        "<department> contract <procurement_id> to <vendor as reported>: original <amount>, total after amendments <amount>.",
      dates: { contract_date: "<date>", start: "<date>", end: "<date>" },
      money: [
        {
          amount: "<number as stated>",
          currency: "CAD",
          as_stated: "<text>",
          basis: "original_value",
        },
        {
          amount: "<number>",
          currency: "CAD",
          as_stated: "<text>",
          basis: "total_after_amendments",
        },
      ],
      counterparty: {
        name_as_reported: "<department as reported>",
        legal_name: null,
        kind: "government body",
      },
      identifiers: [
        { system: "owner_org", value: "<code>" },
        { system: "procurement_id", value: "<id>" },
        { system: "reference_number", value: "<batch id>" },
      ],
      sources: [
        {
          url: "<open.canada.ca search result or dataset URL>",
          title: "<title>",
          publisher: "Government of Canada",
          published_on: null,
          accessed_on: "<YYYY-MM-DD>",
          source_type: "government_dataset",
          locator:
            "owner_org=<...>; reference_number=<...>; procurement_id=<...>; vendor_name=<...>; contract_value=<...>",
          quote: null,
        },
      ],
      confidence: "medium",
      confidence_reason: "<why>",
      notes: null,
    },
    {
      finding_id: "F003",
      field_id: "A11",
      entity_id: "E1",
      status: "confirmed_absent",
      claim: "<e.g. 'E1 describes itself as privately held.'>",
      sources: [
        {
          url: "<url>",
          title: "<title>",
          publisher: "<publisher>",
          published_on: null,
          accessed_on: "<YYYY-MM-DD>",
          source_type: "first_party",
          locator: "<where>",
          quote: "<at most 30 words>",
        },
      ],
      confidence: "medium",
      confidence_reason: "<why>",
    },
    {
      finding_id: "F004",
      field_id: "C04",
      entity_id: "E1",
      status: "not_found",
      claim: "No company-stated cumulative total raised was found.",
      sources: [],
      searched: ["<company news page>", "<search queries used>", "<other places>"],
      confidence: "low",
      confidence_reason: "Absence of evidence is not evidence of absence.",
    },
  ],
  search_log: [
    { category: "E", searched: ["<datasets, sites and queries>"], date: "<YYYY-MM-DD>" },
  ],
  derived: [
    {
      field_id: "X01",
      value: [{ currency: "<currency>", amount: "<total>" }],
      computation: "<how the rule was applied>",
      inputs: ["<finding IDs>"],
    },
  ],
  open_questions: ["<anything a human should look at>"],
});

function outputSection(c: BlindCard | null): string {
  return [
    "## 12. Output template",
    "",
    "Fill in one file per company. The JSON Schema (`output.schema.json`) is provided with this assignment; this template shows the shape. Placeholders in angle brackets are not data.",
    "",
    "```json",
    JSON.stringify(TEMPLATE(c), null, 2),
    "```",
  ].join("\n");
}

// ---- Round 2 (2026-10-15): one company per run, fixed researcher IDs, chat-only output ----------

/** Perplexity's round-2 focus: corporate events, capital and contract award notices (completeness). */
const PERPLEXITY_FOCUS: ReadonlySet<string> = new Set([
  "A02",
  "A03",
  "A11",
  "A12",
  "A13",
  "A14",
  "A15",
  "C01",
  "C02",
  "C03",
  "C04",
  "D01",
  "E01",
  "E06",
  "E07",
  "X01",
  "X02",
  "X03",
  "X09",
]);

const ROUND2 = COHORT
  ? ({
      chatgpt: { id: `R-chatgpt-dr-b${COHORT_NUMBER}`, tool: "ChatGPT deep research" },
      perplexity: { id: `R-perplexity-b${COHORT_NUMBER}`, tool: "Perplexity" },
    } as const)
  : ({
      chatgpt: { id: "R-chatgpt-dr-r2", tool: "ChatGPT deep research" },
      perplexity: { id: "R-perplexity-r2", tool: "Perplexity" },
    } as const);

function runHeader(kind: keyof typeof ROUND2, c: BlindCard): string {
  const r = ROUND2[kind];
  return [
    "# Run instructions (read before anything else)",
    "",
    `- **Your researcher ID:** \`${r.id}\`. Put exactly this in \`researcher.id\`. Put your real model name in \`researcher.model_or_tool\`.`,
    `- **Your company:** card ${c.card} only (section 8).`,
    kind === "perplexity"
      ? `- **Focus:** corporate history and ownership, every financing event and investor, and every contract award, including foreign ones (fields ${[...PERPLEXITY_FOCUS].join(", ")}). Completeness is the goal: find every event the evidence shows, not only the best-known ones. For federal contracts, search the CanadaBuys award notices and contract-history pages as well as the open.canada.ca disclosure; vendor names there can be spelled differently from the company's own name, so search name variants.`
      : "- **Scope:** every field in the inventory (section 9). Completeness is the goal: find every event the evidence shows, not only the best-known ones.",
    "- **Deliverable:** the complete package as **one JSON object in a single ```json code block** at the end of your answer. This chat output is the deliverable; you do not need to create a file. Do not replace the JSON with a summary.",
    "- **If the JSON is too long for one block,** split it into consecutive ```json code blocks, each preceded by a line `PART k OF n`. Their contents joined in order must form one valid JSON object. If you are cut off, the user will reply `continue`: resume exactly where the JSON stopped.",
    "",
  ].join("\n");
}

/** Run instructions for a group of companies in one chat (`package --cohort batchN --group K`). */
function groupHeader(kind: keyof typeof ROUND2, group: BlindCard[]): string {
  const r = ROUND2[kind];
  const ids = group.map((c) => c.card).join(", ");
  const fence = "```";
  return [
    "# Run instructions (read before anything else)",
    "",
    `- **Your researcher ID:** \`${r.id}\`. Put exactly this in \`researcher.id\` of every package. Put your real model name in \`researcher.model_or_tool\`.`,
    `- **Your companies:** cards ${ids} (section 8). They are unrelated businesses: research each one separately, never carry a finding from one company to another, and give every company the same depth.`,
    kind === "perplexity"
      ? `- **Focus:** corporate history and ownership, every financing event and investor, and every contract award, including foreign ones (fields ${[...PERPLEXITY_FOCUS].join(", ")}). Completeness is the goal for each company. For federal contracts, search the CanadaBuys award notices and contract-history pages as well as the open.canada.ca disclosure; vendor names there can be spelled differently from the company's own name, so search name variants.`
      : "- **Scope:** every field in the inventory (section 9), for each company. Completeness is the goal: find every event the evidence shows, not only the best-known ones.",
    `- **Deliverable:** one complete package per company, in the order of the cards, each as **one JSON object in its own ${fence}json code block**, with a line \`COMPANY <card id>\` immediately before each block. Finish one company completely before starting the next. This chat output is the deliverable; do not replace the JSON with summaries.`,
    `- **If a package is too long for one block,** split it into consecutive ${fence}json blocks, each preceded by a line \`COMPANY <card id> PART k OF n\`. Their contents joined in order must form one valid JSON object. If you are cut off, the user will reply \`continue\`: resume exactly where the JSON stopped.`,
    "",
  ].join("\n");
}

function prompt(assigned: BlindCard[], only?: ReadonlySet<string>): string {
  const brief = readFileSync(join(SHARE, "parts", "brief.md"), "utf8").trim();
  return [
    "<!-- Generated by scripts/research/blind-verification.ts package. Edit parts/brief.md or pipeline/research/blindFields.ts, then regenerate. -->",
    "",
    brief,
    "",
    assigned.length === 1
      ? "## 8. Your assigned company"
      : "## 8. Assigned companies (one output file each)",
    "",
    assigned.map(cardBlock).join("\n\n"),
    "",
    fieldInventory(only),
    "",
    taxonomy(),
    "",
    ELIGIBILITY,
    "",
    outputSection(assigned.length === 1 ? assigned[0]! : null),
  ].join("\n");
}

/** A numbered cohort: one ChatGPT and one Perplexity prompt per company, plus the owner's instructions. */
async function packageCohort() {
  const files: Record<string, string> = {};
  for (const c of cards) {
    files[join("chatgpt", `${c.card}.md`)] = runHeader("chatgpt", c) + prompt([c]);
    files[join("perplexity", `${c.card}.md`)] =
      runHeader("perplexity", c) + prompt([c], PERPLEXITY_FOCUS);
  }
  // Grouped prompts (owner decision 2026-10-21): by default five companies per ChatGPT prompt and
  // three per Perplexity prompt (its answers are cut off more often). `--group K` sets both; `--group 0` turns it off.
  const groupAt = process.argv.indexOf("--group");
  const forced = groupAt >= 0 ? Number(process.argv[groupAt + 1]) : null;
  const sizes = { chatgpt: forced ?? 5, perplexity: forced ?? 3 } as const;
  for (const kind of ["chatgpt", "perplexity"] as const) {
    const size = sizes[kind];
    if (!(size > 1)) continue;
    for (let i = 0; i < cards.length; i += size) {
      const g = cards.slice(i, i + size);
      const name = `${g[0]!.card}-${g.at(-1)!.card}.md`;
      files[join("grouped", kind, name)] =
        groupHeader(kind, g) + (kind === "perplexity" ? prompt(g, PERPLEXITY_FOCUS) : prompt(g));
    }
  }
  files["README.md"] = [
    `# Blind research, batch ${COHORT_NUMBER}: instructions for the owner`,
    "",
    "Each file is one complete prompt for one company. Paste the **whole file** as the first message of a fresh chat, then send the answer back to Claude. The prompts contain no CANDEF findings; the generator's leak check passed. Regenerate with `npx tsx scripts/research/blind-verification.ts package --cohort " +
      COHORT +
      "`.",
    "",
    "| Folder | Tool and setting | Researcher ID |",
    "| --- | --- | --- |",
    `| \`chatgpt/\` | **ChatGPT, Deep research**, in a **temporary chat** (memory off) | \`${ROUND2.chatgpt.id}\` |`,
    `| \`perplexity/\` | **Perplexity, Deep Research** (or Computer mode), in a new thread outside any Space | \`${ROUND2.perplexity.id}\` |`,
    "",
    "| Card | Company | Website |",
    "| --- | --- | --- |",
    ...cards.map((c) => `| ${c.card} | ${c.name} | ${c.website} |`),
    "",
    "## Keep each run blind",
    "",
    "- Add nothing to the prompt; never show one tool another tool's answer; do not use Claude; Muse only in a brand-new chat with memory off, outside any project or Space (P-69).",
    '- If the tool asks questions, answer: "Follow the instructions in the prompt; research only the company on the card."',
    "- If the JSON stops partway, reply `continue` until it is complete. Download any file the tool offers.",
    "",
    "## Sending it back",
    "",
    `Attach or paste the answer in the Claude chat and say which tool and card it is, or save it in \`research-cache/blind-verification/returns/${ROUND2.chatgpt.id}/\` or \`.../${ROUND2.perplexity.id}/\`. Returns stay out of Git (they contain short quotes).`,
  ].join("\n");
  for (const [name, text] of Object.entries(files)) {
    const file = join(COHORT_SHARE, name);
    write(file, await format(text, { ...(await resolveConfig(file)), filepath: file }));
  }
  const inv = buildInventory(loadCorpus(), cards, today);
  const hits = runLeakCheck(inv, COHORT_SHARE);
  console.log(
    `Batch ${COHORT_NUMBER} prompts written to ${relative(root, COHORT_SHARE)} (${Object.keys(files).length} files).`,
  );
  if (hits.length) {
    console.error(`LEAK CHECK FAILED: ${hits.length} inventory value(s) appear in the prompts:`);
    for (const h of hits) console.error(`  ${h.file}: "${h.token}" (${h.claimId})`);
    process.exit(1);
  }
  console.log(
    `Leak check passed: none of ${inv.leakTokens.length} inventory tokens or ${inv.items.reduce((n, i) => n + i.citations.length, 0)} cited URLs appear in the prompts.`,
  );
}

async function packageCommand() {
  if (COHORT) return packageCohort();
  const files: Record<string, string> = {};
  files["RESEARCHER_PROMPT_ALL.md"] = prompt(cards);
  for (const c of cards) files[join("assignments", `${c.card}.md`)] = prompt([c]);
  // Round 2: ChatGPT already returned C01, so it gets C02-C10; Perplexity gets all ten (focused).
  for (const c of cards) {
    if (c.card !== "C01")
      files[join("round2", "chatgpt", `${c.card}.md`)] = runHeader("chatgpt", c) + prompt([c]);
    files[join("round2", "perplexity", `${c.card}.md`)] =
      runHeader("perplexity", c) + prompt([c], PERPLEXITY_FOCUS);
  }
  files["companies.md"] = [
    "# Companies for blind verification (shareable)",
    "",
    "Name and website only. Nothing else about CANDEF's research is shared.",
    "",
    "| Card | Name | Website |",
    "| ---- | ---- | ------- |",
    ...cards.map((c) => `| ${c.card} | ${c.name} | ${c.website} |`),
  ].join("\n");
  files["field-inventory.md"] = [
    "# CANDEF field inventory (shareable)",
    "",
    fieldInventory().replace(/^## 9\. /, "## "),
  ].join("\n");
  files["output.schema.json"] = JSON.stringify(
    z.toJSONSchema(ResearcherPackage, { unrepresentable: "any" }),
    null,
    2,
  );
  files["output-template.json"] = JSON.stringify(TEMPLATE(null), null, 2);
  // Written already formatted, so `npm run format:check` passes on a fresh package.
  for (const [name, text] of Object.entries(files)) {
    const file = join(SHARE, name);
    write(file, await format(text, { ...(await resolveConfig(file)), filepath: file }));
  }

  const inv = buildInventory(loadCorpus(), cards, today);
  const hits = runLeakCheck(inv);
  console.log(
    `Shareable package written to ${relative(root, SHARE)} (${Object.keys(files).length} files).`,
  );
  if (hits.length) {
    console.error(
      `LEAK CHECK FAILED: ${hits.length} inventory value(s) appear in the shareable package:`,
    );
    for (const h of hits) console.error(`  ${h.file}: "${h.token}" (${h.claimId})`);
    process.exit(1);
  }
  console.log(
    `Leak check passed: none of ${inv.leakTokens.length} inventory tokens or ${inv.items.reduce((n, i) => n + i.citations.length, 0)} cited URLs appear in the shareable files.`,
  );
}

function shareFiles(dir = SHARE): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? shareFiles(join(dir, e.name))
      : [
          {
            file: relative(root, join(dir, e.name)),
            text: readFileSync(join(dir, e.name), "utf8"),
          },
        ],
  );
}

function runLeakCheck(inv: Inventory, dir = SHARE) {
  const nodes = parse(readFileSync(join(root, "research", "taxonomy.yaml"), "utf8")) as {
    id: string;
    label: string;
  }[];
  const allow = [
    ...cards.flatMap((c) => [c.name, c.website]),
    // The taxonomy is the category list itself: every ID and label is in every prompt.
    ...nodes.flatMap((n) => [n.id, n.label]),
    // Generic program names given as examples in the method notes (never per-company hints).
    "Innovation for Defence Excellence and Security",
    "Regional Defence Investment Initiative",
    "Strategic Aerospace and Defence Initiative",
    "Canadian Safety and Security Program",
    "Government of Canada",
    "Corporations Canada",
  ];
  // "Contracts over $10,000" is the dataset's own name.
  return leakCheck(shareFiles(dir), inv, allow, ["10,000"]);
}

// ---- Private inventory --------------------------------------------------------------------------

function inventoryMarkdown(inv: Inventory): string {
  const out = [
    "# PRIVATE: CANDEF blind-verification inventory",
    "",
    `Generated ${inv.generatedAt} (corpus as of ${inv.today}). **Do not share with blind researchers.** Derived displays come from an in-memory compile in which every proposed record is treated as approved; nothing was approved or written.`,
    "",
    inv.simulation.ok
      ? "Simulation: compiled cleanly."
      : `Simulation FAILED: ${inv.simulation.failures.join("; ")}`,
    "",
  ];
  for (const c of inv.cards) {
    const items = inv.items.filter((i) => i.card === c.card);
    const by = (k: string) => items.filter((i) => i.kind === k).length;
    out.push(
      `## ${c.card} ${c.name}`,
      "",
      `${items.length} claims: ${by("base")} base records, ${by("derived")} derived displays, ${by("absence")} absence displays, ${by("process")} ledger records.`,
      "",
      "| Claim | Field | Kind | Entity | Label | Value | Publishes if approved | Note |",
      "| ----- | ----- | ---- | ------ | ----- | ----- | --------------------- | ---- |",
      ...items.map(
        (i) =>
          `| ${i.claimId} | ${i.fieldId} | ${i.kind} | ${cell(i.entity)} | ${cell(i.label)} | ${cell(i.value.slice(0, 300))} | ${i.publishes === null ? "n/a" : i.publishes ? "yes" : "**no**"} | ${cell(i.note ?? "")} |`,
      ),
      "",
    );
  }
  return out.join("\n");
}

function inventoryCommand() {
  const inv = buildInventory(loadCorpus(), cards, today);
  mkdirSync(CACHE, { recursive: true });
  write(join(CACHE, `internal-inventory-${today}.json`), JSON.stringify(inv, null, 2));
  write(join(CACHE, `internal-inventory-${today}.md`), inventoryMarkdown(inv));
  const count = (k: string) => inv.items.filter((i) => i.kind === k).length;
  console.log(
    `Private inventory: ${inv.items.length} claims for ${inv.cards.length} cards (${count("base")} base, ${count("derived")} derived, ${count("absence")} absence, ${count("process")} ledger) -> ${relative(root, CACHE)}`,
  );
  const blocked = inv.items.filter((i) => i.publishes === false);
  if (blocked.length)
    console.log(
      `${blocked.length} displayed claim(s) would NOT publish even if approved (see the 'Publishes' column).`,
    );
  if (!inv.simulation.ok) console.log(`Simulation failures: ${inv.simulation.failures.join("; ")}`);
}

// ---- Worksheet ---------------------------------------------------------------------------------

/**
 * A researcher package pasted into a chat report: the first ```json block that is a whole package,
 * else all ```json blocks joined in order (the round-2 "PART k OF n" split). `undefined` when the
 * report has no JSON block at all, `null` when its blocks do not form a package.
 */
function packageFromMarkdown(text: string): unknown {
  const blocks = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  if (!blocks.length) return undefined;
  const isPackage = (v: unknown) =>
    typeof v === "object" && v !== null && "package_version" in v && "findings" in v;
  for (const b of blocks) {
    try {
      const v = JSON.parse(b);
      if (isPackage(v)) return v;
    } catch {
      // a fragment of a split package; tried joined below
    }
  }
  try {
    const v = JSON.parse(blocks.join(""));
    return isPackage(v) ? v : null;
  } catch {
    return null;
  }
}

function worksheetCommand() {
  const inv = buildInventory(loadCorpus(), cards, today);
  if (!existsSync(RETURNS)) {
    console.error(
      `No returns folder: put researcher files in ${relative(root, RETURNS)}/<researcher-id>/`,
    );
    process.exit(1);
  }
  const packages: ResearcherPackage[] = [];
  const problems: string[] = [];
  const normalizations: string[] = [];
  const evidenceIssues: string[] = [];
  const unusable = new Map<string, Set<string>>();
  // `original/` folders keep the owner's untouched uploads; the extracted files sit beside them.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? e.name === "original"
          ? []
          : walk(join(dir, e.name))
        : /\.(json|md)$/.test(e.name)
          ? [join(dir, e.name)]
          : [],
    );
  const seen = new Map<string, string>();
  const files = walk(RETURNS).sort(
    (a, b) => Number(b.endsWith(".json")) - Number(a.endsWith(".json")),
  );
  for (const file of files) {
    const rel = relative(root, file);
    const text = readFileSync(file, "utf8");
    let raw: unknown;
    if (file.endsWith(".md")) {
      raw = packageFromMarkdown(text);
      if (raw === undefined) continue; // a report without a package (summaries, notes)
      if (raw === null) {
        problems.push(`${rel}: has JSON code blocks but they do not form one valid package`);
        continue;
      }
    } else {
      try {
        raw = JSON.parse(text);
      } catch (e) {
        problems.push(`${rel}: not valid JSON (${(e as Error).message})`);
        continue;
      }
    }
    const r = raw as { researcher?: { id?: string }; company?: { card_id?: string } };
    const dupKey = `${r.researcher?.id}|${r.company?.card_id}`;
    if (seen.has(dupKey)) {
      normalizations.push(`${rel}: same researcher and card as ${seen.get(dupKey)}; skipped`);
      continue;
    }
    seen.set(dupKey, rel);
    const intake = intakePackage(raw);
    for (const n of intake.notes) normalizations.push(`${rel}: ${n}`);
    if (!intake.pkg) {
      problems.push(`${rel}: ${intake.errors.slice(0, 8).join("; ")}`);
      continue;
    }
    const pkg = intake.pkg;
    if (!cards.some((c) => c.card === pkg.company.card_id))
      problems.push(`${rel}: unknown card ${pkg.company.card_id}`);
    const missing = BLIND_FIELDS.filter(
      (f) =>
        f.id !== "H01" &&
        !pkg.findings.some((x) => x.field_id === f.id) &&
        !(pkg.derived ?? []).some((x) => x.field_id === f.id),
    );
    if (missing.length)
      problems.push(`${rel}: no entry for fields ${missing.map((f) => f.id).join(", ")}`);
    for (const i of intake.issues) evidenceIssues.push(`${rel}: ${i.findingId} ${i.message}`);
    const key = `${pkg.researcher.id}|${pkg.company.card_id}`;
    unusable.set(
      key,
      new Set([...(unusable.get(key) ?? []), ...intake.issues.map((i) => i.findingId)]),
    );
    packages.push(pkg);
  }
  const independence = JSON.parse(readFileSync(INDEPENDENCE, "utf8")) as {
    exposed: { researcher: string; cards: string[] }[];
  };
  const exposed = new Set(
    independence.exposed.flatMap((e) => e.cards.map((c) => `${e.researcher}|${c}`)),
  );
  const ws = buildWorksheet(inv, packages, unusable, exposed);
  // Claude's saved primary-source evaluations survive re-runs (bound to each claim's value hash).
  const evalFile = join(CACHE, "evaluations.json");
  const stale = existsSync(evalFile)
    ? applyEvaluations(ws, EvaluationsFile.parse(JSON.parse(readFileSync(evalFile, "utf8"))))
    : [];
  if (stale.length) problems.push(`${stale.length} evaluation(s) are stale: ${stale.join(", ")}`);
  write(
    join(CACHE_ROOT, `${WORKSHEET}.json`),
    JSON.stringify({ ...ws, validation: problems, normalizations, evidenceIssues }, null, 2),
  );
  const md = [
    "# PRIVATE: blind-verification reconciliation worksheet",
    "",
    `Generated ${ws.generatedAt}. Packages: ${ws.packages.map((p) => `${p.researcher}/${p.card} (${p.findings})`).join(", ") || "none"}.`,
    "",
    problems.length
      ? `**Validation problems:**\n\n${problems.map((p) => `- ${p}`).join("\n")}`
      : "All packages validated.",
    "",
    "Every row starts as `not_yet_evaluated`. Candidates are alignment suggestions only; an outcome is assigned after reading the primary evidence (RECONCILIATION_PLAN.md section 5).",
    "",
  ];
  for (const c of cards) {
    const rows = ws.rows.filter((r) => r.card === c.card);
    md.push(
      `## ${c.card} ${c.name}`,
      "",
      "| Claim | Field | Kind | Value | Signal | Candidates (researcher:finding status, independent origins) | Outcome |",
      "| ----- | ----- | ---- | ----- | ------ | ---------------------------------------------------------- | ------- |",
      ...rows.map(
        (r) =>
          `| ${r.claimId} | ${r.fieldId} | ${r.kind} | ${cell(r.value.slice(0, 160))} | ${r.signal} | ${cell(
            r.candidates
              .slice(0, 4)
              .map(
                (x) =>
                  `${x.researcher}:${x.findingId} ${x.status}${x.usable ? "" : " UNUSABLE"}${x.independent ? "" : " EXPOSED"}${x.sameAsCandefSource ? " (same source as CANDEF)" : ""}`,
              )
              .join("; ") || "none",
          )} (${r.distinctIndependentOrigins}) | ${r.outcome} |`,
      ),
      "",
      "New independent findings (not linked to an existing claim):",
      "",
      ...(ws.newFindings
        .filter((f) => f.card === c.card)
        .map((f) => `- ${f.researcher}:${f.findingId} [${f.fieldId}] ${f.claim}`) || []),
      "",
    );
  }
  write(join(CACHE_ROOT, `${WORKSHEET}.md`), md.join("\n"));
  console.log(
    `Worksheet: ${ws.rows.length} claims, ${packages.length} packages, ${ws.newFindings.length} new findings -> ${relative(root, CACHE)}`,
  );
  if (problems.length) console.log(`${problems.length} validation problem(s); see the worksheet.`);
  const signals = new Map<string, number>();
  for (const r of ws.rows) signals.set(r.signal, (signals.get(r.signal) ?? 0) + 1);
  console.log(`Signals: ${[...signals].map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (evidenceIssues.length)
    console.log(`${evidenceIssues.length} finding(s) kept but unusable as evidence.`);
  if (normalizations.length)
    console.log(`${normalizations.length} format normalization note(s) (files unchanged).`);
}

// ---- Intake of the owner's uploads ---------------------------------------------------------------

/** The package JSON in a chat report: one whole-package block, else all json blocks joined. */
function rawPackageFromMarkdown(text: string): unknown {
  const blocks = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const isPackage = (v: unknown) =>
    typeof v === "object" &&
    v !== null &&
    ("package_version" in v || "packageversion" in v) &&
    ("findings" in v || "findingsfinding" in v);
  for (const b of [...blocks, blocks.join("")]) {
    try {
      const v = JSON.parse(b);
      if (isPackage(v)) return v;
    } catch {
      // a fragment, or prose without a package
    }
  }
  return undefined;
}

/**
 * A return cut off mid-JSON (the model hit its output limit): keeps every finding that is complete
 * and closes the array. The caller logs it as truncated; nothing is completed or guessed.
 */
function salvageTruncated(text: string): { value: unknown; findings: number } | undefined {
  const block = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)(?:```|$)/g)]
    .map((m) => m[1]!)
    .find((b) => /"(?:package_version|packageversion)"/.test(b));
  if (!block) return undefined;
  const ends = [...block.matchAll(/\n( {4})\},?\n/g)].map((m) => m.index! + m[0].indexOf("}") + 1);
  for (const end of ends.reverse()) {
    try {
      const value = JSON.parse(`${block.slice(0, end)}\n  ]\n}`) as { findings?: unknown[] };
      const list = value.findings ?? (value as { findingsfinding?: unknown[] }).findingsfinding;
      if (Array.isArray(list)) return { value, findings: list.length };
    } catch {
      // try the previous complete finding
    }
  }
  return undefined;
}

/**
 * extract <researcher-id> <file.md ...>: files each upload under returns/<id>/original/, repairs
 * exports that lost their underscores (never the original) and writes <id>__<card>.json beside it.
 */
function extractCommand() {
  const args = process.argv
    .slice(3)
    .filter((a, i, all) => a !== "--cohort" && all[i - 1] !== "--cohort");
  const [researcher, ...files] = args;
  if (!researcher || !files.length) {
    console.error("usage: extract <researcher-id> <file.md ...> [--cohort batchN]");
    process.exit(1);
  }
  const dir = join(RETURNS, researcher);
  mkdirSync(join(dir, "original"), { recursive: true });
  const vocab = vocabularyOf(z.toJSONSchema(ResearcherPackage, { unrepresentable: "any" }));
  const written = new Map<string, { file: string; findings: number; text: string }>();
  for (const file of files) {
    const name = basename(file);
    copyFileSync(file, join(dir, "original", name));
    const fileText = readFileSync(file, "utf8");
    let raw = rawPackageFromMarkdown(fileText);
    const notes: string[] = [];
    if (raw === undefined) {
      const salvaged = salvageTruncated(fileText);
      if (!salvaged) {
        console.log(`${name}: no JSON package (kept under original/ as leads only)`);
        continue;
      }
      raw = salvaged.value;
      notes.push(
        `TRUNCATED return: kept the ${salvaged.findings} complete findings, the rest is missing`,
      );
    }
    let value = raw;
    if (looksStripped(raw)) {
      const r = repairStripped(raw, vocab);
      value = r.value;
      notes.push(`underscores restored: ${r.notes.length} kinds`);
      if (r.ambiguous.length) notes.push(`ambiguous, left alone: ${r.ambiguous.join(", ")}`);
    }
    const intake = intakePackage(value);
    if (!intake.pkg) {
      console.log(`${name}: INVALID package: ${intake.errors.slice(0, 5).join("; ")}`);
      continue;
    }
    const pkg = intake.pkg;
    const card = pkg.company.card_id;
    // P-69: a fresh-context researcher counts as independent unless it reports prior CANDEF context.
    // A limitation saying CANDEF material was NOT searched, opened or used is a non-exposure statement.
    const exposure = (pkg.researcher.limitations ?? []).filter(
      (l) =>
        /candef|prior (knowledge|context)|memory/i.test(l) &&
        !/\b(no|not|never)\b[^.]*\b(searched|opened|used|consulted)\b/i.test(l),
    );
    if (exposure.length)
      notes.push(
        `EXPOSURE: reports prior context (${exposure[0]!.slice(0, 120)}); ask the owner to add ${researcher}|${card} to independence.json before it counts`,
      );
    const text = JSON.stringify(value, null, 2);
    const prior = written.get(card);
    if (prior && prior.text === text) {
      console.log(`${name}: identical to ${prior.file} (card ${card}); skipped`);
      continue;
    }
    if (prior && prior.findings >= pkg.findings.length) {
      console.log(`${name}: card ${card} already has a fuller package (${prior.file}); skipped`);
      continue;
    }
    const out = `${researcher}__${card}.json`;
    write(join(dir, out), text);
    written.set(card, { file: name, findings: pkg.findings.length, text });
    console.log(
      `${name}: card ${card} -> ${out} (${pkg.findings.length} findings; ${[...notes, ...intake.notes].join("; ") || "no repairs"})`,
    );
  }
}

const command = process.argv[2];
if (command === "package") await packageCommand();
else if (command === "inventory") inventoryCommand();
else if (command === "worksheet") worksheetCommand();
else if (command === "extract") extractCommand();
else {
  console.error("usage: blind-verification.ts package | inventory | worksheet | extract");
  process.exit(1);
}
