/**
 * Rounds radar (P-68): which CANDEF companies a lead is about.
 *
 * Two strengths, never confused:
 * - `exact-name`: the filer's name and a CANDEF company's name or legal name have the same
 *   normalized key (names.ts). Still a candidate match: the runbook confirms the entity.
 * - `mention`: a distinctive CANDEF company name appears in an announcement's text. A discovery
 *   signal only; the runbook confirms which entity the text means.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Corpus } from "../../../src/domain/schema/corpus";
import { canonicalText, nameKey, nameKeys } from "../names";

export interface OrgRef {
  orgId: string;
  slug: string;
  name: string;
}

export interface NameIndex {
  byKey: Map<string, OrgRef[]>;
  /** Canonical phrases searched for in announcement text, longest first. */
  phrases: { phrase: string; org: OrgRef }[];
}

/**
 * Single-word names that are ordinary words in government releases. Such a company is still found
 * by an exact Form D name match, but never by a text mention.
 */
const GENERIC_WORDS = new Set([
  "PHOTONIC",
  "QUANTUM",
  "SPACE",
  "CANADA",
  "DEFENCE",
  "SECURITY",
  "AEROSPACE",
  "ROBOTICS",
  "SYSTEMS",
  "MISSION",
  "NORTH",
  "VECTOR",
  "SENSOR",
  "WOLF",
  "REACH",
  "LABS",
  "SOLACE",
  "VOLTA",
]);

function distinctive(key: string): boolean {
  const tokens = key.split(" ");
  if (tokens.length >= 2) return true;
  return key.length >= 5 && !GENERIC_WORDS.has(key);
}

export function buildNameIndex(corpus: Corpus): NameIndex {
  const legal = new Map<string, string[]>();
  for (const a of corpus.assertions)
    if (
      a.predicate === "legal_name" &&
      typeof a.value === "string" &&
      (a.verification === "proposed" || a.verification === "verified")
    )
      legal.set(a.subjectId, [...(legal.get(a.subjectId) ?? []), a.value]);
  const byKey = new Map<string, OrgRef[]>();
  const phrases: { phrase: string; org: OrgRef }[] = [];
  for (const o of corpus.organizations) {
    if (o.kind !== "company" || o.mergedInto || o.isDemo) continue;
    const ref: OrgRef = { orgId: o.id, slug: o.slug, name: o.name };
    const keys = new Set([o.name, ...(legal.get(o.id) ?? [])].flatMap((n) => nameKeys(n)));
    for (const k of keys) {
      const list = byKey.get(k) ?? [];
      if (!list.some((r) => r.orgId === o.id)) list.push(ref);
      byKey.set(k, list);
      if (distinctive(k)) phrases.push({ phrase: k, org: ref });
    }
  }
  phrases.sort((a, b) => b.phrase.length - a.phrase.length);
  return { byKey, phrases };
}

/** Companies whose normalized name equals the reported name's (exact key match only). */
export function matchName(index: NameIndex, reported: string): OrgRef[] {
  const out = new Map<string, OrgRef>();
  for (const k of nameKeys(reported)) for (const r of index.byKey.get(k) ?? []) out.set(r.orgId, r);
  return [...out.values()];
}

/** Companies whose distinctive name appears as whole words in the text. */
export function findMentions(index: NameIndex, text: string): OrgRef[] {
  const canon = ` ${canonicalText(text)} `;
  const out = new Map<string, OrgRef>();
  for (const { phrase, org } of index.phrases)
    if (!out.has(org.orgId) && canon.includes(` ${phrase} `)) out.set(org.orgId, org);
  return [...out.values()];
}

// ---- Federal rows (grant-ask lead index), for new filers -------------------------------------------

export interface FederalRows {
  name: string;
  tier: string;
  dndContractValue: number;
  csaValue: number;
  grantValue: number;
  contractValue: number;
  provinces: string[];
}

/**
 * Looks names up in the grant-ask lead index (one JSON object per line; see docs/LEADS_SEARCH*.md).
 * Exact normalized-name match only. Returns an empty map when the file is absent.
 */
export async function federalRowsFor(
  file: string | null | undefined,
  names: string[],
): Promise<Map<string, FederalRows>> {
  const out = new Map<string, FederalRows>();
  if (!file || !existsSync(file) || names.length === 0) return out;
  const wanted = new Map<string, string>();
  for (const n of names) for (const k of nameKeys(n)) wanted.set(k, n);
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const d = JSON.parse(line) as {
      name: string;
      otherNames?: string[];
      tier: string;
      dndContractValue: number;
      csaValue: number;
      grantValue: number;
      contractValue: number;
      provinces: string[];
    };
    for (const n of [d.name, ...(d.otherNames ?? [])]) {
      const k = nameKey(n);
      const reported = wanted.get(k);
      if (!reported) continue;
      const prev = out.get(reported);
      if (!prev || prev.grantValue + prev.contractValue < d.grantValue + d.contractValue)
        out.set(reported, {
          name: d.name,
          tier: d.tier,
          dndContractValue: d.dndContractValue,
          csaValue: d.csaValue,
          grantValue: d.grantValue,
          contractValue: d.contractValue,
          provinces: d.provinces,
        });
      break;
    }
  }
  return out;
}
