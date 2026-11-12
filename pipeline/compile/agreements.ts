/**
 * Agreement resolution (DATA_SCHEMA §9 + v0.3 delta, P-16, P-19).
 *
 * - Disclosure rows are cumulative; the latest row is the current total (it may be lower than
 *   the original: negative amendments are real).
 * - A consortium total is never attributed to a member unless an allocation is disclosed.
 * - Procurement and grants stay separate families; a grant never implies a customer.
 * - "Other transfer payments" are a third family: never counted as grants or as procurement, and
 *   their value is the agreement amount the source states, not a confirmed disbursement.
 */
import type { Agreement, Money } from "../../src/domain/schema/corpus";
import type { AgreementView, AttributionView } from "../../src/domain/schema/snapshot";
import { toCitations } from "./citations";
import { hasValidReview } from "./hash";

const COMPANY_ROLES = new Set(["prime", "member", "recipient", "subcontractor", "partner"]);
const INSTITUTION_ROLES = ["buyer", "funder"] as const;

export function currentValue(g: Agreement): { money: Money | null; basis: string } {
  const last = g.disclosureRows[g.disclosureRows.length - 1];
  if (last) {
    // A row without a stated total is a gap in the disclosure, never a zero.
    if (last.totalValue === null)
      return {
        money: {
          amount: null,
          currency: g.currency,
          disclosure: "undisclosed",
          asStated: "total not stated in the disclosure",
        },
        basis: g.disclosureRows.length > 1 ? "amended_total" : "award_value",
      };
    return {
      money: {
        amount: last.totalValue,
        currency: g.currency,
        disclosure: "disclosed",
        asStated: `${g.currency} ${last.totalValue}`,
      },
      basis: g.disclosureRows.length > 1 ? "amended_total" : "award_value",
    };
  }
  const awarded =
    g.valueStatements.find((v) => v.basis.stage === "awarded") ?? g.valueStatements[0];
  if (!awarded) return { money: null, basis: "unknown" };
  return { money: awarded.money, basis: awarded.basis.stage };
}

export function attributions(g: Agreement, companyIds: ReadonlySet<string>): AttributionView[] {
  const members = g.parties.filter(
    (p) =>
      COMPANY_ROLES.has(p.role) &&
      p.evidenceStrength === "party_of_record" &&
      companyIds.has(p.orgId),
  );
  const value = currentValue(g).money;
  return members.map((m) => {
    const allocation = g.allocations.find((a) => a.orgId === m.orgId);
    if (value?.disclosure === "not_applicable")
      return { orgId: m.orgId, money: null, basis: "not_applicable" };
    if (allocation) return { orgId: m.orgId, money: allocation.money, basis: "allocation" };
    if (members.length === 1) return { orgId: m.orgId, money: value, basis: "sole_party" };
    return { orgId: m.orgId, money: null, basis: "consortium_undisclosed" };
  });
}

export function buildAgreementView(
  g: Agreement,
  companyIds: ReadonlySet<string>,
  programName: string | null,
): AgreementView | null {
  if (!hasValidReview("agreement", g)) return null;
  const { money, basis } = currentValue(g);
  const counterparty =
    g.parties.find((p) => (INSTITUTION_ROLES as readonly string[]).includes(p.role)) ??
    g.parties.find((p) => p.role === "partner" && !companyIds.has(p.orgId));
  const attrib = attributions(g, companyIds);
  const cad = (m: Money | null) =>
    m && m.currency === "CAD" && m.amount !== null ? Number(m.amount) : null;
  // For the drawing threshold only: the attributable value, else the agreement total (consortium).
  const thresholdValueCad =
    g.family === "procurement"
      ? Math.max(...attrib.map((a) => cad(a.money) ?? cad(money) ?? 0), 0)
      : null;
  // One evidence entry per disclosure row is the importer's layout: row i is read from evidence i.
  // Records that keep a different layout get a record-level citation list only.
  const rowCitations =
    g.evidence.length === g.disclosureRows.length
      ? g.evidence.map((e) => ({
          sourceId: e.sourceId,
          locator: e.locator,
          quality: e.locatorQuality,
        }))
      : null;
  return {
    id: g.id,
    family: g.family,
    type: g.type,
    sourceClassification: g.sourceClassification ?? null,
    title: g.title,
    programName,
    counterpartyId: counterparty?.orgId ?? null,
    parties: g.parties.map((p) => ({
      orgId: p.orgId,
      role: p.role,
      evidenceStrength: p.evidenceStrength,
      reportedName: p.reportedName,
    })),
    currentValue: money,
    currency: g.currency,
    originalValue: g.disclosureRows[0]?.originalValue ?? null,
    valueBasis: basis,
    valueStatements: g.valueStatements.map((v) => ({
      money: v.money,
      basis: `${v.basis.stage}; options ${v.basis.options}; taxes ${v.basis.taxes}`,
      sourceIds: v.evidence.map((e) => e.sourceId),
      citations: toCitations(v.evidence),
    })),
    rows: g.disclosureRows.map((r, i) => ({
      reportingPeriod: r.reportingPeriod,
      instrument: r.instrument,
      amendmentValue: r.amendmentValue,
      totalValue: r.totalValue,
      endOnAsStated: r.endOnAsStated,
      citation: rowCitations?.[i] ?? null,
    })),
    attributions: attrib,
    announcedOn: g.announcedOn,
    startOn: g.startOn,
    status: g.statusAsOf,
    repayability: g.repayability,
    externalIds: g.externalIds,
    verification: "verified",
    epistemic: g.epistemic,
    sourceIds: [...new Set(g.evidence.map((e) => e.sourceId))],
    citations: toCitations(g.evidence),
    thresholdValueCad,
  };
}
