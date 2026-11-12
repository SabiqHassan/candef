/**
 * Rounds radar (P-68): one sweep. Reads the enabled sources since the last sweep, keeps Canadian
 * funding leads, matches them to CANDEF companies and writes a dated lead list to
 * research-cache/radar/ (gitignored). It never writes to research/: turning a lead into a record is
 * the runbook's job (docs/RADAR.md), after the primary source is read.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Corpus } from "../../../src/domain/schema/corpus";
import { robotsAllows, USER_AGENT, visibleText } from "../capture";
import {
  buildNameIndex,
  federalRowsFor,
  findMentions,
  matchName,
  type FederalRows,
  type NameIndex,
  type OrgRef,
} from "./match";
import {
  extractAmounts,
  FORM_D_TYPES,
  formDPrimaryDocUrl,
  FUNDING_SIGNAL,
  parseDailyIndex,
  parseFeed,
  parseFormDSubmission,
  inScope,
  type FormD,
} from "./parse";
import {
  CANADA_STATE_CODES,
  GC_NEWS,
  isCanadianStateCode,
  RSS_SOURCES,
  SEC_FORM_D,
  type RadarSource,
} from "./sources";

export type LeadKind = "private_round" | "government_announcement" | "news";
/** existing: about a CANDEF company; candidate: possibly a new company in scope; low/fund: listed in leads.json only. */
export type Relevance = "existing" | "candidate" | "low" | "fund";

export interface RadarLead {
  id: string;
  source: string;
  kind: LeadKind;
  relevance: Relevance;
  /** Filing date or publication date, YYYY-MM-DD when known. */
  date: string | null;
  title: string;
  url: string;
  reportedName: string | null;
  place: string | null;
  matches: (OrgRef & { how: "exact-name" | "mention" })[];
  formD?: Pick<
    FormD,
    | "accession"
    | "cik"
    | "submissionType"
    | "isAmendment"
    | "previousAccession"
    | "industryGroup"
    | "investmentFundType"
    | "totalOfferingAmount"
    | "totalAmountSold"
    | "dateOfFirstSale"
    | "firstSaleYetToOccur"
    | "securities"
    | "jurisdictionOfInc"
    | "yearOfInc"
  >;
  /** Dollar amounts as written in an announcement (short facts, not excerpts). */
  amounts?: string[];
  department?: string;
  /** Defence, security, space or dual-use words appear. */
  inScopeWords?: boolean;
  federal?: FederalRows | null;
}

export interface RadarState {
  version: 1;
  sec: { lastCompleteDate: string | null; ciks: Record<string, string>; seen: string[] };
  gcnews: { lastRunDate: string | null; seen: string[] };
  rss: Record<string, { seen: string[] }>;
  sweeps: { at: string; since: string; until: string; leads: number; dir: string }[];
}

export interface SweepStats {
  requests: number;
  sec: {
    days: number;
    indexFiles: number;
    formD: number;
    fetched: number;
    canadian: number;
    skippedKnownForeign: number;
    stoppedEarly: boolean;
  };
  gcnews: { feeds: number; items: number; opened: number };
  rss: { feeds: number; items: number };
  notes: string[];
}

export interface SweepOptions {
  corpus: Corpus;
  cacheDir: string;
  /** YYYY-MM-DD (the sweep's date). */
  today: string;
  /** Overrides the per-source start date (default: the day after the last sweep, else 7 days ago). */
  since?: string;
  until?: string;
  only?: string[];
  /** Cap on SEC requests in one sweep (a later sweep continues where this one stopped). */
  maxSecRequests?: number;
  /** Cap on government release pages opened in one sweep. */
  maxPages?: number;
  /** grant-ask lead index (JSON lines), used to flag new filers that have federal defence or space rows. */
  federalIndexFile?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
  /** Write nothing (state or leads); print only. */
  dryRun?: boolean;
}

export interface SweepResult {
  leads: RadarLead[];
  stats: SweepStats;
  since: { sec: string; gcnews: string };
  until: string;
  dir: string | null;
  markdown: string;
}

const SEEN_CAP = 20000;
const CORE_INDUSTRIES = new Set([
  "Computers",
  "Telecommunications",
  "Other Technology",
  "Manufacturing",
  "Business Services",
  "Other",
  "Energy Conservation",
  "Environmental Services",
  "Other Energy",
  "Electric Utilities",
]);

/** YYYY-MM-DD from an ISO or RFC 822 date, or null. */
function isoDate(raw: string | null): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function emptyState(): RadarState {
  return {
    version: 1,
    sec: { lastCompleteDate: null, ciks: {}, seen: [] },
    gcnews: { lastRunDate: null, seen: [] },
    rss: {},
    sweeps: [],
  };
}

export function loadState(cacheDir: string): RadarState {
  const file = join(cacheDir, "radar", "state.json");
  if (!existsSync(file)) return emptyState();
  const s = JSON.parse(readFileSync(file, "utf8")) as RadarState;
  return { ...emptyState(), ...s };
}

function saveState(cacheDir: string, state: RadarState) {
  const trim = (a: string[]) => a.slice(-SEEN_CAP);
  state.sec.seen = trim(state.sec.seen);
  state.gcnews.seen = trim(state.gcnews.seen);
  for (const k of Object.keys(state.rss)) state.rss[k]!.seen = trim(state.rss[k]!.seen);
  state.sweeps = state.sweeps.slice(-200);
  mkdirSync(join(cacheDir, "radar"), { recursive: true });
  writeFileSync(join(cacheDir, "radar", "state.json"), JSON.stringify(state, null, 2) + "\n");
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Weekdays from `since` to `until`, inclusive (EDGAR publishes no index on weekends). */
export function weekdays(since: string, until: string): string[] {
  const out: string[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) out.push(d);
    if (out.length > 400) break;
  }
  return out;
}

export function dailyIndexUrl(date: string): string {
  const [y, m, d] = date.split("-");
  const q = Math.floor((Number(m) - 1) / 3) + 1;
  return `${SEC_FORM_D.url}${y}/QTR${q}/form.${y}${m}${d}.idx`;
}

/** Robots-aware, per-host throttled GET. A host whose robots.txt cannot be read (5xx, network) is skipped. */
class PoliteClient {
  requests = 0;
  private robots = new Map<string, string | null | "deny">();
  private next = new Map<string, number>();
  constructor(
    private readonly doFetch: typeof fetch,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number,
  ) {}

  private async throttle(host: string, rate: number) {
    const wait = (this.next.get(host) ?? 0) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.next.set(host, this.now() + 1000 / rate);
  }

  async get(
    url: string,
    rate: number,
  ): Promise<{ ok: true; status: number; text: string } | { ok: false; reason: string }> {
    const u = new URL(url);
    if (!this.robots.has(u.host)) {
      await this.throttle(u.host, rate);
      try {
        const r = await this.doFetch(new URL("/robots.txt", u), {
          headers: { "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(20_000),
        });
        this.requests++;
        this.robots.set(
          u.host,
          r.ok ? await r.text() : r.status === 404 || r.status === 410 ? null : "deny",
        );
      } catch {
        this.robots.set(u.host, "deny");
      }
    }
    const robots = this.robots.get(u.host);
    if (robots === "deny")
      return { ok: false, reason: `robots.txt of ${u.host} could not be read` };
    if (robots && !robotsAllows(robots, USER_AGENT, u.pathname + u.search))
      return { ok: false, reason: `robots.txt of ${u.host} disallows ${u.pathname}` };
    await this.throttle(u.host, rate);
    try {
      const res = await this.doFetch(u, {
        headers: { "user-agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      this.requests++;
      return { ok: true, status: res.status, text: await res.text() };
    } catch (e) {
      return { ok: false, reason: `${u.host}: ${(e as Error).message}` };
    }
  }
}

function place(city: string | null, code: string | null): string | null {
  const prov = code ? CANADA_STATE_CODES[code.toUpperCase()] : undefined;
  const c = city
    ? city.replace(/\b\w+/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase())
    : null;
  return [c, prov].filter(Boolean).join(", ") || null;
}

export function formDLead(d: FormD, index: NameIndex): RadarLead {
  const reported = d.entityName ?? d.filerName;
  const matches = new Map<string, OrgRef & { how: "exact-name" }>();
  for (const n of new Set([reported, d.filerName]))
    for (const m of matchName(index, n)) matches.set(m.orgId, { ...m, how: "exact-name" });
  const fund =
    Boolean(d.investmentFundType) ||
    d.industryGroup === "Pooled Investment Fund" ||
    d.securities.includes("pooled investment fund interest");
  const relevance: Relevance = matches.size
    ? "existing"
    : fund
      ? "fund"
      : d.industryGroup && CORE_INDUSTRIES.has(d.industryGroup)
        ? "candidate"
        : "low";
  const canadian = isCanadianStateCode(d.businessState) ? d.businessState : d.issuerState;
  return {
    id: `sec:${d.accession}`,
    source: SEC_FORM_D.id,
    kind: "private_round",
    relevance,
    date: d.filedOn,
    title: `Form ${d.submissionType}: ${reported}`,
    url: formDPrimaryDocUrl(d.cik, d.accession),
    reportedName: reported,
    place: place(isCanadianStateCode(d.businessState) ? d.businessCity : d.issuerCity, canadian),
    matches: [...matches.values()],
    formD: {
      accession: d.accession,
      cik: d.cik,
      submissionType: d.submissionType,
      isAmendment: d.isAmendment,
      previousAccession: d.previousAccession,
      industryGroup: d.industryGroup,
      investmentFundType: d.investmentFundType,
      totalOfferingAmount: d.totalOfferingAmount,
      totalAmountSold: d.totalAmountSold,
      dateOfFirstSale: d.dateOfFirstSale,
      firstSaleYetToOccur: d.firstSaleYetToOccur,
      securities: d.securities,
      jurisdictionOfInc: d.jurisdictionOfInc,
      yearOfInc: d.yearOfInc,
    },
  };
}

/** The main content of a canada.ca page (falls back to the whole page). */
function mainText(html: string): string {
  const m = /<main\b[\s\S]*?<\/main>/i.exec(html);
  return visibleText(m ? m[0] : html);
}

export async function sweep(o: SweepOptions): Promise<SweepResult> {
  const log = o.log ?? (() => {});
  const client = new PoliteClient(
    o.fetchImpl ?? fetch,
    o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    o.now ?? Date.now,
  );
  const state = loadState(o.cacheDir);
  const index = buildNameIndex(o.corpus);
  const until = o.until ?? o.today;
  const fallback = addDays(o.today, -7);
  const since = {
    sec:
      o.since ?? (state.sec.lastCompleteDate ? addDays(state.sec.lastCompleteDate, 1) : fallback),
    gcnews: o.since ?? state.gcnews.lastRunDate ?? fallback,
  };
  const want = (s: RadarSource) => s.enabled && (!o.only || o.only.includes(s.id));
  const stats: SweepStats = {
    requests: 0,
    sec: {
      days: 0,
      indexFiles: 0,
      formD: 0,
      fetched: 0,
      canadian: 0,
      skippedKnownForeign: 0,
      stoppedEarly: false,
    },
    gcnews: { feeds: 0, items: 0, opened: 0 },
    rss: { feeds: 0, items: 0 },
    notes: [],
  };
  const leads: RadarLead[] = [];

  // ---- SEC Form D
  if (want(SEC_FORM_D)) {
    const seen = new Set(state.sec.seen);
    const max = o.maxSecRequests ?? 2500;
    const days = weekdays(since.sec, until);
    stats.sec.days = days.length;
    const start = client.requests;
    outer: for (const day of days) {
      const idx = await client.get(dailyIndexUrl(day), SEC_FORM_D.ratePerSecond);
      if (!idx.ok) {
        stats.notes.push(`SEC: ${idx.reason}; stopped`);
        stats.sec.stoppedEarly = true;
        break;
      }
      if (idx.status === 404) {
        // No index for a holiday, or not yet published for today: a later sweep reads it.
        if (day >= addDays(o.today, -1)) {
          stats.notes.push(`SEC: no daily index yet for ${day}`);
          break;
        }
        state.sec.lastCompleteDate = day;
        continue;
      }
      if (idx.status !== 200) {
        stats.notes.push(`SEC: daily index ${day} returned HTTP ${idx.status}; stopped`);
        stats.sec.stoppedEarly = true;
        break;
      }
      stats.sec.indexFiles++;
      const entries = parseDailyIndex(idx.text).filter((e) => FORM_D_TYPES.has(e.formType));
      stats.sec.formD += entries.length;
      for (const e of entries) {
        const accession = e.path
          .split("/")
          .pop()!
          .replace(/\.txt$/, "");
        if (seen.has(accession)) continue;
        const known = state.sec.ciks[e.cik];
        if (known && !isCanadianStateCode(known)) {
          stats.sec.skippedKnownForeign++;
          seen.add(accession);
          continue;
        }
        if (client.requests - start >= max) {
          stats.sec.stoppedEarly = true;
          stats.notes.push(
            `SEC: request cap (${max}) reached during ${day}; the next sweep continues from there`,
          );
          break outer;
        }
        const sub = await client.get(
          `https://www.sec.gov/Archives/${e.path}`,
          SEC_FORM_D.ratePerSecond,
        );
        if (!sub.ok || sub.status !== 200) {
          stats.notes.push(
            `SEC: ${e.path}: ${sub.ok ? `HTTP ${sub.status}` : sub.reason} (retried next sweep)`,
          );
          if (sub.ok && sub.status === 429) {
            stats.sec.stoppedEarly = true;
            break outer;
          }
          continue;
        }
        stats.sec.fetched++;
        seen.add(accession);
        const d = parseFormDSubmission(sub.text);
        if (!d) continue;
        const code = d.businessState ?? d.issuerState;
        if (code) state.sec.ciks[e.cik] = code;
        if (!isCanadianStateCode(d.businessState) && !isCanadianStateCode(d.issuerState)) continue;
        stats.sec.canadian++;
        leads.push(formDLead(d, index));
      }
      state.sec.lastCompleteDate = day;
      log(`SEC ${day}: ${entries.length} Form D filings, ${stats.sec.canadian} Canadian so far`);
    }
    state.sec.seen = [...seen];
  }

  // ---- Government of Canada news
  if (want(GC_NEWS)) {
    const seen = new Set(state.gcnews.seen);
    const maxPages = o.maxPages ?? 150;
    for (const dept of GC_NEWS.departments) {
      const url = GC_NEWS.url.replace("{dept}", dept).replace("{since}", since.gcnews);
      const res = await client.get(url, GC_NEWS.ratePerSecond);
      if (!res.ok || res.status !== 200) {
        stats.notes.push(`Government news ${dept}: ${res.ok ? `HTTP ${res.status}` : res.reason}`);
        continue;
      }
      stats.gcnews.feeds++;
      const items = parseFeed(res.text);
      for (const item of items) {
        if (!item.link || seen.has(item.link)) continue;
        stats.gcnews.items++;
        const head = `${item.title} ${item.summary}`;
        if (!FUNDING_SIGNAL.test(head)) {
          seen.add(item.link);
          continue;
        }
        if (stats.gcnews.opened >= maxPages) {
          stats.notes.push(
            `Government news: page cap (${maxPages}) reached; the rest wait for the next sweep`,
          );
          break;
        }
        const page = await client.get(item.link, GC_NEWS.ratePerSecond);
        if (!page.ok || page.status !== 200) {
          stats.notes.push(
            `Government news page ${item.link}: ${page.ok ? `HTTP ${page.status}` : page.reason}`,
          );
          continue;
        }
        stats.gcnews.opened++;
        seen.add(item.link);
        const text = mainText(page.text);
        const mentions = findMentions(index, `${item.title} ${text}`);
        const amounts = extractAmounts(text);
        const inScopeWords = inScope(`${head} ${text}`);
        leads.push({
          id: `gcnews:${item.link}`,
          source: GC_NEWS.id,
          kind: "government_announcement",
          relevance: mentions.length
            ? "existing"
            : inScopeWords && amounts.length
              ? "candidate"
              : "low",
          date: isoDate(item.published),
          title: item.title,
          url: item.link,
          reportedName: null,
          place: null,
          matches: mentions.map((m) => ({ ...m, how: "mention" as const })),
          amounts,
          department: item.author ?? dept,
          inScopeWords,
        });
      }
    }
    state.gcnews.seen = [...seen];
    state.gcnews.lastRunDate = o.today;
  }

  // ---- RSS news feeds (off unless enabled in sources.ts)
  for (const src of RSS_SOURCES.filter(want)) {
    const st = (state.rss[src.id] ??= { seen: [] });
    const seen = new Set(st.seen);
    const res = await client.get(src.url, src.ratePerSecond);
    if (!res.ok || res.status !== 200) {
      stats.notes.push(`${src.label}: ${res.ok ? `HTTP ${res.status}` : res.reason}`);
      continue;
    }
    stats.rss.feeds++;
    for (const item of parseFeed(res.text)) {
      if (!item.link || seen.has(item.link)) continue;
      seen.add(item.link);
      stats.rss.items++;
      const head = `${item.title} ${item.summary}`;
      if (!FUNDING_SIGNAL.test(head)) continue;
      const mentions = findMentions(index, head);
      leads.push({
        id: `${src.id}:${item.link}`,
        source: src.id,
        kind: "news",
        relevance: mentions.length ? "existing" : inScope(head) ? "candidate" : "low",
        date: isoDate(item.published),
        title: item.title,
        url: item.link,
        reportedName: null,
        place: null,
        matches: mentions.map((m) => ({ ...m, how: "mention" as const })),
        amounts: extractAmounts(head),
        inScopeWords: inScope(head),
      });
    }
    st.seen = [...seen];
  }

  // ---- Flag new Form D filers that already have federal defence or space rows
  const candidates = leads.filter((l) => l.kind === "private_round" && l.relevance === "candidate");
  if (candidates.length && o.federalIndexFile) {
    const rows = await federalRowsFor(
      o.federalIndexFile,
      candidates.map((l) => l.reportedName!),
    );
    for (const l of candidates) l.federal = rows.get(l.reportedName!) ?? null;
  }

  stats.requests = client.requests;
  const result: SweepResult = {
    leads: sortLeads(leads),
    stats,
    since,
    until,
    dir: null,
    markdown: "",
  };
  // UTC time of day keeps two sweeps on one day apart.
  const stamp = `${o.today}T${new Date(o.now ? o.now() : Date.now()).toISOString().slice(11, 16).replace(":", "")}Z`;
  result.markdown = renderLeadsMarkdown(result, stamp);
  if (!o.dryRun) {
    const dir = join(o.cacheDir, "radar", stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "leads.json"),
      JSON.stringify(
        {
          format: "candef-radar-leads",
          version: 1,
          stamp,
          since,
          until,
          stats,
          leads: result.leads,
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(dir, "leads.md"), result.markdown);
    state.sweeps.push({ at: stamp, since: since.sec, until, leads: leads.length, dir });
    saveState(o.cacheDir, state);
    result.dir = dir;
  }
  return result;
}

const RANK: Record<Relevance, number> = { existing: 0, candidate: 1, low: 2, fund: 3 };

function federalWeight(l: RadarLead): number {
  const f = l.federal;
  return f ? f.dndContractValue + f.csaValue + f.grantValue : -1;
}

/** A Form D amount as a number for sorting ("Indefinite" and blanks sort as 0). */
const dollars = (v: string | null | undefined) => (v && /^\d+$/.test(v) ? Number(v) : 0);

export function sortLeads(leads: RadarLead[]): RadarLead[] {
  return [...leads].sort(
    (a, b) =>
      RANK[a.relevance] - RANK[b.relevance] ||
      federalWeight(b) - federalWeight(a) ||
      dollars(b.formD?.totalAmountSold) - dollars(a.formD?.totalAmountSold) ||
      (b.date ?? "").localeCompare(a.date ?? ""),
  );
}

// ---- Lead list (markdown) -----------------------------------------------------------------------

const cell = (s: string | null | undefined) =>
  (s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

function usd(v: string | null | undefined): string {
  if (!v) return "?";
  return /^\d+$/.test(v) ? `$${Number(v).toLocaleString("en-US")}` : v;
}

function money(l: RadarLead): string {
  const f = l.formD!;
  return `${usd(f.totalAmountSold)} of ${usd(f.totalOfferingAmount)}`;
}

/** null: looked up in the lead index and not found; undefined: not looked up (no index file). */
function federalCell(f: FederalRows | null | undefined): string {
  if (f === undefined) return "not checked";
  if (f === null) return "none found in the index";
  const m = (n: number) => `${(n / 1e6).toFixed(2)}M`;
  return `tier ${f.tier}; DND contracts ${m(f.dndContractValue)}, CSA ${m(f.csaValue)}, grants ${m(f.grantValue)} (index, not verified)`;
}

export function renderLeadsMarkdown(r: SweepResult, stamp: string): string {
  const by = (kind: LeadKind, rel: Relevance) =>
    r.leads.filter((l) => l.kind === kind && l.relevance === rel);
  const lines: string[] = [];
  lines.push(`# Rounds radar, sweep ${stamp}`, "");
  lines.push(
    "Internal. **Leads only: nothing here is evidence.** For each lead, follow docs/RADAR.md section 3 (read the primary source, then record). Kept in research-cache/ (never committed).",
    "",
  );
  lines.push(
    `Window: Form D from ${r.since.sec}, government news from ${r.since.gcnews}, to ${r.until}. Requests made: ${r.stats.requests}.`,
    "",
  );

  const roundsExisting = by("private_round", "existing");
  lines.push(`## 1. Private rounds at companies already in CANDEF (${roundsExisting.length})`, "");
  if (roundsExisting.length) {
    lines.push(
      "| Filed | CANDEF company | Filer as reported | Place | Sold of offered (USD, as filed) | First sale | Securities | Form D |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const l of roundsExisting)
      lines.push(
        `| ${cell(l.date)} | ${cell(l.matches.map((m) => `${m.name} (${m.slug})`).join("; "))} | ${cell(l.reportedName)} | ${cell(l.place)} | ${money(l)} | ${cell(l.formD!.firstSaleYetToOccur ? "yet to occur" : l.formD!.dateOfFirstSale)} | ${cell(l.formD!.securities.join(", "))} | [${l.formD!.submissionType}${l.formD!.isAmendment ? " (amendment)" : ""}](${l.url}) |`,
      );
  } else lines.push("None this sweep.");
  lines.push("");

  const govExisting = by("government_announcement", "existing").concat(by("news", "existing"));
  lines.push(`## 2. Announcements naming CANDEF companies (${govExisting.length})`, "");
  if (govExisting.length) {
    lines.push(
      "| Date | Announcement | Companies named (mention: confirm the entity) | Amounts in text |",
      "| --- | --- | --- | --- |",
    );
    for (const l of govExisting)
      lines.push(
        `| ${cell(l.date)} | [${cell(l.title)}](${l.url}) | ${cell(l.matches.map((m) => `${m.name} (${m.slug})`).join("; "))} | ${cell((l.amounts ?? []).join(", "))} |`,
      );
  } else lines.push("None this sweep.");
  lines.push("");

  const roundsNew = by("private_round", "candidate");
  lines.push(
    `## 3. New Canadian companies with private rounds (${roundsNew.length} candidates)`,
    "",
  );
  lines.push(
    "Not in CANDEF. Candidates for a future batch only after the scope check (defence, security, space or dual-use, P-01). Filers with federal defence or space rows are listed first.",
    "",
  );
  if (roundsNew.length) {
    lines.push(
      "| Filed | Filer | Place | Industry (as filed) | Sold of offered (USD) | Federal rows | Form D |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const l of roundsNew)
      lines.push(
        `| ${cell(l.date)} | ${cell(l.reportedName)} | ${cell(l.place)} | ${cell(l.formD!.industryGroup)} | ${money(l)} | ${cell(federalCell(l.federal))} | [${l.formD!.submissionType}](${l.url}) |`,
      );
  }
  lines.push("");

  const govNew = by("government_announcement", "candidate").concat(by("news", "candidate"));
  lines.push(
    `## 4. Funding announcements in scope, no CANDEF company named (${govNew.length})`,
    "",
  );
  if (govNew.length) {
    lines.push("| Date | Announcement | From | Amounts in text |", "| --- | --- | --- | --- |");
    for (const l of govNew)
      lines.push(
        `| ${cell(l.date)} | [${cell(l.title)}](${l.url}) | ${cell(l.department ?? l.source)} | ${cell((l.amounts ?? []).join(", "))} |`,
      );
  }
  lines.push("");

  const low = r.leads.filter((l) => l.relevance === "low" || l.relevance === "fund");
  lines.push("## 5. Not listed (details in leads.json)", "");
  lines.push(
    `- Canadian Form D filings by pooled investment funds: ${low.filter((l) => l.relevance === "fund").length}.`,
    `- Canadian Form D filings in other industries (real estate, finance, mining, health care, retail and similar): ${low.filter((l) => l.kind === "private_round" && l.relevance === "low").length}.`,
    `- Announcements opened without scope words or amounts: ${low.filter((l) => l.kind !== "private_round").length}.`,
    "",
  );
  lines.push("## Run notes", "");
  const s = r.stats;
  lines.push(
    `- SEC: ${s.sec.days} weekday(s), ${s.sec.indexFiles} daily index file(s), ${s.sec.formD} Form D filings, ${s.sec.fetched} submissions read, ${s.sec.skippedKnownForeign} skipped (filer known to be outside Canada), ${s.sec.canadian} Canadian.${s.sec.stoppedEarly ? " **Stopped early; the next sweep continues.**" : ""}`,
    `- Government of Canada news: ${s.gcnews.feeds} feed(s), ${s.gcnews.items} new item(s), ${s.gcnews.opened} release(s) opened.`,
    `- News feeds: ${s.rss.feeds} feed(s), ${s.rss.items} item(s).`,
  );
  for (const n of s.notes) lines.push(`- ${n}`);
  lines.push("");
  return lines.join("\n");
}
