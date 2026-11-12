/**
 * Risk-based routing (policy sections 3-5): every proposed review unit gets a class, the checks
 * its class needs, exactly one state, the next automated step when there is one, and, when only
 * the owner can settle it, a decision group.
 *
 * Inputs are the tiers@1 evaluation (its rule results and value checks are reused, not
 * re-implemented), a freshly built blind worksheet, the researcher packages and the dataset rows.
 * Read-only and pure: nothing here writes research/, approves or publishes.
 */
import type { Assertion, Corpus, Evidence } from "../../../src/domain/schema/corpus";
import { INACTIVE } from "../../compile/facts";
import {
  signalTokens,
  type BlindCard,
  type Inventory,
  type InventoryItem,
  type ResearcherPackage,
  type Worksheet,
} from "../blind";
import type { RawRows } from "../verifyGovClaims";
import type { TierRecord } from "../tiers/rules";
import {
  duplicateRounds,
  entityInText,
  entityNames,
  legalFormRisks,
  roundNormalization,
  rowValueCheck,
  sameSite,
  websiteOf,
  type LegalFormRisk,
} from "./checks";
import {
  AUTHORITY_WAIVES_CORROBORATION,
  DEFINITIONS,
  HOMEWORK,
  REQUIRED,
  type CheckId,
  type ClaimClass,
  type ClearanceState,
  type GroupKind,
  type HomeworkKind,
} from "./policy";
import { findingView, formOf, nameKey, relate, type ClaimView, type Relation } from "./relate";
import { matchIdentifier, matchName, matchProvince, matchYear } from "../tiers/match";
import { recordParts } from "../tiers/rules";
import { coveredByReads, type VerificationReadFile } from "../verificationRead";
import { nameKey as govNameKey } from "../names";

/** Re-runs the tiers@1 matcher of a value kind on a copy's normalized text. */
function rematch(text: string, kind: string, value: string): boolean {
  if (kind === "name" || kind === "city") return matchName(text, value).found;
  if (kind === "year") return matchYear(text, value).found;
  if (kind === "identifier") return matchIdentifier(text, value).found;
  return false;
}

export interface Check {
  id: CheckId;
  result: "pass" | "fail" | "waived" | "n/a";
  reason: string;
}
export interface RelationRow {
  claimId: string;
  fieldId: string;
  researcher: string;
  findingId: string;
  relation: Relation;
  claim: string;
  origins: string[];
  /** The finding rests on a document CANDEF itself cites (re-reading, not new evidence). */
  sameOrigin: boolean;
  /** URLs of official sources (registry, dataset, government publication, filing) it cites. */
  official: string[];
}
export interface Homework {
  kind: HomeworkKind;
  reason: string;
}
export interface ClearanceRecord {
  id: string;
  kind: TierRecord["kind"];
  orgId: string;
  orgName: string;
  predicate: string | null;
  /** Blind-research field IDs that describe this record (A02 legal name, C02 disclosure, …). */
  fields: string[];
  /** Unit hash (decisions.ts): any edit to the record changes it and voids the clearance. */
  hash: string;
  cls: ClaimClass;
  state: ClearanceState;
  /** Cleared, but only once the owner confirms the identity anchors listed (tier 1 rows). */
  conditionalOn: string[];
  checks: Check[];
  relations: RelationRow[];
  homework: Homework[];
  /** If the deterministic homework succeeded as simulated in memory, this state would follow. */
  projected: ClearanceState | null;
  group: { kind: GroupKind; key: string } | null;
  flags: string[];
  /**
   * K4 only: deterministic support found for CANDEF's value (registry triangulation, researcher
   * agreement). It strengthens the recommendation; it never clears the record.
   */
  support: string[];
  /** K4 only: the support meets a delegation candidate rule (policy section 9; not active). */
  delegable: "D1-identity" | "D2-classification" | null;
  /** What tiers@1 did with the record, for comparison. */
  tiers: { tier: 1 | 2 | 3; status: string; route: string };
  /** One line: why this state. */
  basis: string;
  lifecycle: {
    researchComplete: boolean;
    independentlyChecked: boolean;
    clearedByPolicy: boolean;
    ownerApproved: boolean;
  };
}

export interface RouteInputs {
  corpus: Corpus;
  today: string;
  tiers: TierRecord[];
  worksheet: Worksheet;
  inventory: Inventory;
  packages: ResearcherPackage[];
  exposed: Set<string>;
  rows: RawRows | null;
  readCapture: (sourceId: string, captureId: string) => string | null;
  cards: BlindCard[];
  /** One-time verification reads (P-61), by source ID (research-cache/verification-reads/). */
  reads: Map<string, VerificationReadFile>;
  /** Attempts already made per `recordId|homeworkKind` (research-cache/clearance/ladder.json). */
  attempts: Map<string, number>;
}

const STRUCTURE = new Set(["subsidiary_of", "managed_by", "division_of", "predecessor_of"]);
const SCOPE = new Set(["eligibility", "classified_as"]);

// ---- Class and group ------------------------------------------------------------------------

function classify(
  t: TierRecord,
  a: Assertion | undefined,
): { cls: ClaimClass; group: GroupKind | null } {
  if (t.kind === "acquisition") return { cls: "K4", group: "structure" };
  if (t.kind === "agreement")
    return t.tier === 1 ? { cls: "K1", group: null } : { cls: "K3", group: null };
  if (t.kind === "round") return { cls: "K3", group: null };
  // CANDEF's own descriptions join the company-profile card with scope and subsector.
  if (!a) return { cls: "K4", group: "scope" };
  if (t.route.startsWith("identity anchor") || t.route === "legal-name history")
    return { cls: "K4", group: "identity" };
  if (SCOPE.has(a.predicate)) return { cls: "K4", group: "scope" };
  if (STRUCTURE.has(a.predicate)) return { cls: "K4", group: "structure" };
  if (t.tier === 3) return { cls: "K4", group: "scope" };
  return { cls: "K2", group: null };
}

// ---- Relations ------------------------------------------------------------------------------

function itemsByRecord(inv: Inventory): Map<string, InventoryItem[]> {
  const out = new Map<string, InventoryItem[]>();
  for (const it of inv.items) {
    if (it.kind !== "base") continue;
    for (const r of new Set(it.recordIds.map((x) => x.replace(/#p\d+$/, "")))) {
      out.set(r, [...(out.get(r) ?? []), it]);
    }
  }
  return out;
}

function relationsFor(
  items: InventoryItem[],
  ctx: {
    entityKeys: Set<string>;
    siblingKeys: Set<string>;
    historical: boolean;
    entityForms: Map<string, Set<string>>;
  },
  rowsByClaim: Map<string, Worksheet["rows"][number]>,
  pkgs: Map<string, ResearcherPackage>,
): RelationRow[] {
  const out: RelationRow[] = [];
  for (const it of items) {
    const row = rowsByClaim.get(it.claimId);
    if (!row) continue;
    let eventMonth: string | null = null;
    if (it.fieldId === "C02") {
      try {
        eventMonth =
          String((JSON.parse(it.value) as { date?: string }).date ?? "").slice(0, 7) || null;
      } catch {
        eventMonth = null;
      }
    }
    const claim: ClaimView = {
      fieldId: it.fieldId,
      tokens: signalTokens(it),
      entityKeys: ctx.entityKeys,
      siblingKeys: ctx.siblingKeys,
      entityForms: ctx.entityForms,
      historical: ctx.historical,
      eventMonth,
    };
    for (const c of row.candidates) {
      if (!c.usable || !c.independent) continue;
      const fv = findingView(pkgs.get(`${c.researcher}|${it.card}`), c.findingId, c);
      out.push({
        claimId: it.claimId,
        fieldId: it.fieldId,
        researcher: c.researcher,
        findingId: c.findingId,
        relation: relate(claim, fv),
        claim: c.claim,
        origins: c.origins,
        sameOrigin: c.sameAsCandefSource,
        official: (fv.finding?.sources ?? [])
          .filter((s) =>
            ["registry", "government_dataset", "government_publication", "filing"].includes(
              s.source_type ?? "",
            ),
          )
          .map((s) => s.url),
      });
    }
  }
  return out;
}

// ---- Checks ---------------------------------------------------------------------------------

const ruleOf = (t: TierRecord, id: string) => t.rules.find((r) => r.rule === id);
const mapRule = (
  id: CheckId,
  r: TierRecord["rules"][number] | undefined,
  fallback: string,
): Check =>
  r
    ? {
        id,
        result: r.result === "pass" ? "pass" : r.result === "conditional" ? "pass" : "fail",
        reason: r.reason,
      }
    : { id, result: "n/a", reason: fallback };

export function evidenceOf(
  t: { kind: TierRecord["kind"]; id: string },
  corpus: Corpus,
): Evidence[] {
  if (t.kind === "assertion") return corpus.assertions.find((a) => a.id === t.id)?.evidence ?? [];
  if (t.kind === "round") {
    const r = corpus.rounds.find((x) => x.id === t.id);
    return r
      ? [
          ...r.evidence,
          ...r.disclosures.flatMap((d) => d.evidence),
          ...r.participations.flatMap((p) => p.evidence),
        ]
      : [];
  }
  if (t.kind === "agreement") return corpus.agreements.find((g) => g.id === t.id)?.evidence ?? [];
  return corpus.acquisitions.find((q) => q.id === t.id)?.evidence ?? [];
}

// ---- Entry point ----------------------------------------------------------------------------

export function routeRecords(inputs: RouteInputs): ClearanceRecord[] {
  const { corpus, today } = inputs;
  const sources = new Map(corpus.sources.map((s) => [s.id, s]));
  const byRecord = itemsByRecord(inputs.inventory);
  const rowsByClaim = new Map(inputs.worksheet.rows.map((r) => [r.claimId, r]));
  const pkgs = new Map(inputs.packages.map((p) => [`${p.researcher.id}|${p.company.card_id}`, p]));
  const orgs = new Map(corpus.organizations.map((o) => [o.id, o]));
  const cardOrgs = new Map<string, string[]>();
  for (const c of inputs.cards) {
    const ids = c.orgSlugs
      .map((s) => corpus.organizations.find((o) => o.slug === s)?.id)
      .filter((x): x is string => !!x);
    for (const id of ids) cardOrgs.set(id, ids);
  }
  // Saved federal registry copies cited anywhere for an organization (identity triangulation).
  const registryCache = new Map<string, { sourceId: string; text: string }[]>();
  const registryCopies = (orgId: string) => {
    if (registryCache.has(orgId)) return registryCache.get(orgId)!;
    const ids = new Set(
      corpus.assertions
        .filter((x) => x.subjectId === orgId)
        .flatMap((x) => x.evidence.map((e) => e.sourceId)),
    );
    const out: { sourceId: string; text: string }[] = [];
    for (const id of ids) {
      const s = sources.get(id);
      if (s?.kind !== "registry") continue;
      const cap = s.captures?.at(-1);
      const text = cap ? inputs.readCapture(id, cap.id) : null;
      if (text) out.push({ sourceId: id, text });
    }
    registryCache.set(orgId, out);
    return out;
  };
  const foundedYear = (orgId: string): number | null => {
    const a = corpus.assertions.find(
      (x) =>
        x.subjectId === orgId && x.predicate === "founded_year" && !INACTIVE.has(x.verification),
    );
    return a ? Number(a.value) : null;
  };

  return inputs.tiers.map((t): ClearanceRecord => {
    const a = t.kind === "assertion" ? corpus.assertions.find((x) => x.id === t.id) : undefined;
    const org = orgs.get(t.orgId);
    const names = entityNames(corpus, t.orgId);
    const entityKeys = new Set(names.map(nameKey).filter(Boolean));
    const siblingKeys = new Set(
      (cardOrgs.get(t.orgId) ?? [])
        .filter((id) => id !== t.orgId)
        .flatMap((id) => entityNames(corpus, id).map(nameKey)),
    );
    const historical = !!a && (a.validTo !== null || t.route === "legal-name history");
    const { cls, group } = classify(t, a);
    const items = byRecord.get(t.id) ?? [];
    const entityForms = new Map<string, Set<string>>();
    for (const n of names) {
      const f = formOf(n);
      if (f) entityForms.set(nameKey(n), (entityForms.get(nameKey(n)) ?? new Set()).add(f));
    }
    const relations = relationsFor(
      items,
      { entityKeys, siblingKeys, historical, entityForms },
      rowsByClaim,
      pkgs,
    );
    const evidence = evidenceOf(t, corpus);
    const flags: string[] = [];
    const risks: LegalFormRisk[] = legalFormRisks(evidence, inputs.rows, names);
    for (const r of risks)
      flags.push(
        `cited row ${r.reference} names "${r.rowName}", CANDEF records "${r.entityName}": same name, different legal element (possible predecessor, successor or affiliate)`,
      );
    const indep = relations.filter((r) => r.relation === "supports");
    const contra = relations.filter((r) => r.relation === "contradicts");
    const judgements = relations.filter((r) => r.relation === "judgement_differs");
    if (judgements.length && cls === "K4")
      flags.push(
        `independent researcher(s) reached a different judgement: ${[...new Set(judgements.map((j) => j.researcher))].join(", ")}`,
      );
    const homework: Homework[] = [];
    const add = (kind: HomeworkKind, reason: string) => {
      if (!homework.some((h) => h.kind === kind)) homework.push({ kind, reason });
    };
    const base = {
      id: t.id,
      kind: t.kind,
      orgId: t.orgId,
      orgName: org?.name ?? t.orgId,
      predicate: a?.predicate ?? null,
      fields: [...new Set(items.map((i) => i.fieldId))],
      hash: t.hash,
      cls,
      relations,
      flags,
      tiers: { tier: t.tier, status: t.status, route: t.route },
      support: [] as string[],
      delegable: null as ClearanceRecord["delegable"],
      lifecycle: {
        researchComplete: evidence.length > 0,
        independentlyChecked: relations.some((r) => r.relation !== "no_finding"),
        clearedByPolicy: false,
        ownerApproved: false,
      },
    };

    // ---- K4: never cleared; prepared for one grouped decision ----
    if (cls === "K4") {
      const support: string[] = [];
      let delegable: ClearanceRecord["delegable"] = null;
      // D1: a BN anchor printed on the federal registry page whose corporate name is this entity.
      if (a?.predicate === "registry_id" && (a.value as { system?: string }).system === "cra-bn") {
        const bn = String((a.value as { value?: string }).value ?? "").replace(/\D/g, "");
        for (const s of registryCopies(t.orgId)) {
          const corp = s.text.match(/corporate name: (.+?) status:/)?.[1];
          if (
            corp &&
            names.some((n) => govNameKey(n) === govNameKey(corp)) &&
            s.text.replace(/\s/g, "").includes(bn)
          ) {
            support.push(
              `BN ${bn} is printed on the federal registry page for "${corp}" (${s.sourceId})`,
            );
            delegable = "D1-identity";
            break;
          }
        }
      }
      // D1: a postal anchor whose area is the registered office on that registry page.
      if (
        (a?.predicate === "operations_location" || a?.predicate === "hq_location") &&
        (a.value as { postalCode?: string }).postalCode
      ) {
        const fsa = String((a.value as { postalCode?: string }).postalCode)
          .slice(0, 3)
          .toLowerCase();
        for (const s of registryCopies(t.orgId)) {
          const corp = s.text.match(/corporate name: (.+?) status:/)?.[1];
          const office = s.text.match(/registered office address (.{0,120})/)?.[1] ?? "";
          if (
            corp &&
            names.some((n) => govNameKey(n) === govNameKey(corp)) &&
            new RegExp(`\\b${fsa}\\s?\\d`).test(office)
          ) {
            support.push(
              `postal area ${fsa.toUpperCase()} is the registered office on the federal registry page (${s.sourceId})`,
            );
            delegable = "D1-identity";
            break;
          }
        }
      }
      // D2: the primary subsector, when two or more independent researchers reached it too.
      if (a?.predicate === "classified_as") {
        const agree = new Set(
          relations.filter((r) => r.relation === "judgement_agrees").map((r) => r.researcher),
        );
        const differ = relations.some((r) => r.relation === "judgement_differs");
        if (agree.size)
          support.push(
            `${agree.size} independent researcher(s) chose the same subsector: ${[...agree].join(", ")}`,
          );
        if (agree.size >= 2 && !differ) delegable = "D2-classification";
      }
      if (flags.length) delegable = null;
      return {
        ...base,
        support,
        delegable,
        state: "needs_owner",
        conditionalOn: [],
        checks: [],
        homework,
        projected: null,
        group: { kind: group!, key: `${group}:${t.orgId}` },
        basis: `consequential or judgement (${t.route}): never cleared automatically`,
      };
    }

    // ---- K1: federal dataset rows (tiers@1 rules carry over) ----
    if (cls === "K1") {
      const checks: Check[] = [
        { id: "V-ev", result: "pass", reason: "dataset row citation" },
        ...["T1-a", "T1-b", "T1-d"].map((id) => mapRule("V-row", ruleOf(t, id), "not evaluated")),
        mapRule("V-con", ruleOf(t, "T1-c"), "not evaluated"),
      ];
      const t1a = ruleOf(t, "T1-a");
      const t1b = ruleOf(t, "T1-b");
      const t1c = ruleOf(t, "T1-c");
      const t1d = ruleOf(t, "T1-d");
      if (risks.length && t1b?.result !== "fail" && !/approved anchor|BN/.test(t1b?.reason ?? ""))
        checks.push({ id: "V-ent", result: "fail", reason: flags.join("; ") });
      let state: ClearanceState = "cleared";
      let groupKind: GroupKind | null = null;
      let basis =
        "every value equals the dataset row; recipient anchored to the company's identity";
      if (t1a?.result === "fail" || t1d?.result === "fail") {
        state = "incorrect";
        groupKind = "correction";
        basis = `the record differs from its own dataset row: ${(t1a?.result === "fail" ? t1a : t1d)!.reason}`;
      } else if (
        t1b?.result === "fail" ||
        checks.some((c) => c.id === "V-ent" && c.result === "fail")
      ) {
        state = "needs_owner";
        groupKind = "identity";
        basis = `recipient not anchored to the company: ${t1b?.result === "fail" ? t1b.reason : flags.join("; ")}`;
      } else if (t1c?.result === "fail") {
        state = "needs_owner";
        groupKind = "reconciliation";
        basis = `reconciliation case: ${t1c.reason}`;
      }
      return {
        ...base,
        state,
        conditionalOn: state === "cleared" ? t.dependsOn : [],
        checks,
        homework,
        projected: null,
        group: groupKind
          ? {
              kind: groupKind,
              key: `${groupKind}:${groupKind === "correction" ? "batch" : t.orgId}`,
            }
          : null,
        basis:
          state === "cleared" && t.dependsOn.length
            ? `${basis} (once the owner confirms the identity anchors)`
            : basis,
        lifecycle: { ...base.lifecycle, clearedByPolicy: state === "cleared" },
      };
    }

    // ---- K2 and K3 ----
    const checks: Check[] = [];
    const t2a = ruleOf(t, "T2-a");
    const t2b = ruleOf(t, "T2-b");
    const t2c = ruleOf(t, "T2-c");
    const t2d = ruleOf(t, "T2-d");
    const t2f = ruleOf(t, "T2-f");
    checks.push(
      mapRule(
        "V-ev",
        t2d,
        t.tier === 3 ? "owner-record agreement: evidence rule not run by tiers@1" : "not evaluated",
      ),
    );
    const t3t4 = t.route.includes("T3/T4") || t2a?.result === "fail";
    checks.push(
      t3t4
        ? {
            id: "V-src",
            result: "fail",
            reason: t2a?.reason ?? "relies on a T3/T4 or licensed source",
          }
        : mapRule("V-src", t2a, "not evaluated"),
    );
    if (t3t4)
      add("find-original", "a secondary source carries the claim: find and capture the original");

    // V-copy: saved copy (tiers T2-b, T2-c), or the cited dataset row for values taken from a row.
    let copy: Check;
    const row = a ? rowValueCheck(a, inputs.rows) : null;
    let projectedCopy = false;
    // A government-dataset source cannot name a page capture; its rows are checked on their own
    // (T1-a, rowValueCheck), so it does not count against the saved-copy check of the other evidence.
    const datasetOnly = (r: typeof t2b) =>
      !!r &&
      r.result === "fail" &&
      (r.reason.match(/src_[0-9a-f]{12}/g) ?? []).length > 0 &&
      (r.reason.match(/src_[0-9a-f]{12}/g) ?? []).every(
        (id) => sources.get(id)?.kind === "gov_dataset",
      ) &&
      !/permission|unknown source/.test(r.reason);
    if (row) copy = { id: "V-copy", result: row.found ? "pass" : "fail", reason: row.reason };
    else if ((t2b?.result === "pass" || datasetOnly(t2b)) && t2c?.result === "pass")
      copy = { id: "V-copy", result: "pass", reason: t2c.reason };
    else {
      const reasons = [t2b, t2c].filter((r) => r && r.result === "fail").map((r) => r!.reason);
      copy = { id: "V-copy", result: "fail", reason: reasons.join(" | ") || "no saved-copy check" };
      const why = reasons.join(" ");
      if (/permission (denied|unknown)/.test(why))
        add(
          "verification-read",
          "the site does not allow a saved copy: verify by a one-time read that keeps only hashes and the match offset",
        );
      if (/evidence names no capture/.test(why)) {
        // Simulate the link in memory: does the source's latest capture hold every value?
        const values = t.values.filter((v) => !v.found);
        const ok =
          values.length > 0 &&
          values.every((v) =>
            evidence.some((e) => {
              const cap = sources.get(e.sourceId)?.captures?.at(-1);
              if (!cap) return false;
              const text = inputs.readCapture(e.sourceId, cap.id);
              return !!text && rematch(text, v.kind, v.value);
            }),
          );
        projectedCopy = ok;
        add("link-capture", "the source has a saved copy but the evidence does not point to it");
      }
      if (
        /not found in a cited capture/.test(why) &&
        // The saved copies exist (T2-b passed, or failed for another reason than missing copies).
        (t2b?.result === "pass" ||
          !/permission|names no capture|no capture/.test(t2b?.reason ?? ""))
      )
        add(
          "reread-copy",
          "the saved copy exists but the value was not found in it by the matcher",
        );
      if (/no stated amount|no identifier value|no city|no ticker/.test(why))
        add("fix-record", why);
      if (/no capture$|: no capture;|: no capture/.test(t2b?.reason ?? ""))
        add(
          "find-original",
          "no saved copy of the cited source: capture it (or find a permitted original)",
        );
    }
    // P-61: a one-time read of a page that may not be copied covers values the saved-copy check
    // could not see (only hashes and offsets were kept; the record's hash binds the read).
    let readSources: ReturnType<typeof coveredByReads>["sources"] = [];
    if (copy.result === "fail" && !row && (t.kind === "assertion" || t.kind === "round")) {
      const parts = recordParts(corpus, t.id);
      if (typeof parts !== "string") {
        const have = new Set(t.values.filter((v) => v.found).map((v) => v.part));
        const cov = coveredByReads(t.id, t.hash, parts, have, inputs.reads);
        if (cov.sources.length && !cov.missing.length) {
          readSources = cov.sources;
          copy = {
            id: "V-copy",
            result: "pass",
            reason: `${parts.length - have.size} value(s) verified by a one-time read (P-61): ${cov.sources.map((s) => `${s.sourceId} on ${s.readAt.slice(0, 10)}`).join(", ")}; only hashes and offsets kept`,
          };
          for (const k of ["verification-read", "link-capture", "reread-copy"] as const) {
            const i = homework.findIndex((h) => h.kind === k);
            if (i >= 0) homework.splice(i, 1);
          }
        }
      }
    }
    checks.push(copy);

    // V-ent: the value's copy names this entity, or the source is the company's own site.
    const website = websiteOf(corpus, org);
    const registryOther = new Set<string>();
    const entHits = t.values
      .filter((v) => v.found && v.sourceId && v.captureId)
      .map((v) => {
        const text = inputs.readCapture(v.sourceId!, v.captureId!);
        // A registry page is about exactly one corporation: its corporate name must be one of this
        // entity's names (a predecessor's or affiliate's page is a lineage question for the owner).
        const corp = text?.match(/corporate name: (.+?) status:/)?.[1];
        if (corp && !names.some((n) => govNameKey(n) === govNameKey(corp))) {
          registryOther.add(corp);
          return null;
        }
        const name = text ? entityInText(text, names) : null;
        const own = sameSite(sources.get(v.sourceId!)?.url ?? "", website);
        return name ? `copy names "${name}"` : own ? "company's own website" : null;
      });
    for (const s of readSources) {
      const named = s.entityNamed[t.orgId];
      const own = sameSite(sources.get(s.sourceId)?.url ?? "", website);
      entHits.push(named ? `read names "${named}"` : own ? "company's own website" : null);
    }
    const ent: Check = row?.found
      ? { id: "V-ent", result: "pass", reason: "value read from a row about this recipient" }
      : copy.result !== "pass"
        ? { id: "V-ent", result: "n/a", reason: "no matched copy to check" }
        : entHits.length && entHits.every(Boolean)
          ? { id: "V-ent", result: "pass", reason: [...new Set(entHits)].join("; ") }
          : {
              id: "V-ent",
              result: "fail",
              reason: registryOther.size
                ? `the registry page is for another corporation ("${[...registryOther].join('", "')}"): a predecessor or affiliate`
                : "a copy holding the value does not name the entity and is not the company's own site",
            };
    if (risks.length) {
      ent.result = "fail";
      ent.reason = flags.join("; ");
    }
    checks.push(ent);

    // V-ind: independent support. Original-authority waiver for K2 on a matched T1 copy.
    // Every key value must be found in a saved copy of an official (T1) source; other sources may
    // be cited beside it (a company page that agrees does not weaken the official record).
    const t1Evidence = evidence.filter(
      (e) => !!e.captureId && sources.get(e.sourceId)?.tier === "T1",
    );
    const cityValue = t.values.find((x) => x.kind === "city")?.value ?? null;
    const inT1 = (v: (typeof t.values)[number]) =>
      t1Evidence.some((e) => {
        const text = inputs.readCapture(e.sourceId, e.captureId!);
        if (!text) return false;
        return v.kind === "province"
          ? matchProvince(text, v.value, cityValue).found
          : rematch(text, v.kind, v.value);
      });
    // A value equal to its cited government-dataset row is an official-record match as well.
    const t1Copy =
      copy.result === "pass" && (!!row?.found || (t.values.length > 0 && t.values.every(inT1)));
    const amountItems = items.filter((i) => i.fieldId === "C02");
    let ind: Check;
    if (cls === "K3" && t.kind === "round" && amountItems.length) {
      const unsupported = amountItems.filter((i) => !indep.some((r) => r.claimId === i.claimId));
      ind = unsupported.length
        ? {
            id: "V-ind",
            result: "fail",
            reason: `${unsupported.length} of ${amountItems.length} disclosure(s) have no independent supporting finding`,
          }
        : {
            id: "V-ind",
            result: "pass",
            reason: `every disclosure supported by ${[...new Set(indep.map((r) => r.researcher))].join(", ")}`,
          };
    } else if (indep.length)
      ind = {
        id: "V-ind",
        result: "pass",
        reason: `${[...new Set(indep.map((r) => r.researcher))].join(", ")}${indep.every((r) => r.sameOrigin) ? " (same document CANDEF cites)" : ""}`,
      };
    else if (AUTHORITY_WAIVES_CORROBORATION.has(cls) && t1Copy)
      ind = {
        id: "V-ind",
        result: "waived",
        reason: "original-authority rule: the value is in a saved official record",
      };
    else
      ind = {
        id: "V-ind",
        result: "fail",
        reason: items.length
          ? "no independent finding states the value"
          : "no blind-research coverage",
      };
    if (ind.result === "fail") add("blind-task", ind.reason);
    checks.push(ind);

    // V-con: contradictions (same entity, same period, different value) and CANDEF disputes.
    const dispute = t2f?.result === "fail" && /another CANDEF record/.test(t2f.reason);
    // Authority rule: CANDEF's value is in a saved official copy that names the entity. A
    // contradicting AI finding that cites no official source does not outweigh that record; one
    // that cites an official source CANDEF has not read sends the system to read it (step 2).
    const officialCopy = t1Copy && ent.result === "pass";
    const contraOfficial = contra.filter((c) => c.official.length > 0);
    if (officialCopy && contra.length && !contraOfficial.length) {
      checks.push({
        id: "V-con",
        result: "pass",
        reason: `${contra.map((c) => `${c.researcher} ${c.findingId}`).join(", ")} differ but cite no official source; the saved official record holds CANDEF's value (logged)`,
      });
      contra.length = 0;
    }
    const con: Check = contra.length
      ? {
          id: "V-con",
          result: "fail",
          reason: `${contra.map((c) => `${c.researcher} ${c.findingId}`).join(", ")} give a different value`,
        }
      : dispute
        ? { id: "V-con", result: "fail", reason: t2f!.reason }
        : {
            id: "V-con",
            result: "pass",
            reason: "no independent finding gives a different value for the same entity and period",
          };
    if (contra.length)
      add(
        "read-contradicting-source",
        `${con.reason}${contraOfficial.length ? `; official source(s) to read: ${[...new Set(contraOfficial.flatMap((c) => c.official))].slice(0, 3).join(", ")}` : ""}`,
      );
    if (dispute) add("adjudicate", "two CANDEF records disagree");
    if (!checks.some((c) => c.id === "V-con")) checks.push(con);

    // V-norm, V-dup, V-time.
    const round = t.kind === "round" ? corpus.rounds.find((r) => r.id === t.id) : undefined;
    const norm = round ? roundNormalization(round, today) : [];
    if (a?.predicate === "founded_year") {
      const y = Number(a.value);
      if (!(y >= 1800 && y <= Number(today.slice(0, 4))))
        norm.push(`year ${String(a.value)} is out of range`);
    }
    checks.push(
      norm.length
        ? { id: "V-norm", result: "fail", reason: norm.join("; ") }
        : { id: "V-norm", result: "pass", reason: "well formed" },
    );
    if (norm.length) add("fix-record", norm.join("; "));
    if (cls === "K3") {
      const dups = round ? duplicateRounds(round, corpus) : [];
      checks.push(
        dups.length
          ? { id: "V-dup", result: "fail", reason: dups.join("; ") }
          : { id: "V-dup", result: "pass", reason: "no likely duplicate" },
      );
      if (dups.length) add("adjudicate", `possible duplicate: ${dups.join("; ")}`);
    }
    const fy = foundedYear(t.orgId);
    const older = fy
      ? evidence.filter((e) => {
          const p = sources.get(e.sourceId)?.publishedOn;
          return p && Number(p.slice(0, 4)) < fy;
        })
      : [];
    checks.push(
      older.length
        ? {
            id: "V-time",
            result: "fail",
            reason: `evidence published before the entity's founding year ${fy}: ${older.map((e) => e.sourceId).join(", ")}`,
          }
        : {
            id: "V-time",
            result: fy ? "pass" : "n/a",
            reason: fy ? "no evidence older than the entity" : "founding year not recorded",
          },
    );

    // Method questions: the evidence is right, but what it proves depends on an undefined rule.
    const locators = evidence.map((e) => e.locator);
    let definition: keyof typeof DEFINITIONS | null = null;
    if (
      a?.predicate === "founded_year" &&
      locators.length &&
      locators.every((l) => DEFINITIONS.founded_year.locator.test(l))
    )
      definition = "founded_year";
    if (
      (a?.predicate === "hq_location" || a?.predicate === "operations_location") &&
      locators.length &&
      locators.every((l) => DEFINITIONS.location.locator.test(l))
    )
      definition = "location";
    // A settled method question is the system's homework, not a question for the owner.
    if (definition && DEFINITIONS[definition].decidedBy) {
      const searched =
        (inputs.attempts.get(`${t.id}|find-original`) ?? 0) >=
        HOMEWORK["find-original"].maxAttempts;
      // P-63: once the search for a first-party statement found none, a registered office stands
      // (labelled); a dateline-only location does not.
      const office = locators.some((l) => /registered.office/i.test(l));
      if (definition === "location" && searched && office)
        flags.push(
          "location rests on the registered office: no first-party statement was found (P-63)",
        );
      else add("find-original", DEFINITIONS[definition].ruling);
      definition = null;
    } else if (definition)
      flags.push(
        `method question: ${definition} (evidence: ${locators
          .map((l) => l.replace(/^[^#]*#/, ""))
          .join("; ")
          .slice(0, 160)})`,
      );

    // ---- State ----
    const required = REQUIRED[cls];
    const failed = checks.filter((c) => required.includes(c.id) && c.result === "fail");
    const exhausted =
      homework.length > 0 &&
      homework.every(
        (h) => (inputs.attempts.get(`${t.id}|${h.kind}`) ?? 0) >= HOMEWORK[h.kind].maxAttempts,
      );
    let state: ClearanceState;
    let groupOut: ClearanceRecord["group"] = null;
    let basis: string;
    if (!failed.length && !definition && !homework.length) {
      state = "cleared";
      basis = `${cls} checks passed: ${checks
        .filter((c) => c.result === "pass" || c.result === "waived")
        .map((c) => c.id)
        .join(", ")}`;
    } else if (definition && !failed.some((c) => c.id === "V-ent" || c.id === "V-time")) {
      state = "needs_owner";
      groupOut = { kind: "definition", key: `definition:${definition}` };
      basis = `waits for the method decision on ${definition}`;
    } else if (failed.some((c) => c.id === "V-ent" || c.id === "V-time")) {
      state = "needs_owner";
      groupOut = { kind: "identity", key: `identity:${t.orgId}` };
      basis = `attribution: ${failed
        .filter((c) => c.id === "V-ent" || c.id === "V-time")
        .map((c) => c.reason)
        .join("; ")}`;
    } else if (exhausted) {
      // K2 and K3 records are held, never pushed to the owner as an uninformed decision.
      state = contra.length ? "contradictory" : "insufficient";
      if (contra.length) groupOut = { kind: "conflict", key: `conflict:${t.id}` };
      basis = `the ladder's budget is used up (${homework.map((h) => h.kind).join(", ")})`;
    } else if (homework.length) {
      state = "homework";
      basis = `failed ${failed.map((c) => c.id).join(", ")}; next: ${homework.map((h) => h.kind).join(", ")}`;
    } else {
      state = "insufficient";
      basis = `failed ${failed.map((c) => c.id).join(", ")} with no automated next step`;
    }
    // Only deterministic homework is simulated: linking evidence to a copy that already exists.
    const projected =
      state === "homework" &&
      homework.every((h) => h.kind === "link-capture") &&
      projectedCopy &&
      failed.every((c) => c.id === "V-copy")
        ? "cleared"
        : null;
    return {
      ...base,
      state,
      conditionalOn: [],
      checks,
      homework,
      projected,
      group: groupOut,
      basis,
      lifecycle: { ...base.lifecycle, clearedByPolicy: state === "cleared" },
    };
  });
}

// ---- Decision groups ------------------------------------------------------------------------

export interface DecisionGroup {
  key: string;
  kind: GroupKind;
  orgId: string | null;
  orgName: string;
  records: string[];
  /** Distinct answers the owner gives for this group (counted for the workload comparison). */
  decisions: number;
  /** Records that clear once this group is decided (tier 1 rows gated by identity anchors). */
  unlocks: number;
  question: string;
  recommendation: string;
  /** No flag and a kind whose recommendation can be accepted together with others after a skim. */
  bulkAcceptable: boolean;
  /** Deterministic support for the recommendation, per record. */
  support: string[];
  /** Decisions in this group that a delegation rule would settle if the owner approved it. */
  delegableDecisions: number;
  evidence: string[];
  flags: string[];
  /** What "Accept the recommendation" does to each record (shown on the card, used by apply). */
  actions: GroupAction[];
}

export interface GroupAction {
  id: string;
  kind: ClearanceRecord["kind"];
  hash: string;
  onAccept: "approve" | "reject" | "leave";
  reason?: string;
}

const RISK = /different legal element|method question|another corporation/;

/** The recommended outcome for one record of a group. */
function recommendedAction(r: ClearanceRecord, kind: GroupKind): GroupAction {
  const base = { id: r.id, kind: r.kind, hash: r.hash };
  const legal = r.flags.find((f) => /different legal element/.test(f));
  if (kind === "correction") return { ...base, onAccept: "reject", reason: r.basis.slice(0, 480) };
  if (legal && r.predicate === "eligibility")
    return {
      ...base,
      onAccept: "reject",
      reason: `The rationale cites a government row naming a different legal entity (${legal.slice(0, 380)}); a corrected rationale is drafted as a new proposal.`,
    };
  if (r.flags.some((f) => RISK.test(f))) return { ...base, onAccept: "leave" };
  if (kind === "reconciliation") return { ...base, onAccept: "leave" };
  if (kind === "identity" && r.kind === "agreement") return { ...base, onAccept: "leave" };
  return { ...base, onAccept: "approve" };
}

export function decisionGroups(records: ClearanceRecord[], corpus: Corpus): DecisionGroup[] {
  const byKey = new Map<string, ClearanceRecord[]>();
  for (const r of records)
    if (r.group && r.state !== "cleared")
      byKey.set(r.group.key, [...(byKey.get(r.group.key) ?? []), r]);
  const assertion = new Map(corpus.assertions.map((a) => [a.id, a]));
  const out: DecisionGroup[] = [];
  for (const [key, list] of byKey) {
    const kind = list[0]!.group!.kind;
    const orgId = kind === "correction" || kind === "definition" ? null : list[0]!.orgId;
    const orgName = orgId ? list[0]!.orgName : "this batch";
    const flags = [...new Set(list.flatMap((r) => r.flags))];
    const unlocks = orgId
      ? records.filter(
          (r) =>
            r.state === "cleared" && r.conditionalOn.some((id) => list.some((x) => x.id === id)),
        ).length
      : 0;
    const val = (id: string) => {
      const a = assertion.get(id);
      if (!a) return id;
      const v = a.value as Record<string, unknown> | string;
      if (typeof v !== "object") return `${a.predicate} = ${String(v)}`;
      if (a.predicate === "eligibility") return `eligibility = ${String(v.decision)}`;
      if (a.predicate === "registry_id") return `${String(v.system)} ${String(v.value)}`;
      if ("postalCode" in v)
        return `${a.predicate} = ${String(v.city)}, ${String(v.province)} (${String(v.postalCode)})`;
      return `${a.predicate} = ${JSON.stringify(v).slice(0, 80)}`;
    };
    let decisions: number;
    let question: string;
    let recommendation: string;
    switch (kind) {
      case "identity": {
        const rowQs = new Set(list.filter((r) => r.kind === "agreement").map((r) => r.basis));
        decisions = (list.some((r) => r.kind === "assertion") ? 1 : 0) + rowQs.size;
        question = `Confirm ${orgName}'s legal identity: the names, business number and postal areas below are the ones government rows are matched by${rowQs.size ? `, and decide ${rowQs.size} row question(s)` : ""}.`;
        recommendation = flags.length
          ? "Do not confirm until the flagged legal-element difference is explained (predecessor or affiliate?)."
          : `Confirm: each identifier is taken from an official record cited below${unlocks ? `; confirming clears ${unlocks} federal row(s)` : ""}.`;
        break;
      }
      case "scope":
        decisions = new Set(list.map((r) => r.predicate)).size;
        question = `Company profile: is ${orgName} in scope, is its primary subsector right, and do CANDEF's descriptions fit the sources?`;
        recommendation = flags.some((f) => /different legal element/.test(f))
          ? "Do not accept the eligibility rationale as written: it cites a government row naming a different legal entity (likely a predecessor). Reject it with that reason; a corrected rationale citing this entity's own evidence is drafted as a new proposal."
          : flags.length
            ? "Accept CANDEF's subsector unless the researcher's alternative (shown below) fits the company's main business better."
            : "Accept as written (no researcher reached a different conclusion).";
        break;
      case "interpretation":
        decisions = 1;
        question = `Accept CANDEF's ${list.length} descriptive statement(s) about ${orgName}?`;
        recommendation = "Accept as written unless a statement overstates the source.";
        break;
      case "definition": {
        const topic = key.split(":")[1] as keyof typeof DEFINITIONS;
        decisions = 1;
        question = `${DEFINITIONS[topic].question} (${list.length} record(s) in this batch: ${[...new Set(list.map((r) => r.orgName))].join(", ")})`;
        recommendation = DEFINITIONS[topic].recommendation;
        break;
      }
      case "structure":
        decisions = list.length;
        question = `Ownership and corporate history of ${orgName}: are these ${list.length} record(s) right?`;
        recommendation =
          "Approve as recorded if the linked sources (the parties' own statements or filings) say so; otherwise reject with the reason.";
        break;
      case "reconciliation":
        decisions = list.length;
        question = `${list.length} government agreement(s) for ${orgName} no longer match one dataset row (hand-merged amendments, or a row missing from the current import).`;
        recommendation =
          "Keep them out until they are reconciled against the current dataset (GOV_LINKAGE runbook). Choose another reading only if you have checked the rows yourself.";
        break;
      case "correction":
        decisions = 1;
        question = `Confirm that these ${list.length} record(s) are wrong; corrected records are drafted as new proposals.`;
        recommendation = "Confirm.";
        break;
      default:
        decisions = list.length;
        question = `${list.length} ${kind} item(s) for ${orgName}.`;
        recommendation = "See each item.";
    }
    out.push({
      key,
      kind,
      orgId,
      orgName,
      records: list.map((r) => r.id),
      decisions,
      unlocks,
      question,
      recommendation,
      evidence: list.map((r) => `${r.id}: ${r.kind === "assertion" ? val(r.id) : r.basis}`),
      flags,
      actions: list.map((r) => recommendedAction(r, kind)),
      // A profile card is only skim-acceptable when an independent researcher reached the same
      // judgement somewhere in it: "no objection" without anyone having looked proves nothing.
      bulkAcceptable:
        !flags.length &&
        (kind === "identity" ||
          (kind === "scope" &&
            list.some((r) => r.relations.some((x) => x.relation === "judgement_agrees")))),
      support: list.flatMap((r) => r.support),
      // Identity: one decision, delegable only when every anchor in it is triangulated.
      delegableDecisions:
        kind === "identity"
          ? list.every((r) => r.kind === "assertion" && r.delegable === "D1-identity")
            ? decisions
            : 0
          : list.filter((r) => r.delegable === "D2-classification").length,
    });
  }
  const order: GroupKind[] = [
    "definition",
    "conflict",
    "identity",
    "structure",
    "scope",
    "reconciliation",
    "secondary-source",
    "interpretation",
    "correction",
    "qc",
  ];
  return out.sort(
    (x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || x.orgName.localeCompare(y.orgName),
  );
}
