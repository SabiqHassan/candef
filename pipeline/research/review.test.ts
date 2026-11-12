/**
 * Tests for the owner-approval library on TEMPORARY SYNTHETIC corpora only. Nothing here touches
 * research/; agents never run `candef review` on real data.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasValidReview } from "../compile/hash";
import { loadResearchCorpus } from "./load";
import { reviewRecords } from "./review";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const SOURCE = `kind: company_release
tier: T2
publisher: Fictional Gamma
title: Fictional page
url: https://example.org/fictional-gamma
publishedOn: "2025"
retrievedAt: "2026-10-13T00:00:00Z"
originGroup: og:gamma
textSha256: null
`;
const ORG = `# reviewer notes stay in place
org: { id: org_gamma, kind: company, slug: gamma, name: Fictional Gamma }
defaults: { createdBy: "agent:test" }
facts:
  - id: a_legal
    predicate: legal_name
    value: Fictional Gamma Inc.
    src: ["src_gamma#about"]
  - id: a_weak
    predicate: website
    value: https://example.org
    src: [{ source: src_gamma, locator: "footer", quality: related_link }]
rounds:
  - id: fin_gamma_a
    eventState: announced
    roundLabelAsStated: Series A
    stage: series_a
    instrument: equity
    proceeds: primary
    participantsCompleteness: partial_named
    src: ["src_gamma#para 2"]
    disclosures:
      - { date: "2025-06", kind: single, amountBasis: cumulative_round_total,
          amount: { amount: "9000000", currency: CAD, disclosure: disclosed, asStated: "$9M" } }
    participations:
      - { reportedName: Fictional Fund, investorId: org_fund, role: lead }
`;
function setup(): string {
  const r = mkdtempSync(join(tmpdir(), "candef-review-"));
  roots.push(r);
  mkdirSync(join(r, "sources"));
  mkdirSync(join(r, "orgs"));
  writeFileSync(join(r, "sources", "src_gamma.yaml"), SOURCE);
  writeFileSync(join(r, "orgs", "gamma.yaml"), ORG);
  writeFileSync(
    join(r, "orgs", "fund.yaml"),
    "org: { id: org_fund, kind: investor_firm, slug: fund, name: Fictional Fund }\n",
  );
  return r;
}
const AT = "2026-10-13";

describe("owner review (synthetic corpora only)", () => {
  it("approves a fact with a hash the compiler accepts, keeping comments", () => {
    const r = setup();
    reviewRecords(r, { ids: ["a_legal"], reviewer: "owner", at: AT });
    const a = loadResearchCorpus(r).corpus!.assertions.find((x) => x.id === "a_legal")!;
    expect(a.verification).toBe("verified");
    expect(hasValidReview("assertion", a)).toBe(true);
    expect(readFileSync(join(r, "orgs", "gamma.yaml"), "utf8")).toMatch(
      /^# reviewer notes stay in place/,
    );
  });
  it("approves a round together with its disclosures and participations", () => {
    const r = setup();
    const { reviewed } = reviewRecords(r, { ids: ["fin_gamma_a"], reviewer: "owner", at: AT });
    expect(reviewed).toHaveLength(3);
    const round = loadResearchCorpus(r).corpus!.rounds[0]!;
    expect(hasValidReview("round", round)).toBe(true);
    expect(hasValidReview("disclosure", round.disclosures[0]!)).toBe(true);
    expect(hasValidReview("participation", round.participations[0]!)).toBe(true);
  });
  it("an edit after approval invalidates the review", () => {
    const r = setup();
    reviewRecords(r, { ids: ["a_legal"], reviewer: "owner", at: AT });
    const file = join(r, "orgs", "gamma.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("Fictional Gamma Inc.", "Fictional Gamma Ltd."),
    );
    const a = loadResearchCorpus(r).corpus!.assertions.find((x) => x.id === "a_legal")!;
    expect(hasValidReview("assertion", a)).toBe(false);
  });
  it("refuses agent, pipeline and fixture reviewer names", () => {
    const r = setup();
    for (const reviewer of [
      "agent:claude-code",
      "Claude",
      "codex",
      "pipeline:tbs-import",
      "demo-fixture",
      " ",
    ])
      expect(() => reviewRecords(r, { ids: ["a_legal"], reviewer, at: AT })).toThrow(/cannot sign/);
  });
  it("refuses a record that fails its evidence rule, and unknown IDs, writing nothing", () => {
    const r = setup();
    const before = readFileSync(join(r, "orgs", "gamma.yaml"), "utf8");
    expect(() => reviewRecords(r, { ids: ["a_weak"], reviewer: "owner", at: AT })).toThrow(
      /evidence rule/,
    );
    expect(() => reviewRecords(r, { ids: ["nope"], reviewer: "owner", at: AT })).toThrow(/unknown/);
    expect(readFileSync(join(r, "orgs", "gamma.yaml"), "utf8")).toBe(before);
  });
});

describe("approvable records per organization (report command and review --org)", () => {
  it("lists proposed records that pass their evidence rule, and nothing already approved", async () => {
    const { approvableIds } = await import("./review");
    const r = setup();
    let corpus = loadResearchCorpus(r).corpus!;
    // a_weak cites only a related link, so it fails the evidence rule and is left out.
    expect(approvableIds(corpus, "org_gamma", AT)).toEqual(["a_legal", "fin_gamma_a"]);
    reviewRecords(r, { ids: ["a_legal"], reviewer: "owner", at: AT });
    corpus = loadResearchCorpus(r).corpus!;
    expect(approvableIds(corpus, "org_gamma", AT)).toEqual(["fin_gamma_a"]);
  });
});
