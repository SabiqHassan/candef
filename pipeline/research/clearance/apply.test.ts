/**
 * apply-clearance planning on fictional data only (nothing is written; the writer is apply-tiers'
 * `applyTierPlan`, tested in tiers/apply.test.ts on temporary corpora).
 */
import { describe, expect, it } from "vitest";
import { AuthoringError } from "../authoring";
import { planClearanceApply, type AnswersFile } from "./apply";
import { POLICY_VERSION } from "./policy";
import type { ClearanceRecord, DecisionGroup } from "./route";
import type { ClearanceFile } from "./run";

const H = (c: string) => c.repeat(64);
const rec = (id: string, over: Partial<ClearanceRecord>): ClearanceRecord =>
  ({
    id,
    kind: "assertion",
    orgId: "org_fict",
    orgName: "Fictional Alpha",
    predicate: null,
    fields: [],
    hash: H("1"),
    cls: "K2",
    state: "cleared",
    conditionalOn: [],
    checks: [],
    relations: [],
    homework: [],
    projected: null,
    group: null,
    flags: [],
    support: [],
    delegable: null,
    tiers: { tier: 2, status: "pass", route: "" },
    basis: "",
    lifecycle: {
      researchComplete: true,
      independentlyChecked: true,
      clearedByPolicy: true,
      ownerApproved: false,
    },
    ...over,
  }) as ClearanceRecord;

const group = (
  key: string,
  records: string[],
  actions: DecisionGroup["actions"],
): DecisionGroup => ({
  key,
  kind: key.split(":")[0] as DecisionGroup["kind"],
  orgId: "org_fict",
  orgName: "Fictional Alpha",
  records,
  decisions: 1,
  unlocks: 0,
  question: "",
  recommendation: "",
  bulkAcceptable: false,
  support: [],
  delegableDecisions: 0,
  evidence: [],
  flags: [],
  actions,
});

function file(): ClearanceFile {
  const records = [
    rec("asr_name", { cls: "K2", state: "cleared_qc" }),
    rec("asr_city", { cls: "K2" }),
    rec("agr_row", { kind: "agreement", cls: "K1", conditionalOn: ["asr_bn"] }),
    rec("asr_bn", {
      cls: "K4",
      state: "needs_owner",
      group: { kind: "identity", key: "identity:org_fict" },
    }),
    rec("asr_elig", {
      cls: "K4",
      state: "needs_owner",
      predicate: "eligibility",
      group: { kind: "scope", key: "scope:org_fict" },
    }),
    rec("asr_class", {
      cls: "K4",
      state: "needs_owner",
      predicate: "classified_as",
      group: { kind: "scope", key: "scope:org_fict" },
    }),
    rec("fin_x", { kind: "round", cls: "K3", state: "homework" }),
  ];
  return {
    format: "candef-clearance",
    policy: POLICY_VERSION,
    policyActive: true,
    today: "2026-10-20",
    generatedAt: "",
    batch: H("b"),
    cohort: ["X01"],
    run: { cacheDir: "", returnsDir: "", independenceFile: null, cardsFile: null },
    inputs: { packages: 0, researchers: [], govRowsLoaded: true, worksheetRows: 0 },
    counts: {},
    workload: {} as ClearanceFile["workload"],
    records,
    groups: [
      group(
        "identity:org_fict",
        ["asr_bn"],
        [{ id: "asr_bn", kind: "assertion", hash: H("1"), onAccept: "approve" }],
      ),
      group(
        "scope:org_fict",
        ["asr_elig", "asr_class"],
        [
          {
            id: "asr_elig",
            kind: "assertion",
            hash: H("1"),
            onAccept: "reject",
            reason: "cites a predecessor's row",
          },
          { id: "asr_class", kind: "assertion", hash: H("1"), onAccept: "approve" },
        ],
      ),
    ],
    qc: [{ id: "asr_name", reasons: ["random"] }],
    completeness: [],
    homework: [],
    inconsistentRecheck: [],
  };
}

const answers = (a: AnswersFile["answers"], batch = H("b")): AnswersFile => ({
  format: "candef-clearance-review",
  batch,
  policy: POLICY_VERSION,
  exportedAt: "2026-10-20T00:00:00Z",
  answers: a,
});

describe("planClearanceApply", () => {
  it("applies accepted recommendations per record and the cleared records with the policy basis", () => {
    const f = file();
    const p = planClearanceApply(
      f,
      f,
      answers({
        "qc:asr_name": { choice: "correct" },
        "identity:org_fict": { choice: "accept" },
        "scope:org_fict": { choice: "accept" },
      }),
    );
    expect(p.approve.map((a) => [a.id, a.basis.kind])).toEqual([
      ["asr_bn", "owner_judgement"],
      ["asr_class", "owner_judgement"],
    ]);
    expect(p.reject.map((r) => r.id)).toEqual(["asr_elig"]);
    expect(p.batch.map((b) => [b.id, b.basis.kind]).sort()).toEqual([
      ["agr_row", "policy_clearance"],
      ["asr_city", "policy_clearance"],
      ["asr_name", "policy_clearance"],
    ]);
    // Homework is never applied.
    expect([...p.approve, ...p.batch].some((a) => a.id === "fin_x")).toBe(false);
  });

  it("keeps a government row waiting while its identity anchor is not confirmed", () => {
    const f = file();
    const p = planClearanceApply(
      f,
      f,
      answers({
        "qc:asr_name": { choice: "correct" },
        "identity:org_fict": { choice: "research" },
      }),
    );
    expect(p.waiting).toEqual([{ id: "agr_row", anchors: ["asr_bn"] }]);
    expect(p.open[0]!.key).toBe("identity:org_fict");
    expect(p.unanswered).toEqual(["scope:org_fict"]);
  });

  it("refuses an incomplete audit", () => {
    const f = file();
    expect(() => planClearanceApply(f, f, answers({}))).toThrow(/audit is incomplete/);
  });

  it("holds every cleared record of a class when an audit record of that class is wrong", () => {
    const f = file();
    const p = planClearanceApply(
      f,
      f,
      answers({ "qc:asr_name": { choice: "wrong", note: "the copy says 2014" } }),
    );
    expect(p.held.map((h) => h.id).sort()).toEqual(["asr_city", "asr_name"]);
    expect(p.batch.map((b) => b.id)).toEqual([]); // agr_row (K1) still waits for its anchor
  });

  it("refuses when anything changed since the queue was made", () => {
    const f = file();
    const changed = {
      ...f,
      records: f.records.map((r) => (r.id === "asr_city" ? { ...r, hash: H("2") } : r)),
    };
    expect(() =>
      planClearanceApply(f, changed, answers({ "qc:asr_name": { choice: "correct" } })),
    ).toThrow(/changed/);
    expect(() => planClearanceApply(f, { ...f, batch: H("c") }, answers({}))).toThrow(
      AuthoringError,
    );
    expect(() => planClearanceApply(f, f, answers({}, H("d")))).toThrow(
      /different clearance batch/,
    );
  });

  it("requires a reason to reject a whole group and refuses answers for unknown cards", () => {
    const f = file();
    expect(() =>
      planClearanceApply(
        f,
        f,
        answers({ "qc:asr_name": { choice: "correct" }, "scope:org_fict": { choice: "reject" } }),
      ),
    ).toThrow(/needs a reason/);
    expect(() =>
      planClearanceApply(
        f,
        f,
        answers({ "qc:asr_name": { choice: "correct" }, "scope:org_other": { choice: "accept" } }),
      ),
    ).toThrow(/unknown cards/);
  });
});
