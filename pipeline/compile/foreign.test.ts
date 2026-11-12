import { describe, expect, it } from "vitest";
import { foreignFixture } from "./foreign.test-helpers";
import { compile } from "./compile";
import { sealDemoCorpus } from "./hash";
import { auditCitations } from "./citations";
import { governmentJurisdiction } from "../../src/domain/government";
import { evaluateTiers } from "../research/tiers/rules";
import { inputs } from "../research/tiers/fixture.test-helpers";

describe("documented foreign government agreements", () => {
  it("keeps the foreign agency contextual and preserves USD values without TBS rows", () => {
    const { corpus } = foreignFixture();
    const r = compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" });
    expect(r.failures).toEqual([]);
    const snap = r.snapshot!;
    const agency = snap.organizations.find((o) => o.id === "org_fictional_foreign")!;
    expect(agency.scope).toBe("contextual");
    expect(governmentJurisdiction(agency)).toBe("foreign");
    expect(
      governmentJurisdiction({
        ...agency,
        hq: { ...agency.hq, value: null, state: "not_researched" },
      }),
    ).toBe("unknown");
    expect(
      governmentJurisdiction({
        ...agency,
        hq: { ...agency.hq, value: { ...agency.hq.value!, country: "CA" } },
      }),
    ).toBe("canadian");
    expect(snap.organizations.some((o) => o.id === "org_fictional_unrelated_foreign")).toBe(false);
    expect(snap.agreements[0]).toMatchObject({
      currency: "USD",
      rows: [],
      currentValue: { amount: "123456", currency: "USD" },
      thresholdValueCad: 0,
    });
    expect(auditCitations(snap)).toEqual([]);
  });
  it("routes non-TBS evidence to owner review and refuses uncited value claims", () => {
    const { corpus, agreement } = foreignFixture();
    agreement.verification = "proposed";
    expect(evaluateTiers(inputs(corpus)).find((r) => r.id === agreement.id)).toMatchObject({
      tier: 3,
      status: "judgement",
      route: "agreement not from the federal datasets (owner record)",
    });
    agreement.verification = "verified";
    agreement.valueStatements[0]!.evidence = [];
    expect(
      compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" }).failures,
    ).toContainEqual(expect.objectContaining({ gate: "citation-coverage" }));
  });
});
