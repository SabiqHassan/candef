/**
 * Runs the existing government-claim verifier once and saves a compact result for the owner review
 * workspace: per agreement, whether every recorded value equals the cited dataset row, and the key
 * fields of that row, so the owner compares the claim with the row without opening a 2 GB CSV.
 *
 *   npx tsx scripts/research/gov-row-check.ts [--data research-cache/gov-data/<date>]
 *
 * Writes research-cache/review/gov-check-<date>.json (gitignored; open-data row fields, never
 * committed). Read-only on research/. It uses only the verifier's exported functions; it does not
 * change the importer, the verifier or the agreement schema.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadResearchCorpus } from "../../pipeline/research/load";
import {
  collectCitedRefs,
  loadRawRows,
  verifyAgreement,
} from "../../pipeline/research/verifyGovClaims";
import type { GovCheckFile, GovCheckRow } from "../../pipeline/research/govCheck";

const root = process.cwd();
const cache = join(root, "research-cache", "gov-data");
const flagAt = process.argv.indexOf("--data");
const newest = existsSync(cache)
  ? readdirSync(cache)
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && statSync(join(cache, n)).isDirectory())
      .sort()
      .at(-1)
  : undefined;
const data = flagAt > 0 ? resolve(process.argv[flagAt + 1]!) : newest ? join(cache, newest) : null;
if (!data || !existsSync(data)) {
  console.error("Government dataset folder not found (research-cache/gov-data/<date>).");
  process.exit(1);
}

const loaded = loadResearchCorpus(join(root, "research"));
if (!loaded.corpus) {
  console.error("research/ does not load; run `candef validate`.");
  process.exit(1);
}
const agreements = loaded.corpus.agreements.filter(
  (a) => a.id.startsWith("agr_tbs_c_") || a.id.startsWith("agr_tbs_g_"),
);
const rows = await loadRawRows(
  join(data, "contracts.csv"),
  join(data, "grants.csv"),
  collectCitedRefs(agreements),
);

/** `ref_number=…;amendment_number=…` (or reference_number for contracts) from an evidence locator. */
function parseLocator(locator: string) {
  const parts = new Map(
    locator.split(";").map((p) => {
      const at = p.indexOf("=");
      return [p.slice(0, at).trim(), p.slice(at + 1).trim()] as const;
    }),
  );
  return {
    ref: parts.get("ref_number") ?? parts.get("reference_number") ?? null,
    amendment: parts.get("amendment_number") ?? null,
  };
}

const results: GovCheckFile["results"] = {};
for (const a of agreements) {
  const findings = verifyAgreement(a, rows);
  const shown: GovCheckRow[] = [];
  const seen = new Set<string>();
  for (const loc of new Set(a.evidence.flatMap((e) => e.locator.split(/;\s+(?=ref)/)))) {
    const { ref, amendment } = parseLocator(loc);
    if (!ref || seen.has(`${ref}|${amendment}`)) continue;
    seen.add(`${ref}|${amendment}`);
    if (a.id.startsWith("agr_tbs_g_")) {
      for (const r of rows.grants.get(ref) ?? [])
        if (amendment === null || String(r.amendment_number) === amendment)
          shown.push({
            reference: ref,
            amendment: String(r.amendment_number),
            reportedName: r.recipient_legal_name,
            operatingName: r.recipient_operating_name || null,
            businessNumber: r.recipient_business_number || null,
            postalArea: (r.recipient_postal_code || "").slice(0, 3) || null,
            department: r.owner_org_title,
            program: r.prog_name_en || null,
            value: r.agreement_value,
            start: r.agreement_start_date,
            end: r.agreement_end_date,
          });
    } else {
      for (const r of rows.contracts.get(ref) ?? [])
        shown.push({
          reference: ref,
          amendment: null,
          reportedName: r.vendor_name,
          operatingName: null,
          businessNumber: null,
          postalArea: (r.vendor_postal_code || "").slice(0, 3) || null,
          department: r.owner_org_title,
          program: null,
          value: r.contract_value,
          start: r.contract_period_start ?? r.contract_date,
          end: r.delivery_date,
        });
    }
  }
  results[a.id] = {
    verdict: findings.length ? "findings" : "match",
    findings: findings.map((f) => f.field),
    rows: shown.slice(0, 6),
  };
}

const sums = existsSync(join(data, "SHA256SUMS"))
  ? readFileSync(join(data, "SHA256SUMS"), "utf8")
  : "";
const file: GovCheckFile = {
  format: "candef-gov-row-check",
  version: 1,
  dataset: data.split(/[\\/]/).at(-1)!,
  datasetChecksums: sums.trim().split("\n").slice(0, 4),
  checkedAt: new Date().toISOString(),
  results,
};
const out = join(root, "research-cache", "review");
mkdirSync(out, { recursive: true });
const path = join(out, `gov-check-${file.dataset}.json`);
writeFileSync(path, JSON.stringify(file));
const counts = { match: 0, findings: 0 };
for (const r of Object.values(results)) counts[r.verdict]++;
console.log(
  `gov row check → ${path}: ${counts.match} agreements match their rows, ${counts.findings} have findings`,
);
