import { describe, expect, it } from "vitest";
import { rowLocator } from "../../ingest/gov/locators";
import { batchHash, evaluateTiers, type TierRecord } from "./rules";
import {
  consistent,
  corpus,
  DATASET,
  fact,
  grantAgreement,
  grantRow,
  inputs,
  ORG,
  round,
  source,
} from "./fixture.test-helpers";

const REG_PAGE =
  "<p>Corporate name: Fictional Alpha Inc. Corporation number: 1234567-8. Incorporated 2019-03-04. Ottawa, ON K1A 0B1</p>";
const PR_PAGE =
  "<p>OTTAWA, May 2, 2024 - Fictional Alpha raised US$12 million in a Series A led by Fictional Ventures.</p>";
const rule = (r: TierRecord, id: string) => r.rules.find((x) => x.rule === id);
const byId = (rs: TierRecord[], id: string) => rs.find((r) => r.id === id)!;

describe("tier 2: sourced facts", () => {
  const base = () =>
    corpus({
      assertions: [
        fact("asr_name", "legal_name", "Fictional Alpha Inc.", "src_fict_reg"),
        fact(
          "asr_corp",
          "registry_id",
          { system: "corporations-canada", value: "1234567-8" },
          "src_fict_reg",
        ),
        fact("asr_year", "founded_year", 2019, "src_fict_reg"),
      ],
    });
  const corroborated = () =>
    new Map([
      ["asr_name", [consistent("C1:A01:asr_name")]],
      ["asr_corp", [consistent("C1:A04:asr_corp")]],
      ["asr_year", [consistent("C1:A08:asr_year")]],
    ]);

  it("passes when the value is in the saved copy and an independent finding agrees", () => {
    const rs = evaluateTiers(
      inputs(base(), { pages: { src_fict_reg: REG_PAGE }, corroboration: corroborated() }),
    );
    for (const id of ["asr_name", "asr_corp", "asr_year"]) {
      const r = byId(rs, id);
      expect(r.tier, id).toBe(2);
      expect(r.status, `${id}: ${JSON.stringify(r.rules)}`).toBe("pass");
      expect(r.values.every((v) => v.found && v.offset !== null)).toBe(true);
      expect(r.sources[0]).toMatchObject({
        sourceId: "src_fict_reg",
        captureId: "cap_src_fict_reg",
        rawSha256: "a".repeat(64),
      });
    }
  });

  it("checks a stated total stored as { money: { amount, currency, asStated } }", () => {
    const money = (asStated: string) => ({
      money: { amount: "40000000", currency: "USD", disclosure: "disclosed", asStated },
    });
    const run = (page: string) =>
      byId(
        evaluateTiers(
          inputs(
            corpus({
              assertions: [
                fact("asr_total", "total_raised_as_stated", money("US$40 million"), "src_fict_reg"),
              ],
            }),
            {
              pages: { src_fict_reg: page },
              corroboration: new Map([["asr_total", [consistent("C1:C04:asr_total")]]]),
            },
          ),
        ),
        "asr_total",
      );
    const ok = run("<p>The company has raised US$40 million to date.</p>");
    expect(rule(ok, "T2-c")!.result).toBe("pass");
    expect(ok.values[0]!.kind).toBe("money");
    // The amount must really be in the copy.
    expect(rule(run("<p>The company has raised US$25 million.</p>"), "T2-c")!.result).toBe("fail");
  });

  it("T2-c fails when the value is not in the capture, even if the source is right", () => {
    const page = REG_PAGE.replace("1234567-8", "7654321-0");
    const r = byId(
      evaluateTiers(
        inputs(base(), { pages: { src_fict_reg: page }, corroboration: corroborated() }),
      ),
      "asr_corp",
    );
    expect(r.status).toBe("exception");
    expect(rule(r, "T2-c")!.result).toBe("fail");
  });

  it("T2-b fails without capture permission or without a capture ID on the evidence", () => {
    const c = base();
    c.sources[0] = source("src_fict_reg", {
      permissions: { ...c.sources[0]!.permissions!, capture: "unknown" },
    });
    let r = byId(
      evaluateTiers(
        inputs(c, { pages: { src_fict_reg: REG_PAGE }, corroboration: corroborated() }),
      ),
      "asr_name",
    );
    expect(rule(r, "T2-b")!.result).toBe("fail");
    const d = base();
    d.assertions[0]!.evidence[0]!.captureId = null;
    r = byId(
      evaluateTiers(
        inputs(d, { pages: { src_fict_reg: REG_PAGE }, corroboration: corroborated() }),
      ),
      "asr_name",
    );
    expect(rule(r, "T2-b")!.result).toBe("fail");
    expect(rule(r, "T2-c")!.result).toBe("fail");
  });

  it("T2-e fails without corroboration; T2-f fails on an inconsistent or stale claim", () => {
    let r = byId(evaluateTiers(inputs(base(), { pages: { src_fict_reg: REG_PAGE } })), "asr_name");
    expect(rule(r, "T2-e")!.result).toBe("fail");
    const bad = corroborated();
    bad.set("asr_name", [{ ...consistent("C1:A01:asr_name"), signal: "inconsistent" }]);
    r = byId(
      evaluateTiers(inputs(base(), { pages: { src_fict_reg: REG_PAGE }, corroboration: bad })),
      "asr_name",
    );
    expect(rule(r, "T2-f")!.result).toBe("fail");
    bad.set("asr_name", [{ ...consistent("C1:A01:asr_name"), stale: true }]);
    r = byId(
      evaluateTiers(inputs(base(), { pages: { src_fict_reg: REG_PAGE }, corroboration: bad })),
      "asr_name",
    );
    expect(rule(r, "T2-e")!.reason).toMatch(/changed since the worksheet/);
  });

  it("a same-origin copy still needs the value in the saved copy (corroboration alone is not enough)", () => {
    const r = byId(
      evaluateTiers(inputs(base(), { pages: {}, corroboration: corroborated() })),
      "asr_name",
    );
    expect(rule(r, "T2-e")!.result).toBe("pass");
    expect(rule(r, "T2-c")!.result).toBe("fail");
    expect(r.status).toBe("exception");
  });

  it("routes a T3 source, anchors, assessments, structure and analyst interpretation to tier 3", () => {
    const c = base();
    c.sources.push(source("src_fict_news", { kind: "news", tier: "T3" }));
    c.assertions.push(
      fact("asr_news", "founded_year", 2018, "src_fict_news"),
      fact("asr_bn", "registry_id", { system: "cra-bn", value: "123456789" }, "src_fict_reg"),
      fact(
        "asr_ops",
        "operations_location",
        { city: "Ottawa", province: "ON", country: "CA", postalCode: "K1A" },
        "src_fict_reg",
      ),
      fact("asr_elig", "eligibility", { decision: "included", rationale: "x" }, "src_fict_reg"),
      fact("asr_parent", "subsidiary_of", { orgId: "org_x" }, "src_fict_reg"),
      fact("asr_desc", "description", "Fictional robots", "src_fict_pr", {
        epistemic: "analyst_interpretation",
      }),
    );
    const rs = evaluateTiers(inputs(c, { pages: { src_fict_reg: REG_PAGE } }));
    for (const id of ["asr_news", "asr_bn", "asr_ops", "asr_elig", "asr_parent", "asr_desc"])
      expect(byId(rs, id), id).toMatchObject({ tier: 3, status: "judgement" });
    expect(byId(rs, "asr_bn").route).toMatch(/identity anchor/);
    expect(byId(rs, "asr_news").route).toMatch(/T3\/T4/);
  });

  it("T2-f fails when another CANDEF record disagrees (a dispute)", () => {
    const c = base();
    c.assertions.push(fact("asr_year2", "founded_year", 2018, "src_fict_reg"));
    const r = byId(
      evaluateTiers(
        inputs(c, { pages: { src_fict_reg: REG_PAGE }, corroboration: corroborated() }),
      ),
      "asr_year",
    );
    expect(rule(r, "T2-f")!.result).toBe("fail");
  });
});

describe("tier 2: financing rounds", () => {
  const c = () => corpus({ rounds: [round("fin_fict_a", "src_fict_pr")] });
  const corr = () => new Map([["fin_fict_a", [consistent("C1:C02:d1"), consistent("C1:C03:p0")]]]);
  it("needs the date, amount with currency, label and every participant in the capture", () => {
    let r = byId(
      evaluateTiers(inputs(c(), { pages: { src_fict_pr: PR_PAGE }, corroboration: corr() })),
      "fin_fict_a",
    );
    expect(r.status, JSON.stringify(r.rules)).toBe("pass");
    expect(r.values.map((v) => v.part)).toEqual([
      "label",
      "fin_fict_a_d1 date",
      "fin_fict_a_d1 amount",
      "participant 0 (lead)",
    ]);
    r = byId(
      evaluateTiers(
        inputs(c(), {
          pages: { src_fict_pr: PR_PAGE.replace("US$12", "CA$12") },
          corroboration: corr(),
        }),
      ),
      "fin_fict_a",
    );
    expect(rule(r, "T2-c")!.reason).toMatch(/amount/);
  });
  it("fails T2-e when a participant claim found no independent candidate", () => {
    const m = corr();
    m.set("fin_fict_a", [
      consistent("C1:C02:d1"),
      { ...consistent("C1:C03:p0"), signal: "no_candidate" },
    ]);
    const r = byId(
      evaluateTiers(inputs(c(), { pages: { src_fict_pr: PR_PAGE }, corroboration: m })),
      "fin_fict_a",
    );
    expect(rule(r, "T2-e")!.result).toBe("fail");
  });
});

describe("tier 1: government agreements", () => {
  const withAnchor = (verification: "proposed" | "verified") =>
    fact("asr_bn", "registry_id", { system: "cra-bn", value: "123456789" }, "src_fict_reg", {
      verification,
    });
  it("is conditional on a proposed BN anchor, and passes once the anchor is approved", () => {
    const row = grantRow();
    const g = grantAgreement(row);
    let r = byId(
      evaluateTiers(
        inputs(corpus({ agreements: [g], assertions: [withAnchor("proposed")] }), { rows: [row] }),
      ),
      g.id,
    );
    expect(r.tier).toBe(1);
    expect(r.status, JSON.stringify(r.rules)).toBe("conditional");
    expect(r.dependsOn).toEqual(["asr_bn"]);
    r = byId(
      evaluateTiers(
        inputs(corpus({ agreements: [g], assertions: [withAnchor("verified")] }), { rows: [row] }),
      ),
      g.id,
    );
    expect(r.status, JSON.stringify(r.rules)).toBe("pass");
  });
  it("fails T1-b on a name-only row and on a conflicting BN", () => {
    const row = grantRow({ recipient_business_number: "", recipient_postal_code: "M5V 1A1" });
    const g = grantAgreement(row);
    let r = byId(
      evaluateTiers(
        inputs(corpus({ agreements: [g], assertions: [withAnchor("verified")] }), { rows: [row] }),
      ),
      g.id,
    );
    expect(rule(r, "T1-b")!.reason).toMatch(/name only/);
    const other = grantRow({ recipient_business_number: "987654321RC0001" });
    const h = grantAgreement(other);
    r = byId(
      evaluateTiers(
        inputs(corpus({ agreements: [h], assertions: [withAnchor("verified")] }), {
          rows: [other],
        }),
      ),
      h.id,
    );
    expect(rule(r, "T1-b")!.reason).toMatch(/differs/);
  });
  it("accepts name plus an approved postal-area anchor", () => {
    const row = grantRow({ recipient_business_number: "" });
    const g = grantAgreement(row);
    const ops = fact(
      "asr_ops",
      "operations_location",
      { city: "Ottawa", province: "ON", country: "CA", postalCode: "K1A 0B1" },
      "src_fict_reg",
      {
        verification: "verified",
      },
    );
    const name = fact("asr_name", "legal_name", "Fictional Alpha Inc.", "src_fict_reg");
    const r = byId(
      evaluateTiers(inputs(corpus({ agreements: [g], assertions: [ops, name] }), { rows: [row] })),
      g.id,
    );
    expect(rule(r, "T1-b")!.result).toBe("pass");
  });
  it("does not fall back to name and postal area when the BN field holds an invalid number", () => {
    // Real case: a 10-digit BN field on a row whose name and postal area match the company.
    const row = grantRow({ recipient_business_number: "1163747141" });
    const g = grantAgreement(row);
    const ops = fact(
      "asr_ops",
      "operations_location",
      { city: "Ottawa", province: "ON", country: "CA", postalCode: "K1A 0B1" },
      "src_fict_reg",
      { verification: "verified" },
    );
    const name = fact("asr_name", "legal_name", "Fictional Alpha Inc.", "src_fict_reg");
    const r = byId(
      evaluateTiers(
        inputs(corpus({ agreements: [g], assertions: [ops, name, withAnchor("verified")] }), {
          rows: [row],
        }),
      ),
      g.id,
    );
    expect(rule(r, "T1-b")!.result).toBe("fail");
    expect(rule(r, "T1-b")!.reason).toMatch(/not a valid business number/);
  });
  it("fails T1-a when a recorded value differs from the row, and T1-c on a pending migration", () => {
    const row = grantRow();
    const g = grantAgreement(row);
    g.disclosureRows[0]!.totalValue = "1";
    const plan = {
      version: 1 as const,
      inputHash: "x",
      hash: "y",
      changes: [
        {
          oldIds: [g.id],
          newIds: [g.id],
          action: "update" as const,
          fields: ["evidence"],
          reason: "",
          blocked: false,
          beforeHashes: {},
          afterHashes: {},
        },
      ],
      replacements: [grantAgreement(row)],
      aliases: [],
      reviewedIds: [],
      cases: [],
    };
    const r = byId(
      evaluateTiers(
        inputs(corpus({ agreements: [g], assertions: [withAnchor("verified")] }), {
          rows: [row],
          plan,
        }),
      ),
      g.id,
    );
    expect(rule(r, "T1-a")!.result).toBe("fail");
    expect(rule(r, "T1-c")!.reason).toMatch(/pending migration update/);
    // The migration's replacement content is evaluated too, for the owner's preview.
    expect(r.projected?.status).toBe("pass");
  });
  it("routes candidate and missing components to the owner instead of asking for another apply", () => {
    const row = grantRow();
    const g = grantAgreement(row);
    for (const action of ["candidate", "missing"] as const) {
      const plan = {
        version: 1 as const,
        inputHash: "x",
        hash: "y",
        changes: [
          {
            oldIds: [g.id],
            newIds: [],
            action,
            fields: ["id"],
            reason: "",
            blocked: false,
            beforeHashes: {},
            afterHashes: {},
          },
        ],
        replacements: [],
        aliases: [],
        reviewedIds: [],
        cases: [],
      };
      const r = byId(
        evaluateTiers(
          inputs(corpus({ agreements: [g], assertions: [withAnchor("verified")] }), {
            rows: [row],
            plan,
          }),
        ),
        g.id,
      );
      const t1c = rule(r, "T1-c")!;
      expect(t1c.result).toBe("fail");
      expect(t1c.reason).toMatch(action === "candidate" ? /reconciliation candidate/ : /missing/);
      expect(t1c.reason).not.toMatch(/apply the reviewed migration/);
    }
  });
  it("fails T1-c on a duplicate-number case and T1-d on a wrong party name", () => {
    const row = grantRow();
    const g = grantAgreement(row);
    const twin = grantAgreement(grantRow({ ref_number: "FICT-G2" }), "agr_tbs_g_fict2");
    let r = byId(
      evaluateTiers(
        inputs(corpus({ agreements: [g, twin], assertions: [withAnchor("verified")] }), {
          rows: [row],
        }),
      ),
      g.id,
    );
    expect(rule(r, "T1-c")!.reason).toMatch(/duplicate-number/);
    const named = grantAgreement(row);
    named.parties[1]!.reportedName = "Fictional Alpha Incorporated";
    r = byId(
      evaluateTiers(
        inputs(corpus({ agreements: [named], assertions: [withAnchor("verified")] }), {
          rows: [row],
        }),
      ),
      named.id,
    );
    expect(rule(r, "T1-d")!.result).toBe("fail");
  });
  it("binds evidence to the registered dataset source", () => {
    const row = grantRow();
    const g = grantAgreement(row);
    g.evidence[0]!.sourceId = "src_fict_reg";
    const r = byId(
      evaluateTiers(
        inputs(corpus({ agreements: [g], assertions: [withAnchor("verified")] }), { rows: [row] }),
      ),
      g.id,
    );
    expect(rule(r, "T1-a")!.result).toBe("fail");
    expect(g.evidence[0]!.locator).toBe(rowLocator("grants", row));
    expect(DATASET).toBe("src_fict_grants");
  });
});

describe("batch hash", () => {
  it("changes when any record's status or evidence hash changes", () => {
    const c = corpus({
      assertions: [fact("asr_name", "legal_name", "Fictional Alpha Inc.", "src_fict_reg")],
    });
    const a = evaluateTiers(inputs(c, { pages: { src_fict_reg: REG_PAGE } }));
    const b = evaluateTiers(
      inputs(c, {
        pages: { src_fict_reg: REG_PAGE },
        corroboration: new Map([["asr_name", [consistent("x")]]]),
      }),
    );
    expect(batchHash(a)).not.toBe(batchHash(b));
    expect(batchHash(a)).toBe(
      batchHash(evaluateTiers(inputs(c, { pages: { src_fict_reg: REG_PAGE } }))),
    );
    expect(ORG).toBe("org_fict_alpha");
  });
});
