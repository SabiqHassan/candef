/**
 * Tier classifiers (docs/VERIFICATION_TIERS.md sections 2-4, D-21).
 *
 * `evaluateTiers` routes every proposed review unit to tier 1 (government agreements matched to the
 * dataset), tier 2 (sourced facts and rounds checked in saved copies) or tier 3 (owner judgement),
 * and runs each tier's fixed rules. Every rule result records its reason; every record lists the
 * evidence it rests on with capture hashes, and every value check its offset in the capture.
 *
 * Pure: all file and dataset access comes in through `TierInputs`. Nothing here writes research/,
 * approves or publishes anything; `apply.ts` (owner only) is the only writer.
 */
import type {
  Agreement,
  Assertion,
  Corpus,
  Evidence,
  FinancingRound,
  Source,
} from "../../../src/domain/schema/corpus";
import { canonicalJson, sha256 } from "../../compile/hash";
import { FactIndex, INACTIVE, SINGLE_VALUED } from "../../compile/facts";
import { approvedCorpus, type ClaimSignal } from "../blind";
import { reviewUnits, type ReviewUnit, type UnitKind } from "../decisions";
import { approvableIds } from "../review";
import { businessNumberRoot, nameKeys, postalFsa } from "../names";
import { verifyAgreement, type RawRows } from "../verifyGovClaims";
import { locatorMatches, parseLocator } from "../../ingest/gov/locators";
import { reconcileNumbers } from "../../ingest/gov/identity";
import type { MigrationPlan } from "../../ingest/gov/migration";
import type { ContractRow, GrantRow } from "../../ingest/gov/tbs";
import {
  matchDate,
  matchIdentifier,
  matchMoney,
  matchName,
  matchProvince,
  matchTicker,
  matchYear,
  type Match,
} from "./match";

export const RULES_VERSION = "tiers@1";

/** Tier 2 scope (section 3): sourced facts with these predicates, except identity anchors. */
export const TIER2_PREDICATES: ReadonlySet<string> = new Set([
  "legal_name",
  "registry_id",
  "founded_year",
  "hq_location",
  "operations_location",
  "public_listing",
  "total_raised_as_stated",
]);
const STRUCTURE = new Set(["subsidiary_of", "managed_by", "division_of"]);
const ASSESSMENTS = new Set(["eligibility", "classified_as"]);

export type RuleId =
  "T1-a" | "T1-b" | "T1-c" | "T1-d" | "T2-a" | "T2-b" | "T2-c" | "T2-d" | "T2-e" | "T2-f";
export interface RuleResult {
  rule: RuleId;
  result: "pass" | "fail" | "conditional";
  reason: string;
}
export interface ValueCheck {
  /** Which part of the record: "value", "label", "disclosure d1 amount", "participant 2"… */
  part: string;
  kind: "name" | "identifier" | "year" | "date" | "money" | "city" | "province" | "ticker";
  value: string;
  found: boolean;
  sourceId: string | null;
  captureId: string | null;
  offset: number | null;
}
export interface SourceRef {
  sourceId: string;
  captureId: string | null;
  rawSha256: string | null;
  textSha256: string | null;
}
export type TierStatus = "pass" | "conditional" | "exception" | "judgement";
export interface TierRecord {
  id: string;
  kind: UnitKind;
  orgId: string;
  /** The unit hash an approval would bind to (decisions.ts `unitHash`). */
  hash: string;
  tier: 1 | 2 | 3;
  /**
   * pass: every rule passed. conditional: tier 1, passes once the identity anchors in `dependsOn`
   * are approved. exception: a rule failed; the owner decides. judgement: tier 3 by nature.
   */
  status: TierStatus;
  /** Why tier 3 (judgement), or the failed rules (exception). */
  route: string;
  rules: RuleResult[];
  dependsOn: string[];
  sources: SourceRef[];
  values: ValueCheck[];
  /** Tier 1 only: the result on the migration plan's replacement content, if the plan updates it. */
  projected?: { status: TierStatus; rules: RuleResult[] };
}

export interface TierInputs {
  corpus: Corpus;
  today: string;
  /** Normalized text of a capture, or null when it is missing, unreadable or changed. */
  readCapture: (sourceId: string, captureId: string) => string | null;
  /** Rows cited by TBS agreements, read from the registered dataset captures; null = not loaded. */
  govRows: RawRows | null;
  datasetSources: { contracts: string; grants: string };
  /** Worksheet signals per record ID (`corroborationByRecord`); null = no worksheet. */
  corroboration: Map<string, ClaimSignal[]> | null;
  /** The latest reconciliation plan (GOV_LINKAGE runbook step 2); null = none generated. */
  plan: MigrationPlan | null;
}

const pass = (rule: RuleId, reason: string): RuleResult => ({ rule, result: "pass", reason });
const fail = (rule: RuleId, reason: string): RuleResult => ({ rule, result: "fail", reason });

// ---- Routing --------------------------------------------------------------------------------

const isAnchor = (a: Assertion): boolean => {
  const v = a.value as { system?: string; postalCode?: string | null } | null;
  if (a.predicate === "registry_id") return v?.system === "cra-bn";
  if (a.predicate === "operations_location" || a.predicate === "hq_location")
    return !!v?.postalCode;
  return false;
};

/** Why an assertion is tier 3 by nature, or null when it is in tier 2's scope. */
function assertionRoute(a: Assertion, corpus: Corpus): string | null {
  if (isAnchor(a)) return "identity anchor (BN or postal area used by government matching)";
  if (ASSESSMENTS.has(a.predicate)) return `CANDEF assessment (${a.predicate})`;
  if (STRUCTURE.has(a.predicate)) return `corporate structure (${a.predicate})`;
  if (a.epistemic !== "sourced_fact") return `${a.epistemic.replace(/_/g, " ")}`;
  if (a.predicate === "legal_name") {
    const others = corpus.assertions.filter(
      (o) =>
        o.id !== a.id &&
        o.subjectId === a.subjectId &&
        o.predicate === "legal_name" &&
        !INACTIVE.has(o.verification),
    );
    if (a.validTo !== null || others.length) return "legal-name history";
  }
  if (!TIER2_PREDICATES.has(a.predicate)) return `outside tier 1-2 scope (${a.predicate})`;
  return null;
}

// ---- Evidence and captures ------------------------------------------------------------------

function sourceRefs(evidence: Evidence[], sources: Map<string, Source>): SourceRef[] {
  const seen = new Map<string, SourceRef>();
  for (const e of evidence) {
    const s = sources.get(e.sourceId);
    const cap = e.captureId ? s?.captures?.find((c) => c.id === e.captureId) : undefined;
    const fp = s?.fingerprints?.at(-1);
    const ref: SourceRef = {
      sourceId: e.sourceId,
      captureId: cap?.id ?? null,
      rawSha256: cap?.rawSha256 ?? fp?.rawSha256 ?? null,
      textSha256: cap?.textSha256 ?? fp?.textSha256 ?? null,
    };
    seen.set(`${ref.sourceId}@${ref.captureId}`, ref);
  }
  return [...seen.values()];
}

function ruleT2a(evidence: Evidence[], sources: Map<string, Source>): RuleResult {
  const weak = [...new Set(evidence.map((e) => e.sourceId))].filter((id) => {
    const s = sources.get(id);
    return !s || (s.tier !== "T1" && s.tier !== "T2") || s.kind === "licensed_database";
  });
  return weak.length
    ? fail("T2-a", `needs a T3/T4 or licensed source: ${weak.join(", ")}`)
    : pass("T2-a", "every evidence item cites a T1 or T2 source");
}

function ruleT2b(evidence: Evidence[], sources: Map<string, Source>): RuleResult {
  const problems: string[] = [];
  for (const e of evidence) {
    const s = sources.get(e.sourceId);
    if (!s) problems.push(`${e.sourceId}: unknown source`);
    else if ((s.permissions?.capture ?? "unknown") !== "allowed")
      problems.push(
        `${e.sourceId}: capture permission ${s.permissions?.capture ?? "unknown"}${s.fingerprints?.length ? " (hashes only)" : ""}`,
      );
    else if (!s.captures?.length) problems.push(`${e.sourceId}: no capture`);
    else if (!e.captureId) problems.push(`${e.sourceId}: evidence names no capture`);
    else if (!s.captures.some((c) => c.id === e.captureId))
      problems.push(`${e.sourceId}: capture ${e.captureId} is not registered`);
    else if (!s.captures.find((c) => c.id === e.captureId)!.textSha256)
      problems.push(`${e.sourceId}: capture has no text hash`);
  }
  return problems.length
    ? fail("T2-b", [...new Set(problems)].join("; "))
    : pass("T2-b", "every evidence item names a saved, hashed capture with capture permission");
}

// ---- Values (T2-c) --------------------------------------------------------------------------

interface Part {
  part: string;
  kind: ValueCheck["kind"];
  value: string;
  evidence: Evidence[];
  match: (text: string) => Match;
}

function assertionParts(a: Assertion): Part[] | string {
  const v = a.value as Record<string, unknown> | string | number | null;
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x : null);
  const ev = a.evidence;
  switch (a.predicate) {
    case "legal_name":
      return [
        {
          part: "value",
          kind: "name",
          value: String(v),
          evidence: ev,
          match: (t: string) => matchName(t, String(v)),
        },
      ];
    case "registry_id": {
      const id = str(o.value);
      if (!id) return "no identifier value";
      return [
        {
          part: "value",
          kind: "identifier",
          value: id,
          evidence: ev,
          match: (t: string) => matchIdentifier(t, id),
        },
      ];
    }
    case "founded_year":
      return [
        {
          part: "value",
          kind: "year",
          value: String(v),
          evidence: ev,
          match: (t: string) => matchYear(t, String(v)),
        },
      ];
    case "hq_location":
    case "operations_location": {
      const city = str(o.city);
      const province = str(o.province);
      const parts: Part[] = [];
      if (city)
        parts.push({
          part: "city",
          kind: "city",
          value: city,
          evidence: ev,
          match: (t: string) => matchName(t, city),
        });
      if (province)
        parts.push({
          part: "province",
          kind: "province",
          value: province,
          evidence: ev,
          match: (t: string) => matchProvince(t, province, city),
        });
      return parts.length ? parts : "no city or province";
    }
    case "public_listing": {
      const ticker = str(o.ticker);
      if (!ticker) return "no ticker";
      return [
        {
          part: "ticker",
          kind: "ticker",
          value: ticker,
          evidence: ev,
          match: (t: string) => matchTicker(t, ticker),
        },
      ];
    }
    case "total_raised_as_stated": {
      // Records store the total as { money: { amount, currency, asStated } }.
      const m = (typeof o.money === "object" && o.money !== null ? o.money : o) as Record<
        string,
        unknown
      >;
      const amount = str(m.amount);
      if (!amount) return "no stated amount";
      const money = {
        amount,
        currency: String(m.currency ?? "unknown"),
        asStated: String(m.asStated ?? ""),
      };
      return [
        {
          part: "amount",
          kind: "money",
          value: `${amount} ${money.currency}`,
          evidence: ev,
          match: (t: string) => matchMoney(t, money),
        },
      ];
    }
    default:
      return `no value rule for ${a.predicate}`;
  }
}

function roundParts(r: FinancingRound): Part[] {
  const parts: Part[] = [];
  const label = r.roundLabelAsStated;
  if (label)
    parts.push({
      part: "label",
      kind: "name",
      value: label,
      evidence: r.evidence,
      match: (t: string) => matchName(t, label),
    });
  for (const d of r.disclosures) {
    parts.push({
      part: `${d.id} date`,
      kind: "date",
      value: d.date,
      evidence: d.evidence,
      match: (t: string) => matchDate(t, d.date),
    });
    const amount = d.amount.amount;
    if (amount)
      parts.push({
        part: `${d.id} amount`,
        kind: "money",
        value: `${amount} ${d.amount.currency}`,
        evidence: d.evidence,
        match: (t: string) =>
          matchMoney(t, { amount, currency: d.amount.currency, asStated: d.amount.asStated }),
      });
  }
  r.participations.forEach((p, i) =>
    parts.push({
      part: `participant ${i} (${p.role})`,
      kind: "name",
      value: p.reportedName,
      evidence: p.evidence,
      match: (t: string) => matchName(t, p.reportedName),
    }),
  );
  return parts;
}

/** One key value of a record and how to find it in a page's normalized text. */
export interface RecordPart {
  part: string;
  kind: ValueCheck["kind"];
  value: string;
  /** Sources the record cites for this part (a part is found in any of them). */
  sourceIds: string[];
  match: (text: string) => Match;
}

/**
 * The key values of a record (a tier-2 fact, or a financing round with its disclosures and
 * participants), for checks against a page read once (P-61). A string explains why there are none.
 */
export function recordParts(corpus: Corpus, id: string): RecordPart[] | string {
  const a = corpus.assertions.find((x) => x.id === id);
  const r = corpus.rounds.find((x) => x.id === id);
  const parts = a ? assertionParts(a) : r ? roundParts(r) : "not an assertion or a round";
  if (typeof parts === "string") return parts;
  return parts.map((p) => ({
    part: p.part,
    kind: p.kind,
    value: p.value,
    sourceIds: [...new Set(p.evidence.map((e) => e.sourceId))],
    match: p.match,
  }));
}

function checkParts(
  parts: Part[],
  read: TierInputs["readCapture"],
): { rule: RuleResult; values: ValueCheck[] } {
  const values: ValueCheck[] = [];
  for (const p of parts) {
    let check: ValueCheck = {
      part: p.part,
      kind: p.kind,
      value: p.value,
      found: false,
      sourceId: null,
      captureId: null,
      offset: null,
    };
    for (const e of p.evidence) {
      if (!e.captureId) continue;
      const text = read(e.sourceId, e.captureId);
      if (text === null) continue;
      const m = p.match(text);
      if (m.found) {
        check = {
          ...check,
          found: true,
          sourceId: e.sourceId,
          captureId: e.captureId,
          offset: m.offset,
        };
        break;
      }
    }
    values.push(check);
  }
  const missing = values.filter((v) => !v.found);
  return {
    values,
    rule: missing.length
      ? fail(
          "T2-c",
          `not found in a cited capture: ${missing.map((v) => `${v.part} "${v.value}"`).join("; ")}`,
        )
      : pass("T2-c", `${values.length} key value(s) found in cited captures`),
  };
}

// ---- Corroboration (T2-e, T2-f) -------------------------------------------------------------

function ruleT2e(id: string, inputs: TierInputs): RuleResult {
  if (!inputs.corroboration) return fail("T2-e", "no blind worksheet");
  const claims = inputs.corroboration.get(id) ?? [];
  if (!claims.length) return fail("T2-e", "no blind-research coverage for this record");
  const stale = claims.filter((c) => c.stale);
  if (stale.length)
    return fail(
      "T2-e",
      `claim changed since the worksheet: ${stale.map((c) => c.claimId).join(", ")}; re-run worksheet`,
    );
  const comparable = claims.filter((c) => c.signal !== "not_compared");
  const consistent = comparable.filter((c) => c.signal === "consistent");
  const others = comparable.filter((c) => c.signal !== "consistent");
  if (!consistent.length) return fail("T2-e", "no independent finding aligns with the claim");
  if (others.length)
    return fail(
      "T2-e",
      `not corroborated: ${others.map((c) => `${c.claimId} (${c.signal})`).join(", ")}`,
    );
  const researchers = [...new Set(consistent.flatMap((c) => c.researchers))];
  const origins = [...new Set(consistent.flatMap((c) => c.origins))];
  return pass(
    "T2-e",
    `${consistent.length} claim(s) consistent; independent researchers ${researchers.join(", ") || "n/a"}; ${origins.length} origin(s)`,
  );
}

function ruleT2f(id: string, inputs: TierInputs, disputed: ReadonlySet<string>): RuleResult {
  const claims = inputs.corroboration?.get(id) ?? [];
  const bad = claims.filter((c) => c.signal === "inconsistent" || c.contradictory);
  if (bad.length)
    return fail("T2-f", `independent finding disagrees: ${bad.map((c) => c.claimId).join(", ")}`);
  if (disputed.has(id))
    return fail("T2-f", "another CANDEF record disagrees (the compiler reports a dispute)");
  return pass("T2-f", "no contradicting finding and no dispute");
}

/** Assertions the compiler reports as disputed when every proposed record is approved. */
export function disputedAssertions(corpus: Corpus, today: string): Set<string> {
  const approved = approvedCorpus(corpus, today);
  const facts = new FactIndex(approved, today);
  const out = new Set<string>();
  const pairs = new Set(
    corpus.assertions
      .filter((a) => a.verification === "proposed" && SINGLE_VALUED.has(a.predicate))
      .map((a) => `${a.subjectId}|${a.predicate}`),
  );
  for (const pair of pairs) {
    const [subject, predicate] = pair.split("|") as [string, Assertion["predicate"]];
    const f = facts.fact(subject, predicate);
    if (f.state === "disputed") f.assertionIds.forEach((id) => out.add(id));
  }
  return out;
}

// ---- Tier 1 ---------------------------------------------------------------------------------

type Row = ContractRow | GrantRow;
const isContract = (r: Row): r is ContractRow => "reference_number" in r;
const kindOf = (g: Agreement) =>
  g.id.startsWith("agr_tbs_c_") ? "contracts" : g.id.startsWith("agr_tbs_g_") ? "grants" : null;

function citedRows(g: Agreement, rows: RawRows): { locator: string; rows: Row[] }[] {
  const kind = kindOf(g);
  const key = kind === "contracts" ? "reference_number" : "ref_number";
  return g.evidence.map((e) => {
    const fields = parseLocator(e.locator);
    const ref = fields?.get(key);
    const pool: Row[] =
      !fields || ref === undefined
        ? []
        : kind === "contracts"
          ? (rows.contracts.get(ref) ?? [])
          : (rows.grants.get(ref) ?? []);
    return {
      locator: e.locator,
      rows: fields ? pool.filter((r) => locatorMatches(fields, r)) : [],
    };
  });
}

interface Anchors {
  names: Set<string>;
  bns: Map<string, Assertion[]>;
  fsas: Map<string, Assertion[]>;
}
function anchorsOf(orgId: string, corpus: Corpus): Anchors {
  const live = corpus.assertions.filter(
    (a) => a.subjectId === orgId && !INACTIVE.has(a.verification),
  );
  const org = corpus.organizations.find((o) => o.id === orgId);
  const names = new Set(
    [org?.name, ...live.filter((a) => a.predicate === "legal_name").map((a) => String(a.value))]
      .filter((n): n is string => !!n)
      .flatMap((n) => nameKeys(n)),
  );
  const bns = new Map<string, Assertion[]>();
  const fsas = new Map<string, Assertion[]>();
  for (const a of live.filter(isAnchor)) {
    const v = a.value as { system?: string; value?: string; postalCode?: string };
    const key =
      a.predicate === "registry_id" ? businessNumberRoot(v.value) : postalFsa(v.postalCode);
    if (!key) continue;
    const map = a.predicate === "registry_id" ? bns : fsas;
    map.set(key, [...(map.get(key) ?? []), a]);
  }
  return { names, bns, fsas };
}

function ruleT1b(
  g: Agreement,
  cited: { locator: string; rows: Row[] }[],
  corpus: Corpus,
): { rule: RuleResult; dependsOn: string[] } {
  const party = g.parties.find((p) => p.role === "prime" || p.role === "recipient");
  if (!party) return { rule: fail("T1-b", "no prime or recipient party"), dependsOn: [] };
  const anchors = anchorsOf(party.orgId, corpus);
  const rows = cited.flatMap((c) => c.rows);
  if (!rows.length) return { rule: fail("T1-b", "no cited row to anchor"), dependsOn: [] };
  const depends = new Set<string>();
  const problems: string[] = [];
  let pending = false;
  for (const row of rows) {
    const names = isContract(row)
      ? [row.vendor_name]
      : [row.recipient_legal_name, row.recipient_operating_name].filter(Boolean);
    const bn = isContract(row) ? null : businessNumberRoot(row.recipient_business_number);
    const fsa = postalFsa(isContract(row) ? row.vendor_postal_code : row.recipient_postal_code);
    const nameHit = names.some((n) => nameKeys(n).some((k) => anchors.names.has(k)));
    // A BN field that is filled but not a valid BN is not "no BN": it may name another business.
    const rawBn = isContract(row) ? "" : (row.recipient_business_number ?? "").trim();
    if (!bn && /\d/.test(rawBn) && anchors.bns.size) {
      problems.push(
        `row BN field "${rawBn}" is not a valid business number; the owner checks the identity`,
      );
      continue;
    }
    let via: Assertion[] | undefined;
    if (bn && anchors.bns.has(bn)) via = anchors.bns.get(bn);
    else if (bn && anchors.bns.size && !anchors.bns.has(bn)) {
      problems.push(`row BN ${bn} differs from the company's BN anchor`);
      continue;
    } else if (nameHit && fsa && anchors.fsas.has(fsa)) via = anchors.fsas.get(fsa);
    if (!via) {
      problems.push(
        nameHit
          ? `row matches by name only (postal area ${fsa ?? "none"} is not an anchor)`
          : "row recipient name does not match the company",
      );
      continue;
    }
    if (via.some((a) => a.verification === "verified")) continue;
    pending = true;
    via.forEach((a) => depends.add(a.id));
  }
  if (problems.length)
    return { rule: fail("T1-b", [...new Set(problems)].join("; ")), dependsOn: [] };
  if (pending)
    return {
      rule: {
        rule: "T1-b",
        result: "conditional",
        reason: `anchored through proposed anchor(s) ${[...depends].join(", ")}; passes once the owner approves them`,
      },
      dependsOn: [...depends],
    };
  return {
    rule: pass("T1-b", "every cited row resolves through an approved anchor"),
    dependsOn: [],
  };
}

function ruleT1c(
  g: Agreement,
  cases: Map<string, string>,
  plan: MigrationPlan | null,
  projected: boolean,
): RuleResult {
  const problems: string[] = [];
  if (cases.has(g.id)) problems.push(`duplicate-number case: ${cases.get(g.id)}`);
  const kind = kindOf(g);
  const key = kind === "contracts" ? "procurement_id" : "ref_number";
  const refs = new Set(
    g.evidence
      .map(
        (e) =>
          parseLocator(e.locator)?.get(key) ??
          parseLocator(e.locator)?.get(kind === "contracts" ? "reference_number" : "ref_number"),
      )
      .filter(Boolean),
  );
  if (kind === "grants" && refs.size > 1)
    problems.push(`hand-merged record (${refs.size} references)`);
  if (!plan)
    problems.push("no reconciliation plan supplied (run the GOV_LINKAGE runbook plan step)");
  else if (!projected) {
    const change = plan.changes.find((c) => c.oldIds.includes(g.id));
    // A candidate or missing component is never applied; it needs the owner, not another apply.
    if (change?.action === "candidate")
      problems.push(
        "reconciliation candidate: the migration never applies it; the owner reconciles the record (GOV_LINKAGE.md runbook step 3)",
      );
    else if (change?.action === "missing")
      problems.push(
        "missing from the current import: no dataset row links to this record any more (kept, not deleted); the owner reviews it",
      );
    else if (change && change.action !== "unchanged")
      problems.push(
        `pending migration ${change.action}${change.fields.length ? ` (${change.fields.slice(0, 6).join(", ")})` : ""}: apply the reviewed migration first`,
      );
    if (change?.blocked) problems.push("migration component is blocked");
  }
  return problems.length
    ? fail("T1-c", problems.join("; "))
    : pass("T1-c", "no open reconciliation case");
}

function ruleT1d(g: Agreement, findings: { field: string }[]): RuleResult {
  const kind = kindOf(g)!;
  const want = kind === "contracts" ? ["buyer", "prime"] : ["funder", "recipient"];
  const problems: string[] = [];
  for (const role of want)
    if (g.parties.filter((p) => p.role === role).length !== 1)
      problems.push(`needs exactly one ${role}`);
  const family = kind === "contracts" ? ["procurement"] : ["grant_contribution", "other_transfer"];
  if (!family.includes(g.family))
    problems.push(`family ${g.family} does not fit the ${kind} dataset`);
  const named = findings.filter((f) => f.field.endsWith(".reportedName")).map((f) => f.field);
  if (named.length) problems.push(`party name differs from the row: ${named.join(", ")}`);
  return problems.length
    ? fail("T1-d", problems.join("; "))
    : pass("T1-d", "buyer/funder and prime/recipient come from the rows");
}

function tier1Rules(
  g: Agreement,
  inputs: TierInputs,
  cases: Map<string, string>,
  projected: boolean,
): { rules: RuleResult[]; dependsOn: string[] } {
  if (!inputs.govRows) return { rules: [fail("T1-a", "dataset rows not loaded")], dependsOn: [] };
  const kind = kindOf(g)!;
  const findings = verifyAgreement(g, inputs.govRows, {
    strictLocators: true,
    datasetSources: { [kind]: inputs.datasetSources[kind] },
  });
  const valueFindings = findings.filter((f) => !f.field.endsWith(".reportedName"));
  const t1a = valueFindings.length
    ? fail(
        "T1-a",
        `${valueFindings.length} difference(s) from the dataset rows: ${[...new Set(valueFindings.map((f) => f.field.replace(/\[\d+\]/g, "[]")))].slice(0, 8).join(", ")}`,
      )
    : pass(
        "T1-a",
        "every cited row exists once in the registered capture and every value equals it",
      );
  const cited = citedRows(g, inputs.govRows);
  const t1b = ruleT1b(g, cited, inputs.corpus);
  return {
    rules: [t1a, t1b.rule, ruleT1c(g, cases, inputs.plan, projected), ruleT1d(g, findings)],
    dependsOn: t1b.dependsOn,
  };
}

// ---- Status ---------------------------------------------------------------------------------

function statusOf(rules: RuleResult[]): { status: TierStatus; route: string } {
  const failed = rules.filter((r) => r.result === "fail");
  if (failed.length)
    return { status: "exception", route: `failed ${failed.map((r) => r.rule).join(", ")}` };
  if (rules.some((r) => r.result === "conditional"))
    return { status: "conditional", route: "waits for identity anchor approval" };
  return { status: "pass", route: "all rules passed" };
}

// ---- Entry point ----------------------------------------------------------------------------

export function evaluateTiers(inputs: TierInputs): TierRecord[] {
  const { corpus, today } = inputs;
  const sources = new Map(corpus.sources.map((s) => [s.id, s]));
  const units: ReviewUnit[] = reviewUnits(corpus, today);
  const approvable = new Set(
    corpus.organizations.flatMap((o) => approvableIds(corpus, o.id, today)),
  );
  const facts = new FactIndex(corpus, today);
  const disputed = disputedAssertions(corpus, today);
  const active = corpus.agreements.filter((g) => !INACTIVE.has(g.verification));
  const cases = new Map<string, string>();
  for (const c of reconcileNumbers(active).cases)
    for (const id of c.ids)
      cases.set(id, `${c.classification} with ${c.ids.filter((x) => x !== id).join(", ")}`);
  const replacements = new Map((inputs.plan?.replacements ?? []).map((r) => [r.id, r]));

  return units.map((u): TierRecord => {
    const base = {
      id: u.id,
      kind: u.kind,
      orgId: u.orgId,
      hash: u.hash,
      dependsOn: [] as string[],
      values: [] as ValueCheck[],
    };
    if (u.kind === "acquisition") {
      const q = corpus.acquisitions.find((x) => x.id === u.id)!;
      return {
        ...base,
        tier: 3,
        status: "judgement",
        route: "corporate structure (acquisition)",
        rules: [],
        sources: sourceRefs(q.evidence, sources),
      };
    }
    if (u.kind === "agreement") {
      const g = corpus.agreements.find((x) => x.id === u.id)!;
      const refs = sourceRefs(
        [...g.evidence, ...g.valueStatements.flatMap((v) => v.evidence)],
        sources,
      );
      if (!kindOf(g))
        return {
          ...base,
          tier: 3,
          status: "judgement",
          route: "agreement not from the federal datasets (owner record)",
          rules: [],
          sources: refs,
        };
      const now = tier1Rules(g, inputs, cases, false);
      const s = statusOf(now.rules);
      const record: TierRecord = {
        ...base,
        tier: 1,
        ...s,
        rules: now.rules,
        dependsOn: now.dependsOn,
        sources: refs,
      };
      const next = replacements.get(g.id);
      if (
        next &&
        inputs.plan?.changes.some((c) => c.oldIds.includes(g.id) && c.action !== "unchanged")
      ) {
        const proj = tier1Rules(next, inputs, cases, true);
        record.projected = { status: statusOf(proj.rules).status, rules: proj.rules };
      }
      return record;
    }
    if (u.kind === "assertion") {
      const a = corpus.assertions.find((x) => x.id === u.id)!;
      const refs = sourceRefs(a.evidence, sources);
      const route = assertionRoute(a, corpus);
      if (route) return { ...base, tier: 3, status: "judgement", route, rules: [], sources: refs };
      const t2a = ruleT2a(a.evidence, sources);
      if (t2a.result === "fail")
        return {
          ...base,
          tier: 3,
          status: "judgement",
          route: "relies on a T3/T4 or licensed source",
          rules: [t2a],
          sources: refs,
        };
      const parts = assertionParts(a);
      const c =
        typeof parts === "string"
          ? { rule: fail("T2-c", parts), values: [] }
          : checkParts(parts, inputs.readCapture);
      const rules = [
        t2a,
        ruleT2b(a.evidence, sources),
        c.rule,
        facts.meetsEvidenceRule(a)
          ? pass("T2-d", "evidence rule passes")
          : fail("T2-d", "fails the predicate's evidence rule"),
        ruleT2e(a.id, inputs),
        ruleT2f(a.id, inputs, disputed),
      ];
      return { ...base, tier: 2, ...statusOf(rules), rules, sources: refs, values: c.values };
    }
    const r = corpus.rounds.find((x) => x.id === u.id)!;
    const evidence = [
      ...r.evidence,
      ...r.disclosures.flatMap((d) => d.evidence),
      ...r.participations.flatMap((p) => p.evidence),
    ];
    const refs = sourceRefs(evidence, sources);
    const t2a = ruleT2a(evidence, sources);
    if (t2a.result === "fail")
      return {
        ...base,
        tier: 3,
        status: "judgement",
        route: "relies on a T3/T4 or licensed source",
        rules: [t2a],
        sources: refs,
      };
    const c = checkParts(roundParts(r), inputs.readCapture);
    const rules = [
      t2a,
      ruleT2b(evidence, sources),
      c.rule,
      approvable.has(r.id)
        ? pass("T2-d", "every part cites registered evidence")
        : fail("T2-d", "a part has no registered evidence"),
      ruleT2e(r.id, inputs),
      ruleT2f(r.id, inputs, disputed),
    ];
    return { ...base, tier: 2, ...statusOf(rules), rules, sources: refs, values: c.values };
  });
}

/** The batch hash: binds rules version, every record's content hash, status, rules and evidence hashes. */
export function batchHash(records: TierRecord[]): string {
  return sha256(
    canonicalJson({
      rules: RULES_VERSION,
      records: records.map((r) => ({
        id: r.id,
        hash: r.hash,
        tier: r.tier,
        status: r.status,
        rules: r.rules.map((x) => [x.rule, x.result]),
        dependsOn: r.dependsOn,
        sources: r.sources,
      })),
    }),
  );
}
