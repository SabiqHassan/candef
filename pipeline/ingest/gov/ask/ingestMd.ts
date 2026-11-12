/**
 * Turns a chat tool's Markdown export (blocks "FILE chunk-NNN.txt" followed by lines
 * "NNN | yes|no|unsure | reason") into verdict files. A chunk is accepted only when every number
 * 1..N appears exactly once with a valid verdict; otherwise the whole chunk is rejected and nothing
 * is written for it, so it can be judged again.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "./manual";
import { stripMarkdownLinks, type Verdict } from "./triage";

export interface ParsedExport {
  /** chunk file name -> verdict lines found in its block (in order of appearance) */
  blocks: Map<string, { n: number; verdict: Verdict; reason: string }[]>;
  /** lines that start like a verdict line but cannot be parsed, per chunk: [line number in export, text] */
  malformed: Map<string, [number, string][]>;
  webSearch: "yes" | "no" | null;
}

const FILE_RE = /^file\s*:?\s*(\S+?)\s*$/i;
const VERDICT_RE = /^(\d{1,6})\s*\|\s*(yes|no|unsure)\s*\|\s*(\S.*)$/i;

/** Removes bold/code marks and quote or bullet prefixes so a line can be matched. */
function clean(raw: string): string {
  return stripMarkdownLinks(raw)
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*(?:>\s*)*(?:[-*]\s+)?/, "")
    .trim();
}

export function parseExport(text: string): ParsedExport {
  const blocks: ParsedExport["blocks"] = new Map();
  const malformed: ParsedExport["malformed"] = new Map();
  let webSearch: ParsedExport["webSearch"] = null;
  let current: string | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = clean(raw);
    if (!line) return;
    const ws = /web search used:?\s*(yes|no)/i.exec(line);
    if (ws) {
      const v = ws[1]!.toLowerCase() as "yes" | "no";
      if (webSearch !== "yes") webSearch = v;
      return;
    }
    const f = FILE_RE.exec(line);
    if (f) {
      current = f[1]!.replace(/[,.:;]+$/, "").toLowerCase();
      if (!blocks.has(current)) blocks.set(current, []);
      return;
    }
    if (!current) return;
    const m = VERDICT_RE.exec(line);
    if (m) {
      blocks.get(current)!.push({
        n: Number(m[1]),
        verdict: m[2]!.toLowerCase() as Verdict,
        reason: m[3]!.trim(),
      });
    } else if (/^\d{1,6}\s*\|/.test(line)) {
      const list = malformed.get(current) ?? [];
      list.push([i + 1, line.slice(0, 80)]);
      malformed.set(current, list);
    }
  });
  return { blocks, malformed, webSearch };
}

export interface IngestResult {
  accepted: string[];
  rejected: { chunk: string; reasons: string[] }[];
  unknown: string[];
  notPresent: string[];
  skippedExisting: string[];
  webSearch: ParsedExport["webSearch"];
}

const range = (nums: number[]): string => {
  const s = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    parts.push(j > i ? `${s[i]}-${s[j]}` : String(s[i]));
    i = j + 1;
  }
  const text = parts.join(", ");
  return text.length > 200 ? `${text.slice(0, 200)}... (${s.length} numbers)` : text;
};

/** Checks one chunk's lines against its company count; returns the reasons it fails (empty = ok). */
export function validateChunk(
  lines: { n: number }[],
  malformed: [number, string][],
  size: number,
): string[] {
  const reasons: string[] = [];
  const count = new Map<number, number>();
  for (const l of lines) count.set(l.n, (count.get(l.n) ?? 0) + 1);
  const missing: number[] = [];
  for (let n = 1; n <= size; n++) if (!count.has(n)) missing.push(n);
  const dup = [...count].filter(([, c]) => c > 1).map(([n]) => n);
  const extra = [...count.keys()].filter((n) => n < 1 || n > size);
  if (missing.length) reasons.push(`missing numbers ${range(missing)}`);
  if (dup.length) reasons.push(`duplicated numbers ${range(dup)}`);
  if (extra.length) reasons.push(`numbers outside 1-${size}: ${range(extra)}`);
  if (malformed.length) {
    const shown = malformed.slice(0, 5).map(([ln, t]) => `line ${ln}: "${t}"`);
    const more = malformed.length > 5 ? `; and ${malformed.length - 5} more` : "";
    reasons.push(`malformed lines in the export (${shown.join("; ")}${more})`);
  }
  return reasons;
}

export async function ingestMarkdown(
  dir: string,
  mdText: string,
  force = false,
): Promise<IngestResult> {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
  const parsed = parseExport(mdText);
  const known = new Map(manifest.chunks.map((c) => [c.file, c]));
  const res: IngestResult = {
    accepted: [],
    rejected: [],
    unknown: [...parsed.blocks.keys()].filter((k) => !known.has(k)),
    notPresent: [],
    skippedExisting: [],
    webSearch: parsed.webSearch,
  };
  for (const c of manifest.chunks) {
    const lines = parsed.blocks.get(c.file);
    if (!lines) {
      res.notPresent.push(c.file);
      continue;
    }
    const reasons = validateChunk(lines, parsed.malformed.get(c.file) ?? [], c.keys.length);
    if (reasons.length) {
      res.rejected.push({ chunk: c.file, reasons });
      continue;
    }
    const target = join(dir, c.verdictFile);
    if (existsSync(target) && !force) {
      res.skippedExisting.push(c.verdictFile);
      continue;
    }
    const body = [...lines]
      .sort((a, b) => a.n - b.n)
      .map((l) => `${String(l.n).padStart(3, "0")} | ${l.verdict} | ${l.reason}`)
      .join("\n");
    await writeFile(target, `${body}\n`);
    res.accepted.push(c.file);
  }
  return res;
}

export function ingestReport(r: IngestResult): string {
  const list = (a: string[]) => (a.length ? ` (${a.join(", ")})` : "");
  const out = [
    `accepted: ${r.accepted.length}${list(r.accepted)}`,
    `rejected: ${r.rejected.length}`,
  ];
  for (const x of r.rejected) out.push(`  ${x.chunk}: ${x.reasons.join(" | ")}`);
  if (r.skippedExisting.length)
    out.push(`not overwritten (use --force): ${r.skippedExisting.join(", ")}`);
  if (r.unknown.length) out.push(`unknown chunk names in the export: ${r.unknown.join(", ")}`);
  out.push(`not present in the export: ${r.notPresent.length}${list(r.notPresent)}`);
  if (r.webSearch === "yes")
    out.push(
      "WARNING: the export says web search was used; the judge may have used outside knowledge",
    );
  else if (r.webSearch === null) out.push('note: no "web search used" line found');
  return out.join("\n");
}
