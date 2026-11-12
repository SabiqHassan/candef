/**
 * `candef capture` (M3-B2): one polite, permitted retrieval of a source into research-cache/.
 *
 * Refuses unless a human has recorded `permissions.capture: allowed` after reading the site's terms
 * (D-15: unknown ⇒ denied); honours robots.txt; identifies CANDEF in its user agent; stores the bytes
 * outside Git; records an immutable Capture entry (raw + normalized-text SHA-256) in the source file.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import type { Capture, Fingerprint } from "../../src/domain/schema/corpus";
import { AuthoringError, ulid } from "./authoring";
import { isCosmeticRedirect } from "./links";
import { loadResearchCorpus } from "./load";

export const USER_AGENT = "CANDEF-research/0.1 (+private non-commercial research; robots-aware)";
const MAX_BYTES = 15 * 1024 * 1024;

/** A robots.txt path pattern: prefix match, `*` wildcard, trailing `$` anchors the end. */
function ruleRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** robots.txt (RFC 9309 subset): groups by user agent, longest matching Allow/Disallow wins. */
export function robotsAllows(robotsTxt: string, userAgent: string, path: string): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else lastWasAgent = false;
  }
  const product = userAgent.split("/")[0]!.toLowerCase();
  const group =
    groups.find((g) => g.agents.some((a) => a !== "*" && product.includes(a))) ??
    groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of group.rules) {
    const re = ruleRegex(rule.pattern);
    if (
      re.test(path) &&
      (!best ||
        rule.pattern.length > best.length ||
        (rule.pattern.length === best.length && rule.allow))
    )
      best = { allow: rule.allow, length: rule.pattern.length };
  }
  return best ? best.allow : true;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Visible text for change detection: scripts, styles and tags removed, entities decoded, whitespace collapsed. */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) =>
      e[0] === "#"
        ? String.fromCodePoint(
            e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
          )
        : (ENTITIES[e.toLowerCase()] ?? all),
    )
    .replace(/\s+/g, " ")
    .trim();
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export interface CaptureOptions {
  /** research-cache/ directory; must not be inside research/. */
  cacheDir: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}

function checkCacheDir(root: string, cacheDir: string): string {
  const dir = resolve(cacheDir);
  const rel = relative(resolve(root), dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
    throw new AuthoringError(
      "the capture cache must be outside research/ (captures never enter Git)",
    );
  return dir;
}

function loadSource(root: string, sourceId: string) {
  const loaded = loadResearchCorpus(root);
  if (!loaded.corpus)
    throw new AuthoringError("research/ does not validate; run `candef validate`");
  const source = loaded.corpus.sources.find((s) => s.id === sourceId);
  if (!source) throw new AuthoringError(`unknown source ${sourceId}`);
  return { source, file: join(root, loaded.origins.get(sourceId)!.file) };
}

function requireCapturePermission(sourceId: string, permission: string) {
  if (permission !== "allowed")
    throw new AuthoringError(
      `capture permission for ${sourceId} is "${permission}". Read the site's terms, then record permissions.capture: allowed (and the basis). If the terms do not allow keeping a copy, use \`candef fingerprint\` (hashes only).`,
    );
}

/** Appends an entry to a list field of the source file, preserving comments and layout. */
function appendToSource(
  file: string,
  field: "captures" | "fingerprints",
  entry: object,
  extra: Record<string, string> = {},
) {
  const doc = parseDocument(readFileSync(file, "utf8"));
  if (!isMap(doc.contents)) throw new AuthoringError(`${file} is not a mapping`);
  const list = doc.get(field, true);
  if (isSeq(list)) {
    list.flow = false;
    list.add(doc.createNode(entry));
  } else doc.set(field, doc.createNode([entry]));
  for (const [k, v] of Object.entries(extra)) doc.set(k, v);
  writeFileSync(file, doc.toString());
}

/** Polite, robots-aware retrieval shared by capture and fingerprint. */
export async function politeFetch(sourceUrl: string, doFetch: typeof fetch) {
  const url = new URL(sourceUrl);
  const robots = await doFetch(new URL("/robots.txt", url), {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (robots.ok && !robotsAllows(await robots.text(), USER_AGENT, url.pathname + url.search))
    throw new AuthoringError(`robots.txt disallows ${url.pathname} for CANDEF`);
  if (!robots.ok && robots.status >= 500)
    throw new AuthoringError(`robots.txt unavailable (HTTP ${robots.status}); not capturing`);
  const res = await doFetch(url, {
    headers: { "user-agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new AuthoringError(`response larger than ${MAX_BYTES} bytes`);
  const type = res.headers.get("content-type") ?? "";
  const moved =
    Boolean(res.url) && res.url !== url.toString() && !isCosmeticRedirect(url.toString(), res.url);
  return { res, bytes, type, availability: !res.ok ? "unavailable" : moved ? "moved" : "ok" };
}

/** Text hash for change detection: visible text for HTML, the decoded text for other text types. */
function textHashFor(bytes: Buffer, type: string): string | null {
  if (!/html|text|json|csv/.test(type)) return null;
  return sha256(/html/.test(type) ? visibleText(bytes.toString("utf8")) : bytes.toString("utf8"));
}

export async function captureSource(
  root: string,
  sourceId: string,
  options: CaptureOptions,
): Promise<Capture> {
  const cacheDir = checkCacheDir(root, options.cacheDir);
  const { source, file } = loadSource(root, sourceId);
  requireCapturePermission(sourceId, source.permissions?.capture ?? "unknown");

  const { res, bytes, type, availability } = await politeFetch(
    source.url,
    options.fetchImpl ?? fetch,
  );
  const ext = /html/.test(type)
    ? "html"
    : /pdf/.test(type)
      ? "pdf"
      : /json/.test(type)
        ? "json"
        : /csv/.test(type)
          ? "csv"
          : /text/.test(type)
            ? "txt"
            : "bin";
  const now = options.now ?? new Date();
  const id = `cap_${ulid(now.getTime())}`;
  const relPath = `captures/${sourceId}/${id}.${ext}`;
  mkdirSync(join(cacheDir, "captures", sourceId), { recursive: true });
  writeFileSync(join(cacheDir, relPath), bytes);
  const capture: Capture = {
    id,
    retrievedAt: now.toISOString(),
    method: "http",
    httpStatus: res.status,
    rawSha256: sha256(bytes),
    textSha256: textHashFor(bytes, type),
    path: relPath,
  };
  appendToSource(file, "captures", capture, { availability, lastCheckedAt: now.toISOString() });
  if (!existsSync(join(cacheDir, relPath))) throw new AuthoringError("capture write failed");
  return capture;
}

/**
 * Hashes only (D-15 initial mode): retrieves the page politely, records its raw and visible-text
 * SHA-256 and keeps no bytes. For sources whose terms are silent on, or prohibit, keeping a copy.
 */
export async function fingerprintSource(
  root: string,
  sourceId: string,
  options: Omit<CaptureOptions, "cacheDir">,
): Promise<Fingerprint> {
  const { source, file } = loadSource(root, sourceId);
  const { res, bytes, type, availability } = await politeFetch(
    source.url,
    options.fetchImpl ?? fetch,
  );
  const now = options.now ?? new Date();
  const fp: Fingerprint = {
    id: `fp_${ulid(now.getTime())}`,
    retrievedAt: now.toISOString(),
    httpStatus: res.status,
    rawSha256: sha256(bytes),
    textSha256: textHashFor(bytes, type),
  };
  appendToSource(file, "fingerprints", fp, { availability, lastCheckedAt: now.toISOString() });
  return fp;
}

/** Streams a file's SHA-256 (the TBS CSVs are several gigabytes). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface LocalCaptureOptions {
  cacheDir: string;
  /** browser: saved from a browser session (script-rendered pages); manual: any other human save. */
  method: "browser" | "manual";
  /**
   * The text a reviewer reads, for formats whose bytes are not text (a PDF's extracted text, or a
   * browser's rendered visible text). Must also be inside the cache; its SHA-256 is the textSha256.
   */
  textFile?: string;
  /** When the file was retrieved (defaults to the file's modification time). */
  retrievedAt?: string;
  now?: Date;
}

const TEXT_EXT = /\.(csv|txt|json|md)$/i;
const HTML_EXT = /\.html?$/i;

/**
 * Registers a file already saved inside research-cache/ as a capture of a source (browser saves of
 * script-rendered pages, official PDFs, the bulk TBS CSVs). The file stays where it is; only its
 * hashes and cache-relative path are recorded. Same permission rule as `captureSource`.
 */
export async function registerLocalCapture(
  root: string,
  sourceId: string,
  filePath: string,
  options: LocalCaptureOptions,
): Promise<Capture> {
  const cacheDir = checkCacheDir(root, options.cacheDir);
  const { source, file } = loadSource(root, sourceId);
  requireCapturePermission(sourceId, source.permissions?.capture ?? "unknown");
  const inCache = (p: string) => {
    const abs = resolve(p);
    const rel = relative(cacheDir, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new AuthoringError(`${p} must be inside the capture cache (${cacheDir})`);
    if (!existsSync(abs)) throw new AuthoringError(`${p} does not exist`);
    return { abs, rel: rel.split("\\").join("/") };
  };
  const main = inCache(filePath);
  const rawSha256 = await sha256File(main.abs);
  let textSha256: string | null;
  if (options.textFile) textSha256 = await sha256File(inCache(options.textFile).abs);
  else if (HTML_EXT.test(main.abs))
    textSha256 = sha256(visibleText(readFileSync(main.abs, "utf8")));
  // A plain-text file is its own text; hashing the bytes avoids decoding gigabytes into memory.
  else if (TEXT_EXT.test(main.abs)) textSha256 = rawSha256;
  else textSha256 = null;
  const now = options.now ?? new Date();
  const capture: Capture = {
    id: `cap_${ulid(now.getTime())}`,
    retrievedAt: options.retrievedAt ?? statSync(main.abs).mtime.toISOString(),
    method: options.method,
    httpStatus: null,
    rawSha256,
    textSha256,
    path: main.rel,
  };
  appendToSource(file, "captures", capture);
  return capture;
}
