import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "./compile/compile";
import { generateDemoCorpus } from "./demo/generate";
import { publishSnapshot } from "./publish";
import { rollback } from "./rollback";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const build = (dir: string, companies: number) =>
  publishSnapshot(
    dir,
    compile(generateDemoCorpus({ companies }), { today: "2026-10-13" }).snapshot!,
  );
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));

describe("snapshot rollback (D-18)", () => {
  it("re-points the manifest at the previous snapshot and can be reversed", () => {
    const dir = mkdtempSync(join(tmpdir(), "candef-rollback-"));
    dirs.push(dir);
    const first = build(dir, 20).file;
    const second = build(dir, 25).file;
    expect(manifest(dir).current).toBe(second);
    rollback(dir);
    expect(manifest(dir).current).toBe(first);
    expect(manifest(dir).previous[0]).toBe(second);
    rollback(dir); // reverse
    expect(manifest(dir).current).toBe(second);
  });
  it("refuses when there is nothing to roll back to, or the file is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "candef-rollback-"));
    dirs.push(dir);
    const first = build(dir, 20).file;
    expect(() => rollback(dir)).toThrow(/no previous/);
    build(dir, 25);
    unlinkSync(join(dir, first));
    expect(() => rollback(dir)).toThrow(/missing/);
    expect(existsSync(join(dir, manifest(dir).current))).toBe(true);
  });
});
