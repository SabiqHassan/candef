import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { Agreement } from "../../src/domain/schema/corpus";
import { loadResearchCorpus } from "./load";
import { collectCitedRefs, loadRawRows, verifyCorpus } from "./verifyGovClaims";

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      proposals: { type: "string" },
      "contracts-source": { type: "string" },
      "grants-source": { type: "string" },
      "counts-only": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.proposals && (!values["contracts-source"] || !values["grants-source"]))
    throw new Error(
      "Proposal verification requires --contracts-source and --grants-source to bind local captures",
    );
  const root = process.cwd();
  const cache = join(root, "research-cache", "gov-data");
  const newest = existsSync(cache)
    ? readdirSync(cache)
        .filter(
          (name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && statSync(join(cache, name)).isDirectory(),
        )
        .sort()
        .at(-1)
    : undefined;
  const data = values.data ? resolve(values.data) : newest ? join(cache, newest) : null;
  if (!data || !existsSync(data)) {
    console.log("Government claim check skipped: data folder absent.");
    return 0;
  }
  const loaded = loadResearchCorpus(join(root, "research"));
  if (!loaded.corpus || loaded.issues.length) {
    console.error(`Cannot load research corpus: ${loaded.issues.length} issue(s).`);
    for (const issue of loaded.issues.slice(0, 50))
      console.error(`${issue.file}:${issue.path}: ${issue.message}`);
    return 1;
  }
  const agreements = values.proposals
    ? z.array(Agreement).parse(JSON.parse(readFileSync(values.proposals, "utf8")))
    : loaded.corpus.agreements;
  const rows = await loadRawRows(
    join(data, "contracts.csv"),
    join(data, "grants.csv"),
    collectCitedRefs(agreements),
  );
  const result = verifyCorpus(agreements, rows, {
    strictLocators: true,
    datasetSources: { contracts: values["contracts-source"], grants: values["grants-source"] },
  });
  console.log(
    `Government agreements checked: ${result.agreementsChecked}; findings: ${result.findings.length}`,
  );
  const counts = new Map<string, number>();
  for (const finding of result.findings) {
    const type = finding.field.replace(/\[\d+\]/g, "[]");
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  for (const [type, count] of [...counts].sort(([a], [b]) => a.localeCompare(b)))
    console.log(`  ${type}: ${count}`);
  if (!values["counts-only"])
    for (const finding of result.findings.slice(0, 50)) console.log(JSON.stringify(finding));
  return result.findings.length ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
