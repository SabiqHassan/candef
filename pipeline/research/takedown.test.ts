/** Corrections/takedowns on TEMPORARY SYNTHETIC corpora only. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../compile/compile";
import { loadResearchCorpus } from "./load";
import { reviewRecords } from "./review";
import { readTakedowns, retractRecords, takedownFailures } from "./takedown";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function setup(): string {
  const r = mkdtempSync(join(tmpdir(), "candef-takedown-"));
  roots.push(r);
  mkdirSync(join(r, "sources"));
  mkdirSync(join(r, "orgs"));
  writeFileSync(
    join(r, "sources", "src_i.yaml"),
    'kind: company_release\ntier: T2\npublisher: Fictional India\ntitle: About\nurl: https://example.org/fictional-india\npublishedOn: null\nretrievedAt: "2026-10-13T00:00:00Z"\noriginGroup: og:i\ntextSha256: null\n',
  );
  writeFileSync(
    join(r, "orgs", "india.yaml"),
    'org: { id: org_india, kind: company, slug: india, name: Fictional India }\ndefaults: { createdBy: "agent:test" }\nfacts:\n  - { id: a_desc, predicate: description, value: "Fictional description", src: ["src_i#about"] }\n',
  );
  reviewRecords(r, { ids: ["a_desc"], reviewer: "owner", at: "2026-10-13" });
  return r;
}

describe("corrections and takedowns", () => {
  it("retracts a published record, logs the takedown, and the compiler withholds it", () => {
    const r = setup();
    retractRecords(r, {
      ids: ["a_desc"],
      by: "owner",
      at: "2026-10-14",
      reason: "Source withdrew the statement",
    });
    const corpus = loadResearchCorpus(r).corpus!;
    expect(corpus.assertions[0]!.verification).toBe("retracted");
    expect(readTakedowns(r)).toEqual([
      { date: "2026-10-14", ids: ["a_desc"], reason: "Source withdrew the statement", by: "owner" },
    ]);
    expect(compile(corpus, { today: "2026-10-14" }).snapshot!.assertions["a_desc"]).toBeUndefined();
    expect(takedownFailures(corpus, readTakedowns(r))).toEqual([]);
  });

  it("fails the build when a taken-down record becomes publishable again", () => {
    const r = setup();
    retractRecords(r, {
      ids: ["a_desc"],
      by: "owner",
      at: "2026-10-14",
      reason: "Correction requested",
    });
    const file = join(r, "orgs", "india.yaml");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("verification: retracted", "verification: verified"),
    );
    const failures = takedownFailures(loadResearchCorpus(r).corpus!, readTakedowns(r));
    expect(failures.map((f) => f.gate)).toEqual(["takedown-respected"]);
  });

  it("refuses agent names, unknown IDs and empty reasons", () => {
    const r = setup();
    expect(() =>
      retractRecords(r, { ids: ["a_desc"], by: "agent:claude", at: "2026-10-14", reason: "x x x" }),
    ).toThrow(/cannot retract/);
    expect(() =>
      retractRecords(r, { ids: ["nope"], by: "owner", at: "2026-10-14", reason: "x x x" }),
    ).toThrow(/unknown/);
    expect(() =>
      retractRecords(r, { ids: ["a_desc"], by: "owner", at: "2026-10-14", reason: "" }),
    ).toThrow();
  });

  it("the CLI refuses to retract without an interactive terminal", () => {
    const r = setup();
    const res = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "pipeline/cli/candef.ts",
        "retract",
        "a_desc",
        "--reason",
        "test",
        "--dir",
        r,
      ],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(res.status).toBe(2);
    expect(loadResearchCorpus(r).corpus!.assertions[0]!.verification).toBe("verified");
  });
});
