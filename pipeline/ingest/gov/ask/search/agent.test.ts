// API mode, tested with scripted fake models and fake fetch only. No network, no real key.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  anthropic,
  FakeChatModel,
  fitResult,
  NoKeyError,
  openaiCompatible,
  redact,
  runAgent,
  SearchProviders,
  type CompleteRequest,
  type FetchLike,
} from "./agent";
import { askCommand } from "./askCommand";
import { store } from "./fixtures";
import { LEAD_LABEL, type LeadCard } from "./schema";
import type { WebProvider } from "./web";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SECRET = "sk-test-SECRET-0123456789";

type Card = Pick<LeadCard, "key" | "name" | "tier" | "claims" | "unknowns">;

/** The cards of the most recent search_leads tool result in a request. */
function lastCards(req: CompleteRequest): Card[] {
  for (const m of [...req.messages].reverse())
    if (m.role === "tool" && m.name === "search_leads")
      return JSON.parse(m.content).cards as Card[];
  throw new Error("no search result in the conversation");
}

const answerJson = (cards: Card[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    question: "q",
    summary: "s",
    leads: cards.map((c) => ({
      key: c.key,
      name: c.name,
      tier: c.tier,
      whyMatched: "matched",
      claims: c.claims,
      unknowns: c.unknowns,
    })),
    searchesRun: ["search_leads"],
    notes: [],
    label: LEAD_LABEL,
    ...extra,
  });

const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: args });

describe("runAgent", () => {
  it("runs search, get and a final cited answer", async () => {
    const model = new FakeChatModel((req, n) => {
      if (n === 0) return { toolCalls: [call("1", "search_leads", { text: "drone" })] };
      if (n === 1)
        return { toolCalls: [call("2", "get_company", { key: lastCards(req)[0]!.key })] };
      return { text: "```json\n" + answerJson(lastCards(req).slice(0, 1)) + "\n```" };
    });
    const r = await runAgent({ model, question: "drone firms?", store: store() });
    expect(r.source).toBe("model");
    expect(r.toolSteps).toBe(2);
    expect(r.requests).toBe(3);
    expect(r.answer.leads[0]!.key).toBe("k-drone");
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual([
      "search_leads",
      "get_company",
      "web_lookup",
    ]);
    expect(model.requests[0]!.system).toMatch(/ONLY the tools/);
    expect(model.requests[0]!.system).toMatch(/PitchBook/);
  });

  it("returns malformed, unknown and invalid tool calls to the model as errors", async () => {
    const model = new FakeChatModel((_req, n) => {
      if (n === 0)
        return {
          toolCalls: [
            call("1", "no_such_tool", {}),
            { id: "2", name: "search_leads", parseError: "the arguments were not valid JSON" },
            call("3", "search_leads", { tags: ["not_a_tag"] }),
            call("4", "get_company", {}),
          ],
        };
      return { text: answerJson([]) };
    });
    const r = await runAgent({ model, question: "q", store: store() });
    expect(r.source).toBe("model");
    const tool = model.requests[1]!.messages.filter((m) => m.role === "tool");
    expect(tool).toHaveLength(4);
    for (const m of tool) expect(JSON.parse((m as { content: string }).content).error).toBeTruthy();
  });

  it("falls back to the plain search when the answer cites a row that does not match", async () => {
    const model = new FakeChatModel((req, n) => {
      if (n === 0) return { toolCalls: [call("1", "search_leads", { text: "drone" })] };
      const cards = lastCards(req);
      const bad = structuredClone(cards);
      (bad[0]!.claims[0]!.sources[0] as { value: number }).value = 123456789;
      return { text: answerJson(bad) };
    });
    const r = await runAgent({ model, question: "drone", store: store() });
    expect(r.source).toBe("fallback");
    expect(r.note).toMatch(/citation problems/);
    expect(r.requests).toBe(3); // search, answer, one repair
    expect(r.answer.summary).toMatch(/could not be used/);
    expect(r.answer.leads.length).toBeGreaterThan(0);
  });

  it("repairs once: a corrected second answer is accepted", async () => {
    const model = new FakeChatModel((req, n) => {
      if (n === 0) return { toolCalls: [call("1", "search_leads", { text: "drone" })] };
      if (n === 1) return { text: "Here you go, no JSON." };
      return { text: answerJson(lastCards(req).slice(0, 1)) };
    });
    const r = await runAgent({ model, question: "drone", store: store() });
    expect(r.source).toBe("model");
  });

  it("falls back when the final message is not an answer at all", async () => {
    const model = new FakeChatModel([{ text: "I think it is Acme." }]);
    const r = await runAgent({ model, question: "drone", store: store() });
    expect(r.source).toBe("fallback");
    expect(r.answer.label).toBe(LEAD_LABEL);
  });

  it("rejects an answer that cites an invented web page, accepts one a tool returned", async () => {
    const page = { url: "https://example.org/about", title: "About", accessed: "2026-10-18" };
    const web: WebProvider = {
      id: "test",
      lookup: async () => ({ state: "found", pages: [page] }),
    };
    const withWeb = (url: string) =>
      new FakeChatModel((req, n) => {
        if (n === 0) return { toolCalls: [call("1", "search_leads", { text: "drone" })] };
        if (n === 1)
          return {
            toolCalls: [
              call("2", "web_lookup", { name: "Northern Drone Works", question: "founded?" }),
            ],
          };
        const cards = lastCards(req).slice(0, 1);
        cards[0]!.claims = [
          ...cards[0]!.claims,
          {
            text: "Founded in 2019",
            sources: [{ kind: "web", url, title: "About", accessed: "2026-10-18" }],
          },
        ];
        return { text: answerJson(cards) };
      });
    const ok = await runAgent({ model: withWeb(page.url), question: "q", store: store(), web });
    expect(ok.source).toBe("model");
    const bad = await runAgent({
      model: withWeb("https://invented.example/x"),
      question: "q",
      store: store(),
      web,
    });
    expect(bad.source).toBe("fallback");
    expect(bad.note).toMatch(/not returned by any tool/);
  });

  it("stops after the tool-step limit and then offers no tools", async () => {
    const model = new FakeChatModel(() => ({
      toolCalls: [call("x", "search_leads", { text: "drone" })],
    }));
    const r = await runAgent({ model, question: "q", store: store(), limits: { maxToolSteps: 2 } });
    expect(r.source).toBe("fallback");
    expect(r.note).toMatch(/kept calling tools/);
    expect(r.toolSteps).toBe(2);
    expect(model.requests.at(-1)!.tools).toEqual([]);
  });

  it("stops at the request cap", async () => {
    const model = new FakeChatModel(() => ({
      toolCalls: [call("x", "search_leads", { text: "drone" })],
    }));
    const r = await runAgent({
      model,
      question: "q",
      store: store(),
      limits: { maxRequests: 2, maxToolSteps: 8 },
    });
    expect(r.source).toBe("fallback");
    expect(r.requests).toBe(2);
    expect(r.note).toMatch(/request cap/);
  });

  it("passes the output-token limit to the model", async () => {
    const model = new FakeChatModel([{ text: answerJson([]) }]);
    await runAgent({ model, question: "q", store: store(), limits: { maxOutputTokens: 777 } });
    expect(model.requests[0]!.maxOutputTokens).toBe(777);
  });

  it("falls back, with the reason, when the provider fails", async () => {
    const model = new FakeChatModel(() => {
      throw new Error("model provider answered HTTP 500");
    });
    const r = await runAgent({ model, question: "drone", store: store() });
    expect(r.source).toBe("fallback");
    expect(r.note).toMatch(/HTTP 500/);
  });

  it("truncates a very large tool result before the model sees it", () => {
    const cards = Array.from({ length: 30 }, (_, i) => ({ i, pad: "x".repeat(1000) }));
    const text = fitResult({ total: 30, cards }, 5000);
    expect(text.length).toBeLessThanOrEqual(5000);
    expect(JSON.parse(text).truncated).toBe(true);
  });
});

describe("keys never leak", () => {
  const keyless = () => (_: string, __: Record<string, string>) => undefined;

  it("redact strips a secret from any text", () => {
    expect(redact(`bad ${SECRET} here`, [SECRET])).toBe("bad [key] here");
  });

  it("a missing key is a clear error that names the variable, not a value", async () => {
    const m = openaiCompatible({
      baseUrl: "https://example.invalid/v1",
      model: "m",
      keyEnv: "CANDEF_TEST_NO_KEY",
      resolve: keyless(),
    });
    await expect(
      m.complete({ system: "s", messages: [], tools: [], maxOutputTokens: 10 }),
    ).rejects.toBeInstanceOf(NoKeyError);
    await expect(runAgent({ model: m, question: "q", store: store() })).rejects.toThrow(
      /CANDEF_TEST_NO_KEY/,
    );
  });

  it("provider errors and network failures are redacted", async () => {
    const echo: FetchLike = async () => new Response(`invalid key ${SECRET}`, { status: 401 });
    const boom: FetchLike = async () => {
      throw new Error(`connect failed with ${SECRET}`);
    };
    for (const fetch of [echo, boom]) {
      const m = openaiCompatible({
        baseUrl: "https://example.invalid/v1",
        model: "m",
        keyEnv: "K",
        resolve: () => SECRET,
        fetch,
      });
      const err = await m
        .complete({ system: "s", messages: [], tools: [], maxOutputTokens: 10 })
        .catch((e: Error) => e);
      expect((err as Error).message).not.toContain(SECRET);
      expect((err as Error).message).toMatch(/provider|request/);
    }
  });

  it("the agent's fallback note does not contain the key", async () => {
    const fetch: FetchLike = async () => new Response(`bad key ${SECRET}`, { status: 401 });
    const m = openaiCompatible({
      baseUrl: "https://example.invalid/v1",
      model: "m",
      keyEnv: "K",
      resolve: () => SECRET,
      fetch,
    });
    const r = await runAgent({ model: m, question: "drone", store: store() });
    expect(r.source).toBe("fallback");
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("the config schema holds names of variables, never keys", () => {
    const good = {
      providers: [{ name: "a", kind: "anthropic", model: "m", keyEnv: "ANTHROPIC_API_KEY" }],
    };
    expect(SearchProviders.safeParse(good).success).toBe(true);
    expect(
      SearchProviders.safeParse({ providers: [{ ...good.providers[0], keyEnv: "sk-ant-abc-123" }] })
        .success,
    ).toBe(false);
    expect(
      SearchProviders.safeParse({ providers: [{ ...good.providers[0], apiKey: "x" }] }).success,
    ).toBe(false);
  });
});

describe("adapters (fake fetch)", () => {
  const history: CompleteRequest["messages"] = [
    { role: "user", text: "find drones" },
    {
      role: "assistant",
      text: "searching",
      toolCalls: [{ id: "c1", name: "search_leads", arguments: { text: "drone" } }],
    },
    { role: "tool", callId: "c1", name: "search_leads", content: '{"total":0}' },
  ];
  const tools = [{ name: "search_leads", description: "d", parameters: { type: "object" } }];

  it("openai-compatible: request shape, tool call parsing and malformed arguments", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Json } | null = null;
    const fetch: FetchLike = async (url, init) => {
      seen = {
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      };
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "a", function: { name: "search_leads", arguments: '{"text":"x"}' } },
                { id: "b", function: { name: "search_leads", arguments: "{not json" } },
              ],
            },
          },
        ],
      });
    };
    const m = openaiCompatible({
      baseUrl: "https://example.invalid/v1/",
      model: "m1",
      keyEnv: "K",
      resolve: () => SECRET,
      fetch,
    });
    const res = (await m.complete({
      system: "SYS",
      messages: history,
      tools,
      maxOutputTokens: 55,
    })) as { toolCalls: Json[] };
    expect(seen!.url).toBe("https://example.invalid/v1/chat/completions");
    expect(seen!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen!.body.max_tokens).toBe(55);
    expect(seen!.body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(seen!.body.messages[2].tool_calls[0].function.arguments).toBe('{"text":"drone"}');
    expect(seen!.body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(seen!.body.tools[0].function.name).toBe("search_leads");
    expect(res.toolCalls[0].arguments).toEqual({ text: "x" });
    expect(res.toolCalls[1].parseError).toMatch(/not valid JSON/);
  });

  it("openai-compatible: a plain text reply", async () => {
    const fetch: FetchLike = async () =>
      Response.json({ choices: [{ message: { content: "hello" } }] });
    const m = openaiCompatible({
      baseUrl: "https://example.invalid/v1",
      model: "m",
      keyEnv: "K",
      resolve: () => SECRET,
      fetch,
    });
    expect(await m.complete({ system: "s", messages: [], tools: [], maxOutputTokens: 5 })).toEqual({
      text: "hello",
    });
  });

  it("anthropic: request shape (tool results merged into one user turn) and tool_use parsing", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Json } | null = null;
    const fetch: FetchLike = async (url, init) => {
      seen = {
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      };
      return Response.json({
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "get_company", input: { key: "k" } },
        ],
      });
    };
    const m = anthropic({ model: "claude-x", keyEnv: "K", resolve: () => SECRET, fetch });
    const two: CompleteRequest["messages"] = [
      ...history,
      { role: "tool", callId: "c2", name: "get_company", content: "{}" },
    ];
    const res = (await m.complete({ system: "SYS", messages: two, tools, maxOutputTokens: 9 })) as {
      toolCalls: Json[];
      text?: string;
    };
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen!.headers["x-api-key"]).toBe(SECRET);
    expect(seen!.headers["anthropic-version"]).toBeTruthy();
    expect(seen!.body.system).toBe("SYS");
    expect(seen!.body.tools[0].input_schema).toEqual({ type: "object" });
    const roles = seen!.body.messages.map((x: Json) => x.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(seen!.body.messages[2].content.map((b: Json) => b.type)).toEqual([
      "tool_result",
      "tool_result",
    ]);
    expect(res.toolCalls[0]).toMatchObject({
      id: "t1",
      name: "get_company",
      arguments: { key: "k" },
    });
    expect(res.text).toBe("ok");
  });
});

describe("ask command", () => {
  async function setup(withKey: boolean) {
    const root = await mkdtemp(join(tmpdir(), "leads-ask-"));
    const dir = join(root, "research-cache", "grant-ask");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "search-providers.json"),
      JSON.stringify({
        providers: [
          {
            name: "t",
            kind: "openai",
            model: "m",
            keyEnv: "CANDEF_TEST_ASK_KEY",
            baseUrl: "https://example.invalid/v1",
          },
        ],
      }),
    );
    if (withKey) await writeFile(join(dir, "keys.env"), `CANDEF_TEST_ASK_KEY=${SECRET}\n`);
    return root;
  }

  it("explains how to add a key when none is set, without printing anything secret", async () => {
    const root = await setup(false);
    const lines: string[] = [];
    const code = await askCommand(store(), root, "drones?", undefined, (s) => lines.push(s));
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/CANDEF_TEST_ASK_KEY/);
    expect(lines.join("\n")).toMatch(/keys\.env/);
  });

  it("asks for a provider file when there is none", async () => {
    const root = await mkdtemp(join(tmpdir(), "leads-ask-"));
    const lines: string[] = [];
    expect(await askCommand(store(), root, "q", undefined, (s) => lines.push(s))).toBe(1);
    expect(lines.join("\n")).toMatch(/search-providers\.json/);
  });

  it("runs end to end over a fake HTTP layer and never prints the key", async () => {
    const root = await setup(true);
    let calls = 0;
    let sawKey = false;
    const fetch: FetchLike = async (_url, init) => {
      calls++;
      if ((init.headers as Record<string, string>).authorization === `Bearer ${SECRET}`)
        sawKey = true;
      const body = JSON.parse(String(init.body));
      if (calls === 1)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "1", function: { name: "search_leads", arguments: '{"text":"drone"}' } },
                ],
              },
            },
          ],
        });
      const toolMsg = body.messages.find((m: Json) => m.role === "tool");
      const cards = JSON.parse(toolMsg.content).cards as Card[];
      return Response.json({ choices: [{ message: { content: answerJson(cards.slice(0, 1)) } }] });
    };
    const lines: string[] = [];
    const code = await askCommand(
      store(),
      root,
      "drone firms?",
      undefined,
      (s) => lines.push(s),
      fetch,
    );
    expect(code).toBe(0);
    expect(sawKey).toBe(true);
    const printed = lines.join("\n");
    expect(printed).toContain("Northern Drone Works");
    expect(printed).toContain("citations checked");
    expect(printed).not.toContain(SECRET);
  });
});
