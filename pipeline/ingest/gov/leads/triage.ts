/** Read-only triage of held name-only candidates. Never links, accepts or writes research records. */
import { createReadStream, readFileSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { Corpus } from "../../../../src/domain/schema/corpus";
import { loadResearchCorpus } from "../../../research/load";
import { nameKeys, postalFsa } from "../../../research/names";
import { readCsv } from "../csv";
import { compare, locatorMatches, parseLocator, rowLocator } from "../locators";
import { toContractRow, toGrantRow, validateHeader } from "../tbs";
import { writeReviewOutputs } from "../output";

export interface ResearchProfile {
  orgId: string;
  slug: string;
  name: string;
  legalNames: string[];
  foundedYears: number[];
  provinces: string[];
  cities: string[];
  postalAreas: string[];
  locations?: { province: string | null; city: string | null; postalArea: string | null }[];
  departments: string[];
  programmes: string[];
  assertionIds?: string[];
}
export interface HeldRow {
  dataset: "contracts" | "grants";
  locator: string;
  name: string;
  startOn: string | null;
  date: string | null;
  dateBasis: "start" | "award" | "amendment" | "not_stated";
  value: string | null;
  currency: string;
  province: string | null;
  city: string | null;
  postalArea: string | null;
  department: string;
  programme: string | null;
}
export interface Verdict {
  verdict: "clearly_not" | "plausible" | "unknown";
  reasons: string[];
  supports: string[];
  missing: string[];
}
const fold = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
const PROVINCES: Record<string, string> = {
  ONTARIO: "ON",
  QUEBEC: "QC",
  "BRITISH COLUMBIA": "BC",
  "COLOMBIE BRITANNIQUE": "BC",
  ALBERTA: "AB",
  SASKATCHEWAN: "SK",
  MANITOBA: "MB",
  "NEW BRUNSWICK": "NB",
  "NOUVEAU BRUNSWICK": "NB",
  "NOVA SCOTIA": "NS",
  "NOUVELLE ECOSSE": "NS",
  "PRINCE EDWARD ISLAND": "PE",
  "ILE DU PRINCE EDOUARD": "PE",
  "NEWFOUNDLAND AND LABRADOR": "NL",
  "TERRE NEUVE ET LABRADOR": "NL",
  YUKON: "YT",
  NUNAVUT: "NU",
  "NORTHWEST TERRITORIES": "NT",
  "TERRITOIRES DU NORD OUEST": "NT",
};
const variants = (s: string | null) => (s ?? "").split("|").map(fold).filter(Boolean);
const provinces = (s: string | null) =>
  variants(s)
    .map((p) => PROVINCES[p] ?? (/^[A-Z]{2}$/.test(p) ? p : ""))
    .filter(Boolean);
const unique = <T>(values: T[]) => [...new Set(values)];

/** Any hard rejection must be a contradiction with every recorded alternative. */
export function classifyHeldRow(row: HeldRow, profile: ResearchProfile): Verdict {
  const reasons: string[] = [],
    supports: string[] = [],
    missing: string[] = [
      "No independent matching identifier anchor established; held name_only, not accepted",
    ];
  const names = profile.legalNames.flatMap(nameKeys);
  const sourceNames = nameKeys(row.name);
  if (!names.length || !row.name.trim())
    missing.push("Legal name on record or source name missing");
  else if (!sourceNames.some((name) => names.includes(name)))
    reasons.push(
      "Legal name differs from every recorded legal name beyond punctuation, case or legal-form suffix",
    );
  else supports.push("Same normalized legal name");
  const years = profile.foundedYears.filter((y) => Number.isInteger(y) && y >= 1000 && y <= 9999);
  if (!years.length) missing.push("No structured founding year or incorporation date on record");
  if (!row.startOn)
    missing.push(
      "Agreement start date not stated; award/amendment date does not establish commencement",
    );
  if (row.startOn && years.length && Number(row.startOn.slice(0, 4)) < Math.min(...years))
    reasons.push(
      `Agreement started ${row.startOn}, before every recorded founding year (earliest ${Math.min(...years)})`,
    );
  const recordedProvinces = unique(profile.provinces.flatMap(provinces));
  const rowProvinces = provinces(row.province);
  if (recordedProvinces.length && rowProvinces.length) {
    if (rowProvinces.some((p) => recordedProvinces.includes(p)))
      supports.push("Same province as a recorded location");
    else if (
      profile.locations?.length &&
      profile.locations.every((location) => provinces(location.province).length > 0)
    )
      reasons.push(
        `Source province ${rowProvinces.join("/")} differs from every location on record (${recordedProvinces.join("/")})`,
      );
  }
  const fsas = unique(profile.postalAreas.map(postalFsa).filter((s): s is string => !!s));
  const rowFsa = postalFsa(row.postalArea);
  if (fsas.length && rowFsa) {
    if (fsas.includes(rowFsa))
      supports.push("Same postal area as a recorded location; still held pending identity review");
    else if (
      profile.locations?.length &&
      profile.locations.every((location) => postalFsa(location.postalArea) !== null)
    )
      reasons.push(
        `Source postal area ${rowFsa} differs from every location on record (${fsas.join("/")})`,
      );
  }
  if (!recordedProvinces.length && !fsas.length && !profile.cities.length)
    missing.push("Company location not recorded");
  if (!rowProvinces.length && !rowFsa && !row.city)
    missing.push("Source city, province and postal area missing");
  if (variants(row.city).some((c) => profile.cities.flatMap(variants).includes(c)))
    supports.push("Same city as a recorded location");
  if (profile.departments.includes(row.department))
    supports.push("Same department as an agreement already on record");
  if (row.programme && profile.programmes.some((p) => fold(p) === fold(row.programme!)))
    supports.push("Same programme as an agreement already on record");
  const sufficient =
    names.length > 0 &&
    sourceNames.length > 0 &&
    (years.length > 0 ||
      recordedProvinces.length > 0 ||
      fsas.length > 0 ||
      profile.cities.length > 0);
  return {
    verdict: reasons.length ? "clearly_not" : sufficient ? "plausible" : "unknown",
    reasons: reasons.length
      ? reasons
      : sufficient
        ? ["No hard contradiction found; identity remains unconfirmed"]
        : ["Research record lacks enough identity, chronology or location data to judge"],
    supports,
    missing,
  };
}

/** Lexical and resolved-ancestor checks prevent output through junctions outside the cache. */
export async function assertTriageOutputDir(root: string, output: string): Promise<string> {
  const cache = resolve(root, "research-cache"),
    target = resolve(root, output);
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    return (
      !!rel &&
      rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(rel)
    );
  };
  if (!inside(cache, target)) throw new Error("--out must be inside research-cache/");
  const canonical = async (path: string): Promise<string> => {
    const suffix: string[] = [];
    let ancestor = path;
    for (;;) {
      try {
        return join(await realpath(ancestor), ...suffix.reverse());
      } catch (e) {
        if (
          !(e && typeof e === "object" && "code" in e && e.code === "ENOENT") ||
          dirname(ancestor) === ancestor
        )
          throw e;
        suffix.push(relative(dirname(ancestor), ancestor));
        ancestor = dirname(ancestor);
      }
    }
  };
  const physicalCache = await canonical(cache),
    physicalTarget = await canonical(target);
  // A linked research-cache root itself must not alias the research corpus or another directory.
  if (physicalCache !== cache || !inside(physicalCache, physicalTarget))
    throw new Error("--out must resolve inside the actual research-cache/ directory");
  return physicalTarget;
}

const CandidateSchema = z.object({
  dataset: z.enum(["contracts", "grants"]),
  locator: z.string(),
  method: z.string(),
  candidates: z.array(z.string()),
});
export type HeldCandidate = z.infer<typeof CandidateSchema>;
export interface TriageOptions {
  root: string;
  contracts: string;
  grants: string;
  candidates: HeldCandidate[];
  profiles: ResearchProfile[];
  out: string;
}
export interface TriageResult {
  kind: "held-row-triage";
  evidence: false;
  inputCandidates: number;
  assessments: number;
  skippedIndividualCandidates: number;
  counts: Record<Verdict["verdict"], number>;
  rows: (Verdict & {
    orgId: string;
    orgSlug: string;
    profileRecordIds: string[];
    dataset: HeldRow["dataset"];
    locator: string;
    name: string | null;
    date: string | null;
    dateBasis: HeldRow["dateBasis"];
    value: string | null;
    currency: string | null;
  })[];
}

export function profilesFromCorpus(corpus: Corpus, slugs: string[]): ResearchProfile[] {
  const wanted = new Set(slugs),
    programs = new Map(corpus.programs.map((p) => [p.id, p.name]));
  const live = corpus.assertions.filter((a) => !["rejected", "retracted"].includes(a.verification));
  const departments = new Map<string, string[]>();
  for (const a of live)
    if (a.predicate === "registry_id" && a.value && typeof a.value === "object") {
      const v = a.value as { system?: unknown; value?: unknown };
      if (v.system === "tbs-owner-org" && typeof v.value === "string")
        departments.set(a.subjectId, [...(departments.get(a.subjectId) ?? []), v.value]);
    }
  return corpus.organizations
    .filter((o) => wanted.has(o.slug))
    .map((org) => {
      const facts = live.filter((a) => a.subjectId === org.id);
      const locations = facts
        .filter((a) => ["hq_location", "operations_location"].includes(a.predicate))
        .map((a) => a.value)
        .filter(
          (v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v),
        );
      const strings = (key: string) =>
        locations
          .map((v) => v[key])
          .filter((v): v is string => typeof v === "string" && !!v.trim());
      const agreements = corpus.agreements.filter(
        (g) =>
          !["rejected", "retracted"].includes(g.verification) &&
          g.parties.some((p) => p.orgId === org.id && p.evidenceStrength === "party_of_record"),
      );
      return {
        orgId: org.id,
        slug: org.slug,
        name: org.name,
        legalNames: unique(
          facts
            .filter((a) => a.predicate === "legal_name" && typeof a.value === "string")
            .map((a) => a.value as string),
        ),
        foundedYears: unique(
          facts
            .filter((a) => a.predicate === "founded_year" && typeof a.value === "number")
            .map((a) => a.value as number),
        ),
        provinces: unique(strings("province")),
        cities: unique(strings("city")),
        postalAreas: unique(
          strings("postalCode")
            .map(postalFsa)
            .filter((v): v is string => !!v),
        ),
        locations: locations.map((location) => ({
          province: typeof location.province === "string" ? location.province : null,
          city: typeof location.city === "string" ? location.city : null,
          postalArea:
            typeof location.postalCode === "string" ? postalFsa(location.postalCode) : null,
        })),
        departments: unique(
          agreements.flatMap((g) =>
            g.parties
              .filter((p) => ["buyer", "funder"].includes(p.role))
              .flatMap((p) => departments.get(p.orgId) ?? []),
          ),
        ),
        programmes: unique(
          agreements.flatMap((g) => [
            ...g.externalIds.filter((x) => x.system === "tbs-grants:program").map((x) => x.value),
            ...(g.programId && programs.has(g.programId) ? [programs.get(g.programId)!] : []),
          ]),
        ),
        assertionIds: facts.map((a) => a.id).sort(compare),
      };
    })
    .sort((a, b) => compare(a.orgId, b.orgId));
}

export async function triageHeldRows(options: TriageOptions): Promise<TriageResult> {
  const out = await assertTriageOutputDir(options.root, options.out);
  const profiles = new Map(options.profiles.map((p) => [p.orgId, p]));
  const candidates = options.candidates.filter(
    (c) => c.method === "name_only" && c.candidates.some((id) => profiles.has(id)),
  );
  const found = new Map<string, HeldRow[]>(),
    individuals = new Set<string>();
  for (const dataset of ["contracts", "grants"] as const) {
    const relevant = candidates.filter((c) => c.dataset === dataset);
    if (!relevant.length) continue;
    const refKey = dataset === "contracts" ? "reference_number" : "ref_number";
    const byRef = new Map<string, HeldCandidate[]>();
    for (const c of relevant) {
      const ref = parseLocator(c.locator)?.get(refKey);
      if (ref) byRef.set(ref, [...(byRef.get(ref) ?? []), c]);
    }
    const sourceColumns = new Set(
      Object.keys(
        (dataset === "contracts" ? toContractRow({}) : toGrantRow({ amendment_number: "0" }))
          .sourceCells!,
      ),
    );
    sourceColumns.add("recipient_province");
    sourceColumns.add("recipient_city");
    for await (const raw of readCsv(
      createReadStream(options[dataset]),
      (headers) => validateHeader(dataset, headers),
      (column) => sourceColumns.has(column),
    )) {
      const selected = byRef.get(raw[refKey] ?? "");
      if (!selected) continue;
      if (dataset === "grants" && raw.recipient_type?.trim() === "P") {
        for (const c of selected) individuals.add(`${dataset}:${c.locator}`);
        continue;
      }
      const row = dataset === "contracts" ? toContractRow(raw) : toGrantRow(raw);
      const locator = rowLocator(dataset, row);
      for (const candidate of selected) {
        const fields = parseLocator(candidate.locator);
        if (!fields || !locatorMatches(fields, row)) continue;
        const startOn =
          "contract_period_start" in row ? row.contract_period_start : row.agreement_start_date;
        const fallback = "contract_date" in row ? row.contract_date : row.amendment_date;
        const view: HeldRow = {
          dataset,
          locator,
          name: dataset === "contracts" ? raw.vendor_name! : raw.recipient_legal_name!,
          startOn,
          date: startOn || fallback || null,
          dateBasis: startOn
            ? "start"
            : fallback
              ? dataset === "contracts"
                ? "award"
                : "amendment"
              : "not_stated",
          value: "contract_value" in row ? row.contract_value : row.agreement_value,
          currency: "CAD",
          province: raw.recipient_province || null,
          city: raw.recipient_city || null,
          postalArea: postalFsa(
            dataset === "contracts" ? raw.vendor_postal_code : raw.recipient_postal_code,
          ),
          department: raw.owner_org ?? "",
          programme: raw.prog_name_en || null,
        };
        const key = `${dataset}:${candidate.locator}`;
        found.set(key, [...(found.get(key) ?? []), view]);
      }
    }
  }
  const result: TriageResult = {
    kind: "held-row-triage",
    evidence: false,
    inputCandidates: candidates.length,
    assessments: 0,
    skippedIndividualCandidates: 0,
    counts: { clearly_not: 0, plausible: 0, unknown: 0 },
    rows: [],
  };
  for (const candidate of candidates) {
    const key = `${candidate.dataset}:${candidate.locator}`,
      matches = found.get(key) ?? [];
    if (!matches.length && individuals.has(key)) {
      result.skippedIndividualCandidates++;
      continue;
    }
    for (const orgId of unique(candidate.candidates)
      .filter((id) => profiles.has(id))
      .sort(compare)) {
      const profile = profiles.get(orgId)!;
      const row = matches.length === 1 ? matches[0] : undefined;
      const verdict: Verdict = row
        ? classifyHeldRow(row, profile)
        : {
            verdict: "unknown",
            reasons: [
              matches.length
                ? "Locator matches multiple source rows; no unique row can be judged"
                : "Source row not found at the exact locator",
            ],
            supports: [],
            missing: ["Unique readable source row"],
          };
      result.rows.push({
        ...verdict,
        orgId,
        orgSlug: profile.slug,
        profileRecordIds: profile.assertionIds ?? [],
        dataset: candidate.dataset,
        locator: candidate.locator,
        name: row?.name ?? null,
        date: row?.date ?? null,
        dateBasis: row?.dateBasis ?? "not_stated",
        value: row?.value ?? null,
        currency: row?.currency ?? null,
      });
      result.counts[verdict.verdict]++;
    }
  }
  const rank = { plausible: 0, unknown: 1, clearly_not: 2 };
  result.rows.sort(
    (a, b) =>
      rank[a.verdict] - rank[b.verdict] ||
      compare(a.orgSlug, b.orgSlug) ||
      compare(a.locator, b.locator),
  );
  result.assessments = result.rows.length;
  const cell = (v: unknown) =>
    String(v ?? "not stated")
      .replaceAll("|", "\\|")
      .replace(/[\r\n]+/g, " ")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const markdown = [
    "# Held name-only government rows",
    "",
    "Triage only; no row is accepted and no research record is changed. These outputs are not evidence.",
    "",
    `Scoped name_only entries: ${result.inputCandidates}. Assessments: ${result.assessments}. Individuals skipped: ${result.skippedIndividualCandidates}.`,
    `Plausible: ${result.counts.plausible}; unknown: ${result.counts.unknown}; clearly not: ${result.counts.clearly_not}.`,
    "",
    "Uses all recorded legal-name and location alternatives, including history; research may still be proposed. Only structured founding years can be compared: the current corpus has no incorporation-date field. Award or amendment dates never prove an agreement start date.",
    "",
    "| Company | Locator | Name as stated | Date (basis) | Value | Verdict | Reasons, support and missing data |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...result.rows
      .map((r) =>
        [
          r.orgSlug,
          r.locator,
          r.name,
          `${r.date ?? "not stated"} (${r.dateBasis})`,
          r.value === null ? "not stated" : `${r.currency} ${r.value}`,
          r.verdict,
          [...r.reasons, ...r.supports, ...r.missing].join("; "),
        ]
          .map(cell)
          .join(" | "),
      )
      .map((r) => `| ${r} |`),
    "",
  ].join("\n");
  await mkdir(out, { recursive: true });
  await assertTriageOutputDir(options.root, out);
  await writeReviewOutputs(out, {
    "triage.json": JSON.stringify(result, null, 2) + "\n",
    "triage.md": markdown,
  });
  return result;
}

export async function runTriageCli(
  args: string[],
  root = process.cwd(),
): Promise<TriageResult | null> {
  const { values } = parseArgs({
    args,
    options: {
      plan: { type: "string", default: "research-cache/gov-linkage/plan-post/migration.json" },
      tiers: { type: "string", default: "research-cache/tiers/tiers-2026-10-15.json" },
      research: { type: "string", default: "research" },
      contracts: { type: "string", default: "research-cache/gov-data/2026-10-13/contracts.csv" },
      grants: { type: "string", default: "research-cache/gov-data/2026-10-13/grants.csv" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      "gov-triage --out research-cache/gov-triage/<date> [--plan file --tiers file --research research --contracts file --grants file]\nRead-only triage, never acceptance. Defaults to the first-10 held-row plan and scope.",
    );
    return null;
  }
  if (!values.out) throw new Error("--out inside research-cache/ is required");
  await assertTriageOutputDir(root, values.out);
  const plan = z
    .object({ candidates: z.array(CandidateSchema) })
    .parse(JSON.parse(readFileSync(resolve(root, values.plan), "utf8")));
  const tiers = z
    .object({ scope: z.object({ orgSlugs: z.array(z.string()) }) })
    .parse(JSON.parse(readFileSync(resolve(root, values.tiers), "utf8")));
  const loaded = loadResearchCorpus(resolve(root, values.research));
  if (!loaded.corpus) throw new Error(JSON.stringify(loaded.issues));
  const profiles = profilesFromCorpus(loaded.corpus, tiers.scope.orgSlugs);
  if (profiles.length !== unique(tiers.scope.orgSlugs).length)
    throw new Error("Tier scope contains organizations not found in the research corpus");
  const result = await triageHeldRows({
    root,
    contracts: resolve(root, values.contracts),
    grants: resolve(root, values.grants),
    candidates: plan.candidates,
    profiles,
    out: resolve(root, values.out),
  });
  console.log(
    JSON.stringify({
      inputCandidates: result.inputCandidates,
      assessments: result.assessments,
      skippedIndividualCandidates: result.skippedIndividualCandidates,
      counts: result.counts,
    }),
  );
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  runTriageCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`gov-triage: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
