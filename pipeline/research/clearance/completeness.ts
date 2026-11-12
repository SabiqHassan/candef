/**
 * Completeness of event inventories (policy section 6).
 *
 * Accuracy checks ask "is each recorded event right?". Completeness asks "is any event missing?".
 * Agreement on an incomplete list proves nothing, so each researcher's event list is compared with
 * CANDEF's, event by event:
 * - an event CANDEF has and a researcher also lists: matched;
 * - an event a researcher lists and CANDEF does not: a lead, which becomes a targeted check
 *   (never an owner decision on its own);
 * - with two independent inventories, the overlap gives a rough estimate of how many events
 *   nobody found (Chapman's capture-recapture estimate). It assumes the researchers search
 *   independently; when both read the same press page it underestimates, so it is an indicator,
 *   never a proof of completeness.
 *
 * Government agreements have an original oracle: the federal datasets themselves. Their
 * completeness comes from the importer (every row with the company's anchored identity), not from
 * researchers; researcher-only agreements are leads for other sources (provincial, foreign).
 */
import type { Corpus } from "../../../src/domain/schema/corpus";
import type { BlindCard, ResearcherPackage } from "../blind";
import { amountsInText, sigKey } from "../blind";
import { INACTIVE } from "../../compile/facts";
import { nameKey as govNameKey } from "../names";
import { entityNames } from "./checks";

export interface EventKey {
  /** Year-month or year of the event, when known. */
  when: string | null;
  /** Rounded amount keys (3 significant digits) of the amounts stated for the event. */
  amounts: string[];
  label: string;
}

export interface ResearcherEvent extends EventKey {
  researcher: string;
  findingId: string;
  claim: string;
  origins: string[];
}

export interface CategoryCompleteness {
  category: "financing" | "acquisitions" | "government";
  candef: number;
  /** Per independent researcher: events listed, and how many match a CANDEF event. */
  inventories: { researcher: string; listed: number; matched: number }[];
  /** Researcher events with no CANDEF counterpart (deduplicated across researchers). */
  leads: ResearcherEvent[];
  /** Events researchers filed under another entity (predecessor, acquired company): context only. */
  otherEntityEvents: number;
  /** Chapman estimate of the total from two independent inventories; null when not computable. */
  estimate: { total: number; basis: string } | null;
  status:
    | "no-independent-inventory" // nobody independent listed events: completeness unknown
    | "gaps-pending" // researchers found events CANDEF lacks: targeted checks queued
    | "no-gap-found-1" // one independent inventory, nothing extra (weak)
    | "no-gap-found-2" // two or more independent inventories, nothing extra
    | "dataset-oracle"; // government rows: completeness comes from the datasets
  note: string;
}

const ym = (d: string | null | undefined) =>
  d && /^\d{4}(-\d{2})?/.test(d) ? d.slice(0, 7) : null;

function eventsOf(
  pkg: ResearcherPackage,
  fields: string[],
  isOurs: (entityName: string | null) => boolean,
): { events: ResearcherEvent[]; otherEntity: number } {
  const found = pkg.findings.filter((f) => fields.includes(f.field_id) && f.status === "found");
  const entityName = (id: string | null | undefined) =>
    id ? (pkg.entities.find((e) => e.entity_id === id)?.legal_name ?? null) : null;
  const keyOf = (f: (typeof found)[number]): EventKey => {
    const dates = Object.values(f.dates ?? {}).filter(Boolean) as string[];
    const money = (f.money ?? []).map((m) => m.amount).filter(Boolean) as string[];
    const amounts = new Set<string>();
    for (const a of money) {
      const k = sigKey(Number(a));
      if (k) amounts.add(k);
    }
    if (!money.length)
      for (const n of amountsInText(f.claim)) {
        const k = sigKey(n);
        if (k) amounts.add(k);
      }
    const year = f.claim.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
    return {
      when: ym(dates.sort()[0]) ?? year,
      amounts: [...amounts],
      label: f.claim.slice(0, 80),
    };
  };
  // Events are the event findings (C01, A15); a disclosure (C02) joins the event it links to, or
  // an event of the same year without an amount, and stands alone only when there is none.
  type Ev = ResearcherEvent & { entity: string | null };
  const heads = found.filter((f) => f.field_id !== "C02");
  const events: Ev[] = heads.map((f) => ({
    ...keyOf(f),
    researcher: pkg.researcher.id,
    findingId: f.finding_id,
    claim: f.claim,
    origins: [...new Set(f.sources.map((s) => s.url))],
    entity: entityName(f.entity_id),
  }));
  for (const d of found.filter((f) => f.field_id === "C02")) {
    const k = keyOf(d);
    const target =
      events.find((e) => (d.links_to ?? []).includes(e.findingId)) ??
      events.find(
        (e) => !e.amounts.length && e.when && k.when && e.when.slice(0, 4) === k.when.slice(0, 4),
      );
    if (target) {
      target.amounts = [...new Set([...target.amounts, ...k.amounts])];
      target.when = target.when ?? k.when;
    } else
      events.push({
        ...k,
        researcher: pkg.researcher.id,
        findingId: d.finding_id,
        claim: d.claim,
        origins: [...new Set(d.sources.map((s) => s.url))],
        entity: entityName(d.entity_id),
      });
  }
  // Merge a researcher's own duplicates (an event stated twice).
  const merged: Ev[] = [];
  for (const e of events) if (!merged.some((m) => sameEvent(m, e))) merged.push(e);
  const ours = merged.filter((e) => isOurs(e.entity));
  return { events: ours, otherEntity: merged.length - ours.length };
}

/** Two events are the same when an amount matches; without amounts, when the dates agree at the
 * precision both have (a year-only date meets any month of that year). */
export function sameEvent(a: EventKey, b: EventKey): boolean {
  if (a.amounts.length && b.amounts.length) return a.amounts.some((k) => b.amounts.includes(k));
  if (!a.when || !b.when) return false;
  const n = Math.min(a.when.length, b.when.length) >= 7 ? 7 : 4;
  return a.when.slice(0, n) === b.when.slice(0, n);
}

function roundKeys(corpus: Corpus, orgIds: Set<string>): EventKey[] {
  return corpus.rounds
    .filter((r) => orgIds.has(r.companyId) && !INACTIVE.has(r.verification))
    .map((r) => {
      const amounts = new Set<string>();
      for (const d of r.disclosures) {
        const k = d.amount.amount ? sigKey(Number(d.amount.amount)) : null;
        if (k) amounts.add(k);
      }
      return {
        when: ym([...r.disclosures.map((d) => d.date)].sort()[0]),
        amounts: [...amounts],
        label: r.roundLabelAsStated ?? r.id,
      };
    });
}

function acquisitionKeys(corpus: Corpus, orgIds: Set<string>): EventKey[] {
  return corpus.acquisitions
    .filter(
      (q) => (orgIds.has(q.targetId) || orgIds.has(q.acquirerId)) && !INACTIVE.has(q.verification),
    )
    .map((q) => ({
      when: ym([...q.history.map((h) => h.date)].sort()[0]),
      amounts: [],
      label: q.id,
    }));
}

/** Chapman's estimator N = (n1+1)(n2+1)/(m+1) - 1 for two independent inventories. */
export function chapman(n1: number, n2: number, m: number): number {
  return Math.round(((n1 + 1) * (n2 + 1)) / (m + 1) - 1);
}

function compare(
  category: CategoryCompleteness["category"],
  candef: EventKey[],
  perResearcher: Map<string, ResearcherEvent[]>,
  otherEntityEvents = 0,
): CategoryCompleteness {
  const inventories = [...perResearcher.entries()].map(([researcher, evs]) => ({
    researcher,
    listed: evs.length,
    matched: evs.filter((e) => candef.some((c) => sameEvent(c, e))).length,
  }));
  const leads: ResearcherEvent[] = [];
  for (const evs of perResearcher.values())
    for (const e of evs)
      if (!candef.some((c) => sameEvent(c, e)) && !leads.some((l) => sameEvent(l, e)))
        leads.push(e);
  const listing = inventories.filter((i) => i.listed > 0);
  let estimate: CategoryCompleteness["estimate"] = null;
  if (listing.length >= 2) {
    const [a, b] = [...perResearcher.entries()].filter(([, e]) => e.length).slice(0, 2);
    const m = a![1].filter((x) => b![1].some((y) => sameEvent(x, y))).length;
    estimate = {
      total: chapman(a![1].length, b![1].length, m),
      basis: `${a![0]} listed ${a![1].length}, ${b![0]} listed ${b![1].length}, ${m} in both`,
    };
  }
  const status: CategoryCompleteness["status"] = !listing.length
    ? "no-independent-inventory"
    : leads.length
      ? "gaps-pending"
      : listing.length >= 2
        ? "no-gap-found-2"
        : "no-gap-found-1";
  const note =
    status === "no-independent-inventory"
      ? "No independent researcher listed events: completeness is unknown and shown as such."
      : status === "gaps-pending"
        ? `${leads.length} event(s) found only by a researcher: each becomes a targeted check (find and read the original) before it is recorded or dismissed.`
        : estimate && estimate.total > candef.length
          ? `No researcher listed an event CANDEF lacks, but the overlap suggests about ${estimate.total} events in total (CANDEF has ${candef.length}): treat as possibly incomplete.`
          : "No researcher listed an event CANDEF lacks. This is not proof of completeness.";
  return {
    category,
    candef: candef.length,
    inventories,
    leads,
    otherEntityEvents,
    estimate,
    status,
    note,
  };
}

export interface CardCompleteness {
  card: string;
  orgSlugs: string[];
  categories: CategoryCompleteness[];
}

export function cardCompleteness(
  corpus: Corpus,
  card: BlindCard,
  packages: ResearcherPackage[],
  independent: (researcher: string, card: string) => boolean,
  govMissing: number | null,
): CardCompleteness {
  const orgIds = new Set(
    card.orgSlugs
      .map((s) => corpus.organizations.find((o) => o.slug === s)?.id)
      .filter((x): x is string => !!x),
  );
  const mine = packages.filter(
    (p) => p.company.card_id === card.card && independent(p.researcher.id, card.card),
  );
  const keys = new Set(
    [...orgIds].flatMap((id) => entityNames(corpus, id)).map((n) => govNameKey(n)),
  );
  const isOurs = (name: string | null) => !name || keys.has(govNameKey(name));
  const finRaw = mine.map((p) => [p.researcher.id, eventsOf(p, ["C01", "C02"], isOurs)] as const);
  const acqRaw = mine.map((p) => [p.researcher.id, eventsOf(p, ["A15"], () => true)] as const);
  const fin = new Map(finRaw.map(([k, v]) => [k, v.events]));
  const acq = new Map(acqRaw.map(([k, v]) => [k, v.events]));
  const finOther = finRaw.reduce((n, [, v]) => n + v.otherEntity, 0);
  const govCount = corpus.agreements.filter(
    (g) => g.parties.some((p) => orgIds.has(p.orgId)) && !INACTIVE.has(g.verification),
  ).length;
  return {
    card: card.card,
    orgSlugs: card.orgSlugs,
    categories: [
      compare("financing", roundKeys(corpus, orgIds), fin, finOther),
      compare("acquisitions", acquisitionKeys(corpus, orgIds), acq),
      {
        category: "government",
        candef: govCount,
        inventories: [],
        leads: [],
        otherEntityEvents: 0,
        estimate: null,
        status: "dataset-oracle",
        note:
          govMissing === null
            ? "Federal rows come from the full datasets by anchored identity; no reconciliation plan was supplied, so rows the importer holds as candidates are not counted."
            : `Federal rows come from the full datasets by anchored identity; ${govMissing} row group(s) are held as name-only or candidate matches (P-50) and are not in the data. Provincial, municipal and foreign agreements are not covered by the datasets.`,
      },
    ],
  };
}
