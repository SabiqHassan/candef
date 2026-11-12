import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { columnsFor } from "./rows";
import { main } from "../api-cli";

vi.mock("./client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./client")>();
  return {
    ...original,
    CkanClient: class {
      async findPackage() {
        return "fictional-package";
      }
      async packageShow() {
        return {
          id: "fictional-package",
          title: "Proactive Publication - Contracts",
          resources: [{ id: "fictional-resource", datastore_active: true }],
        };
      }
      async search(_id: string, options: { limit?: number; offset?: number }) {
        const rows = ["2026-2027-Q2", "2026-2027-Q1"].map((period, i) => ({
          _id: i + 1,
          reference_number: "FICTIONAL-CLI",
          vendor_name: "Fictional Aster Inc.",
          contract_value: "20.00",
          instrument_type: "C",
          reporting_period: period,
          owner_org: "fictional-dept",
          contact_email: "forbidden@example.invalid",
        }));
        return {
          fields: [...columnsFor("contracts"), "_id"].map((id) => ({ id, type: "text" })),
          total: 2,
          records:
            options.limit === 0
              ? []
              : rows.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 1000)),
        };
      }
    },
  };
});

const temporary: string[] = [];
const outputFiles: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) await rm(path, { force: true, recursive: true });
  for (const path of outputFiles.splice(0)) await rm(path, { force: true });
});

describe("gov-api CLI with fictional client", () => {
  it.each(["new-rows", "lookup"])(
    "writes a discovery-only %s report in the ignored cache",
    async (command) => {
      const directory = await mkdtemp(join(tmpdir(), "candef-fictional-api-"));
      temporary.push(directory);
      const csv = join(directory, "fictional.csv"),
        names = join(directory, "names.json");
      await writeFile(
        csv,
        "reference_number,vendor_name,contract_value,instrument_type,reporting_period,owner_org\nFICTIONAL-CLI,Fictional Aster Inc.,20.00,C,2026-2027-Q1,fictional-dept\n",
      );
      await writeFile(names, JSON.stringify(["Fictional Aster"]));
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const args = command === "lookup" ? ["--names", names] : ["--since", "2025-2026-Q1"];
      expect(
        await main(["gov-api", command, "--dataset", "contracts", "--contracts", csv, ...args]),
      ).toBe(0);
      const line = String(log.mock.calls[0]![0]);
      const path = /^Discovery report: (.+) \(exit/.exec(line)?.[1];
      expect(path?.startsWith(resolve("research-cache/gov-api"))).toBe(true);
      outputFiles.push(path!);
      const raw = await readFile(path!, "utf8"),
        report = JSON.parse(raw);
      expect(report.purpose).toContain("never evidence");
      expect(report.datasets[0].resource.id).toBe("fictional-resource");
      expect(raw).not.toContain("forbidden");
      expect(raw).not.toContain("Fictional Aster"); // legal name is encoded only inside the existing locator
      expect(report.datasets[0].discovery.complete).toBe(true);
      if (command === "lookup")
        expect(report.datasets[0].discovery.queries[0]).toMatchObject({
          apiMatches: 2,
          alreadyInLocal: 1,
          notInLocal: [{ locator: expect.stringContaining("row_sha256=") }],
        });
      else expect(report.datasets[0].discovery.matched).toBe(1);
    },
  );
});
