import { readCsv } from "../csv";
import { validateHeader } from "../tbs";
import type { DatasetKind } from "../tbs";
import { businessNumberRoot, nameKey, nameKeys } from "../../../research/names";
import { columnsFor, locatorFor, project } from "./rows";
import { pageBudget } from "./client";
import type { ApiRecord, PageOptions, SearchPort } from "./client";

export type CsvInput = AsyncIterable<string | Buffer>;
export interface LocalSummary {
  rows: number;
  newestPeriod: string | null;
  hasReportingPeriod: boolean;
  blankReportingPeriods: number;
  invalidReportingPeriods: number;
}
export function periodKey(value: string): number {
  const m = /^(\d{4})-(\d{4})-Q([1-4])$/.exec(value);
  if (!m || Number(m[2]) !== Number(m[1]) + 1)
    throw new Error(
      "Invalid reporting_period; expected YYYY-YYYY-Q1 through Q4 with consecutive years",
    );
  return Number(m[1]) * 4 + Number(m[3]);
}
async function* localRecords(
  kind: DatasetKind,
  input: CsvInput,
  onHeader?: (headers: string[]) => void,
  summaryOnly = false,
) {
  let seen = false;
  const allowed = new Set(
    summaryOnly ? ["reporting_period"] : [...columnsFor(kind), "reporting_period"],
  );
  for await (const row of readCsv(
    input,
    (headers) => {
      validateHeader(kind, headers);
      seen = true;
      onHeader?.(headers);
    },
    (h) => allowed.has(h),
  ))
    yield row;
  if (!seen) throw new Error(`${kind}: local CSV has no header`);
}
export async function inspectLocal(kind: DatasetKind, input: CsvInput): Promise<LocalSummary> {
  const summary: LocalSummary = {
    rows: 0,
    newestPeriod: null,
    hasReportingPeriod: false,
    blankReportingPeriods: 0,
    invalidReportingPeriods: 0,
  };
  for await (const row of localRecords(
    kind,
    input,
    (headers) => {
      summary.hasReportingPeriod = headers.includes("reporting_period");
    },
    true,
  )) {
    summary.rows++;
    if (!summary.hasReportingPeriod) continue;
    const period = row.reporting_period?.trim() ?? "";
    if (!period) {
      summary.blankReportingPeriods++;
      continue;
    }
    let key: number;
    try {
      key = periodKey(period);
    } catch {
      summary.invalidReportingPeriods++;
      continue;
    }
    if (summary.newestPeriod === null || key > periodKey(summary.newestPeriod))
      summary.newestPeriod = period;
  }
  return summary;
}
interface Lead {
  locator: string;
}
interface NewRowsResult {
  status: "ok" | "unsupported";
  reason?: string;
  complete: boolean;
  apiScanComplete: boolean;
  localPeriodsComplete: boolean;
  threshold: string;
  total: number | null;
  pages: number;
  matched: number;
  skippedIndividuals: number;
  counts: { department: string; period: string; count: number }[];
  leads: (Lead & { department: string; period: string })[];
}
export async function newRows(
  client: SearchPort,
  resource: string,
  kind: DatasetKind,
  local: LocalSummary,
  since: string,
  options: PageOptions = {},
): Promise<NewRowsResult> {
  const budget = pageBudget(options),
    sinceKey = periodKey(since);
  const threshold =
    local.newestPeriod && periodKey(local.newestPeriod) > sinceKey ? local.newestPeriod : since;
  const result: NewRowsResult = {
    status: "ok",
    complete: false,
    apiScanComplete: false,
    localPeriodsComplete:
      local.hasReportingPeriod &&
      local.blankReportingPeriods === 0 &&
      local.invalidReportingPeriods === 0,
    threshold,
    total: null,
    pages: 0,
    matched: 0,
    skippedIndividuals: 0,
    counts: [],
    leads: [],
  };
  if (!local.hasReportingPeriod)
    return {
      ...result,
      status: "unsupported",
      reason:
        "Local CSV has no reporting_period. Dates are not substituted for publication periods.",
    };
  if (!local.newestPeriod)
    return {
      ...result,
      status: "unsupported",
      reason:
        "Local CSV has no nonblank reporting_period; no local newest period can be established.",
    };
  const counts = new Map<string, { department: string; period: string; count: number }>();
  let offset = 0,
    previous = Infinity;
  const ids = new Set<number>();
  for (let p = 0; p < budget; p++) {
    const page = await client.search(resource, {
      fields: [...new Set([...columnsFor(kind), "reporting_period", "_id"])],
      sort: "reporting_period desc, _id asc",
      offset,
      limit: options.limit ?? 1000,
    });
    if (result.total !== null && result.total !== page.total)
      throw new Error("API total changed during paging; rerun discovery");
    result.total = page.total;
    result.pages++;
    let atBoundary = false;
    for (const raw of page.records) {
      checkId(raw, ids);
      const period = typeof raw.reporting_period === "string" ? raw.reporting_period.trim() : "";
      const key = periodKey(period);
      if (key > previous) throw new Error("API reporting_period sort is not monotonic");
      previous = key;
      if (key <= periodKey(threshold)) {
        atBoundary = true;
        continue;
      }
      if (kind === "grants" && String(raw.recipient_type ?? "").trim() === "P") {
        result.skippedIndividuals++;
        continue;
      }
      const department = String(raw.owner_org ?? "").trim();
      if (!department) throw new Error("API row lacks department; counts cannot be attributed");
      result.leads.push({ department, period, locator: locatorFor(kind, raw) });
      const countKey = JSON.stringify([department, period]);
      const counter = counts.get(countKey) ?? { department, period, count: 0 };
      counter.count++;
      counts.set(countKey, counter);
      result.matched++;
    }
    offset += page.records.length;
    if (atBoundary || offset >= page.total) {
      result.apiScanComplete = true;
      break;
    }
    if (!page.records.length) throw new Error("Empty page before API total");
  }
  result.counts = [...counts.values()].sort(
    (a, b) => a.department.localeCompare(b.department) || periodKey(a.period) - periodKey(b.period),
  );
  result.complete = result.apiScanComplete && result.localPeriodsComplete;
  return result;
}

export interface Query {
  index: number;
  kind: "name" | "businessNumber";
  key: string | null;
  status: "valid" | "invalid";
}
export function parseQueries(input: unknown): Query[] {
  if (!Array.isArray(input) || input.length > 1000)
    throw new Error("--names must contain a JSON list of at most 1000 names or business numbers");
  return input.map((entry: unknown, index) => {
    let value: string, kind: Query["kind"];
    if (typeof entry === "string") {
      value = entry;
      kind = /^[\d\s-]+$/.test(value) || /^\s*\d{9}/.test(value) ? "businessNumber" : "name";
    } else if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 1 &&
      "name" in entry &&
      typeof entry.name === "string"
    ) {
      value = entry.name;
      kind = "name";
    } else if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 1 &&
      "businessNumber" in entry &&
      typeof entry.businessNumber === "string"
    ) {
      value = entry.businessNumber;
      kind = "businessNumber";
    } else
      throw new Error(
        "Each query must be a string, {name: string}, or {businessNumber: string}; numeric JSON values are not accepted",
      );
    const key = kind === "businessNumber" ? businessNumberRoot(value) : nameKey(value) || null;
    return { index, kind, key, status: key === null ? "invalid" : "valid" };
  });
}
function invalidBn(kind: DatasetKind, row: ApiRecord) {
  const bn = row.recipient_business_number;
  return (
    kind === "grants" &&
    bn !== undefined &&
    bn !== null &&
    String(bn).trim() !== "" &&
    !businessNumberRoot(String(bn))
  );
}
function matches(kind: DatasetKind, row: Record<string, string>, query: Query) {
  if (!query.key) return false;
  if (query.kind === "businessNumber")
    return kind === "grants" && businessNumberRoot(row.recipient_business_number) === query.key;
  const names =
    kind === "contracts"
      ? [row.vendor_name ?? ""]
      : [row.recipient_legal_name ?? "", row.recipient_operating_name ?? ""];
  return names.some((name) => nameKeys(name).includes(query.key!));
}
function checkId(row: ApiRecord, ids: Set<number>) {
  if (typeof row._id !== "number" || !Number.isSafeInteger(row._id) || ids.has(row._id))
    throw new Error("Invalid or repeated API _id during paging");
  ids.add(row._id);
}
export async function lookup(
  client: SearchPort,
  resource: string,
  kind: DatasetKind,
  local: CsvInput,
  queries: Query[],
  options: PageOptions = {},
) {
  const budget = pageBudget(options);
  const hits = queries.map(() => [] as string[]);
  let total: number | null = null,
    pages = 0,
    offset = 0,
    complete = false,
    invalidBusinessNumberRows = 0,
    skippedIndividuals = 0;
  const ids = new Set<number>();
  for (let p = 0; p < budget; p++) {
    const page = await client.search(resource, {
      fields: [...columnsFor(kind), "_id"],
      sort: "_id asc",
      offset,
      limit: options.limit ?? 1000,
    });
    if (total !== null && page.total !== total)
      throw new Error("API total changed during paging; rerun discovery");
    total = page.total;
    pages++;
    for (const raw of page.records) {
      checkId(raw, ids);
      if (kind === "grants" && String(raw.recipient_type ?? "").trim() === "P") {
        skippedIndividuals++;
        continue;
      }
      if (invalidBn(kind, raw)) {
        invalidBusinessNumberRows++;
        continue;
      }
      const row = project(kind, raw);
      let locator: string | undefined;
      queries.forEach((query, i) => {
        if (matches(kind, row, query)) {
          locator ??= locatorFor(kind, raw);
          hits[i]!.push(locator);
        }
      });
    }
    offset += page.records.length;
    if (offset >= page.total) {
      complete = true;
      break;
    }
    if (!page.records.length) throw new Error("Empty page before API total");
  }
  const needed = new Set(hits.flat()),
    present = new Set<string>();
  let localRows = 0,
    invalidLocalBusinessNumberRows = 0;
  for await (const row of localRecords(kind, local)) {
    localRows++;
    if (kind === "grants" && row.recipient_type?.trim() === "P") continue;
    if (invalidBn(kind, row)) {
      invalidLocalBusinessNumberRows++;
      continue;
    }
    if (!queries.some((query) => matches(kind, row, query))) continue;
    const locator = locatorFor(kind, row);
    if (needed.has(locator)) present.add(locator);
  }
  return {
    total,
    pages,
    complete,
    localRows,
    invalidBusinessNumberRows,
    invalidLocalBusinessNumberRows,
    skippedIndividuals,
    businessNumberFieldAvailable: kind === "grants",
    queries: queries.map((query, i) => ({
      index: query.index,
      kind: query.kind,
      status:
        query.status === "valid" && query.kind === "businessNumber" && kind === "contracts"
          ? "unsupported"
          : query.status,
      apiMatches: hits[i]!.length,
      alreadyInLocal: hits[i]!.filter((locator) => present.has(locator)).length,
      notInLocal: hits[i]!.filter((locator) => !present.has(locator)).map((locator) => ({
        locator,
      })),
    })),
  };
}
