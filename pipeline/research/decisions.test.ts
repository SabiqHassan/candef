/**
 * Owner review decisions on TEMPORARY SYNTHETIC corpora only. Nothing here touches research/;
 * agents never run `candef apply-decisions` on real data.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasIntactReview, hasValidReview } from "../compile/hash";
import {
  applyDecisions,
  DecisionsFile,
  planDecisions,
  readDecisionsFile,
  reviewUnits,
  workspaceFingerprint,
  type Decision,
} from "./decisions";
import { loadResearchCorpus } from "./load";

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
const ORG = `org: { id: org_gamma, kind: company, slug: gamma, name: Fictional Gamma }
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
const AT = "2026-10-13";

function setup(): string {
  const r = mkdtempSync(join(tmpdir(), "candef-decisions-"));
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

/** What the workspace would export for these choices, at the content it showed. */
function exportFor(
  root: string,
  choices: Record<string, Partial<Decision> & { decision: Decision["decision"] }>,
): DecisionsFile {
  const units = reviewUnits(loadResearchCorpus(root).corpus!, AT);
  return {
    format: "candef-review-decisions",
    version: 1,
    workspace: { fingerprint: workspaceFingerprint(units, AT), generatedAt: AT },
    exportedAt: `${AT}T12:00:00Z`,
    decisions: units
      .filter((u) => choices[u.id])
      .map((u) => ({
        id: u.id,
        kind: u.kind,
        hash: u.hash,
        sourceOpened: true,
        ...choices[u.id]!,
      })),
  };
}
const corpusOf = (r: string) => loadResearchCorpus(r).corpus!;
const OWNER = { reviewer: "owner", at: AT, includeUnopened: false };

describe("review units", () => {
  it("lists every proposed record once, flagging those that cannot be approved", () => {
    const units = reviewUnits(corpusOf(setup()), AT);
    expect(units.map((u) => [u.id, u.kind, u.approvable])).toEqual([
      ["a_legal", "assertion", true],
      ["a_weak", "assertion", false],
      ["fin_gamma_a", "round", true],
    ]);
    expect(units.every((u) => u.orgId === "org_gamma")).toBe(true);
  });
});

describe("planning and applying decisions (owner only; synthetic corpora)", () => {
  it("approves with a valid review and rejects with the reason, both hash-bound", () => {
    const r = setup();
    const file = exportFor(r, {
      a_legal: { decision: "approve" },
      a_weak: { decision: "reject", reason: "Footer link only; not evidence of the website claim" },
    });
    const { approved, rejected } = applyDecisions(r, file, OWNER);
    expect(approved).toEqual(["a_legal"]);
    expect(rejected).toEqual(["a_weak"]);
    const c = corpusOf(r);
    const legal = c.assertions.find((a) => a.id === "a_legal")!;
    const weak = c.assertions.find((a) => a.id === "a_weak")!;
    expect(hasValidReview("assertion", legal)).toBe(true);
    expect(weak.verification).toBe("rejected");
    expect(hasValidReview("assertion", weak)).toBe(false);
    expect(hasIntactReview("assertion", weak)).toBe(true);
    expect(weak.review?.note).toMatch(/Footer link only/);
  });

  it("skips a decision whose record changed after the workspace was generated", () => {
    const r = setup();
    const file = exportFor(r, { a_legal: { decision: "approve" } });
    const path = join(r, "orgs", "gamma.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("Gamma Inc.", "Gamma Ltd."));
    const before = readFileSync(path, "utf8");
    const { approved, plan } = applyDecisions(r, file, OWNER);
    expect(approved).toEqual([]);
    expect(plan.stale.map((d) => d.id)).toEqual(["a_legal"]);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("treats a change to a round's participant as a change to the round", () => {
    const r = setup();
    const file = exportFor(r, { fin_gamma_a: { decision: "approve" } });
    const path = join(r, "orgs", "gamma.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("role: lead", "role: participant"));
    expect(planDecisions(corpusOf(r), file, AT).stale.map((d) => d.id)).toEqual(["fin_gamma_a"]);
  });

  it("refuses approving a record that fails its evidence rule, but allows rejecting it", () => {
    const r = setup();
    const plan = planDecisions(corpusOf(r), exportFor(r, { a_weak: { decision: "approve" } }), AT);
    expect(plan.refused.map((d) => d.id)).toEqual(["a_weak"]);
    expect(plan.approve).toEqual([]);
  });

  it("holds back approvals whose sources were never opened unless the owner confirms", () => {
    const r = setup();
    const file = exportFor(r, { a_legal: { decision: "approve", sourceOpened: false } });
    expect(applyDecisions(r, file, OWNER).approved).toEqual([]);
    expect(corpusOf(r).assertions.find((a) => a.id === "a_legal")!.verification).toBe("proposed");
    expect(applyDecisions(r, file, { ...OWNER, includeUnopened: true }).approved).toEqual([
      "a_legal",
    ]);
  });

  it("approves a round with its disclosures and participants", () => {
    const r = setup();
    const { approved } = applyDecisions(
      r,
      exportFor(r, { fin_gamma_a: { decision: "approve" } }),
      OWNER,
    );
    expect(approved).toHaveLength(3);
    expect(hasValidReview("round", corpusOf(r).rounds[0]!)).toBe(true);
  });

  it("does not apply a decision twice", () => {
    const r = setup();
    const file = exportFor(r, { a_legal: { decision: "approve" } });
    applyDecisions(r, file, OWNER);
    const again = applyDecisions(r, file, OWNER);
    expect(again.approved).toEqual([]);
    expect(again.plan.notProposed.map((d) => d.id)).toEqual(["a_legal"]);
  });

  it("refuses agent reviewer names and writes nothing", () => {
    const r = setup();
    const before = readFileSync(join(r, "orgs", "gamma.yaml"), "utf8");
    expect(() =>
      applyDecisions(r, exportFor(r, { a_legal: { decision: "approve" } }), {
        ...OWNER,
        reviewer: "agent:claude-code",
      }),
    ).toThrow(/cannot sign/);
    expect(readFileSync(join(r, "orgs", "gamma.yaml"), "utf8")).toBe(before);
  });

  it("restores every file when a later step fails", () => {
    const r = setup();
    const before = readFileSync(join(r, "orgs", "gamma.yaml"), "utf8");
    const file = exportFor(r, {
      a_legal: { decision: "approve" },
      a_weak: { decision: "reject", reason: "x".repeat(10) },
    });
    // A reason over the limit makes the rejection fail after the approval was written.
    file.decisions.find((d) => d.id === "a_weak")!.reason = "x".repeat(501);
    expect(() => applyDecisions(r, file, OWNER)).toThrow(/500/);
    expect(readFileSync(join(r, "orgs", "gamma.yaml"), "utf8")).toBe(before);
  });
});

describe("decisions file validation (untrusted input)", () => {
  const write = (r: string, value: unknown) => {
    const p = join(r, "d.json");
    writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value));
    return p;
  };
  it("accepts an exported file", () => {
    const r = setup();
    const file = exportFor(r, { a_legal: { decision: "approve" } });
    expect(readDecisionsFile(write(r, file)).decisions).toHaveLength(1);
  });
  it("rejects malformed JSON, unknown fields, duplicates, bad hashes and reasonless rejections", () => {
    const r = setup();
    const good = exportFor(r, { a_legal: { decision: "approve" } });
    const d = good.decisions[0]!;
    for (const bad of [
      "{not json",
      { ...good, extra: true },
      { ...good, decisions: [d, d] },
      { ...good, decisions: [{ ...d, hash: "abc" }] },
      { ...good, decisions: [{ ...d, decision: "reject" }] },
      { ...good, decisions: [{ ...d, id: "../../etc" }] },
      { ...good, format: "something-else" },
    ])
      expect(() => readDecisionsFile(write(r, bad))).toThrow(/not valid/);
  });
});
