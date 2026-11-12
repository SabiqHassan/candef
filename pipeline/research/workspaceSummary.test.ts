import { describe, expect, it } from "vitest";
import { corpus, fact, grantAgreement, grantRow, round } from "./tiers/fixture.test-helpers";
import { summaryOf } from "./workspaceSummary";

const c = corpus();
const name = (id: string) => c.organizations.find((o) => o.id === id)?.name ?? id;
const sentence = (kind: string, id: string, corp = c) => summaryOf({ id, kind }, corp, name);

describe("workspace 'You are verifying' sentences", () => {
  it("states each fact type in plain words", () => {
    const facts = [
      fact("a1", "legal_name", "Fictional Alpha Inc.", "src_fict_reg"),
      fact("a2", "registry_id", { system: "cra-bn", value: "123456789" }, "src_fict_reg"),
      fact("a3", "hq_location", { city: "Ottawa", province: "ON", country: "CA" }, "src_fict_reg"),
      fact("a4", "founded_year", 2015, "src_fict_reg"),
      fact(
        "a5",
        "operations_location",
        { city: null, province: null, country: "CA", postalCode: "K1A" },
        "src_fict_reg",
      ),
      fact("a6", "legal_name", "Old Alpha Ltd.", "src_fict_reg", { validTo: "2017-08-24" }),
    ];
    const corp = { ...c, assertions: facts };
    expect(sentence("assertion", "a1", corp)).toBe(
      "Check that Fictional Alpha's legal name is “Fictional Alpha Inc.”.",
    );
    expect(sentence("assertion", "a2", corp)).toMatch(
      /123456789 is Fictional Alpha's CRA business number/,
    );
    expect(sentence("assertion", "a3", corp)).toBe(
      "Check that Fictional Alpha's headquarters is in Ottawa, ON, CA.",
    );
    expect(sentence("assertion", "a4", corp)).toBe(
      "Check that Fictional Alpha was founded in 2015.",
    );
    expect(sentence("assertion", "a5", corp)).toMatch(/postal area K1A/);
    expect(sentence("assertion", "a6", corp)).toMatch(
      /formerly named .*Old Alpha Ltd.*until 2017-08-24/,
    );
  });

  it("states a round and an agreement with their key numbers", () => {
    const r = round("fin_fict_a", "src_fict_pr");
    const g = grantAgreement(grantRow());
    const corp = { ...c, rounds: [r], agreements: [g] };
    expect(sentence("round", "fin_fict_a", corp)).toMatch(/^Check Fictional Alpha's .* round \(/);
    expect(sentence("agreement", g.id, corp)).toMatch(
      /^Check that Fictional Department gave Fictional Alpha CAD /,
    );
  });

  it("never prints the word undefined", () => {
    const odd = fact("a9", "description", { weird: true }, "src_fict_reg");
    const out = sentence("assertion", "a9", { ...c, assertions: [odd] }) ?? "";
    expect(out).not.toMatch(/undefined/);
  });

  it("returns null for a record that is not in the corpus", () => {
    expect(sentence("assertion", "missing")).toBeNull();
  });
});
