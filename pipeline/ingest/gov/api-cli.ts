/** Run: npx tsx pipeline/ingest/gov/api-cli.ts [gov-api] new-rows|lookup --help */
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CkanClient } from "./api/client";
import { inspectLocal, lookup, newRows, parseQueries, periodKey } from "./api/discovery";
import { discoverResource, PACKAGE_TITLES } from "./api/resources";
import type { DatasetKind } from "./tbs";

const HELP = `gov-api: read-only discovery leads, never evidence or records.
Usage: npx tsx pipeline/ingest/gov/api-cli.ts [gov-api] <command> [options]
  new-rows --since YYYY-YYYY-Qn
  lookup --names <JSON file>
Options:
  --dataset contracts|grants|all (default all)
  --contracts <CSV path>  --grants <CSV path>
  --contracts-package <CKAN package ID/slug>  --grants-package <ID/slug>
  --contracts-resource <resource ID>  --grants-resource <resource ID>
  --max-pages 1..50 (per dataset; default 50; 100 total hard cap)
  --page-size 1..1000 (default 1000)
  --terms-reviewed (owner has read the open.canada.ca terms and https://open.canada.ca/en/open-government-licence-canada)
CSV defaults: research-cache/gov-data/2026-10-13/{contracts,grants}.csv
Output: research-cache/gov-api/<timestamp>-<command>.json
Grants without reporting_period are explicitly unsupported for new-rows.
Names and BN roots are exact normalized discovery matches. Capped counts are lower bounds.`;

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      since: { type: "string" },
      names: { type: "string" },
      dataset: { type: "string", default: "all" },
      contracts: { type: "string" },
      grants: { type: "string" },
      "contracts-package": { type: "string" },
      "grants-package": { type: "string" },
      "contracts-resource": { type: "string" },
      "grants-resource": { type: "string" },
      "max-pages": { type: "string", default: "50" },
      "page-size": { type: "string", default: "1000" },
      "terms-reviewed": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (positionals[0] === "gov-api") positionals.shift();
  const command = positionals[0];
  if (positionals.length !== 1 || (command !== "lookup" && command !== "new-rows"))
    throw new Error(HELP);
  if (!["contracts", "grants", "all"].includes(values.dataset!))
    throw new Error("Invalid --dataset");
  const maxPages = Number(values["max-pages"]),
    limit = Number(values["page-size"]);
  if (
    !Number.isInteger(maxPages) ||
    maxPages < 1 ||
    maxPages > 50 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error("Invalid page cap/size");
  if (command === "new-rows") {
    if (!values.since) throw new Error("new-rows requires --since");
    periodKey(values.since);
  }
  if (command === "lookup" && !values.names) throw new Error("lookup requires --names");
  const queries =
    command === "lookup"
      ? parseQueries(JSON.parse(await readFile(resolve(values.names!), "utf8")))
      : [];
  const datasets: DatasetKind[] =
    values.dataset === "all" ? ["contracts", "grants"] : [values.dataset as DatasetKind];
  const client = new CkanClient({ termsReviewed: values["terms-reviewed"] });
  const report = {
    version: 1,
    purpose: "discovery-only; leads are never evidence and never create records",
    generatedAt: new Date().toISOString(),
    command,
    fingerprintCaveat:
      "API JSON may coerce CSV cell formats. A nonmatching fingerprint is only a lead; re-download a dated fingerprinted file before citing. Offset paging is not a transactional snapshot and cannot find late rows in older periods.",
    datasets: [] as unknown[],
    stopped: false,
  };
  let exit = 0;
  for (const kind of datasets) {
    const path = resolve(values[kind] ?? `research-cache/gov-data/2026-10-13/${kind}.csv`);
    try {
      // Inspect local periods before touching the network, including the unsupported grants case.
      const local =
        command === "new-rows" ? await inspectLocal(kind, createReadStream(path)) : null;
      if (local && (!local.hasReportingPeriod || !local.newestPeriod)) {
        report.datasets.push({
          kind,
          local,
          discovery: await newRows(client, "", kind, local, values.since!),
        });
        exit = 2;
        continue;
      }
      const packageId =
        values[`${kind}-package`] ?? (await client.findPackage(PACKAGE_TITLES[kind]));
      const resource = await discoverResource(client, kind, packageId, values[`${kind}-resource`]);
      if (command === "new-rows" && !resource.hasReportingPeriod) {
        report.datasets.push({
          kind,
          local,
          resource,
          status: "unsupported",
          reason: "API has no reporting_period",
          complete: false,
        });
        exit = 2;
        continue;
      }
      const discovery =
        command === "new-rows"
          ? await newRows(client, resource.id, kind, local!, values.since!, { maxPages, limit })
          : await lookup(client, resource.id, kind, createReadStream(path), queries, {
              maxPages,
              limit,
            });
      report.datasets.push({ kind, local, resource, discovery });
      if (!discovery.complete) exit = 2;
    } catch (error) {
      // Our transport errors exclude server bodies; do not log arbitrary JSON/CSV values or parser messages.
      const message = error instanceof Error ? error.message : "Discovery failed";
      const safe =
        /^(Request refused|Request blocked|Client stopped|Access challenge|robots|API |HTTP |Owner must review|Network request|No unique exact-title|Package discovery|contracts:|grants:|Invalid reporting_period|Empty page|Invalid or repeated API|Expected plain JSON|CKAN action|Duplicate API schema|Response exceeds|Hard page cap)/.test(
          message,
        )
          ? message
          : "Discovery failed; inspect input schema/format locally (source values withheld)";
      report.datasets.push({ kind, status: "failed", complete: false, error: safe });
      report.stopped = true;
      exit = 1;
      break;
    }
  }
  const directory = resolve("research-cache/gov-api");
  await mkdir(directory, { recursive: true });
  const output = join(directory, `${report.generatedAt.replace(/[:.]/g, "-")}-${command}.json`);
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  console.log(`Discovery report: ${output} (exit ${exit}; API results are leads only)`);
  return exit;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error(
        "gov-api: invalid arguments or unreadable input; use --help. Source values withheld.",
      );
      process.exitCode = 1;
    });
}
