/**
 * One plain sentence per review card saying exactly what the owner is verifying (workspace "You are
 * verifying" line). Built only from the record itself; it never adds facts, and it is not part of
 * any content hash, so changing the wording never invalidates a decision.
 */
import type {
  Acquisition,
  Agreement,
  Assertion,
  Corpus,
  FinancingRound,
} from "../../src/domain/schema/corpus";

type Place = {
  city?: string | null;
  region?: string | null;
  province?: string | null;
  country?: string | null;
};

const quote = (s: string) => `“${s}”`;
/** "Kepler" gives "Kepler's"; a name ending in s gives "Kinova's"-style "Names'". */
const poss = (n: string) => (/s$/i.test(n) ? `${n}'` : `${n}'s`);
/** "285000.0" gives "285,000"; "4655725.77" gives "4,655,725.77". */
const num = (v: string) =>
  Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-CA", { maximumFractionDigits: 2 }) : v;
const place = (p: Place): string =>
  [p.city, p.region ?? p.province, p.country].filter((x): x is string => !!x).join(", ");

function ofAssertion(a: Assertion, corpus: Corpus, name: (id: string) => string): string {
  const org = name(a.subjectId);
  const v = a.value as Record<string, unknown> | string | number | null;
  const obj = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  switch (a.predicate) {
    case "description":
      return `Check that ${quote(String(v))} is an accurate one-sentence description of ${org}.`;
    case "legal_name":
      return a.validTo
        ? `Check that ${org} was formerly named ${quote(String(v))} (until ${a.validTo}).`
        : `Check that ${poss(org)} legal name is ${quote(String(v))}.`;
    case "registry_id": {
      const id = String(obj.value ?? "");
      if (obj.system === "cra-bn")
        return `Check that ${id} is ${poss(org)} CRA business number. Approving it lets government rows carrying this number count as ${poss(org)}.`;
      if (obj.system === "corporations-canada")
        return `Check that ${id} is ${poss(org)} federal corporation number (Corporations Canada).`;
      return `Check that ${id} is ${poss(org)} ${String(obj.system)} identifier.`;
    }
    case "hq_location":
      return `Check that ${poss(org)} headquarters is in ${place(obj as Place)}.`;
    case "operations_location": {
      const where = place(obj as Place);
      return obj.postalCode
        ? `Check that ${org} has an address in postal area ${String(obj.postalCode)}${where ? ` (${where})` : ""}. Approving it lets government rows with this postal area and a matching name count as ${poss(org)}.`
        : `Check that ${org} operates in ${where}.`;
    }
    case "founded_year":
      return `Check that ${org} was founded in ${String(v)}.`;
    case "classified_as": {
      const label = corpus.taxonomy.find((t) => t.id === v)?.label ?? String(v);
      return `Decide whether ${org} belongs in the CANDEF category ${quote(label)}.`;
    }
    case "eligibility":
      return obj.decision === "included"
        ? `Decide whether ${org} belongs in CANDEF (Canadian headquarters; defence, security, space or dual-use technology). The record says it does.`
        : `Decide whether ${org} should be left out of CANDEF. The record says it should.`;
    case "subsidiary_of":
      return `Check that ${org} is a subsidiary of ${name(String(v))}.`;
    case "total_raised_as_stated": {
      const money = (obj.money ?? {}) as { asStated?: string };
      return `Check that ${org} states it has raised ${quote(money.asStated ?? "an amount")}${obj.since ? ` since ${String(obj.since)}` : ""}.`;
    }
    case "public_listing":
      return `Check that ${org} is listed on ${String(obj.exchange)} under the symbol ${String(obj.ticker)}.`;
    default:
      return `Check this ${a.predicate.replace(/_/g, " ")} fact about ${org}.`;
  }
}

function ofRound(r: FinancingRound, name: (id: string) => string): string {
  const org = name(r.companyId);
  const raw = r.roundLabelAsStated ?? (r.stage ? r.stage.replace(/_/g, " ") : "funding");
  const label = /round|offering|deal|financing/i.test(raw) ? raw : `${raw} round`;
  const amounts = r.disclosures.map((d) => `${d.date}: ${d.amount.asStated}`).join("; ");
  const lead = r.participations.find((p) => p.role === "lead")?.reportedName;
  const n = r.participations.length;
  const investors =
    n === 0
      ? ""
      : ` and its ${n} named investor${n === 1 ? "" : "s"}${lead ? `, led by ${lead}` : ""}`;
  return `Check ${poss(org)} ${label} (${amounts})${investors}.`;
}

function ofAgreement(g: Agreement, name: (id: string) => string): string {
  const who = (...roles: string[]) => {
    const p = g.parties.find((x) => roles.includes(x.role));
    return p ? (p.orgId ? name(p.orgId) : p.reportedName) : "the other party";
  };
  const stated = g.valueStatements.at(-1)?.money;
  const total = g.disclosureRows.at(-1)?.totalValue ?? stated?.amount ?? null;
  const amount = total ? `${stated?.currency ?? g.currency} ${num(total)}` : "an unstated amount";
  if (g.family === "procurement")
    return `Check that ${who("buyer")} awarded ${who("prime")} the contract ${quote(g.title)} (${amount}).`;
  const program = g.externalIds.find((x) => x.system === "tbs-grants:program")?.value;
  return `Check that ${who("funder")} gave ${who("recipient")} ${amount}${program ? ` under ${program}` : ""} (agreement ${quote(g.title)}).`;
}

function ofAcquisition(q: Acquisition, name: (id: string) => string): string {
  const last = q.history.at(-1);
  return `Check that ${name(q.acquirerId)} acquired ${name(q.targetId)}${last ? ` (${last.state.replace(/_/g, " ")} ${last.date})` : ""}.`;
}

/** The sentence for one review unit, or null when the unit cannot be found. */
export function summaryOf(
  unit: { id: string; kind: string },
  corpus: Corpus,
  name: (id: string) => string,
): string | null {
  switch (unit.kind) {
    case "assertion": {
      const a = corpus.assertions.find((x) => x.id === unit.id);
      return a ? ofAssertion(a, corpus, name) : null;
    }
    case "round": {
      const r = corpus.rounds.find((x) => x.id === unit.id);
      return r ? ofRound(r, name) : null;
    }
    case "agreement": {
      const g = corpus.agreements.find((x) => x.id === unit.id);
      return g ? ofAgreement(g, name) : null;
    }
    case "acquisition": {
      const q = corpus.acquisitions.find((x) => x.id === unit.id);
      return q ? ofAcquisition(q, name) : null;
    }
    default:
      return null;
  }
}
