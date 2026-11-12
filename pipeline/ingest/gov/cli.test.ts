import { execFile } from "node:child_process";
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Agreement } from "../../../src/domain/schema/corpus";
import { assertOutputPath, runCli } from "./cli";

const fixtureDir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const directories: string[] = [];
async function scratch() {
  const path = await mkdtemp(join(fixtureDir, ".tmp-"));
  directories.push(path);
  return path;
}
const args = (out: string) => [
  "--out",
  out,
  "--index",
  join(fixtureDir, "entities.json"),
  "--bodies",
  join(fixtureDir, "bodies.json"),
  "--contracts",
  join(fixtureDir, "contracts.csv"),
  "--contracts-source",
  "src_fictional_contracts",
  "--grants",
  join(fixtureDir, "grants.csv"),
  "--grants-source",
  "src_fictional_grants",
  "--date",
  "2026-10-13",
];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("government import CLI", () => {
  it("checks unknown vendors in the second pass and gates propagated rows", async () => {
    const root = await scratch();
    const csv = join(root, "fictional-collision.csv");
    const header =
      "reference_number,vendor_name,vendor_postal_code,procurement_id,owner_org,contract_value,instrument_type,reporting_period\n";
    const rows = [
      "fictional-unknown,Fictional Unrelated Inc.,Z9Z,fictional-p,fictional-testing,900,C,2025-2026-Q1\n",
      "fictional-seed,Fictional Alpha Bio Inc.,Z1Z,fictional-p,fictional-testing,100,C,2025-2026-Q1\n",
      "fictional-followup,Fictional Alpha Bio Inc.,,fictional-p,fictional-testing,120,A,2025-2026-Q2\n",
    ];
    const base = [
      "--index",
      join(fixtureDir, "entities.json"),
      "--bodies",
      join(fixtureDir, "bodies.json"),
      "--contracts",
      csv,
      "--contracts-source",
      "src_fictional",
      "--date",
      "2026-10-14",
    ];
    await writeFile(csv, header + rows.join(""));
    const report = await runCli([...base, "--out", join(root, "one")]);
    expect(report.countsByStatus).toMatchObject({ confirmed: 0, ambiguous: 2, no_match: 1 });
    expect(report.proposedAgreements).toBe(0);
    await writeFile(csv, header + rows.slice(1).join(""));
    const linked = await runCli([...base, "--out", join(root, "two")]);
    expect(linked.countsByMethod.agreement_anchor).toBe(1);
    expect(linked.proposedAgreements).toBe(1);
    await expect(
      runCli([...base, "--out", join(root, "three"), "--max-per-org", "1"]),
    ).rejects.toThrow(/Magnitude/);
  });
  it("emits identical files under source-row permutation including more than 200 candidates", async () => {
    const root = await scratch();
    const csv = join(root, "fictional.csv");
    const header =
      "reference_number,vendor_name,vendor_postal_code,procurement_id,owner_org,contract_value,instrument_type,reporting_period\n";
    const rows = Array.from(
      { length: 205 },
      (_, i) => `fictional-${i},Fictional Alpha Bio Inc.,,,fictional-testing,-1,C,2025-2026-Q1\n`,
    );
    const base = [
      "--index",
      join(fixtureDir, "entities.json"),
      "--bodies",
      join(fixtureDir, "bodies.json"),
      "--contracts",
      csv,
      "--contracts-source",
      "src_fictional",
      "--date",
      "2026-10-14",
      "--max-per-org",
      "205",
    ];
    await writeFile(csv, header + rows.join(""));
    await runCli([...base, "--out", join(root, "one")]);
    await writeFile(csv, header + rows.reverse().join(""));
    await runCli([...base, "--out", join(root, "two")]);
    for (const file of [
      "proposed-agreements.json",
      "all-agreements.json",
      "linkage.json",
      "match-report.json",
      "match-report.md",
    ])
      expect(await readFile(join(root, "one", file), "utf8"), file).toBe(
        await readFile(join(root, "two", file), "utf8"),
      );
  });
  it("writes schema-valid proposals and human/machine reports to an ignored folder", async () => {
    const out = await scratch();
    const report = await runCli(args(out));
    expect(report.rowsRead).toBe(7);
    expect(report.countsByStatus).toMatchObject({ confirmed: 7 });
    expect(report.countsByMethod).toMatchObject({ "name+postal": 3, "name+bn": 4 });
    expect(report.confirmedRowsPerOrg).toEqual({ org_fictional_alpha: 7 });
    const proposals: unknown[] = JSON.parse(
      await readFile(join(out, "proposed-agreements.json"), "utf8"),
    );
    expect(proposals).toHaveLength(2);
    for (const proposal of proposals)
      expect(Agreement.parse(proposal).verification).toBe("proposed");
    expect(JSON.parse(await readFile(join(out, "match-report.json"), "utf8"))).toEqual(report);
    expect(await readFile(join(out, "match-report.md"), "utf8")).toContain("Rows read: 7");
    expect(await readFile(join(out, ".gitignore"), "utf8")).toContain("*");
  });
  it("reports unmapped departments, skipped transfers, currency, consortiums and ambiguities", async () => {
    const out = await scratch();
    const contracts = join(out, "fictional-contracts.csv");
    const grants = join(out, "fictional-grants.csv");
    await writeFile(
      contracts,
      "reference_number,vendor_name,vendor_postal_code,buyer_name,contract_value,instrument_type,reporting_period\nfictional-1,Fictional Alpha Bio Inc.,,Fictional Department of Testing,1.23,A,2025-2026-Q1\nfictional-2,Fictional Alpha in joint venture with Fictional Beta Inc.,Z1Z,Fictional Department of Testing,2.34,C,2025-2026-Q1\nfictional-3,Fictional Alpha Bio Inc.,Z1Z,Fictional Department of Testing,-3.45,C,2025-2026-Q1\n",
    );
    await writeFile(
      grants,
      "ref_number,amendment_number,recipient_legal_name,agreement_value,agreement_type,foreign_currency_type,foreign_currency_value\nfictional-g,0,Fictional Unknown Inc.,4.56,O,USD,5.67\n",
    );
    const bodies = join(out, "bodies.json");
    await writeFile(bodies, "{}");
    const report = await runCli([
      "--out",
      join(out, "output"),
      "--index",
      join(fixtureDir, "entities.json"),
      "--bodies",
      bodies,
      "--contracts",
      contracts,
      "--contracts-source",
      "src_fictional_contracts",
      "--grants",
      grants,
      "--grants-source",
      "src_fictional_grants",
    ]);
    expect(report.countsByStatus).toEqual({
      confirmed: 1,
      ambiguous: 1,
      no_match: 1,
      consortium: 1,
    });
    expect(report.ambiguousRows[0]).toMatchObject({
      name: "Fictional Alpha Bio Inc.",
      reason: "name_only",
      candidateOrgIds: ["org_fictional_alpha"],
    });
    expect(report.consortiumRows).toHaveLength(1);
    expect(report.unmappedDepartments["Fictional Department of Testing"]).toBe(1);
    expect(report.skippedOtherGrants).toBe(1);
    expect(report.foreignCurrencyRows).toHaveLength(1);
    expect(report.warnings).toHaveLength(2);
  });
  it("never matches or names an individual recipient (recipient_type P, D-17)", async () => {
    const out = await scratch();
    const grants = join(out, "fictional-grants.csv");
    // Operating name, BN and postal code all match an indexed company; the recipient is a person.
    await writeFile(
      grants,
      "ref_number,amendment_number,recipient_type,recipient_business_number,recipient_legal_name,recipient_operating_name,recipient_postal_code,agreement_value,agreement_type,owner_org\n" +
        'fictional-p,0,P,123456789,"Personne, Fictive",Fictional Alpha Bio Inc.,Z1Z 9Z9,4500.00,G,fictional-testing\n',
    );
    const output = join(out, "output");
    const report = await runCli([
      "--out",
      output,
      "--index",
      join(fixtureDir, "entities.json"),
      "--bodies",
      join(fixtureDir, "bodies.json"),
      "--grants",
      grants,
      "--grants-source",
      "src_fictional_grants",
    ]);
    expect(report).toMatchObject({
      rowsRead: 1,
      skippedIndividualGrants: 1,
      proposedAgreements: 0,
    });
    expect(report.countsByStatus).toEqual({
      confirmed: 0,
      ambiguous: 0,
      no_match: 0,
      consortium: 0,
    });
    for (const file of ["proposed-agreements.json", "match-report.json", "match-report.md"])
      expect(await readFile(join(output, file), "utf8")).not.toContain("Personne");
  });
  it("limits ambiguity details to 200 while counting all rows and gate candidates", async () => {
    const out = await scratch();
    const csv = join(out, "fictional-ambiguous.csv");
    await writeFile(
      csv,
      "reference_number,vendor_name,contract_value,instrument_type,reporting_period\n" +
        Array.from(
          { length: 205 },
          (_, i) => `fictional-${i},Fictional Alpha Bio Inc.,1.23,C,2025-2026-Q1\n`,
        ).join(""),
    );
    const report = await runCli([
      "--out",
      join(out, "output"),
      "--index",
      join(fixtureDir, "entities.json"),
      "--bodies",
      join(fixtureDir, "bodies.json"),
      "--contracts",
      csv,
      "--contracts-source",
      "src_fictional",
      "--max-per-org",
      "205",
    ]);
    expect(report.ambiguousRows).toHaveLength(200);
    expect(report.countsByStatus.ambiguous).toBe(205);
  });
  it("refuses research paths before writing and validates header-only inputs", async () => {
    await expect(assertOutputPath("research/proposals")).rejects.toThrow(/research/);
    await expect(assertOutputPath("ReSeArCh/proposals")).rejects.toThrow(/research/);
    const out = await scratch();
    const csv = join(out, "fictional-bad.csv");
    await writeFile(csv, "vendor_name\n");
    await expect(
      runCli([
        "--out",
        join(out, "output"),
        "--index",
        join(fixtureDir, "entities.json"),
        "--bodies",
        join(fixtureDir, "bodies.json"),
        "--contracts",
        csv,
        "--contracts-source",
        "src_fictional",
      ]),
    ).rejects.toThrow(/missing required columns/);
  });
  it("rejects incomplete source pairs, invalid dates and invalid magnitude limits", async () => {
    const out = await scratch();
    await expect(
      runCli(
        args(out).filter(
          (value) => value !== "--contracts-source" && value !== "src_fictional_contracts",
        ),
      ),
    ).rejects.toThrow(/contracts-source/);
    await expect(runCli([...args(out), "--max-per-org", "-1"])).rejects.toThrow();
    await expect(
      runCli(args(out).map((v) => (v === "2026-10-13" ? "2025-02-30" : v))),
    ).rejects.toThrow(/date/);
  });
  it("returns nonzero on a magnitude failure, without creating proposals", async () => {
    const out = await scratch();
    const exec = promisify(execFile);
    await expect(
      exec(process.execPath, [
        "--import",
        "tsx",
        fileURLToPath(new URL("./cli.ts", import.meta.url)),
        ...args(join(out, "output")),
        "--max-per-org",
        "1",
      ]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Magnitude gate failed") });
    await expect(readFile(join(out, "output", "proposed-agreements.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("refuses output aliases that resolve through a junction into research", async () => {
    const out = await scratch();
    const research = join(out, "research");
    await mkdir(research);
    await symlink(research, join(out, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(assertOutputPath(join(out, "alias", "proposals"))).rejects.toThrow(/research/);
  });
  it("does not overwrite a linked research file through an existing output child", async () => {
    const out = await scratch();
    const research = join(out, "research");
    await mkdir(research);
    const target = join(research, "fictional-target.json");
    await writeFile(target, "Fictional sentinel: must remain unchanged");
    await link(target, join(out, "proposed-agreements.json"));
    await runCli(args(out));
    expect(await readFile(target, "utf8")).toBe("Fictional sentinel: must remain unchanged");
    expect(JSON.parse(await readFile(join(out, "proposed-agreements.json"), "utf8"))).toHaveLength(
      2,
    );
  });
  it("rejects an existing output child that is a symbolic link", async () => {
    const out = await scratch();
    const directory = join(out, "fictional-target");
    await mkdir(directory);
    const target = join(directory, "fictional-sentinel.json");
    await writeFile(target, "Fictional sentinel: must remain unchanged");
    await symlink(
      process.platform === "win32" ? directory : target,
      join(out, "match-report.json"),
      process.platform === "win32" ? "junction" : "file",
    );
    await expect(runCli(args(out))).rejects.toThrow(/linked output/);
    expect(await readFile(target, "utf8")).toBe("Fictional sentinel: must remain unchanged");
    await expect(readFile(join(out, "proposed-agreements.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
