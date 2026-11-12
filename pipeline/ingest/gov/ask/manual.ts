/**
 * Manual judging (a person, or a Claude session, with no API): profiles are exported as chunk files
 * of numbered text; the judge writes verdict files in the TRIAGE_INSTRUCTIONS format; the verdicts
 * are imported back and combined with the safety net. Numbers restart at 1 in every chunk and a
 * manifest maps them to companies, so a judge sees nothing but the profile text.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompanyProfile } from "./profiles";
import {
  finalise,
  formatProfile,
  parseVerdictLines,
  TRIAGE_INSTRUCTIONS,
  type TriageRecord,
} from "./triage";
import type { KnownCompanies } from "./signals";

export interface Manifest {
  chunkSize: number;
  chunks: { file: string; verdictFile: string; keys: string[] }[];
}

export async function exportChunks(
  profiles: CompanyProfile[],
  dir: string,
  chunkSize: number,
): Promise<Manifest> {
  await mkdir(dir, { recursive: true });
  const manifest: Manifest = { chunkSize, chunks: [] };
  await writeFile(join(dir, "INSTRUCTIONS.md"), `${TRIAGE_INSTRUCTIONS}\n`);
  for (let i = 0, c = 1; i < profiles.length; i += chunkSize, c++) {
    const part = profiles.slice(i, i + chunkSize);
    const id = String(c).padStart(3, "0");
    const file = `chunk-${id}.txt`;
    await writeFile(join(dir, file), part.map((p, j) => formatProfile(p, j + 1)).join("\n\n"));
    manifest.chunks.push({ file, verdictFile: `verdicts-${id}.txt`, keys: part.map((p) => p.key) });
  }
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** Reads every verdict file named in the manifest; a missing company becomes "unsure". */
export async function importVerdicts(
  dir: string,
  profiles: CompanyProfile[],
  known?: KnownCompanies,
): Promise<{ records: TriageRecord[]; missing: number }> {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
  const byKey = new Map(profiles.map((p) => [p.key, p]));
  const files = new Set(await readdir(dir));
  const records: TriageRecord[] = [];
  let missing = 0;
  for (const chunk of manifest.chunks) {
    const answers = new Map<number, ReturnType<typeof parseVerdictLines>[number]>();
    if (files.has(chunk.verdictFile)) {
      for (const l of parseVerdictLines(await readFile(join(dir, chunk.verdictFile), "utf8")))
        answers.set(l.n, l);
    }
    chunk.keys.forEach((key, j) => {
      const p = byKey.get(key);
      if (!p) throw new Error(`profile ${key} is in the manifest but not in the profiles file`);
      const a = answers.get(j + 1);
      if (!a) missing++;
      records.push(
        finalise(p, a?.verdict ?? "unsure", a?.reason ?? "no answer from judge", "manual", known),
      );
    });
  }
  return { records, missing };
}

/**
 * Which chunks still need a verdict file. A chunk is complete when its verdict file has one line per
 * company; a shorter file is "incomplete" and the judge should redo that chunk.
 */
export async function chunkStatus(
  dir: string,
): Promise<{ total: number; done: number; pending: string[]; partial: string[] }> {
  const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest;
  const files = new Set(await readdir(dir));
  const pending: string[] = [];
  const partial: string[] = [];
  let done = 0;
  for (const c of manifest.chunks) {
    if (!files.has(c.verdictFile)) {
      pending.push(c.file);
      continue;
    }
    const lines = (await readFile(join(dir, c.verdictFile), "utf8"))
      .split(String.fromCharCode(10))
      .filter((l) => l.trim());
    if (lines.length >= c.keys.length) done++;
    else {
      partial.push(c.verdictFile);
      pending.push(c.file);
    }
  }
  return { total: manifest.chunks.length, done, pending, partial };
}
