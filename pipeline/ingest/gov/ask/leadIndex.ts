/**
 * Lead index of grant-ask: one row per company, built from the company profiles and the triage
 * verdicts. It adds three things the triage does not give: a tier (how strong the defence, space or
 * security link is, by fixed rules on government rows, never by company name), keyword tags with
 * their evidence rows, and the counts a reader filters on (first appearance, first-time grant
 * recipient, totals).
 *
 * Deterministic: the same inputs give the same output. Leads only: nothing here is a verified fact,
 * and nothing is written under research/.
 *
 * Tiers (docs/LEADS_SEARCH_HANDOFF.md §3):
 *   A  a defence, space or security link by rule (structured signal, STRONG contract category,
 *      MEDIUM category from National Defence / Space Agency with size or breadth, or defence text)
 *   B  National Defence or Canadian Space Agency supplier only
 *   C  public-safety supplier only (RCMP, Correctional Service, CBSA, Public Safety, CSIS)
 *   D  judge-only lead (the judge said yes or unsure, no rule evidence)
 *   out  everything else
 * A company with an A rule that the judge said "no" to is still A (judgeSaidNo); nothing is subtracted.
 */
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CompanyProfile } from "./profiles";
import { DEFENCE_PROGRAMME_NAMES, type KnownCompanies } from "./signals";
import { defenceTextMatch, lineText, tagLines, type TagEvidence } from "./tags";

export type Tier = "A" | "B" | "C" | "D" | "out";

export interface TierEvidence {
  rule: string;
  /** Index into the company's profile lines; null for company-level rules (a known CANDEF organization). */
  line: number | null;
  detail?: string;
}

/** What the index keeps of a triage record. */
export interface TriageInfo {
  verdict: "yes" | "no" | "unsure";
  reason: string;
  judge: string;
  status: string;
}

export interface LeadRow {
  key: string;
  name: string;
  otherNames: string[];
  businessNumber: string | null;
  cities: string[];
  provinces: string[];
  /** First and last appearance in government data. NOT the founding date. */
  firstDate: string | null;
  lastDate: string | null;
  /** First grant start date when it can be known from the stored rows, else null. */
  firstGrantDate: string | null;
  /** Distinct grant agreements (amendments collapsed). */
  grantAgreements: number;
  grantCount: number;
  contractCount: number;
  grantValue: number;
  contractValue: number;
  dndContractValue: number;
  /** Space Agency money in the stored rows (a lower bound when the profile has more rows than are stored). */
  csaValue: number;
  departments: string[];
  programmes: string[];
  verdict: "yes" | "no" | "unsure" | null;
  reason: string;
  judge: string;
  status: string;
  signals: string[];
  tier: Tier;
  tierEvidence: TierEvidence[];
  judgeSaidNo: boolean;
  tags: string[];
  tagEvidence: TagEvidence[];
  firstTimeGrantRecipient: boolean;
  /** Indices of the stored profile lines: a claim cites {key, line}. */
  sourceLines: number[];
  /** Position of the profile in profiles.jsonl, for reading the full profile back. */
  profileOffset: number;
  profileLength: number;
}

// ---- Contract categories ------------------------------------------------------------------------

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^\d{3,4}\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

/** STRONG categories: a contract in one of these is a defence, space or security link on its own. */
export const STRONG_CATEGORY: RegExp[] = [
  /(?<!non-)(?<!non )\bmilitary\b/,
  /\bcombat\b/,
  /\bradar\b|\bsonar\b/,
  /\belectronic warfare\b/,
  /\bnight vision\b/,
  /\buninhabited\b|\bunmanned\b|\buav\b/,
  /\bsatellites?\b|\bspacecraft\b/,
  /\bairframe/,
  /\bhelicopters?\b/,
  /\barmou?r(?:ed)?\b/,
  /\bballistic\b/,
  /\bcbrn\b|\bchemical warfare\b|\bchemical\/biological studies\b/,
  /\bsimulators?\b/,
  /\(r&d\)|\br&d\b/,
  /logistics support services \(transportation and defence\)/,
  /\bemanation control\b/,
  /\bcryptologic\b/,
  /\bsecurity control systems\b/,
];

/**
 * Weapon and explosive categories are applied loosely by civilian departments (a fisheries lab
 * order filed as "Weapons (including parts)"), so they count only when a defence or police buyer
 * placed the contract. The other STRONG categories (radar, satellites, military R&D...) count from any buyer.
 */
export const STRONG_CATEGORY_SECURITY_BUYER: RegExp[] = [
  /\bweapons?\b/,
  /\bammunition\b|\bmunitions?\b/,
  /\bordnance\b|\barmaments?\b/,
  /\bmissiles?\b/,
  /\bexplosives?\b/,
  /\bfire control\b/,
  /\bguided\b/,
];

/**
 * Categories that identify defence equipment only when National Defence or the Space Agency is the
 * buyer (the same words are ordinary office purchases elsewhere). A single contract is enough.
 */
export const DEFENCE_BUYER_CATEGORY: RegExp[] = [
  /radio and television communications? equipment, except airborne/,
  /electrical and electronic assemblies; boards, cards/,
];

/** MEDIUM categories (National Defence / Space Agency contracts only): group name -> pattern. */
export const MEDIUM_CATEGORY: Record<string, RegExp> = {
  comms: /\bradio\b|communications\/networking|communications equipment/,
  electronics:
    /electronic(?:s| or electrical)? assembl|electrical (?:or|and) electronic assembl|electronic components/,
  measuring: /electrical and electronic measuring|\boscilloscopes?\b|\bamplifiers?\b/,
  cameras: /high[- ]speed|instrumentation camera/,
  optics: /optical instrument|optical sighting/,
  navigation: /\bnavigation/,
  marine: /\bships?\b|\bboats?\b|marine equipment/,
  engineering: /engineering and technical services|\bengineering services\b/,
  scientific: /scientific (?:services|consultants)|research contracts/,
  protection: /\bprotection services\b/,
};

/** "aircraft" counts (parts, engines, accessories, the aircraft itself) unless the contract is a hire, fuel, tyres or de-icing. */
const AIRCRAFT = /(?<!non-)(?<!except )\baircraft\b/;
const AIRCRAFT_VETO = /\b(?:rental|charter|chartered|lease|leases|fuel|tires|de-?icing)\b/;

const SECURITY_BUYERS = new Set([
  "dnd-mdn",
  "csa-asc",
  "rcmp-grc",
  "csc-scc",
  "cbsa-asfc",
  "ps-sp",
  "csis-scrs",
]);

/** `ownerOrg` is the buying department; without it the weapon categories count from any buyer. */
export function isStrongCategory(category: string, ownerOrg?: string): boolean {
  const c = norm(category);
  if (STRONG_CATEGORY.some((re) => re.test(c)) || (AIRCRAFT.test(c) && !AIRCRAFT_VETO.test(c)))
    return true;
  return (
    (ownerOrg === undefined || SECURITY_BUYERS.has(ownerOrg)) &&
    STRONG_CATEGORY_SECURITY_BUYER.some((re) => re.test(c))
  );
}

export function isDefenceBuyerCategory(category: string): boolean {
  const c = norm(category);
  return DEFENCE_BUYER_CATEGORY.some((re) => re.test(c));
}

export function mediumGroup(category: string): string | null {
  const c = norm(category);
  for (const [g, re] of Object.entries(MEDIUM_CATEGORY)) if (re.test(c)) return g;
  return null;
}

export const PUBLIC_SAFETY_ORGS = new Set([
  "rcmp-grc",
  "csc-scc",
  "cbsa-asfc",
  "ps-sp",
  "csis-scrs",
]);
const isDefenceOrg = (o: string) => o === "dnd-mdn" || o === "csa-asc";

// ---- Tier rules ---------------------------------------------------------------------------------

/** Medium-category rule thresholds. */
export const MEDIUM_MIN_VALUE = 100_000;
export const MEDIUM_MIN_GROUPS = 2;
/** Rule 5: total of all National Defence contracts (CA$) that counts as a defence relationship on its own. */
export const LARGE_DND_TOTAL = 10_000_000;

/** All rule evidence for a company, in rule order. Empty means no A rule fired. */
export function tierARules(p: CompanyProfile, known?: KnownCompanies): TierEvidence[] {
  const ev: TierEvidence[] = [];
  // Rule 1: structured signals other than a plain National Defence contract.
  if (known && p.businessNumber && known.businessNumbers.has(p.businessNumber))
    ev.push({ rule: "1:candef-organization", line: null });
  p.lines.forEach((l, i) => {
    if (l.kind === "grant" && l.ownerOrg === "dnd-mdn")
      ev.push({ rule: "1:national-defence-grant", line: i });
    else if (l.kind === "grant" && l.ownerOrg === "csa-asc")
      ev.push({ rule: "1:space-agency-grant", line: i });
    else if (l.kind === "grant" && DEFENCE_PROGRAMME_NAMES.test(l.programme))
      ev.push({ rule: "1:defence-programme", line: i, detail: l.programme });
  });
  // Rule 2: a contract in a STRONG category, any department.
  p.lines.forEach((l, i) => {
    if (l.kind === "contract" && isStrongCategory(l.description, l.ownerOrg))
      ev.push({ rule: "2:strong-category", line: i, detail: l.description });
  });
  p.lines.forEach((l, i) => {
    if (l.kind === "contract" && isDefenceOrg(l.ownerOrg) && isDefenceBuyerCategory(l.description))
      ev.push({ rule: "2:defence-buyer-category", line: i, detail: l.description });
  });
  // Rule 3: National Defence / Space Agency contracts in MEDIUM categories, with size or breadth.
  const groups = new Set<string>();
  let mediumValue = 0;
  const mediumLines: number[] = [];
  p.lines.forEach((l, i) => {
    if (l.kind !== "contract" || !isDefenceOrg(l.ownerOrg)) return;
    const g = mediumGroup(l.description);
    if (!g) return;
    groups.add(g);
    mediumValue += l.value;
    mediumLines.push(i);
  });
  if (mediumLines.length && (mediumValue >= MEDIUM_MIN_VALUE || groups.size >= MEDIUM_MIN_GROUPS))
    for (const i of mediumLines)
      ev.push({ rule: "3:medium-category", line: i, detail: p.lines[i]!.description });
  // Rule 5: a very large total of National Defence contracts.
  if (p.dndContractValue >= LARGE_DND_TOTAL)
    ev.push({ rule: "5:large-defence-total", line: null, detail: String(p.dndContractValue) });
  // Rule 4: defence, security or space words in a row's own text.
  p.lines.forEach((l, i) => {
    const m = defenceTextMatch(lineText(l));
    if (m) ev.push({ rule: "4:defence-text", line: i, detail: m });
  });
  return ev;
}

export interface TierResult {
  tier: Tier;
  evidence: TierEvidence[];
  judgeSaidNo: boolean;
}

export function assignTier(
  p: CompanyProfile,
  triage: TriageInfo | null,
  known?: KnownCompanies,
): TierResult {
  const a = tierARules(p, known);
  const verdict = triage?.verdict ?? null;
  if (a.length) return { tier: "A", evidence: a, judgeSaidNo: verdict === "no" };
  const defenceContracts = p.lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.kind === "contract" && isDefenceOrg(l.ownerOrg));
  if (defenceContracts.length || p.dndContractValue > 0)
    return {
      tier: "B",
      evidence: defenceContracts.map(({ i }) => ({ rule: "B:defence-supplier", line: i })),
      judgeSaidNo: verdict === "no",
    };
  const judged = verdict === "yes" || verdict === "unsure";
  const safety = p.lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.kind === "contract" && PUBLIC_SAFETY_ORGS.has(l.ownerOrg));
  if (judged && safety.length)
    return {
      tier: "C",
      evidence: safety.map(({ i }) => ({ rule: "C:public-safety-supplier", line: i })),
      judgeSaidNo: false,
    };
  if (judged)
    return { tier: "D", evidence: [{ rule: "D:judge-only", line: null }], judgeSaidNo: false };
  return { tier: "out", evidence: [], judgeSaidNo: false };
}

// ---- Row building -------------------------------------------------------------------------------

/** Structured signals as plain labels (for display). */
function signalLabels(ev: TierEvidence[]): string[] {
  const out = new Set<string>();
  for (const e of ev) {
    if (e.rule === "1:candef-organization") out.add("already a CANDEF organization");
    if (e.rule === "1:national-defence-grant") out.add("National Defence grant or contribution");
    if (e.rule === "1:space-agency-grant") out.add("Canadian Space Agency grant");
    if (e.rule === "1:defence-programme") out.add(`defence programme: ${e.detail}`);
  }
  return [...out].slice(0, 4);
}

const distinct = (xs: string[]) => [...new Set(xs.filter(Boolean))];

export function buildLeadRow(
  p: CompanyProfile,
  triage: TriageInfo | null,
  known: KnownCompanies | undefined,
  offset: { profileOffset: number; profileLength: number },
): LeadRow {
  const t = assignTier(p, triage, known);
  const tagEvidence = tagLines(p.lines);
  const grantLines = p.lines.filter((l) => l.kind === "grant");
  // The profile stores at most a dozen rows, so the first grant date is known only when all grant
  // rows are stored (or the company has no contracts, so its first date is its first grant date).
  let firstGrantDate: string | null = null;
  if (p.grantCount > 0) {
    if (p.contractCount === 0) firstGrantDate = p.firstDate;
    else if (grantLines.length === p.grantCount)
      firstGrantDate =
        grantLines
          .map((l) => l.date)
          .filter(Boolean)
          .sort()[0] ?? null;
  }
  const csaValue = Math.round(
    p.lines.filter((l) => l.ownerOrg === "csa-asc").reduce((s, l) => s + l.value, 0),
  );
  return {
    key: p.key,
    name: p.name,
    otherNames: p.otherNames,
    businessNumber: p.businessNumber,
    cities: p.cities,
    provinces: p.provinces,
    firstDate: p.firstDate,
    lastDate: p.lastDate,
    firstGrantDate,
    grantAgreements: p.grantCount,
    grantCount: p.grantCount,
    contractCount: p.contractCount,
    grantValue: p.grantValue,
    contractValue: p.contractValue,
    dndContractValue: p.dndContractValue,
    csaValue,
    departments: distinct(p.lines.map((l) => l.department)),
    programmes: distinct(p.lines.map((l) => l.programme)),
    verdict: triage?.verdict ?? null,
    reason: triage?.reason ?? "",
    judge: triage?.judge ?? "",
    status: triage?.status ?? "",
    signals: signalLabels(t.evidence),
    tier: t.tier,
    tierEvidence: t.evidence,
    judgeSaidNo: t.judgeSaidNo,
    tags: tagEvidence.map((e) => e.tag),
    tagEvidence,
    firstTimeGrantRecipient: p.grantCount === 1,
    sourceLines: p.lines.map((_, i) => i),
    ...offset,
  };
}

// ---- Index run ----------------------------------------------------------------------------------

export interface IndexSummary {
  total: number;
  byTier: Record<Tier, number>;
  byTag: Record<string, number>;
  byProvince: Record<string, number>;
  byJudge: Record<string, number>;
  judgeSaidNoInA: number;
  byTierRule: Record<string, number>;
  firstTimeGrantRecipients: number;
}

export function emptySummary(): IndexSummary {
  return {
    total: 0,
    byTier: { A: 0, B: 0, C: 0, D: 0, out: 0 },
    byTag: {},
    byProvince: {},
    byJudge: {},
    judgeSaidNoInA: 0,
    byTierRule: {},
    firstTimeGrantRecipients: 0,
  };
}

export function addToSummary(s: IndexSummary, r: LeadRow): void {
  s.total++;
  s.byTier[r.tier]++;
  for (const t of r.tags) s.byTag[t] = (s.byTag[t] ?? 0) + 1;
  for (const pr of r.provinces.length ? r.provinces : ["?"])
    s.byProvince[pr] = (s.byProvince[pr] ?? 0) + 1;
  const j = r.judge || "none";
  s.byJudge[j] = (s.byJudge[j] ?? 0) + 1;
  if (r.tier === "A" && r.judgeSaidNo) s.judgeSaidNoInA++;
  for (const rule of new Set(r.tierEvidence.map((e) => e.rule)))
    s.byTierRule[rule] = (s.byTierRule[rule] ?? 0) + 1;
  if (r.firstTimeGrantRecipient) s.firstTimeGrantRecipients++;
}

export function readTriage(path: string): Promise<Map<string, TriageInfo>> {
  return new Promise((resolve, reject) => {
    const m = new Map<string, TriageInfo>();
    const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const r = JSON.parse(line) as {
        key: string;
        verdict: TriageInfo["verdict"];
        reason: string;
        judge?: string;
        status: string;
      };
      m.set(r.key, {
        verdict: r.verdict,
        reason: r.reason,
        judge: r.judge ?? "",
        status: r.status,
      });
    });
    rl.on("close", () => resolve(m));
    rl.on("error", reject);
  });
}

/**
 * Stream profiles.jsonl and write leads.jsonl (every company) and search.jsonl (companies that are
 * not tier "out", with their stored rows, which the search reads), plus summary.json.
 */
export async function buildIndex(opts: {
  profilesPath: string;
  triagePath: string;
  outDir: string;
  known?: KnownCompanies;
}): Promise<IndexSummary> {
  const triage = await readTriage(opts.triagePath);
  await mkdir(opts.outDir, { recursive: true });
  const leads = await open(join(opts.outDir, "leads.jsonl"), "w");
  const search = await open(join(opts.outDir, "search.jsonl"), "w");
  const summary = emptySummary();
  let offset = 0;
  try {
    const rl = createInterface({
      input: createReadStream(opts.profilesPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let buf: string[] = [];
    let sbuf: string[] = [];
    const flush = async () => {
      if (buf.length) await leads.write(buf.join(""));
      if (sbuf.length) await search.write(sbuf.join(""));
      buf = [];
      sbuf = [];
    };
    for await (const line of rl) {
      const byteLen = Buffer.byteLength(line, "utf8");
      if (line.trim()) {
        const p = JSON.parse(line) as CompanyProfile;
        const row = buildLeadRow(p, triage.get(p.key) ?? null, opts.known, {
          profileOffset: offset,
          profileLength: byteLen,
        });
        addToSummary(summary, row);
        buf.push(JSON.stringify(row) + "\n");
        if (row.tier !== "out") sbuf.push(JSON.stringify({ ...row, lines: p.lines }) + "\n");
        if (buf.length >= 2000) await flush();
      }
      offset += byteLen + 1; // profiles.jsonl is written with "\n" line ends
    }
    await flush();
  } finally {
    await leads.close();
    await search.close();
  }
  await writeFile(join(opts.outDir, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}
