import { describe, expect, it } from "vitest";
import { Assertion, type Corpus } from "../../src/domain/schema/corpus";
import { generateDemoCorpus } from "../demo/generate";
import { sealDemoCorpus } from "./hash";
import { compile } from "./compile";
import { auditCitations } from "./citations";
import { buildLensScene, edgeMask } from "../../src/features/explorer/sceneData";
import { indexSnapshot } from "../../src/domain";
import { ZoomLevel } from "../../src/graph/engine/types";

function fixture() {
  const corpus = generateDemoCorpus({ companies: 5 });
  const companies = corpus.organizations.filter((o) => o.kind === "company");
  const base = corpus.assertions.find((a) => a.subjectId === companies[0]!.id)!;
  const a = {
    ...base,
    id: "asr_fictional_lineage",
    predicate: "predecessor_of",
    value: { orgId: companies[1]!.id, event: "amalgamation", date: "2014" },
    verification: "verified",
    review: null,
  } as Corpus["assertions"][number];
  corpus.assertions.push(a);
  return { corpus, a, companies };
}

describe("corporate lineage", () => {
  it("rejects cyclic corporate succession instead of publishing contradictory history", () => {
    const { corpus, a } = fixture();
    const successor = (a.value as { orgId: string }).orgId;
    corpus.assertions.push({
      ...a,
      id: "asr_fictional_reverse",
      subjectId: successor,
      value: { orgId: a.subjectId, event: "reorganization", date: "2017" },
    });
    expect(
      compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" }).failures,
    ).toContainEqual(expect.objectContaining({ gate: "lineage-cycle" }));
  });
  it("rejects longer succession cycles and accepts a simple chain", () => {
    const { corpus, a, companies } = fixture();
    const second = (a.value as { orgId: string }).orgId,
      third = companies[2]!.id;
    corpus.assertions.push({
      ...a,
      id: "asr_fictional_chain",
      subjectId: second,
      value: { orgId: third, event: "other", date: "2017" },
    });
    expect(compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" }).failures).toEqual(
      [],
    );
    corpus.assertions.push({
      ...a,
      id: "asr_fictional_loop",
      subjectId: third,
      value: { orgId: a.subjectId, event: "other", date: "2019" },
    });
    expect(
      compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" }).failures,
    ).toContainEqual(expect.objectContaining({ gate: "lineage-cycle" }));
  });
  it("validates event values in canonical assertions", () => {
    const { a } = fixture();
    expect(Assertion.safeParse(a).success).toBe(true);
    for (const value of [
      { orgId: "x", event: "guess", date: "2014" },
      { orgId: "x", event: "other" },
      { orgId: "", event: "other", date: "2014" },
    ])
      expect(Assertion.safeParse({ ...a, value }).success).toBe(false);
  });
  it("publishes both history directions and a cited edge only after verification", () => {
    const { corpus, a, companies } = fixture();
    const approved = compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" });
    expect(approved.failures).toEqual([]);
    const snap = approved.snapshot!;
    expect(snap.organizations.find((o) => o.id === companies[0]!.id)?.lineage).toContainEqual(
      expect.objectContaining({
        direction: "predecessor_of",
        orgId: companies[1]!.id,
        assertionIds: [a.id],
      }),
    );
    expect(snap.organizations.find((o) => o.id === companies[1]!.id)?.lineage).toContainEqual(
      expect.objectContaining({ direction: "successor_of", orgId: companies[0]!.id }),
    );
    expect(snap.graph.lenses.industry.edges).toContainEqual(
      expect.objectContaining({ kind: "lineage", recordIds: [a.id] }),
    );
    expect(auditCitations(snap)).toEqual([]);
    const scene = buildLensScene(indexSnapshot(snap), "industry");
    const edge = scene.edges.findIndex((e) => e.kind === "lineage");
    expect(edge).toBeGreaterThanOrEqual(0);
    expect(
      edgeMask(scene, {
        selected: null,
        zoom: ZoomLevel.Detail,
        showGrants: true,
        thresholdCad: 0,
      })[edge],
    ).toBe(0);
    expect(
      edgeMask(scene, {
        selected: scene.indexOf.get(companies[0]!.id)!,
        zoom: ZoomLevel.Detail,
        showGrants: true,
        thresholdCad: 0,
      })[edge],
    ).toBe(1);
    snap.assertions[a.id]!.evidence = [];
    expect(auditCitations(snap)).toContainEqual(
      expect.objectContaining({ problem: "no citation" }),
    );
    a.verification = "proposed";
    const proposed = compile(sealDemoCorpus(corpus, "2026-10-16"), {
      today: "2026-10-16",
    }).snapshot!;
    expect(proposed.graph.lenses.industry.edges).toEqual([]);
    a.verification = "verified";
    a.evidence = [];
    expect(
      compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" }).snapshot?.graph.lenses
        .industry.edges ?? [],
    ).toEqual([]);
  });
  it("rejects self links and non-company or missing successors", () => {
    for (const target of ["org_missing", "org_investor", "self"]) {
      const { corpus, a } = fixture();
      (a.value as { orgId: string }).orgId = target === "self" ? a.subjectId : target;
      expect(
        compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" }).failures,
      ).toContainEqual(expect.objectContaining({ gate: "lineage-endpoints" }));
    }
  });
});
