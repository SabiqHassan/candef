import { businessNumberRoot, nameKeys, postalFsa } from "../../research/names";
import { compare, rowFingerprint, rowLocator } from "./locators";
import { matchRecipient } from "./match";
import type { MatchResult, Recipient, RecipientIndex } from "./match";
import type { ContractRow, GrantRow } from "./tbs";

export interface LinkInput {
  rowId: string;
  dataset: "contracts" | "grants";
  reference: string;
  locator: string;
  recipient: Recipient;
  /** Typed, department-scoped agreement keys; never a name, BN or contract batch. */
  keys: string[];
}
export interface LinkDecision extends MatchResult {
  rowId: string;
  dataset: LinkInput["dataset"];
  locator: string;
  outcome: "linked" | "candidate" | "excluded";
  reasons: string[];
  anchors: string[];
}
export function contractLink(row: ContractRow): LinkInput {
  const department = row.owner_org || row.buyer_name;
  return {
    rowId: `contracts:${rowFingerprint(row)}`,
    dataset: "contracts",
    reference: row.reference_number,
    locator: rowLocator("contracts", row),
    recipient: {
      names: [row.vendor_name],
      businessNumber: null,
      postal: row.vendor_postal_code || null,
    },
    keys:
      department && row.procurement_id
        ? [JSON.stringify(["contracts", department, row.procurement_id])]
        : [],
  };
}
export function grantLink(row: GrantRow): LinkInput {
  return {
    rowId: `grants:${rowFingerprint(row)}`,
    dataset: "grants",
    reference: row.ref_number,
    locator: rowLocator("grants", row),
    recipient: {
      names: [row.recipient_legal_name, row.recipient_operating_name].filter(Boolean),
      businessNumber: row.recipient_business_number || null,
      postal: row.recipient_postal_code || null,
    },
    keys: row.owner_org
      ? [
          ...(row.ref_number
            ? [JSON.stringify(["grants-ref", row.owner_org, row.ref_number])]
            : []),
          ...(row.agreement_number
            ? [JSON.stringify(["grants-number", row.owner_org, row.agreement_number])]
            : []),
        ]
      : [],
  };
}

/** Two finite propagation stages. Only independent direct seeds teach identifiers; no recursive name learning. */
export function linkRows(inputs: readonly LinkInput[], index: RecipientIndex): LinkDecision[] {
  const rows = [...inputs].sort((a, b) => compare(a.rowId, b.rowId));
  const decisions = rows.map((r): LinkDecision => {
    const match = matchRecipient(r.recipient, index);
    return {
      ...match,
      rowId: r.rowId,
      dataset: r.dataset,
      locator: r.locator,
      outcome:
        match.status === "confirmed"
          ? "linked"
          : match.status === "ambiguous"
            ? "candidate"
            : "excluded",
      reasons: [match.method],
      anchors: [],
    };
  });
  const candidate = (d: LinkDecision, reason: string) => {
    d.status = "ambiguous";
    d.outcome = "candidate";
    d.method = reason;
    d.reasons = [...new Set([...d.reasons, reason])].sort(compare);
    d.anchors = [];
  };
  const groups = new Map<string, number[]>();
  rows.forEach((r, i) => r.keys.forEach((k) => groups.set(k, [...(groups.get(k) ?? []), i])));
  // A contradictory/unresolved party poisons the key, including already confirmed rows.
  const blocked = new Set<number>();
  for (const members of groups.values()) {
    const orgs = new Set(members.flatMap((i) => decisions[i]!.candidates));
    const roots = new Set(
      members
        .map((i) => businessNumberRoot(rows[i]!.recipient.businessNumber))
        .filter((r): r is string => r !== null),
    );
    if (
      roots.size > 1 ||
      orgs.size > 1 ||
      members.some((i) => {
        const d = decisions[i]!;
        return d.status !== "confirmed" && d.method !== "name_only";
      })
    )
      for (const i of members) blocked.add(i);
  }
  // Do not let a blocked bridge contaminate a neighboring key.
  let changed = true;
  while (changed) {
    changed = false;
    for (const members of groups.values())
      if (members.some((i) => blocked.has(i)))
        for (const i of members)
          if (!blocked.has(i)) {
            blocked.add(i);
            changed = true;
          }
  }
  for (const i of blocked)
    if (decisions[i]!.candidates.length) candidate(decisions[i]!, "agreement_identity_conflict");

  const seeds = decisions.flatMap((d, i) => (d.status === "confirmed" ? [i] : []));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!,
      d = decisions[i]!;
    if (blocked.has(i) || d.method !== "name_only" || d.candidates.length !== 1) continue;
    const names = new Set(row.recipient.names.flatMap(nameKeys));
    const bn = businessNumberRoot(row.recipient.businessNumber),
      fsa = postalFsa(row.recipient.postal);
    const anchors = seeds.filter((j) => {
      const anchor = rows[j]!,
        seed = decisions[j]!;
      if (
        seed.orgId !== d.orgId ||
        !anchor.recipient.names.flatMap(nameKeys).some((n) => names.has(n))
      )
        return false;
      return (
        (bn !== null && bn === businessNumberRoot(anchor.recipient.businessNumber)) ||
        (seed.method === "name+bn" && fsa !== null && fsa === postalFsa(anchor.recipient.postal))
      );
    });
    if (anchors.length) {
      d.status = "confirmed";
      d.outcome = "linked";
      d.method = bn ? "anchor+bn" : "anchor+postal";
      d.anchors = anchors.map((j) => rows[j]!.rowId).sort(compare);
      d.reasons.push(d.method);
    }
  }
  // Group-based propagation can cross periods/references, but not a conflicting party or dataset family.
  changed = true;
  while (changed) {
    changed = false;
    for (const [key, members] of [...groups].sort(([a], [b]) => compare(a, b))) {
      if (members.some((i) => blocked.has(i))) continue;
      const anchors = members.filter((i) => decisions[i]!.status === "confirmed");
      if (!anchors.length) continue;
      for (const i of members) {
        const d = decisions[i]!;
        if (
          d.method !== "name_only" ||
          d.candidates.length !== 1 ||
          d.orgId !== decisions[anchors[0]!]!.orgId
        )
          continue;
        d.status = "confirmed";
        d.outcome = "linked";
        d.method = "agreement_anchor";
        d.anchors = [
          ...new Set(
            anchors.flatMap((j) =>
              decisions[j]!.anchors.length ? decisions[j]!.anchors : [rows[j]!.rowId],
            ),
          ),
        ].sort(compare);
        d.reasons.push(`same scoped identifier ${key}`);
        changed = true;
      }
    }
  }
  return decisions;
}
