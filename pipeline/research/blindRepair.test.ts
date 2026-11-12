import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ResearcherPackage } from "./blind";
import { looksStripped, repairStripped, vocabularyOf } from "./blindRepair";

const schema = z.toJSONSchema(ResearcherPackage, { unrepresentable: "any" });
const vocab = vocabularyOf(schema);

describe("repairStripped", () => {
  it("restores schema keys and enum values that lost their underscores", () => {
    const stripped = {
      packageversion: "candef-blind-v2",
      researcher: { id: "R-x", modelortool: "Perplexity", startedat: "t" },
      company: { cardid: "B10", nameasgiven: "GHGSat" },
      findings: [{ findingid: "F001", fieldid: "A01", status: "notresearched", confidence: "low" }],
    };
    expect(looksStripped(stripped)).toBe(true);
    const r = repairStripped(stripped, vocab);
    const v = r.value as typeof stripped & Record<string, unknown>;
    expect(v).toHaveProperty("package_version", "candef-blind-v2");
    expect(v.researcher).toHaveProperty("model_or_tool", "Perplexity");
    expect(v.company).toHaveProperty("card_id", "B10");
    expect(v.findings[0]).toMatchObject({
      finding_id: "F001",
      field_id: "A01",
      status: "not_researched",
    });
    expect(r.ambiguous).toEqual([]);
  });

  it("leaves a package that is already intact unchanged", () => {
    const intact = {
      package_version: "candef-blind-v2",
      company: { card_id: "B03" },
      findings: [{ finding_id: "F1", status: "not_found", claim: "a_b_c url_with_underscores" }],
    };
    expect(looksStripped(intact)).toBe(false);
    const r = repairStripped(intact, vocab);
    expect(r.value).toEqual(intact);
    expect(r.notes).toEqual([]);
  });

  it("never rewrites free text, URLs or values outside enum fields", () => {
    const stripped = {
      packageversion: "v2",
      findings: [
        {
          findingid: "F1",
          status: "found",
          claim: "notresearched",
          sources: [{ url: "https://x.example/a_b", locator: "referencenumber=C-1" }],
        },
      ],
    };
    const r = repairStripped(stripped, vocab).value as { findings: Record<string, unknown>[] };
    expect(r.findings[0]!.claim).toBe("notresearched");
    expect(JSON.stringify(r.findings[0]!.sources)).toContain("https://x.example/a_b");
    expect(JSON.stringify(r.findings[0]!.sources)).toContain("referencenumber=C-1");
  });
});
