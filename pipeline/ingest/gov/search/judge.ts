/**
 * Judge stage of the grant search: decides whether each candidate really matches the query and
 * says why in one sentence. Pluggable so an AI model can do it once there is an API key; until then
 * a person (or Claude in a session) judges a batch file by hand. A judgement is a lead, never
 * evidence: it creates no research record.
 *
 * ApiJudge (design, not active): reads the key from CANDEF_JUDGE_API_KEY; for each candidate sends
 * the query plus the candidate's title, description, programme and department (never personal data;
 * individuals are already excluded) and asks for `{match, reason}` as JSON; validates the reply with
 * the same rules as a hand-judged file; caches replies by query and row locator so a rerun costs
 * nothing; caps calls per run. Without a key it refuses before any network access.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate } from "./search";

export type Verdict = "yes" | "no" | "unsure";
export interface Judgement {
  match: Verdict;
  reason: string;
}
export interface Judge {
  readonly name: string;
  judge(query: string, candidates: Candidate[]): Promise<Map<string, Judgement>>;
}

/** One sentence: non-empty, single line, at most 300 characters. */
export function checkJudgement(value: unknown): Judgement {
  const v = value as Partial<Judgement> | null;
  if (!v || !["yes", "no", "unsure"].includes(v.match as string))
    throw new Error("match must be yes, no or unsure");
  const reason = typeof v.reason === "string" ? v.reason.trim() : "";
  if (!reason || reason.length > 300 || /[\r\n]/.test(reason))
    throw new Error("reason must be one sentence on one line (at most 300 characters)");
  return { match: v.match as Verdict, reason };
}

export interface ToJudgeItem {
  key: string;
  rank: number;
  recipient: string;
  title: string;
  description: string;
  programme: string;
  department: string;
  matchedTerms: string[];
}
export interface ToJudgeFile {
  format: "candef-grant-search-to-judge";
  version: 1;
  query: string;
  instructions: string;
  items: ToJudgeItem[];
}
export interface JudgedFile {
  format: "candef-grant-search-judged";
  version: 1;
  query: string;
  judgements: ({ key: string } & Judgement)[];
}

export const TO_JUDGE = "to-judge.json";
export const JUDGED = "judged.json";

export function toJudgeFile(query: string, candidates: Candidate[]): ToJudgeFile {
  return {
    format: "candef-grant-search-to-judge",
    version: 1,
    query,
    instructions:
      'For each item write {key, match: "yes" | "no" | "unsure", reason: one sentence} into judged.json (format candef-grant-search-judged). Judge only from the text shown; a match is a lead, not evidence.',
    items: candidates.map((c) => ({
      key: c.key,
      rank: c.rank,
      recipient: c.recipient,
      title: c.title,
      description: c.description,
      programme: c.programme,
      department: c.department,
      matchedTerms: c.matchedTerms,
    })),
  };
}

/** Hand judging: the batch file is written by the CLI; this reads the judged file back. */
export class ManualJudge implements Judge {
  readonly name = "manual";
  constructor(private readonly dir: string) {}
  async judge(query: string, candidates: Candidate[]): Promise<Map<string, Judgement>> {
    const file = JSON.parse(await readFile(join(this.dir, JUDGED), "utf8")) as JudgedFile;
    if (file.format !== "candef-grant-search-judged" || file.version !== 1)
      throw new Error("Not a judged file");
    if (file.query !== query) throw new Error("Judged file is for a different query");
    const out = new Map<string, Judgement>();
    for (const j of file.judgements) {
      if (out.has(j.key)) throw new Error(`Duplicate judgement: ${j.key}`);
      out.set(j.key, checkJudgement(j));
    }
    const missing = candidates.filter((c) => !out.has(c.key)).map((c) => c.key);
    if (missing.length) throw new Error(`Not judged: ${missing.slice(0, 5).join(", ")}`);
    const unknown = [...out.keys()].filter((k) => !candidates.some((c) => c.key === k));
    if (unknown.length)
      throw new Error(`Judged keys not in this run: ${unknown.slice(0, 5).join(", ")}`);
    return out;
  }
}

/** Placeholder for the model-backed judge; never makes a call without a key, and is inactive. */
export class ApiJudge implements Judge {
  readonly name = "api";
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}
  async judge(): Promise<Map<string, Judgement>> {
    if (!this.env.CANDEF_JUDGE_API_KEY)
      throw new Error("No API key (CANDEF_JUDGE_API_KEY); no call made. Use the manual judge.");
    throw new Error("ApiJudge is a documented stub (see judge.ts); no call made.");
  }
}
