/**
 * The tools of the leads agent: search_leads, get_company, web_lookup. One definition list serves the
 * CLI (`leads tools`), the API-mode agent and the tests, so the three always agree.
 */
import { z } from "zod";
import { getCompany, searchLeads, type LeadStore } from "./index";
import { GetCompanyArgs, SearchQuery, WebLookupArgs } from "./schema";
import { webLookup, type WebProvider } from "./web";

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

const schema = (s: z.ZodType) => {
  const j = z.toJSONSchema(s, { io: "input" }) as Record<string, unknown>;
  delete j.$schema;
  return j;
};

export const TOOL_NAMES = ["search_leads", "get_company", "web_lookup"] as const;

export function toolDefs(): ToolDef[] {
  return [
    {
      name: "search_leads",
      description:
        "Search the index of companies in Canadian federal grants and contracts data that may have a defence, security or space link. Returns ranked lead cards; every claim on a card lists the government rows behind it. Leads are unverified. Default tier is A (strongest link).",
      parameters: schema(SearchQuery),
    },
    {
      name: "get_company",
      description:
        "One company by its key (from a search result): the full index row, every stored government row, and its card.",
      parameters: schema(GetCompanyArgs),
    },
    {
      name: "web_lookup",
      description:
        "Look up a fact the government data does not hold (founding year, what the company makes). May answer not_researched or not_configured; then report the fact as unknown.",
      parameters: schema(WebLookupArgs),
    },
  ];
}

export interface ToolContext {
  store: LeadStore;
  web?: WebProvider;
  /** Largest `limit` a model may ask for in one search (keeps replies small). */
  maxSearchLimit?: number;
}

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: string };

/** Run a tool by name. Bad arguments come back as an error the model can read, never as a throw. */
export async function runTool(ctx: ToolContext, name: string, args: unknown): Promise<ToolOutcome> {
  try {
    if (name === "search_leads") {
      const q = SearchQuery.parse(args ?? {});
      q.limit = Math.min(q.limit, ctx.maxSearchLimit ?? 25);
      const r = await searchLeads(ctx.store, q);
      return { ok: true, result: r };
    }
    if (name === "get_company") {
      const { key } = GetCompanyArgs.parse(args);
      const c = await getCompany(ctx.store, key);
      return c ? { ok: true, result: c } : { ok: false, error: `no company with key ${key}` };
    }
    if (name === "web_lookup") {
      const a = WebLookupArgs.parse(args);
      return { ok: true, result: await webLookup(a.name, a.question, ctx.web) };
    }
    return { ok: false, error: `unknown tool ${name}` };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof z.ZodError ? `bad arguments: ${z.prettifyError(e)}` : errorText(e),
    };
  }
}

/** An error message that cannot carry a secret: the first line only, no environment values. */
export function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 300);
}
