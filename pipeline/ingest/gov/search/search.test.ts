import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  fold,
  matchText,
  planQuery,
  searchGrants,
  termPattern,
  type MatchInput,
  type QuerySpec,
} from "./search";
import { ApiJudge, ManualJudge, checkJudgement, JUDGED } from "./judge";
import { assertSearchOutputDir, runGrantSearch } from "./cli";

const HEADER =
  "ref_number,amendment_number,amendment_date,agreement_type,recipient_type,recipient_business_number,recipient_legal_name,recipient_operating_name,research_organization_name,recipient_country,recipient_province,recipient_city,recipient_postal_code,federal_riding_name_en,federal_riding_name_fr,federal_riding_number,prog_name_en,prog_name_fr,prog_purpose_en,prog_purpose_fr,agreement_title_en,agreement_title_fr,agreement_number,agreement_value,foreign_currency_type,foreign_currency_value,agreement_start_date,agreement_end_date,coverage,description_en,description_fr,naics_identifier,expected_results_en,expected_results_fr,additional_information_en,additional_information_fr,owner_org,owner_org_title".split(
    ",",
  );
type Row = Partial<Record<string, string>>;
const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
function csv(rows: Row[]): string {
  const base: Row = {
    amendment_number: "0",
    agreement_type: "G",
    recipient_type: "F",
    recipient_country: "CA",
    owner_org: "fict-dept",
    owner_org_title: "Fictional Department of Testing",
    prog_name_en: "Fictional Innovation Programme",
    agreement_value: "50000",
  };
  return [
    HEADER.join(","),
    ...rows.map((r) => HEADER.map((h) => quote({ ...base, ...r }[h] ?? "")).join(",")),
  ].join("\n");
}
const run = (text: string, specs: QuerySpec[]) => searchGrants([text], specs.map(planQuery));

const ROWS: Row[] = [
  // Fictional Aster: first grant 2015 (not a drone), then a drone grant in 2023 with an amendment.
  {
    ref_number: "FICT-2015-1",
    recipient_business_number: "100000001RC0001",
    recipient_legal_name: "Fictional Aster Ltd.",
    recipient_province: "ON",
    recipient_city: "Fictionville",
    recipient_postal_code: "K0A 1A0",
    agreement_title_en: "Bakery equipment",
    agreement_start_date: "2015-04-01",
  },
  {
    ref_number: "FICT-2023-1",
    recipient_business_number: "100000001",
    recipient_legal_name: "Fictional Aster Ltd.",
    recipient_province: "ON",
    agreement_title_en: "Prototype UAV for inspection",
    agreement_value: "100000",
    agreement_start_date: "2023-02-01",
  },
  {
    ref_number: "FICT-2023-1",
    amendment_number: "1",
    recipient_business_number: "100000001",
    recipient_legal_name: "Fictional Aster Ltd.",
    recipient_province: "ON",
    agreement_title_en: "Prototype UAV for inspection",
    agreement_value: "150000",
    agreement_start_date: "2023-02-01",
  },
  // Fictional Boréal: French title only, first funded 2024, Quebec.
  {
    ref_number: "FICT-2024-2",
    recipient_business_number: "100000002",
    recipient_legal_name: "Fictional Boréal Inc.",
    recipient_province: "QC",
    agreement_title_fr: "Développement d’un aéronef télépiloté pour la sécurité",
    agreement_value: "20000",
    agreement_start_date: "2024-05-01",
  },
  // Fictional Cirrus: drones only in the description, first funded 2022.
  {
    ref_number: "FICT-2022-3",
    recipient_business_number: "100000003",
    recipient_legal_name: "Fictional Cirrus Corp.",
    recipient_province: "BC",
    agreement_title_en: "Market expansion",
    description_en: "Hire staff to sell RPAS services to utilities.",
    agreement_value: "300000",
    agreement_start_date: "2022-06-01",
  },
  // An individual with a drone grant: skipped entirely.
  {
    ref_number: "FICT-2023-4",
    recipient_type: "P",
    recipient_legal_name: "Fictional Person",
    agreement_title_en: "Drone photography",
    agreement_start_date: "2023-01-01",
  },
  // A not-for-profit drone project: not a candidate by default.
  {
    ref_number: "FICT-2023-5",
    recipient_type: "N",
    recipient_business_number: "100000005",
    recipient_legal_name: "Fictional Drone Society",
    agreement_title_en: "Drone safety training",
    agreement_start_date: "2023-03-01",
  },
  // A false friend: drone bees.
  {
    ref_number: "FICT-2023-6",
    recipient_business_number: "100000006",
    recipient_legal_name: "Fictional Apiary Ltd.",
    agreement_title_en: "Drone bee breeding for pollination",
    agreement_start_date: "2023-04-01",
  },
];

describe("grant search: query planning and matching", () => {
  const t = (titleEn: string, rest: Partial<MatchInput> = {}): MatchInput => ({ titleEn, ...rest });
  it("expands a plain query into the synonym topic and matches whole words", () => {
    const plan = planQuery({ id: "drones", query: "first-time grants to drone companies" });
    expect(plan.topics).toEqual(["drones"]);
    for (const title of [
      "UAV payload",
      "RPAS training",
      "unmanned aerial mapping",
      "Drones for farms",
    ])
      expect(matchText(plan, t(title))?.where, title).toBe("title");
    expect(matchText(plan, t("Hydrone fuel cells"))).toBeNull();
  });
  it("matches French without accents or typographic apostrophes", () => {
    const plan = planQuery({ id: "drones", query: "drones" });
    expect(fold("Aéronef d’essai")).toBe("aeronef d'essai");
    expect(matchText(plan, t("", { titleFr: "Système d’aéronef télépiloté" }))?.terms).toEqual([
      "systeme d'aeronef telepilote",
    ]);
  });
  it("counts weak terms only in the English title and lets exclusions veto", () => {
    const plan = planQuery({ id: "c-uas", query: "counter-drone", topics: ["counter_drone"] });
    expect(matchText(plan, t("Radar upgrade"))?.where).toBe("title-weak");
    expect(matchText(plan, t("Market study", { description: "uses radar data" }))).toBeNull();
    expect(matchText(plan, t("Study", { titleFr: "Radar de surveillance" }))).toBeNull();
    expect(matchText(plan, t("Weather radar network"))).toBeNull();
  });
  it("ignores the recipient's own name in titles", () => {
    const plan = planQuery({ id: "q", query: "quantum sensing", topics: ["quantum_nav"] });
    expect(
      matchText(
        plan,
        t("Fictional Atomic Clock Ltd-2026-1", { names: ["Fictional Atomic Clock Ltd"] }),
      ),
    ).toBeNull();
    expect(matchText(plan, t("Atomic clock prototype", { names: ["Fictional Ltd"] }))?.where).toBe(
      "title",
    );
  });
  it("matches a defence programme name and enforces required topics", () => {
    const diana = planQuery({ id: "d", query: "DIANA innovators", topics: ["diana"] });
    expect(
      matchText(diana, t("Battery pack", { programme: "Fictional DIANA Accelerator Fund" }))?.where,
    ).toBe("programme");
    const arctic = planQuery({
      id: "a",
      query: "Arctic defence",
      topics: ["arctic"],
      require: ["defence_readiness"],
    });
    expect(matchText(arctic, t("Arctic resort expansion"))).toBeNull();
    expect(matchText(arctic, t("Arctic sensor for military use"))?.where).toBe("title-weak");
  });
  it("rejects unknown topics, empty plans and unsafe ids", () => {
    expect(() => planQuery({ id: "x", query: "pottery" })).toThrow(/no topic/);
    expect(() => planQuery({ id: "x", query: "q", topics: ["nope"] })).toThrow(/Unknown topic/);
    expect(() => planQuery({ id: "x", query: "q", require: ["nope"], topics: ["drones"] })).toThrow(
      /Unknown topic/,
    );
    expect(() => planQuery({ id: "../x", query: "drones" })).toThrow(/id/);
    expect(termPattern([])).toBeNull();
  });
});

describe("grant search: one pass over the file", () => {
  it("skips individuals, keeps for-profit rows, never sums amendments, ranks titles first", async () => {
    const { results, stats } = await run(csv(ROWS), [{ id: "drones", query: "drone companies" }]);
    expect(stats.individualsSkipped).toBe(1);
    const c = results[0]!.candidates;
    expect(c.map((x) => x.recipient)).toEqual([
      "Fictional Boréal Inc.",
      "Fictional Aster Ltd.",
      "Fictional Cirrus Corp.",
    ]);
    expect(c.map((x) => x.matchIn)).toEqual(["title", "title", "description"]);
    const aster = c.find((x) => x.recipient === "Fictional Aster Ltd.")!;
    expect(aster.originalValue).toBe("100000");
    expect(aster.amendments).toBe(1);
    expect(aster.recipientOriginalTotal).toBe("150000.00"); // 50,000 (2015) + 100,000, not 150,000 more
    expect(aster.recipientFirstGrant).toBe("2015-04-01");
    expect(aster.locator).toMatch(/^ref_number=FICT-2023-1;amendment_number=0;/);
    expect(c.find((x) => x.recipient === "Fictional Boréal Inc.")!.title).toContain("aéronef");
  });
  it("applies first-grant, province, department, programme and value filters", async () => {
    const text = csv(ROWS);
    const ids = async (filters: QuerySpec["filters"]) =>
      (await run(text, [{ id: "d", query: "drones", filters }]))["results"][0]!.candidates.map(
        (x) => x.recipient,
      );
    expect(await ids({ firstSince: "2022-01-01" })).toEqual([
      "Fictional Boréal Inc.",
      "Fictional Cirrus Corp.",
    ]);
    expect(await ids({ provinces: ["QC"] })).toEqual(["Fictional Boréal Inc."]);
    expect(await ids({ minValue: 50000, maxValue: 200000 })).toEqual(["Fictional Aster Ltd."]);
    expect(await ids({ department: "other-dept" })).toEqual([]);
    expect(await ids({ programme: "innovation" })).toHaveLength(3);
    expect(await ids({ recipientTypes: ["N"] })).toEqual(["Fictional Drone Society"]);
    expect(await ids({ excludeProgramme: "fictional innovation" })).toEqual([]);
  });
  it("shows one agreement per company, counts the rest, and drops foreign recipients", async () => {
    const rows: Row[] = [
      ...ROWS,
      {
        ref_number: "FICT-2024-7",
        recipient_business_number: "100000001",
        recipient_legal_name: "Fictional Aster Ltd.",
        agreement_title_en: "Second UAV project",
        agreement_start_date: "2024-01-01",
      },
      {
        ref_number: "FICT-2024-8",
        recipient_country: "NO",
        recipient_business_number: "100000008",
        recipient_legal_name: "Fictional Fjord AS",
        agreement_title_en: "Drone harbour survey",
        agreement_start_date: "2024-02-01",
      },
    ];
    const { results } = await run(csv(rows), [{ id: "d", query: "drones" }]);
    const aster = results[0]!.candidates.filter((x) => x.recipient === "Fictional Aster Ltd.");
    expect(aster).toHaveLength(1);
    expect(aster[0]!.otherMatchingAgreements).toBe(1);
    expect(results[0]!.candidates.some((x) => x.recipient === "Fictional Fjord AS")).toBe(false);
    const all = await run(csv(rows), [
      { id: "d", query: "drones", perRecipient: 5, filters: { countries: ["CA", "", "NO"] } },
    ]);
    expect(
      all.results[0]!.candidates.filter((x) => x.recipient === "Fictional Aster Ltd."),
    ).toHaveLength(2);
    expect(all.results[0]!.candidates.some((x) => x.recipient === "Fictional Fjord AS")).toBe(true);
  });
  it("drops Canada Summer Jobs rows by default", async () => {
    const rows: Row[] = [
      ...ROWS,
      {
        ref_number: "FICT-2024-10",
        recipient_business_number: "100000010",
        recipient_legal_name: "Fictional Diner Ltd.",
        prog_name_en: "Youth - Canada Summer Jobs",
        agreement_title_en: "Drone Diner summer staff",
        agreement_start_date: "2024-05-01",
      },
    ];
    const shown = async (filters?: QuerySpec["filters"]) =>
      (await run(csv(rows), [{ id: "d", query: "drones", filters }])).results[0]!.candidates.map(
        (x) => x.recipient,
      );
    expect(await shown()).not.toContain("Fictional Diner Ltd.");
    expect(await shown({ excludeProgramme: "" })).toContain("Fictional Diner Ltd.");
  });
  it("finds an earlier first grant filed under the same name without a business number", async () => {
    const rows: Row[] = [
      ...ROWS,
      {
        ref_number: "FICT-2010-9",
        recipient_legal_name: "Fictional Cirrus Corp",
        agreement_title_en: "Export plan",
        agreement_start_date: "2010-01-01",
      },
    ];
    const { results } = await run(csv(rows), [
      { id: "d", query: "drones", filters: { firstSince: "2022-01-01" } },
    ]);
    expect(results[0]!.candidates.map((x) => x.recipient)).toEqual(["Fictional Boréal Inc."]);
  });
  it("answers several queries in one pass, in a deterministic order", async () => {
    const text = csv(ROWS);
    const specs: QuerySpec[] = [
      { id: "a", query: "drones" },
      { id: "b", query: "drones", filters: { provinces: ["BC"] } },
    ];
    const first = await run(text, specs);
    expect(first.results.map((r) => r.counts.shown)).toEqual([3, 1]);
    expect(JSON.stringify((await run(text, specs)).results)).toBe(JSON.stringify(first.results));
  });
});

describe("grant search: judging and output", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
  });
  it("checks one-sentence judgements and refuses the API judge without a key", async () => {
    expect(checkJudgement({ match: "yes", reason: "Builds drones." })).toEqual({
      match: "yes",
      reason: "Builds drones.",
    });
    expect(() => checkJudgement({ match: "maybe", reason: "x" })).toThrow();
    expect(() => checkJudgement({ match: "no", reason: "two\nlines" })).toThrow();
    await expect(new ApiJudge({}).judge()).rejects.toThrow(/No API key/);
    await expect(new ApiJudge({ CANDEF_JUDGE_API_KEY: "fictional" }).judge()).rejects.toThrow(
      /stub/,
    );
  });
  it("refuses output outside research-cache/grant-search/", async () => {
    const root = await mkdtemp(join(tmpdir(), "candef-grant-search-"));
    roots.push(root);
    for (const out of ["research/x", "research-cache/other", "research-cache/grant-search", ".."])
      await expect(assertSearchOutputDir(root, out), out).rejects.toThrow();
    await expect(
      assertSearchOutputDir(root, "research-cache/grant-search/run-1"),
    ).resolves.toContain("grant-search");
  });
  it("runs candidates, then a hand-judged report, entirely inside the run folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "candef-grant-search-"));
    roots.push(root);
    await mkdir(join(root, "data"));
    await writeFile(join(root, "data", "grants.csv"), csv(ROWS));
    const out = "research-cache/grant-search/run-1";
    expect(
      await runGrantSearch(
        [
          "candidates",
          "--query",
          "drones",
          "--id",
          "drones",
          "--grants",
          "data/grants.csv",
          "--out",
          out,
        ],
        root,
      ),
    ).toBe(0);
    const dir = join(root, out, "drones");
    const toJudge = JSON.parse(await readFile(join(dir, "to-judge.json"), "utf8"));
    expect(toJudge.items).toHaveLength(3);
    // Incomplete judging is refused.
    await writeFile(
      join(dir, JUDGED),
      JSON.stringify({
        format: "candef-grant-search-judged",
        version: 1,
        query: "drones",
        judgements: [{ key: toJudge.items[0].key, match: "yes", reason: "Fictional reason." }],
      }),
    );
    await expect(runGrantSearch(["report", "--out", out], root)).rejects.toThrow(/Not judged/);
    await writeFile(
      join(dir, JUDGED),
      JSON.stringify({
        format: "candef-grant-search-judged",
        version: 1,
        query: "drones",
        judgements: toJudge.items.map((i: { key: string }, n: number) => ({
          key: i.key,
          match: n === 2 ? "no" : "yes",
          reason: "Fictional reason.",
        })),
      }),
    );
    expect(await runGrantSearch(["report", "--out", out], root)).toBe(0);
    const results = JSON.parse(await readFile(join(dir, "results.json"), "utf8"));
    expect(results.precision).toBeCloseTo(2 / 3);
    expect(await readFile(join(dir, "results.md"), "utf8")).toContain("Fictional reason.");
    expect(new ManualJudge(dir).name).toBe("manual");
  });
});
