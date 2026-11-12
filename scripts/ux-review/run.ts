/**
 * Sends an approved UX-review bundle to Google Antigravity (`agy`) for an independent review.
 *
 *   npx tsx scripts/ux-review/run.ts --id <bundle id> [--dry-run] [--model gemini-3.8-flash-high]
 *
 * Guard rails (P-39, docs/UX_REVIEW.md):
 *   - Input is only research-cache/ux-review/<id>/ made by capture.ts: demo-data PNG screenshots and
 *     the approved docs/ux-review/brief.md. The manifest must say dataMode "demo-fictional", list
 *     every file with its SHA-256, and match the folder exactly.
 *   - The bundle is copied to a fresh temp folder outside the repository; agy runs there, read-only
 *     (`--mode plan --sandbox`). It never sees the repository, research/, or any credential.
 *   - The prompt is short and passed as an argument (no stdin piping, no shell). No permission
 *     bypass flag is ever used.
 *   - The reply is saved to docs/reports/ux-reviews/ for triage; this script changes nothing else.
 * `--dry-run` validates the bundle and prints the command without contacting Antigravity.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const id = arg("--id");
const model = arg("--model") ?? "gemini-3.8-flash-high";
const dry = process.argv.includes("--dry-run");
if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
  console.error("usage: run.ts --id <bundle id> [--dry-run] [--model <id>]");
  process.exit(2);
}
const bundle = join(ROOT, "research-cache", "ux-review", id);

const MAX_PNG = 6 * 1024 * 1024;
const MAX_TOTAL = 48 * 1024 * 1024;
const MAX_BRIEF = 12 * 1024;
const FORBIDDEN_IN_BRIEF = [
  /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, // email
  /\bresearch\/(orgs|sources)\b/i,
  /research-cache/i,
  /(api[_-]?key|secret|token|passw(or)?d)\s*[:=]/i,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bBN\s*\d{9}/i,
];

function fail(msg: string): never {
  console.error(`Bundle refused: ${msg}`);
  process.exit(1);
}
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function validate() {
  if (!existsSync(join(bundle, "manifest.json"))) fail("manifest.json is missing (run capture.ts)");
  const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as {
    dataMode: string;
    files: { file: string; sha256: string }[];
  };
  if (manifest.dataMode !== "demo-fictional")
    fail(`dataMode is "${manifest.dataMode}", not demo-fictional`);
  const listed = new Set(manifest.files.map((f) => f.file));
  const actual: string[] = [
    ...readdirSync(join(bundle, "screenshots")).map((n) => `screenshots/${n}`),
    "brief.md",
  ];
  for (const f of actual) if (!listed.has(f)) fail(`unlisted file in bundle: ${f}`);
  for (const f of listed) if (!actual.includes(f)) fail(`listed file missing: ${f}`);
  const extra = readdirSync(bundle).filter(
    (n) => !["manifest.json", "brief.md", "screenshots", "agy-result.json"].includes(n),
  );
  if (extra.length) fail(`unexpected entries in bundle folder: ${extra.join(", ")}`);
  let total = 0;
  for (const { file, sha256 } of manifest.files) {
    const p = join(bundle, file);
    if (sha(p) !== sha256) fail(`hash mismatch (file changed after capture): ${file}`);
    const size = statSync(p).size;
    total += size;
    if (file.startsWith("screenshots/")) {
      if (!file.endsWith(".png")) fail(`only PNG screenshots are allowed: ${file}`);
      if (size > MAX_PNG) fail(`screenshot too large: ${file}`);
    } else if (file !== "brief.md") fail(`file type not allowed: ${file}`);
  }
  if (total > MAX_TOTAL) fail("bundle too large");
  const brief = readFileSync(join(bundle, "brief.md"), "utf8");
  if (brief.length > MAX_BRIEF) fail("brief.md too long");
  if (brief !== readFileSync(join(ROOT, "docs/ux-review/brief.md"), "utf8"))
    fail("brief.md differs from the approved docs/ux-review/brief.md (re-run capture.ts)");
  for (const rx of FORBIDDEN_IN_BRIEF)
    if (rx.test(brief)) fail(`brief.md matches a forbidden pattern: ${rx}`);
  return manifest;
}

const manifest = validate();
console.log(`Bundle OK: ${manifest.files.length} files, demo-fictional data only.`);

const work = mkdtempSync(join(tmpdir(), `candef-ux-${id}-`));
cpSync(join(bundle, "screenshots"), join(work, "screenshots"), { recursive: true });
cpSync(join(bundle, "brief.md"), join(work, "brief.md"));

const shots = manifest.files.filter((f) => f.file.startsWith("screenshots/")).map((f) => f.file);
const prompt =
  "Follow the instructions in ./brief.md exactly. Open and look at each of these image files directly by path (do not list directories and do not start subagents): " +
  shots.join(", ") +
  ". When you have viewed all of them, reply with the review in the Markdown format the brief specifies, in this single reply. You cannot run commands or edit files; do not try.";
const args = [
  "-p",
  prompt,
  "--model",
  model,
  "--effort",
  "high",
  "--mode",
  "plan",
  "--sandbox",
  "--output-format",
  "json",
  "--print-timeout",
  "900s",
];

if (dry) {
  console.log(
    `Dry run. Would run in ${work}:\n  agy ${args.map((a) => JSON.stringify(a)).join(" ")}`,
  );
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

console.log(`Running agy (${model}) in ${work} ...`);
const r = spawnSync("agy", args, {
  cwd: work,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 1_000_000,
  maxBuffer: 64 * 1024 * 1024,
});
rmSync(work, { recursive: true, force: true });
writeFileSync(join(bundle, "agy-result.json"), r.stdout ?? "");
if (r.status !== 0) {
  console.error(`agy exited with ${r.status}\n${(r.stderr ?? "").slice(0, 2000)}`);
  process.exit(1);
}
let result: {
  status?: string;
  response?: string;
  usage?: unknown;
  duration_seconds?: number;
  conversation_id?: string;
};
try {
  result = JSON.parse(r.stdout);
} catch {
  console.error("agy returned non-JSON output; raw output saved in the bundle folder");
  process.exit(1);
}
if (result.status !== "SUCCESS" || !result.response) {
  console.error(
    `agy status: ${result.status}; no review text. Raw output saved in the bundle folder.`,
  );
  process.exit(1);
}

const dir = join(ROOT, "docs", "reports", "ux-reviews");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${id}-${model}.md`);
const header = `# Independent UX review: ${id}

- **Reviewer:** Google Antigravity \`agy\`, model \`${model}\`, plan (read-only) mode, sandboxed.
- **Inputs:** ${manifest.files.length} files, fictional demo data only (bundle manifest SHA-256 of file list: ${createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex").slice(0, 16)}). See \`docs/ux-review/brief.md\`.
- **Run:** ${new Date().toISOString()}, ${result.duration_seconds?.toFixed(1)} s, usage ${JSON.stringify(result.usage)}.
- **Status:** raw model output below, unedited. Triage and decisions are in the "Triage" section appended by Claude after review. Nothing here has been applied automatically.

---

`;
writeFileSync(file, header + result.response + "\n");
console.log(`Saved ${file}`);
