/**
 * Field resolution: turns assertions + research ledger into display facts with an explicit state.
 * Missing information never becomes a claim that nothing exists (P-19).
 */
import type {
  Assertion,
  Corpus,
  Predicate,
  ResearchAttempt,
  ResearchTopic,
  Source,
} from "../../src/domain/schema/corpus";
import type { Fact, ResearchState } from "../../src/domain/schema/snapshot";
import { canonicalJson, hasIntactReview, hasValidReview } from "./hash";

/** Predicates that may hold only one value at a time; others are multi-valued (F-24 / §6). */
export const SINGLE_VALUED: ReadonlySet<Predicate> = new Set([
  "legal_name",
  "hq_location",
  "founded_year",
  "description",
  "eligibility",
  "public_listing",
  "subsidiary_of",
  "division_of",
  "managed_by",
]);

export const TOPIC_OF: Record<Predicate, ResearchTopic> = {
  legal_name: "identity",
  hq_location: "identity",
  founded_year: "identity",
  public_listing: "identity",
  subsidiary_of: "identity",
  predecessor_of: "identity",
  division_of: "identity",
  managed_by: "identity",
  website: "identity",
  operations_location: "identity",
  registry_id: "identity",
  total_raised_as_stated: "financing",
  description: "eligibility",
  classified_as: "eligibility",
  eligibility: "eligibility",
  role_held: "people",
};

export const INACTIVE = new Set(["superseded", "retracted", "rejected"]);

export class FactIndex {
  private bySubject = new Map<string, Assertion[]>();
  private byId = new Map<string, Assertion>();
  private research = new Map<string, ResearchAttempt[]>();
  private sources: Map<string, Source>;

  constructor(
    corpus: Corpus,
    private readonly today: string,
    /** Share build: verified assertions no supporting source allows sharing (D-21 section 8). */
    private readonly withheld: ReadonlySet<string> = new Set(),
  ) {
    for (const a of corpus.assertions) {
      this.byId.set(a.id, a);
      const list = this.bySubject.get(a.subjectId) ?? [];
      list.push(a);
      this.bySubject.set(a.subjectId, list);
    }
    for (const r of corpus.research) {
      const key = `${r.subjectId}|${r.topic}`;
      const list = this.research.get(key) ?? [];
      list.push(r);
      this.research.set(key, list);
    }
    this.sources = new Map(corpus.sources.map((s) => [s.id, s]));
  }

  /** Evidence rule per predicate (§4). Demo corpora still have to satisfy it. */
  meetsEvidenceRule(a: Assertion): boolean {
    if (a.epistemic === "sourced_fact" && a.evidence.length === 0) return false;
    const srcs = a.evidence
      .map((e) => this.sources.get(e.sourceId))
      .filter((s): s is Source => !!s);
    if (srcs.length !== a.evidence.length) return false;
    if (srcs.some((s) => s.sourceBasis === "anonymous_sources")) return false;
    if (a.evidence.every((e) => e.locatorQuality === "related_link")) return false;
    if (a.predicate === "hq_location") {
      // City-level HQ needs first-party or filing evidence; a registry establishes province only.
      const v = a.value as { city: string | null } | null;
      const firstParty = srcs.some((s) => ["company_release", "filing"].includes(s.kind));
      if (v?.city && !firstParty) return false;
    }
    return true;
  }

  publishable(a: Assertion): boolean {
    return this.verifiedValue(a) && !this.withheld.has(a.id);
  }

  private verifiedValue(a: Assertion): boolean {
    return (
      !INACTIVE.has(a.verification) && hasValidReview("assertion", a) && this.meetsEvidenceRule(a)
    );
  }

  /** A once-approved value that a newer assertion replaced: shown as history, never as current. */
  isHistory(a: Assertion): boolean {
    return (
      a.verification === "superseded" &&
      hasIntactReview("assertion", a) &&
      this.meetsEvidenceRule(a)
    );
  }

  /** Supersession chain behind a current assertion, newest first (DATA_SCHEMA §7). */
  private history<T>(current: Assertion, map: (v: unknown) => T): NonNullable<Fact<T>["history"]> {
    const out: NonNullable<Fact<T>["history"]> = [];
    const seen = new Set<string>([current.id]);
    let cur = current;
    while (cur.supersedes && !seen.has(cur.supersedes)) {
      seen.add(cur.supersedes);
      const old = this.byId.get(cur.supersedes);
      if (!old || old.subjectId !== current.subjectId || old.predicate !== current.predicate) break;
      if (this.isHistory(old))
        out.push({
          value: map(old.value),
          assertionIds: [old.id],
          asOf: old.asOf,
          replacedOn: cur.validFrom ?? cur.asOf,
        });
      cur = old;
    }
    return out;
  }

  researchState(subjectId: string, topic: ResearchTopic): ResearchState {
    const attempts = (this.research.get(`${subjectId}|${topic}`) ?? [])
      .slice()
      .sort((x, y) => (x.at < y.at ? 1 : -1));
    const latest = attempts[0];
    if (!latest) return { state: "not_researched", lastAt: null, nextReview: null, outcome: null };
    const stale = latest.nextReview !== null && latest.nextReview < this.today;
    return {
      state: stale ? "stale" : "researched",
      lastAt: latest.at,
      nextReview: latest.nextReview,
      outcome: latest.outcome,
    };
  }

  assertions(subjectId: string, predicate: Predicate): Assertion[] {
    return (this.bySubject.get(subjectId) ?? []).filter(
      (a) => a.predicate === predicate && !INACTIVE.has(a.verification),
    );
  }

  fact<T>(
    subjectId: string,
    predicate: Predicate,
    map: (v: unknown) => T = (v) => v as T,
  ): Fact<T> {
    const all = this.assertions(subjectId, predicate);
    const verified = all.filter((a) => this.publishable(a));
    // Rule (b), defect 2 (SELECTION.md): for a single-valued predicate, a value whose validTo is in
    // the past is history, not a competing current value. It is shown as "previously …" with its end
    // date. Only when every value has ended does the compiler fall back to treating them all alike.
    const ended = (a: Assertion) => a.validTo !== null && a.validTo < this.today;
    const past = SINGLE_VALUED.has(predicate) ? verified.filter(ended) : [];
    const pub =
      past.length && past.length < verified.length ? verified.filter((a) => !ended(a)) : verified;
    if (pub.length > 0) {
      const distinct = new Map<string, Assertion[]>();
      for (const a of pub) {
        const key = canonicalJson(a.value);
        distinct.set(key, [...(distinct.get(key) ?? []), a]);
      }
      const groups = [...distinct.values()];
      const first = groups[0]![0]!;
      if (SINGLE_VALUED.has(predicate) && groups.length > 1) {
        return {
          value: null,
          state: "disputed",
          epistemic: first.epistemic,
          assertionIds: pub.map((a) => a.id),
          asOf: first.asOf,
          alternatives: groups.map((g) => ({
            value: map(g[0]!.value),
            assertionIds: g.map((a) => a.id),
          })),
        };
      }
      const preferred = pub.find((a) => a.primary) ?? first;
      const history = [
        ...this.history(preferred, map),
        ...(pub === verified ? [] : past)
          .slice()
          .sort((x, y) => (x.validTo! < y.validTo! ? 1 : -1))
          .map((a) => ({
            value: map(a.value),
            assertionIds: [a.id],
            asOf: a.asOf,
            replacedOn: a.validTo,
          })),
      ];
      return {
        value: map(preferred.value),
        state: "verified",
        epistemic: preferred.epistemic,
        assertionIds: [preferred.id],
        asOf: preferred.asOf,
        ...(history.length ? { history } : {}),
      };
    }
    if (all.some((a) => this.withheld.has(a.id) && this.verifiedValue(a)))
      // Verified, but not shareable in this edition: say so rather than leave a silent gap.
      return { value: null, state: "withheld", epistemic: null, assertionIds: [], asOf: null };
    if (all.length > 0) {
      // Something was reported but is not verified: the value is withheld.
      return {
        value: null,
        state: "unconfirmed",
        epistemic: null,
        assertionIds: all.map((a) => a.id),
        asOf: null,
      };
    }
    const research = this.researchState(subjectId, TOPIC_OF[predicate]);
    return {
      value: null,
      state: research.state === "not_researched" ? "not_researched" : "not_found",
      epistemic: null,
      assertionIds: [],
      asOf: research.lastAt,
    };
  }

  /** Every publishable value of a multi-valued predicate. */
  values<T>(subjectId: string, predicate: Predicate): { value: T; assertion: Assertion }[] {
    return this.assertions(subjectId, predicate)
      .filter((a) => this.publishable(a))
      .map((a) => ({ value: a.value as T, assertion: a }));
  }
}
