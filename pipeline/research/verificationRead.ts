/**
 * Verification reads (P-61, docs/VERIFICATION_CLEARANCE.md).
 *
 * For a source whose terms forbid keeping a copy, the page is read once and checked against the
 * key values of the records that cite it. Only these are kept, in research-cache/verification-
 * reads/<sourceId>.json: the page's raw and visible-text SHA-256, whether each value was found and
 * at which offset in the normalized text, and the entity name the page carries. No text, no
 * excerpt. robots.txt, logins, paywalls and CAPTCHAs are respected exactly as for captures
 * (`politeFetch`); a page that refuses or fails is recorded as such and never worked around.
 *
 * A read is bound to the record's content hash: editing the record voids it. Re-reading a page
 * replaces that source's entries for the records it covers.
 *
 * Pure matching lives in tiers/match.ts; this module only fetches, hashes and stores results.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Corpus } from "../../src/domain/schema/corpus";
import { AuthoringError } from "./authoring";
import { politeFetch, visibleText } from "./capture";
import { reviewUnits } from "./decisions";
import { entityNames, entityInText } from "./clearance/checks";
import { normalize } from "./tiers/match";
import { recordParts } from "./tiers/rules";

export interface ReadPart {
  part: string;
  kind: string;
  value: string;
  found: boolean;
  offset: number | null;
}
export interface ReadRecord {
  /** The unit hash (decisions.ts) the read applies to; an edit to the record voids it. */
  hash: string;
  parts: ReadPart[];
}
export interface VerificationReadFile {
  format: "candef-verification-read";
  version: 1;
  sourceId: string;
  url: string;
  readAt: string;
  method: "http" | "file";
  httpStatus: number | null;
  rawSha256: string;
  textSha256: string;
  /** Length of the normalized text (so a changed page is visible without keeping it). */
  textLength: number;
  /** Which of the organization's names the page carries, per organization ID. */
  entityNamed: Record<string, string | null>;
  records: Record<string, ReadRecord>;
}

const sha = (d: Buffer | string) => createHash("sha256").update(d).digest("hex");

export const readsDir = (cacheDir: string) => join(cacheDir, "verification-reads");

/** All verification reads in the cache, by source ID. */
export function loadReads(cacheDir: string): Map<string, VerificationReadFile> {
  const out = new Map<string, VerificationReadFile>();
  const dir = readsDir(cacheDir);
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    try {
      const v = JSON.parse(readFileSync(join(dir, f), "utf8")) as VerificationReadFile;
      if (v.format === "candef-verification-read") out.set(v.sourceId, v);
    } catch {
      // a damaged file is ignored: the record then has no read
    }
  }
  return out;
}

/** Plain text of a fetched or local page: HTML visible text, PDF via pdftotext, else as text. */
function textOf(bytes: Buffer, type: string): string {
  if (/pdf/.test(type)) {
    const dir = mkdtempSync(join(tmpdir(), "candef-read-"));
    try {
      const f = join(dir, "page.pdf");
      writeFileSync(f, bytes);
      return execFileSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" });
    } catch {
      throw new AuthoringError("the page is a PDF and pdftotext is not available");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const raw = bytes.toString("utf8");
  return /html/.test(type) ? visibleText(raw) : raw;
}

export interface ReadOptions {
  cacheDir: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  /** Use this local file (a page the owner saved) instead of fetching; kept nowhere. */
  file?: { bytes: Buffer; type: string };
}

/**
 * Reads the source once and checks every record that cites it. Writes only the read file.
 * Returns it, with what was not found, so the caller can report.
 */
export async function verificationRead(
  corpus: Corpus,
  sourceId: string,
  options: ReadOptions,
): Promise<VerificationReadFile> {
  const source = corpus.sources.find((s) => s.id === sourceId);
  if (!source) throw new AuthoringError(`unknown source ${sourceId}`);
  const now = options.now ?? new Date();
  let bytes: Buffer;
  let type: string;
  let status: number | null = null;
  if (options.file) {
    bytes = options.file.bytes;
    type = options.file.type;
  } else {
    const r = await politeFetch(source.url, options.fetchImpl ?? fetch);
    if (!r.res.ok)
      throw new AuthoringError(
        `${source.url} answered HTTP ${r.res.status}; not read, not worked around`,
      );
    bytes = r.bytes;
    type = r.type;
    status = r.res.status;
  }
  const text = normalize(textOf(bytes, type));
  const units = new Map(reviewUnits(corpus, now.toISOString().slice(0, 10)).map((u) => [u.id, u]));
  const records: Record<string, ReadRecord> = {};
  const orgIds = new Set<string>();
  for (const unit of units.values()) {
    if (unit.kind !== "assertion" && unit.kind !== "round") continue;
    const parts = recordParts(corpus, unit.id);
    if (typeof parts === "string") continue;
    const mine = parts.filter((p) => p.sourceIds.includes(sourceId));
    if (!mine.length) continue;
    orgIds.add(unit.orgId);
    records[unit.id] = {
      hash: unit.hash,
      parts: mine.map((p) => {
        const m = p.match(text);
        return { part: p.part, kind: p.kind, value: p.value, found: m.found, offset: m.offset };
      }),
    };
  }
  const entityNamed: Record<string, string | null> = {};
  for (const id of orgIds) entityNamed[id] = entityInText(text, entityNames(corpus, id));
  const out: VerificationReadFile = {
    format: "candef-verification-read",
    version: 1,
    sourceId,
    url: source.url,
    readAt: now.toISOString(),
    method: options.file ? "file" : "http",
    httpStatus: status,
    rawSha256: sha(bytes),
    textSha256: sha(text),
    textLength: text.length,
    entityNamed,
    records,
  };
  const dir = readsDir(options.cacheDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sourceId}.json`), JSON.stringify(out, null, 2));
  return out;
}

/**
 * Whether the reads cover a record's parts: every key value found in a read of the same record
 * hash. Returns the sources used, or null (and the missing part names) when not all are covered.
 */
export function coveredByReads(
  recordId: string,
  recordHash: string,
  parts: { part: string }[],
  alreadyFound: Set<string>,
  reads: Map<string, VerificationReadFile>,
): {
  sources: { sourceId: string; readAt: string; entityNamed: Record<string, string | null> }[];
  missing: string[];
} {
  const used = new Map<
    string,
    { sourceId: string; readAt: string; entityNamed: Record<string, string | null> }
  >();
  const missing: string[] = [];
  for (const p of parts) {
    if (alreadyFound.has(p.part)) continue;
    let ok = false;
    for (const r of reads.values()) {
      const rec = r.records[recordId];
      if (rec && rec.hash === recordHash && rec.parts.some((x) => x.part === p.part && x.found)) {
        used.set(r.sourceId, {
          sourceId: r.sourceId,
          readAt: r.readAt,
          entityNamed: r.entityNamed,
        });
        ok = true;
        break;
      }
    }
    if (!ok) missing.push(p.part);
  }
  return { sources: [...used.values()], missing };
}
