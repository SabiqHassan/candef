import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Agreement } from "../../../src/domain/schema/corpus";
import { identityTokens, partyScope, externalValues } from "./identity";
import { resolveAlias } from "./migration";

export const ALIAS_FILE = "_gov-linkage-aliases.json";
export const AliasManifest = z.object({
  version: z.literal(1),
  aliases: z.array(
    z.object({
      from: z.string().min(1),
      to: z.array(z.string().min(1)).min(1),
      reason: z.string(),
    }),
  ),
});
export function readAliases(root: string) {
  const file = join(root, ALIAS_FILE);
  const aliases = existsSync(file)
    ? AliasManifest.parse(JSON.parse(readFileSync(file, "utf8"))).aliases
    : [];
  for (const alias of aliases) resolveAlias(alias.from, aliases);
  return aliases;
}
/** A collision is a review candidate, not permission to overwrite or merge. */
export function existingIdentityMatches(
  a: Agreement,
  existing: Agreement[],
  aliases: ReturnType<typeof readAliases>,
): string[] {
  const targets = resolveAlias(a.id, aliases);
  const tokens = new Set(identityTokens(a));
  const numberSystem =
    a.family === "grant_contribution"
      ? "tbs-grants:agreement_number"
      : "tbs-contracts:procurement_id";
  const numbers = new Set(externalValues(a, numberSystem));
  return existing
    .filter(
      (b) =>
        a.id === b.id ||
        (partyScope(a) === partyScope(b) &&
          (targets.includes(b.id) ||
            identityTokens(b).some((t) => tokens.has(t)) ||
            externalValues(b, numberSystem).some((n) => numbers.has(n)))),
    )
    .map((b) => b.id)
    .sort();
}
