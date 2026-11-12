/**
 * Triage stage of grant-ask: a judge reads every company profile and says whether the company
 * plausibly has a defence, security or space link (yes, no or unsure, one short reason). No topic
 * filter decides what the judge sees. The safety net (signals.ts) means a "no" can never remove a
 * company that carries a structured defence signal.
 *
 * The judge is pluggable: a person or a Claude session (manual files), or a model client (api.ts,
 * refuses without a key and a spending cap). Results are leads under research-cache/ only.
 */
import { createHash } from "node:crypto";
import type { CompanyProfile } from "./profiles";
import { safetyNetSignals, weakNotes, type KnownCompanies } from "./signals";

export type Verdict = "yes" | "no" | "unsure";

export const TRIAGE_INSTRUCTIONS = `For each company profile, answer one question:

Does this company plausibly have a defence, security or space link?

Use only the profile text. Do not use outside knowledge of the company.

Answer with exactly one of:
- yes: the profile shows a clear defence, security, space or dual-use link (for example a National Defence program or contract, a space agency program, a security product, or a defence-technology business).
- no: nothing in the profile points to defence, security or space (for example a farm, a restaurant, a general software firm with no defence program).
- unsure: some signal, but not enough to say. Prefer unsure over no when in doubt.

Output format, one line per company, nothing else:
NNN | yes|no|unsure | one short reason (max 15 words)`;

const money = (n: number) => (n ? `CA$${Math.round(n).toLocaleString("en-CA")}` : "");

/** The text a judge reads for one company. Deterministic: the same profile gives the same text. */
export function formatProfile(p: CompanyProfile, n: number): string {
  const where = [p.cities.join(", "), p.provinces.join(", ")].filter(Boolean).join(" ");
  const parts = [
    `${p.grantCount} grant(s)`,
    p.contractCount ? `${p.contractCount} contract(s)` : "",
    p.firstDate ? `${p.firstDate} to ${p.lastDate}` : "",
  ].filter(Boolean);
  const head = `[${String(n).padStart(3, "0")}] ${p.name} | ${where || "?"} | ${parts.join(", ")}`;
  // Identical rows (same programme, title and description) are shown once with a count: a profile
  // repeating one standard payment 24 times adds no information after the first.
  const groups = new Map<string, { l: (typeof p.lines)[number]; n: number; last: string }>();
  for (const l of p.lines) {
    const k = JSON.stringify([l.kind, l.department, l.programme, l.title, l.description, l.value]);
    const g = groups.get(k);
    if (g) {
      g.n++;
      if (l.date > g.last) g.last = l.date;
    } else groups.set(k, { l, n: 1, last: l.date });
  }
  const rows = [...groups.values()].map(({ l, n, last }) => {
    const when = n > 1 ? `${l.date} to ${last}, ${n} times` : l.date;
    const cols =
      l.kind === "contract"
        ? ["contract", when, l.department.slice(0, 50), l.description.slice(0, 120), money(l.value)]
        : [
            "grant",
            when,
            l.department.slice(0, 50),
            l.programme.slice(0, 70),
            l.title.slice(0, 110),
            l.description.slice(0, 160),
          ];
    return `  - ${cols.filter((c) => c !== "").join(" | ")}`;
  });
  return [head, ...rows].join("\n");
}

export function profileHash(p: CompanyProfile): string {
  return createHash("sha256").update(formatProfile(p, 0)).digest("hex").slice(0, 16);
}

export interface TriageLine {
  n: number;
  verdict: Verdict;
  reason: string;
}

/**
 * Removes markdown links "[text](url)" that some chat tools append to every line as source
 * citations. Done by scanning, so a long signed URL never reaches the stored reason.
 */
export function stripMarkdownLinks(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "[") {
      const close = text.indexOf("](", i);
      const end = close < 0 ? -1 : text.indexOf(")", close + 2);
      if (close > i && end > close) {
        i = end + 1;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

/** Parses `NNN | yes|no|unsure | reason`; ignores blank lines; throws on anything else. */
export function parseVerdictLines(text: string): TriageLine[] {
  const out: TriageLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripMarkdownLinks(raw).trim();
    if (!line) continue;
    const m = /^(\d{1,6}) \| (yes|no|unsure) \| (.+)$/.exec(line);
    if (!m) throw new Error(`unparseable verdict line: ${line.slice(0, 80)}`);
    out.push({ n: Number(m[1]), verdict: m[2] as Verdict, reason: m[3]!.trim() });
  }
  return out;
}

export interface TriageRecord {
  key: string;
  name: string;
  businessNumber: string | null;
  verdict: Verdict;
  reason: string;
  signals: string[];
  /** Weaker facts shown to a reader; they never keep a company on the list. */
  notes: string[];
  /** in = on the lead list; out = judged no and no safety-net signal. */
  status: "in" | "kept_by_safety_net" | "out";
  profileHash: string;
  judge: string;
}

/** Combines a judgement with the safety net. A "no" never removes a company with a signal. */
export function finalise(
  p: CompanyProfile,
  verdict: Verdict,
  reason: string,
  judge: string,
  known?: KnownCompanies,
): TriageRecord {
  const signals = safetyNetSignals(p, known);
  const status = verdict !== "no" ? "in" : signals.length ? "kept_by_safety_net" : "out";
  return {
    key: p.key,
    name: p.name,
    businessNumber: p.businessNumber,
    verdict,
    reason,
    signals,
    notes: weakNotes(p),
    status,
    profileHash: profileHash(p),
    judge,
  };
}

/** Judges a batch. `numbering` maps the number in the profile text back to the company. */
export interface TriageJudge {
  readonly name: string;
  judgeBatch(profiles: { n: number; text: string }[]): Promise<TriageLine[]>;
}

export interface TriageRunOptions {
  batchSize: number;
  known?: KnownCompanies;
  /** Records already judged with an identical profile are reused and cost nothing. */
  cache?: ReadonlyMap<string, TriageRecord>;
  /** Called after every batch with the records finished so far, so a run can save its progress. */
  onBatch?: (done: number, total: number, soFar: TriageRecord[]) => void;
}

export async function runTriage(
  profiles: CompanyProfile[],
  judge: TriageJudge,
  opts: TriageRunOptions,
): Promise<TriageRecord[]> {
  const results = new Map<string, TriageRecord>();
  const todo: CompanyProfile[] = [];
  for (const p of profiles) {
    const hit = opts.cache?.get(p.key);
    if (hit && hit.profileHash === profileHash(p) && hit.judge === judge.name) {
      results.set(p.key, finalise(p, hit.verdict, hit.reason, hit.judge, opts.known));
    } else todo.push(p);
  }
  for (let i = 0; i < todo.length; i += opts.batchSize) {
    const batch = todo.slice(i, i + opts.batchSize);
    const numbered = batch.map((p, j) => ({ n: j + 1, text: formatProfile(p, j + 1), p }));
    const lines = await judge.judgeBatch(numbered.map(({ n, text }) => ({ n, text })));
    const byN = new Map(lines.map((l) => [l.n, l]));
    for (const { n, p } of numbered) {
      const l = byN.get(n);
      // A missing answer is "unsure", never "no": an unanswered company must stay in play.
      results.set(
        p.key,
        finalise(
          p,
          l?.verdict ?? "unsure",
          l?.reason ?? "no answer from judge",
          judge.name,
          opts.known,
        ),
      );
    }
    opts.onBatch?.(Math.min(i + opts.batchSize, todo.length), todo.length, [...results.values()]);
  }
  return profiles.map((p) => results.get(p.key)!);
}
