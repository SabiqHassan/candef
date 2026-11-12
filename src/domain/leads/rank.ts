/**
 * Keyword ranking for the leads search: a small BM25 over weighted fields, with synonym expansion
 * from the tag taxonomy. No model, no network; the same query over the same index gives the same
 * order.
 */
import { SYNONYM_GROUPS } from "./vocabulary";

/** The fields of a government row the ranking reads. */
export interface RankLine {
  title: string;
  description: string;
  programme: string;
}

const STOP = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with",
  "who",
  "which",
  "companies",
  "company",
  "firms",
  "firm",
  "canada",
  "canadian",
  "inc",
  "ltd",
  "corp",
  "limited",
  "new",
]);

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Lowercase word tokens, accents removed, light plural stripping, stop words dropped. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of fold(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us"))
    return w.slice(0, -1);
  return w;
}

const SYN = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  const stems = group.flatMap((g) => tokenize(g));
  for (const s of stems) {
    let set = SYN.get(s);
    if (!set) SYN.set(s, (set = new Set()));
    for (const t of stems) if (t !== s) set.add(t);
  }
}

export interface QueryTerm {
  term: string;
  weight: number;
}

/** Query tokens with their synonyms (synonyms count less than the typed word). */
export function expandQuery(text: string): QueryTerm[] {
  const seen = new Map<string, number>();
  for (const t of tokenize(text)) {
    seen.set(t, Math.max(seen.get(t) ?? 0, 1));
    for (const s of SYN.get(t) ?? []) seen.set(s, Math.max(seen.get(s) ?? 0, 0.6));
  }
  return [...seen].map(([term, weight]) => ({ term, weight }));
}

export interface DocTerms {
  /** Weighted term frequency. */
  tf: Map<string, number>;
  length: number;
  /** Which terms each field holds, for `matchedOn`. */
  name: Set<string>;
  reason: Set<string>;
  lines: Set<string>[];
}

const add = (tf: Map<string, number>, into: Set<string>, text: string, w: number) => {
  for (const t of tokenize(text)) {
    tf.set(t, (tf.get(t) ?? 0) + w);
    into.add(t);
  }
};

/** Index one company's searchable text: name x3, project title x2, everything else x1. */
export function docTerms(
  name: string,
  otherNames: string[],
  reason: string,
  lines: readonly RankLine[],
): DocTerms {
  const tf = new Map<string, number>();
  const nameSet = new Set<string>();
  const reasonSet = new Set<string>();
  add(tf, nameSet, [name, ...otherNames].join(" "), 3);
  add(tf, reasonSet, reason, 1);
  const lineSets = lines.map((l) => {
    const s = new Set<string>();
    add(tf, s, l.title, 2);
    add(tf, s, l.description.slice(0, 400), 1);
    add(tf, s, l.programme, 1);
    return s;
  });
  let length = 0;
  for (const v of tf.values()) length += v;
  return { tf, length, name: nameSet, reason: reasonSet, lines: lineSets };
}

const K1 = 1.2;
const B = 0.75;

export interface Scorer {
  score(doc: DocTerms): number;
}

/** BM25 over the candidate documents: idf from their document frequencies. */
export function makeScorer(query: QueryTerm[], docs: readonly DocTerms[]): Scorer {
  const n = docs.length || 1;
  const avg = docs.reduce((s, d) => s + d.length, 0) / n || 1;
  const idf = new Map<string, number>();
  for (const q of query) {
    let df = 0;
    for (const d of docs) if (d.tf.has(q.term)) df++;
    idf.set(q.term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  return {
    score(doc) {
      let s = 0;
      for (const q of query) {
        const f = doc.tf.get(q.term);
        if (!f) continue;
        s +=
          q.weight *
          (idf.get(q.term) ?? 0) *
          ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / avg)));
      }
      return s;
    },
  };
}

export function matchedFields(query: QueryTerm[], doc: DocTerms) {
  const terms = new Set(query.map((q) => q.term));
  const hit = (s: Set<string>) => [...s].filter((t) => terms.has(t));
  const out: { field: "name" | "reason" | "line"; line?: number; terms: string[] }[] = [];
  const n = hit(doc.name);
  if (n.length) out.push({ field: "name", terms: n });
  const r = hit(doc.reason);
  if (r.length) out.push({ field: "reason", terms: r });
  doc.lines.forEach((s, i) => {
    const h = hit(s);
    if (h.length) out.push({ field: "line", line: i, terms: h });
  });
  return out;
}
