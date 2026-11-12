/**
 * How one independent finding relates to one CANDEF claim (policy section 3, reconciliation).
 *
 * The blind worksheet's signal says `inconsistent` whenever an independent finding exists for a
 * field and none contains the claim's key value. That conflates five different things: the
 * finding agrees in other words, says nothing about this value (an incomplete list), is about a
 * different legal entity, is about a different period (a former name), or really contradicts it.
 * Only the last is a conflict. This module tells them apart, deterministically, from the finding's
 * structured fields and text. It never decides who is right: a contradiction still has to be
 * resolved against original sources (route.ts).
 */
import type { BlindFinding, ResearcherPackage } from "../blind";
import { amountsInText, digitsKey, sigKey } from "../blind";

export type Relation =
  | "supports" // the finding states the claim's value (any wording, any format)
  | "silent" // about the field, but does not state this value: incomplete, not contradictory
  | "other_entity" // about a different legal entity (parent, predecessor, foreign affiliate)
  | "other_period" // about another period: the claim is historical, the finding is current
  | "contradicts" // same entity and period, a different value of the same kind
  | "no_finding" // not found, not researched, not applicable
  | "judgement_agrees" // judgement field (classification, eligibility): same conclusion
  | "judgement_differs"; // judgement field: a different conclusion (an input, not a conflict)

/** Fields that hold one value per entity and period: a different value there is a conflict. */
export const SINGLE_VALUED_FIELDS: ReadonlySet<string> = new Set([
  "A02", // legal name (current)
  "A04", // registry number
  "A05", // business number
  "A06", // headquarters
  "A08", // founded year
  "A11", // listing
  "C02", // a disclosure's amount (per event)
]);
/** Judgement fields: a researcher's different opinion is an input to the owner, not a conflict. */
export const JUDGEMENT_FIELDS: ReadonlySet<string> = new Set(["B01", "B02", "B06"]);

/** Letters and digits, accents folded. */
export const flat = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const LEGAL_FORM =
  /\b(incorporated|inc|ltd|limited|ltee|ltée|corp|corporation|co|company|llc|lp|plc|sa|sas|gmbh|ag|ulc)\b\.?/gi;

/** A legal or brand name without its legal form: "Kraken Robotics Inc." → "krakenrobotics". */
export function nameKey(name: string): string {
  return flat(name.replace(LEGAL_FORM, " "));
}

/** Names with a legal form written in free text ("Field Effect Security Ltd", "PV Labs Inc."). */
export function legalNamesIn(text: string): string[] {
  const out = new Set<string>();
  const re =
    /((?:[A-Z0-9][\w&.'’-]*\s+){0,5}[A-Z0-9][\w&.'’-]*)\s+(Inc|Incorporated|Ltd|Limited|Ltée|Corp|Corporation|LLC|plc|GmbH|ULC|INC|LTD|LIMITED|CORP|CORPORATION)\b\.?/g;
  for (const m of text.matchAll(re)) {
    // Drop leading sentence words ("The", "Exact", "Counterparty:") that are not part of a name.
    const words = m[1]!
      .split(/\s+/)
      .filter(
        (w) =>
          !/^(the|exact|current|legal|name|of|is|and|a|an|its|by|from|counterparty:?|acquirer|parent)$/i.test(
            w,
          ),
      );
    if (words.length) out.add(`${words.join(" ")} ${m[2]}`);
  }
  return [...out];
}

/** Everything a finding says, flattened for token matching. */
export function findingText(f: BlindFinding): string {
  return [
    f.claim,
    typeof f.value === "string" ? f.value : JSON.stringify(f.value ?? null),
    JSON.stringify(f.identifiers ?? []),
    JSON.stringify(f.money ?? []),
    JSON.stringify(f.dates ?? {}),
    f.counterparty ? JSON.stringify(f.counterparty) : "",
  ].join(" ");
}

export interface ClaimView {
  fieldId: string;
  /** Key tokens of the claim's value (blind.ts `signalTokens`): name keys, digit keys, years. */
  tokens: string[];
  /** Name keys of the entity the claim is about (all its names, any period). */
  entityKeys: Set<string>;
  /** Name keys of the other entities on the same card (parent, subsidiary), if any. */
  siblingKeys: Set<string>;
  /** Per base name, the legal elements recorded for this entity ("pvlabs" -> {"ltd"}). */
  entityForms?: Map<string, Set<string>>;
  /** The claim describes a past state (a former legal name, a record with validTo). */
  historical: boolean;
  /** For C02: the disclosure's year-month, to tell "another event" from "another amount". */
  eventMonth?: string | null;
}

export interface FindingView {
  status: string;
  text: string;
  /** The legal name of the entity the researcher filed the finding under, when stated. */
  entityName: string | null;
  finding: BlindFinding | null;
}

export function findingView(
  pkg: ResearcherPackage | undefined,
  findingId: string,
  fallback: { status: string; claim: string },
): FindingView {
  const f = pkg?.findings.find((x) => x.finding_id === findingId) ?? null;
  const entity = f?.entity_id
    ? (pkg?.entities.find((e) => e.entity_id === f.entity_id)?.legal_name ?? null)
    : null;
  return {
    status: f?.status ?? fallback.status,
    text: f ? findingText(f) : fallback.claim,
    entityName: entity,
    finding: f,
  };
}

/** Digit keys and rounded amount keys in a text (how amounts and identifiers are compared). */
function numberKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const n of text.match(/\d[\d,\- ]*(?:\.\d+)?/g) ?? []) {
    const d = digitsKey(n.replace(/[- ]/g, ""));
    if (d) out.add(d);
  }
  for (const n of amountsInText(text)) {
    const k = sigKey(n);
    if (k) out.add(k);
  }
  return out;
}

const FOUNDING_WORDS = /(found|establish|start|formed)/i;

function supports(claim: ClaimView, fv: FindingView): boolean {
  if (!claim.tokens.length) return false;
  const text = fv.text;
  const flatText = flat(text);
  const nums = numberKeys(text);
  return claim.tokens.some((t) => {
    if (!t) return false;
    if (/^~/.test(t) || /^\d{5,}$/.test(t)) return nums.has(t) || flatText.includes(t);
    if (/^(18|19|20)\d{2}$/.test(t)) return new RegExp(`\\b${t}\\b`).test(text);
    return t.length >= 2 && flatText.includes(t);
  });
}

/** The entity a finding is about, when it says: its filed entity, else legal names in its text. */
function aboutOtherEntity(claim: ClaimView, fv: FindingView): boolean {
  // Exact base names only: "Rutter Engineering" is not "Rutter", "Kraken Robotics" is not
  // "Kraken Robotic Systems".
  const known = (k: string) => claim.entityKeys.has(k);
  // Same base name with a different legal element ("PV Labs Inc." vs "PV Labs Ltd.") is another
  // entity: a predecessor, a successor or an affiliate.
  const ours = (name: string) => {
    const k = nameKey(name);
    if (!k || !known(k)) return false;
    const forms = claim.entityForms?.get(k);
    const f = formOf(name);
    return !forms?.size || !f || forms.has(f);
  };
  if (fv.entityName) return !ours(fv.entityName);
  const names = legalNamesIn(fv.text);
  if (!names.length) return false;
  // Only other names, none of ours: the finding is about someone else.
  return names.every((n) => !ours(n));
}

/** The legal element class of a name: Inc. and Incorporated agree, Inc. and Ltd. do not. */
export function formOf(name: string): string | null {
  const last = flat(name.split(/\s+/).at(-1) ?? "");
  const cls: Record<string, string> = {
    inc: "inc",
    incorporated: "inc",
    incorporee: "inc",
    ltd: "ltd",
    limited: "ltd",
    ltee: "ltd",
    limitee: "ltd",
    corp: "corp",
    corporation: "corp",
    llc: "llc",
    ulc: "ulc",
    plc: "plc",
  };
  return cls[last] ?? null;
}

const PERIOD_WORDS =
  /\b(predecessor|formerly|former|previous|previously|renamed|until 20\d\d|prior to)\b/i;

/** Does the finding state a comparable value of the claim's kind (that then differs)? */
function statesComparableValue(claim: ClaimView, fv: FindingView): boolean {
  const text = fv.text;
  const v = fv.finding?.value;
  switch (claim.fieldId) {
    case "A08": {
      if (typeof v === "string" || typeof v === "number")
        return /^(18|19|20)\d{2}$/.test(String(v));
      // A founding statement with its year nearby. Incorporation, continuance and registry
      // anniversary dates are other facts: a company is often founded before it incorporates.
      return (
        FOUNDING_WORDS.test(text) &&
        /(found|establish|start|formed)\w*[^.;]{0,40}\b(18|19|20)\d{2}\b/i.test(text)
      );
    }
    case "A04":
    case "A05":
      return (fv.finding?.identifiers?.length ?? 0) > 0 || numberKeys(text).size > 0;
    case "A02":
      return (typeof v === "string" && v.trim().length > 2) || legalNamesIn(text).length > 0;
    case "A06": {
      const o = (typeof v === "object" && v !== null ? v : {}) as { city?: unknown };
      return typeof o.city === "string" && o.city.trim().length > 1;
    }
    case "A11":
      return /\b(TSX|TSXV|NYSE|NASDAQ|CSE|OTC)\b/.test(text);
    case "C02": {
      // A different amount only conflicts when the finding is about the same event (same month).
      const money = fv.finding?.money ?? [];
      if (!money.some((m) => m.amount)) return false;
      if (!claim.eventMonth) return false;
      const dates = Object.values(fv.finding?.dates ?? {}).filter(Boolean) as string[];
      return dates.some((d) => d.slice(0, 7) === claim.eventMonth);
    }
    default:
      return false;
  }
}

/** The relation of one finding to one claim. Order matters: support first, conflict last. */
export function relate(claim: ClaimView, fv: FindingView): Relation {
  if (!["found", "contradictory"].includes(fv.status)) return "no_finding";
  const hit = supports(claim, fv);
  if (JUDGEMENT_FIELDS.has(claim.fieldId)) {
    // Without a comparable key (eligibility has none) a judgement can neither agree nor differ.
    if (!claim.tokens.length) return "silent";
    return hit ? "judgement_agrees" : "judgement_differs";
  }
  if (hit) return "supports";
  if (aboutOtherEntity(claim, fv)) return "other_entity";
  if (!SINGLE_VALUED_FIELDS.has(claim.fieldId)) return "silent";
  if (claim.historical || PERIOD_WORDS.test(fv.text)) return "other_period";
  return statesComparableValue(claim, fv) ? "contradicts" : "silent";
}

/** Plain words for the owner and the audit trail. */
export const RELATION_LABEL: Record<Relation, string> = {
  supports: "states the same value",
  silent: "does not mention this value (incomplete, not a conflict)",
  other_entity: "is about a different legal entity",
  other_period: "describes another period (claim is historical)",
  contradicts: "gives a different value for the same entity",
  no_finding: "found nothing",
  judgement_agrees: "reaches the same judgement",
  judgement_differs: "reaches a different judgement",
};
