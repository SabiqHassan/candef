/**
 * API mode of the leads search: a small tool-calling loop around any chat model.
 *
 * The model may call search_leads, get_company and web_lookup; its final message must be an
 * `Answer` (schema.ts) whose government citations match the stored rows. If it is not, the user
 * gets the plain search result with a note, never an unchecked answer.
 *
 * Built and tested with fake models only: no network call happens unless the caller supplies a
 * real adapter and a key. Keys come from the environment or research-cache/grant-ask/keys.env,
 * and are never printed, logged or placed in an error message.
 */
import { z } from "zod";
import { parseKeysFile, resolveKey } from "../pool";
import { checkAnswerCitations, searchLeads, type LeadStore } from "./index";
import { Answer, LEAD_LABEL } from "./schema";
import { errorText, runTool, toolDefs, type ToolContext, type ToolDef } from "./tools";

// ---- Model interface -----------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments (an object), or undefined when the model's arguments were not valid JSON. */
  arguments?: unknown;
  /** Set when `arguments` could not be parsed. */
  parseError?: string;
}

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string };

export interface CompleteRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  maxOutputTokens: number;
}
export type CompleteResult = { text: string } | { toolCalls: ToolCall[]; text?: string };

export interface ChatModel {
  readonly id: string;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

// ---- Keys and errors -----------------------------------------------------------------------------

export class NoKeyError extends Error {
  constructor(readonly keyEnv: string) {
    super(
      `No API key found for ${keyEnv}. Set it once in your own terminal (setx ${keyEnv} "<key>") or add a line ${keyEnv}=<key> to research-cache/grant-ask/keys.env, then run again. See docs/LEADS_SEARCH.md.`,
    );
  }
}

/** Replace every occurrence of a secret in a message. */
export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[key]");
  return out;
}

/** Provider replies are untyped JSON; fields are read defensively and every result is validated. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface AdapterBase {
  keyEnv: string;
  model: string;
  fetch?: FetchLike;
  /** Entries of keys.env, already parsed. */
  keysFile?: Record<string, string>;
  /** Looks a key up; defaults to the environment, keys.env and the Windows user environment. */
  resolve?: (name: string, keysFile: Record<string, string>) => string | undefined;
}

function keyFor(a: AdapterBase): string {
  const k = (a.resolve ?? resolveKey)(a.keyEnv, a.keysFile ?? {});
  if (!k) throw new NoKeyError(a.keyEnv);
  return k;
}

function parseArgs(raw: unknown): Pick<ToolCall, "arguments" | "parseError"> {
  if (raw === undefined || raw === null || raw === "") return { arguments: {} };
  if (typeof raw === "object") return { arguments: raw };
  try {
    return { arguments: JSON.parse(String(raw)) };
  } catch {
    return { parseError: "the arguments were not valid JSON" };
  }
}

async function post(
  a: AdapterBase,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  secret: string,
): Promise<Record<string, Json>> {
  let res: Response;
  try {
    res = await (a.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(redact(`request to the model provider failed: ${errorText(e)}`, [secret]));
  }
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      redact(
        `model provider answered HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`,
        [secret],
      ),
    );
  try {
    return JSON.parse(text) as Record<string, Json>;
  } catch {
    throw new Error("model provider returned a reply that is not JSON");
  }
}

// ---- Adapters ------------------------------------------------------------------------------------

/** Any OpenAI-compatible chat/completions API with tool calling (OpenAI, Groq, many hosts). */
export function openaiCompatible(
  opts: AdapterBase & { baseUrl: string; extraBody?: Record<string, unknown> },
): ChatModel {
  return {
    id: `openai-compatible:${opts.model}`,
    async complete(req) {
      const key = keyFor(opts);
      const messages: unknown[] = [{ role: "system", content: req.system }];
      for (const m of req.messages) {
        if (m.role === "user") messages.push({ role: "user", content: m.text });
        else if (m.role === "tool")
          messages.push({ role: "tool", tool_call_id: m.callId, content: m.content });
        else
          messages.push({
            role: "assistant",
            content: m.text ?? null,
            ...(m.toolCalls?.length
              ? {
                  tool_calls: m.toolCalls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
                  })),
                }
              : {}),
          });
      }
      const body = {
        model: opts.model,
        messages,
        max_tokens: req.maxOutputTokens,
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
        ...opts.extraBody,
      };
      const json = await post(
        opts,
        `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
        { authorization: `Bearer ${key}` },
        body,
        key,
      );
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error("model provider reply had no message");
      const calls: ToolCall[] = (msg.tool_calls ?? []).map((c: Json, i: number) => ({
        id: String(c.id ?? `call_${i}`),
        name: String(c.function?.name ?? ""),
        ...parseArgs(c.function?.arguments),
      }));
      return calls.length
        ? { toolCalls: calls, text: msg.content ?? undefined }
        : { text: typeof msg.content === "string" ? msg.content : "" };
    },
  };
}

/** Anthropic Messages API with tools. */
export function anthropic(opts: AdapterBase & { baseUrl?: string }): ChatModel {
  return {
    id: `anthropic:${opts.model}`,
    async complete(req) {
      const key = keyFor(opts);
      const messages: { role: "user" | "assistant"; content: unknown[] }[] = [];
      const push = (role: "user" | "assistant", block: unknown) => {
        const last = messages.at(-1);
        if (last && last.role === role) last.content.push(block);
        else messages.push({ role, content: [block] });
      };
      for (const m of req.messages) {
        if (m.role === "user") push("user", { type: "text", text: m.text });
        else if (m.role === "tool")
          push("user", { type: "tool_result", tool_use_id: m.callId, content: m.content });
        else {
          if (m.text) push("assistant", { type: "text", text: m.text });
          for (const c of m.toolCalls ?? [])
            push("assistant", {
              type: "tool_use",
              id: c.id,
              name: c.name,
              input: c.arguments ?? {},
            });
        }
      }
      const body = {
        model: opts.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages,
        ...(req.tools.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      };
      const json = await post(
        opts,
        `${(opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`,
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        body,
        key,
      );
      const blocks: Json[] = Array.isArray(json.content) ? json.content : [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
      const calls: ToolCall[] = blocks
        .filter((b) => b.type === "tool_use")
        .map((b, i) => ({
          id: String(b.id ?? `call_${i}`),
          name: String(b.name ?? ""),
          ...parseArgs(b.input),
        }));
      return calls.length ? { toolCalls: calls, text: text || undefined } : { text };
    },
  };
}

// ---- Config --------------------------------------------------------------------------------------

/** research-cache/grant-ask/search-providers.json. Never holds a key, only the name of its variable. */
export const SearchProviders = z.object({
  default: z.string().optional(),
  providers: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        kind: z.enum(["anthropic", "openai"]),
        model: z.string().min(1),
        keyEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "keyEnv is the NAME of a variable, not a key"),
        baseUrl: z.string().url().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
      }),
    )
    .min(1),
});
export type SearchProviders = z.infer<typeof SearchProviders>;

export function modelFromConfig(
  cfg: SearchProviders,
  name: string | undefined,
  keysText: string,
  fetchImpl?: FetchLike,
): { model: ChatModel; maxOutputTokens?: number } {
  const p = cfg.providers.find((x) => x.name === (name ?? cfg.default ?? cfg.providers[0]!.name));
  if (!p) throw new Error(`no provider named ${name} in the config`);
  const base = {
    keyEnv: p.keyEnv,
    model: p.model,
    keysFile: parseKeysFile(keysText),
    fetch: fetchImpl,
  };
  const model =
    p.kind === "anthropic"
      ? anthropic({ ...base, baseUrl: p.baseUrl })
      : openaiCompatible({ ...base, baseUrl: p.baseUrl ?? "https://api.openai.com/v1" });
  return { model, maxOutputTokens: p.maxOutputTokens };
}

// ---- The loop ------------------------------------------------------------------------------------

export const AGENT_SYSTEM = `You answer questions about companies in Canadian federal grants and contracts data, using ONLY the tools search_leads, get_company and web_lookup.

Rules:
- Use only what the tools return. Do not use outside knowledge of any company.
- Every claim must cite its source: copy the "sources" of the claims you use from the tool results exactly (government rows with key, line, date, department, programme or category, value, ref). Never invent a source, a date, an amount or a URL.
- If a fact is not in the tool results, put it in "unknowns" as unknown, not_found or not_researched. Never guess a founding year, owner or product.
- Do not use licensed databases (PitchBook, Crunchbase and similar). A web_lookup that answers not_researched or not_configured means the fact stays unknown.
- Every lead is an unverified lead from public government data; keep the label "${LEAD_LABEL}".
- Search with several different queries when the first is too narrow or too wide. Prefer tier A; mention tiers B-D only when asked.
- Finish with ONE JSON object and nothing else, in this shape: {"question": string, "summary": string, "leads": [{"key", "name", "tier", "whyMatched", "claims": [{"text", "sources": [...]}], "unknowns": [{"field", "state", "note"?}]}], "searchesRun": [string], "notes": [string], "label": "${LEAD_LABEL}"}.`;

/**
 * Standing guidance sent with every request, after AGENT_SYSTEM. It teaches the model how a user's plain
 * words map onto search_leads filters. It adds no facts and relaxes none of the rules above.
 */
export const AGENT_GUIDE = `How to turn a request into searches:
- Read the user's words literally, then pick filters: topic words -> "tags" (and "text" for specific words); a place -> "provinces" (two-letter codes, or atlantic, prairies, territories); a program such as IDEaS, DIANA, RDII, SADI or IRAP -> "programmes"; a department such as National Defence or the Canadian Space Agency -> "departments"; a money limit -> "maxTotalValue".
- Tags (use only these): uas_drones, space, cyber, robotics_autonomy, aerospace_aviation, maritime_naval, land_vehicles, weapons_munitions, sensors_optics_radar, comms_electronics, ai_software, simulation_training, cbrn_medical, energy_power, materials_manufacturing, security_services. "Drone", "UAS", "UAV", "uncrewed" -> uas_drones. "Satellite", "launch", "orbit" -> space.
- "First-time grant recipient", "first grant", "new to government funding" -> firstTimeGrantRecipient: true.
- A year in the request ("in 2026", "since 2023") is a date filter, not a topic word. "Got their first grant in 2026" -> firstGrantAfter "2026-01-01". "Appeared in the data since 2022" -> firstSeenAfter "2022-01-01". Say in "notes" exactly which date field you used, and that these are dates in the government data, not company founding dates.
- Founding year, number of employees, owners and products are not in the data: do not filter on them and list them under "unknowns". If the user asks for them, say what the data can and cannot answer.
- Keep tier A unless the user asks for ordinary suppliers (then add B or C) or for everything.
- If a search returns nothing, widen it once (drop the narrowest filter) and say you did. If it returns more than the user can read, give the best 10 and say how many matched in total.
- If the request is too vague to search (for example "good companies"), ask one short clarifying question in "summary" with an empty "leads" list.
- Refuse requests to rank companies as investments, to give investment advice, or to name private individuals. Say so in "summary".
Answer size and format (the answer must always be complete, valid JSON):
- Return at most 10 leads, ranked best first. If more matched, say the total count in "summary".
- At most 3 claims per lead, each one short, and copy each source object exactly once as the tool gave it. Do not repeat the same claim or source on several leads.
- Keep "whyMatched" and every "note" to one sentence. Never include commentary or markdown outside the JSON object.
- If the data does not support the filters the user asked for (for example the first-grant date does not fall in the requested year), leave that company out. Do not include near misses to fill the list; say how many you left out in "notes".
- Be honest and plain: say what the data shows, what it cannot show, and never overstate. A grant or contract is not proof of a product, a customer, an investment or an endorsement.
Style of the answer: "summary" is two or three plain sentences with the count, the filters used and the main caveat. "whyMatched" is one sentence per company naming the programme, department or tag that matched. Put amounts in Canadian dollars exactly as the rows state them. Never claim a company is verified, eligible or recommended.`;

export interface AgentLimits {
  /** Model turns that call tools. */
  maxToolSteps: number;
  /** All model requests for one question, repairs included. */
  maxRequests: number;
  maxOutputTokens: number;
  /** Characters of one tool result sent back to the model. */
  maxToolResultChars: number;
}
export const DEFAULT_LIMITS: AgentLimits = {
  maxToolSteps: 8,
  maxRequests: 12,
  maxOutputTokens: 4000,
  maxToolResultChars: 24_000,
};

export interface AgentResult {
  answer: Answer;
  /** "model": the model's answer passed the checks. "fallback": plain search result. */
  source: "model" | "fallback";
  requests: number;
  toolSteps: number;
  note?: string;
}

/** Cut a search result down to a size the model can read, dropping the lowest-ranked cards. */
export function fitResult(value: unknown, maxChars: number): string {
  let text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  const v = value as { total?: number; cards?: unknown[] };
  if (Array.isArray(v?.cards)) {
    let cards = v.cards;
    while (cards.length > 1 && JSON.stringify({ ...v, cards, truncated: true }).length > maxChars)
      cards = cards.slice(0, Math.max(1, Math.floor(cards.length * 0.7)));
    text = JSON.stringify({ ...v, cards, truncated: true });
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the final message");
  return JSON.parse(body.slice(start, end + 1));
}

async function plainFallback(store: LeadStore, question: string, why: string): Promise<Answer> {
  const r = await searchLeads(store, { text: question, limit: 10 });
  return {
    question,
    summary: `The model's answer could not be used (${why}). These are the top plain keyword-search results for the question, tier A.`,
    leads: r.cards.map((c) => ({
      key: c.key,
      name: c.name,
      tier: c.tier,
      whyMatched: `Keyword match on: ${[...new Set(c.matchedOn.flatMap((m) => m.terms))].slice(0, 6).join(", ") || "tier A listing"}`,
      claims: c.claims,
      unknowns: c.unknowns,
    })),
    searchesRun: [JSON.stringify({ text: question, tiers: ["A"], limit: 10 })],
    notes: [`${r.total} tier A companies matched the plain search; showing ${r.cards.length}.`],
    label: LEAD_LABEL,
  };
}

/** Web pages the model may cite: only those a tool returned. */
function allowedWeb(results: unknown[]): Set<string> {
  const urls = new Set<string>();
  for (const r of results) {
    const pages = (r as { pages?: { url?: string }[] } | null)?.pages;
    if (Array.isArray(pages)) for (const p of pages) if (p?.url) urls.add(p.url);
  }
  return urls;
}

async function validateFinal(
  text: string,
  store: LeadStore,
  webAllowed: Set<string>,
): Promise<{ ok: true; answer: Answer } | { ok: false; why: string }> {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, why: errorText(e) };
  }
  const parsed = Answer.safeParse(raw);
  if (!parsed.success)
    return { ok: false, why: `not a valid Answer: ${z.prettifyError(parsed.error).slice(0, 400)}` };
  const problems = await checkAnswerCitations(store, parsed.data);
  for (const l of parsed.data.leads)
    for (const c of l.claims)
      for (const s of c.sources)
        if (s.kind === "web" && !webAllowed.has(s.url))
          problems.push(`${l.name}: web source ${s.url} was not returned by any tool`);
  if (problems.length)
    return { ok: false, why: `citation problems: ${problems.slice(0, 4).join("; ")}` };
  return { ok: true, answer: parsed.data };
}

export async function runAgent(opts: {
  model: ChatModel;
  question: string;
  store: LeadStore;
  limits?: Partial<AgentLimits>;
  web?: ToolContext["web"];
  /** Secrets to strip from anything reported back (the key itself is never passed in here). */
  log?: (line: string) => void;
}): Promise<AgentResult> {
  const lim = { ...DEFAULT_LIMITS, ...opts.limits };
  const ctx: ToolContext = { store: opts.store, web: opts.web, maxSearchLimit: 15 };
  const tools = toolDefs();
  const messages: ChatMessage[] = [{ role: "user", text: opts.question }];
  const toolResults: unknown[] = [];
  let requests = 0;
  let toolSteps = 0;
  let repaired = false;
  const log = opts.log ?? (() => {});

  const fail = async (why: string): Promise<AgentResult> => ({
    answer: await plainFallback(opts.store, opts.question, why),
    source: "fallback",
    requests,
    toolSteps,
    note: why,
  });

  while (requests < lim.maxRequests) {
    const noMoreTools = toolSteps >= lim.maxToolSteps;
    requests++;
    let res: CompleteResult;
    try {
      res = await opts.model.complete({
        system: `${AGENT_SYSTEM}

${AGENT_GUIDE}`,
        messages,
        tools: noMoreTools ? [] : tools,
        maxOutputTokens: lim.maxOutputTokens,
      });
    } catch (e) {
      if (e instanceof NoKeyError) throw e;
      return fail(errorText(e));
    }

    if ("toolCalls" in res && res.toolCalls.length) {
      if (noMoreTools) return fail(`the model kept calling tools after ${lim.maxToolSteps} steps`);
      toolSteps++;
      messages.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        let content: string;
        if (call.parseError)
          content = JSON.stringify({ error: `${call.parseError}; send valid JSON arguments` });
        else {
          const out = await runTool(ctx, call.name, call.arguments);
          if (out.ok) {
            toolResults.push(out.result);
            content = fitResult(out.result, lim.maxToolResultChars);
          } else content = JSON.stringify({ error: out.error });
        }
        log(`tool ${call.name}`);
        messages.push({ role: "tool", callId: call.id, name: call.name, content });
      }
      continue;
    }

    const text = ("text" in res ? res.text : "") ?? "";
    const v = await validateFinal(text, opts.store, allowedWeb(toolResults));
    if (v.ok) return { answer: v.answer, source: "model", requests, toolSteps };
    if (!repaired && requests < lim.maxRequests) {
      repaired = true;
      messages.push({ role: "assistant", text });
      messages.push({
        role: "user",
        text: `Your final message was not accepted: ${v.why}. Reply again with ONE corrected JSON object only, copying sources exactly from the tool results.`,
      });
      continue;
    }
    return fail(v.why);
  }
  return fail(`the request cap of ${lim.maxRequests} was reached`);
}

// ---- Test double ---------------------------------------------------------------------------------

/** A scripted model for tests: replies come from a list or a function; nothing leaves the process. */
export class FakeChatModel implements ChatModel {
  readonly id = "fake";
  readonly requests: CompleteRequest[] = [];
  private i = 0;
  constructor(
    private readonly script:
      CompleteResult[] | ((req: CompleteRequest, n: number) => CompleteResult),
  ) {}
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.requests.push(structuredClone(req));
    const n = this.i++;
    if (typeof this.script === "function") return this.script(req, n);
    const r = this.script[Math.min(n, this.script.length - 1)];
    if (!r) throw new Error("fake model has no reply");
    return r;
  }
}
