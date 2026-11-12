/** Local-only beta preparation and audit. This module never uploads or deploys files. */
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot, SnapshotManifest } from "../../src/domain/schema/snapshot";
import { readTakedowns, type Takedown } from "../research/takedown";

interface BetaOptions {
  researchDir: string;
}

export interface BetaSummary {
  /** Paths relative to dist; kept files are listed in manifest order. */
  kept: string[];
  removed: string[];
  droppedRollbacks: { file: string; reasons: string[] }[];
}

const DATA = "data/research";
const ROBOTS_META = '<meta name="robots" content="noindex, nofollow">';
const ROBOTS = "User-agent: *\nDisallow: /\n";
/** The policy the beta ships with; tests/e2e/csp.spec.ts runs the whole app under exactly this. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'";
const HEADERS = `/*
  X-Robots-Tag: noindex, nofollow
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: ${CONTENT_SECURITY_POLICY}
`;
/**
 * The only contact data allowed in a release: the owner-authorized public corrections address
 * (P-33). Any other email address is still a problem.
 */
export const AUTHORIZED_PUBLIC_CONTACTS = ["sabiqhassan1234@gmail.com"];
const EMAIL = /[^\s"@<>()]+@[^\s"@<>()]+\.[a-z]{2,}/gi;

const UNPUBLISHED = new Set(["proposed", "rejected", "retracted", "superseded"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Never follow symlinks, including directory junctions, while reading or pruning a build. */
function inventory(root: string) {
  const files: string[] = [];
  const directories: string[] = [];
  const problems: string[] = [];
  function visit(path: string) {
    try {
      const stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink()) {
        problems.push(`Unsafe symbolic link: ${path || root}`);
      } else if (stat.isDirectory()) {
        if (path) directories.push(path);
        for (const name of readdirSync(join(root, path)).sort()) {
          visit(path ? `${path}/${name}` : name);
        }
      } else if (stat.isFile()) {
        files.push(path);
      } else {
        problems.push(`Unsupported file: ${path}`);
      }
    } catch (error) {
      problems.push(`${path || root}: ${message(error)}`);
    }
  }
  visit("");
  return { files, directories, problems };
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function readManifest(distDir: string): SnapshotManifest {
  const manifest = readJson(join(distDir, DATA, "manifest.json"));
  if (
    !object(manifest) ||
    typeof manifest.current !== "string" ||
    !Array.isArray(manifest.previous) ||
    !manifest.previous.every((file: unknown) => typeof file === "string") ||
    typeof manifest.isDemo !== "boolean" ||
    typeof manifest.builtAt !== "string" ||
    typeof manifest.schemaVersion !== "string"
  ) {
    throw new Error("Invalid research manifest.json");
  }
  for (const name of [manifest.current, ...manifest.previous] as string[]) {
    if (!/^[^/\\:\0]+\.json$/.test(name) || name === "manifest.json") {
      throw new Error(`Unsafe snapshot path/name in manifest: ${name}`);
    }
  }
  return manifest as unknown as SnapshotManifest;
}

function takedownPolicy(takedowns: Takedown[]) {
  const ids = [...new Set(takedowns.flatMap((entry) => entry.ids))];
  let latest: Takedown | undefined;
  for (const entry of takedowns) {
    if (!Number.isFinite(Date.parse(entry.date))) {
      throw new Error(`Invalid takedown date: ${entry.date}`);
    }
    if (!latest || Date.parse(entry.date) > Date.parse(latest.date)) latest = entry;
  }
  return { ids, latest };
}

/** Canonical serialization also catches IDs encoded with JSON Unicode escapes in the input. */
function retractedIds(snapshot: unknown, ids: string[]): string[] {
  const text = JSON.stringify(snapshot);
  return ids.filter((id) => text.includes(JSON.stringify(id)));
}

function snapshotAge(snapshot: unknown, latest: Takedown | undefined): string | undefined {
  const meta = object(snapshot) && object(snapshot.meta) ? snapshot.meta : {};
  const builtAt = meta.builtAt;
  if (typeof builtAt !== "string" || !Number.isFinite(Date.parse(builtAt))) {
    return "Invalid or missing meta.builtAt";
  }
  if (latest && Date.parse(builtAt) < Date.parse(latest.date)) {
    return `meta.builtAt ${builtAt} is earlier than latest takedown ${latest.date}`;
  }
}

// HTML emitted by Vite is static. Ignore comments and parse attributes independently so an
// attribute value containing e.g. "src=" cannot masquerade as a script's source attribute.
function htmlTags(html: string, name: string) {
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
  return [
    ...uncommented.matchAll(new RegExp(`<${name}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>`, "gi")),
  ];
}

function attributes(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of text.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = match[1]!.toLowerCase();
    if (!result.has(name)) result.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function robotsTags(html: string) {
  const head = htmlTags(html, "head")[0];
  const close = htmlTags(html, "/head")[0];
  if (!head || !close) return [];
  return htmlTags(html, "meta").filter(
    (tag) =>
      tag.index! > head.index! &&
      tag.index! < close.index! &&
      attributes(tag[1]!).get("name")?.toLowerCase() === "robots",
  );
}

function hasRobotsMeta(html: string): boolean {
  return robotsTags(html).some((tag) => {
    const content = attributes(tag[1]!)
      .get("content")
      ?.toLowerCase()
      .split(/[\s,]+/);
    return content?.includes("noindex") && content.includes("nofollow");
  });
}

function hardenedHtml(html: string): string {
  if (htmlTags(html, "script").some((tag) => !attributes(tag[1]!).get("src")?.trim())) {
    throw new Error(
      "Inline scripts in index.html would be broken by script-src 'self'; preparation stopped",
    );
  }
  const head = htmlTags(html, "head")[0];
  const close = htmlTags(html, "/head")[0];
  if (!head || !close || close.index! < head.index!)
    throw new Error("index.html is missing its <head>");
  // Replace permissive robots tags too: merely having name="robots" is not a noindex policy.
  let next = html;
  for (const tag of robotsTags(html).reverse()) {
    next = next.slice(0, tag.index) + ROBOTS_META + next.slice(tag.index! + tag[0].length);
  }
  if (!robotsTags(html).length) {
    const at = head.index! + head[0].length;
    next = next.slice(0, at) + `\n    ${ROBOTS_META}` + next.slice(at);
  }
  return next;
}

export function prepareBeta(distDir: string, { researchDir }: BetaOptions): BetaSummary {
  const build = inventory(distDir);
  if (build.problems.length) throw new Error(build.problems.join("\n"));
  // Fictional datasets (the demo and the synthetic stress set) must never ship in a beta.
  const fictional = [...build.files, ...build.directories].find((path) =>
    ["data/demo", "data/stress"].includes(path.toLowerCase()),
  );
  if (fictional) throw new Error(`Refusing beta: ${fictional} exists`);
  if (!build.files.includes(`${DATA}/manifest.json`))
    throw new Error("Missing research manifest.json");
  const manifest = readManifest(distDir);
  if (manifest.isDemo !== false)
    throw new Error("Refusing demo research manifest (isDemo must be false)");
  const policy = takedownPolicy(readTakedowns(researchDir));
  const current = readJson(join(distDir, DATA, manifest.current));
  const currentIds = retractedIds(current, policy.ids);
  if (currentIds.length)
    throw new Error(`Current snapshot contains retracted IDs: ${currentIds.join(", ")}`);
  const html = hardenedHtml(readFileSync(join(distDir, "index.html"), "utf8"));
  const droppedRollbacks: BetaSummary["droppedRollbacks"] = [];
  const previous = manifest.previous.filter((file) => {
    const snapshot = readJson(join(distDir, DATA, file));
    const reasons: string[] = [];
    const ids = retractedIds(snapshot, policy.ids);
    if (ids.length) reasons.push(`Contains retracted IDs: ${ids.join(", ")}`);
    const age = snapshotAge(snapshot, policy.latest);
    if (age) reasons.push(age);
    if (reasons.length) droppedRollbacks.push({ file, reasons });
    return reasons.length === 0;
  });
  const kept = ["manifest.json", manifest.current, ...previous].map((file) => `${DATA}/${file}`);
  const keep = new Set(kept);
  const removed = build.files.filter((file) => file.startsWith(`${DATA}/`) && !keep.has(file));

  // All refusal checks precede the first mutation. Directory entries are known not to be links.
  for (const file of removed) rmSync(join(distDir, file));
  for (const dir of build.directories.filter((dir) => dir.startsWith(`${DATA}/`)).reverse()) {
    rmSync(join(distDir, dir), { recursive: true });
  }
  writeFileSync(
    join(distDir, DATA, "manifest.json"),
    JSON.stringify({ ...manifest, previous }, null, 2),
  );
  writeFileSync(join(distDir, "robots.txt"), ROBOTS);
  writeFileSync(join(distDir, "_headers"), HEADERS);
  writeFileSync(join(distDir, "index.html"), html);
  return { kept, removed, droppedRollbacks };
}

/** Check states outside history arrays. Facts and research states in Snapshot have their own
 * allowed states (unconfirmed, not_researched, etc.); none are in UNPUBLISHED. A value's nested
 * domain data is not a record status, so only its enclosing Fact's state is inspected.
 */
function inspectSnapshot(snapshot: unknown, report: (problem: string) => void) {
  const historicalIds = new Set<string>();
  const currentIds = new Set<string>();
  // Fact histories publish their own evidence via the shared assertions dictionary. Only those
  // references make a superseded AssertionView historical rather than a current record.
  const factFields: (keyof Snapshot["organizations"][number])[] = [
    "legalName",
    "hq",
    "founded",
    "description",
    "segment",
    "listing",
  ];
  if (object(snapshot) && Array.isArray(snapshot.organizations)) {
    for (const org of snapshot.organizations as unknown[]) {
      if (!object(org)) continue;
      for (const field of factFields) {
        const fact = org[field];
        if (!object(fact) || !Array.isArray(fact.history)) continue;
        for (const entry of fact.history as unknown[]) {
          if (!object(entry) || !Array.isArray(entry.assertionIds)) continue;
          for (const id of entry.assertionIds as unknown[]) {
            if (typeof id === "string") historicalIds.add(id);
          }
        }
      }
    }
  }
  function currentReferences(value: unknown, history = false) {
    if (Array.isArray(value)) {
      value.forEach((entry: unknown) => currentReferences(entry, history));
    } else if (object(value)) {
      for (const [key, entry] of Object.entries(value)) {
        if (!history && key === "assertionIds" && Array.isArray(entry)) {
          for (const id of entry as unknown[]) if (typeof id === "string") currentIds.add(id);
        }
        currentReferences(entry, history || (key === "history" && Array.isArray(entry)));
      }
    }
  }
  currentReferences(snapshot);
  if (object(snapshot) && object(snapshot.meta) && snapshot.meta.preview === true)
    report("$.meta.preview: a local preview (simulated approvals) can never be released");
  if (!object(snapshot) || !object(snapshot.meta) || snapshot.meta.isDemo !== false) {
    report("$.meta.isDemo must be false");
  }
  if (object(snapshot) && Array.isArray(snapshot.organizations)) {
    snapshot.organizations.forEach((org: unknown, index: number) => {
      if (object(org) && org.isDemo === true) report(`$.organizations[${index}].isDemo is true`);
    });
  }
  function inspectText(value: string, path: string) {
    if (value.toLowerCase().includes("example.invalid")) report(`${path}: example.invalid URL`);
    const emails = (value.match(EMAIL) ?? []).filter(
      (e) => !AUTHORIZED_PUBLIC_CONTACTS.includes(e.toLowerCase()),
    );
    if (emails.length) report(`${path}: email address`);
    if (/\+?1?[ .-]?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}/.test(value))
      report(`${path}: phone-like contact data`);
  }
  function walk(value: unknown, path: string, history = false, domainValue = false) {
    if (typeof value === "string") {
      inspectText(value, path);
    } else if (Array.isArray(value)) {
      value.forEach((entry: unknown, index: number) =>
        walk(entry, `${path}[${index}]`, history, domainValue),
      );
    } else if (object(value)) {
      for (const [key, entry] of Object.entries(value)) {
        const child =
          path === "$.assertions" || path === "$.sources"
            ? `${path}[${JSON.stringify(key)}]`
            : `${path}.${key}`;
        inspectText(key, `${child} (key)`);
        const historicalEvidence =
          key === "verification" &&
          entry === "superseded" &&
          typeof value.id === "string" &&
          path === `$.assertions[${JSON.stringify(value.id)}]` &&
          historicalIds.has(value.id) &&
          !currentIds.has(value.id);
        if (
          !history &&
          !domainValue &&
          !historicalEvidence &&
          (key === "verification" || key === "state") &&
          typeof entry === "string" &&
          UNPUBLISHED.has(entry)
        ) {
          report(`${child}: unpublished record state ${entry}`);
        }
        walk(
          entry,
          child,
          history || (key === "history" && Array.isArray(entry)),
          domainValue || key === "value",
        );
      }
    }
  }
  walk(snapshot, "$");
}

export function auditBeta(
  distDir: string,
  { researchDir }: BetaOptions,
): { ok: boolean; problems: string[] } {
  const build = inventory(distDir);
  const problems = [...build.problems];
  for (const path of [...build.files, ...build.directories]) {
    if (/(?:^|\/)data\/(?:demo|stress)(?:\/|$)/i.test(path))
      problems.push(`Fictional (demo or synthetic) data path: ${path}`);
  }
  for (const file of build.files) {
    if (/research-cache|\.yaml|\.env|metrics\.json|\.map|captures\//i.test(file)) {
      problems.push(`File must never ship: ${file}`);
    }
  }
  // Only read files enumerated without following links, even if the manifest names one.
  function requireFile(path: string): string {
    if (!build.files.includes(path)) throw new Error(`Missing or unsafe file: ${path}`);
    return join(distDir, path);
  }
  try {
    requireFile(`${DATA}/manifest.json`);
    const manifest = readManifest(distDir);
    if (manifest.isDemo !== false) problems.push("Research manifest.isDemo must be false");
    const files = new Set([manifest.current, ...manifest.previous]);
    const allowed = new Set([
      `${DATA}/manifest.json`,
      ...[...files].map((file) => `${DATA}/${file}`),
    ]);
    for (const file of build.files) {
      if (file.startsWith(`${DATA}/`) && !allowed.has(file))
        problems.push(`Unexpected research file: ${file}`);
      if (file.startsWith(`${DATA}/`) && /(?:^|\/)snapshot\.[^/]+\.json$/i.test(file)) {
        files.add(file.slice(DATA.length + 1));
      }
    }
    let policy: ReturnType<typeof takedownPolicy> = { ids: [], latest: undefined };
    try {
      policy = takedownPolicy(readTakedowns(researchDir));
    } catch (error) {
      problems.push(`Takedown log: ${message(error)}`);
    }
    for (const file of files) {
      const path = `${DATA}/${file}`;
      try {
        const snapshot = readJson(requireFile(path));
        inspectSnapshot(snapshot, (problem) => problems.push(`${path}: ${problem}`));
        for (const id of retractedIds(snapshot, policy.ids))
          problems.push(`${path}: retracted ID ${id}`);
        const age = snapshotAge(snapshot, policy.latest);
        if (age) problems.push(`${path}: ${age}`);
      } catch (error) {
        problems.push(`${path}: ${message(error)}`);
      }
    }
  } catch (error) {
    problems.push(`Research manifest: ${message(error)}`);
  }
  for (const file of ["robots.txt", "_headers"]) {
    if (!build.files.includes(file)) problems.push(`Missing hardening file: ${file}`);
  }
  try {
    const html = readFileSync(requireFile("index.html"), "utf8");
    if (!hasRobotsMeta(html))
      problems.push("index.html is missing the robots noindex, nofollow meta tag");
  } catch (error) {
    problems.push(`index.html: ${message(error)}`);
  }
  return { ok: problems.length === 0, problems };
}

function main() {
  console.log("Local beta preparation only: no uploads or deployments are performed.");
  try {
    let distDir = "dist";
    let researchDir = "research";
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i];
      const value = args[i + 1];
      if ((flag !== "--dist" && flag !== "--research") || !value || value.startsWith("--")) {
        throw new Error("Usage: npm run release:beta -- [--dist dist] [--research research]");
      }
      if (flag === "--dist") distDir = value;
      else researchDir = value;
    }
    const summary = prepareBeta(resolve(distDir), { researchDir: resolve(researchDir) });
    console.log(`Kept ${summary.kept.length} research files; removed ${summary.removed.length}.`);
    for (const file of summary.kept) console.log(`  kept: ${file}`);
    for (const file of summary.removed) console.log(`  removed: ${file}`);
    for (const drop of summary.droppedRollbacks)
      console.log(`  dropped ${drop.file}: ${drop.reasons.join("; ")}`);
    const audit = auditBeta(resolve(distDir), { researchDir: resolve(researchDir) });
    if (!audit.ok) {
      for (const problem of audit.problems) console.error(`  problem: ${problem}`);
      process.exitCode = 1;
    }
    console.log(`Beta audit: ${audit.ok ? "PASS" : "FAIL"}.`);
  } catch (error) {
    console.error(`Beta release refused: ${message(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
