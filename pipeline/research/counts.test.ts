import { describe, expect, it } from "vitest";
import { generateDemoCorpus } from "../demo/generate";
import { proposedRecordCount } from "./counts";

describe("proposed record count", () => {
  it("counts acquisitions with facts, rounds and agreements", () => {
    const c = generateDemoCorpus({ companies: 5 });
    for (const r of [...c.assertions, ...c.rounds, ...c.agreements, ...c.acquisitions])
      r.verification = "verified";
    expect(proposedRecordCount(c)).toBe(0);
    expect(c.acquisitions.length).toBeGreaterThan(0);
    c.acquisitions[0]!.verification = "proposed";
    c.assertions[0]!.verification = "proposed";
    expect(proposedRecordCount(c)).toBe(2);
  });
});
