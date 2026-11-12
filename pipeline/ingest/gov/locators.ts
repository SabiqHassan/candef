import { createHash } from "node:crypto";
import type { ContractRow, GrantRow, SourceCells } from "./tbs";

/** Code-point ordering, independent of OS locale. Arrays deliberately retain order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compare(a, b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
/** v1 hashes original allowlisted cells, not column order, CSV quoting or line endings outside cells. */
export function rowFingerprint(row: SourceCells): string {
  return digest({ version: 1, cells: row.sourceCells ?? row });
}
export function rowLocator(kind: "contracts" | "grants", row: ContractRow | GrantRow): string {
  const fields =
    kind === "contracts" && "reference_number" in row
      ? {
          reference_number: row.reference_number,
          procurement_id: row.procurement_id,
          vendor_name: row.vendor_name,
          owner_org: row.owner_org,
        }
      : "ref_number" in row
        ? {
            ref_number: row.ref_number,
            amendment_number: String(row.amendment_number),
            agreement_number: row.agreement_number,
            recipient_legal_name: row.recipient_legal_name,
            owner_org: row.owner_org,
          }
        : {};
  return Object.entries({ ...fields, locator_version: "1", row_sha256: rowFingerprint(row) })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join(";");
}
export function parseLocator(locator: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  try {
    for (const part of locator.split(";")) {
      const at = part.indexOf("=");
      if (at < 1) return null;
      const key = part.slice(0, at).trim();
      if (fields.has(key)) return null;
      // Decode only versioned locators: legacy values may contain literal percent signs.
      fields.set(
        key,
        locator.includes("locator_version=1")
          ? decodeURIComponent(part.slice(at + 1).trim())
          : part.slice(at + 1).trim(),
      );
    }
    if (
      fields.has("locator_version") &&
      (fields.get("locator_version") !== "1" ||
        !/^[a-f0-9]{64}$/.test(fields.get("row_sha256") ?? ""))
    )
      return null;
    return fields;
  } catch {
    return null;
  }
}

/** All declared locator fields must agree; fingerprints alone never excuse mismatched readable fields. */
export function locatorMatches(fields: Map<string, string>, row: ContractRow | GrantRow): boolean {
  for (const [key, value] of fields) {
    if (key === "locator_version") continue;
    if (key === "row_sha256") {
      if (value !== rowFingerprint(row)) return false;
    } else if (!(key in row) || String(row[key as keyof typeof row] ?? "") !== value) return false;
  }
  return true;
}
