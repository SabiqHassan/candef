/**
 * The automated row check shown beside each government agreement in the owner review workspace.
 *
 * `scripts/research/gov-row-check.ts` runs the existing claim verifier once and saves, per
 * agreement, whether every recorded value equals the cited dataset row, plus the key fields of that
 * row. The workspace reads that file (if present) so the owner compares a claim with the row it
 * cites without downloading the dataset. It is an aid, never a decision: it proves the recorded
 * values equal the row, not that the row belongs to the company it was linked to.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Row = z.object({
  reference: z.string().max(200),
  amendment: z.string().max(20).nullable(),
  reportedName: z.string().max(400),
  operatingName: z.string().max(400).nullable(),
  businessNumber: z.string().max(40).nullable(),
  postalArea: z.string().max(10).nullable(),
  department: z.string().max(400),
  program: z.string().max(400).nullable(),
  value: z.string().max(40).nullable(),
  start: z.string().max(20).nullable(),
  end: z.string().max(20).nullable(),
});
export type GovCheckRow = z.infer<typeof Row>;

export const GovCheck = z.object({
  format: z.literal("candef-gov-row-check"),
  version: z.literal(1),
  dataset: z.string().max(40),
  datasetChecksums: z.array(z.string().max(200)).max(8),
  checkedAt: z.string().max(40),
  results: z.record(
    z.string().max(200),
    z.object({
      verdict: z.enum(["match", "findings"]),
      findings: z.array(z.string().max(200)).max(50),
      rows: z.array(Row).max(6),
    }),
  ),
});
export type GovCheckFile = z.infer<typeof GovCheck>;

/** The newest valid result file in `<cacheDir>/review`, or null (the workspace then simply omits it). */
export function readGovCheck(cacheDir: string): GovCheckFile | null {
  const dir = join(cacheDir, "review");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /^gov-check-.*\.json$/.test(f))
    .sort()
    .reverse();
  for (const f of files) {
    try {
      const parsed = GovCheck.safeParse(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      // Unreadable: try the next older file.
    }
  }
  return null;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** HTML for one agreement: the verdict, the cited row's key fields, and what the check does not show. */
export function govCheckHtml(check: GovCheckFile | null, agreementId: string): string {
  if (!check) return "";
  const r = check.results[agreementId];
  if (!r)
    return `<div class="rowcheck muted">Row check: this agreement was not in the automated check (dataset ${esc(check.dataset)}).</div>`;
  const verdict =
    r.verdict === "match"
      ? '<span class="ok">Every recorded value equals the cited dataset row.</span>'
      : `<span class="bad">The recorded values differ from the cited row (${r.findings.map(esc).join(", ")}). Do not approve until this is resolved.</span>`;
  const rows = r.rows
    .map(
      (x) =>
        `<tr><td>${esc(x.reference)}${x.amendment !== null ? ` / amendment ${esc(x.amendment)}` : ""}</td><td>${esc(x.reportedName)}${x.operatingName ? ` <span class="muted">(operating: ${esc(x.operatingName)})</span>` : ""}</td><td>${esc(x.businessNumber ?? "")}</td><td>${esc(x.postalArea ?? "")}</td><td>${esc(x.department)}</td><td>${esc(x.value ?? "")}</td><td>${esc(x.start ?? "")}${x.end ? ` to ${esc(x.end)}` : ""}</td></tr>`,
    )
    .join("");
  return `<div class="rowcheck"><h4>Automated row check <span class="muted">(dataset ${esc(check.dataset)})</span></h4><p>${verdict}</p>${
    rows
      ? `<table class="rowtable"><thead><tr><th>Reference</th><th>Recipient as reported</th><th>BN</th><th>Postal area</th><th>Department</th><th>Value</th><th>Dates</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="muted">The cited row could not be shown.</p>'
  }<p class="muted">This confirms the values match the dataset row. It does not decide that the recipient named in the row is the company this claim is attached to: check the name, business number and postal area above against the company.</p></div>`;
}
