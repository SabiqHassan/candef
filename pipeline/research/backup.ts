/**
 * Private, local-folder research-cache backup (D-15 / P-30). Plain backups retain the synchronous
 * API and side-by-side conflicts. Encrypted backups stream AES-256-GCM, authenticate paths, retain
 * previous ciphertext, and verify plaintext before publishing the manifest. No network or secrets
 * in metadata; the passphrase comes exclusively from CANDEF_BACKUP_PASSPHRASE.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AuthoringError } from "./authoring";

const MAGIC = Buffer.from("CANDEFB1");
const CHECK = Buffer.from("CANDEF backup key check v1");
const KDF = { kdf: "scrypt", N: 2 ** 15, r: 8, p: 1 } as const;
const HASH = /^[0-9a-f]{64}$/;

export interface BackupOptions {
  encrypt?: boolean;
  exclude?: string[];
}
export interface BackupResult {
  copied: number;
  unchanged: number;
  conflicts: string[];
  files: number;
  excluded: number;
  previous: string[];
}
interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
  stored: string;
  storedSha256: string;
}
interface Manifest {
  generatedAt: string;
  encrypted: boolean;
  files: ManifestFile[];
}
export interface VerifyResult {
  files: number;
  ok: boolean;
  missing: string[];
  corrupt: string[];
  decrypted: boolean;
}
export interface RestoreResult {
  restored: number;
  failed: string[];
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(rel))
  );
};

/** Resolve existing ancestors too, so a junction cannot bypass the repository/cache guards. */
function physical(path: string): string {
  const abs = resolve(path);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(physical(parent), relative(parent, abs));
}

function validPath(path: string, prefix = false): boolean {
  const parts = (prefix && path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  return parts.every(
    (p) =>
      p.length > 0 &&
      p !== "." &&
      p !== ".." &&
      !/[\\:<>"|?*]/.test(p) &&
      ![...p].some((c) => c.charCodeAt(0) < 32) &&
      !/[. ]$/.test(p) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p),
  );
}

/** Reject symlinks/junctions in stored and output paths, including metadata files. */
function safeFile(root: string, rel: string): string {
  if (!validPath(rel)) throw new AuthoringError("backup contains an unsafe relative path");
  let path = root;
  for (const part of rel.split("/")) {
    path = join(path, part);
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new AuthoringError("backup paths must not contain symlinks");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return path;
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new AuthoringError("cache must contain only regular files and directories");
    return stat.isDirectory() ? walk(abs, base) : [relative(base, abs).replace(/\\/g, "/")];
  });
}

/** Bounded-memory hashing for the legacy synchronous plain API. */
function hashSync(file: string): string {
  const fd = openSync(file, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  try {
    let n: number;
    while ((n = readSync(fd, chunk, 0, chunk.length, null))) hash.update(chunk.subarray(0, n));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function hashSink() {
  const hash = createHash("sha256");
  let bytes = 0;
  return {
    stream: new Writable({
      write(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        bytes += chunk.length;
        done();
      },
    }),
    digest: () => ({ sha256: hash.digest("hex"), bytes }),
  };
}

async function hashFile(file: string) {
  const sink = hashSink();
  await pipeline(createReadStream(file), sink.stream);
  return sink.digest();
}

function tempFile(file: string): string {
  return `${file}.tmp-${randomBytes(12).toString("hex")}`;
}
function removeTemp(file: string) {
  if (existsSync(file)) unlinkSync(file);
}
function writeJson(file: string, value: unknown) {
  const tmp = tempFile(file);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: "wx" });
    renameSync(tmp, file);
  } finally {
    removeTemp(tmp);
  }
}

function readManifest(root: string, legacy = false): Manifest {
  try {
    const data = JSON.parse(readFileSync(safeFile(root, "manifest.json"), "utf8")) as Manifest;
    if (!data || (!legacy && typeof data.encrypted !== "boolean") || !Array.isArray(data.files))
      throw new Error();
    const paths = new Set<string>();
    const stored = new Set<string>();
    for (const f of data.files) {
      if (
        !f ||
        typeof f.path !== "string" ||
        !validPath(f.path) ||
        !HASH.test(f.sha256) ||
        !Number.isSafeInteger(f.bytes) ||
        f.bytes < 0 ||
        paths.has(f.path)
      )
        throw new Error();
      if (legacy && !data.encrypted && f.stored === undefined) {
        f.stored = f.path;
        f.storedSha256 = f.sha256;
      }
      if (
        typeof f.stored !== "string" ||
        !validPath(f.stored) ||
        !HASH.test(f.storedSha256) ||
        stored.has(f.stored) ||
        (data.encrypted && f.stored !== `${f.path}.enc`)
      )
        throw new Error();
      paths.add(f.path);
      stored.add(f.stored);
    }
    return { ...data, encrypted: data.encrypted ?? false };
  } catch {
    throw new AuthoringError("backup manifest is missing or invalid");
  }
}

function passphrase(): string {
  const value = process.env.CANDEF_BACKUP_PASSPHRASE;
  if (!value || value.length < 16)
    throw new AuthoringError(
      "CANDEF_BACKUP_PASSPHRASE is required and must contain at least 16 characters",
    );
  return value;
}

/** A small authenticated key check is IV + ciphertext + tag, encoded as hex. */
function keyMaterial(root: string, create: boolean): { key: Buffer; metadata?: unknown } {
  const secret = passphrase();
  const file = safeFile(root, "backup-key.json");
  if (!existsSync(file)) {
    if (!create) throw new AuthoringError("backup-key.json is missing");
    const salt = randomBytes(16);
    const key = scryptSync(secret, salt, 32, { ...KDF, maxmem: 64 * 1024 * 1024 });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const check = Buffer.concat([iv, cipher.update(CHECK), cipher.final(), cipher.getAuthTag()]);
    return { key, metadata: { ...KDF, salt: salt.toString("hex"), check: check.toString("hex") } };
  }
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (
      data.kdf !== KDF.kdf ||
      data.N !== KDF.N ||
      data.r !== KDF.r ||
      data.p !== KDF.p ||
      !/^[0-9a-f]{32}$/.test(data.salt) ||
      typeof data.check !== "string" ||
      data.check.length !== (12 + CHECK.length + 16) * 2 ||
      !/^[0-9a-f]+$/.test(data.check)
    )
      throw new Error();
    const key = scryptSync(secret, Buffer.from(data.salt, "hex"), 32, {
      ...KDF,
      maxmem: 64 * 1024 * 1024,
    });
    const check = Buffer.from(data.check, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, check.subarray(0, 12));
    decipher.setAuthTag(check.subarray(-16));
    if (!Buffer.concat([decipher.update(check.subarray(12, -16)), decipher.final()]).equals(CHECK))
      throw new Error();
    return { key };
  } catch {
    throw new AuthoringError("wrong backup passphrase or invalid backup-key.json");
  }
}

function decipherFor(file: string, rel: string, key: Buffer) {
  const size = statSync(file).size;
  if (size < 36) throw new AuthoringError("invalid encrypted backup file");
  const fd = openSync(file, "r");
  const header = Buffer.alloc(20);
  const tag = Buffer.alloc(16);
  try {
    if (
      readSync(fd, header, 0, 20, 0) !== 20 ||
      readSync(fd, tag, 0, 16, size - 16) !== 16 ||
      !header.subarray(0, 8).equals(MAGIC)
    )
      throw new AuthoringError("invalid encrypted backup file");
  } finally {
    closeSync(fd);
  }
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(8));
  decipher.setAAD(Buffer.from(rel, "utf8"));
  decipher.setAuthTag(tag);
  return { decipher, size };
}

async function decryptHash(file: string, rel: string, key: Buffer) {
  const { decipher, size } = decipherFor(file, rel, key);
  const sink = hashSink();
  // An empty plaintext has no ciphertext; an empty stream still authenticates its tag.
  const input =
    size === 36 ? Readable.from([]) : createReadStream(file, { start: 20, end: size - 17 });
  await pipeline(input, decipher, sink.stream);
  return sink.digest();
}

async function encryptFile(src: string, dest: string, rel: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(rel, "utf8"));
  // Header and tag are tiny; the payload always travels through streams.
  writeFileSync(dest, Buffer.concat([MAGIC, iv]), { flag: "wx" });
  await pipeline(createReadStream(src), cipher, createWriteStream(dest, { flags: "a" }));
  writeFileSync(dest, cipher.getAuthTag(), { flag: "a" });
}

export function backupCache(cacheDir: string, targetDir: string, repoRoot: string): BackupResult;
export function backupCache(
  cacheDir: string,
  targetDir: string,
  repoRoot: string,
  options: BackupOptions & { encrypt: true },
): Promise<BackupResult>;
export function backupCache(
  cacheDir: string,
  targetDir: string,
  repoRoot: string,
  options: BackupOptions,
): BackupResult | Promise<BackupResult>;
export function backupCache(
  cacheDir: string,
  targetDir: string,
  repoRoot: string,
  options: BackupOptions = {},
): BackupResult | Promise<BackupResult> {
  const cache = physical(cacheDir);
  const target = physical(targetDir);
  const repo = physical(repoRoot);
  if (inside(target, repo))
    throw new AuthoringError(
      "the backup must be outside the repository (captures never enter Git)",
    );
  if (inside(target, cache) || inside(cache, target))
    throw new AuthoringError("the backup must not overlap the cache itself");
  if (!existsSync(cache)) throw new AuthoringError(`no cache at ${cache}`);
  for (const prefix of options.exclude ?? [])
    if (!validPath(prefix, true))
      throw new AuthoringError("--exclude must be a relative POSIX path prefix");
  const all = walk(cache);
  const files = all.filter(
    (rel) => !(options.exclude ?? []).some((prefix) => rel.startsWith(prefix)),
  );
  for (const rel of files) {
    if (!validPath(rel) || ["manifest.json", "backup-key.json"].includes(rel.split("/")[0]!))
      throw new AuthoringError("cache contains an unsafe or reserved backup path");
    const dest = safeFile(target, options.encrypt ? `${rel}.enc` : rel);
    if (inside(dest, repo))
      throw new AuthoringError("the backup must not write files inside the repository");
  }
  const manifestFile = safeFile(target, "manifest.json");
  const previous = existsSync(manifestFile) ? readManifest(target, true) : undefined;
  if (previous && previous.encrypted !== !!options.encrypt)
    throw new AuthoringError("cannot mix encrypted and plain backups in one destination");
  if (!options.encrypt && existsSync(safeFile(target, "backup-key.json")))
    throw new AuthoringError("cannot write a plain backup into an encrypted destination");
  const result: BackupResult = {
    copied: 0,
    unchanged: 0,
    conflicts: [],
    files: files.length,
    excluded: all.length - files.length,
    previous: [],
  };
  if (options.encrypt) return encryptedBackup(cache, target, files, previous, result);
  const manifest: ManifestFile[] = [];
  for (const rel of files) {
    const src = join(cache, rel);
    const hash = hashSync(src);
    let stored = rel;
    let dest = safeFile(target, stored);
    if (existsSync(dest) && hashSync(dest) !== hash) {
      stored = `${rel}.conflict-${hash.slice(0, 8)}`;
      dest = safeFile(target, stored);
      result.conflicts.push(rel);
    }
    if (existsSync(dest)) {
      if (hashSync(dest) !== hash)
        throw new AuthoringError(`conflict copy of ${rel} already differs`);
      // Preserve the legacy conflict counters (existing conflict copies are not unchanged originals).
      if (stored === rel) result.unchanged++;
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest, constants.COPYFILE_EXCL);
      if (hashSync(dest) !== hash) throw new AuthoringError(`copy of ${rel} failed verification`);
      result.copied++;
    }
    manifest.push({
      path: rel,
      sha256: hash,
      bytes: statSync(src).size,
      stored,
      storedSha256: hash,
    });
  }
  mkdirSync(target, { recursive: true });
  writeJson(manifestFile, {
    generatedAt: new Date().toISOString(),
    encrypted: false,
    files: manifest,
  });
  return result;
}

async function encryptedBackup(
  cache: string,
  target: string,
  files: string[],
  old: Manifest | undefined,
  result: BackupResult,
): Promise<BackupResult> {
  // Authenticate before mkdir, temporary writes, renames, or metadata changes.
  const { key, metadata } = keyMaterial(target, !old);
  mkdirSync(target, { recursive: true });
  if (metadata) writeJson(safeFile(target, "backup-key.json"), metadata);
  const manifest: ManifestFile[] = [];
  for (const rel of files) {
    const src = join(cache, rel);
    const plain = await hashFile(src);
    const stored = `${rel}.enc`;
    const dest = safeFile(target, stored);
    const prior = old?.files.find((f) => f.path === rel);
    if (
      prior?.sha256 === plain.sha256 &&
      existsSync(dest) &&
      (await hashFile(dest)).sha256 === prior.storedSha256
    ) {
      const verified = await decryptHash(dest, rel, key);
      if (verified.sha256 !== plain.sha256 || verified.bytes !== plain.bytes)
        throw new AuthoringError(`encrypted copy of ${rel} failed verification`);
      manifest.push({ ...prior, bytes: plain.bytes });
      result.unchanged++;
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = tempFile(dest);
    try {
      await encryptFile(src, tmp, rel, key);
      const verified = await decryptHash(tmp, rel, key);
      if (verified.sha256 !== plain.sha256 || verified.bytes !== plain.bytes)
        throw new AuthoringError(`encrypted copy of ${rel} failed verification`);
      const storedSha256 = (await hashFile(tmp)).sha256;
      if (existsSync(dest)) {
        const oldHash = (await hashFile(dest)).sha256;
        // Use the previous plaintext hash when known; unknown ciphertext is named by its stored hash.
        let previous = `${stored}.prev-${(prior?.sha256 ?? oldHash).slice(0, 8)}`;
        if (existsSync(safeFile(target, previous)))
          previous += `-${randomBytes(8).toString("hex")}`;
        renameSync(dest, safeFile(target, previous));
        result.previous.push(previous);
      }
      renameSync(tmp, dest);
      manifest.push({ path: rel, ...plain, stored, storedSha256 });
      result.copied++;
    } finally {
      removeTemp(tmp);
    }
  }
  writeJson(safeFile(target, "manifest.json"), {
    generatedAt: new Date().toISOString(),
    encrypted: true,
    files: manifest,
  });
  return result;
}

export async function verifyBackup(fromDir: string): Promise<VerifyResult> {
  const root = physical(fromDir);
  const manifest = readManifest(root);
  const key =
    manifest.encrypted && process.env.CANDEF_BACKUP_PASSPHRASE !== undefined
      ? keyMaterial(root, false).key
      : undefined;
  const result: VerifyResult = {
    files: manifest.files.length,
    ok: true,
    missing: [],
    corrupt: [],
    decrypted: !!key,
  };
  for (const f of manifest.files) {
    try {
      const file = safeFile(root, f.stored);
      if (!existsSync(file)) {
        result.missing.push(f.path);
        continue;
      }
      const stored = await hashFile(file);
      if (stored.sha256 !== f.storedSha256) throw new Error();
      if (key) {
        const plain = await decryptHash(file, f.path, key);
        if (plain.sha256 !== f.sha256 || plain.bytes !== f.bytes) throw new Error();
      } else if (!manifest.encrypted && (stored.sha256 !== f.sha256 || stored.bytes !== f.bytes))
        throw new Error();
    } catch {
      result.corrupt.push(f.path);
    }
  }
  result.ok = !result.missing.length && !result.corrupt.length;
  return result;
}

export async function restoreCache(
  fromDir: string,
  toDir: string,
  repoRoot: string,
): Promise<RestoreResult> {
  const root = physical(fromDir);
  const target = physical(toDir);
  const repo = physical(repoRoot);
  // The exception must be the actual named research-cache, not another path resolving through a link.
  const ownCache = resolve(repoRoot, "research-cache");
  if (
    inside(target, repo) &&
    (resolve(toDir) !== ownCache || target !== resolve(repo, "research-cache"))
  )
    throw new AuthoringError(
      "restore must be outside the repository, except its empty research-cache",
    );
  if (inside(target, root) || inside(root, target))
    throw new AuthoringError("restore must not overlap the backup");
  if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length))
    throw new AuthoringError("restore destination must be empty or missing");
  const manifest = readManifest(root);
  const key = manifest.encrypted ? keyMaterial(root, false).key : undefined;
  // Preflight all output paths before creating anything.
  for (const f of manifest.files) safeFile(target, f.path);
  mkdirSync(target, { recursive: true });
  const result: RestoreResult = { restored: 0, failed: [] };
  for (const f of manifest.files) {
    const dest = safeFile(target, f.path);
    const tmp = tempFile(dest);
    try {
      const src = safeFile(root, f.stored);
      if ((await hashFile(src)).sha256 !== f.storedSha256) throw new Error();
      mkdirSync(dirname(dest), { recursive: true });
      if (key) {
        const { decipher, size } = decipherFor(src, f.path, key);
        await pipeline(
          size === 36 ? Readable.from([]) : createReadStream(src, { start: 20, end: size - 17 }),
          decipher,
          createWriteStream(tmp, { flags: "wx" }),
        );
      } else {
        await pipeline(createReadStream(src), createWriteStream(tmp, { flags: "wx" }));
      }
      const plain = await hashFile(tmp);
      if (plain.sha256 !== f.sha256 || plain.bytes !== f.bytes || existsSync(dest))
        throw new Error();
      renameSync(tmp, dest);
      result.restored++;
    } catch {
      result.failed.push(f.path);
    } finally {
      removeTemp(tmp);
    }
  }
  return result;
}
