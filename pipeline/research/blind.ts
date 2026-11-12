/**
 * Blind independent verification (docs/verification/blind-v2-internal/RECONCILIATION_PLAN.md).
 *
 * - `ResearcherPackage`: the structured return format external researchers fill in.
 * - `buildInventory`: the PRIVATE inventory of every CANDEF record and every user-facing derived
 *   display about the selected companies. Derived displays are computed by compiling an in-memory
 *   copy of the corpus in which every proposed record is treated as approved, so the inventory shows
 *   exactly what the product would display. That copy is never written anywhere: nothing here
 *   approves, edits or publishes a research record.
 * - `leakCheck`: proves the shareable package contains none of the inventory's values.
 * - `buildWorksheet`: aligns returned findings with the inventory; every inventory claim starts as
 *   `not_yet_evaluated` and outcomes are assigned only after reading primary evidence.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Agreement, Assertion, Corpus, Predicate } from "../../src/domain/schema/corpus";
import type { OrgView, Snapshot } from "../../src/domain/schema/snapshot";
import { compile } from "../compile/compile";
import { canonicalJson, sealDemoCorpus } from "../compile/hash";
import { BLIND_FIELDS, EVENT_FIELDS, groupOf } from "./blindFields";

// ---- Researcher return format -------------------------------------------------------------------

export const FINDING_STATUS = [
  "found",
  "not_found",
  "not_applicable",
  "confirmed_absent",
  "contradictory",
  "not_researched",
] as const;

const BlindSource = z.object({
  url: z.string(),
  title: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
  published_on: z.string().nullable().optional(),
  accessed_on: z.string().nullable().optional(),
  source_type: z
    .enum([
      "first_party",
      "registry",
      "government_dataset",
      "government_publication",
      "filing",
      "counterparty",
      "investor",
      "news",
      "patent_office",
      "aggregator",
      "other",
    ])
    .optional(),
  locator: z.string(),
  quote: z.string().nullable().optional(),
  same_origin_as: z.array(z.string()).optional(),
});

const Money = z.object({
  amount: z.string().nullable(),
  currency: z.string(),
  as_stated: z.string().nullable().optional(),
  basis: z.string().nullable().optional(),
  nature: z.string().nullable().optional(),
});

export const BlindFinding = z.object({
  finding_id: z.string(),
  field_id: z.enum(BLIND_FIELDS.map((f) => f.id) as [string, ...string[]]),
  entity_id: z.string().nullable().optional(),
  status: z.enum(FINDING_STATUS),
  claim: z.string(),
  value: z.unknown().optional(),
  dates: z.record(z.string(), z.string().nullable()).optional(),
  money: z.array(Money).optional(),
  counterparty: z
    .object({
      name_as_reported: z.string(),
      legal_name: z.string().nullable().optional(),
      kind: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  identifiers: z.array(z.object({ system: z.string(), value: z.string() })).optional(),
  links_to: z.array(z.string()).optional(),
  sources: z.array(BlindSource),
  confidence: z.enum(["high", "medium", "low"]),
  confidence_reason: z.string().nullable().optional(),
  contradictions: z
    .array(
      z.object({
        claim: z.string(),
        sources: z.array(BlindSource),
        assessment: z.string().nullable().optional(),
      }),
    )
    .optional(),
  searched: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
});
export type BlindFinding = z.infer<typeof BlindFinding>;

export const ResearcherPackageShape = z.object({
  package_version: z.literal("candef-blind-v2"),
  researcher: z.object({
    id: z.string(),
    model_or_tool: z.string(),
    started_at: z.string().nullable().optional(),
    finished_at: z.string().nullable().optional(),
    browsing: z.boolean(),
    limitations: z.array(z.string()),
  }),
  company: z.object({
    card_id: z.string(),
    name_as_given: z.string(),
    website_as_given: z.string(),
  }),
  entities: z.array(
    z.object({
      entity_id: z.string(),
      legal_name: z.string().nullable(),
      role: z.string(),
      jurisdiction: z.string().nullable().optional(),
      identifiers: z.array(z.object({ system: z.string(), value: z.string() })).optional(),
      notes: z.string().nullable().optional(),
    }),
  ),
  findings: z.array(BlindFinding),
  search_log: z
    .array(
      z.object({
        category: z.string(),
        searched: z.array(z.string()),
        date: z.string().nullable().optional(),
      }),
    )
    .optional(),
  derived: z
    .array(
      z.object({
        field_id: z.string(),
        value: z.unknown(),
        computation: z.string(),
        inputs: z.array(z.string()),
      }),
    )
    .optional(),
  open_questions: z.array(z.string()).optional(),
});

/** Fields whose value is the researcher's judgement over other findings (the brief asks them to cite finding IDs). */
export const JUDGMENT_FIELDS = new Set(["B01", "B02", "B06"]);

export interface FindingIssue {
  findingId: string;
  index: number;
  message: string;
}

/**
 * Evidence problems inside a well-formed package. A finding with an issue is kept for the record
 * but can never support an outcome. `found` needs a source, except a judgement field or a
 * cross-reference to other findings (`links_to`, or finding IDs named in the claim), as the brief
 * instructs; `not_found` and `confirmed_absent` need the places searched or the source.
 */
export function packageIssues(pkg: z.infer<typeof ResearcherPackageShape>): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const ids = new Set<string>();
  pkg.findings.forEach((f, i) => {
    const add = (message: string) => issues.push({ findingId: f.finding_id, index: i, message });
    if (ids.has(f.finding_id)) add("duplicate finding_id");
    ids.add(f.finding_id);
    const crossReference = (f.links_to?.length ?? 0) > 0 || /\bF\d{2,}\b/.test(f.claim);
    if (
      f.status === "found" &&
      f.sources.length === 0 &&
      !JUDGMENT_FIELDS.has(f.field_id) &&
      !crossReference
    )
      add("a found claim needs a source");
    if (
      (f.status === "not_found" || f.status === "confirmed_absent") &&
      !(f.searched?.length || f.sources.length)
    )
      add("not_found / confirmed_absent need the places searched or the source");
  });
  return issues;
}

export const ResearcherPackage = ResearcherPackageShape.superRefine((pkg, ctx) => {
  for (const issue of packageIssues(pkg))
    ctx.addIssue({ code: "custom", path: ["findings", issue.index], message: issue.message });
});
export type ResearcherPackage = z.infer<typeof ResearcherPackage>;

/** Source-type spellings researchers used, mapped onto the schema's list (the raw value is noted). */
const SOURCE_TYPE_ALIASES: [RegExp, string][] = [
  [/^(press_release|company_press_release|first_party.*)$/i, "first_party"],
  [
    /^(government|government_release|government_notice|government news release|government_foreign|government_record)$/i,
    "government_publication",
  ],
  [/^(secondary|independent_news|news_.*|trade_press|media)$/i, "news"],
  [/^(exchange|regulatory_filing|filing_.*)$/i, "filing"],
  [/^(patent|patent database|patent_database)$/i, "patent_office"],
  [/^counterparty \(investor\)$/i, "investor"],
  [/^counterparty.*$/i, "counterparty"],
];
const SOURCE_TYPES = new Set([
  "first_party",
  "registry",
  "government_dataset",
  "government_publication",
  "filing",
  "counterparty",
  "investor",
  "news",
  "patent_office",
  "aggregator",
  "other",
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** The object entries of a list (anything else in it, or a non-list, is ignored by the loops). */
const asRecords = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isPlainObject) : [];

/** Identifier entries without a value are dropped (nothing was claimed); numbers become text. */
function cleanIdentifiers(list: unknown[], bump: (k: string) => void): unknown[] {
  return list.flatMap((i) => {
    if (!isPlainObject(i)) return [i];
    if (i.value === null || i.value === undefined || i.value === "") {
      bump("identifier without a value dropped");
      return [];
    }
    if (typeof i.value === "number") {
      i.value = String(i.value);
      bump("identifier number -> string");
    }
    return [i];
  });
}

/**
 * Researchers wrote contradictions as a bare sentence or with other field names (`issue`,
 * `version`, `versions`). The schema wants `{ claim, sources, assessment }`: the text they gave
 * becomes the claim, so nothing is lost and nothing is added.
 */
function contradictionAsClaim(c: unknown): unknown {
  if (typeof c === "string") return { claim: c, sources: [] };
  if (!isPlainObject(c) || typeof c.claim === "string") return c;
  const strings: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (isPlainObject(v)) Object.values(v).forEach(collect);
  };
  for (const [k, v] of Object.entries(c)) if (k !== "assessment" && k !== "sources") collect(v);
  return { ...c, claim: strings.join(" | ") || "(no text given)" };
}

export interface Intake {
  pkg: ResearcherPackage | null;
  errors: string[];
  /** Mechanical format normalizations applied in memory (the original file is never changed). */
  notes: string[];
  /** Findings kept for the record that cannot support an outcome. */
  issues: FindingIssue[];
}

/**
 * Reads a returned package without changing the file: applies a few mechanical, logged
 * normalizations (source-type spellings, a single `links_to` string, an omitted empty `sources`
 * list), then validates the shape. Evidence problems do not reject the package; they mark the
 * affected findings as unusable.
 */
export function intakePackage(raw: unknown): Intake {
  const notes: string[] = [];
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  const copy = structuredClone(raw) as { findings?: Record<string, unknown>[] };
  // A finding filed under a field that is not in the inventory cannot be compared with anything:
  // it is set aside (the note keeps its text, so it stays readable as a lead), not guessed at.
  if (Array.isArray(copy?.findings)) {
    const known = new Set(BLIND_FIELDS.map((x) => x.id));
    copy.findings = copy.findings.filter((f) => {
      if (!isPlainObject(f) || typeof f.field_id !== "string" || known.has(f.field_id)) return true;
      const text = typeof f.claim === "string" ? f.claim.slice(0, 220) : "(no claim)";
      notes.push(
        `finding ${String(f.finding_id)} set aside: field_id "${f.field_id}" is not in the inventory (status ${String(f.status)}): ${text}`,
      );
      return false;
    });
  }
  for (const f of copy?.findings ?? []) {
    if (f.confidence === undefined && f.status === "not_researched") {
      f.confidence = "low";
      bump("confidence missing on a not_researched finding -> low");
    }
    if (typeof f.links_to === "string") {
      f.links_to = [f.links_to];
      counts.set("links_to string -> list", (counts.get("links_to string -> list") ?? 0) + 1);
    }
    if (f.sources === undefined) {
      f.sources = [];
      counts.set(
        `omitted sources -> [] (status ${String(f.status)})`,
        (counts.get(`omitted sources -> [] (status ${String(f.status)})`) ?? 0) + 1,
      );
    }
    if (isPlainObject(f.money)) {
      f.money = [f.money];
      bump("money object -> list");
    }
    for (const m of asRecords(f.money)) {
      if (typeof m.amount === "number") {
        m.amount = String(m.amount);
        bump("money amount number -> string");
      }
      if (m.currency === null || m.currency === undefined) {
        m.currency = "unknown";
        bump("money currency missing -> unknown");
      }
    }
    if (Array.isArray(f.identifiers)) f.identifiers = cleanIdentifiers(f.identifiers, bump);
    if (Array.isArray(f.contradictions))
      f.contradictions = f.contradictions.map((c: unknown) => {
        const reshaped = contradictionAsClaim(c);
        if (reshaped !== c) bump("contradiction reshaped to a claim text");
        if (isPlainObject(reshaped) && reshaped.sources === undefined) {
          reshaped.sources = [];
          bump("contradiction without sources -> []");
        }
        return reshaped;
      });
    for (const src of asRecords(f.sources)) {
      const t = src.source_type;
      if (typeof t === "string" && !SOURCE_TYPES.has(t)) {
        const mapped = SOURCE_TYPE_ALIASES.find(([re]) => re.test(t))?.[1] ?? "other";
        src.source_type = mapped;
        counts.set(
          `source_type "${t}" -> ${mapped}`,
          (counts.get(`source_type "${t}" -> ${mapped}`) ?? 0) + 1,
        );
      }
    }
  }
  const entities = (copy as { entities?: unknown }).entities;
  for (const e of asRecords(entities))
    if (Array.isArray(e.identifiers)) e.identifiers = cleanIdentifiers(e.identifiers, bump);
  for (const [k, n] of counts) notes.push(`${k} (${n})`);
  const r = ResearcherPackageShape.safeParse(copy);
  if (!r.success)
    return {
      pkg: null,
      errors: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      notes,
      issues: [],
    };
  return { pkg: r.data, errors: [], notes, issues: packageIssues(r.data) };
}

// ---- Cards ------------------------------------------------------------------------------------

/** Internal mapping from a neutral card to the CANDEF organizations it covers. */
export interface BlindCard {
  card: string;
  name: string;
  website: string;
  orgSlugs: string[];
}

// ---- Internal inventory -------------------------------------------------------------------------

export const OUTCOMES = [
  "corroborated",
  "contradicted",
  "partial",
  "not_found_independently",
  "not_yet_evaluated",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface InventoryItem {
  claimId: string;
  card: string;
  orgSlug: string;
  entity: string;
  fieldId: string;
  /** base = a research record; derived = computed for display; absence = a displayed "not found";
   * process = research-ledger record behind coverage and "not found" displays. */
  kind: "base" | "derived" | "absence" | "process";
  label: string;
  value: string;
  valueHash: string;
  recordIds: string[];
  /** Identifier and amount tokens used to align event findings (procurement IDs, numbers…). */
  matchKeys: string[];
  shownIn: string[];
  /** Would the product display it if every record were approved? null = not a displayed item. */
  publishes: boolean | null;
  note: string | null;
  citations: { sourceId: string; url: string | null; locator: string }[];
  outcome: Outcome;
}

export interface Inventory {
  generatedAt: string;
  today: string;
  simulation: { ok: boolean; failures: string[] };
  cards: BlindCard[];
  items: InventoryItem[];
  /** Short strings that must not appear in the shareable package (leak check). */
  leakTokens: { token: string; claimId: string }[];
}

const FIELD_OF_PREDICATE: Partial<Record<Predicate, string>> = {
  legal_name: "A02",
  hq_location: "A06",
  founded_year: "A08",
  description: "A10",
  classified_as: "B01",
  eligibility: "B06",
  public_listing: "A11",
  subsidiary_of: "A12",
  division_of: "A13",
  managed_by: "D01",
  operations_location: "A07",
  website: "A09",
  role_held: "H01",
  registry_id: "A04",
  total_raised_as_stated: "C04",
};

/** Predicates the compiler turns into displayed facts (OrgView); others are stored only. */
const DISPLAYED_PREDICATES = new Set<Predicate>([
  "legal_name",
  "hq_location",
  "founded_year",
  "description",
  "classified_as",
  "eligibility",
  "public_listing",
  "subsidiary_of",
  "managed_by",
  "registry_id",
]);

const AGREEMENT_FIELD: Record<Agreement["family"], string> = {
  procurement: "E01",
  grant_contribution: "E02",
  other_transfer: "E03",
  partnership: "E07",
};

const hash = (v: unknown) =>
  createHash("sha256")
    .update(canonicalJson(v ?? null))
    .digest("hex")
    .slice(0, 16);

const compact = (v: unknown): string =>
  v === null || v === undefined
    ? "null"
    : typeof v === "string"
      ? v
      : JSON.stringify(v, (_k, x) => (x === null ? undefined : x));

/** Digits of an amount or identifier, for alignment ("1,250,000.00" and "1250000" agree). */
export function digitsKey(s: string): string | null {
  const intPart = s.replace(/[\s,]/g, "").split(".")[0] ?? "";
  const digits = intPart.replace(/\D/g, "");
  return digits.length >= 5 ? digits.replace(/^0+/, "") : null;
}

/** Letters and digits only, accents folded ("Montréal" and "Montreal" agree). */
const idKey = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Three significant digits of an amount, so a rounded "$402.5 million" meets 402,505,000. */
export function sigKey(n: number): string | null {
  if (!Number.isFinite(n) || n < 10_000) return null;
  const exp = Math.floor(Math.log10(n)) - 2;
  return `~${Math.round(n / 10 ** exp)}e${exp}`;
}

/** Amounts in text, including words ("US$30 million", "$4.7M", "1.2 billion"), as numbers. */
export function amountsInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(million|mil|mm|m|billion|bn|b)\b/gi)) {
    const unit = m[2]!.toLowerCase();
    out.push(Number(m[1]) * (unit.startsWith("b") ? 1e9 : 1e6));
  }
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (n >= 10_000) out.push(n);
  }
  return out;
}

/** Exact digits plus the rounded key of an amount, for alignment. */
const amountKeys = (amount: string | null | undefined): string[] => {
  if (!amount) return [];
  const n = Number(amount);
  return [digitsKey(amount), sigKey(n)].filter((x): x is string => !!x);
};

/**
 * In-memory copy of the corpus in which every proposed record is approved (sealed demo reviews).
 * Never written, never published; `isDemo` keeps it out of any real build.
 */
export function approvedCorpus(
  corpus: Corpus,
  today: string,
  /** Only these record IDs are approved; every proposed record when omitted. */
  only?: ReadonlySet<string>,
): Corpus {
  const copy: Corpus = structuredClone(corpus);
  copy.isDemo = true;
  for (const o of copy.organizations) o.isDemo = true;
  const approve = <T extends { verification: string }>(r: T, id?: string): T =>
    r.verification === "proposed" && (!only || (id !== undefined && only.has(id)))
      ? { ...r, verification: "verified" }
      : r;
  copy.assertions = copy.assertions.map((a) => approve(a, a.id));
  // A round's disclosures and participations have no review unit of their own: they follow it.
  const follow = <T extends { verification: string }>(r: T): T =>
    r.verification === "proposed" ? { ...r, verification: "verified" } : r;
  copy.rounds = copy.rounds.map((r) => {
    const on = !only || only.has(r.id);
    return approve(
      {
        ...r,
        disclosures: r.disclosures.map((d) => (on ? follow(d) : d)),
        participations: r.participations.map((p) => (on ? follow(p) : p)),
      },
      r.id,
    );
  });
  copy.agreements = copy.agreements.map((g) => approve(g, g.id));
  copy.acquisitions = copy.acquisitions.map((q) => approve(q, q.id));
  return sealDemoCorpus(copy, `${today}T00:00:00Z`);
}

/** In-memory "everything approved" copy: never written, never published. */
export function simulateApproved(
  corpus: Corpus,
  today: string,
): { snapshot: Snapshot | null; failures: string[] } {
  const result = compile(approvedCorpus(corpus, today), { today });
  return {
    snapshot: result.snapshot,
    failures: result.failures.map(
      (f) => `${f.gate}: ${f.message} (${f.ids.slice(0, 5).join(", ")})`,
    ),
  };
}

export function buildInventory(corpus: Corpus, cards: BlindCard[], today: string): Inventory {
  const sim = simulateApproved(corpus, today);
  const snap = sim.snapshot;
  const orgById = new Map(corpus.organizations.map((o) => [o.id, o]));
  const orgBySlug = new Map(corpus.organizations.map((o) => [o.slug, o]));
  const sourceById = new Map(corpus.sources.map((s) => [s.id, s]));
  const nameOf = (id: string | null | undefined) => (id ? (orgById.get(id)?.name ?? id) : "none");
  const viewById = new Map((snap?.organizations ?? []).map((v) => [v.id, v]));
  const items: InventoryItem[] = [];
  const leak: { token: string; claimId: string }[] = [];
  const fieldShown = new Map(BLIND_FIELDS.map((f) => [f.id, f.shownIn]));

  const cite = (ev: { sourceId: string; locator: string }[]) =>
    ev.map((e) => ({
      sourceId: e.sourceId,
      url: sourceById.get(e.sourceId)?.url ?? null,
      locator: e.locator,
    }));

  for (const card of cards) {
    const orgs = card.orgSlugs.map((s) => {
      const o = orgBySlug.get(s);
      if (!o) throw new Error(`card ${card.card}: unknown organization slug ${s}`);
      return o;
    });
    const ids = new Set(orgs.map((o) => o.id));
    const seen = new Set<string>();
    const add = (
      it: Omit<InventoryItem, "card" | "valueHash" | "outcome" | "shownIn"> & {
        shownIn?: string[];
      },
    ) => {
      if (seen.has(it.claimId)) return;
      seen.add(it.claimId);
      items.push({
        ...it,
        card: card.card,
        shownIn: it.shownIn ?? fieldShown.get(it.fieldId) ?? [],
        valueHash: hash(it.value),
        outcome: "not_yet_evaluated",
      });
    };
    const token = (t: string | null | undefined, claimId: string) => {
      if (t && t.trim().length >= 4) leak.push({ token: t.trim(), claimId });
    };

    const assertionItem = (a: Assertion, entity: string, slug: string, contextual: boolean) => {
      const field = contextual
        ? "D01"
        : a.predicate === "legal_name" && a.verification === "superseded"
          ? "A03"
          : a.predicate === "registry_id" && (a.value as { system?: string })?.system === "cra-bn"
            ? "A05"
            : a.predicate === "classified_as" && !a.primary
              ? "B02"
              : FIELD_OF_PREDICATE[a.predicate];
      // The fixed blind-research rubric has no field for newly supported predicates.
      if (!field) return;
      const displayed = DISPLAYED_PREDICATES.has(a.predicate);
      const claimId = `${card.card}:${field}:${a.id}`;
      const v = a.value as Record<string, unknown> | string | number | null;
      add({
        claimId,
        orgSlug: slug,
        entity,
        fieldId: field,
        kind: "base",
        label: `${a.predicate}${contextual ? " (contextual entity)" : ""}`,
        value:
          ["subsidiary_of", "managed_by", "division_of"].includes(a.predicate) &&
          typeof v === "string"
            ? `${nameOf(v)} (${v})`
            : compact(v),
        recordIds: [a.id],
        matchKeys: [compact(v)].flatMap((s) => [digitsKey(s)].filter((x): x is string => !!x)),
        publishes: displayed ? (snap ? !!snap.assertions[a.id] : null) : null,
        note: displayed
          ? a.verification === "proposed"
            ? null
            : `state: ${a.verification}`
          : "stored; not displayed today",
        citations: cite(a.evidence),
      });
      if (typeof v === "string") token(v.length <= 120 ? v : null, claimId);
      else if (v && typeof v === "object") {
        const rec = v as Record<string, unknown>;
        for (const k of ["city", "value", "ticker", "exchange", "name", "legalName"])
          if (typeof rec[k] === "string") token(rec[k] as string, claimId);
      }
      if (a.predicate === "subsidiary_of" || a.predicate === "managed_by")
        token(nameOf(String(v)), claimId);
    };

    // Organizations on the card: their own records.
    for (const o of orgs) {
      add({
        claimId: `${card.card}:A01:${o.id}`,
        orgSlug: o.slug,
        entity: o.name,
        fieldId: "A01",
        kind: "base",
        label: "display name (organization record)",
        value: o.name,
        recordIds: [o.id],
        matchKeys: [],
        publishes: snap ? viewById.get(o.id)?.scope === "universe" : null,
        note:
          snap && viewById.get(o.id)?.scope !== "universe"
            ? "not in the published universe even if every record were approved"
            : null,
        citations: [],
      });
      for (const a of corpus.assertions.filter((x) => x.subjectId === o.id))
        assertionItem(a, o.name, o.slug, false);
      for (const r of corpus.research.filter((x) => x.subjectId === o.id))
        add({
          claimId: `${card.card}:LEDGER:${r.id}`,
          orgSlug: o.slug,
          entity: o.name,
          fieldId: "LEDGER",
          kind: "process",
          label: `research ledger: ${r.topic}`,
          value: `${r.outcome} at ${r.at}; next review ${r.nextReview ?? "none"}; searched ${r.sourcesSearched.length} source(s)`,
          recordIds: [r.id],
          matchKeys: [],
          publishes: null,
          note: "drives the coverage table and 'not found' displays",
          citations: [],
          shownIn: [
            "dossier research coverage table",
            "company card research coverage",
            "'not found' states",
          ],
        });
    }

    const contextualIds = new Set<string>();

    // Financing.
    for (const r of corpus.rounds.filter((x) => ids.has(x.companyId))) {
      const slug = orgById.get(r.companyId)!.slug;
      const view = snap?.rounds.find((x) => x.id === r.id);
      const claimId = `${card.card}:C01:${r.id}`;
      add({
        claimId,
        orgSlug: slug,
        entity: nameOf(r.companyId),
        fieldId: "C01",
        kind: "base",
        label: "financing round",
        value: compact({
          label: r.roundLabelAsStated,
          stage: r.stage,
          eventState: r.eventState,
          instrument: r.instrument,
          proceeds: r.proceeds,
          participantsCompleteness: r.participantsCompleteness,
          displayedDate: view?.date,
          displayedAmount: view
            ? { status: view.resolved.status, money: view.resolved.money, note: view.resolved.note }
            : undefined,
        }),
        recordIds: [r.id],
        matchKeys: r.disclosures.flatMap((d) =>
          [...amountKeys(d.amount.amount), d.date.slice(0, 7)].filter((x): x is string => !!x),
        ),
        publishes: snap ? !!view && view.verification === "verified" : null,
        note: null,
        citations: cite(r.evidence),
      });
      token(
        r.roundLabelAsStated && !/^(seed|pre-seed|series [a-f])$/i.test(r.roundLabelAsStated)
          ? r.roundLabelAsStated
          : null,
        claimId,
      );
      for (const d of r.disclosures) {
        const dId = `${card.card}:C02:${d.id}`;
        add({
          claimId: dId,
          orgSlug: slug,
          entity: nameOf(r.companyId),
          fieldId: "C02",
          kind: "base",
          label: `disclosure of ${r.id}`,
          value: compact({
            date: d.date,
            kind: d.kind,
            amount: d.amount,
            basis: d.amountBasis,
            nature: d.amountNature,
          }),
          recordIds: [d.id, r.id],
          matchKeys: [...amountKeys(d.amount.amount), d.date.slice(0, 7)].filter(
            (x): x is string => !!x,
          ),
          publishes: snap ? !!view?.disclosures.some((x) => x.id === d.id) : null,
          note: null,
          citations: cite(d.evidence),
        });
        if (d.amount.amount) token(d.amount.amount, dId);
        token(d.amount.asStated, dId);
      }
      r.participations.forEach((p, i) => {
        contextualIds.add(p.investorId);
        if (p.vehicleId) contextualIds.add(p.vehicleId);
        const pId = `${card.card}:C03:${r.id}#p${i}`;
        add({
          claimId: pId,
          orgSlug: slug,
          entity: nameOf(r.companyId),
          fieldId: "C03",
          kind: "base",
          label: `participant in ${r.id}`,
          value: compact({
            investor: nameOf(p.investorId),
            vehicle: p.vehicleId ? nameOf(p.vehicleId) : null,
            role: p.role,
            reportedName: p.reportedName,
            tranches: p.disclosureIds,
          }),
          recordIds: [`${r.id}#p${i}`, r.id],
          matchKeys: [idKey(p.reportedName), idKey(nameOf(p.investorId))],
          publishes: snap ? !!view?.participants.some((x) => x.investorId === p.investorId) : null,
          note: null,
          citations: cite(p.evidence),
        });
        token(p.reportedName, pId);
        token(nameOf(p.investorId), pId);
        if (p.vehicleId) token(nameOf(p.vehicleId), pId);
      });
    }

    // Government and other agreements.
    for (const g of corpus.agreements.filter((x) => x.parties.some((p) => ids.has(p.orgId)))) {
      const party = g.parties.find((p) => ids.has(p.orgId))!;
      const slug = orgById.get(party.orgId)!.slug;
      const field = AGREEMENT_FIELD[g.family];
      const view = snap?.agreements.find((x) => x.id === g.id);
      const counterparty = g.parties.find((p) => p.role === "buyer" || p.role === "funder");
      if (counterparty) contextualIds.add(counterparty.orgId);
      const ends = g.disclosureRows
        .map((r) => r.endOnAsStated)
        .filter((x): x is string => !!x)
        .sort();
      const claimId = `${card.card}:${field}:${g.id}`;
      add({
        claimId,
        orgSlug: slug,
        entity: nameOf(party.orgId),
        fieldId: field,
        kind: "base",
        label: `${g.family} agreement`,
        value: compact({
          title: g.title,
          type: g.type,
          sourceClassification: g.sourceClassification,
          program:
            g.externalIds.find((x) => x.system === "tbs-grants:program")?.value ?? g.programId,
          counterparty: counterparty ? nameOf(counterparty.orgId) : null,
          companyRole: party.role,
          reportedName: party.reportedName,
          evidenceStrength: party.evidenceStrength,
          currency: g.currency,
          displayedValue: view?.currentValue,
          valueBasis: view?.valueBasis,
          originalValue: g.disclosureRows[0]?.originalValue ?? null,
          attribution: view?.attributions.find((a) => ids.has(a.orgId)),
          startOn: g.startOn,
          latestEnd: ends[ends.length - 1] ?? null,
          repayability: g.repayability,
          status: g.statusAsOf,
          externalIds: g.externalIds.filter((x) => x.system !== "tbs-grants:program"),
        }),
        recordIds: [g.id],
        matchKeys: [
          // Program names are shared by many agreements: never an identity key.
          ...g.externalIds
            .filter((x) => x.system !== "tbs-grants:program")
            .map((x) => idKey(x.value)),
          ...g.disclosureRows.flatMap((r) => amountKeys(r.totalValue)),
        ].filter((x): x is string => !!x && x.length >= 4),
        publishes: snap ? !!view && view.attributions.some((a) => ids.has(a.orgId)) : null,
        note: g.createdBy.startsWith("pipeline:")
          ? "imported from the TBS datasets"
          : "entered by hand",
        citations: cite(g.evidence),
      });
      token(g.title.length <= 120 ? g.title : null, claimId);
      for (const x of g.externalIds) if (x.system !== "tbs-grants:program") token(x.value, claimId);
      g.disclosureRows.forEach((row, i) => {
        const rId = `${claimId}:row${i}`;
        add({
          claimId: rId,
          orgSlug: slug,
          entity: nameOf(party.orgId),
          fieldId: field,
          kind: "base",
          label: `disclosure row ${i + 1} of ${g.id}`,
          value: compact(row),
          recordIds: [g.id],
          matchKeys: [...amountKeys(row.totalValue), ...amountKeys(row.amendmentValue)].filter(
            (x): x is string => !!x,
          ),
          publishes: snap ? !!view : null,
          note: null,
          citations: cite(g.evidence.length === g.disclosureRows.length ? [g.evidence[i]!] : []),
        });
        if (row.totalValue) token(row.totalValue, rId);
      });
    }

    // Acquisitions (as target or acquirer).
    for (const q of corpus.acquisitions.filter(
      (x) => ids.has(x.targetId) || ids.has(x.acquirerId),
    )) {
      const own = ids.has(q.targetId) ? q.targetId : q.acquirerId;
      contextualIds.add(ids.has(q.targetId) ? q.acquirerId : q.targetId);
      const claimId = `${card.card}:A15:${q.id}`;
      add({
        claimId,
        orgSlug: orgById.get(own)!.slug,
        entity: nameOf(own),
        fieldId: "A15",
        kind: "base",
        label: "acquisition",
        value: compact({
          target: nameOf(q.targetId),
          acquirer: nameOf(q.acquirerId),
          history: q.history,
          consideration: q.consideration,
          reported: q.reportedConsideration.length,
        }),
        recordIds: [q.id],
        matchKeys: q.history.map((h) => h.date.slice(0, 7)),
        publishes: snap ? snap.acquisitions.some((x) => x.id === q.id) : null,
        note: null,
        citations: cite(q.evidence),
      });
      token(nameOf(q.targetId), claimId);
      token(nameOf(q.acquirerId), claimId);
    }

    // Parents and fund managers named by the card's own facts are contextual entities too.
    for (const a of corpus.assertions.filter(
      (x) =>
        ids.has(x.subjectId) && (x.predicate === "subsidiary_of" || x.predicate === "division_of"),
    ))
      if (typeof a.value === "string") contextualIds.add(a.value);
    for (const id of [...contextualIds]) {
      const managed = corpus.assertions.find(
        (a) => a.subjectId === id && a.predicate === "managed_by",
      );
      if (managed && typeof managed.value === "string") contextualIds.add(managed.value);
    }
    for (const id of [...contextualIds].filter((x) => !ids.has(x)).sort()) {
      const o = orgById.get(id);
      if (!o) continue;
      const claimId = `${card.card}:D01:${o.id}`;
      add({
        claimId,
        orgSlug: o.slug,
        entity: o.name,
        fieldId: "D01",
        kind: "base",
        label: "contextual organization (name and kind)",
        value: compact({ name: o.name, kind: o.kind }),
        recordIds: [o.id],
        matchKeys: [idKey(o.name)],
        publishes: snap ? viewById.has(o.id) : null,
        note: null,
        citations: [],
      });
      token(o.name, claimId);
      for (const a of corpus.assertions.filter((x) => x.subjectId === o.id))
        assertionItem(a, o.name, o.slug, true);
    }

    // Derived and absence displays, from the simulated snapshot.
    if (snap) for (const o of orgs) deriveFor(card.card, o.id, snap, add, nameOf);
  }

  return {
    generatedAt: new Date().toISOString(),
    today,
    simulation: { ok: !!snap, failures: sim.failures },
    cards,
    items,
    leakTokens: leak,
  };
}

type Adder = (
  it: Omit<InventoryItem, "card" | "valueHash" | "outcome" | "shownIn"> & { shownIn?: string[] },
) => void;

/** Mirrors `attributableCad` in src/features/explorer/CompanyCard.tsx (keep in step). */
function attributableCad(snap: Snapshot, orgId: string, family: string) {
  let total = 0;
  let counted = 0;
  const all = snap.agreements.filter(
    (g) => g.family === family && g.attributions.some((a) => a.orgId === orgId),
  );
  for (const g of all) {
    const a = g.attributions.find((x) => x.orgId === orgId);
    if (a?.money?.amount && a.money.currency === "CAD") {
      total += Number(a.money.amount);
      counted++;
    }
  }
  return { count: all.length, total, counted, ids: all.map((g) => g.id) };
}

function deriveFor(
  card: string,
  orgId: string,
  snap: Snapshot,
  add: Adder,
  nameOf: (id: string | null) => string,
) {
  const v: OrgView | undefined = snap.organizations.find((o) => o.id === orgId);
  if (!v || v.scope !== "universe") return;
  const base = { orgSlug: v.slug, entity: v.name, matchKeys: [] as string[], citations: [] };
  const d = (
    fieldId: string,
    key: string,
    label: string,
    value: unknown,
    recordIds: string[],
    note: string | null = null,
    kind: InventoryItem["kind"] = "derived",
  ) =>
    add({
      ...base,
      claimId: `${card}:${fieldId}:${kind}:${v.slug}:${key}`,
      fieldId,
      kind,
      label,
      value: compact(value),
      recordIds,
      publishes: true,
      note,
    });

  d(
    "X08",
    "market",
    "market status label",
    v.marketStatus,
    v.listing.assertionIds,
    v.marketStatus === "private"
      ? "derived from the absence of a verified listing plus an identity ledger entry"
      : null,
  );
  d(
    "X08",
    "ownership",
    "ownership label",
    {
      status: v.ownership.status,
      parent: v.ownership.parentId ? nameOf(v.ownership.parentId) : null,
      since: v.ownership.since,
      parentIsForeign: v.ownership.parentIsForeign,
      parentState: v.ownership.parentState,
    },
    v.ownership.assertionIds,
  );
  d(
    "X08",
    "operating",
    "operating label",
    v.operating,
    snap.acquisitions.filter((q) => q.targetId === orgId).map((q) => q.id),
    v.operating === "operating" ? "derived from the absence of a published acquisition" : null,
  );

  const rounds = snap.rounds.filter((r) => r.companyId === orgId && r.verification === "verified");
  if (v.financing && rounds.length) {
    d(
      "X01",
      "total",
      "disclosed capital total",
      v.financing.totals,
      rounds.map((r) => r.id),
    );
    d(
      "X02",
      "count",
      "rounds with disclosed amounts",
      `${v.financing.roundsWithResolvedAmount} of ${v.financing.roundsKnown}`,
      rounds.map((r) => r.id),
    );
    d(
      "X03",
      "latest",
      "latest round",
      { stage: v.financing.latestStage, date: v.financing.latestRoundDate },
      rounds.map((r) => r.id),
    );
    if (v.financing.flags.length)
      d(
        "X01",
        "flags",
        "financing flags",
        v.financing.flags,
        rounds.map((r) => r.id),
      );
    const investors = new Map<string, { role: string; vehicle: string | null }>();
    for (const r of rounds)
      for (const p of r.participants) {
        const prev = investors.get(p.investorId);
        if (!prev || p.role === "lead")
          investors.set(p.investorId, { role: p.role, vehicle: p.vehicleId });
      }
    d(
      "X09",
      "investors",
      "investor list across rounds",
      [...investors].map(
        ([id, i]) =>
          `${nameOf(id)}${i.role === "lead" ? " (lead)" : ""}${i.vehicle ? ` via ${nameOf(i.vehicle)}` : ""}`,
      ),
      rounds.map((r) => r.id),
    );
  } else
    d(
      "C01",
      "none",
      "financing section",
      v.research.financing?.state === "not_researched"
        ? "Not yet researched"
        : `Not found in reviewed sources (as of ${v.research.financing?.lastAt ?? "?"})`,
      [],
      null,
      "absence",
    );

  const proc = attributableCad(snap, orgId, "procurement");
  const grants = attributableCad(snap, orgId, "grant_contribution");
  const other = snap.agreements.filter(
    (g) => g.family === "other_transfer" && g.attributions.some((a) => a.orgId === orgId),
  );
  if (proc.count + grants.count + other.length) {
    d("X04", "count", "procurement contract count", proc.count, proc.ids);
    d(
      "X05",
      "attributable",
      "attributable CAD contract value",
      { totalCad: proc.total, contractsCounted: proc.counted },
      proc.ids,
    );
    d(
      "X06",
      "grants",
      "grants and contributions count and CAD value",
      { count: grants.count, totalCad: grants.total, counted: grants.counted },
      grants.ids,
    );
    if (other.length)
      d(
        "E03",
        "count",
        "other transfer payments count",
        other.length,
        other.map((g) => g.id),
      );
  } else
    d(
      "E01",
      "none",
      "government relationships section",
      v.research.agreements?.state === "not_researched"
        ? "Not yet researched"
        : `Not found in reviewed sources (as of ${v.research.agreements?.lastAt ?? "?"})`,
      [],
      null,
      "absence",
    );

  for (const e of snap.graph.lenses.contracts.edges.filter((x) => x.target === orgId))
    d(
      "X07",
      e.id,
      "Government network line",
      {
        counterparty: nameOf(e.source),
        kind: e.kind,
        records: e.recordIds.length,
        maxCad: e.valueCad,
        drawnAtOverview:
          e.kind === "procurement"
            ? (e.valueCad ?? 0) >= snap.meta.thresholdCad
            : "bundled by sector",
        style: e.style,
      },
      e.recordIds,
    );
  for (const e of snap.graph.lenses.capital.edges.filter((x) => x.target === orgId))
    d(
      "C03",
      e.id,
      "Capital network line",
      { investor: nameOf(e.source), rounds: e.recordIds.length, style: e.style },
      e.recordIds,
    );

  for (const [key, fact, field] of [
    ["legalName", v.legalName, "A02"],
    ["hq", v.hq, "A06"],
    ["founded", v.founded, "A08"],
    ["description", v.description, "A10"],
    ["segment", v.segment, "B01"],
  ] as const)
    if (fact.state !== "verified")
      d(
        field,
        key,
        `${key} display state`,
        fact.state === "not_found"
          ? `Not found in reviewed sources (as of ${fact.asOf ?? "?"})`
          : fact.state,
        fact.assertionIds,
        fact.state === "unconfirmed"
          ? "a record exists but fails the evidence rule even if approved"
          : null,
        "absence",
      );
  if (!v.ownership.parentId && v.ownership.parentState && v.ownership.parentState !== "verified")
    d(
      "A12",
      "parent",
      "parent company display state",
      v.ownership.parentState,
      [],
      null,
      "absence",
    );

  const sameSub = snap.organizations
    .filter(
      (c) =>
        c.scope === "universe" &&
        c.kind === "company" &&
        c.id !== orgId &&
        c.segment.value?.id === v.segment.value?.id,
    )
    .map((c) => c.name)
    .slice(0, 8);
  d(
    "B01",
    "related",
    "dossier 'Same subsector' list (depends on the whole dataset)",
    sameSub,
    v.segment.assertionIds,
  );
}

// ---- Leak check ------------------------------------------------------------------------------

export interface LeakHit {
  file: string;
  token: string;
  claimId: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

/**
 * True when `needle` occurs in `hay` as a whole word or phrase, not glued to other letters or digits.
 * Plain substring matching flagged the investor "OMERS" inside "customers" in every prompt.
 */
function containsWhole(hay: string, needle: string): boolean {
  const glued = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  for (let from = 0; ;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    if (!glued(hay[i - 1]) && !glued(hay[i + needle.length])) return true;
    from = i + 1;
  }
}

/**
 * Every inventory value token must be absent from the shareable files, except allow-listed text
 * (card names and websites, taxonomy labels, generic program names named in the method notes).
 * Amounts and identifiers are compared by their digits so formatting cannot hide a leak.
 */
export function leakCheck(
  files: { file: string; text: string }[],
  inv: Inventory,
  allow: string[],
  allowDigits: string[] = [],
): LeakHit[] {
  const allowed = allow.map(norm);
  const digitsAllowed = new Set(
    allowDigits.map((d) => digitsKey(d)).filter((x): x is string => !!x),
  );
  const isAllowed = (t: string) => allowed.some((a) => a.includes(norm(t)));
  const hits: LeakHit[] = [];
  for (const { file, text } of files) {
    const body = norm(text);
    const numbers = new Set(
      (text.match(/\d[\d,.\s]{3,}\d/g) ?? [])
        .map((n) => digitsKey(n))
        .filter((x): x is string => !!x),
    );
    const seen = new Set<string>();
    for (const { token, claimId } of inv.leakTokens) {
      if (seen.has(token) || isAllowed(token)) continue;
      const digits = /^[\d,.\s$A-Z]*$/i.test(token) && /\d/.test(token) ? digitsKey(token) : null;
      if (digits && digitsAllowed.has(digits)) continue;
      const found = digits
        ? numbers.has(digits)
        : token.length >= 4 && /[a-z]/i.test(token) && containsWhole(body, norm(token));
      if (found) {
        seen.add(token);
        hits.push({ file, token, claimId });
      }
    }
    for (const it of inv.items)
      for (const c of it.citations)
        if (c.url && !isAllowed(c.url) && body.includes(norm(c.url)) && !seen.has(c.url)) {
          seen.add(c.url);
          hits.push({ file, token: c.url, claimId: it.claimId });
        }
  }
  return hits;
}

// ---- Reconciliation worksheet -----------------------------------------------------------------

/** How the candidates compare with the claim, before anyone reads a source (triage only). */
export type Signal =
  | "consistent" // an independent, usable finding contains the claim's key value
  | "inconsistent" // independent usable findings exist for the field, none contains it
  | "no_candidate" // no independent usable finding
  | "not_compared"; // the claim has no simple key value (rationales, ledger, labels)

/**
 * The key value of a claim that a supporting finding should mention: a legal name, a city, a
 * year, a registry number, a ticker, a taxonomy ID, an amount or an investor name. Amounts and
 * numbers compare by digits, names by letters and digits only.
 */
export function signalTokens(it: InventoryItem): string[] {
  if (it.kind !== "base") return [];
  let v: unknown;
  try {
    v = JSON.parse(it.value);
  } catch {
    v = it.value;
  }
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" ? x : null);
  switch (it.fieldId) {
    case "A01":
    case "A02":
    case "A03":
      return [idKey(String(v))];
    case "A04":
    case "A05":
      return [digitsKey(String(o.value ?? v)) ?? idKey(String(o.value ?? v))];
    case "A06":
    case "A07":
      return [idKey(str(o.city) ?? str(o.province) ?? "")].filter((k) => k.length >= 2);
    case "A08":
      return [String(v)];
    case "A11":
      return [idKey(str(o.ticker) ?? "")].filter(Boolean);
    case "A12":
      return [idKey(it.value.replace(/\s*\(org_[^)]*\)$/, ""))];
    case "B01":
    case "B02":
      return [idKey(String(v))];
    case "D01":
      // A department's own name needs no outside check (and datasets write it as a code).
      return it.label.startsWith("contextual organization") && o.kind !== "government_body"
        ? [idKey(str(o.name) ?? "")]
        : [];
    case "C03":
      return it.matchKeys.filter((k) => !/\d/.test(k) && !k.startsWith("~"));
    case "C02":
    case "E01":
    case "E02":
    case "E03":
      return it.matchKeys.filter((k) => /^(\d+|~\d+e-?\d+)$/.test(k));
    default:
      return [];
  }
}

export interface WorksheetRow {
  claimId: string;
  card: string;
  fieldId: string;
  kind: InventoryItem["kind"];
  entity: string;
  label: string;
  value: string;
  valueHash: string;
  candidates: {
    /** False when the finding has an evidence problem and can never support an outcome. */
    usable: boolean;
    /** False when the researcher was exposed to CANDEF material for this card (not blind). */
    independent: boolean;
    researcher: string;
    findingId: string;
    status: string;
    claim: string;
    origins: string[];
    sameAsCandefSource: boolean;
    score: number;
  }[];
  distinctIndependentOrigins: number;
  signal: Signal;
  outcome: Outcome;
  evaluation: string | null;
}

export interface Worksheet {
  generatedAt: string;
  inventoryGeneratedAt: string;
  packages: { researcher: string; card: string; findings: number }[];
  rows: WorksheetRow[];
  newFindings: {
    researcher: string;
    card: string;
    findingId: string;
    fieldId: string;
    claim: string;
    origins: string[];
  }[];
}

/** Same document, whatever the scheme, `www.`, trailing slash, fragment or tracking query. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Everything a finding says, flattened, for identifier, amount, date and name alignment. */
function findingText(f: BlindFinding): string {
  return [
    f.claim,
    JSON.stringify(f.value ?? null),
    JSON.stringify(f.identifiers ?? []),
    JSON.stringify(f.money ?? []),
    JSON.stringify(f.dates ?? {}),
    f.counterparty ? JSON.stringify(f.counterparty) : "",
    ...f.sources.map((s) => s.locator),
  ].join(" ");
}

/**
 * Alignment keys of a finding: identifier-like tokens (letters and digits, for example a
 * procurement ID or agreement number), amounts by their digits, and year-months. Researchers put
 * these in different places (identifiers, money, the claim, the locator), so all are read.
 */
function findingKeys(f: BlindFinding): Set<string> {
  const text = findingText(f);
  const out = new Set<string>();
  for (const t of text.match(/[A-Za-z0-9][A-Za-z0-9\-/.]{3,}[A-Za-z0-9]/g) ?? [])
    if (/\d/.test(t)) {
      const k = idKey(t);
      if (k.length >= 5) out.add(k);
      const dk = digitsKey(t);
      if (dk) out.add(dk);
    }
  for (const n of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const dk = digitsKey(n);
    if (dk) out.add(dk);
  }
  for (const d of text.match(/\b(?:19|20)\d{2}-\d{2}\b/g) ?? []) out.add(d);
  for (const n of amountsInText(text)) {
    const k = sigKey(n);
    if (k) out.add(k);
  }
  return out;
}

/** Name keys (no digits) match when the finding's flattened text contains them. */
const nameKey = (k: string) => !/\d/.test(k) && k.length >= 5;

export function buildWorksheet(
  inv: Inventory,
  packages: ResearcherPackage[],
  /** Per researcher and card, finding IDs that cannot support an outcome (`packageIssues`). */
  unusable: Map<string, Set<string>> = new Map(),
  /** `researcher|card` pairs that were exposed to CANDEF material: their findings are not independent. */
  exposed: Set<string> = new Set(),
): Worksheet {
  const linked = new Set<string>();
  const rows: WorksheetRow[] = inv.items.map((it) => {
    const candefOrigins = new Set(
      it.citations.map((c) => (c.url ? originOf(c.url) : "")).filter(Boolean),
    );
    const candidates: WorksheetRow["candidates"] = [];
    for (const pkg of packages) {
      if (pkg.company.card_id !== it.card) continue;
      for (const f of pkg.findings) {
        const sameGroup = groupOf(f.field_id) === groupOf(it.fieldId) || f.field_id === it.fieldId;
        if (!sameGroup) continue;
        let score = f.field_id === it.fieldId ? 1 : 0;
        if (EVENT_FIELDS.has(it.fieldId) || EVENT_FIELDS.has(f.field_id)) {
          const keys = findingKeys(f);
          const text = idKey(findingText(f));
          const overlap = it.matchKeys.filter((k) =>
            nameKey(k) ? text.includes(k) : keys.has(k),
          ).length;
          score = overlap ? 1 + overlap * 2 : 0;
        }
        if (score <= 0) continue;
        const origins = [...new Set(f.sources.map((s) => originOf(s.url)))];
        candidates.push({
          usable: !unusable.get(`${pkg.researcher.id}|${pkg.company.card_id}`)?.has(f.finding_id),
          independent: !exposed.has(`${pkg.researcher.id}|${pkg.company.card_id}`),
          researcher: pkg.researcher.id,
          findingId: f.finding_id,
          status: f.status,
          claim: f.claim,
          origins,
          sameAsCandefSource: origins.some((o) => candefOrigins.has(o)),
          score,
        });
        linked.add(`${pkg.researcher.id}|${pkg.company.card_id}|${f.finding_id}`);
      }
    }
    if (it.fieldId.startsWith("X"))
      for (const pkg of packages)
        if (pkg.company.card_id === it.card)
          for (const d of pkg.derived ?? [])
            if (d.field_id === it.fieldId)
              candidates.push({
                usable: true,
                independent: !exposed.has(`${pkg.researcher.id}|${pkg.company.card_id}`),
                researcher: pkg.researcher.id,
                findingId: `derived:${d.field_id}`,
                status: "derived",
                claim: `${JSON.stringify(d.value)} (${d.computation})`,
                origins: [],
                sameAsCandefSource: false,
                score: 1,
              });
    candidates.sort((a, b) => b.score - a.score);
    const tokens = signalTokens(it).filter((t) => t && t.length >= 2);
    // A contextual organization (investor, department, parent) is named in findings of any field.
    const comparable =
      it.fieldId === "D01"
        ? packages
            .filter(
              (p) => p.company.card_id === it.card && !exposed.has(`${p.researcher.id}|${it.card}`),
            )
            .flatMap((p) =>
              p.findings
                .filter(
                  (f) =>
                    (f.status === "found" || f.status === "contradictory") &&
                    !unusable.get(`${p.researcher.id}|${it.card}`)?.has(f.finding_id),
                )
                .map((f) => ({ researcher: p.researcher.id, findingId: f.finding_id })),
            )
        : candidates.filter(
            (c) =>
              c.usable && c.independent && (c.status === "found" || c.status === "contradictory"),
          );
    const texts = new Map<string, { text: string; keys: Set<string> }>();
    for (const pkg of packages)
      if (pkg.company.card_id === it.card)
        for (const f of pkg.findings)
          texts.set(`${pkg.researcher.id}|${f.finding_id}`, {
            text: idKey(findingText(f)),
            keys: findingKeys(f),
          });
    // Amounts compare as parsed numbers (exact digits or rounded key); names and IDs as text.
    const mentions = (c: { researcher: string; findingId: string }, t: string) => {
      const f = texts.get(`${c.researcher}|${c.findingId}`);
      if (!f) return false;
      return /^(\d{5,}|~\d+e-?\d+)$/.test(t) ? f.keys.has(t) : f.text.includes(t);
    };
    const signal: Signal = !tokens.length
      ? "not_compared"
      : !comparable.length
        ? "no_candidate"
        : comparable.some((c) => tokens.some((t) => mentions(c, t)))
          ? "consistent"
          : "inconsistent";
    const independent = new Set(
      candidates.flatMap((c) => c.origins).filter((o) => !candefOrigins.has(o)),
    );
    return {
      claimId: it.claimId,
      card: it.card,
      fieldId: it.fieldId,
      kind: it.kind,
      entity: it.entity,
      label: it.label,
      value: it.value,
      valueHash: it.valueHash,
      candidates,
      distinctIndependentOrigins: independent.size,
      signal,
      outcome: "not_yet_evaluated",
      evaluation: null,
    };
  });
  const newFindings = packages.flatMap((pkg) =>
    pkg.findings
      .filter(
        (f) =>
          !linked.has(`${pkg.researcher.id}|${pkg.company.card_id}|${f.finding_id}`) &&
          (f.status === "found" || f.status === "contradictory"),
      )
      .map((f) => ({
        researcher: pkg.researcher.id,
        card: pkg.company.card_id,
        findingId: f.finding_id,
        fieldId: f.field_id,
        claim: f.claim,
        origins: [...new Set(f.sources.map((s) => originOf(s.url)))],
      })),
  );
  return {
    generatedAt: new Date().toISOString(),
    inventoryGeneratedAt: inv.generatedAt,
    packages: packages.map((p) => ({
      researcher: p.researcher.id,
      card: p.company.card_id,
      findings: p.findings.length,
    })),
    rows,
    newFindings,
  };
}

// ---- Evaluations (persist across worksheet runs) ------------------------------------------------

/**
 * Claude's primary-source evaluations (RECONCILIATION_PLAN.md section 5.3), kept apart from the
 * generated worksheet so that re-running `worksheet` never loses them. Each is bound to the claim's
 * `valueHash`: when the claim changes, the evaluation is shown as stale and the outcome resets.
 * Lives in gitignored research-cache/ (it can name the passages read).
 */
export const Evaluation = z.object({
  outcome: z.enum(OUTCOMES),
  valueHash: z.string(),
  at: z.string(),
  /** What was read and found, in Claude's words (no quotations). */
  note: z.string(),
  sourcesRead: z.array(z.object({ ref: z.string(), locator: z.string() })),
  /** Corroboration from a different document (independent origin) or the same document CANDEF cites. */
  basis: z.enum(["independent_origin", "same_document", "none"]).default("none"),
  /** For contradicted or partial: the proposed correction (a proposal, never applied). */
  proposal: z.string().nullable().default(null),
});
export type Evaluation = z.infer<typeof Evaluation>;
export const EvaluationsFile = z.object({
  version: z.literal(1),
  evaluations: z.record(z.string(), Evaluation),
});
export type EvaluationsFile = z.infer<typeof EvaluationsFile>;

/** Applies saved evaluations to a freshly built worksheet (in place); returns the stale claim IDs. */
export function applyEvaluations(ws: Worksheet, file: EvaluationsFile): string[] {
  const stale: string[] = [];
  for (const row of ws.rows) {
    const e = file.evaluations[row.claimId];
    if (!e) continue;
    if (e.valueHash !== row.valueHash) {
      stale.push(row.claimId);
      row.evaluation = `STALE (claim changed since ${e.at}): ${e.outcome}. ${e.note}`;
      continue;
    }
    row.outcome = e.outcome;
    row.evaluation = e.note;
  }
  return stale;
}

// ---- Corroboration input for tier 2 (VERIFICATION_TIERS.md T2-e, T2-f) -------------------------

/**
 * Researcher sessions that are one researcher for corroboration purposes (the owner's second
 * Perplexity run continues the first). Corroboration counts origins anyway.
 */
export const SAME_RESEARCHER: Readonly<Record<string, string>> = {
  "R-perplexity-r2": "R-PerplexityComputer-20261014-01",
};
export const researcherKey = (id: string) => SAME_RESEARCHER[id] ?? id;

export interface ClaimSignal {
  claimId: string;
  fieldId: string;
  signal: Signal;
  /** The claim's value changed since the worksheet was built: its signal no longer applies. */
  stale: boolean;
  /** An independent, usable finding marked `contradictory` for this claim. */
  contradictory: boolean;
  /** Distinct independent researchers (merged per SAME_RESEARCHER) with a usable found finding. */
  researchers: string[];
  /** Distinct source origins of those findings. */
  origins: string[];
}

/**
 * Per record ID, the worksheet signals of every base claim about it. `current` maps claim IDs to
 * the current inventory's value hashes, so a claim edited since the worksheet is marked stale.
 */
export function corroborationByRecord(
  ws: Worksheet,
  inventory: Inventory,
): Map<string, ClaimSignal[]> {
  const items = new Map(inventory.items.map((i) => [i.claimId, i]));
  const out = new Map<string, ClaimSignal[]>();
  for (const row of ws.rows) {
    if (row.kind !== "base") continue;
    const item = items.get(row.claimId);
    if (!item) continue;
    const usable = row.candidates.filter((c) => c.usable && c.independent);
    const found = usable.filter((c) => c.status === "found" || c.status === "contradictory");
    const signal: ClaimSignal = {
      claimId: row.claimId,
      fieldId: row.fieldId,
      signal: row.signal,
      stale: item.valueHash !== row.valueHash,
      contradictory: usable.some((c) => c.status === "contradictory"),
      researchers: [...new Set(found.map((c) => researcherKey(c.researcher)))].sort(),
      origins: [...new Set(found.flatMap((c) => c.origins))].sort(),
    };
    // A participant claim is about `round#pN`; the round unit also collects it.
    for (const id of new Set(item.recordIds.map((r) => r.replace(/#p\d+$/, "")))) {
      const list = out.get(id) ?? [];
      list.push(signal);
      out.set(id, list);
    }
  }
  return out;
}
