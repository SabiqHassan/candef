/**
 * Prints the full raw TBS rows for given references, so a researcher can read the recipient or
 * vendor name, address, program, title and dates before citing a row. Read-only; one pass over each
 * local file. Output goes to the terminal only (open-data rows are never committed).
 *
 *   npx tsx scripts/research/show-gov-rows.ts <ref> [<ref> …] [--data research-cache/gov-data/<date>]
 *
 * A reference is a grants `ref_number` or a contracts `reference_number`.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { readCsv } from "../../pipeline/ingest/gov/csv";

const args = process.argv.slice(2);
const at = args.indexOf("--data");
const refs = new Set(
  args.filter((a, i) => !a.startsWith("--") && (at < 0 || (i !== at && i !== at + 1))),
);
if (!refs.size) {
  console.error("usage: show-gov-rows.ts <ref> [<ref> …] [--data <dir>]");
  process.exit(1);
}
const cache = join(process.cwd(), "research-cache", "gov-data");
const newest = existsSync(cache)
  ? readdirSync(cache)
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && statSync(join(cache, n)).isDirectory())
      .sort()
      .at(-1)
  : undefined;
const data = at >= 0 ? resolve(args[at + 1]!) : newest ? join(cache, newest) : null;
if (!data || !existsSync(data)) {
  console.error("Government dataset folder not found.");
  process.exit(1);
}
const KEEP_GRANT = [
  "ref_number",
  "amendment_number",
  "recipient_type",
  "recipient_legal_name",
  "recipient_operating_name",
  "recipient_business_number",
  "recipient_city",
  "recipient_province",
  "recipient_postal_code",
  "prog_name_en",
  "agreement_title_en",
  "description_en",
  "agreement_value",
  "agreement_start_date",
  "agreement_end_date",
  "owner_org",
];
const KEEP_CONTRACT = [
  "reference_number",
  "procurement_id",
  "vendor_name",
  "vendor_postal_code",
  "contract_date",
  "description_en",
  "contract_period_start",
  "delivery_date",
  "contract_value",
  "original_value",
  "amendment_value",
  "comments_en",
  "owner_org",
];
for (const [file, key, keep] of [
  ["grants.csv", "ref_number", KEEP_GRANT],
  ["contracts.csv", "reference_number", KEEP_CONTRACT],
] as const) {
  const stream = createReadStream(join(data, file));
  for await (const row of readCsv(stream)) {
    if (!refs.has((row[key] ?? "").trim())) continue;
    console.log(
      file.slice(0, 1).toUpperCase(),
      JSON.stringify(
        Object.fromEntries(
          keep.map((k) => [k, (row[k] ?? "").trim().slice(0, 240)]).filter(([, v]) => v !== ""),
        ),
      ),
    );
  }
  stream.destroy();
}
