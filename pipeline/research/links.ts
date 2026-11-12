/**
 * Link checking (ARCHITECTURE §5 "Staleness", mechanism 1): updates each source's `availability`
 * and `lastCheckedAt`. Content freshness is a separate mechanism (the research ledger's next_review).
 *
 * Polite by construction: robots.txt is honoured, CANDEF identifies itself, requests are sequential
 * with a per-host pause, and no content is stored. A transient failure (5xx, timeout, network) is
 * recorded as `unknown`, never as `unavailable`: only 404/410 mark a source as gone.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { AuthoringError } from "./authoring";
import { USER_AGENT, robotsAllows } from "./capture";
import { loadResearchCorpus } from "./load";

export type Availability = "ok" | "moved" | "unavailable" | "unknown";

export interface LinkResult {
  sourceId: string;
  url: string;
  availability: Availability;
  detail: string;
}

export interface LinkCheckOptions {
  ids?: string[];
  fetchImpl?: typeof fetch;
  /** Minimum pause between two requests to the same host (ms). */
  perHostDelayMs?: number;
  now?: Date;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A redirect that only normalises the address (http to https, `www.`, a trailing slash, letter
 * case, a fragment) leaves the same page at the same place: not "moved". Found when the first real
 * run labelled 30 of 107 healthy sources "moved".
 */
export function isCosmeticRedirect(from: string, to: string): boolean {
  try {
    const a = new URL(from);
    const b = new URL(to);
    const key = (u: URL) =>
      `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "").toLowerCase()}${u.search}`;
    return key(a) === key(b);
  } catch {
    return false;
  }
}

/**
 * Many sites answer a missing page by redirecting to a generic error page that itself returns HTTP
 * 200 (a "soft 404"; canada.ca does). That is a gone source, not a healthy one.
 */
export function isErrorPageAddress(address: string): boolean {
  try {
    const path = new URL(address).pathname.toLowerCase();
    return (
      /\/(404|not-?found|page-?not-?found|error|errors)(\/|\.html?|\.aspx?|\.php)?(\/.*)?$/.test(
        path,
      ) && !/\/news\//.test(path)
    );
  } catch {
    return false;
  }
}

export async function checkLinks(
  root: string,
  options: LinkCheckOptions = {},
): Promise<LinkResult[]> {
  const loaded = loadResearchCorpus(root);
  if (!loaded.corpus)
    throw new AuthoringError("research/ does not validate; run `candef validate`");
  const doFetch = options.fetchImpl ?? fetch;
  const delay = options.perHostDelayMs ?? 1500;
  const now = (options.now ?? new Date()).toISOString();
  const wanted = options.ids ? new Set(options.ids) : null;
  const sources = loaded.corpus.sources.filter((s) => !wanted || wanted.has(s.id));
  if (wanted)
    for (const id of wanted)
      if (!sources.some((s) => s.id === id)) throw new AuthoringError(`unknown source ${id}`);

  const lastHit = new Map<string, number>();
  const robotsCache = new Map<string, string | null>();
  const polite = async (host: string) => {
    const wait = (lastHit.get(host) ?? 0) + delay - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
  };
  const headers = { "user-agent": USER_AGENT };
  const results: LinkResult[] = [];

  for (const s of sources) {
    const url = new URL(s.url);
    let result: LinkResult;
    try {
      if (!robotsCache.has(url.origin)) {
        await polite(url.host);
        const r = await doFetch(new URL("/robots.txt", url), {
          headers,
          signal: AbortSignal.timeout(15_000),
        });
        robotsCache.set(url.origin, r.ok ? await r.text() : null);
      }
      const robots = robotsCache.get(url.origin);
      if (robots && !robotsAllows(robots, USER_AGENT, url.pathname + url.search)) {
        result = {
          sourceId: s.id,
          url: s.url,
          availability: "unknown",
          detail: "not checked: robots.txt disallows",
        };
      } else {
        await polite(url.host);
        let res = await doFetch(url, {
          method: "HEAD",
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 405 || res.status === 501) {
          await polite(url.host);
          res = await doFetch(url, {
            headers,
            redirect: "follow",
            signal: AbortSignal.timeout(20_000),
          });
          await res.body?.cancel();
        }
        let redirected = !!res.url && res.url !== url.toString();
        let cosmetic = redirected && isCosmeticRedirect(s.url, res.url);
        let softSuspect = res.ok && redirected && !cosmetic && isErrorPageAddress(res.url);
        let note = "";
        if (softSuspect) {
          // One odd answer proves nothing (canada.ca answered a rapid batch with its error page and
          // served the same address normally minutes later). Ask again, separately, before judging.
          await polite(url.host);
          const again = await doFetch(url, {
            headers,
            redirect: "follow",
            signal: AbortSignal.timeout(20_000),
          });
          await again.body?.cancel();
          const stillError =
            again.ok &&
            !!again.url &&
            again.url !== url.toString() &&
            isErrorPageAddress(again.url);
          if (stillError) {
            note = " (an error page on a second request too: the source is gone)";
          } else {
            res = again;
            redirected = !!res.url && res.url !== url.toString();
            cosmetic = redirected && isCosmeticRedirect(s.url, res.url);
            softSuspect = false;
            note = again.ok
              ? ""
              : " (first request was redirected to an error page; not confirmed)";
          }
        }
        result = {
          sourceId: s.id,
          url: s.url,
          availability: note.includes("gone")
            ? "unavailable"
            : res.ok
              ? redirected && !cosmetic
                ? "moved"
                : "ok"
              : res.status === 404 || res.status === 410
                ? "unavailable"
                : "unknown",
          detail: `HTTP ${res.status}${redirected ? ` → ${res.url}` : ""}${note}`,
        };
      }
    } catch (e) {
      result = {
        sourceId: s.id,
        url: s.url,
        availability: "unknown",
        detail: `request failed: ${(e as Error).message}`,
      };
    }
    results.push(result);

    const origin = loaded.origins.get(s.id)!;
    const file = join(root, origin.file);
    const doc = parseDocument(readFileSync(file, "utf8"));
    if (!isMap(doc.contents)) throw new AuthoringError(`${origin.file} is not a mapping`);
    doc.set("availability", result.availability);
    doc.set("lastCheckedAt", now);
    writeFileSync(file, doc.toString());
  }
  return results;
}
