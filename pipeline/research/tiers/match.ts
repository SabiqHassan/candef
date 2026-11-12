/**
 * Value matching in a saved copy (docs/VERIFICATION_TIERS.md section 3.1, rule T2-c).
 *
 * Deterministic and conservative: a value matches only when its whole normalized form occurs in the
 * capture's normalized visible text, with word boundaries. Every match records its offset so that the
 * audit can see where it was found. A value can still appear on the page for another reason; the
 * tier 2 rules require every key value of a record, independent corroboration (T2-e) and the audit.
 *
 * Pure functions only: no file or network access. Never import React here.
 */
import { visibleText } from "../capture";

// ---- Normalization --------------------------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  lsquo: "'",
  rsquo: "'",
  sbquo: "'",
  ldquo: '"',
  rdquo: '"',
  bdquo: '"',
  laquo: '"',
  raquo: '"',
  hellip: "...",
  euro: "€",
  pound: "£",
  thinsp: " ",
  ensp: " ",
  emsp: " ",
  shy: "",
  szlig: "ss",
  aelig: "ae",
  AElig: "AE",
  oelig: "oe",
  OElig: "OE",
};

/** Decodes the HTML entities `visibleText` leaves (accented letters, typographic punctuation). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    if (NAMED[e] !== undefined) return NAMED[e]!;
    const accented = /^([a-z])(acute|grave|circ|uml|cedil|tilde|ring|slash)$/i.exec(e);
    return accented ? accented[1]! : all;
  });
}

/**
 * Normalized visible text: NFKC, accents folded, case folded, typographic quotes and dashes mapped
 * to plain ones, whitespace collapsed. Offsets refer to this string.
 */
export function normalize(text: string): string {
  return decodeEntities(text)
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u00b4`]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00a0\u2000-\u200b\u202f\u205f\u3000]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** The text of a capture as the matcher reads it: HTML is reduced to its visible text first. */
export function captureText(content: string, kind: "html" | "text"): string {
  return normalize(kind === "html" ? visibleText(content) : content);
}

export interface Match {
  found: boolean;
  /** Offset in the normalized text; null when not found. */
  offset: number | null;
}
const NOT_FOUND: Match = { found: false, offset: null };
const at = (offset: number): Match => ({ found: true, offset });

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- Names ----------------------------------------------------------------------------------

/** Legal-form variants that are equivalent (section 3.1). Ltée (limitée) is the French Limited. */
const LEGAL_FORMS: Record<string, string> = {
  inc: "inc",
  incorporated: "inc",
  incorporee: "inc",
  ltd: "ltd",
  limited: "ltd",
  ltee: "ltd",
  limitee: "ltd",
  corp: "corp",
  corporation: "corp",
  co: "co",
  company: "co",
  llc: "llc",
  lp: "lp",
  sec: "lp",
  plc: "plc",
};

interface Token {
  word: string;
  start: number;
}

/**
 * Words of a normalized string with their offsets. Periods inside abbreviations are dropped
 * ("s.e.c." → "sec", "u.s." → "us"); "&" is a word; other punctuation separates words.
 */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /[a-z0-9]+(?:\.[a-z0-9]+)*\.?|&/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const raw = m[0].replace(/\.$/, "");
    const word = raw.replace(/\./g, "");
    if (word) out.push({ word: LEGAL_FORMS[word] ?? word, start: m.index });
  }
  return out;
}

/**
 * The whole name as a run of words (legal forms canonical). Partial names never match: every word
 * of the name must be present, in order, and the run must start and end on word boundaries.
 */
export function matchName(text: string, name: string): Match {
  const want = tokens(normalize(name)).map((t) => t.word);
  if (!want.length) return NOT_FOUND;
  const have = tokens(text);
  outer: for (let i = 0; i + want.length <= have.length; i++) {
    for (let j = 0; j < want.length; j++) if (have[i + j]!.word !== want[j]) continue outer;
    return at(have[i]!.start);
  }
  return NOT_FOUND;
}

// ---- Identifiers ----------------------------------------------------------------------------

/**
 * Digits only, compared exactly: each run of digits (spaces and hyphens allowed inside, as in
 * "1032814-6" or "817 253 867") must equal the identifier's digits. Letters end a run, so a BN with
 * its program account ("702973926RC0001") yields the 9-digit root.
 */
export function matchIdentifier(text: string, id: string): Match {
  const want = id.replace(/\D/g, "");
  if (want.length < 4) return NOT_FOUND;
  const re = /\d(?:\d|[ -](?=\d))*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // A run may join several numbers ("702973926 1032814-6"). Spaces separate candidates; a
    // hyphenated group ("1234567-8") is one identifier and is never matched in part.
    const chunks: { digits: string; start: number }[] = [];
    const g = /\d+(?:-\d+)*/g;
    for (let d = g.exec(m[0]); d; d = g.exec(m[0]))
      chunks.push({ digits: d[0].replace(/-/g, ""), start: m.index + d.index });
    for (let i = 0; i < chunks.length; i++) {
      let joined = "";
      for (let j = i; j < chunks.length && joined.length < want.length; j++) {
        joined += chunks[j]!.digits;
        if (joined === want) return at(chunks[i]!.start);
      }
    }
  }
  return NOT_FOUND;
}

/** A ticker as a whole word. */
export function matchTicker(text: string, ticker: string): Match {
  const t = normalize(ticker);
  if (!t) return NOT_FOUND;
  const m = new RegExp(`(?<![a-z0-9])${escape(t)}(?![a-z0-9])`).exec(text);
  return m ? at(m.index) : NOT_FOUND;
}

// ---- Years and dates ------------------------------------------------------------------------

const MONTHS: string[][] = [
  ["january", "jan", "janvier", "janv"],
  ["february", "feb", "fevrier", "fevr", "fev"],
  ["march", "mar", "mars"],
  ["april", "apr", "avril", "avr"],
  ["may", "mai"],
  ["june", "jun", "juin"],
  ["july", "jul", "juillet", "juil"],
  ["august", "aug", "aout"],
  ["september", "sep", "sept", "septembre"],
  ["october", "oct", "octobre"],
  ["november", "nov", "novembre"],
  ["december", "dec", "decembre"],
];

/** A year as a whole word (not part of a longer number). */
export function matchYear(text: string, year: number | string): Match {
  const y = String(year);
  if (!/^\d{4}$/.test(y)) return NOT_FOUND;
  const m = new RegExp(`(?<![\\d.,])${y}(?![\\d])`).exec(text);
  return m ? at(m.index) : NOT_FOUND;
}

/**
 * A date (YYYY, YYYY-MM or YYYY-MM-DD) in any common English or French form: 2023-04-13,
 * April 13, 2023, Apr. 13 2023, 13 April 2023, 13 avril 2023, 1er juin 2020; April 2023.
 */
export function matchDate(text: string, date: string): Match {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date);
  if (!m) return NOT_FOUND;
  const [, y, mo, d] = m;
  if (!mo) return matchYear(text, y!);
  const month = `(?:${MONTHS[Number(mo) - 1]!.map(escape).join("|")})\\.?`;
  const patterns: string[] = [];
  if (!d) {
    patterns.push(`${y}-${mo}(?![\\d-])`, `(?<![a-z])${month},? ${y}(?!\\d)`);
  } else {
    const day = String(Number(d));
    const dayRe = `(?:0?${day})(?:st|nd|rd|th|er|e)?`;
    patterns.push(
      `(?<!\\d)${y}-${mo}-${d}(?!\\d)`,
      `(?<![a-z])${month} ${dayRe},? ${y}(?!\\d)`,
      `(?<![\\d])${dayRe} ${month},? ${y}(?!\\d)`,
    );
  }
  let best: number | null = null;
  for (const p of patterns) {
    const hit = new RegExp(p).exec(text);
    if (hit && (best === null || hit.index < best)) best = hit.index;
  }
  return best === null ? NOT_FOUND : at(best);
}

// ---- Places ---------------------------------------------------------------------------------

/** Full names (matched anywhere) and abbreviations (matched only in an address context). */
const PROVINCES: Record<string, { names: string[]; abbreviations: string[] }> = {
  ON: { names: ["ontario"], abbreviations: ["on", "ont"] },
  QC: { names: ["quebec"], abbreviations: ["qc", "que", "pq"] },
  NS: { names: ["nova scotia", "nouvelle-ecosse"], abbreviations: ["ns"] },
  NB: { names: ["new brunswick", "nouveau-brunswick"], abbreviations: ["nb"] },
  NL: {
    names: ["newfoundland and labrador", "newfoundland", "terre-neuve-et-labrador"],
    abbreviations: ["nl", "nfld"],
  },
  PE: { names: ["prince edward island", "ile-du-prince-edouard"], abbreviations: ["pe", "pei"] },
  MB: { names: ["manitoba"], abbreviations: ["mb", "man"] },
  SK: { names: ["saskatchewan"], abbreviations: ["sk", "sask"] },
  AB: { names: ["alberta"], abbreviations: ["ab", "alta"] },
  BC: { names: ["british columbia", "colombie-britannique"], abbreviations: ["bc"] },
  YT: { names: ["yukon"], abbreviations: ["yt"] },
  NT: { names: ["northwest territories", "territoires du nord-ouest"], abbreviations: ["nt"] },
  NU: { names: ["nunavut"], abbreviations: ["nu"] },
};

/**
 * A province by full name anywhere, or by standard abbreviation in an address context only: right
 * after the city ("Ottawa, ON") or right before a postal code ("ON K2K 2A9"). Abbreviations such as
 * "on" or "que" are ordinary words, so they never match on their own.
 */
export function matchProvince(text: string, code: string, city?: string | null): Match {
  const p = PROVINCES[code.toUpperCase()];
  if (!p) return NOT_FOUND;
  const hits: number[] = [];
  for (const n of p.names) {
    const r = matchName(text, n);
    if (r.found) hits.push(r.offset!);
  }
  // "ns" also matches "n.s." and "n.s".
  const abbr = p.abbreviations
    .map((a) => a.split("").join(String.raw`\.?`) + String.raw`\.?`)
    .join("|");
  const postal = String.raw`\s?\(?[a-z]\d[a-z] ?\d[a-z]\d`;
  const after = new RegExp(String.raw`(?<![a-z])(?:${abbr})(?=${postal})`);
  const a = after.exec(text);
  if (a) hits.push(a.index);
  if (city) {
    const c = escape(normalize(city));
    const b = new RegExp(String.raw`(?<![a-z])${c},? ((?:${abbr}))(?![a-z])`).exec(text);
    if (b) hits.push(b.index + b[0].length - b[1]!.length);
  }
  return hits.length ? at(Math.min(...hits)) : NOT_FOUND;
}

/** A city by name (accents and case folded), as whole words. */
export const matchCity = matchName;

// ---- Money ----------------------------------------------------------------------------------

interface Mention {
  /** Exact value in cents, as a bigint (no floating point). */
  cents: bigint;
  /** Precision as written, in cents: 1n = to the cent, 100n = whole dollars, 10^7 = 0.1 million. */
  precision: bigint;
  start: number;
  end: number;
}

const SCALE_WORDS: Record<string, number> = {
  thousand: 3,
  k: 3,
  million: 6,
  millions: 6,
  mln: 6,
  mm: 6,
  m: 6,
  billion: 9,
  billions: 9,
  bn: 9,
  b: 9,
  milliard: 9,
  milliards: 9,
  g: 9,
};

/**
 * Parses "1,609,650", "4,7", "92 000 000", "402.5" into an integer and its decimal digits. A comma,
 * space or period followed by groups of exactly three digits is a thousands separator.
 */
function parseNumber(raw: string): { digits: string; decimals: number } | null {
  // One separator throughout: table text such as "2,772 209,477 271" is not one number.
  const thousands = /^\d{1,3}([, .])\d{3}(?:\1\d{3})*(?:([.,])(\d+))?$/.exec(raw);
  if (thousands && thousands[2] !== thousands[1]) {
    const sep = thousands[1]!;
    const body = thousands[2] ? raw.slice(0, raw.length - thousands[3]!.length - 1) : raw;
    return {
      digits: body.split(sep).join("") + (thousands[3] ?? ""),
      decimals: thousands[3]?.length ?? 0,
    };
  }
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(raw);
  if (!m) return null;
  return { digits: m[1]! + (m[2] ?? ""), decimals: m[2]?.length ?? 0 };
}

/** value = digits × 10^(exp − decimals) dollars, in cents; precision = 10^(exp − decimals) dollars. */
function mention(
  digits: string,
  decimals: number,
  exp: number,
  start: number,
  end: number,
): Mention | null {
  const shift = exp - decimals + 2; // power of ten from the last digit to cents
  if (shift < 0) return null; // finer than a cent: not money as written
  const unit = 10n ** BigInt(shift);
  return { cents: BigInt(digits) * unit, precision: unit, start, end };
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/**
 * Every money-like mention in normalized text: digits with an optional scale ("$92 million",
 * "US$92M", "92 M$", "92,000,000"), or English number words with a scale ("thirty-two million").
 * A one-letter scale (m, b, k, g) counts only when attached to the number or followed by "$", so
 * "5 m" (metres) is not five million.
 */
function mentions(text: string): Mention[] {
  const out: Mention[] = [];
  const num = String.raw`\d{1,3}(?:[, .]\d{3})+(?:[.,]\d+)?(?!\d)|\d+(?:[.,]\d+)?(?!\d)`;
  const re = new RegExp(
    String.raw`(?<![\d.,])(${num})(?:\s?(thousand|millions?|milliards?|billions?|mln|bn)(?![a-z])|(mm|k|m|b|g)(?![a-z])|\s(mm|k|m|b|g)(?=\s?\$))?`,
    "g",
  );
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const n = parseNumber(m[1]!);
    if (!n) continue;
    const scale = m[2] ?? m[3] ?? m[4];
    const exp = scale ? SCALE_WORDS[scale]! : 0;
    const found = mention(n.digits, n.decimals, exp, m.index, m.index + m[0].length);
    if (found) out.push(found);
  }
  const words = new RegExp(
    String.raw`(?<![a-z])((?:(?:${Object.keys(NUMBER_WORDS).join("|")}|hundred|and)[ -]?)+?)\s?(thousand|million|billion)(?![a-z])`,
    "g",
  );
  for (let m = words.exec(text); m; m = words.exec(text)) {
    let current = 0;
    for (const w of m[1]!.split(/[ -]+/).filter((x) => x && x !== "and")) {
      if (w === "hundred") current = (current || 1) * 100;
      else current += NUMBER_WORDS[w] ?? 0;
    }
    if (!current) continue;
    const found = mention(String(current), 0, SCALE_WORDS[m[2]!]!, m.index, m.index + m[0].length);
    if (found) out.push(found);
  }
  return out;
}

/** Currency markers (word markers need word boundaries; "cad" must not match "cadence"). */
const CURRENCY_MARKERS: Record<string, RegExp> = {
  USD: /(?<![a-z])(?:us ?\$|u\.s\. ?\$|\$ ?us(?![a-z])|usd(?![a-z])|us dollars?(?![a-z])|u\.s\. dollars?(?![a-z])|american dollars?(?![a-z]))/g,
  CAD: /(?<![a-z])(?:ca ?\$|c ?\$|cdn ?\$|can ?\$|\$ ?ca[dn]?(?![a-z])|cad(?![a-z])|cdn(?![a-z])|canadian dollars?(?![a-z])|dollars? canadiens?(?![a-z]))/g,
  EUR: /€|(?<![a-z])(?:eur|euros?)(?![a-z])/g,
  GBP: /£|(?<![a-z])(?:gbp|pounds? sterling)(?![a-z])/g,
};

/** A plain "$" or "dollars" that is not part of a marker such as US$, C$, CA$ or "US dollars". */
const BARE_DOLLAR =
  /(?<!(?:us|ca|cdn|can|u\.s\.|c) ?)\$(?! ?(?:us|ca|can|cad)(?![a-z]))|(?<!(?:us|u\.s\.|american|canadian) )(?<![a-z])dollars?(?! (?:us|canadiens?|americains?)(?![a-z]))(?![a-z])/g;

const WINDOW = 40;

/** The nearest currency marker within 40 characters of a mention, or null. */
function nearestCurrency(text: string, m: Mention): string | null {
  const lo = Math.max(0, m.start - WINDOW);
  const slice = text.slice(lo, Math.min(text.length, m.end + WINDOW));
  let best: { currency: string; distance: number } | null = null;
  for (const [currency, re] of Object.entries(CURRENCY_MARKERS)) {
    re.lastIndex = 0;
    for (let hit = re.exec(slice); hit; hit = re.exec(slice)) {
      const s = lo + hit.index;
      const e = s + hit[0].length;
      const distance = e <= m.start ? m.start - e : s >= m.end ? s - m.end : 0;
      if (!best || distance < best.distance) best = { currency, distance };
    }
  }
  return best?.currency ?? null;
}

function hasBareDollar(text: string, m: Mention): boolean {
  const lo = Math.max(0, m.start - WINDOW);
  BARE_DOLLAR.lastIndex = 0;
  return BARE_DOLLAR.test(text.slice(lo, Math.min(text.length, m.end + WINDOW)));
}

export interface MoneyValue {
  /** Decimal string, as stored ("402505000", "4655725.77"). */
  amount: string;
  /** ISO code or "unknown". */
  currency: string;
  /** The amount as the source wrote it: sets the allowed rounding and whether a bare "$" counts. */
  asStated: string;
}

/**
 * The amount in any common written form. The page may round it, but never more coarsely than the
 * record's `asStated` (or whole dollars when `asStated` has no number). When the record has a
 * currency, the nearest currency marker within 40 characters must be that currency; with no marker,
 * a bare "$" counts only when `asStated` itself uses a bare "$" (or "dollars").
 */
export function matchMoney(text: string, money: MoneyValue): Match {
  const am = /^(-?)(\d+)(?:\.(\d+))?$/.exec(money.amount);
  if (!am) return NOT_FOUND;
  const fraction = (am[3] ?? "").padEnd(2, "0");
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) return NOT_FOUND;
  const exact = BigInt(am[2]! + fraction.slice(0, 2));
  const stated = normalize(money.asStated);
  const statedMention = mentions(stated)[0];
  const tolerance = statedMention ? statedMention.precision : exact % 100n === 0n ? 100n : 1n;
  BARE_DOLLAR.lastIndex = 0;
  const bareAllowed = BARE_DOLLAR.test(stated);
  for (const m of mentions(text)) {
    if (m.precision > tolerance) continue;
    const rounded = ((exact + m.precision / 2n) / m.precision) * m.precision;
    if (m.cents !== exact && m.cents !== rounded) continue;
    if (money.currency !== "unknown") {
      const near = nearestCurrency(text, m);
      if (near !== null && near !== money.currency) continue;
      if (near === null && !(bareAllowed && hasBareDollar(text, m))) continue;
    }
    return at(m.start);
  }
  return NOT_FOUND;
}
