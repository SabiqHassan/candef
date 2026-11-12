/**
 * Model-backed triage judge. Nothing here runs unless the owner sets CANDEF_JUDGE_API_KEY in their
 * own terminal AND passes an explicit spending cap and --yes. The key is read from the environment
 * only: never logged, never written to a file, never part of a request log.
 *
 * The Anthropic SDK is loaded on demand, only inside a run that has a key, so installing it is a
 * separate, deliberate step and this module adds no dependency. Tests use FakeClient (no network).
 */
import {
  parseVerdictLines,
  TRIAGE_INSTRUCTIONS,
  type TriageJudge,
  type TriageLine,
} from "./triage";

export interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}
export interface ModelClient {
  complete(args: { system: string; user: string; maxTokens: number }): Promise<Completion>;
}

/** List prices, USD per million tokens (cached from the API skill 2026-10-06; re-check before a run). */
export const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** Rough token count for planning only (about 3.5 characters per token); real usage is metered. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

/** Estimated cost of triaging `texts` in batches: instructions repeat per batch, ~25 output tokens each. */
export function estimateCost(texts: string[], batchSize: number, model: string): CostEstimate {
  const price = PRICES[model];
  if (!price) throw new Error(`no price known for ${model}`);
  const batches = Math.ceil(texts.length / batchSize);
  const inputTokens =
    texts.reduce((s, t) => s + estimateTokens(t), 0) +
    batches * estimateTokens(TRIAGE_INSTRUCTIONS);
  const outputTokens = texts.length * 25;
  return {
    inputTokens,
    outputTokens,
    usd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000,
  };
}

export class BudgetExceeded extends Error {}

export class ApiTriageJudge implements TriageJudge {
  readonly name: string;
  spentUsd = 0;
  calls = 0;

  constructor(
    private readonly client: ModelClient,
    private readonly model: string,
    private readonly maxUsd: number,
  ) {
    if (!PRICES[model]) throw new Error(`no price known for ${model}`);
    if (!(maxUsd > 0)) throw new Error("a positive --max-usd cap is required");
    this.name = `api:${model}`;
  }

  async judgeBatch(profiles: { n: number; text: string }[]): Promise<TriageLine[]> {
    const user = profiles.map((p) => p.text).join("\n\n");
    // Refuse before the call if even the estimated cost of this batch would pass the cap.
    const price = PRICES[this.model]!;
    const worst =
      (estimateTokens(TRIAGE_INSTRUCTIONS + user) * price.input +
        profiles.length * 40 * price.output) /
      1_000_000;
    if (this.spentUsd + worst > this.maxUsd)
      throw new BudgetExceeded(
        `stopping: spent $${this.spentUsd.toFixed(4)} and the next batch could cost $${worst.toFixed(4)}, over the $${this.maxUsd} cap`,
      );
    const done = await this.client.complete({
      system: TRIAGE_INSTRUCTIONS,
      user,
      maxTokens: Math.max(256, profiles.length * 40),
    });
    this.calls++;
    this.spentUsd +=
      (done.inputTokens * price.input + done.outputTokens * price.output) / 1_000_000;
    return parseVerdictLines(done.text);
  }
}

/** Deterministic client for tests: answers from a function, counts usage by text length. */
export class FakeClient implements ModelClient {
  calls = 0;
  constructor(private readonly answer: (user: string) => string) {}
  async complete(args: { system: string; user: string; maxTokens: number }): Promise<Completion> {
    this.calls++;
    const text = this.answer(args.user);
    return {
      text,
      inputTokens: estimateTokens(args.system + args.user),
      outputTokens: estimateTokens(text),
    };
  }
}

/** Real client. Refuses without a key; refuses if the SDK is not installed; never logs the key. */
export async function anthropicClient(model: string): Promise<ModelClient> {
  const key = process.env.CANDEF_JUDGE_API_KEY;
  if (!key) throw new Error("CANDEF_JUDGE_API_KEY is not set; no request was made");
  const sdkName = "@anthropic-ai/sdk";
  let mod: { default: new (o: { apiKey: string }) => unknown };
  try {
    mod = (await import(/* @vite-ignore */ sdkName)) as typeof mod;
  } catch {
    throw new Error(
      "the Anthropic SDK is not installed (npm install @anthropic-ai/sdk); no request was made",
    );
  }
  const sdk = new mod.default({ apiKey: key }) as {
    messages: {
      create(p: Record<string, unknown>): Promise<{
        content: { type: string; text?: string }[];
        usage: { input_tokens: number; output_tokens: number };
      }>;
    };
  };
  return {
    async complete({ system, user, maxTokens }) {
      const r = await sdk.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        // Triage is a one-word judgement per company: low effort keeps the cost at the floor.
        output_config: { effort: "low" },
        messages: [{ role: "user", content: user }],
      });
      const text = r.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n");
      return { text, inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens };
    },
  };
}
