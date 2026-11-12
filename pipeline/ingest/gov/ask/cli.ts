/**
 * grant-ask: finds companies with a plausible defence, security or space link in the federal grants
 * and contracts data. A judge reads every company profile (no topic keyword decides what it sees);
 * a safety net keeps any company with a structured defence signal. Leads only: all output stays in
 * research-cache/grant-ask/ and nothing is written under research/.
 *
 *   npm run grant-ask -- profiles --grants <grants.csv> --contracts <contracts.csv> --out <dir>
 *   npm run grant-ask -- estimate --profiles <dir>/profiles.jsonl [--model claude-haiku-5-5]
 *   npm run grant-ask -- export   --profiles <dir>/profiles.jsonl --out <chunks dir> [--limit N --seed S]
 *   npm run grant-ask -- export   --profiles <dir>/profiles.jsonl --out <chunks dir> --start 0 --count 10000 --size 100
 *   npm run grant-ask -- status   --dir <chunks dir>
 *   npm run grant-ask -- ingest-md --dir <chunks dir> --file <export.md> [--force]
 *   npm run grant-ask -- pool --dir <chunks dir> --providers <providers.json> [--keys <keys.env>] [--limit-chunks N]
 *   npm run grant-ask -- index    [--profiles <profiles.jsonl> --triage <triage.jsonl> --out <dir>]
 *   npm run grant-ask -- merge    --dirs <batch1>,<batch2> --out <dir>
 *   npm run grant-ask -- import   --dir <chunks dir> --profiles <dir>/profiles.jsonl
 *   npm run grant-ask -- triage   --profiles <dir>/profiles.jsonl --out <dir> --max-usd 10 --yes
 *   npm run grant-ask -- report   --triage <dir>/triage.jsonl
 *
 * `triage` calls a paid model and refuses unless CANDEF_JUDGE_API_KEY is set, a spending cap is given
 * and --yes is passed; the key is never printed or stored.
 */
import { appendFileSync, createReadStream, existsSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadResearchCorpus } from "../../../research/load";
import { businessNumberRoot } from "../../../research/names";
import { readCsv } from "../csv";
import { assertTriageOutputDir } from "../leads/triage";
import { anthropicClient, ApiTriageJudge, BudgetExceeded, estimateCost, PRICES } from "./api";
import { ingestMarkdown, ingestReport } from "./ingestMd";
import { buildIndex } from "./leadIndex";
import { loadProviders, parseKeysFile, runPool } from "./pool";
import { chunkStatus, exportChunks, importVerdicts } from "./manual";
import { ProfileBuilder, type CompanyProfile } from "./profiles";
import type { KnownCompanies } from "./signals";
import { formatProfile, runTriage, type TriageRecord } from "./triage";

/** Only research-cache/grant-ask/ (or deeper); resolved through links. */
export async function assertAskOutputDir(root: string, output: string): Promise<string> {
  const physical = await assertTriageOutputDir(root, output);
  const base = resolve(await assertTriageOutputDir(root, "research-cache/grant-ask/x"), "..");
  const rel = relative(base, physical);
  if (rel.startsWith("..") || rel.split(sep)[0] === "..")
    throw new Error("--out must be inside research-cache/grant-ask/");
  return physical;
}

export function loadKnown(root: string): KnownCompanies {
  const loaded = loadResearchCorpus(join(root, "research"));
  const businessNumbers = new Set<string>();
  for (const a of loaded.corpus?.assertions ?? []) {
    const v = a.value as { system?: string; value?: string } | null;
    if (a.predicate === "registry_id" && v?.system === "cra-bn") {
      const bn = businessNumberRoot(v.value);
      if (bn) businessNumbers.add(bn);
    }
  }
  return { businessNumbers };
}

async function readProfiles(path: string): Promise<CompanyProfile[]> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CompanyProfile);
}
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** Deterministic sample so a run can be repeated exactly. */
export function sample<T>(items: T[], n: number, seed: number): T[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/** An ordered slice (profiles are sorted by key), so batches of a run never overlap. */
export function sliceProfiles<T>(items: T[], start: number, count: number): T[] {
  if (!(start >= 0) || !(count > 0))
    throw new Error("--start must be 0 or more and --count above 0");
  return items.slice(start, start + count);
}

export function reportText(records: TriageRecord[]): string {
  const by = (f: (r: TriageRecord) => string) => {
    const m = new Map<string, number>();
    for (const r of records) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`);
  };
  return [
    `${records.length} companies`,
    "by verdict:",
    ...by((r) => r.verdict),
    "by status:",
    ...by((r) => r.status),
    "safety-net signals:",
    ...by((r) => r.signals.join("; ") || "none").slice(0, 10),
  ].join("\n");
}

export async function main(argv: string[], root = process.cwd()): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values: v } = parseArgs({
    args: rest,
    options: {
      grants: { type: "string" },
      contracts: { type: "string" },
      out: { type: "string" },
      dir: { type: "string" },
      profiles: { type: "string" },
      triage: { type: "string" },
      model: { type: "string", default: "claude-haiku-5-5" },
      batch: { type: "string", default: "50" },
      size: { type: "string", default: "50" },
      limit: { type: "string" },
      start: { type: "string" },
      count: { type: "string" },
      dirs: { type: "string" },
      seed: { type: "string", default: "1" },
      "max-usd": { type: "string" },
      yes: { type: "boolean", default: false },
      file: { type: "string" },
      providers: { type: "string" },
      keys: { type: "string" },
      "limit-chunks": { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  if (cmd === "profiles") {
    if (!v.grants || !v.contracts || !v.out)
      throw new Error("usage: profiles --grants --contracts --out");
    const out = await assertAskOutputDir(root, v.out);
    const b = new ProfileBuilder();
    for await (const r of readCsv(createReadStream(resolve(v.grants)))) b.addGrant(r);
    for await (const r of readCsv(createReadStream(resolve(v.contracts)))) b.addContract(r);
    const profiles = b.finish();
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "profiles.jsonl"), jsonl(profiles));
    await writeFile(
      join(out, "stats.json"),
      JSON.stringify({ ...b.stats, companies: profiles.length }, null, 2),
    );
    console.log(JSON.stringify({ ...b.stats, companies: profiles.length }, null, 2));
    return 0;
  }
  if (cmd === "report") {
    if (!v.triage) throw new Error("usage: report --triage <triage.jsonl>");
    const rows = (await readFile(resolve(v.triage), "utf8")).split("\n").filter(Boolean);
    console.log(reportText(rows.map((l) => JSON.parse(l) as TriageRecord)));
    return 0;
  }
  if (cmd === "status") {
    if (!v.dir) throw new Error("usage: status --dir <chunks dir>");
    const st = await chunkStatus(await assertAskOutputDir(root, v.dir));
    console.log(
      `${st.done}/${st.total} chunks complete; next to judge: ${st.pending.slice(0, 5).join(", ") || "none"}${st.partial.length ? `; incomplete verdict files: ${st.partial.join(", ")}` : ""}`,
    );
    return 0;
  }
  if (cmd === "ingest-md") {
    if (!v.dir || !v.file)
      throw new Error("usage: ingest-md --dir <chunks dir> --file <export.md>");
    const dir = await assertAskOutputDir(root, v.dir);
    const res = await ingestMarkdown(dir, await readFile(resolve(v.file), "utf8"), v.force);
    const st = await chunkStatus(dir);
    const more = st.pending.length > 8 ? ` and ${st.pending.length - 8} more` : "";
    console.log(
      `${ingestReport(res)}\n${st.done}/${st.total} chunks complete; still to judge: ${st.pending.slice(0, 8).join(", ") || "none"}${more}`,
    );
    return res.rejected.length || res.unknown.length ? 1 : 0;
  }
  if (cmd === "pool") {
    if (!v.dir || !v.providers)
      throw new Error(
        "usage: pool --dir <chunks dir> --providers <providers.json> [--keys <keys.env>]",
      );
    const dir = await assertAskOutputDir(root, v.dir);
    const inAsk = async (file: string) =>
      join(await assertAskOutputDir(root, dirname(file)), basename(file));
    const cfgPath = await inAsk(v.providers);
    const keysFile = v.keys ? parseKeysFile(await readFile(await inAsk(v.keys), "utf8")) : {};
    const logFile = join(dir, "pool.log");
    const log = (line: string) => {
      const out = `${new Date().toISOString()} ${line}`;
      console.log(out);
      appendFileSync(
        logFile,
        `${out}
`,
      );
    };
    const summary = await runPool({
      dir,
      providers: loadProviders(cfgPath),
      keys: keysFile,
      limitChunks: v["limit-chunks"] ? Number(v["limit-chunks"]) : undefined,
      log,
    });
    log(`finished: ${JSON.stringify(summary)}`);
    return summary.failed.length ? 1 : 0;
  }
  if (cmd === "index") {
    // Defaults are the real run: all profiles + merged triage -> research-cache/grant-ask/index/.
    const out = await assertAskOutputDir(root, v.out ?? "research-cache/grant-ask/index");
    const summary = await buildIndex({
      profilesPath: resolve(v.profiles ?? "research-cache/grant-ask/full/profiles.jsonl"),
      triagePath: resolve(v.triage ?? "research-cache/grant-ask/all/triage.jsonl"),
      outDir: out,
      known: loadKnown(root),
    });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  if (cmd === "merge") {
    if (!v.dirs || !v.out) throw new Error("usage: merge --dirs <a>,<b> --out <dir>");
    const out = await assertAskOutputDir(root, v.out);
    const rows: TriageRecord[] = [];
    for (const d of v.dirs.split(",")) {
      const f = join(await assertAskOutputDir(root, d), "triage.jsonl");
      for (const l of (await readFile(f, "utf8")).split("\n").filter(Boolean))
        rows.push(JSON.parse(l) as TriageRecord);
    }
    const seen = new Set<string>();
    const merged = rows.filter((r) => !seen.has(r.key) && !!seen.add(r.key));
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "triage.jsonl"), jsonl(merged));
    console.log(`${merged.length} companies merged\n${reportText(merged)}`);
    return 0;
  }
  if (!v.profiles) throw new Error(`usage: ${cmd} --profiles <profiles.jsonl>`);
  let profiles = await readProfiles(resolve(v.profiles));
  if (v.limit) profiles = sample(profiles, Number(v.limit), Number(v.seed));
  if (v.start !== undefined || v.count !== undefined)
    profiles = sliceProfiles(profiles, Number(v.start ?? 0), Number(v.count ?? profiles.length));
  if (cmd === "estimate") {
    const e = estimateCost(
      profiles.map((p, i) => formatProfile(p, i + 1)),
      Number(v.batch),
      v.model!,
    );
    console.log(
      `${profiles.length} companies, ${v.model}: about ${e.inputTokens.toLocaleString()} input and ${e.outputTokens.toLocaleString()} output tokens, about $${e.usd.toFixed(2)} (estimate; known models: ${Object.keys(PRICES).join(", ")})`,
    );
    return 0;
  }
  if (cmd === "export") {
    if (!v.out) throw new Error("usage: export --profiles --out");
    const m = await exportChunks(profiles, await assertAskOutputDir(root, v.out), Number(v.size));
    console.log(`${profiles.length} companies in ${m.chunks.length} chunk files`);
    return 0;
  }
  if (cmd === "import") {
    if (!v.dir) throw new Error("usage: import --dir <chunks dir> --profiles");
    const dir = await assertAskOutputDir(root, v.dir);
    const { records, missing } = await importVerdicts(dir, profiles, loadKnown(root));
    await writeFile(join(dir, "triage.jsonl"), jsonl(records));
    console.log(
      `${records.length} companies (${missing} unanswered, counted as unsure)\n${reportText(records)}`,
    );
    return 0;
  }
  if (cmd === "triage") {
    if (!v.out) throw new Error("usage: triage --profiles --out --max-usd N --yes");
    const out = await assertAskOutputDir(root, v.out);
    const cap = Number(v["max-usd"]);
    if (!v.yes || !(cap > 0))
      throw new Error(
        "this spends money: pass --max-usd <dollars> and --yes (see `estimate` first)",
      );
    const judge = new ApiTriageJudge(await anthropicClient(v.model!), v.model!, cap);
    const file = join(out, "triage.jsonl");
    const cache = new Map<string, TriageRecord>();
    if (existsSync(file))
      for (const l of (await readFile(file, "utf8")).split("\n").filter(Boolean)) {
        const r = JSON.parse(l) as TriageRecord;
        cache.set(r.key, r);
      }
    let done: TriageRecord[] = [];
    try {
      done = await runTriage(profiles, judge, {
        batchSize: Number(v.batch),
        known: loadKnown(root),
        cache,
        onBatch: (d, t, soFar) => {
          console.log(`judged ${d}/${t}, spent $${judge.spentUsd.toFixed(4)}`);
          writeFileSync(file, jsonl(soFar));
        },
      });
    } catch (e) {
      if (!(e instanceof BudgetExceeded)) throw e;
      console.error(e.message);
      return 2;
    } finally {
      console.log(`API calls: ${judge.calls}, spent about $${judge.spentUsd.toFixed(4)}`);
    }
    await writeFile(file, jsonl(done));
    console.log(reportText(done));
    return 0;
  }
  throw new Error("commands: profiles, estimate, export, import, triage, report");
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
