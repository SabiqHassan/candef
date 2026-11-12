/**
 * Verification reads on fictional data: values are checked on a page read once, only hashes and
 * offsets are kept, and an edit to the record voids the read.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { corpus, fact, ORG, source } from "./tiers/fixture.test-helpers";
import { coveredByReads, loadReads, verificationRead } from "./verificationRead";
import { reviewUnits } from "./decisions";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "candef-vr-"));
  dirs.push(d);
  return d;
};

const page = (body: string) => ({
  bytes: Buffer.from(`<html><body><p>${body}</p></body></html>`),
  type: "text/html",
});

describe("verification read", () => {
  const build = () =>
    corpus({
      sources: [source("src_nocopy", { permissions: { capture: "denied" } as never })],
      assertions: [fact("asr_year", "founded_year", 2016, "src_nocopy")],
    });

  it("finds the value, keeps only hashes and offsets, and binds the read to the record hash", async () => {
    const cache = tmp();
    const c = build();
    const r = await verificationRead(c, "src_nocopy", {
      cacheDir: cache,
      file: page("Fictional Alpha Inc. - 2016 - was founded to protect small businesses."),
    });
    const rec = r.records.asr_year!;
    expect(rec.parts[0]).toMatchObject({ kind: "year", value: "2016", found: true });
    expect(rec.parts[0]!.offset).toBeGreaterThan(0);
    expect(rec.hash).toBe(reviewUnits(c, "2026-10-20").find((u) => u.id === "asr_year")!.hash);
    expect(r.entityNamed[ORG]).toMatch(/^Fictional Alpha/); // the entity name check
    // Nothing of the page's text is on disk, only the hashes.
    const files = readdirSync(join(cache, "verification-reads"));
    expect(files).toEqual(["src_nocopy.json"]);
    const raw = readFileSync(join(cache, "verification-reads", files[0]!), "utf8");
    expect(raw).not.toContain("protect small businesses");
    expect(r.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(loadReads(cache).get("src_nocopy")!.records.asr_year!.parts[0]!.found).toBe(true);
  });

  it("records a value that is not on the page as not found", async () => {
    const r = await verificationRead(build(), "src_nocopy", {
      cacheDir: tmp(),
      file: page("Fictional Alpha Inc. was founded in 2012."),
    });
    expect(r.records.asr_year!.parts[0]!.found).toBe(false);
  });

  it("reports a refusing page and does not write a read", async () => {
    const cache = tmp();
    await expect(
      verificationRead(build(), "src_nocopy", {
        cacheDir: cache,
        fetchImpl: (async () => new Response("no", { status: 403 })) as typeof fetch,
      }),
    ).rejects.toThrow(/403|robots/);
    expect(existsSync(join(cache, "verification-reads"))).toBe(false);
  });

  it("covers a record only while its hash is unchanged", async () => {
    const cache = tmp();
    const c = build();
    await verificationRead(c, "src_nocopy", {
      cacheDir: cache,
      file: page("Fictional Alpha - 2016"),
    });
    const reads = loadReads(cache);
    const hash = reviewUnits(c, "2026-10-20").find((u) => u.id === "asr_year")!.hash;
    expect(coveredByReads("asr_year", hash, [{ part: "value" }], new Set(), reads).missing).toEqual(
      [],
    );
    expect(
      coveredByReads("asr_year", "0".repeat(64), [{ part: "value" }], new Set(), reads).missing,
    ).toEqual(["value"]);
  });
});
