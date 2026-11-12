/**
 * `npm run leads -- ask "<question>"`: API mode. Reads research-cache/grant-ask/search-providers.json
 * (provider names and key variable NAMES, never keys) and the optional keys.env, runs the agent and
 * prints the checked answer. Refuses with a plain message when no key is available.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { modelFromConfig, NoKeyError, runAgent, SearchProviders, type FetchLike } from "./agent";
import { answerMd } from "./card";
import type { LeadStore } from "./index";

export const EXAMPLE_CONFIG = {
  default: "claude",
  providers: [
    { name: "claude", kind: "anthropic", model: "claude-haiku-5-5", keyEnv: "ANTHROPIC_API_KEY" },
    {
      name: "groq",
      kind: "openai",
      model: "<model id>",
      keyEnv: "GROQ_API_KEY",
      baseUrl: "https://api.groq.com/openai/v1",
    },
  ],
};

export async function askCommand(
  store: LeadStore,
  root: string,
  question: string,
  configPath: string | undefined,
  out: (s: string) => void,
  fetchImpl?: FetchLike,
): Promise<number> {
  const dir = join(root, "research-cache", "grant-ask");
  const cfgFile = configPath ? resolve(configPath) : join(dir, "search-providers.json");
  if (!existsSync(cfgFile)) {
    out(
      `API mode needs a provider file at ${cfgFile}. Create it like this (it holds the NAME of the key variable, never the key):\n${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\nThen add the key as described in docs/LEADS_SEARCH.md.`,
    );
    return 1;
  }
  const cfg = SearchProviders.parse(JSON.parse(await readFile(cfgFile, "utf8")));
  const keysFile = join(dir, "keys.env");
  const keysText = existsSync(keysFile) ? await readFile(keysFile, "utf8") : "";
  const { model, maxOutputTokens } = modelFromConfig(cfg, undefined, keysText, fetchImpl);
  try {
    const r = await runAgent({
      model,
      question,
      store,
      limits: maxOutputTokens ? { maxOutputTokens } : undefined,
      log: (l) => out(`  (${l})`),
    });
    out(answerMd(r.answer));
    out(
      `\n[${r.source === "model" ? "model answer, citations checked against the stored rows" : `plain search fallback: ${r.note}`}; ${r.requests} model request(s), ${r.toolSteps} tool step(s)]`,
    );
    return r.source === "model" ? 0 : 2;
  } catch (e) {
    if (e instanceof NoKeyError) {
      out(e.message);
      return 1;
    }
    throw e;
  }
}
