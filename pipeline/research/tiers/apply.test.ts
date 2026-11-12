/**
 * apply-tiers on temporary fictional corpora only (never research/).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { AuthoringError } from "../authoring";
import type { TierDecisionsFile } from "../decisions";
import { loadResearchCorpus } from "../load";
import { applyTierPlan, planTierApply } from "./apply";
import { batchHash, RULES_VERSION, type TierRecord } from "./rules";
import type { TiersFile } from "./run";

const H = (c: string) => c.repeat(64);
const rec = (id: string, over: Partial<TierRecord>): TierRecord => ({
  id,
  kind: "assertion",
  orgId: "org_fict_alpha",
  hash: H("1"),
  tier: 2,
  status: "pass",
  route: "",
  rules: [],
  dependsOn: [],
  sources: [],
  values: [],
  ...over,
});

function tiersFile(records: TierRecord[], audit: string[]): TiersFile {
  return {
    format: "candef-tiers",
    version: 1,
    rules: RULES_VERSION,
    today: "2026-10-16",
    generatedAt: "2026-10-16T00:00:00Z",
    batch: batchHash(records),
    inputs: {
      worksheet: null,
      plan: null,
      datasets: { contracts: null, grants: null },
      govRowsLoaded: false,
    },
    counts: {},
    audit,
    records,
  };
}
const decisions = (t: TiersFile, over: Partial<TierDecisionsFile> = {}): TierDecisionsFile => ({
  format: "candef-review-decisions",
  version: 2,
  workspace: { fingerprint: H("f"), generatedAt: "2026-10-16" },
  tiers: { batch: t.batch },
  exportedAt: "2026-10-16T01:00:00Z",
  decisions: [],
  audit: t.audit.map((id) => ({
    id,
    hash: t.records.find((r) => r.id === id)!.hash,
    verdict: "confirm" as const,
    sourceOpened: true,
  })),
  ...over,
});

describe("planTierApply refusals", () => {
  const records = [
    rec("asr_a", {}),
    rec("asr_b", {}),
    rec("asr_j", { tier: 3, status: "judgement" }),
  ];
  const t = tiersFile(records, ["asr_a"]);
  it("refuses when anything changed since the tiers file (batch hash)", () => {
    const changed = records.map((r) =>
      r.id === "asr_b" ? { ...r, status: "exception" as const } : r,
    );
    expect(() =>
      planTierApply(t, { batch: batchHash(changed), records: changed }, decisions(t)),
    ).toThrow(/changed since the tiers file/);
  });
  it("refuses decisions from another batch, an incomplete audit, and any wrong verdict", () => {
    const fresh = { batch: t.batch, records };
    expect(() => planTierApply(t, fresh, decisions(t, { tiers: { batch: H("9") } }))).toThrow(
      /different tiers batch/,
    );
    expect(() => planTierApply(t, fresh, decisions(t, { audit: [] }))).toThrow(
      /audit is incomplete/,
    );
    expect(() =>
      planTierApply(
        t,
        fresh,
        decisions(t, {
          audit: [{ id: "asr_a", hash: H("1"), verdict: "wrong", reason: "x", sourceOpened: true }],
        }),
      ),
    ).toThrow(/whole batch is refused/);
    expect(() =>
      planTierApply(
        t,
        fresh,
        decisions(t, {
          audit: [{ id: "asr_a", hash: H("2"), verdict: "confirm", sourceOpened: true }],
        }),
      ),
    ).toThrow(/changed after it was checked/);
  });
  it("refuses a tiers file written under another rule version", () => {
    expect(() =>
      planTierApply({ ...t, rules: "tiers@0" }, { batch: t.batch, records }, decisions(t)),
    ).toThrow(AuthoringError);
  });
});

describe("planTierApply plan", () => {
  it("approves passes with their basis, owner decisions, and conditionals only with approved anchors", () => {
    const records = [
      rec("asr_pass2", {}),
      rec("agr_pass1", { tier: 1, kind: "agreement" }),
      rec("agr_cond", {
        tier: 1,
        kind: "agreement",
        status: "conditional",
        dependsOn: ["asr_anchor"],
      }),
      rec("agr_wait", {
        tier: 1,
        kind: "agreement",
        status: "conditional",
        dependsOn: ["asr_other"],
      }),
      rec("asr_anchor", { tier: 3, status: "judgement" }),
      rec("asr_other", { tier: 3, status: "judgement" }),
      rec("asr_exc", { status: "exception" }),
    ];
    const t = tiersFile(records, ["asr_pass2"]);
    const plan = planTierApply(
      t,
      { batch: t.batch, records },
      decisions(t, {
        decisions: [
          {
            id: "asr_anchor",
            kind: "assertion",
            hash: H("1"),
            decision: "approve",
            sourceOpened: true,
          },
          {
            id: "asr_other",
            kind: "assertion",
            hash: H("1"),
            decision: "reject",
            reason: "wrong BN",
            sourceOpened: true,
          },
          {
            id: "asr_exc",
            kind: "assertion",
            hash: H("1"),
            decision: "approve",
            sourceOpened: true,
          },
          {
            id: "asr_pass2",
            kind: "assertion",
            hash: H("1"),
            decision: "approve",
            sourceOpened: true,
          },
        ],
      }),
    );
    expect(plan.batch.map((b) => [b.id, b.basis.kind])).toEqual([
      ["asr_pass2", "tier2_source_check"],
      ["agr_pass1", "tier1_dataset_match"],
      ["agr_cond", "tier1_dataset_match"],
    ]);
    expect(plan.approve.map((a) => [a.id, a.basis.kind])).toEqual([
      ["asr_anchor", "owner_judgement"],
      ["asr_exc", "owner_record"],
    ]);
    expect(plan.reject.map((d) => d.id)).toEqual(["asr_other"]);
    expect(plan.waiting).toEqual([{ id: "agr_wait", anchors: ["asr_other"] }]);
    expect(plan.skipped.map((s) => s.id)).toEqual(["asr_pass2"]);
    expect(
      plan.batch.every((b) => b.basis.batch === t.batch && b.basis.rule === RULES_VERSION),
    ).toBe(true);
  });
});

describe("applyTierPlan on a temporary fictional corpus", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "candef-tiers-"));
    roots.push(root);
    mkdirSync(join(root, "sources"));
    mkdirSync(join(root, "orgs"));
    writeFileSync(join(root, "taxonomy.yaml"), "[]\n");
    writeFileSync(
      join(root, "sources", "src_fict.yaml"),
      stringify({
        kind: "registry",
        tier: "T1",
        publisher: "Fictional Registry",
        title: "Fictional",
        url: "https://example.invalid/r",
        publishedOn: null,
        retrievedAt: "2026-10-15T00:00:00Z",
        originGroup: "og:src_fict",
        textSha256: null,
      }),
    );
    writeFileSync(
      join(root, "orgs", "fict-alpha.yaml"),
      stringify({
        org: {
          id: "org_fict_alpha",
          kind: "company",
          slug: "fict-alpha",
          name: "Fictional Alpha",
          isDemo: false,
        },
        defaults: { createdBy: "test" },
        facts: [
          {
            predicate: "legal_name",
            value: "Fictional Alpha Inc.",
            epistemic: "sourced_fact",
            src: ["src_fict#overview"],
          },
          {
            predicate: "founded_year",
            value: 2019,
            epistemic: "sourced_fact",
            src: ["src_fict#overview"],
          },
        ],
      }),
    );
    const corpus = loadResearchCorpus(root).corpus!;
    const [name, year] = corpus.assertions;
    return { root, name: name!, year: year! };
  }

  it("writes hash-bound reviews with their basis, and rejections with the owner's reason", () => {
    const { root, name, year } = setup();
    applyTierPlan(
      root,
      {
        batch: [
          {
            id: name.id,
            basis: { kind: "tier2_source_check", rule: RULES_VERSION, batch: H("b") },
          },
        ],
        approve: [],
        reject: [
          {
            id: year.id,
            kind: "assertion",
            hash: H("1"),
            decision: "reject",
            reason: "registry says 2018",
            sourceOpened: true,
          },
        ],
        waiting: [],
        skipped: [],
      },
      { reviewer: "Owner Name", at: "2026-10-16" },
    );
    const after = loadResearchCorpus(root).corpus!;
    const n = after.assertions.find((a) => a.id === name.id)!;
    expect(n.verification).toBe("verified");
    expect(n.review?.basis).toEqual({
      kind: "tier2_source_check",
      rule: RULES_VERSION,
      batch: H("b"),
    });
    const y = after.assertions.find((a) => a.id === year.id)!;
    expect(y.verification).toBe("rejected");
    expect(y.review?.note).toBe("registry says 2018");
    expect(readFileSync(join(root, "orgs", "fict-alpha.yaml"), "utf8")).toMatch(
      /tier2_source_check/,
    );
  });

  it("refuses an agent as reviewer and leaves files untouched", () => {
    const { root, name } = setup();
    const before = readFileSync(join(root, "orgs", "fict-alpha.yaml"), "utf8");
    expect(() =>
      applyTierPlan(
        root,
        {
          batch: [
            {
              id: name.id,
              basis: { kind: "tier2_source_check", rule: RULES_VERSION, batch: null },
            },
          ],
          approve: [],
          reject: [],
          waiting: [],
          skipped: [],
        },
        { reviewer: "claude", at: "2026-10-16" },
      ),
    ).toThrow(/cannot sign/);
    expect(readFileSync(join(root, "orgs", "fict-alpha.yaml"), "utf8")).toBe(before);
  });
});
