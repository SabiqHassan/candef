import type { Agreement } from "../../../src/domain/schema/corpus";
import { compare, digest, parseLocator } from "./locators";

export interface ReconciliationCase {
  key: string;
  ids: string[];
  classification: "revised_total_candidate" | "separate_component_candidate" | "unknown";
  reason: string;
}
export interface AgreementIdentity {
  id: string;
  legacyIds: string[];
  rowIds: string[];
  key: string;
  reason: string;
}
export function partyScope(a: Agreement): string {
  return JSON.stringify([
    a.family,
    a.parties
      .filter((p) => ["buyer", "funder", "prime", "recipient"].includes(p.role))
      .map((p) => `${p.role}:${p.orgId}`)
      .sort(compare),
  ]);
}
export function externalValues(a: Agreement, system: string): string[] {
  return [
    ...new Set(
      a.externalIds.filter((x) => x.system === system && x.value.trim()).map((x) => x.value.trim()),
    ),
  ].sort(compare);
}
/** Only IDs which identify an agreement within its party scope. Batches and solicitations excluded. */
export function identityTokens(a: Agreement): string[] {
  const systems =
    a.family === "procurement"
      ? ["tbs-contracts:procurement_id", "canadabuys:contractNumber"]
      : ["tbs-grants:ref_number"];
  const values = systems.flatMap((s) =>
    externalValues(a, s).map((v) => `${partyScope(a)}:${s}:${v}`),
  );
  if (a.family === "grant_contribution")
    for (const e of a.evidence) {
      const ref = parseLocator(e.locator)?.get("ref_number");
      if (ref) values.push(`${partyScope(a)}:tbs-grants:ref_number:${ref}`);
    }
  return [...new Set(values)].sort(compare);
}
export function reconcileNumbers(agreements: Agreement[]): {
  agreements: Agreement[];
  cases: ReconciliationCase[];
} {
  const groups = new Map<string, Agreement[]>();
  for (const a of agreements) {
    const values =
      a.family === "grant_contribution"
        ? externalValues(a, "tbs-grants:agreement_number")
        : [
            ...externalValues(a, "tbs-contracts:procurement_id"),
            ...externalValues(a, "canadabuys:contractNumber"),
          ];
    for (const value of values) {
      const key = JSON.stringify([partyScope(a), value]);
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
  }
  const cases: ReconciliationCase[] = [],
    held = new Set<string>();
  for (const [key, entries] of groups) {
    const group = [...new Map(entries.map((a) => [a.id, a])).values()];
    if (group.length < 2) continue;
    const programs = new Set(
      group.map((a) => JSON.stringify(externalValues(a, "tbs-grants:program"))),
    );
    const sameStart = group.every((a) => a.startOn !== null && a.startOn === group[0]!.startOn);
    const classification = group.every((a) => a.family === "grant_contribution")
      ? programs.size > 1
        ? "separate_component_candidate"
        : sameStart
          ? "revised_total_candidate"
          : "unknown"
      : "unknown";
    cases.push({
      key: digest(key),
      ids: group.map((a) => a.id).sort(compare),
      classification,
      reason:
        classification === "revised_total_candidate"
          ? "Same scoped number, program and start date; a revised total is plausible but not proven; do not sum"
          : classification === "separate_component_candidate"
            ? "Same scoped number, differing programs; separate components or a renamed program remain possible; do not sum"
            : "Shared scoped identifier without enough evidence to distinguish duplicate from separate agreement; do not sum",
    });
    group.forEach((a) => held.add(a.id));
  }
  return {
    agreements: agreements.filter((a) => !held.has(a.id)).sort((a, b) => compare(a.id, b.id)),
    cases: cases.sort((a, b) => compare(a.key, b.key)),
  };
}
