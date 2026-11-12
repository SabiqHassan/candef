/**
 * The lead search page's logic on fictional data: file shape, loading states, URL state, filters,
 * and that the site ranks exactly as the command-line search does.
 */
import { describe, expect, it } from "vitest";
import { demoLeadsFile } from "../../../pipeline/ingest/gov/ask/siteDemo";
import { buildLeadsFile } from "../../../pipeline/ingest/gov/ask/siteExport";
import { fixtures, store } from "../../../pipeline/ingest/gov/ask/search/fixtures";
import { searchLeads } from "../../../pipeline/ingest/gov/ask/search";
import { TAGS } from "../../../pipeline/ingest/gov/ask/tags";
import { LeadsFileSchema, recordUrl, ruleText } from "../../domain/leads/siteData";
import { TAG_IDS, TAG_LABELS } from "../../domain/leads/vocabulary";
import { indexLeads, loadLeads, searchLeadsIn } from "./leadsData";
import { groupRules, recordsPhrase } from "./LeadsPage";
import {
  EMPTY_STATE,
  activeFilterCount,
  parseState,
  toParams,
  toQuery,
  type LeadsState,
} from "./leadsState";

const demo = () => indexLeads(demoLeadsFile());
const keys = (r: ReturnType<typeof searchLeadsIn>) => r.hits.map((h) => h.d.key);

describe("data file", () => {
  it("the demo file is valid, labelled demo, and holds only invented companies", () => {
    const f = LeadsFileSchema.parse(demoLeadsFile());
    expect(f.meta.isDemo).toBe(true);
    expect(f.leads.length).toBeGreaterThan(3);
    expect(f.leads.every((l) => l.name.includes("(fictional)"))).toBe(true);
    expect(f.leads.every((l) => l.key.startsWith("demo:"))).toBe(true);
  });
  it("tag labels in the shared vocabulary match the pipeline's tag definitions", () => {
    for (const id of TAG_IDS) expect(TAG_LABELS[id]).toBe(TAGS[id].label);
  });
  it("links a government record without the amendment suffix, and links nothing without a reference", () => {
    expect(
      recordUrl({ kind: "grant", ownerOrg: "nrc-cnrc", ref: "172-2021-2022-Q1-973871#0" }),
    ).toBe(
      "https://search.open.canada.ca/grants/record/nrc-cnrc%2C172-2021-2022-Q1-973871%2Ccurrent",
    );
    expect(recordUrl({ kind: "contract", ownerOrg: "dnd-mdn", ref: "C-2024-2025-Q4-01121" })).toBe(
      "https://search.open.canada.ca/contracts/record/dnd-mdn%2CC-2024-2025-Q4-01121",
    );
    expect(recordUrl({ kind: "grant", ownerOrg: "", ref: "X" })).toBeNull();
    expect(recordUrl({ kind: "grant", ownerOrg: "dnd-mdn", ref: "" })).toBeNull();
  });
  it("explains every tier rule in words", () => {
    for (const r of [
      "1:defence-programme",
      "2:strong-category",
      "4:defence-text",
      "5:large-defence-total",
    ])
      expect(ruleText(r)).not.toBe(r);
    expect(ruleText("9:unknown")).toBe("9:unknown");
  });
});

describe("loading", () => {
  const ok = JSON.stringify(demoLeadsFile());
  const f = (res: Response) => (async () => res) as unknown as typeof fetch;
  it("loads a good file", async () => {
    const r = await loadLeads("/x", f(new Response(ok)));
    expect(r.status).toBe("ready");
  });
  it("a missing file or a host's HTML page is 'missing', not an error", async () => {
    expect((await loadLeads("/x", f(new Response("no", { status: 404 })))).status).toBe("missing");
    expect((await loadLeads("/x", f(new Response("<html>spa</html>")))).status).toBe("missing");
  });
  it("reports a damaged, incompatible or unreachable file in plain words", async () => {
    const bad = await loadLeads("/x", f(new Response(JSON.stringify({ format: "x" }))));
    expect(bad).toMatchObject({ status: "error" });
    const future = await loadLeads(
      "/x",
      f(new Response(JSON.stringify({ ...JSON.parse(ok), version: 99 }))),
    );
    expect(future).toMatchObject({ status: "error" });
    const down = await loadLeads("/x", (async () => {
      throw new Error("offline");
    }) as typeof fetch);
    expect(down).toMatchObject({ status: "error" });
    const server = await loadLeads("/x", f(new Response("e", { status: 500 })));
    expect(server).toMatchObject({ status: "error" });
    if (server.status === "error")
      expect(server.message).not.toMatch(/stack|undefined|SyntaxError/);
  });
});

describe("URL state", () => {
  it("round-trips every filter", () => {
    const s: LeadsState = {
      q: "drone swarm",
      tags: ["uas_drones", "space"],
      province: "ON",
      programme: "ideas",
      since: "2022",
      firstGrantOnly: true,
      maxValue: 500_000,
      selected: "bn:123456789",
    };
    expect(parseState(toParams(s))).toEqual(s);
    expect(activeFilterCount(s)).toBe(7);
  });
  it("ignores unknown or malformed values instead of failing", () => {
    const s = parseState(
      new URLSearchParams(
        "tag=nope,space&prov=ZZ&prog=x&since=1999&max=7&first=0&q=" + "a".repeat(500),
      ),
    );
    expect(s.tags).toEqual(["space"]);
    expect([s.province, s.programme, s.since, s.maxValue, s.firstGrantOnly]).toEqual([
      "",
      "",
      "",
      0,
      false,
    ]);
    expect(s.q).toHaveLength(200);
  });
  it("an empty state has no filters and no query", () => {
    expect(toParams(EMPTY_STATE).toString()).toBe("");
    expect(toQuery(EMPTY_STATE)).toEqual({});
  });
});

describe("filters on the demo leads", () => {
  it("a word finds its synonyms (drone finds UAS wording)", () => {
    expect(keys(searchLeadsIn(demo(), { text: "drone" }))).toEqual(
      expect.arrayContaining(["demo:tidewater-uas", "demo:alder-ridge"]),
    );
  });
  it("province, sector, programme, first-grant and money filters narrow the list", () => {
    const i = demo();
    expect(searchLeadsIn(i, { provinces: ["QC"] }).hits.map((h) => h.d.provinces[0])).toEqual([
      "QC",
      "QC",
    ]);
    expect(keys(searchLeadsIn(i, { tags: ["space"] }))).toEqual(["demo:orbit-line"]);
    expect(keys(searchLeadsIn(i, { programmes: ["ideas"] })).sort()).toEqual([
      "demo:alder-ridge",
      "demo:tidewater-uas",
    ]);
    expect(searchLeadsIn(i, { maxTotalValue: 100_000 }).hits.map((h) => h.d.key)).toEqual([
      "demo:cipher-mesh",
    ]);
    // Contract-only vendors have one or no grant: "one grant so far" needs exactly one grant agreement.
    const first = searchLeadsIn(i, { firstTimeGrantRecipient: true });
    expect(first.hits.every((h) => h.d.grantAgreements === 1)).toBe(true);
    expect(first.hits.some((h) => h.d.key === "demo:northwind-optics")).toBe(false);
  });
  it("no match gives an empty result, not an error", () => {
    expect(searchLeadsIn(demo(), { text: "xylophone" }).total).toBe(0);
  });
  it("lists every matched company in the count but shows at most the limit", () => {
    const r = searchLeadsIn(demo(), { limit: 2 });
    expect(r.hits).toHaveLength(2);
    expect(r.total).toBeGreaterThan(2);
  });
});

describe("one implementation: the site ranks as the command line does", () => {
  const queries = [
    { text: "drone" },
    { text: "satellite" },
    { tags: ["space" as const] },
    { provinces: ["ON"] },
    { text: "robot autonomous" },
    { programmes: ["ideas"] },
    { maxTotalValue: 100_000 },
    {},
  ];
  it("gives the same companies in the same order for the same query", async () => {
    const docs = fixtures();
    const file = buildLeadsFile(docs, {
      dataDate: "2026-10-13",
      tiers: ["A", "B", "C", "D"],
      isDemo: false,
    });
    const index = indexLeads(file);
    for (const q of queries) {
      const cli = await searchLeads(store(), { ...q, tiers: ["A", "B", "C", "D"], limit: 100 });
      const site = searchLeadsIn(index, { ...q, tiers: ["A", "B", "C", "D"] });
      expect(
        site.hits.map((h) => h.d.key),
        JSON.stringify(q),
      ).toEqual(cli.cards.map((c) => c.key));
      expect(site.total).toBe(cli.total);
    }
  });
});

describe("detail text", () => {
  it("groups a repeated rule into one line", () => {
    const g = groupRules([
      { rule: "4:defence-text", line: 2 },
      { rule: "4:defence-text", line: 3 },
      { rule: "1:defence-programme", line: 0 },
      { rule: "4:defence-text", line: 3 },
    ]);
    expect(g).toEqual([
      { rule: "4:defence-text", lines: [3, 4] },
      { rule: "1:defence-programme", lines: [1] },
    ]);
    expect(recordsPhrase([1])).toBe("record 1 below");
    expect(recordsPhrase([3, 4, 5])).toBe("records 3, 4 and 5 below");
    expect(recordsPhrase([3, 4, 5, 6, 7])).toBe("records 3, 4, 5 and 2 more below");
  });
});
