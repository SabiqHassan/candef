import type { OrgView } from "./schema/snapshot";

export type GovernmentJurisdiction = "canadian" | "foreign" | "unknown" | "other";

/** Jurisdiction is supported by a published country fact, never inferred from a name or URL. */
export function governmentJurisdiction(org: OrgView | undefined): GovernmentJurisdiction {
  if (!org || org.kind !== "government_body") return "other";
  const country = org.hq.state === "verified" ? org.hq.value?.country?.trim() : null;
  if (!country || (!/^[A-Z]{2}$/.test(country) && country !== "international")) return "unknown";
  return country === "CA" ? "canadian" : "foreign";
}
