/**
 * Machine evaluation of the blind-verification claims about government agreements (fields E01-E07)
 * and the departments they name (D01), from the latest tiers file: the strict row check T1-a against
 * the registered dataset capture, now or on the migration plan's replacement content.
 * Writes an evaluations input file for `evaluate.ts add`. Read-only on research/.
 *
 *   npx tsx scripts/research/evaluate-gov.ts <out.json>
 *
 * Every note says "machine-checked": Claude did not read these rows one by one; the deterministic
 * verifier compared every recorded value with the cited row (VERIFICATION_TIERS.md T1-a).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildInventory, type BlindCard, type Worksheet } from "../../pipeline/research/blind";
import { loadResearchCorpus } from "../../pipeline/research/load";
import type { TierRecord } from "../../pipeline/research/tiers/rules";
import type { TiersFile } from "../../pipeline/research/tiers/run";

const out = process.argv[2];
if (!out) throw new Error("usage: evaluate-gov.ts <out.json>");
const latest = (dir: string, re: RegExp) =>
  join(
    dir,
    readdirSync(dir)
      .filter((f) => re.test(f))
      .sort()
      .at(-1)!,
  );
const tiers = JSON.parse(
  readFileSync(latest("research-cache/tiers", /^tiers-.*\.json$/), "utf8"),
) as TiersFile;
const ws = JSON.parse(
  readFileSync(latest("research-cache/blind-verification", /^worksheet-.*\.json$/), "utf8"),
) as Worksheet;
const planRaw = JSON.parse(
  readFileSync("research-cache/gov-linkage/plan/migration.json", "utf8"),
) as { plan: { changes: { oldIds: string[]; action: string; fields: string[] }[] } };
const cards = JSON.parse(
  readFileSync("docs/verification/blind-v2-internal/cards.json", "utf8"),
) as BlindCard[];
const corpus = loadResearchCorpus("research").corpus!;
const inv = buildInventory(corpus, cards, new Date().toISOString().slice(0, 10));
const byId = new Map(tiers.records.map((r) => [r.id, r]));
const rows = new Map(ws.rows.map((r) => [r.claimId, r]));
const change = (id: string) => planRaw.plan.changes.find((c) => c.oldIds.includes(id));
const t1a = (r: TierRecord | undefined, projected = false) =>
  (projected ? r?.projected?.rules : r?.rules)?.find((x) => x.rule === "T1-a")?.result === "pass";

type Out = { claimId: string; outcome: string; basis?: string; note: string; proposal?: string };
const result: Out[] = [];
const verifiedAgreements = new Set<string>();
for (const it of inv.items) {
  if (it.kind !== "base" || !/^E0[1-7]$/.test(it.fieldId)) continue;
  const agreementId = it.recordIds.find((id) => id.startsWith("agr_"));
  if (!agreementId) continue;
  const rec = byId.get(agreementId);
  const ch = change(agreementId);
  const signal = rows.get(it.claimId)?.signal ?? "not_compared";
  const agreed = signal === "consistent";
  const label = agreed
    ? "an independent researcher read the same open-data row"
    : "no independent researcher matched this row";
  if (!rec) continue;
  if (t1a(rec)) {
    verifiedAgreements.add(agreementId);
    result.push({
      claimId: it.claimId,
      outcome: agreed ? "corroborated" : "not_found_independently",
      basis: agreed ? "same_document" : "none",
      note: `Machine-checked: every recorded value equals the cited row in the registered dataset capture (strict check T1-a); ${label}.`,
    });
  } else if (rec.projected && t1a(rec, true) && !ch?.fields.includes("disclosureRows")) {
    verifiedAgreements.add(agreementId);
    result.push({
      claimId: it.claimId,
      outcome: agreed ? "corroborated" : "not_found_independently",
      basis: agreed ? "same_document" : "none",
      note: `Machine-checked: the values equal the dataset rows; today's citation is a legacy batch reference that is ambiguous under the strict check, and the pending migration (${ch?.action ?? "update"}: ${ch?.fields.join(", ") ?? ""}) replaces it with an exact row locator without changing any value; ${label}.`,
    });
  } else if (rec.projected && t1a(rec, true)) {
    result.push({
      claimId: it.claimId,
      outcome: "partial",
      note: `Machine-checked: the migration changes this agreement's disclosure rows (${ch?.fields.join(", ")}). Known case: grant amendment totals recorded as original values. The migrated content matches the rows exactly.`,
      proposal: "Apply the reviewed Codex migration before approving.",
    });
  }
  // Hand-merged and hand-resolved records (no projection) stay with the owner: not evaluated here.
}
// Departments named as buyer or funder of an agreement whose rows were matched.
for (const it of inv.items) {
  if (it.kind !== "base" || it.fieldId !== "D01") continue;
  const recordId = it.recordIds[0]!;
  const org = corpus.organizations.find((o) => o.id === recordId);
  const fact = corpus.assertions.find((a) => a.id === recordId);
  const bodyId = org?.kind === "government_body" ? org.id : fact ? fact.subjectId : null;
  if (!bodyId || corpus.organizations.find((o) => o.id === bodyId)?.kind !== "government_body")
    continue;
  if (fact && fact.predicate !== "registry_id") continue;
  const used = corpus.agreements.some(
    (g) =>
      verifiedAgreements.has(g.id) &&
      g.parties.some((p) => p.orgId === bodyId && (p.role === "buyer" || p.role === "funder")),
  );
  if (!used) continue;
  result.push({
    claimId: it.claimId,
    outcome: "corroborated",
    basis: "same_document",
    note: fact
      ? "Machine-checked: the department code is the owner_org value the importer matched on rows whose values were verified (T1-a)."
      : "Machine-checked: the department is the buyer or funder named on dataset rows whose recorded values were verified (T1-a).",
  });
}
writeFileSync(out, JSON.stringify(result, null, 1));
const counts: Record<string, number> = {};
for (const r of result) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
console.log(`${result.length} machine evaluations`, counts);
