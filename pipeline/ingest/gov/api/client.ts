const ORIGIN = "https://open.canada.ca";
const API = `${ORIGIN}/data/en/api/3/action/`;
// open.canada.ca/en/terms returned 404 on 2026-10-16. The client only talks to open.canada.ca, so it
// checks the dataset licence page there (Open Government Licence - Canada; read by Claude 2026-10-16).
// The site's general terms link to https://www.canada.ca/en/transparency/terms.html (read 2026-10-15).
export const TERMS_URL = `${ORIGIN}/en/open-government-licence-canada`;
export const USER_AGENT =
  "CANDEF-GovDiscovery/1.0 (read-only research leads; no evidence ingestion)";
export const MAX_PAGES = 100;
export type ApiRecord = Record<string, unknown>;
export interface Field {
  id: string;
  type: string;
}
export interface SearchResult {
  records: ApiRecord[];
  fields: Field[];
  total: number;
}
export interface SearchOptions {
  filters?: Record<string, string | string[]>;
  fields?: string[];
  sort?: string;
  offset?: number;
  limit?: number;
}
export interface PageOptions extends SearchOptions {
  maxPages?: number;
}
export interface SearchPort {
  search(id: string, options: SearchOptions): Promise<SearchResult>;
}
export interface PackageInfo {
  id: string;
  title: string;
  resources: { id: string; datastore_active?: boolean }[];
}

/** A small REP parser: longest path match; longest agent token; equally specific groups merge. */
export function robotsPolicy(text: string) {
  const groups: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
    delays: number[];
  }[] = [];
  let current = {
    agents: [] as string[],
    rules: [] as { allow: boolean; path: string }[],
    delays: [] as number[],
  };
  let directives = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.split("#")[0]!.trim();
    const at = clean.indexOf(":");
    if (at < 0) continue;
    const key = clean.slice(0, at).trim().toLowerCase(),
      value = clean.slice(at + 1).trim();
    if (key === "user-agent") {
      if (directives) {
        groups.push(current);
        current = { agents: [], rules: [], delays: [] };
        directives = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current.agents.length) {
      directives = true;
      if ((key === "allow" || key === "disallow") && value)
        current.rules.push({ allow: key === "allow", path: value });
      if (key === "crawl-delay") {
        if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid robots crawl-delay");
        current.delays.push(Number(value) * 1000);
      }
      if (key === "request-rate") {
        const rate = /^(\d+)\/(\d+)$/.exec(value);
        if (!rate || Number(rate[1]) < 1) throw new Error("Unsupported robots request-rate");
        current.delays.push((Number(rate[2]) * 1000) / Number(rate[1]));
      }
    }
  }
  groups.push(current);
  const scored = groups.map((group) => ({
    group,
    score: Math.max(
      -1,
      ...group.agents.map((a) =>
        a === "*" ? 0 : "candef-govdiscovery".includes(a) ? a.length : -1,
      ),
    ),
  }));
  const best = Math.max(-1, ...scored.map((g) => g.score));
  const selected = scored.filter((g) => g.score === best && g.score >= 0).map((g) => g.group);
  return {
    delayMs: Math.max(20000, ...selected.flatMap((g) => g.delays)),
    allowed(path: string) {
      const matches = selected
        .flatMap((g) => g.rules)
        .filter((rule) => {
          const end = rule.path.endsWith("$");
          const raw = end ? rule.path.slice(0, -1) : rule.path;
          const pattern = raw
            .split("*")
            .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*");
          return new RegExp("^" + pattern + (end ? "$" : "")).test(path);
        })
        .sort(
          (a, b) =>
            b.path.replace(/[*$]/g, "").length - a.path.replace(/[*$]/g, "").length ||
            Number(b.allow) - Number(a.allow),
        );
      return matches[0]?.allow ?? true;
    },
  };
}

interface ClientOptions {
  termsReviewed: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
export class CkanClient implements SearchPort {
  private fetcher: typeof fetch;
  private now: () => number;
  private sleep: (ms: number) => Promise<void>;
  private last = -Infinity;
  private delay = 20000;
  private stopped = false;
  private ready = false;
  private policy?: ReturnType<typeof robotsPolicy>;
  private queue: Promise<unknown> = Promise.resolve();
  private pagesUsed = 0;
  constructor(private options: ClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  private stop(message: string): never {
    this.stopped = true;
    throw new Error(message);
  }
  private async response(url: URL): Promise<string> {
    if (this.stopped) throw new Error("Client stopped after refusal or invalid response");
    if (url.origin !== ORIGIN || (this.policy && !this.policy.allowed(url.pathname + url.search)))
      this.stop("Request blocked by robots policy");
    let backoff = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.sleep(Math.max(0, this.last + Math.max(this.delay, backoff) - this.now()));
      this.last = this.now();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json, text/plain;q=0.9, text/html;q=0.5",
          },
          signal: AbortSignal.timeout(30000),
        });
      } catch {
        if (attempt === 2) throw new Error("Network request failed after three attempts");
        backoff = 20000 * 2 ** (attempt + 1);
        continue;
      }
      if ([401, 403, 429].includes(response.status)) {
        await response.body?.cancel();
        this.stop(`Request refused (HTTP ${response.status}); no further requests`);
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader)
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 16 * 1024 * 1024) {
            await reader.cancel();
            this.stop("Response exceeds size cap");
          }
          chunks.push(chunk.value);
        }
      const body = Buffer.concat(chunks).toString("utf8");
      if (/captcha|cf-chl-|challenge-platform|just a moment|access denied/i.test(body))
        this.stop("Access challenge detected; no further requests");
      if ([500, 502, 503, 504].includes(response.status) && attempt < 2) {
        const retry = response.headers.get("retry-after");
        const retryMs = retry
          ? /^\d+$/.test(retry)
            ? Number(retry) * 1000
            : Math.max(0, Date.parse(retry) - this.now())
          : 0;
        backoff = Math.max(20000 * 2 ** (attempt + 1), Number.isFinite(retryMs) ? retryMs : 0);
        continue;
      }
      if (!response.ok)
        this.stop(`HTTP ${response.status}; redirects and access workarounds are disabled`);
      return body;
    }
    throw new Error("Retry budget exhausted");
  }
  private async initialize() {
    if (this.ready) return;
    if (!this.options.termsReviewed)
      throw new Error(`Owner must review ${TERMS_URL} and pass --terms-reviewed before API use`);
    const robots = await this.response(new URL("/robots.txt", ORIGIN));
    if (robots.trimStart().startsWith("<")) this.stop("robots.txt returned an HTML challenge");
    this.policy = robotsPolicy(robots);
    this.delay = this.policy.delayMs;
    // Check the actual API path before making even the terms request.
    if (!this.policy.allowed(new URL(API).pathname + "package_show"))
      this.stop("API disallowed by robots.txt");
    await this.response(new URL(TERMS_URL));
    this.ready = true;
  }
  private action(action: string, parameters: Record<string, unknown>): Promise<unknown> {
    const run = this.queue.then(async () => {
      if (this.stopped) throw new Error("Client stopped after refusal or challenge");
      await this.initialize();
      const url = new URL(action, API);
      for (const [key, value] of Object.entries(parameters))
        if (value !== undefined)
          url.searchParams.set(
            key,
            typeof value === "object" ? JSON.stringify(value) : String(value),
          );
      const body = await this.response(url);
      let data: { success?: boolean; result?: unknown };
      try {
        data = JSON.parse(body) as typeof data;
      } catch {
        return this.stop("Expected plain JSON; possible HTML challenge");
      }
      if (!data || data.success !== true || data.result === undefined)
        this.stop("CKAN action rejected or malformed; response body withheld");
      return data.result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  async packageShow(id: string): Promise<PackageInfo> {
    const data = (await this.action("package_show", { id })) as PackageInfo;
    if (
      !data ||
      typeof data.id !== "string" ||
      typeof data.title !== "string" ||
      !Array.isArray(data.resources) ||
      !data.resources.every((r) => r && typeof r.id === "string")
    )
      this.stop("Invalid package_show metadata");
    return data;
  }
  async findPackage(title: string): Promise<string> {
    const data = (await this.action("package_search", { q: `title:"${title}"`, rows: 10 })) as {
      count: number;
      results: PackageInfo[];
    };
    if (
      !data ||
      !Number.isSafeInteger(data.count) ||
      data.count > 10 ||
      !Array.isArray(data.results)
    )
      this.stop("Package discovery was ambiguous or malformed; supply a package ID");
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matches = data.results.filter(
      (p) => typeof p.title === "string" && typeof p.id === "string" && key(p.title) === key(title),
    );
    if (matches.length !== 1)
      throw new Error("No unique exact-title package; supply a package ID from the catalogue");
    return matches[0]!.id;
  }
  async search(id: string, options: SearchOptions = {}): Promise<SearchResult> {
    const limit = options.limit ?? 1000,
      offset = options.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 0 ||
      limit > 1000 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new Error("Invalid page bounds");
    if (limit > 0 && ++this.pagesUsed > MAX_PAGES)
      throw new Error("Hard page cap reached for this client run");
    const data = (await this.action("datastore_search", {
      resource_id: id,
      ...options,
      fields: options.fields?.join(","),
      limit,
      offset,
    })) as SearchResult;
    if (
      !data ||
      !Number.isSafeInteger(data.total) ||
      data.total < 0 ||
      !Array.isArray(data.records) ||
      data.records.length > limit ||
      !data.records.every((r) => r && typeof r === "object" && !Array.isArray(r)) ||
      !Array.isArray(data.fields) ||
      !data.fields.every((f) => f && typeof f.id === "string" && typeof f.type === "string")
    )
      this.stop("Invalid datastore_search response");
    if (
      options.fields &&
      data.records.some((row) => options.fields!.some((field) => !Object.hasOwn(row, field)))
    )
      this.stop("API row is missing a requested fingerprint field");
    return data;
  }
  async pages(id: string, options: PageOptions = {}) {
    const maxPages = pageBudget(options),
      limit = options.limit ?? 1000;
    const records: ApiRecord[] = [];
    let total: number | null = null,
      pages = 0;
    while (pages < maxPages) {
      const { maxPages: _cap, ...searchOptions } = options;
      const page = await this.search(id, {
        ...searchOptions,
        offset: records.length,
        limit,
        sort: options.sort ?? "_id asc",
      });
      if (total !== null && page.total !== total)
        throw new Error("API total changed during paging; rerun discovery");
      total = page.total;
      pages++;
      records.push(...page.records);
      if ((options.offset ?? 0) + records.length >= total)
        return { records, total, pages, complete: true };
      if (!page.records.length)
        throw new Error("Empty page before total; refusing incomplete paging");
    }
    return { records, total, pages, complete: false };
  }
}
export function pageBudget(options: PageOptions) {
  const n = options.maxPages ?? 50,
    size = options.limit ?? 1000;
  if (
    !Number.isInteger(n) ||
    n < 1 ||
    n > MAX_PAGES ||
    !Number.isInteger(size) ||
    size < 1 ||
    size > 1000
  )
    throw new Error("Invalid page cap or page size (maximum 100 pages, 1000 rows)");
  if (options.offset !== undefined && options.offset !== 0)
    throw new Error("Discovery must start at offset zero");
  return n;
}
