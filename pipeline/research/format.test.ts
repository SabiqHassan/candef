import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as prettier from "prettier";
import { afterEach, describe, expect, it } from "vitest";
import { newOrg } from "./authoring";
import { unformattedFiles } from "./format";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const temp = () => {
  const r = mkdtempSync(join(tmpdir(), "candef-format-"));
  roots.push(r);
  return r;
};

describe("research files stay Prettier-clean (CI runs prettier --check)", () => {
  it("candef new writes a file Prettier leaves unchanged, however long the name", async () => {
    const root = temp();
    const { file } = newOrg(root, {
      kind: "company",
      name: "Fictional Extremely Long Advanced Systems and Technologies Corporation International",
      by: "agent:test",
    });
    const text = readFileSync(file, "utf8");
    expect(await prettier.check(text, { filepath: file })).toBe(true);
  });
  it("reports exactly the files prettier --check would flag", async () => {
    const root = temp();
    mkdirSync(join(root, "orgs"));
    writeFileSync(join(root, "orgs", "good.yaml"), "facts: []\n");
    // A flow mapping longer than the print width: prettier --check fails on it (CI run #6).
    writeFileSync(
      join(root, "orgs", "bad.yaml"),
      `org: { id: org_x, kind: company, slug: x, name: "${"Fictional ".repeat(12)}" }\n`,
    );
    expect(await unformattedFiles(root)).toEqual(["orgs/bad.yaml"]);
  });
});
