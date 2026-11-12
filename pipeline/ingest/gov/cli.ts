import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  selectColumn,
  toCanadaBuysRow,
  validateHeader as validateCanadaBuysHeader,
} from "./canadabuys";
import type { CanadaBuysRow } from "./canadabuys";
import { readCsv } from "./csv";
import { groupContracts, groupGrants, groupCanadaBuys } from "./group";
import type { GroupResult, MatchedRow } from "./group";
import {
  assertMagnitudeCounts,
  assertNegativeControl,
  buildIndex,
  countMagnitude,
  matchRecipient,
} from "./match";
import type { IndexEntity } from "./match";
import { writeReviewOutputs } from "./output";
import {
  createCanadaBuysReport,
  createReport,
  increment,
  recordMatch,
  renderReport,
  sortReport,
} from "./report";
import type { MatchReport, ReportDataset } from "./report";
import { parseDate, validateHeader } from "./tbs";
import { scanTbs } from "./scan";
import { canonical } from "./locators";
import { reconcileNumbers } from "./identity";
import { existingIdentityMatches, readAliases } from "./aliases";
import { loadResearchCorpus } from "../../research/load";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
function entitiesFromJson(value: unknown): IndexEntity[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry: unknown) =>
        isRecord(entry) &&
        typeof entry.orgId === "string" &&
        entry.orgId.trim() &&
        stringArray(entry.names) &&
        stringArray(entry.businessNumbers) &&
        stringArray(entry.postalFsas),
    )
  )
    throw new Error(
      "Invalid index: expected entities with orgId, names, businessNumbers and postalFsas",
    );
  return value as IndexEntity[];
}
function bodiesFromJson(value: unknown): Record<string, string> {
  if (
    !isRecord(value) ||
    !Object.values(value).every((item) => typeof item === "string" && item.trim())
  )
    throw new Error("Invalid bodies: expected department-to-orgId string map");
  return value as Record<string, string>;
}

/** Resolves existing ancestors to block junction/symlink aliases into research as well. */
export async function assertOutputPath(output: string): Promise<string> {
  const lexical = resolve(output);
  const isResearch = (path: string) =>
    path.split(/[\\/]/).some((component) => component.toLowerCase() === "research");
  if (isResearch(lexical)) throw new Error("Refusing --out inside research/");
  let ancestor = lexical;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = join(await realpath(ancestor), ...suffix.reverse());
      if (isResearch(canonical)) throw new Error("Refusing --out resolving inside research/");
      return canonical;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      if (ancestor === parse(ancestor).root) throw error;
      suffix.push(parse(ancestor).base);
      ancestor = dirname(ancestor);
    }
  }
}
interface CliOptions {
  out: string;
  index: string;
  bodies: string;
  date: string;
  research?: string;
  maxPerOrg?: number;
  contracts?: string;
  grants?: string;
  contractsSource?: string;
  grantsSource?: string;
  canadabuys?: string;
  canadabuysSource?: string;
}
function optionsFromArgs(args: string[]): CliOptions {
  const keys = [
    "out",
    "index",
    "bodies",
    "contracts",
    "contracts-source",
    "grants",
    "grants-source",
    "canadabuys",
    "canadabuys-source",
    "max-per-org",
    "date",
    "research",
  ];
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(keys.map((key) => [key, { type: "string" as const }])),
    strict: true,
    allowPositionals: false,
  });
  const get = (key: string): string | undefined => {
    const value = values[key];
    return typeof value === "string" ? value.trim() : undefined;
  };
  const needed = (key: string): string => {
    const value = get(key);
    if (!value) throw new Error(`Missing --${key}`);
    return value;
  };
  const date = get("date") ?? new Date().toISOString().slice(0, 10);
  if (!parseDate(date)) throw new Error("Invalid --date: expected a valid YYYY-MM-DD");
  const limit = get("max-per-org");
  if (limit !== undefined && (!/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit))))
    throw new Error("Invalid --max-per-org: expected a nonnegative integer");
  for (const kind of ["contracts", "grants", "canadabuys"] as const) {
    if (Boolean(get(kind)) !== Boolean(get(`${kind}-source`)))
      throw new Error(`--${kind} and --${kind}-source must be supplied together`);
  }
  if (!get("contracts") && !get("grants") && !get("canadabuys"))
    throw new Error("Supply --contracts, --grants or --canadabuys with its source ID");
  return {
    out: needed("out"),
    index: needed("index"),
    bodies: needed("bodies"),
    date,
    research: get("research"),
    maxPerOrg: limit === undefined ? undefined : Number(limit),
    contracts: get("contracts"),
    grants: get("grants"),
    contractsSource: get("contracts-source"),
    grantsSource: get("grants-source"),
    canadabuys: get("canadabuys"),
    canadabuysSource: get("canadabuys-source"),
  };
}
async function* records(path: string, kind: ReportDataset) {
  let headerSeen = false;
  const validate = (headers: string[]) =>
    kind === "canadabuys" ? validateCanadaBuysHeader(headers) : validateHeader(kind, headers);
  for await (const record of readCsv(
    createReadStream(path),
    (headers) => {
      validate(headers);
      headerSeen = true;
    },
    kind === "canadabuys" ? selectColumn : undefined,
  ))
    yield record;
  if (!headerSeen) validate([]);
}
function mergeGrouping(report: MatchReport, result: GroupResult): void {
  for (const [department, count] of Object.entries(result.unmappedDepartments))
    increment(report.unmappedDepartments, department, count);
  // Row-level diagnostics were collected for all input rows, including unmatched rows.
  report.warnings.push(...result.warnings.filter((warning) => warning.reason.startsWith("group ")));
}

export async function runCli(args: string[]): Promise<MatchReport> {
  const options = optionsFromArgs(args);
  const output = await assertOutputPath(options.out);
  const entities = entitiesFromJson(JSON.parse(await readFile(options.index, "utf8")) as unknown);
  const bodies = bodiesFromJson(JSON.parse(await readFile(options.bodies, "utf8")) as unknown);
  const index = buildIndex(entities);
  assertNegativeControl(index);
  const report = createReport(options.date);
  const magnitude = new Map<string, number>();
  const canadabuys: MatchedRow<CanadaBuysRow>[] = [];
  const linked = await scanTbs(
    [
      ...(options.contracts ? [{ kind: "contracts" as const, path: options.contracts }] : []),
      ...(options.grants ? [{ kind: "grants" as const, path: options.grants }] : []),
    ],
    index,
    report,
    magnitude,
  );
  if (options.canadabuys) {
    const stats = createCanadaBuysReport();
    report.canadaBuys = stats;
    report.rowsByDataset.canadabuys = 0;
    for await (const record of records(options.canadabuys, "canadabuys")) {
      const row = toCanadaBuysRow(record);
      const recipient = {
        names: [row.supplierLegalName, row.supplierOperatingName].filter((name) => name.trim()),
        businessNumber: null,
        postal: row.supplierPostal || null,
      };
      const match = matchRecipient(recipient, index);
      recordMatch(
        report,
        "canadabuys",
        row.contractNumber || row.referenceNumber,
        recipient,
        match,
      );
      countMagnitude(match, magnitude);
      stats.rowsRead++;
      increment(stats.countsByContractStatus, row.status || "not stated");
      stats.countsByMatchStatus[match.status]++;
      if (row.currencyDefaulted) stats.currencyCadPerPspcDocumentation++;
      if (row.endUserEntitiesName) increment(stats.endUserEntities, row.endUserEntitiesName);
      if (match.status === "confirmed") canadabuys.push({ row, match });
    }
  }
  assertMagnitudeCounts(magnitude, report.rowsRead, options.maxPerOrg);
  const contractResult = groupContracts(linked.contracts, {
    bodies,
    sourceId: options.contractsSource ?? "",
    date: options.date,
  });
  const grantResult = groupGrants(linked.grants, {
    bodies,
    sourceId: options.grantsSource ?? "",
    date: options.date,
  });
  mergeGrouping(report, contractResult);
  mergeGrouping(report, grantResult);
  const canadaBuysResult = groupCanadaBuys(canadabuys, {
    bodies,
    sourceId: options.canadabuysSource ?? "",
    date: options.date,
  });
  mergeGrouping(report, canadaBuysResult);
  if (report.canadaBuys)
    report.canadaBuys.skippedCancelledGroups = canadaBuysResult.skippedCancelledGroups;
  const allAgreements = [
    ...contractResult.agreements,
    ...grantResult.agreements,
    ...canadaBuysResult.agreements,
  ];
  const reconciled = reconcileNumbers(allAgreements);
  const existing = options.research ? loadResearchCorpus(options.research) : null;
  if (existing && !existing.corpus) throw new Error("Existing research corpus does not validate");
  const aliases = options.research ? readAliases(options.research) : [];
  const existingMatches = allAgreements.flatMap((a) => {
    const ids = existingIdentityMatches(a, existing?.corpus?.agreements ?? [], aliases);
    return ids.length
      ? [
          {
            id: a.id,
            existingIds: ids,
            reason: "Existing identity or alias; inspect migration plan instead of re-accepting",
          },
        ]
      : [];
  });
  const suppressed = new Set(existingMatches.map((a) => a.id));
  const agreements = reconciled.agreements.filter((a) => !suppressed.has(a.id));
  report.proposedAgreements = agreements.length;
  sortReport(report);
  // Validate again immediately before writing, in case an existing ancestor changed.
  const checkedOutput = await assertOutputPath(output);
  await mkdir(checkedOutput, { recursive: true });
  await writeReviewOutputs(checkedOutput, {
    ".gitignore": "# Import proposals and raw inputs are private review artifacts.\n*\n",
    "proposed-agreements.json": JSON.stringify(agreements, null, 2) + "\n",
    "all-agreements.json":
      canonical(allAgreements.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) + "\n",
    "linkage.json":
      canonical({
        version: 1,
        decisions: linked.decisions,
        sourceRows: linked.sourceRows,
        identities: [...contractResult.identities, ...grantResult.identities],
        reconciliation: reconciled.cases,
        existingMatches,
        warnings: report.warnings.filter((w) => w.reason.startsWith("group ")),
      }) + "\n",
    "match-report.json": canonical(report) + "\n",
    "match-report.md":
      renderReport(report) +
      `\nDuplicate-number cases withheld: ${reconciled.cases.length}. Existing identities suppressed: ${existingMatches.length}. See linkage.json and run reconcile-cli.ts before acceptance.\n`,
  });
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(
        `Read ${report.rowsRead} rows; wrote ${report.proposedAgreements} proposed agreements.\n`,
      );
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
