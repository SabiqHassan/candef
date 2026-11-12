/**
 * The full government-import loop on synthetic data: research/ → index → importer (Codex's fixture
 * CSVs) → accept → research/ still valid, agreements proposed, nothing published.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../compile/compile";
import { runCli } from "../ingest/gov/cli";
import { acceptGovProposals, buildGovIndex } from "./govImport";
import { loadResearchCorpus } from "./load";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
};
const FIX = "pipeline/ingest/gov/__fixtures__";
const source = (id: string) => `kind: gov_dataset
tier: T1
publisher: Fictional Treasury
title: Fictional ${id}
url: https://example.org/${id}
publishedOn: null
retrievedAt: "2026-10-13T00:00:00Z"
originGroup: og:${id}
textSha256: null
`;

function research(): string {
  const r = temp("candef-gov-");
  mkdirSync(join(r, "orgs"));
  mkdirSync(join(r, "sources"));
  writeFileSync(join(r, "sources", "src_fictional_contracts.yaml"), source("contracts"));
  writeFileSync(join(r, "sources", "src_fictional_grants.yaml"), source("grants"));
  writeFileSync(
    join(r, "orgs", "alpha.yaml"),
    [
      "org: { id: org_alpha, kind: company, slug: alpha, name: Fictional Alpha Bio }",
      'defaults: { createdBy: "agent:test" }',
      "facts:",
      '  - { predicate: legal_name, value: Fictional Alpha Bio Inc., src: ["src_fictional_grants#recipient_legal_name"] }',
      '  - { predicate: registry_id, value: { system: cra-bn, value: "123456789" }, src: ["src_fictional_grants#recipient_business_number"] }',
      '  - { predicate: hq_location, value: { city: null, region: null, province: ON, country: CA, postalCode: "Z1Z 9Z9" }, src: ["src_fictional_contracts#vendor_postal_code"] }',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(r, "orgs", "testing.yaml"),
    [
      "org: { id: org_testing, kind: government_body, slug: testing, name: Fictional Department of Testing }",
      'defaults: { createdBy: "agent:test" }',
      "facts:",
      '  - { predicate: registry_id, value: { system: tbs-owner-org, value: fictional-testing }, src: ["src_fictional_contracts#owner_org"] }',
      "",
    ].join("\n"),
  );
  return r;
}

const proposal = (id: string, verification = "proposed") => ({
  id,
  family: "grant_contribution",
  type: "grant",
  title: "Fictional",
  programId: null,
  groupId: null,
  externalIds: [],
  parties: [
    {
      orgId: "org_testing",
      role: "funder",
      evidenceStrength: "party_of_record",
      reportedName: "x",
    },
    {
      orgId: "org_alpha",
      role: "recipient",
      evidenceStrength: "party_of_record",
      reportedName: "x",
    },
  ],
  currency: "CAD",
  disclosureRows: [],
  valueStatements: [],
  allocations: [],
  repayability: "unknown",
  announcedOn: null,
  startOn: null,
  statusAsOf: { state: "unknown", asOf: "2026-10-13" },
  epistemic: "sourced_fact",
  verification,
  evidence: [{ sourceId: "src_fictional_grants", locator: "ref_number=1" }],
  review: null,
  createdBy: "pipeline:tbs-import",
});

describe("government import loop", () => {
  it("builds the importer index from research/ facts", () => {
    const { entities, bodies } = buildGovIndex(loadResearchCorpus(research()).corpus!);
    expect(entities).toEqual([
      {
        orgId: "org_alpha",
        names: ["Fictional Alpha Bio", "Fictional Alpha Bio Inc."],
        businessNumbers: ["123456789"],
        postalFsas: ["Z1Z"],
      },
    ]);
    expect(bodies["fictional-testing"]).toBe("org_testing");
    expect(bodies["Fictional Department of Testing"]).toBe("org_testing");
  });

  it("imports, accepts the selected proposals as proposed, and publishes nothing", async () => {
    const root = research();
    const { entities, bodies } = buildGovIndex(loadResearchCorpus(root).corpus!);
    const work = temp("candef-gov-out-");
    writeFileSync(join(work, "entities.json"), JSON.stringify(entities));
    writeFileSync(join(work, "bodies.json"), JSON.stringify(bodies));
    const out = join(work, "out");
    await runCli([
      "--out",
      out,
      "--index",
      join(work, "entities.json"),
      "--bodies",
      join(work, "bodies.json"),
      "--contracts",
      `${FIX}/contracts.csv`,
      "--contracts-source",
      "src_fictional_contracts",
      "--grants",
      `${FIX}/grants.csv`,
      "--grants-source",
      "src_fictional_grants",
      "--date",
      "2026-10-13",
    ]);
    const file = join(out, "proposed-agreements.json");
    const proposals = JSON.parse(readFileSync(file, "utf8")) as { id: string }[];
    expect(proposals).toHaveLength(2);

    acceptGovProposals(
      root,
      file,
      proposals.map((p) => p.id),
    );
    const corpus = loadResearchCorpus(root).corpus!;
    expect(corpus.agreements.map((g) => g.verification)).toEqual(["proposed", "proposed"]);
    const result = compile(corpus, { today: "2026-10-13" });
    expect(result.ok).toBe(true);
    expect(result.snapshot!.agreements).toEqual([]);
    expect(result.quality.filter((q) => q.check === "row-arithmetic")).toEqual([]);
    expect(() => acceptGovProposals(root, file, [proposals[0]!.id])).toThrow(/already in research/);
  });

  it("refuses unregistered sources and anything that is not a plain proposal", () => {
    const root = research();
    const work = temp("candef-gov-out-");
    writeFileSync(
      join(work, "p.json"),
      JSON.stringify([proposal("agr_x"), proposal("agr_y", "verified")]),
    );
    expect(() => acceptGovProposals(root, join(work, "p.json"), ["agr_y"])).toThrow(
      /not a plain proposal/,
    );
    rmSync(join(root, "sources", "src_fictional_grants.yaml"));
    expect(() => acceptGovProposals(root, join(work, "p.json"), ["agr_x"])).toThrow(
      /unregistered source/,
    );
  });
});
