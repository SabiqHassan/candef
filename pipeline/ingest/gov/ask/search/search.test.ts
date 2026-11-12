// Fictional companies only. No network, no key, no real data.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildIndex } from "../leadIndex";
import { answerMd, cardMd } from "./card";
import { main as cli } from "./cli";
import { company, fixtures, line, store } from "./fixtures";
import { checkAnswerCitations, getCompany, LeadStore, searchLeads } from "./index";
import { Answer, Claim, LEAD_LABEL, SearchQuery } from "./schema";
import { runTool, toolDefs } from "./tools";
import { defaultWebProvider, webLookup } from "./web";

const keys = (r: { cards: { key: string }[] }) => r.cards.map((c) => c.key);

describe("searchLeads filters", () => {
  it("defaults to tier A and excludes suppliers and out companies", async () => {
    const r = await searchLeads(store(), {});
    expect(keys(r)).not.toContain("k-supplier");
    expect(keys(r)).not.toContain("k-no");
    expect(r.cards.every((c) => c.tier === "A")).toBe(true);
    expect(keys(await searchLeads(store(), { tiers: ["B"] }))).toEqual(["k-supplier"]);
  });
  it("filters by tags (any of)", async () => {
    const r = await searchLeads(store(), { tags: ["uas_drones", "space"] });
    expect(keys(r).sort()).toEqual(["k-drone", "k-space"]);
  });
  it("filters by province, including groups", async () => {
    expect(keys(await searchLeads(store(), { provinces: ["QC"] }))).toEqual(["k-space"]);
    expect(
      keys(await searchLeads(store(), { provinces: ["atlantic"], tiers: ["A", "B"] })).sort(),
    ).toEqual(["k-drone", "k-supplier", "k-text"]);
    expect(keys(await searchLeads(store(), { provinces: ["Ontario"], tiers: ["A", "D"] }))).toEqual(
      ["k-robot"],
    );
  });
  it("filters by first seen and first grant date (on or after)", async () => {
    const r = await searchLeads(store(), { firstSeenAfter: "2023" });
    expect(keys(r).sort()).toEqual(["k-drone", "k-text"].sort());
    const g = await searchLeads(store(), { firstGrantAfter: "2024-01-01", tiers: ["A", "D"] });
    expect(keys(g)).toContain("k-text");
    expect(keys(g)).not.toContain("k-space");
  });
  it("filters first-time grant recipients and total value", async () => {
    const r = await searchLeads(store(), { firstTimeGrantRecipient: true });
    expect(keys(r)).not.toContain("k-space"); // two agreements
    expect(keys(r)).toContain("k-drone");
    const cheap = await searchLeads(store(), { maxTotalValue: 100_000, tiers: ["A", "B"] });
    expect(keys(cheap)).not.toContain("k-space");
    expect(keys(cheap)).not.toContain("k-ammo");
  });
  it("filters by department and by programme with a since date", async () => {
    expect(keys(await searchLeads(store(), { departments: ["Space Agency"] }))).toEqual([
      "k-space",
    ]);
    expect(
      keys(await searchLeads(store(), { departments: ["dnd-mdn"], tiers: ["A", "B"] })).sort(),
    ).toEqual(["k-ammo", "k-drone", "k-supplier"]);
    expect(keys(await searchLeads(store(), { programmes: ["IDEaS"] }))).toEqual(["k-drone"]);
    expect(
      keys(await searchLeads(store(), { programmes: ["IDEaS"], programmeSince: "2024" })),
    ).toEqual([]);
    expect(
      keys(
        await searchLeads(store(), { programmes: ["Space Technology"], programmeSince: "2020" }),
      ),
    ).toEqual(["k-space"]);
  });
  it("rejects an out-of-range limit and honours the limit", async () => {
    expect(() => SearchQuery.parse({ limit: 101 })).toThrow();
    const r = await searchLeads(store(), { limit: 1, tiers: ["A", "B", "D"] });
    expect(r.cards).toHaveLength(1);
    expect(r.total).toBeGreaterThan(1);
  });
});

describe("searchLeads ranking", () => {
  it("expands synonyms: drone finds a UAV project and says where it matched", async () => {
    const r = await searchLeads(store(), { text: "drone" });
    expect(keys(r)[0]).toBe("k-drone");
    const m = r.cards[0]!.matchedOn;
    expect(m.some((x) => x.field === "name")).toBe(true);
    expect(m.some((x) => x.field === "line" && x.terms.includes("uav"))).toBe(true);
  });
  it("returns nothing when no word matches", async () => {
    expect((await searchLeads(store(), { text: "bakery" })).total).toBe(0);
  });
  it("ranks structured evidence above defence text alone, and A above B", async () => {
    const r = await searchLeads(store(), { tiers: ["A", "B"] });
    const order = keys(r);
    expect(order.indexOf("k-text")).toBeGreaterThan(order.indexOf("k-drone"));
    expect(order.indexOf("k-supplier")).toBeGreaterThan(order.indexOf("k-text"));
  });
  it("is deterministic", async () => {
    const a = await searchLeads(store(), { text: "robot satellite", tiers: ["A", "B", "D"] });
    const b = await searchLeads(store(), { text: "robot satellite", tiers: ["A", "B", "D"] });
    expect(a).toEqual(b);
  });
});

describe("lead cards and citations", () => {
  it("every claim has at least one source and every source resolves to a stored row", async () => {
    const s = store();
    const r = await searchLeads(s, { tiers: ["A", "B", "D"], limit: 50 });
    expect(r.cards.length).toBeGreaterThan(3);
    for (const c of r.cards) {
      expect(c.label).toBe(LEAD_LABEL);
      expect(c.claims.length).toBeGreaterThan(0);
      for (const cl of c.claims) expect(cl.sources.length).toBeGreaterThan(0);
    }
    const answer: Answer = {
      question: "q",
      summary: "s",
      leads: r.cards.map((c) => ({
        key: c.key,
        name: c.name,
        tier: c.tier,
        whyMatched: "w",
        claims: c.claims,
        unknowns: c.unknowns,
      })),
      searchesRun: [],
      notes: [],
      label: LEAD_LABEL,
    };
    expect(Answer.safeParse(answer).success).toBe(true);
    expect(await checkAnswerCitations(s, answer)).toEqual([]);
  });
  it("a claim without a source cannot be built", () => {
    expect(Claim.safeParse({ text: "x", sources: [] }).success).toBe(false);
  });
  it("lists founding year as not researched and never states one", async () => {
    const r = await searchLeads(store(), { text: "robot", tiers: ["A", "B", "D"] });
    const c = r.cards[0]!;
    expect(c.unknowns).toContainEqual({ field: "founding year", state: "not_researched" });
    expect(cardMd(c)).toContain("not the founding date");
  });
  it("detects a citation that does not match the stored row", async () => {
    const s = store();
    const c = (await searchLeads(s, { text: "robot", tiers: ["A", "B", "D"] })).cards[0]!;
    const good = c.claims[0]!;
    const src = { ...good.sources[0]!, value: 1 } as (typeof good.sources)[number];
    const bad = {
      question: "q",
      summary: "s",
      leads: [
        {
          key: c.key,
          name: c.name,
          tier: c.tier,
          whyMatched: "w",
          claims: [{ text: "t", sources: [src] }],
          unknowns: [],
        },
      ],
      searchesRun: [],
      notes: [],
      label: LEAD_LABEL,
    } as Answer;
    expect((await checkAnswerCitations(s, bad))[0]).toMatch(/does not match/);
    const missing = { ...bad, leads: [{ ...bad.leads[0]!, key: "nope" }] } as Answer;
    expect((await checkAnswerCitations(s, missing))[0]).toMatch(/unknown company/);
  });
  it("renders an answer as Markdown with sources", async () => {
    const c = (await searchLeads(store(), { text: "robot", tiers: ["A", "B", "D"] })).cards[0]!;
    const md = answerMd({
      question: "Who?",
      summary: "One.",
      leads: [
        {
          key: c.key,
          name: c.name,
          tier: c.tier,
          whyMatched: "w",
          claims: c.claims,
          unknowns: c.unknowns,
        },
      ],
      searchesRun: ["{}"],
      notes: ["n"],
      label: LEAD_LABEL,
    });
    expect(md).toContain("source: grant");
    expect(md).toContain(LEAD_LABEL);
  });
});

describe("getCompany and web lookup", () => {
  it("returns the company with its rows, or null", async () => {
    const c = await getCompany(store(), "k-space");
    expect(c!.lines).toHaveLength(2);
    expect(c!.card.name).toBe("Aurora Orbit Inc");
    expect(await getCompany(store(), "missing")).toBeNull();
  });
  it("web lookup answers not_researched without a provider and not_configured with a key slot", async () => {
    expect((await webLookup("X", "founded?", defaultWebProvider({}))).state).toBe("not_researched");
    const withKey = await webLookup(
      "X",
      "founded?",
      defaultWebProvider({ CANDEF_WEBSEARCH_API_KEY: "secret-value-123" }),
    );
    expect(withKey.state).toBe("not_configured");
    expect(JSON.stringify(withKey)).not.toContain("secret-value-123");
  });
});

describe("tools", () => {
  it("defines the three tools with JSON schemas", () => {
    const defs = toolDefs();
    expect(defs.map((d) => d.name)).toEqual(["search_leads", "get_company", "web_lookup"]);
    const search = defs[0]!.parameters as { properties: Record<string, unknown>; type: string };
    expect(search.type).toBe("object");
    expect(Object.keys(search.properties)).toEqual(
      expect.arrayContaining(["text", "tags", "tiers", "provinces", "limit"]),
    );
  });
  it("runs a search tool call, caps the limit, and turns bad arguments into an error result", async () => {
    const s = store();
    const ok = await runTool({ store: s, maxSearchLimit: 2 }, "search_leads", {
      tiers: ["A", "B", "D"],
      limit: 50,
    });
    expect(ok.ok).toBe(true);
    expect((ok as { result: { cards: unknown[] } }).result.cards).toHaveLength(2);
    const bad = await runTool({ store: s }, "search_leads", { tags: ["not_a_tag"] });
    expect(bad.ok).toBe(false);
    expect((await runTool({ store: s }, "get_company", {})).ok).toBe(false);
    expect((await runTool({ store: s }, "nope", {})).ok).toBe(false);
    expect((await runTool({ store: s }, "web_lookup", { name: "X", question: "q" })).ok).toBe(true);
  });
});

describe("CLI over a built index", () => {
  it("searches, gets a company and renders a checked answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "leads-cli-"));
    const base = join(root, "research-cache", "grant-ask");
    await mkdir(join(base, "full"), { recursive: true });
    const docs = fixtures();
    const profiles = docs.map((d) => ({ ...d, grantCount: d.grantCount }));
    await writeFile(
      join(base, "full", "profiles.jsonl"),
      profiles
        .map((p) =>
          JSON.stringify({
            key: p.key,
            name: p.name,
            otherNames: [],
            businessNumber: null,
            cities: p.cities,
            provinces: p.provinces,
            areas: [],
            grantCount: p.grantCount,
            contractCount: p.contractCount,
            grantValue: p.grantValue,
            contractValue: p.contractValue,
            dndContractValue: p.dndContractValue,
            firstDate: p.firstDate,
            lastDate: p.lastDate,
            lines: p.lines,
          }),
        )
        .join("\n") + "\n",
    );
    await writeFile(
      join(base, "triage.jsonl"),
      docs
        .map((d) =>
          JSON.stringify({
            key: d.key,
            verdict: d.verdict,
            reason: d.reason,
            status: "in",
            judge: "manual",
          }),
        )
        .join("\n") + "\n",
    );
    await buildIndex({
      profilesPath: join(base, "full", "profiles.jsonl"),
      triagePath: join(base, "triage.jsonl"),
      outDir: join(base, "index"),
    });

    const lines: string[] = [];
    const out = (s: string) => lines.push(s);
    expect(await cli(["search", "--text", "drone", "--json"], root, out)).toBe(0);
    const res = JSON.parse(lines.join("\n")) as { cards: { key: string }[] };
    expect(res.cards[0]!.key).toBe("k-drone");

    lines.length = 0;
    // k-no is tier out: it is read back from leads.jsonl and profiles.jsonl by offset.
    expect(await cli(["get", "k-no", "--json"], root, out)).toBe(0);
    expect(JSON.parse(lines.join("\n")).lines).toHaveLength(1);

    const card = (
      await searchLeads(
        new LeadStore({
          indexDir: join(base, "index"),
          profilesPath: join(base, "full", "profiles.jsonl"),
        }),
        { text: "robot", tiers: ["A", "B", "D"] },
      )
    ).cards[0]!;
    const ans = {
      question: "q",
      summary: "s",
      leads: [
        {
          key: card.key,
          name: card.name,
          tier: card.tier,
          whyMatched: "w",
          claims: card.claims,
          unknowns: card.unknowns,
        },
      ],
      searchesRun: [],
      notes: [],
      label: LEAD_LABEL,
    };
    await writeFile(join(root, "a.json"), JSON.stringify(ans));
    lines.length = 0;
    expect(await cli(["render", join(root, "a.json")], root, out)).toBe(0);
    expect(await readFile(join(root, "a.md"), "utf8")).toContain("Maple Robotics");
  });
});

describe("category and programme-alias filters", () => {
  it("filters by contract category, and by category plus department on the same row", async () => {
    expect(keys(await searchLeads(store(), { categories: ["ammun"] }))).toEqual(["k-ammo"]);
    expect(
      keys(await searchLeads(store(), { categories: ["ammun"], departments: ["Space Agency"] })),
    ).toEqual([]);
    expect(
      keys(
        await searchLeads(store(), {
          categories: ["furniture"],
          departments: ["dnd-mdn"],
          tiers: ["B"],
        }),
      ),
    ).toEqual(["k-supplier"]);
  });
  it("understands programme abbreviations", async () => {
    expect(keys(await searchLeads(store(), { programmes: ["IDEaS"] }))).toEqual(["k-drone"]);
    expect(keys(await searchLeads(store(), { programmes: ["ideas"], text: "drone" }))).toEqual([
      "k-drone",
    ]);
  });
});

describe("programme and tag on the same grant row", () => {
  it("does not match a company whose tag row and programme row differ", async () => {
    const mixed = company("k-mixed", "Split Rows Inc", [
      line({
        title: "Cybersecurity audit",
        programme: "Other Programme",
        date: "2019-01-01",
        ref: "G-30#0",
      }),
      line({
        title: "Office move",
        programme: "Industrial Research Assistance Program",
        date: "2024-01-01",
        ref: "G-31#0",
      }),
    ]);
    const same = company("k-same", "Same Row Inc", [
      line({
        title: "Cybersecurity platform",
        programme: "Industrial Research Assistance Program",
        date: "2024-02-01",
        ref: "G-32#0",
      }),
    ]);
    const s = LeadStore.fromDocs([mixed, same]);
    const r = await searchLeads(s, {
      tags: ["cyber"],
      programmes: ["IRAP"],
      programmeSince: "2023",
      tiers: ["A", "D"],
    });
    expect(keys(r)).toEqual(["k-same"]);
  });
});
