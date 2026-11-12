import type { DatasetKind } from "../tbs";
import type { PackageInfo, SearchPort } from "./client";
import { columnsFor } from "./rows";

// Live catalogue titles confirmed by package_show on 2026-10-16: contracts package
// d8f85d91-7dec-4fd1-8055-483b77225d8b (datastore resource fac950c0-00d5-4ec1-a4d3-9cbebf98a305,
// "Contracts over $10,000"); grants package 432527ab-7aac-45b5-81d6-7597107a7013 (resource
// 1d15a62f-5656-49ad-8c88-f40ce689d831).
export const PACKAGE_TITLES = {
  contracts: "Proactive Publication - Contracts",
  grants: "Proactive Disclosure - Grants and Contributions",
};
export interface MetadataPort extends SearchPort {
  packageShow(id: string): Promise<PackageInfo>;
}
/** Package IDs/slugs are operator inputs. Never bless a supplied resource UUID without metadata. */
export async function discoverResource(
  client: MetadataPort,
  kind: DatasetKind,
  packageId: string,
  resourceId?: string,
) {
  const metadata = await client.packageShow(packageId);
  const titleKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (titleKey(metadata.title) !== titleKey(PACKAGE_TITLES[kind]))
    throw new Error(`${kind}: package title does not identify the requested dataset`);
  const candidates = metadata.resources.filter(
    (r) => r.datastore_active === true && (!resourceId || r.id === resourceId),
  );
  if (!candidates.length || candidates.length > 8)
    throw new Error(`${kind}: no bounded, active datastore resource candidates in package_show`);
  const matches = [];
  for (const resource of candidates) {
    const schema = await client.search(resource.id, { limit: 0 });
    const ids = schema.fields.map((f) => f.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate API schema fields");
    if (columnsFor(kind).every((id) => ids.includes(id)) && ids.includes("_id"))
      matches.push({
        id: resource.id,
        packageId: metadata.id,
        fields: schema.fields,
        total: schema.total,
        hasReportingPeriod: ids.includes("reporting_period"),
        nonTextFingerprintFields: schema.fields
          .filter((f) => columnsFor(kind).includes(f.id) && f.type !== "text")
          .map((f) => f.id),
        confirmedBy: "package_show membership/title + datastore_search limit=0 field schema",
      });
  }
  if (matches.length !== 1)
    throw new Error(
      `${kind}: ambiguous resource or missing importer fingerprint fields/_id; provide a resource ID from package_show`,
    );
  return matches[0]!;
}
