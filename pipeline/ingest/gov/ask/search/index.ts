/**
 * Leads search: filters, ranking and company lookup over the lead index (leadIndex.ts).
 *
 * No React, no model, no network. The index files live in research-cache/grant-ask/index/ and are
 * built by `npm run grant-ask -- index`. Leads are unverified; nothing here writes under research/.
 */
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { LeadRow } from "../leadIndex";
import type { CompanyProfile, ProfileLine } from "../profiles";
import { lineTagIds } from "../tags";
import { buildCard } from "./card";
import { rankLeads } from "../../../../../src/domain/leads/search";
import { docTerms, type DocTerms } from "../../../../../src/domain/leads/rank";
import {
  Answer,
  SearchQuery,
  type GovSource,
  type LeadCard,
  type SearchQueryInput,
} from "./schema";

export type SearchDoc = LeadRow & { lines: ProfileLine[] };

export interface LeadsPaths {
  indexDir: string;
  profilesPath: string;
}

export const defaultPaths = (root = process.cwd()): LeadsPaths => ({
  indexDir: join(root, "research-cache", "grant-ask", "index"),
  profilesPath: join(root, "research-cache", "grant-ask", "full", "profiles.jsonl"),
});

/** The loaded index. Reads search.jsonl once (companies that are not tier "out"). */
export class LeadStore {
  private loaded: SearchDoc[] | null = null;
  private byKey = new Map<string, SearchDoc>();
  private terms = new WeakMap<SearchDoc, DocTerms>();

  constructor(private readonly paths: LeadsPaths | null = defaultPaths()) {}

  /** A store over given documents (tests, and callers that already hold the data). */
  static fromDocs(docs: SearchDoc[]): LeadStore {
    const s = new LeadStore(null);
    s.setDocs(docs);
    return s;
  }

  private setDocs(docs: SearchDoc[]) {
    this.loaded = docs;
    this.byKey = new Map(docs.map((d) => [d.key, d]));
  }

  async docs(): Promise<SearchDoc[]> {
    if (this.loaded) return this.loaded;
    if (!this.paths) return [];
    let text: string;
    try {
      text = await readFile(join(this.paths.indexDir, "search.jsonl"), "utf8");
    } catch {
      throw new Error(
        "lead index not found: run `npm run grant-ask -- index` first (it writes research-cache/grant-ask/index/)",
      );
    }
    this.setDocs(
      text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SearchDoc),
    );
    return this.loaded!;
  }

  termsFor(d: SearchDoc): DocTerms {
    let t = this.terms.get(d);
    if (!t) this.terms.set(d, (t = docTerms(d.name, d.otherNames, d.reason, d.lines)));
    return t;
  }

  /** One company by key, with its stored government rows. Companies outside the search file are read from leads.jsonl and profiles.jsonl. */
  async get(key: string): Promise<{ row: LeadRow; lines: ProfileLine[] } | null> {
    await this.docs();
    const hit = this.byKey.get(key);
    if (hit) return { row: hit, lines: hit.lines };
    if (!this.paths) return null;
    const prefix = `{"key":${JSON.stringify(key)},`;
    const rl = createInterface({
      input: createReadStream(join(this.paths.indexDir, "leads.jsonl"), { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let row: LeadRow | null = null;
    for await (const l of rl) {
      if (l.startsWith(prefix)) {
        row = JSON.parse(l) as LeadRow;
        rl.close();
        break;
      }
    }
    if (!row) return null;
    const fh = await open(this.paths.profilesPath, "r");
    try {
      const buf = Buffer.alloc(row.profileLength);
      await fh.read(buf, 0, row.profileLength, row.profileOffset);
      const p = JSON.parse(buf.toString("utf8")) as CompanyProfile;
      if (p.key !== key)
        throw new Error("index is out of date: rebuild it with `npm run grant-ask -- index`");
      return { row, lines: p.lines };
    } finally {
      await fh.close();
    }
  }
}

// ---- Filters and ranking: shared with the site (src/domain/leads/search.ts) ----------------------

export {
  expandProvinces,
  PROGRAMME_ALIASES,
  programmeMatches,
  ruleStrength,
} from "../../../../../src/domain/leads/search";

export interface SearchResult {
  /** Companies that matched all filters (and the text), before the limit. */
  total: number;
  cards: LeadCard[];
}

export async function searchLeads(
  store: LeadStore,
  input: SearchQueryInput | SearchQuery,
): Promise<SearchResult> {
  const q = SearchQuery.parse(input);
  const all = await store.docs();
  const ranked = rankLeads(all, q, (d) => store.termsFor(d), lineTagIds);
  return {
    total: ranked.length,
    cards: ranked
      .slice(0, q.limit)
      .map(({ d, score, matched }) =>
        buildCard({ row: d, lines: d.lines, matchedOn: matched.slice(0, 8), score }),
      ),
  };
}

/** One company with every stored government row, and its card. */
export async function getCompany(store: LeadStore, key: string) {
  const hit = await store.get(key);
  if (!hit) return null;
  return {
    row: hit.row,
    lines: hit.lines,
    card: buildCard({ row: hit.row, lines: hit.lines, matchedOn: [], score: 0 }),
  };
}

// ---- Citation check ------------------------------------------------------------------------------

/**
 * Checks that every government source in an answer points at a real stored row and repeats that
 * row's date, department, value and reference. Returns one message per problem (empty means ok).
 * Web sources are checked for shape only; whether a page says what a claim says is for a reader.
 */
export async function checkAnswerCitations(store: LeadStore, answer: Answer): Promise<string[]> {
  const problems: string[] = [];
  const cache = new Map<string, ProfileLine[] | null>();
  const linesOf = async (key: string) => {
    if (!cache.has(key)) cache.set(key, (await store.get(key))?.lines ?? null);
    return cache.get(key)!;
  };
  for (const lead of answer.leads) {
    if (!(await linesOf(lead.key))) problems.push(`${lead.name}: unknown company key ${lead.key}`);
    for (const c of lead.claims)
      for (const s of c.sources) {
        if (s.kind === "web") continue;
        const lines = await linesOf(s.key);
        if (!lines) {
          problems.push(`${lead.name}: source cites unknown key ${s.key}`);
          continue;
        }
        const l = lines[s.line];
        if (!l) {
          problems.push(`${lead.name}: ${s.key} has no line ${s.line}`);
          continue;
        }
        const g = s as GovSource;
        if (
          (g.kind === "gov_grant") !== (l.kind === "grant") ||
          g.date !== l.date ||
          g.ref !== l.ref ||
          Math.abs(g.value - l.value) > 0.5 ||
          g.department !== l.department
        )
          problems.push(
            `${lead.name}: source ${s.key} line ${s.line} does not match the stored row`,
          );
      }
  }
  return problems;
}
