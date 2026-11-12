/**
 * Organization-name normalization for entity resolution (M3-C2).
 *
 * A normalized key is used for EXACT comparison only: never substring or fuzzy matching (a search
 * that matched on the token "Inc." attributed unrelated grants; see the research triage). Two names
 * with the same key are a *candidate* match that still needs a second identifier.
 */

/** Legal-form tokens removed from the END of a name (repeatedly), English and French. */
const LEGAL_SUFFIXES = new Set([
  "INC",
  "INCORPORATED",
  "INCORPOREE",
  "LTD",
  "LIMITED",
  "LTEE",
  "LIMITEE",
  "CORP",
  "CORPORATION",
  "LLC",
  "LLP",
  "LP",
  "ULC",
  "PLC",
  "GMBH",
  "AG",
  "SA",
  "SARL",
  "SENC",
  "SENCRL",
  "CO",
  "COMPANY",
]);

/** Uppercase, accents folded, punctuation removed, "&" → "AND", whitespace collapsed. */
export function canonicalText(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['’`]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Exact-match key for one name: canonical text without trailing legal-form tokens or a leading "THE". */
export function nameKey(raw: string): string {
  const tokens = canonicalText(raw).split(" ").filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  if (tokens.length > 1 && tokens[0] === "THE") tokens.shift();
  return tokens.join(" ");
}

/**
 * Keys for every variant of a reported name. Government datasets record bilingual legal names as
 * "English|French"; each side is a variant.
 */
export function nameKeys(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split("|")
        // A trailing or inline parenthetical is often a trade name or abbreviation ("… Inc. (GSTS)");
        // the name without it is a second variant, never a replacement.
        .flatMap((part) => (part.includes("(") ? [part, part.replace(/\([^)]*\)/g, " ")] : [part]))
        .map((part) => nameKey(part))
        .filter(Boolean),
    ),
  ];
}

/**
 * True when a vendor/recipient string names a joint venture or consortium. Such a record is one
 * award to a group; it must never be attributed to a single member automatically.
 */
export function isConsortiumName(raw: string): boolean {
  const t = canonicalText(raw);
  if (
    /\b(JOINT VENTURE|JV|CONSORTIUM|COENTREPRISE|IN PARTNERSHIP WITH|EN PARTENARIAT AVEC)\b/.test(t)
  )
    return true;
  // "A Inc. and B Ltd.": two legal-form tokens joined by AND indicate two parties.
  const parts = t.split(/\bAND\b/);
  const withSuffix = parts.filter((p) =>
    p
      .trim()
      .split(" ")
      .some((tok) => LEGAL_SUFFIXES.has(tok) && tok !== "CO" && tok !== "COMPANY"),
  );
  return withSuffix.length >= 2;
}

/**
 * Canada Revenue Agency business number: the 9-digit root, or null when malformed or a placeholder.
 * "0", "N/A", "NONE" and 10-digit cells already fail the shape. A root of one repeated digit
 * ("000000000": 2,354 non-individual grant rows naming more than 50 different recipients in the
 * 2026-10-13 file; "999999999", "111111111") is a filler, not an identifier, and would otherwise
 * tie unrelated recipients together.
 */
export function businessNumberRoot(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim().toUpperCase().replace(/[ -]/g, "");
  const root = /^(\d{9})(?:[A-Z]{2}\d{4})?$/.exec(value)?.[1] ?? null;
  return root && !/^(\d)\1{8}$/.test(root) ? root : null;
}

/** Forward sortation area (first 3 characters of a Canadian postal code), or null. */
export function postalFsa(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.toUpperCase().replace(/\s+/g, "");
  return /^[A-Z]\d[A-Z]/.test(t) ? t.slice(0, 3) : null;
}
