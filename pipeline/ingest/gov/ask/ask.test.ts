// Fictional companies only. No network, no key, no real data.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiTriageJudge, BudgetExceeded, estimateCost, FakeClient, anthropicClient } from "./api";
import { ingestMarkdown, ingestReport } from "./ingestMd";
import { parseKeysFile, runPool } from "./pool";
import { existsSync } from "node:fs";
import { chunkStatus, exportChunks, importVerdicts } from "./manual";
import { ProfileBuilder } from "./profiles";
import { safetyNetSignals, weakNotes } from "./signals";
import {
  finalise,
  formatProfile,
  parseVerdictLines,
  stripMarkdownLinks,
  profileHash,
  runTriage,
  type TriageJudge,
} from "./triage";
import { reportText, sample, sliceProfiles } from "./cli";

const grant = (o: Record<string, string>): Record<string, string> => ({
  recipient_type: "F",
  recipient_legal_name: "Acme Drones Inc.",
  recipient_business_number: "123456789RC0001",
  recipient_city: "Ottawa",
  recipient_province: "ON",
  recipient_postal_code: "K1N 5M3",
  agreement_start_date: "2024-01-01",
  ref_number: "R1",
  amendment_number: "0",
  agreement_value: "1000",
  prog_name_en: "Industrial Research Assistance Program",
  owner_org: "nrc-cnrc",
  owner_org_title: "National Research Council Canada",
  agreement_title_en: "Drone navigation",
  description_en: "A project",
  ...o,
});
const contract = (o: Record<string, string>): Record<string, string> => ({
  vendor_name: "Acme Drones Inc.",
  vendor_postal_code: "K1N",
  contract_date: "2025-01-01",
  contract_value: "5000",
  description_en: "Engineering services",
  owner_org: "dnd-mdn",
  owner_org_title: "National Defence | Défense nationale",
  reference_number: "C-1",
  ...o,
});

function build(grants: Record<string, string>[], contracts: Record<string, string>[]) {
  const b = new ProfileBuilder();
  for (const g of grants) b.addGrant(g);
  for (const c of contracts) b.addContract(c);
  return { profiles: b.finish(), stats: b.stats };
}

describe("profiles", () => {
  it("groups by business number, skips individuals, keeps the latest amendment of an agreement", () => {
    const { profiles, stats } = build(
      [
        grant({}),
        grant({ amendment_number: "1", agreement_value: "2500" }),
        grant({ recipient_type: "P", recipient_legal_name: "Some Person" }),
        grant({ ref_number: "R2", agreement_value: "300" }),
      ],
      [],
    );
    expect(profiles).toHaveLength(1);
    expect(stats.skippedNotCompany).toBe(1);
    expect(profiles[0]!.grantCount).toBe(2);
    expect(profiles[0]!.grantValue).toBe(2800); // 2500 (latest amendment) + 300
  });

  it("links a contract only by exact name and postal area; a different area starts its own profile", () => {
    const { profiles, stats } = build(
      [grant({})],
      [contract({}), contract({ vendor_postal_code: "T2N", reference_number: "C-2" })],
    );
    expect(stats.contractsLinked).toBe(1);
    expect(stats.contractOnlyCompanies).toBe(1);
    expect(profiles).toHaveLength(2);
    const acme = profiles.find((p) => p.businessNumber === "123456789")!;
    expect(acme.contractCount).toBe(1);
    expect(acme.lines.some((l) => l.kind === "contract")).toBe(true);
  });

  it("leaves a contract unlinked when its name and area fit two companies", () => {
    const { stats } = build(
      [grant({}), grant({ recipient_business_number: "987654321RC0001", ref_number: "R9" })],
      [contract({})],
    );
    expect(stats.contractsAmbiguous).toBe(1);
    expect(stats.contractsLinked).toBe(0);
  });

  it("counts a repeated contract row once", () => {
    const { profiles } = build([grant({})], [contract({}), contract({})]);
    expect(profiles[0]!.contractCount).toBe(1);
  });

  it("creates a profile for a vendor that has contracts but no grants", () => {
    const { profiles } = build([], [contract({ vendor_name: "Contract Only Ltd." })]);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.grantCount).toBe(0);
    expect(profiles[0]!.contractCount).toBe(1);
  });

  it("puts defence rows first in the kept lines", () => {
    const { profiles } = build(
      [
        grant({ ref_number: "A", agreement_start_date: "2025-06-01" }),
        grant({
          ref_number: "B",
          agreement_start_date: "2019-01-01",
          owner_org: "dnd-mdn",
          prog_name_en: "Innovation for Defence Excellence and Security Program",
        }),
      ],
      [],
    );
    expect(profiles[0]!.lines[0]!.ownerOrg).toBe("dnd-mdn");
  });
});

describe("safety net (never subtract)", () => {
  const withDnd = build([grant({})], [contract({ contract_value: "2000000" })]).profiles[0]!;
  const smallDnd = build([grant({})], [contract({ contract_value: "500" })]).profiles[0]!;
  const plain = build([grant({})], []).profiles[0]!;

  it("finds structured signals", () => {
    expect(safetyNetSignals(withDnd)).toContain("National Defence contract");
    expect(safetyNetSignals(plain)).toEqual([]);
    // Small companies matter: a tiny National Defence contract still counts by default.
    expect(safetyNetSignals(smallDnd)).toContain("National Defence contract");
    // A reader may tighten a list explicitly; that is an option, never the default.
    expect(safetyNetSignals(smallDnd, undefined, { dndContractMinTotal: 1000 })).toEqual([]);
    expect(weakNotes(smallDnd, { dndContractMinTotal: 1000 })[0]).toMatch(/totalling/);
    expect(safetyNetSignals(plain, { businessNumbers: new Set(["123456789"]) })).toContain(
      "already a CANDEF organization",
    );
  });

  it("a 'no' never removes a company with a signal, but removes one without", () => {
    expect(finalise(withDnd, "no", "x", "t").status).toBe("kept_by_safety_net");
    expect(finalise(plain, "no", "x", "t").status).toBe("out");
    expect(finalise(plain, "unsure", "x", "t").status).toBe("in");
    expect(finalise(plain, "yes", "x", "t").status).toBe("in");
  });
});

describe("verdict lines", () => {
  it("parses well-formed lines and rejects anything else", () => {
    expect(parseVerdictLines("001 | yes | National Defence contract\n\n002 | no | farm")).toEqual([
      { n: 1, verdict: "yes", reason: "National Defence contract" },
      { n: 2, verdict: "no", reason: "farm" },
    ]);
    expect(() => parseVerdictLines("001 | maybe | x")).toThrow();
    expect(() => parseVerdictLines("hello")).toThrow();
  });
});

describe("chat-tool citations", () => {
  it("strips appended markdown links before parsing", () => {
    const url = "https://files.example.com/a.txt?X-Amz-Signature=abc&x=1";
    expect(stripMarkdownLinks(`a [src](${url}) b`)).toBe("a  b");
    expect(stripMarkdownLinks("no links [here] (x)")).toBe("no links [here] (x)");
    const lines = parseVerdictLines(`001 | yes | National Defence grant  [files](${url}).`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ n: 1, verdict: "yes" });
    expect(lines[0]!.reason).toContain("National Defence grant");
    expect(lines[0]!.reason).not.toContain("http");
  });
});

describe("triage run", () => {
  const profiles = build(
    [
      grant({}),
      grant({
        recipient_legal_name: "Farm Co",
        recipient_business_number: "222222222RC0001",
        ref_number: "F",
      }),
      grant({
        recipient_legal_name: "Cafe Co",
        recipient_business_number: "333333333RC0001",
        ref_number: "G",
      }),
    ],
    [],
  ).profiles;

  const judgeAll = (verdict: string): TriageJudge => ({
    name: "fake",
    judgeBatch: async (b) => b.map((x) => ({ n: x.n, verdict: verdict as "yes", reason: "r" })),
  });

  it("treats a missing answer as unsure, never no", async () => {
    const silent: TriageJudge = { name: "silent", judgeBatch: async () => [] };
    const r = await runTriage(profiles, silent, { batchSize: 2 });
    expect(r.every((x) => x.verdict === "unsure" && x.status === "in")).toBe(true);
  });

  it("reuses cached verdicts for an unchanged profile (a rerun costs nothing)", async () => {
    const first = await runTriage(profiles, judgeAll("no"), { batchSize: 10 });
    let calls = 0;
    const counting: TriageJudge = {
      name: "fake",
      judgeBatch: async (b) => {
        calls++;
        return b.map((x) => ({ n: x.n, verdict: "yes", reason: "r" }));
      },
    };
    const again = await runTriage(profiles, counting, {
      batchSize: 10,
      cache: new Map(first.map((r) => [r.key, r])),
    });
    expect(calls).toBe(0);
    expect(again.map((r) => r.verdict)).toEqual(first.map((r) => r.verdict));
  });

  it("formats a profile deterministically and hashes it", () => {
    const p = profiles[0]!;
    expect(formatProfile(p, 7)).toBe(formatProfile(p, 7));
    expect(formatProfile(p, 7).startsWith("[007] ")).toBe(true);
    expect(profileHash(p)).toBe(profileHash(p));
  });
});

describe("api judge", () => {
  const profiles = build(
    Array.from({ length: 6 }, (_, i) =>
      grant({
        recipient_legal_name: `Co ${i}`,
        recipient_business_number: `10000000${i}RC0001`,
        ref_number: `X${i}`,
      }),
    ),
    [],
  ).profiles;
  const answer = (user: string) =>
    [...user.matchAll(/^\[(\d{3})\]/gm)].map((m) => `${m[1]} | no | nothing`).join("\n");

  it("judges through a client and meters the spend", async () => {
    const client = new FakeClient(answer);
    const judge = new ApiTriageJudge(client, "claude-haiku-5-5", 5);
    const r = await runTriage(profiles, judge, { batchSize: 3 });
    expect(client.calls).toBe(2);
    expect(judge.spentUsd).toBeGreaterThan(0);
    expect(r.every((x) => x.verdict === "no")).toBe(true);
  });

  it("stops before a batch that could pass the spending cap", async () => {
    const judge = new ApiTriageJudge(new FakeClient(answer), "claude-haiku-5-5", 0.000001);
    await expect(runTriage(profiles, judge, { batchSize: 3 })).rejects.toBeInstanceOf(
      BudgetExceeded,
    );
    expect(judge.calls).toBe(0);
  });

  it("requires a positive cap and a known model", () => {
    expect(() => new ApiTriageJudge(new FakeClient(answer), "claude-haiku-5-5", 0)).toThrow();
    expect(() => new ApiTriageJudge(new FakeClient(answer), "gpt-x", 5)).toThrow();
  });

  it("the real client refuses without a key, before any network access", async () => {
    const saved = process.env.CANDEF_JUDGE_API_KEY;
    delete process.env.CANDEF_JUDGE_API_KEY;
    try {
      await expect(anthropicClient("claude-haiku-5-5")).rejects.toThrow(/not set/);
    } finally {
      if (saved !== undefined) process.env.CANDEF_JUDGE_API_KEY = saved;
    }
  });

  it("estimates cost from list prices", () => {
    const texts = profiles.map((p, i) => formatProfile(p, i + 1));
    const cheap = estimateCost(texts, 3, "claude-haiku-5-5").usd;
    const dear = estimateCost(texts, 3, "claude-opus-5-5").usd;
    expect(dear / cheap).toBeCloseTo(40, 0);
  });
});

describe("manual judging round trip", () => {
  it("exports blind chunks, imports verdicts, keeps the safety net, treats gaps as unsure", async () => {
    const { profiles } = build(
      [
        grant({}),
        grant({
          recipient_legal_name: "Farm Co",
          recipient_business_number: "222222222RC0001",
          ref_number: "F",
        }),
        grant({
          recipient_legal_name: "Cafe Co",
          recipient_business_number: "333333333RC0001",
          ref_number: "G",
        }),
      ],
      [contract({ contract_value: "2000000" })],
    );
    const dir = await mkdtemp(join(tmpdir(), "ask-"));
    const m = await exportChunks(profiles, dir, 2);
    expect(m.chunks).toHaveLength(2);
    const chunk1 = await readFile(join(dir, m.chunks[0]!.file), "utf8");
    expect(chunk1).not.toMatch(/candef|known/i);
    // Chunk 1: company 1 (Acme, has a DND contract) judged no; company 2 judged no. Chunk 2 unanswered.
    await writeFile(join(dir, m.chunks[0]!.verdictFile), "001 | no | x\n002 | no | y\n");
    const { records, missing } = await importVerdicts(dir, profiles);
    expect(missing).toBe(1);
    const acme = records.find((r) => r.name === "Acme Drones Inc.")!;
    expect(acme.status).toBe("kept_by_safety_net");
    const unanswered = records.filter((r) => r.reason === "no answer from judge");
    expect(unanswered).toHaveLength(1);
    expect(unanswered[0]!.status).toBe("in");
  });
});

describe("batches and resume", () => {
  it("slices in order without overlap and rejects bad ranges", () => {
    const a = Array.from({ length: 25 }, (_, i) => i);
    expect(sliceProfiles(a, 0, 10)).toEqual(a.slice(0, 10));
    expect(sliceProfiles(a, 10, 10)).toEqual(a.slice(10, 20));
    expect(sliceProfiles(a, 20, 10)).toEqual(a.slice(20));
    expect(() => sliceProfiles(a, -1, 5)).toThrow();
    expect(() => sliceProfiles(a, 0, 0)).toThrow();
  });
  it("reports which chunks are pending, incomplete or done", async () => {
    const { profiles } = build(
      Array.from({ length: 5 }, (_, i) =>
        grant({
          recipient_legal_name: `Co ${i}`,
          recipient_business_number: `20000000${i}RC0001`,
          ref_number: `Y${i}`,
        }),
      ),
      [],
    );
    const dir = await mkdtemp(join(tmpdir(), "ask-"));
    const m = await exportChunks(profiles, dir, 2); // chunks of 2, 2, 1
    await writeFile(join(dir, m.chunks[0]!.verdictFile), "001 | no | a\n002 | no | b\n");
    await writeFile(join(dir, m.chunks[1]!.verdictFile), "001 | no | a\n");
    const st = await chunkStatus(dir);
    expect(st).toMatchObject({ total: 3, done: 1 });
    expect(st.partial).toEqual([m.chunks[1]!.verdictFile]);
    expect(st.pending).toEqual([m.chunks[1]!.file, m.chunks[2]!.file]);
  });
});

describe("helpers", () => {
  it("samples deterministically", () => {
    const a = Array.from({ length: 50 }, (_, i) => i);
    expect(sample(a, 5, 7)).toEqual(sample(a, 5, 7));
    expect(sample(a, 5, 7)).not.toEqual(sample(a, 5, 8));
  });
  it("reports counts", () => {
    const p = build([grant({})], []).profiles[0]!;
    expect(reportText([finalise(p, "yes", "r", "t")])).toMatch(/1 companies/);
  });
});

describe("ingest-md (chat export to verdict files)", () => {
  const url = "https://files.example.com/a.txt?X-Amz-Signature=abc&x=1";
  async function setup(sizes: number[]) {
    const dir = await mkdtemp(join(tmpdir(), "ask-md-"));
    const manifest = {
      chunkSize: 3,
      chunks: sizes.map((n, i) => {
        const id = String(i + 1).padStart(3, "0");
        return {
          file: `chunk-${id}.txt`,
          verdictFile: `verdicts-${id}.txt`,
          keys: Array.from({ length: n }, (_, j) => `k${i}-${j}`),
        };
      }),
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    return dir;
  }

  it("accepts a chunk through links, fences, bold, bullets and a trailing web-search line", async () => {
    const dir = await setup([3]);
    const md = [
      "Here you go:",
      "**FILE chunk-001.txt**",
      "```",
      `001 | yes | National Defence contract [src](${url})`,
      "- 002 | NO | farm",
      "003 | unsure | could be civil",
      "```",
      "web search used: no",
    ].join("\n");
    const r = await ingestMarkdown(dir, md);
    expect(r.accepted).toEqual(["chunk-001.txt"]);
    expect(r.webSearch).toBe("no");
    const written = await readFile(join(dir, "verdicts-001.txt"), "utf8");
    expect(written).toBe(
      "001 | yes | National Defence contract\n002 | no | farm\n003 | unsure | could be civil\n",
    );
    expect(written).not.toContain("http");
    expect(parseVerdictLines(written)).toHaveLength(3);
  });

  it("rejects a chunk with a missing line and writes nothing", async () => {
    const dir = await setup([3]);
    const r = await ingestMarkdown(dir, "FILE chunk-001.txt\n001 | no | a\n003 | no | c\n");
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0]!.reasons.join()).toContain("missing numbers 2");
    expect(existsSync(join(dir, "verdicts-001.txt"))).toBe(false);
  });

  it("rejects duplicated, extra and malformed lines", async () => {
    const dir = await setup([2, 2, 2]);
    const md = [
      "FILE chunk-001.txt",
      "001 | no | a",
      "001 | yes | again",
      "002 | no | b",
      "FILE chunk-002.txt",
      "001 | no | a",
      "002 | no | b",
      "003 | no | too many",
      "FILE chunk-003.txt",
      "001 | maybe | bad verdict",
      "002 | no | b",
    ].join("\n");
    const r = await ingestMarkdown(dir, md);
    expect(r.accepted).toEqual([]);
    const why = Object.fromEntries(r.rejected.map((x) => [x.chunk, x.reasons.join()]));
    expect(why["chunk-001.txt"]).toContain("duplicated numbers 1");
    expect(why["chunk-002.txt"]).toContain("outside 1-2: 3");
    expect(why["chunk-003.txt"]).toContain("malformed");
    expect(why["chunk-003.txt"]).toContain("missing numbers 1");
  });

  it("reports unknown and absent chunks, warns on web search, and respects --force", async () => {
    const dir = await setup([1, 1]);
    const md =
      "FILE chunk-001.txt\n001 | no | a\nFILE chunk-099.txt\n001 | no | a\nweb search used: yes\n";
    const r = await ingestMarkdown(dir, md);
    expect(r.accepted).toEqual(["chunk-001.txt"]);
    expect(r.unknown).toEqual(["chunk-099.txt"]);
    expect(r.notPresent).toEqual(["chunk-002.txt"]);
    expect(r.webSearch).toBe("yes");
    expect(ingestReport(r)).toContain("WARNING");
    const again = await ingestMarkdown(dir, "FILE chunk-001.txt\n001 | yes | b\n");
    expect(again.skippedExisting).toEqual(["verdicts-001.txt"]);
    expect(await readFile(join(dir, "verdicts-001.txt"), "utf8")).toContain("| no |");
    const forced = await ingestMarkdown(dir, "FILE chunk-001.txt\n001 | yes | b\n", true);
    expect(forced.accepted).toEqual(["chunk-001.txt"]);
  });
});

describe("provider pool", () => {
  const SECRET = "sk-test-SECRET-123";
  async function chunkDir(sizes: number[]) {
    const dir = await mkdtemp(join(tmpdir(), "ask-pool-"));
    const manifest = {
      chunkSize: 3,
      chunks: sizes.map((n, i) => {
        const id = String(i + 1).padStart(3, "0");
        return {
          file: `chunk-${id}.txt`,
          verdictFile: `verdicts-${id}.txt`,
          keys: Array.from({ length: n }, (_, j) => `k${i}-${j}`),
        };
      }),
    };
    await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
    for (let i = 0; i < sizes.length; i++)
      await writeFile(
        join(dir, `chunk-${String(i + 1).padStart(3, "0")}.txt`),
        Array.from(
          { length: sizes[i]! },
          (_, j) => `[${String(j + 1).padStart(3, "0")}] Co ${j}`,
        ).join("\n\n"),
      );
    return dir;
  }
  const reply = (text: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(
      status === 200
        ? JSON.stringify({
            model: "m",
            usage: { total_tokens: 10 },
            choices: [{ message: { content: text } }],
          })
        : "err",
      { status, headers },
    );
  const answer = (user: string) =>
    [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => `${m[1]} | no | civil`).join("\n");
  const userOf = (init: RequestInit) =>
    (JSON.parse(init.body as string).messages as { role: string; content: string }[]).find(
      (m) => m.role === "user",
    )!.content;
  const cfg = (name: string) => ({
    name,
    baseUrl: "https://x.test/v1",
    model: "m",
    keyEnv: `K_${name}`,
  });
  const keys = { K_a: SECRET, K_b: SECRET + "b" };

  it("completes all chunks across providers, validates, and never writes the key", async () => {
    const dir = await chunkDir([3, 3, 2, 3]);
    const s = await runPool({
      dir,
      providers: [cfg("a"), cfg("b")],
      keys,
      fetcher: async (_u, init) => reply(answer(userOf(init))),
    });
    expect(s.done).toBe(4);
    expect(s.failed).toEqual([]);
    expect(await readFile(join(dir, "verdicts-003.txt"), "utf8")).toBe(
      "001 | no | civil\n002 | no | civil\n",
    );
    const all =
      (await readFile(join(dir, "progress.json"), "utf8")) +
      (await readFile(join(dir, "pool-log.jsonl"), "utf8"));
    expect(all).not.toContain("SECRET");
  });

  it("retries a chunk with a dropped line and accepts a good answer", async () => {
    const dir = await chunkDir([3]);
    let calls = 0;
    const s = await runPool({
      dir,
      providers: [cfg("a")],
      keys,
      fetcher: async (_u, init) => {
        calls++;
        const text = answer(userOf(init));
        return reply(calls === 1 ? text.split("\n").slice(0, 2).join("\n") : text);
      },
    });
    expect(calls).toBe(2);
    expect(s.done).toBe(1);
    expect(s.providers.a!.rejected).toBe(1);
  });

  it("waits out a rate limit, and disables a provider whose key is refused", async () => {
    const dir = await chunkDir([2, 2]);
    let limited = false;
    const s = await runPool({
      dir,
      providers: [cfg("a"), cfg("b")],
      keys,
      fetcher: async (_u, init) => {
        const auth = (init.headers as Record<string, string>).authorization;
        if (auth?.includes("SECRET-123b")) return reply("", 401);
        if (!limited) {
          limited = true;
          return reply("", 429, { "retry-after": "0.05" });
        }
        return reply(answer(userOf(init)));
      },
    });
    expect(s.done).toBe(2);
    expect(s.providers.b!.disabled).toContain("refused");
    expect(s.providers.a!.rateLimited + s.providers.b!.rateLimited).toBeLessThanOrEqual(1);
  });

  it("skips finished chunks, honours STOP, and reports unfinished chunks", async () => {
    const dir = await chunkDir([2, 2, 2]);
    await writeFile(join(dir, "verdicts-001.txt"), "001 | no | x\n002 | no | x\n");
    let calls = 0;
    const s = await runPool({
      dir,
      providers: [cfg("a")],
      keys,
      fetcher: async (_u, init) => {
        calls++;
        await writeFile(join(dir, "STOP"), "");
        return reply(answer(userOf(init)));
      },
    });
    expect(calls).toBe(1);
    expect(s.stopped).toBe(true);
    expect(s.done).toBe(2);
  });

  it("marks a chunk failed after repeated bad answers", async () => {
    const dir = await chunkDir([2]);
    const s = await runPool({
      dir,
      providers: [cfg("a")],
      keys,
      maxAttemptsPerChunk: 2,
      fetcher: async () => reply("nonsense"),
    });
    expect(s.failed).toEqual(["chunk-001.txt"]);
    expect(s.done).toBe(0);
  });

  it("parses a keys file", () => {
    expect(parseKeysFile('# c\nA=1\n B = "two" \n\nbad\n')).toEqual({ A: "1", B: "two" });
  });
});
