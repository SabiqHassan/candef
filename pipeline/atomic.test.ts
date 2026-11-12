import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "./compile/compile";
import { generateDemoCorpus } from "./demo/generate";
import { writeFileAtomic } from "./atomic";
import { publishSnapshot } from "./publish";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "candef-atomic-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("creates a file and replaces an existing one whole, leaving no temporary file", () => {
    const dir = tmp();
    const file = join(dir, "manifest.json");
    writeFileAtomic(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    writeFileAtomic(file, '{"a":2,"long":"' + "x".repeat(100_000) + '"}');
    expect(JSON.parse(readFileSync(file, "utf8")).a).toBe(2);
    expect(readdirSync(dir)).toEqual(["manifest.json"]);
  });

  it("fails loudly, and leaves nothing behind, when the target cannot be written", () => {
    const dir = tmp();
    expect(() => writeFileAtomic(join(dir, "missing", "manifest.json"), "x")).toThrow(/ENOENT/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never touches the old file until the new one is complete", () => {
    const dir = tmp();
    const file = join(dir, "manifest.json");
    writeFileSync(file, "old");
    // A write that fails before the rename (unwritable temporary path) keeps the old content.
    expect(() => writeFileAtomic(join(dir, "nope", "manifest.json"), "new")).toThrow();
    expect(readFileSync(file, "utf8")).toBe("old");
  });
});

describe("publishSnapshot", () => {
  it("leaves only the snapshots and a valid manifest in the directory", () => {
    const dir = tmp();
    const snap = (n: number) =>
      compile(generateDemoCorpus({ companies: n }), { today: "2026-10-13" }).snapshot!;
    publishSnapshot(dir, snap(15));
    const second = publishSnapshot(dir, snap(18));
    const files = readdirSync(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(files.sort()).toEqual([
      "manifest.json",
      ...files.filter((f) => f.startsWith("snapshot.")).sort(),
    ]);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest.current).toBe(second.file);
    expect(manifest.previous).toHaveLength(1);
  });
});
