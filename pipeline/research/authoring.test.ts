import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthoringError,
  addSource,
  appendLedger,
  canonicalUrl,
  newOrg,
  slugify,
  sourceIdForUrl,
  ulid,
  localDate,
} from "./authoring";
import { loadResearchCorpus } from "./load";

const roots: string[] = [];
const root = () => {
  const r = mkdtempSync(join(tmpdir(), "candef-author-"));
  roots.push(r);
  return r;
};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("identifiers", () => {
  it("mints 26-char Crockford ULIDs that sort by time", () => {
    const a = ulid(1_700_000_000_000, new Uint8Array(10));
    const b = ulid(1_700_000_000_001, new Uint8Array(10).fill(255));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
  it("derives one source ID per canonical URL", () => {
    expect(canonicalUrl("https://Example.org/News/Item/?utm_source=x#top")).toBe(
      "https://example.org/News/Item",
    );
    expect(sourceIdForUrl("https://example.org/a?b=2&a=1")).toBe(
      sourceIdForUrl("https://EXAMPLE.org/a?a=1&b=2&utm_medium=email"),
    );
    expect(slugify("Systèmes Alpha & Fils Inc.")).toBe("systemes-alpha-and-fils-inc");
  });
});

describe("candef new / source add / ledger", () => {
  it("creates an organization file the loader accepts, as proposed-only data", () => {
    const r = root();
    const { id } = newOrg(r, {
      kind: "company",
      name: "Fictional Alpha Robotics",
      by: "agent:test",
    });
    const { corpus, issues } = loadResearchCorpus(r);
    expect(issues).toEqual([]);
    expect(corpus!.organizations[0]).toMatchObject({
      id,
      slug: "fictional-alpha-robotics",
      isDemo: false,
    });
    expect(id).toMatch(/^org_[0-9A-Z]{26}$/);
  });
  it("refuses a name that normalizes to an existing organization of the same kind", () => {
    const r = root();
    newOrg(r, { kind: "company", name: "Fictional Alpha Robotics", by: "t" });
    expect(() =>
      newOrg(r, { kind: "company", name: "FICTIONAL ALPHA ROBOTICS INC.", slug: "other", by: "t" }),
    ).toThrow(AuthoringError);
    // A fund with the same name is a different kind of entity.
    expect(() =>
      newOrg(r, { kind: "fund", name: "Fictional Alpha Robotics", slug: "alpha-fund", by: "t" }),
    ).not.toThrow();
  });
  it("adds a source with unknown permissions and refuses the same page twice", () => {
    const r = root();
    const { id } = addSource(r, {
      url: "https://example.org/fictional/release?utm_campaign=x",
      kind: "company_release",
      tier: "T2",
      publisher: "Fictional Alpha",
      title: "Fictional release",
    });
    const src = loadResearchCorpus(r).corpus!.sources[0]!;
    expect(src.id).toBe(id);
    expect(src.url).toBe("https://example.org/fictional/release");
    expect(src.permissions?.capture).toBe("unknown");
    expect(() =>
      addSource(r, {
        url: "https://EXAMPLE.org/fictional/release/",
        kind: "news",
        tier: "T3",
        publisher: "x",
        title: "x",
      }),
    ).toThrow(/already/);
  });
  it("appends ledger entries, keeps comments, and validates topic and outcome", () => {
    const r = root();
    newOrg(r, { kind: "company", name: "Fictional Beta", by: "t" });
    appendLedger(r, "fictional-beta", {
      topic: "financing",
      outcome: "none_found",
      sourcesSearched: ["company site", "BetaKit"],
      by: "agent:test",
      at: "2026-10-13",
      nextReview: "2027-04",
    });
    const text = readFileSync(join(r, "orgs", "fictional-beta.yaml"), "utf8");
    expect(text).toMatch(/^# Created by candef new/);
    const research = loadResearchCorpus(r).corpus!.research;
    expect(research).toHaveLength(1);
    expect(research[0]).toMatchObject({
      topic: "financing",
      outcome: "none_found",
      nextReview: "2027-04",
    });
    expect(() =>
      appendLedger(r, "fictional-beta", {
        topic: "gossip",
        outcome: "found",
        sourcesSearched: [],
        by: "t",
      }),
    ).toThrow();
  });
});

describe("localDate", () => {
  it("uses the researcher's own calendar date, not UTC", () => {
    expect(localDate(new Date(2026, 9, 13, 23, 30))).toBe("2026-10-13");
    expect(localDate(new Date(2026, 0, 2, 0, 5))).toBe("2026-01-02");
  });
});
