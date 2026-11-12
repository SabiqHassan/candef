/**
 * Loading the lead-search data (`/data/<dataset>/leads.json`) and searching it in the browser.
 * The file is fetched only when the leads page opens, and parsed once per visit. The same ranking
 * code as the command-line search runs here (src/domain/leads/search.ts).
 */
import { useEffect, useState } from "react";
import { DATASET } from "../../data/dataSource";
import type { DocTerms } from "../../domain/leads/rank";
import {
  rankLeads,
  termsOf,
  withDefaults,
  type LeadQuery,
  type Ranked,
} from "../../domain/leads/search";
import {
  LEADS_FILE_VERSION,
  type LeadsFile,
  type SiteLead,
  type SiteLine,
} from "../../domain/leads/siteTypes";

export type LeadsLoad =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; data: LeadsFile };

/** Where the data is, for a given dataset (a build ships exactly one). */
export const leadsUrl = (dataset: string = DATASET) =>
  `${import.meta.env.BASE_URL}data/${dataset}/leads.json`;

/**
 * Reads and sanity-checks the file. A build without lead data answers 404 (or the host's HTML
 * fallback page): that is "missing", not an error. Full schema validation happens when the file is
 * written (pipeline), not here: 8,000+ leads would make a second pass slow.
 */
export async function loadLeads(
  url: string = leadsUrl(),
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<LeadsLoad> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal });
  } catch {
    return {
      status: "error",
      message: "The leads data could not be reached. Check your connection and try again.",
    };
  }
  if (res.status === 404) return { status: "missing" };
  if (!res.ok)
    return {
      status: "error",
      message: `The leads data is unavailable right now (HTTP ${res.status}).`,
    };
  let data: unknown;
  try {
    data = JSON.parse(await res.text());
  } catch {
    // A host that answers a missing file with its HTML page lands here too.
    return { status: "missing" };
  }
  const f = data as Partial<LeadsFile> | null;
  if (!f || f.format !== "candef-leads" || !Array.isArray(f.leads) || !f.meta)
    return {
      status: "error",
      message: "The leads data arrived incomplete or damaged. Please try again.",
    };
  if (f.version !== LEADS_FILE_VERSION)
    return {
      status: "error",
      message:
        "This version of CANDEF cannot read the leads data. Reloading the page usually fixes this.",
    };
  return { status: "ready", data: f as LeadsFile };
}

export function useLeads(): LeadsLoad & { retry: () => void } {
  const [state, setState] = useState<LeadsLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    loadLeads(leadsUrl(), fetch, abort.signal).then(
      (s) => !abort.signal.aborted && setState(s),
      () => undefined,
    );
    return () => abort.abort();
  }, [attempt]);
  const retry = () => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  };
  return { ...state, retry };
}

// ---- Search --------------------------------------------------------------------------------------

export interface LeadsIndex {
  data: LeadsFile;
  termsFor: (d: SiteLead) => DocTerms;
}

/** Caches each company's term index, so a keystroke re-scores without re-reading the text. */
export function indexLeads(data: LeadsFile): LeadsIndex {
  const cache = new WeakMap<SiteLead, DocTerms>();
  return {
    data,
    termsFor(d) {
      let t = cache.get(d);
      if (!t) cache.set(d, (t = termsOf(d)));
      return t;
    },
  };
}

export interface LeadsResult {
  total: number;
  /** Best first, cut to `limit`. */
  hits: Ranked<SiteLead>[];
}

/** The site's filters as a shared SearchQuery (tier A only: that is what the file holds). */
export function searchLeadsIn(index: LeadsIndex, query: Partial<LeadQuery> = {}): LeadsResult {
  const q = withDefaults({ tiers: index.data.meta.tiers, limit: 100, ...query });
  const ranked = rankLeads(index.data.leads, q, index.termsFor, (l) => (l as SiteLine).tags);
  return { total: ranked.length, hits: ranked.slice(0, q.limit) };
}
