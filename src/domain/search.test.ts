import { describe, expect, it } from "vitest";
import { compile } from "../../pipeline/compile/compile";
import { generateStressCorpus } from "../../pipeline/synthetic/stress";
import { emptyFilters, filterCompanies, indexSnapshot } from ".";
import { fold, parseQuery, scoreOrg } from "./search";
import type { OrgView } from "./schema/snapshot";

const snap = compile(generateStressCorpus({ companies: 300, seed: 11 }).corpus, {
  today: "2026-10-13",
}).snapshot!;
const ix = indexSnapshot(snap);
const search = (q: string) => filterCompanies(ix, { ...emptyFilters, q });

describe("fold and parseQuery", () => {
  it("ignores accents, case and punctuation", () => {
    expect(fold("Nüvü Caméras, Inc.")).toBe("nuvu cameras inc");
    expect(fold("AT&T  Canada")).toBe("at t canada");
    expect(parseQuery("  Nuvu--Cameras ").tokens).toEqual(["nuvu", "cameras"]);
  });
  it("bounds the number of words, and an empty query has none", () => {
    expect(parseQuery("a b c d e f g h i j k").tokens).toHaveLength(8);
    expect(parseQuery("  ?! ").tokens).toEqual([]);
  });
});

describe("company search", () => {
  const companies = ix.companies;

  it("an empty search returns everyone, in name order", () => {
    expect(search("")).toEqual(companies);
    expect(search("   ")).toEqual(companies);
  });

  it("finds a company by its legal name, with and without the suffix", () => {
    const sample = companies.filter((c) => c.legalName.value).slice(0, 25);
    expect(sample.length).toBeGreaterThan(10);
    for (const c of sample) {
      expect(search(c.legalName.value!)[0], c.legalName.value!).toBe(c);
      expect(search(c.legalName.value!.toUpperCase())).toContain(c);
    }
  });

  it("finds a company by a former legal name", () => {
    const renamed = companies.filter((c) => c.legalName.history?.length);
    expect(renamed.length).toBeGreaterThan(3);
    for (const c of renamed) {
      const earlier = c.legalName.history![0]!.value;
      expect(search(earlier), earlier).toContain(c);
    }
  });

  it("does not depend on word order", () => {
    const c = companies.find((x) => x.hq.value?.city && x.segment.value)!;
    const city = c.hq.value!.city!;
    const topic = c.segment.value!.sectorLabel;
    expect(search(`${city} ${topic}`)).toContain(c);
    expect(search(`${topic} ${city}`)).toContain(c);
    expect(search(`${city} ${c.name}`)).toContain(c);
  });

  it("ranks the company whose name was typed above one that merely contains it", () => {
    const [first, second] = companies.filter((c) => c.name.split(" ").length === 2);
    const twin = { ...second!, id: "x", name: `${first!.name} Holdings` } as OrgView;
    const withTwin = indexSnapshot({ ...snap, organizations: [...snap.organizations, twin] });
    const ranked = filterCompanies(withTwin, { ...emptyFilters, q: first!.name });
    expect(ranked[0]).toBe(withTwin.org.get(first!.id));
    expect(ranked.indexOf(withTwin.org.get("x")!)).toBeGreaterThan(0);
  });

  it("a name that starts with the text comes before one that only contains it", () => {
    const prefix = companies[5]!.name.slice(0, 3);
    const hits = search(prefix);
    const starts = hits.findIndex((c) => !fold(c.name).startsWith(fold(prefix)));
    const lastStart = hits.map((c) => fold(c.name).startsWith(fold(prefix))).lastIndexOf(true);
    if (starts !== -1) expect(lastStart).toBeLessThan(starts);
  });

  it("requires every word typed to match something", () => {
    const c = companies[0]!;
    expect(search(`${c.name} zzzznothing`)).toEqual([]);
  });

  it("matches tickers and registry numbers", () => {
    const listed = companies.find((c) => c.listing.value)!;
    expect(search(listed.listing.value!.ticker)).toContain(listed);
    const withId = {
      ...companies[1]!,
      id: "id1",
      name: "Registry Test Co",
      identifiers: [{ system: "corporations-canada", value: "123456-7", assertionIds: [] }],
    } as OrgView;
    expect(scoreOrg(withId, parseQuery("123456-7"))).toBeGreaterThan(0);
    expect(scoreOrg(withId, parseQuery("123456 7"))).toBeGreaterThan(0);
    expect(scoreOrg(withId, parseQuery("999999"))).toBe(0);
  });

  it("still combines with the other filters", () => {
    const c = companies.find((x) => x.hq.value?.province)!;
    const inProvince = filterCompanies(ix, {
      ...emptyFilters,
      q: c.name,
      province: c.hq.value!.province!,
    });
    expect(inProvince).toContain(c);
    const elsewhere = filterCompanies(ix, { ...emptyFilters, q: c.name, province: "ZZ" });
    expect(elsewhere).toEqual([]);
  });

  it("every previous contiguous-substring match still matches", () => {
    // The old rule: the query appeared inside "name subsector sector city". Nothing that used to be
    // found may disappear.
    const old = (c: OrgView, q: string) =>
      `${c.name} ${c.segment.value?.label ?? ""} ${c.segment.value?.sectorLabel ?? ""} ${c.hq.value?.city ?? ""}`
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .includes(q);
    for (const q of ["rob", "space", "sec", "ott", "tech", "an", "e"]) {
      const now = new Set(search(q));
      for (const c of companies) if (old(c, q)) expect(now.has(c), `${q} → ${c.name}`).toBe(true);
    }
  });
});
