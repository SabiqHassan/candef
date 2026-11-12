/**
 * The time view (docs/TIME_VIEW.md): when each relationship line's records happened, and the
 * filter that shows the network as of a year. Pure functions shared by the compiler (which writes
 * a timeline on every single relationship) and the explorer (which filters by it).
 *
 * Honesty rules:
 * - Dates are the recorded partial ISO dates ("2019", "2019-05", "2019-05-14"); nothing is
 *   estimated. Filtering works at year precision, so a year-only date is never over-interpreted.
 * - A record without the date a mode needs is never placed in time: it is left out and counted
 *   (`undated`, `noEnd`), so the page can say how much is not shown.
 * - Bundles are recomputed from their surviving member relationships, so line thickness always
 *   means "relationships documented in the selected time", never the all-time count.
 */
import type { AgreementView, GraphEdgeView, RoundView, TimelineEntry } from "./schema/snapshot";

/** "began": relationships that started in or before the year. "active": running during the year. */
export type TimeMode = "began" | "active";

export interface TimeFilter {
  mode: TimeMode;
  year: number;
}

export type EntryStatus = "in" | "out" | "undated" | "no_end";

/** The calendar year of a partial ISO date, or null. */
export function yearOf(date: string | null | undefined): number | null {
  const m = date ? /^(\d{4})(?:-|$)/.exec(date) : null;
  return m ? Number(m[1]) : null;
}

function earliest(dates: (string | null | undefined)[]): string | null {
  const known = dates.filter((d): d is string => !!d && yearOf(d) !== null);
  // Partial ISO dates of the same year order correctly as strings; across precisions the year
  // decides, which is all the filter uses.
  return known.length ? known.reduce((a, b) => (b < a ? b : a)) : null;
}

function latest(dates: (string | null | undefined)[]): string | null {
  const known = dates.filter((d): d is string => !!d && yearOf(d) !== null);
  return known.length ? known.reduce((a, b) => (b > a ? b : a)) : null;
}

/**
 * One investor's entry for a round: the date of the tranche(s) the source says it joined, else the
 * round's first disclosure. An investor that joined only a later extension is not dated to the
 * first close.
 */
export function roundEntry(
  round: RoundView,
  investorId: string,
  style: TimelineEntry["style"],
): TimelineEntry {
  const participant = round.participants.find((p) => p.investorId === investorId);
  const linked = new Set(participant?.disclosureIds ?? []);
  const tranche = earliest(round.disclosures.filter((d) => linked.has(d.id)).map((d) => d.date));
  return {
    recordId: round.id,
    companyId: round.companyId,
    start: tranche ?? earliest(round.disclosures.map((d) => d.date)),
    end: null,
    kind: "event",
    style,
    valueCad: null,
  };
}

/** Latest disclosed end date across an agreement's disclosure rows, or null. */
export function agreementEnd(rows: { endOnAsStated: string | null }[]): string | null {
  return latest(rows.map((r) => r.endOnAsStated));
}

/** An agreement's entry: disclosed start (else announcement) to the latest disclosed end date. */
export function agreementEntry(
  agreement: AgreementView,
  companyId: string,
  style: TimelineEntry["style"],
): TimelineEntry {
  return {
    recordId: agreement.id,
    companyId,
    start: earliest([agreement.startOn, agreement.announcedOn]),
    end: agreementEnd(agreement.rows),
    kind: "period",
    style,
    valueCad: agreement.family === "procurement" ? (agreement.thresholdValueCad ?? 0) : null,
  };
}

export function entryStatus(entry: TimelineEntry, filter: TimeFilter): EntryStatus {
  const start = yearOf(entry.start);
  if (start === null) return "undated";
  if (filter.mode === "began") return start <= filter.year ? "in" : "out";
  if (entry.kind === "event") return start === filter.year ? "in" : "out";
  if (start > filter.year) return "out";
  const end = yearOf(entry.end);
  if (end === null) return "no_end";
  return end >= filter.year ? "in" : "out";
}

export interface TimeStats {
  /** Distinct records shown. */
  shown: number;
  /** Distinct records left out because they have no start date. */
  undated: number;
  /** Distinct agreements left out of "active" because no end date is disclosed. */
  noEnd: number;
  /** Distinct records outside the selected time. */
  outside: number;
}

/**
 * The relationship lines of one lens as of a time filter. Returns the input unchanged (and no
 * stats) when there is no filter. Lines without a timeline (older snapshots) count as undated.
 */
export function applyTimeFilter(
  edges: GraphEdgeView[],
  filter: TimeFilter | null,
  /** False when grants are hidden: their records are then not counted in the stats either. */
  countGrants = true,
): { edges: GraphEdgeView[]; stats: TimeStats | null } {
  if (!filter) return { edges, stats: null };
  const status = new Map<string, EntryStatus>();
  // A record can sit on several lines (one per investor) with different tranche dates: it counts as
  // shown if it is shown anywhere, and is otherwise reported by its most specific reason.
  const rank: Record<EntryStatus, number> = { in: 3, no_end: 2, undated: 1, out: 0 };
  let counting = true;
  const note = (id: string, s: EntryStatus) => {
    if (!counting) return;
    const prev = status.get(id);
    if (prev === undefined || rank[s] > rank[prev]) status.set(id, s);
  };

  const single = new Map<string, GraphEdgeView>();
  for (const e of edges) {
    if (e.kind === "bundle") continue;
    counting = countGrants || e.kind !== "grant";
    if (!e.timeline) {
      for (const id of e.recordIds) note(id, "undated");
      continue;
    }
    const kept: TimelineEntry[] = [];
    for (const entry of e.timeline) {
      const s = entryStatus(entry, filter);
      note(entry.recordId, s);
      if (s === "in") kept.push(entry);
    }
    if (!kept.length) continue;
    const recordIds = [...new Set(kept.map((k) => k.recordId))];
    single.set(e.id, {
      ...e,
      recordIds,
      weight: recordIds.length,
      style: kept.some((k) => k.style === "dashed") ? "dashed" : "solid",
      valueCad: e.valueCad === null ? null : Math.max(0, ...kept.map((k) => k.valueCad ?? 0)),
      timeline: kept,
    });
  }

  const out: GraphEdgeView[] = [];
  for (const e of edges) {
    if (e.kind !== "bundle") {
      const kept = single.get(e.id);
      if (kept) out.push(kept);
      continue;
    }
    const members = (e.memberEdgeIds ?? [])
      .map((id) => single.get(id))
      .filter((m): m is GraphEdgeView => !!m);
    if (!members.length) continue;
    out.push({
      ...e,
      recordIds: [...new Set(members.flatMap((m) => m.recordIds))],
      memberEdgeIds: members.map((m) => m.id),
      weight: members.length,
      valueCad: e.valueCad === null ? null : Math.max(0, ...members.map((m) => m.valueCad ?? 0)),
    });
  }

  const stats: TimeStats = { shown: 0, undated: 0, noEnd: 0, outside: 0 };
  for (const s of status.values()) {
    if (s === "in") stats.shown++;
    else if (s === "undated") stats.undated++;
    else if (s === "no_end") stats.noEnd++;
    else stats.outside++;
  }
  return { edges: out, stats };
}

/** First and last year the filter offers: earliest dated record to the later of the last record and the build year. */
export function timeExtent(
  edges: GraphEdgeView[],
  builtAt: string,
): { min: number; max: number } | null {
  const years = edges
    .flatMap((e) => e.timeline ?? [])
    .map((t) => yearOf(t.start))
    .filter((y): y is number => y !== null);
  if (!years.length) return null;
  const built = yearOf(builtAt) ?? Math.max(...years);
  return { min: Math.min(...years), max: Math.max(built, ...years) };
}

/** Plain-language description of a filter, for headings, status lines and screen readers. */
export function describeTimeFilter(filter: TimeFilter): string {
  return filter.mode === "began"
    ? `relationships that began by the end of ${filter.year}`
    : `relationships active during ${filter.year}`;
}
