import type { Agreement } from "../../../src/domain/schema/corpus";
import { decimalSum } from "./audit";
import { identityTokens, partyScope, reconcileNumbers } from "./identity";
import type { AgreementIdentity, ReconciliationCase } from "./identity";
import { canonical, compare, digest, parseLocator } from "./locators";

export interface Alias {
  from: string;
  to: string[];
  reason: string;
}
export interface MigrationChange {
  oldIds: string[];
  newIds: string[];
  action:
    "new" | "update" | "split" | "merge" | "existing_merge" | "unchanged" | "missing" | "candidate";
  fields: string[];
  reason: string;
  blocked: boolean;
  beforeHashes: Record<string, string>;
  afterHashes: Record<string, string>;
}
export interface MigrationPlan {
  version: 1;
  inputHash: string;
  hash: string;
  changes: MigrationChange[];
  replacements: Agreement[];
  aliases: Alias[];
  reviewedIds: string[];
  cases: ReconciliationCase[];
}
export function resolveAlias(id: string, aliases: Alias[], path: string[] = []): string[] {
  if (path.includes(id)) throw new Error(`Alias cycle: ${[...path, id].join(" -> ")}`);
  const entries = aliases.filter((a) => a.from === id);
  if (entries.length > 1) throw new Error(`Duplicate alias source: ${id}`);
  const entry = entries[0];
  if (!entry) return [id];
  if (!entry.to.length) throw new Error(`Empty alias target: ${id}`);
  return [
    ...new Set(
      entry.to.flatMap((to) => (to === id ? [id] : resolveAlias(to, aliases, [...path, id]))),
    ),
  ].sort(compare);
}
function refs(e: Agreement["evidence"][number]): string | null {
  const fields = parseLocator(e.locator);
  if (!fields?.get("ref_number") || !fields.has("amendment_number")) return null;
  return canonical([e.sourceId, fields.get("ref_number"), fields.get("amendment_number")]);
}
/** Existing researched merge is evidence of identity, not proof of any fresh component or amount. */
function refreshMerge(old: Agreement, incoming: Agreement[]): Agreement | null {
  const earliestStart =
    incoming
      .map((a) => a.startOn)
      .filter((d): d is string => d !== null)
      .sort(compare)[0] ?? null;
  if (
    old.startOn !== earliestStart ||
    !incoming.some((a) => a.title === old.title) ||
    old.parties.some(
      (p) => !incoming.some((a) => a.parties.some((q) => canonical(p) === canonical(q))),
    ) ||
    old.externalIds.some(
      (e) => !incoming.some((a) => a.externalIds.some((f) => canonical(e) === canonical(f))),
    ) ||
    incoming.some(
      (a) =>
        a.type !== old.type ||
        a.currency !== old.currency ||
        a.repayability !== old.repayability ||
        a.programId !== old.programId,
    ) ||
    old.allocations.length ||
    old.valueStatements.length
  )
    return null;
  if (
    old.family !== "grant_contribution" ||
    old.evidence.length !== old.disclosureRows.length ||
    old.review !== null ||
    old.verification !== "proposed"
  )
    return null;
  const rows = incoming.flatMap((a) =>
    a.evidence.map((e, i) => ({ evidence: e, row: a.disclosureRows[i], key: refs(e) })),
  );
  const used = new Set<number>();
  const selected: typeof rows = [];
  const normalizeRow = (row: Agreement["disclosureRows"][number]) => ({
    ...row,
    originalValue: row.originalValue === null ? null : decimalSum([row.originalValue]),
    amendmentValue: row.amendmentValue === null ? null : decimalSum([row.amendmentValue]),
    totalValue: row.totalValue === null ? null : decimalSum([row.totalValue]),
  });
  for (let i = 0; i < old.evidence.length; i++) {
    const key = refs(old.evidence[i]!);
    const matches = rows.flatMap((r, j) =>
      key !== null &&
      r.key === key &&
      r.row &&
      !used.has(j) &&
      canonical(normalizeRow(r.row)) === canonical(normalizeRow(old.disclosureRows[i]!))
        ? [j]
        : [],
    );
    if (matches.length !== 1) return null;
    used.add(matches[0]!);
    selected.push(rows[matches[0]!]!);
  }
  if (used.size !== rows.length) return null;
  // Only row locators are refreshed. Preserve the owner's researched ordering and economics.
  return { ...old, evidence: selected.map((r) => r.evidence) };
}
const hashes = (rows: Agreement[]) => Object.fromEntries(rows.map((a) => [a.id, digest(a)]));

export function planMigration(
  existing: Agreement[],
  incoming: Agreement[],
  identities: AgreementIdentity[] = [],
  previousAliases: Alias[] = [],
): MigrationPlan {
  for (const a of previousAliases) resolveAlias(a.from, previousAliases);
  const old = [...existing].sort((a, b) => compare(a.id, b.id)),
    fresh = [...incoming].sort((a, b) => compare(a.id, b.id));
  if (
    new Set(old.map((a) => a.id)).size !== old.length ||
    new Set(fresh.map((a) => a.id)).size !== fresh.length
  )
    throw new Error("Duplicate agreement IDs in migration inputs");
  if (fresh.some((a) => a.verification !== "proposed" || a.review !== null))
    throw new Error("Migration inputs must be plain proposals");
  // Existing-only records survive apply, so they must participate in collision detection.
  const reconciliation = reconcileNumbers([
    ...old.filter((a) => !fresh.some((b) => b.id === a.id)),
    ...fresh,
  ]);
  const held = new Set(reconciliation.cases.flatMap((c) => c.ids));
  const tokens = new Map(old.map((a) => [a.id, new Set(identityTokens(a))]));
  const edges = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    edges.get(a)!.add(b);
    edges.get(b)!.add(a);
  };
  old.forEach((a) => edges.set(`old:${a.id}`, new Set()));
  fresh.forEach((a) => edges.set(`new:${a.id}`, new Set()));
  const possibleCorrections = new Set<string>();
  for (const a of old)
    for (const b of fresh) {
      if (a.id === b.id) {
        connect(`old:${a.id}`, `new:${b.id}`);
        continue;
      }
      if (partyScope(a) !== partyScope(b)) continue;
      const legacyIds = identities.find((i) => i.id === b.id)?.legacyIds ?? [];
      const legacyAlias = legacyIds.some((id) => resolveAlias(id, previousAliases).includes(a.id));
      if (
        legacyAlias &&
        !legacyIds.includes(a.id) &&
        !identityTokens(b).some((t) => tokens.get(a.id)!.has(t))
      )
        possibleCorrections.add(b.id);
      if (
        a.id === b.id ||
        identities.find((i) => i.id === b.id)?.legacyIds.includes(a.id) ||
        resolveAlias(b.id, previousAliases).includes(a.id) ||
        legacyAlias ||
        identityTokens(b).some((t) => tokens.get(a.id)!.has(t))
      )
        connect(`old:${a.id}`, `new:${b.id}`);
    }
  const seen = new Set<string>(),
    changes: MigrationChange[] = [],
    replacements: Agreement[] = [];
  const aliasMap = new Map(previousAliases.map((a) => [a.from, a]));
  const setAlias = (from: string, to: string[], reason: string) =>
    aliasMap.set(from, { from, to: [...new Set(to)].sort(compare), reason });
  const handled = new Set<string>();
  for (const start of [...edges.keys()].sort(compare)) {
    if (seen.has(start)) continue;
    const members: string[] = [],
      queue = [start];
    while (queue.length) {
      const n = queue.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      members.push(n);
      queue.push(...edges.get(n)!);
    }
    const before = old.filter((a) => members.includes(`old:${a.id}`)),
      next = fresh.filter((a) => members.includes(`new:${a.id}`));
    let after = next;
    let action: MigrationChange["action"] =
      before.length === 0
        ? "new"
        : next.length === 0
          ? "missing"
          : before.length > 1 && next.length === 1
            ? "merge"
            : before.length === 1 && next.length > 1
              ? "split"
              : "update";
    let reason = "Scoped agreement identity and explicit legacy-ID mapping";
    if (before.length === 1 && next.length > 1 && before[0]!.family === "grant_contribution") {
      const refreshed = refreshMerge(before[0]!, next);
      if (refreshed) {
        after = [refreshed];
        action = "existing_merge";
        reason =
          "Every source reference/amendment and amount matches an existing researched merge; preserve canonical ID and history";
      } else {
        action = "candidate";
        reason =
          "Possible existing merge has new, missing or conflicting rows; human reconciliation required";
      }
    } else if (before.length > 1 && next.length > 1) {
      action = "candidate";
      reason = "Many-to-many identity change requires explicit human reconciliation";
    }
    if (next.some((a) => held.has(a.id)) && action !== "existing_merge") {
      action = "candidate";
      reason = "Unresolved shared-number reconciliation; no sum or automatic merge";
    }
    if (next.some((a) => possibleCorrections.has(a.id))) {
      action = "candidate";
      reason =
        "Changed row fingerprint shares a prior batch alias; possible correction or new component, never automatic insertion";
    }
    if (before.length && next.length && new Set([...before, ...next].map(partyScope)).size > 1) {
      action = "candidate";
      reason = "Existing ID changes legal-party scope; explicit human reconciliation required";
    }
    if (
      before.length &&
      canonical(before) === canonical([...after].sort((a, b) => compare(a.id, b.id)))
    )
      action = "unchanged";
    const blocked = before.some((a) => a.review !== null || a.verification !== "proposed");
    const fields =
      before.length === 1 && after.length === 1
        ? Object.keys(after[0]!)
            .filter(
              (k) =>
                canonical(before[0]![k as keyof Agreement]) !==
                canonical(after[0]![k as keyof Agreement]),
            )
            .sort(compare)
        : ["grouping", "id", "disclosureRows", "evidence"];
    changes.push({
      oldIds: before.map((a) => a.id),
      newIds: after.map((a) => a.id),
      action,
      reason,
      fields: action === "unchanged" ? [] : fields,
      blocked,
      beforeHashes: hashes(before),
      afterHashes: hashes(after),
    });
    if (blocked || action === "candidate" || action === "missing") {
      before.forEach((a) => setAlias(a.id, [a.id], "unchanged; migration withheld"));
      continue;
    }
    replacements.push(...after);
    next.forEach((a) => handled.add(a.id));
    for (const a of before)
      setAlias(
        a.id,
        after.map((x) => x.id),
        reason,
      );
    for (const b of next) {
      setAlias(b.id, after.some((a) => a.id === b.id) ? [b.id] : after.map((a) => a.id), reason);
      for (const legacy of identities.find((i) => i.id === b.id)?.legacyIds ?? []) {
        if (before.some((a) => a.id === legacy)) continue;
        const prior = aliasMap.get(legacy)?.to ?? [];
        setAlias(
          legacy,
          [...prior, ...after.map((a) => a.id)],
          "deterministic legacy grouping-key mapping",
        );
      }
    }
  }
  const aliases = [...aliasMap.values()].sort((a, b) => compare(a.from, b.from));
  for (const a of aliases) resolveAlias(a.from, aliases);
  const payload = {
    version: 1 as const,
    inputHash: digest({
      existing: old,
      incoming: fresh,
      identities: [...identities].sort((a, b) => compare(a.id, b.id)),
      previousAliases,
    }),
    changes: changes.sort((a, b) =>
      compare(
        canonical(a.oldIds.length ? a.oldIds : a.newIds),
        canonical(b.oldIds.length ? b.oldIds : b.newIds),
      ),
    ),
    replacements: replacements.sort((a, b) => compare(a.id, b.id)),
    aliases,
    reviewedIds: old.filter((a) => a.review !== null).map((a) => a.id),
    cases: reconciliation.cases.filter((c) => !c.ids.every((id) => handled.has(id))),
  };
  return { ...payload, hash: digest(payload) };
}
