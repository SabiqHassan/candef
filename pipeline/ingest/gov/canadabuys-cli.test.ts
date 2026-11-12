import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Agreement } from "../../../src/domain/schema/corpus";
import { runCli } from "./cli";

const fixtureDir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const directories: string[] = [];
async function scratch() {
  const path = await mkdtemp(join(fixtureDir, ".tmp-cb-"));
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
  "--canadabuys",
  join(fixtureDir, "canadabuys.csv"),
  "--canadabuys-source",
  "src_fictional_canadabuys",
  "--date",
  "2026-10-13",
];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("CanadaBuys CLI", () => {
  it("reports zero rows for a valid header-only CanadaBuys file", async () => {
    const out = await scratch();
    const csv = join(out, "fictional-empty.csv");
    const fixture = await readFile(join(fixtureDir, "canadabuys.csv"), "utf8");
    await writeFile(csv, fixture.split("\n")[0]! + "\n");
    const report = await runCli(
      args(out).map((arg) => (arg === join(fixtureDir, "canadabuys.csv") ? csv : arg)),
    );
    expect(report.rowsByDataset).toEqual({ contracts: 0, grants: 0, canadabuys: 0 });
    expect(report.canadaBuys).toMatchObject({
      rowsRead: 0,
      skippedCancelledGroups: 0,
      currencyCadPerPspcDocumentation: 0,
    });
    expect(JSON.parse(await readFile(join(out, "proposed-agreements.json"), "utf8"))).toEqual([]);
  });
  it("writes schema-valid proposals and reports without any contact values", async () => {
    const out = await scratch();
    const report = await runCli(args(out));
    expect(report.rowsRead).toBe(8);
    expect(report.rowsByDataset.canadabuys).toBe(8);
    expect(report.countsByStatus).toEqual({
      confirmed: 5,
      ambiguous: 1,
      no_match: 1,
      consortium: 1,
    });
    expect(report.countsByMethod["name+postal"]).toBe(5);
    expect(report.canadaBuys).toMatchObject({
      rowsRead: 8,
      countsByContractStatus: { Active: 6, Expired: 1, Cancelled: 1 },
      skippedCancelledGroups: 1,
      currencyCadPerPspcDocumentation: 4,
      taxes: "included",
      amendmentDeltas: "not_derived",
    });
    expect(report.unmappedDepartments).toEqual({ "Fictional Unmapped Buyer": 1 });
    const outputs = await Promise.all(
      ["proposed-agreements.json", "match-report.json", "match-report.md"].map((file) =>
        readFile(join(out, file), "utf8"),
      ),
    );
    const proposals: unknown[] = JSON.parse(outputs[0]!);
    expect(proposals).toHaveLength(1);
    for (const proposal of proposals) expect(Agreement.parse(proposal).review).toBeNull();
    for (const text of outputs) {
      for (const value of [
        "Fictional Contact Secret",
        "Fictional-private@example.invalid",
        "Fictional-phone-555-0101",
        "Fictional-fax-555-0102",
        "Fictional private address 123",
        "Fictional Ambiguous Contact",
        "Fictional-ambiguous@example.invalid",
        "Fictional-ambiguous-phone",
        "Fictional-ambiguous-fax",
        "Fictional ambiguous address",
      ])
        expect(text).not.toContain(value);
      expect(text).not.toContain("contactInfo");
    }
    expect(JSON.parse(outputs[1]!)).toEqual(report);
    expect(outputs[2]).toContain("currency CAD per PSPC documentation: 4");
    expect(outputs[2]).toContain("Taxes are included");
    expect(outputs[2]).toContain("Amendment deltas are not derived");
    expect(outputs[2]).toContain("2026 restructuring");
  });
  it("combines TBS and CanadaBuys row counts and magnitude gates before writing", async () => {
    const out = await scratch();
    const combined = [
      ...args(join(out, "combined")),
      "--contracts",
      join(fixtureDir, "contracts.csv"),
      "--contracts-source",
      "src_fictional_contracts",
      "--grants",
      join(fixtureDir, "grants.csv"),
      "--grants-source",
      "src_fictional_grants",
    ];
    await expect(runCli([...combined, "--max-per-org", "7"])).rejects.toThrow(
      /Magnitude gate failed/,
    );
    await expect(readFile(join(out, "combined", "proposed-agreements.json"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    const report = await runCli(combined);
    expect(report.rowsRead).toBe(15);
    expect(report.rowsByDataset).toEqual({ contracts: 3, grants: 4, canadabuys: 8 });
    expect(report.proposedAgreements).toBe(3);
    const proposals: unknown[] = JSON.parse(
      await readFile(join(out, "combined", "proposed-agreements.json"), "utf8"),
    );
    for (const proposal of proposals) Agreement.parse(proposal);
  });
  it("rejects incomplete source pairs and header-only or empty invalid inputs", async () => {
    const out = await scratch();
    await expect(
      runCli(
        args(out).filter(
          (arg) => arg !== "--canadabuys-source" && arg !== "src_fictional_canadabuys",
        ),
      ),
    ).rejects.toThrow(/canadabuys-source/);
    for (const input of ["contractNumber-numeroContrat\n", ""]) {
      const csv = join(out, "fictional-bad.csv");
      await writeFile(csv, input);
      await expect(
        runCli(args(out).map((arg) => (arg === join(fixtureDir, "canadabuys.csv") ? csv : arg))),
      ).rejects.toThrow(/missing required columns/);
    }
  });
});
