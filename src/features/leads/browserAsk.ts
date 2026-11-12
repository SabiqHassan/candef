/**
 * Bring-your-own-key question answering, entirely in the visitor's browser. The visitor's Anthropic key
 * is sent only to api.anthropic.com from this page; it is never stored by the site and never sent to
 * any other host. The model can only call one tool, `search_leads`, which runs the same ranking code
 * as the Leads page over the loaded government-data leads. Leads are unverified.
 */
import { searchLeadsIn, type LeadsIndex } from "./leadsData";
import { TAG_LABELS } from "../../domain/leads/vocabulary";
import type { SiteLead } from "../../domain/leads/siteTypes";

export const ASK_MODELS = [
  { id: "claude-haiku-5-5", label: "Haiku 5.5 (fastest, cheapest)" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (better with vague requests)" },
] as const;

const API_URL = "https://api.anthropic.com/v1/messages";
const MAX_STEPS = 6;

const TAGS = Object.keys(TAG_LABELS);

const SYSTEM = `You answer questions about companies found in Canadian federal grants and contracts data. Use ONLY the search_leads tool. Every company you mention must come from a tool result.

Rules:
- Use only what the tool returns. Do not use outside knowledge of any company.
- Cite the evidence for each company: the date, department, programme (or category), amount and reference number of the government row, exactly as the tool gives them. Never invent a source, date, amount or reference.
- If a fact is not in the results (founding year, what the company makes, owners, employees), say it is unknown. A grant or contract does not prove a product, a customer, an investment or an endorsement.
- Every result is an unverified lead from public government data. Say so once, plainly.
- Never give investment advice or rank companies as investments. Do not name private individuals.

Turning a request into filters:
- Topic words -> "tags" (and "text" for specific words). Tags: ${TAGS.join(", ")}. "Drone", "UAS", "UAV", "uncrewed" -> uas_drones. "Satellite", "launch", "orbit" -> space.
- A place -> "provinces" (two-letter codes, or atlantic, prairies, territories). A programme such as IDEaS, DIANA, RDII, SADI or IRAP -> "programmes". A money limit -> "maxTotalValue".
- "First-time grant recipient", "first grant" -> firstTimeGrantRecipient true.
- A year in the request is a date filter, not a topic word. "Got their first grant in 2026" -> firstGrantAfter "2026-01-01". "Appeared in the data since 2022" -> firstSeenAfter "2022-01-01". Say which date field you used, and that these are dates in the government data, not founding dates.
- If a search returns nothing, widen it once by dropping the narrowest filter, and say you did. If the request is too vague to search, ask one short question instead.

Answer format: plain text. Start with one or two sentences: how many companies matched, the filters you used, and the main caveat. Then at most 10 companies, best first. For each: name, province or city if known, the tags, and one to three evidence rows (date, department, programme or category, amount in Canadian dollars, reference). Keep it short and honest.`;

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type Msg = { role: "user" | "assistant"; content: string | unknown[] };

const TOOL = {
  name: "search_leads",
  description:
    "Search the loaded index of companies in Canadian federal grants and contracts data with a defence, security or space link. Returns ranked, unverified leads with the government rows behind them.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Keywords to match in names, projects and categories." },
      tags: { type: "array", items: { type: "string", enum: TAGS } },
      provinces: { type: "array", items: { type: "string" } },
      programmes: { type: "array", items: { type: "string" } },
      departments: { type: "array", items: { type: "string" } },
      firstSeenAfter: { type: "string", description: "YYYY-MM-DD" },
      firstGrantAfter: { type: "string", description: "YYYY-MM-DD" },
      firstTimeGrantRecipient: { type: "boolean" },
      maxTotalValue: { type: "number" },
      limit: { type: "number", description: "At most 15." },
    },
  },
};

const compact = (l: SiteLead) => ({
  name: l.name,
  provinces: l.provinces,
  cities: l.cities.slice(0, 2),
  tags: l.tags,
  firstSeen: l.firstDate,
  firstGrantDate: l.firstGrantDate,
  firstTimeGrantRecipient: l.firstTimeGrantRecipient,
  grantAgreements: l.grantAgreements,
  totalGrantValue: l.grantValue,
  totalContractValue: l.contractValue,
  triageReason: l.reason,
  evidence: l.lines.slice(0, 3).map((x) => ({
    kind: x.kind,
    date: x.date,
    department: x.department,
    programmeOrCategory: x.programme || x.description.slice(0, 80),
    title: x.title.slice(0, 120),
    value: x.value,
    ref: x.ref,
  })),
});

function runSearch(index: LeadsIndex, input: Record<string, unknown>): string {
  const q: Record<string, unknown> = { ...input };
  q.limit = Math.min(Number(q.limit) || 10, 15);
  const r = searchLeadsIn(index, q as Parameters<typeof searchLeadsIn>[1]);
  return JSON.stringify({
    totalMatches: r.total,
    shown: r.hits.length,
    leads: r.hits.map((h) => compact(h.d)),
  });
}

export class AskError extends Error {}

/** Runs the question. The key goes only to Anthropic; errors never echo it. */
export async function askInBrowser(opts: {
  apiKey: string;
  model: string;
  question: string;
  index: LeadsIndex;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: Msg[] = [{ role: "user", content: opts.question }];
  for (let step = 0; step <= MAX_STEPS; step++) {
    let res: Response;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        signal: opts.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 3000,
          system: SYSTEM,
          tools: step < MAX_STEPS ? [TOOL] : [],
          messages,
        }),
      });
    } catch {
      throw new AskError("Could not reach api.anthropic.com. Check your connection and try again.");
    }
    if (res.status === 401)
      throw new AskError("Anthropic rejected that key (401). Check it and try again.");
    if (res.status === 429)
      throw new AskError(
        "Anthropic says you are over a rate or spending limit (429). Try again later.",
      );
    if (!res.ok) throw new AskError(`Anthropic returned an error (HTTP ${res.status}).`);
    const body = (await res.json()) as { content: Block[]; stop_reason: string };
    const calls = body.content.filter(
      (b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use",
    );
    if (body.stop_reason === "tool_use" && calls.length) {
      messages.push({ role: "assistant", content: body.content });
      messages.push({
        role: "user",
        content: calls.map((c) => ({
          type: "tool_result",
          tool_use_id: c.id,
          content: runSearch(opts.index, c.input),
        })),
      });
      continue;
    }
    const text = body.content
      .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text || "The model returned no answer.";
  }
  throw new AskError("The model kept searching without answering. Try a narrower question.");
}
