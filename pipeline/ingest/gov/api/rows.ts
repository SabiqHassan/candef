import { rowLocator } from "../locators";
import { toContractRow, toGrantRow } from "../tbs";
import type { DatasetKind } from "../tbs";
import type { ApiRecord } from "./client";

// Derive the allowlist from the importer's own sourceCells projection. No contact fields.
const contractColumns = Object.keys(toContractRow({}).sourceCells!);
const grantColumns = Object.keys(toGrantRow({ amendment_number: "0" }).sourceCells!);
export function columnsFor(kind: DatasetKind): string[] {
  return [...(kind === "contracts" ? contractColumns : grantColumns)];
}
export function project(kind: DatasetKind, raw: ApiRecord): Record<string, string> {
  return Object.fromEntries(
    columnsFor(kind).map((key) => {
      const value = raw[key];
      if (
        value !== undefined &&
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      )
        throw new Error(`Unsupported API cell type in ${key}`);
      if (
        typeof value === "number" &&
        (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      )
        throw new Error(`Lossy numeric API cell in ${key}`);
      return [key, value == null ? "" : String(value)];
    }),
  );
}
export function locatorFor(kind: DatasetKind, raw: ApiRecord): string {
  const cells = project(kind, raw);
  return kind === "contracts"
    ? rowLocator(kind, toContractRow(cells))
    : rowLocator(kind, toGrantRow(cells));
}
