/**
 * Company and institution search (backlog "Search v2", 2026-10-14).
 *
 * What a person types is matched against everything that identifies an organization, not just the
 * display name: legal name, earlier legal names, city and province, sector and subsector labels,
 * stock ticker and registry numbers. Word order does not matter ("ottawa space" finds a space
 * company in Ottawa), punctuation and accents are ignored ("Nuvu" finds "Nüvü"), and results are
 * ranked so that the company whose name was typed comes before one that merely mentions it.
 * Pure functions over `OrgView`; nothing here invents data.
 */
import type { OrgView } from "./schema/snapshot";

/** Lower-case, accent-free text with every run of punctuation collapsed to one space. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const MAX_TOKENS = 8;

export interface Query {
  /** The folded query as one phrase. */
  phrase: string;
  tokens: string[];
}

export function parseQuery(q: string): Query {
  const phrase = fold(q);
  return { phrase, tokens: phrase ? phrase.split(" ").slice(0, MAX_TOKENS) : [] };
}

interface Entry {
  name: string;
  legal: string;
  where: string;
  topic: string;
  codes: string;
  all: string;
}

const cache = new WeakMap<OrgView, Entry>();

function entryOf(o: OrgView): Entry {
  let e = cache.get(o);
  if (e) return e;
  const legalNames = [
    o.legalName.value,
    ...(o.legalName.alternatives ?? []).map((a) => a.value),
    ...(o.legalName.history ?? []).map((h) => h.value),
  ].filter((v): v is string => !!v);
  const hq = o.hq.value;
  const where = [hq?.city, hq?.region, hq?.province].filter(Boolean).join(" ");
  const topic = [
    o.segment.value?.label,
    o.segment.value?.sectorLabel,
    ...o.secondarySegments.map((s) => s.label),
  ]
    .filter(Boolean)
    .join(" ");
  const codes = [o.listing.value?.ticker, o.listing.value?.exchange]
    .concat((o.identifiers ?? []).map((i) => i.value))
    .filter(Boolean)
    .join(" ");
  const parts = {
    name: fold(o.name),
    legal: fold(legalNames.join(" | ")),
    where: fold(where),
    topic: fold(topic),
    codes: fold(codes),
  };
  e = { ...parts, all: Object.values(parts).join(" ") };
  cache.set(o, e);
  return e;
}

const startsWord = (text: string, token: string) =>
  text.startsWith(token) || text.includes(` ${token}`);

/**
 * 0 when the organization does not match; otherwise a rank (higher is better). Every word typed
 * must appear somewhere in the organization's searchable text.
 */
export function scoreOrg(o: OrgView, query: Query): number {
  if (!query.tokens.length) return 1;
  const e = entryOf(o);
  if (!query.tokens.every((t) => e.all.includes(t))) return 0;
  const { phrase } = query;
  if (e.name === phrase) return 1000;
  if (e.name.startsWith(phrase)) return 800;
  if (e.name.includes(` ${phrase}`)) return 700;
  if (e.legal.split(" | ").some((l) => l === phrase || l.startsWith(phrase))) return 600;
  if (e.name.includes(phrase)) return 500;
  let sum = 0;
  for (const t of query.tokens) {
    sum += startsWord(e.name, t)
      ? 100
      : e.name.includes(t)
        ? 70
        : startsWord(e.legal, t)
          ? 50
          : startsWord(`${e.where} ${e.topic} ${e.codes}`, t)
            ? 20
            : 10;
  }
  return sum;
}
