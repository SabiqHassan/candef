import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { govCheckHtml, readGovCheck, type GovCheckFile } from "./govCheck";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const cacheWith = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "candef-govcheck-"));
  dirs.push(dir);
  mkdirSync(join(dir, "review"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "review", name), text);
  return dir;
};

const row = {
  reference: "033-2025-2026-Q3-515670",
  amendment: "0",
  reportedName: "FICTIONAL <b>ANYON</b> INC.",
  operatingName: null,
  businessNumber: "123456789",
  postalArea: "H9P",
  department: "Innovation, Science and Economic Development Canada",
  program: null,
  value: "23000000.0",
  start: "2025-12-09",
  end: null,
};
const good = (over: Partial<GovCheckFile> = {}): GovCheckFile => ({
  format: "candef-gov-row-check",
  version: 1,
  dataset: "2026-10-13",
  datasetChecksums: [],
  checkedAt: "2026-10-14T00:00:00Z",
  results: {
    agr_ok: { verdict: "match", findings: [], rows: [row] },
    agr_bad: { verdict: "findings", findings: ["disclosureRows[0].value"], rows: [row] },
  },
  ...over,
});

describe("readGovCheck", () => {
  it("reads the newest valid file and ignores damaged or foreign ones", () => {
    const cache = cacheWith({
      "gov-check-2026-10-12.json": JSON.stringify(good({ dataset: "2026-10-12" })),
      "gov-check-2026-10-13.json": JSON.stringify(good()),
      "gov-check-2026-10-14.json": "{ not json",
      "gov-check-2026-10-15.json": JSON.stringify({ format: "something-else", version: 1 }),
      "workspace.html": "<html>",
    });
    expect(readGovCheck(cache)?.dataset).toBe("2026-10-13");
  });
  it("returns null when there is no usable file", () => {
    expect(readGovCheck(join(tmpdir(), "no-such-cache-folder"))).toBeNull();
    expect(readGovCheck(cacheWith({ "gov-check-x.json": "[]" }))).toBeNull();
  });
  it("rejects a file with the wrong shape instead of showing it", () => {
    const bad = good() as unknown as { results: Record<string, { verdict: string }> };
    bad.results.agr_ok!.verdict = "approved";
    expect(
      readGovCheck(cacheWith({ "gov-check-2026-10-13.json": JSON.stringify(bad) })),
    ).toBeNull();
  });
});

describe("govCheckHtml", () => {
  it("shows nothing without a check file", () => {
    expect(govCheckHtml(null, "agr_ok")).toBe("");
  });
  it("says a match is a match of values, and not of identity", () => {
    const html = govCheckHtml(good(), "agr_ok");
    expect(html).toContain("Every recorded value equals the cited dataset row");
    expect(html).toContain("does not decide that the recipient named in the row is the company");
    expect(html).toContain("H9P");
    expect(html).toContain("123456789");
  });
  it("warns against approving when values differ", () => {
    const html = govCheckHtml(good(), "agr_bad");
    expect(html).toContain("Do not approve until this is resolved");
    expect(html).toContain("disclosureRows[0].value");
  });
  it("escapes everything that comes from the dataset", () => {
    const html = govCheckHtml(good(), "agr_ok");
    expect(html).not.toContain("<b>ANYON</b>");
    expect(html).toContain("&lt;b&gt;ANYON&lt;/b&gt;");
  });
  it("is honest about an agreement the check did not cover", () => {
    expect(govCheckHtml(good(), "agr_other")).toContain("not in the automated check");
  });
});
