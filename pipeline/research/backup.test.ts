import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupCache, restoreCache, verifyBackup } from "./backup";
import { AuthoringError } from "./authoring";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SECRET = "fictional-backup-passphrase-for-tests";
const encrypted = (cache: string, target: string, exclude: string[] = []) =>
  backupCache(cache, target, REPO, { encrypt: true, exclude });
const fixture = () => {
  vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", SECRET);
  const cache = temp();
  const target = temp();
  mkdirSync(join(cache, "captures", "fictional"), { recursive: true });
  writeFileSync(
    join(cache, "captures", "fictional", "source.html"),
    "fictional plaintext marker: never in ciphertext",
  );
  writeFileSync(join(cache, "report.txt"), "another fictional document");
  return { cache, target };
};
const manifestAt = (target: string) =>
  JSON.parse(readFileSync(join(target, "manifest.json"), "utf8")) as {
    encrypted: boolean;
    files: { path: string; sha256: string; bytes: number; stored: string; storedSha256: string }[];
  };
const snapshot = (root: string, prefix = ""): Record<string, string> =>
  Object.fromEntries(
    readdirSync(root, { withFileTypes: true }).flatMap((f): [string, string][] =>
      f.isDirectory()
        ? Object.entries(snapshot(join(root, f.name), `${prefix}${f.name}/`))
        : [[`${prefix}${f.name}`, readFileSync(join(root, f.name)).toString("hex")]],
    ),
  );

describe("encrypted private backup and restore", () => {
  it("round-trips a byte-identical tree and verifies with and without the environment passphrase", async () => {
    const { cache, target } = fixture();
    writeFileSync(join(cache, "empty.txt"), "");
    writeFileSync(join(cache, "binary.bin"), Buffer.from([0, 255, 128, 13, 10]));
    expect(await encrypted(cache, target)).toMatchObject({ files: 4, copied: 4 });
    const keyBefore = readFileSync(join(target, "backup-key.json"), "utf8");
    expect(await encrypted(cache, target)).toMatchObject({ unchanged: 4, copied: 0 });
    expect(readFileSync(join(target, "backup-key.json"), "utf8")).toBe(keyBefore);
    expect(JSON.parse(keyBefore)).toMatchObject({ kdf: "scrypt", N: 32768, r: 8, p: 1 });
    const manifest = manifestAt(target);
    expect(manifest.encrypted).toBe(true);
    for (const f of manifest.files) {
      expect(f.stored).toBe(`${f.path}.enc`);
      expect(f.sha256).toBe(
        createHash("sha256")
          .update(readFileSync(join(cache, f.path)))
          .digest("hex"),
      );
      expect(f.storedSha256).toBe(
        createHash("sha256")
          .update(readFileSync(join(target, f.stored)))
          .digest("hex"),
      );
    }
    vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", undefined);
    expect(await verifyBackup(target)).toEqual({
      files: 4,
      ok: true,
      missing: [],
      corrupt: [],
      decrypted: false,
    });
    vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", SECRET);
    expect(await verifyBackup(target)).toEqual({
      files: 4,
      ok: true,
      missing: [],
      corrupt: [],
      decrypted: true,
    });
    const restored = join(temp(), "new-output");
    expect(await restoreCache(target, restored, REPO)).toEqual({ restored: 4, failed: [] });
    expect(snapshot(restored)).toEqual(snapshot(cache));
  });

  it("does not expose plaintext or the passphrase in ciphertext or metadata; uses fresh IVs", async () => {
    const { cache, target } = fixture();
    await encrypted(cache, target);
    const ivs = new Set<string>();
    for (const f of manifestAt(target).files) {
      const bytes = readFileSync(join(target, f.stored));
      expect(bytes.subarray(0, 8).toString()).toBe("CANDEFB1");
      expect(bytes.includes(Buffer.from("fictional plaintext marker"))).toBe(false);
      ivs.add(bytes.subarray(8, 20).toString("hex"));
    }
    expect(ivs.size).toBe(2);
    for (const name of ["manifest.json", "backup-key.json"])
      expect(readFileSync(join(target, name), "utf8")).not.toContain(SECRET);
  });

  it("refuses missing/short passphrases and a wrong passphrase before writing anything", async () => {
    const { cache, target } = fixture();
    for (const value of [undefined, "too-short"]) {
      vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", value);
      await expect(encrypted(cache, target)).rejects.toThrow(AuthoringError);
      expect(readdirSync(target)).toEqual([]);
    }
    vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", SECRET);
    await encrypted(cache, target);
    const before = snapshot(target);
    writeFileSync(join(cache, "new.txt"), "new fictional content");
    vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", "a-different-fictional-passphrase");
    await expect(encrypted(cache, target)).rejects.toThrow(/wrong backup passphrase/);
    expect(snapshot(target)).toEqual(before);
    const restored = join(temp(), "must-not-exist");
    await expect(restoreCache(target, restored, REPO)).rejects.toThrow(/wrong backup passphrase/);
    expect(existsSync(restored)).toBe(false);
    await expect(verifyBackup(target)).rejects.toThrow(/wrong backup passphrase/);
  });

  it("detects tampering and missing files, and never leaves failed plaintext or temporary output", async () => {
    const { cache, target } = fixture();
    await encrypted(cache, target);
    const file = join(target, "report.txt.enc");
    const bytes = readFileSync(file);
    bytes[20] = bytes[20]! ^ 1;
    writeFileSync(file, bytes);
    vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", undefined);
    expect(await verifyBackup(target)).toMatchObject({
      ok: false,
      corrupt: ["report.txt"],
      decrypted: false,
    });
    vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", SECRET);
    expect(await verifyBackup(target)).toMatchObject({ ok: false, corrupt: ["report.txt"] });
    // Updating the untrusted stored checksum still cannot bypass GCM authentication.
    const manifest = manifestAt(target);
    manifest.files.find((f) => f.path === "report.txt")!.storedSha256 = createHash("sha256")
      .update(bytes)
      .digest("hex");
    writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest));
    expect(await verifyBackup(target)).toMatchObject({ ok: false, corrupt: ["report.txt"] });
    const restored = temp();
    expect(await restoreCache(target, restored, REPO)).toEqual({
      restored: 1,
      failed: ["report.txt"],
    });
    expect(Object.keys(snapshot(restored))).toEqual(["captures/fictional/source.html"]);
    rmSync(file);
    expect(await verifyBackup(target)).toMatchObject({
      ok: false,
      missing: ["report.txt"],
      corrupt: [],
    });
  });

  it("authenticates relative paths so swapped ciphertext fails even with updated stored checksums", async () => {
    const { cache, target } = fixture();
    await encrypted(cache, target);
    const manifest = manifestAt(target);
    const [a, b] = manifest.files;
    const first = readFileSync(join(target, a!.stored));
    const second = readFileSync(join(target, b!.stored));
    writeFileSync(join(target, a!.stored), second);
    writeFileSync(join(target, b!.stored), first);
    [a!.storedSha256, b!.storedSha256] = [b!.storedSha256, a!.storedSha256];
    writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest));
    expect(await verifyBackup(target)).toMatchObject({ ok: false, corrupt: [a!.path, b!.path] });
    const restored = temp();
    expect(await restoreCache(target, restored, REPO)).toEqual({
      restored: 0,
      failed: [a!.path, b!.path],
    });
    expect(Object.keys(snapshot(restored))).toEqual([]);
  });

  it("keeps and reports previous ciphertext for changed plaintext, including repeat versions", async () => {
    const { cache, target } = fixture();
    await encrypted(cache, target);
    const before = readFileSync(join(target, "report.txt.enc"));
    const hash = manifestAt(target).files.find((f) => f.path === "report.txt")!.sha256;
    writeFileSync(join(cache, "report.txt"), "changed fictional report");
    const result = await encrypted(cache, target);
    const previous = `report.txt.enc.prev-${hash.slice(0, 8)}`;
    expect(result).toMatchObject({ copied: 1, unchanged: 1, previous: [previous] });
    expect(readFileSync(join(target, previous))).toEqual(before);
    const changed = readFileSync(join(target, "report.txt.enc"));
    expect(changed).not.toEqual(before);
    expect(changed.subarray(8, 20)).not.toEqual(before.subarray(8, 20));
    writeFileSync(join(cache, "report.txt"), "another fictional document");
    await encrypted(cache, target);
    writeFileSync(join(cache, "report.txt"), "changed again");
    const repeated = await encrypted(cache, target);
    expect(repeated.previous[0]).toMatch(new RegExp(`^${previous}-`));
    expect(readFileSync(join(target, previous))).toEqual(before);
    expect(await verifyBackup(target)).toMatchObject({ ok: true });
  });

  it("excludes repeatable POSIX prefixes in plain and encrypted manifests", async () => {
    const { cache, target } = fixture();
    mkdirSync(join(cache, "gov-data"));
    writeFileSync(join(cache, "gov-data", "fictional.csv"), "fictional,only\n");
    expect(await encrypted(cache, target, ["gov-data/", "report"])).toMatchObject({
      excluded: 2,
      files: 1,
    });
    expect(manifestAt(target).files.map((f) => f.path)).toEqual(["captures/fictional/source.html"]);
    expect(existsSync(join(target, "gov-data"))).toBe(false);
    const plain = temp();
    expect(backupCache(cache, plain, REPO, { exclude: ["gov-data/", "report"] })).toMatchObject({
      excluded: 2,
      files: 1,
    });
    expect(manifestAt(plain).files).toHaveLength(1);
    expect(() => backupCache(cache, temp(), REPO, { exclude: ["../"] })).toThrow(/POSIX/);
  });

  it("streams a generated 20 MiB fictional dataset through backup, verification, and restore", async () => {
    const { cache, target } = fixture();
    const src = join(cache, "dataset.bin");
    const chunk = Buffer.alloc(1024 * 1024, "fictional-dataset\n");
    const fd = openSync(src, "wx");
    try {
      for (let i = 0; i < 20; i++) writeSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
    expect(await encrypted(cache, target)).toMatchObject({ copied: 3 });
    expect(manifestAt(target).files.find((f) => f.path === "dataset.bin")!.bytes).toBe(
      20 * 1024 * 1024,
    );
    expect(await verifyBackup(target)).toMatchObject({ ok: true, decrypted: true });
    const restored = temp();
    expect(await restoreCache(target, restored, REPO)).toEqual({ restored: 3, failed: [] });
    expect(readFileSync(join(restored, "dataset.bin")).equals(readFileSync(src))).toBe(true);
  }, 20000);

  it("restores plain conflict copies using their actual stored paths", async () => {
    const cache = temp();
    const target = temp();
    writeFileSync(join(cache, "report.txt"), "fictional new content");
    writeFileSync(join(target, "report.txt"), "fictional old content");
    backupCache(cache, target, REPO);
    const manifest = manifestAt(target);
    expect(manifest.encrypted).toBe(false);
    expect(manifest.files[0]!.stored).toMatch(/^report.txt.conflict-/);
    expect(await verifyBackup(target)).toMatchObject({ ok: true, decrypted: false });
    const restored = temp();
    expect(await restoreCache(target, restored, REPO)).toEqual({ restored: 1, failed: [] });
    expect(snapshot(restored)).toEqual(snapshot(cache));
  });

  it("enforces restore location, emptiness, and safe manifest paths before writing", async () => {
    const { cache, target } = fixture();
    await encrypted(cache, target);
    const fakeRepo = temp();
    await expect(restoreCache(target, join(fakeRepo, "other"), fakeRepo)).rejects.toThrow(
      /outside the repository/,
    );
    expect(existsSync(join(fakeRepo, "other"))).toBe(false);
    const ownCache = join(fakeRepo, "research-cache");
    expect(await restoreCache(target, ownCache, fakeRepo)).toMatchObject({ restored: 2 });
    await expect(restoreCache(target, ownCache, fakeRepo)).rejects.toThrow(/empty or missing/);
    rmSync(ownCache, { recursive: true });
    mkdirSync(ownCache);
    expect(await restoreCache(target, ownCache, fakeRepo)).toMatchObject({ restored: 2 });
    await expect(restoreCache(target, join(target, "output"), REPO)).rejects.toThrow(/overlap/);
    const manifest = manifestAt(target);
    manifest.files[0]!.path = "../escape.txt";
    writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest));
    const restored = join(temp(), "not-created");
    await expect(restoreCache(target, restored, REPO)).rejects.toThrow(/manifest/);
    expect(existsSync(restored)).toBe(false);
  });

  it("refuses backup mode changes and missing key metadata without modifying the destination", async () => {
    const { cache, target } = fixture();
    await encrypted(cache, target);
    const before = snapshot(target);
    expect(() => backupCache(cache, target, REPO)).toThrow(/mix encrypted and plain/);
    expect(snapshot(target)).toEqual(before);
    rmSync(join(target, "backup-key.json"));
    const withoutKey = snapshot(target);
    await expect(encrypted(cache, target)).rejects.toThrow(/backup-key.json is missing/);
    expect(snapshot(target)).toEqual(withoutKey);
    const plain = temp();
    backupCache(cache, plain, REPO);
    expect(() => encrypted(cache, plain)).toThrow(/mix encrypted and plain/);
  });

  it("checks plaintext manifest hashes and sizes before publishing restored files", async () => {
    const { cache, target } = fixture();
    await encrypted(cache, target);
    const manifest = manifestAt(target);
    manifest.files.find((f) => f.path === "report.txt")!.sha256 = "0".repeat(64);
    manifest.files.find((f) => f.path !== "report.txt")!.bytes++;
    writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest));
    vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", undefined);
    expect(await verifyBackup(target)).toMatchObject({ ok: true, decrypted: false });
    vi.stubEnv("CANDEF_BACKUP_PASSPHRASE", SECRET);
    expect(await verifyBackup(target)).toMatchObject({
      ok: false,
      corrupt: manifest.files.map((f) => f.path),
    });
    const restored = temp();
    expect(await restoreCache(target, restored, REPO)).toEqual({
      restored: 0,
      failed: manifest.files.map((f) => f.path),
    });
    expect(Object.keys(snapshot(restored))).toEqual([]);
  });

  it("blocks junctions and ancestor destinations that would write inside the repository", async () => {
    const cache = temp();
    const parent = temp();
    const fakeRepo = join(parent, "fictional-repo");
    mkdirSync(fakeRepo);
    mkdirSync(join(cache, "fictional-repo"));
    writeFileSync(join(cache, "fictional-repo", "capture.txt"), "fictional private capture");
    expect(() => backupCache(cache, parent, fakeRepo)).toThrow(/inside the repository/);
    expect(readdirSync(fakeRepo)).toEqual([]);
    const junction = join(temp(), "repo-junction");
    symlinkSync(fakeRepo, junction, "junction");
    expect(() => backupCache(cache, join(junction, "backup"), fakeRepo)).toThrow(
      /outside the repository/,
    );
    const target = temp();
    const outside = temp();
    symlinkSync(outside, join(target, "fictional-repo"), "junction");
    expect(() => backupCache(cache, target, fakeRepo)).toThrow(/symlinks/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "candef-backup-"));
  dirs.push(d);
  return d;
};
const REPO = process.cwd();

describe("research-cache backup (D-15)", () => {
  it("copies with verification, skips unchanged files, and writes a manifest", () => {
    const cache = temp();
    const target = temp();
    mkdirSync(join(cache, "captures", "src_a"), { recursive: true });
    writeFileSync(join(cache, "captures", "src_a", "cap_1.html"), "<p>fictional</p>");
    writeFileSync(join(cache, "metrics.jsonl"), "{}\n");
    expect(backupCache(cache, target, REPO)).toMatchObject({ copied: 2, unchanged: 0, files: 2 });
    expect(readFileSync(join(target, "captures", "src_a", "cap_1.html"), "utf8")).toBe(
      "<p>fictional</p>",
    );
    expect(backupCache(cache, target, REPO)).toMatchObject({ copied: 0, unchanged: 2 });
    const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("never overwrites a differing file at the destination", () => {
    const cache = temp();
    const target = temp();
    writeFileSync(join(cache, "a.txt"), "new content");
    writeFileSync(join(target, "a.txt"), "original content");
    const r = backupCache(cache, target, REPO);
    expect(r.conflicts).toEqual(["a.txt"]);
    expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("original content");
    const conflict = readdirSync(target).find((f) => f.startsWith("a.txt.conflict-"))!;
    expect(readFileSync(join(target, conflict), "utf8")).toBe("new content");
  });
  it("refuses a destination inside the repository or overlapping the cache", () => {
    const cache = temp();
    writeFileSync(join(cache, "a.txt"), "x");
    expect(() => backupCache(cache, join(REPO, "backup-here"), REPO)).toThrow(
      /outside the repository/,
    );
    expect(() => backupCache(cache, join(cache, "sub"), REPO)).toThrow(/overlap/);
  });
});
