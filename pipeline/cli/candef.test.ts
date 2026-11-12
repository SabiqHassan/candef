/** The candef CLI as a real child process, on temporary synthetic research trees. */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
};
const candef = (...args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", "pipeline/cli/candef.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, CANDEF_AUTHOR: "agent:test" },
    stdio: ["pipe", "pipe", "pipe"],
  });

describe("candef CLI", () => {
  it("new → ledger → validate on a fresh research tree", () => {
    const dir = temp("candef-cli-");
    expect(candef("new", "company", "Fictional Delta Systems", "--dir", dir).status).toBe(0);
    const ledger = candef(
      "ledger",
      "fictional-delta-systems",
      "financing",
      "none_found",
      "--searched",
      "company site; BetaKit",
      "--next",
      "2027-04",
      "--at",
      "2026-10-13",
      "--dir",
      dir,
    );
    expect(ledger.status).toBe(0);
    const v = candef("validate", "--dir", dir);
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(
      /1 organizations · 0 proposed records · 0 companies would be published/,
    );
    expect(
      candef("new", "company", "FICTIONAL DELTA SYSTEMS INC.", "--slug", "x", "--dir", dir).status,
    ).toBe(1);
  }, 20000);

  it("validate fails on an invalid file and names it", () => {
    const dir = temp("candef-cli-");
    candef("new", "company", "Fictional Echo", "--dir", dir);
    writeFileSync(join(dir, "orgs", "broken.yaml"), "org: { id: x }\n");
    const v = candef("validate", "--dir", dir);
    expect(v.status).toBe(1);
    expect(v.stderr).toMatch(/orgs\/broken\.yaml:org\./);
  });

  it("review refuses without an interactive terminal and changes nothing", () => {
    const dir = temp("candef-cli-");
    candef("new", "company", "Fictional Foxtrot", "--dir", dir);
    const file = join(dir, "orgs", "fictional-foxtrot.yaml");
    const before = readFileSync(file, "utf8");
    const r = candef("review", "anything", "--dir", dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/owner-only/);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("report lists proposed records with their IDs and escapes values", () => {
    const dir = temp("candef-cli-");
    const cache = temp("candef-cache-");
    candef("new", "company", "Fictional Golf", "--dir", dir);
    candef(
      "source",
      "add",
      "https://example.org/fictional-golf",
      "--kind",
      "company_release",
      "--tier",
      "T2",
      "--publisher",
      "Fictional Golf",
      "--title",
      "About",
      "--dir",
      dir,
    );
    const src = readFileSync(join(dir, "orgs", "fictional-golf.yaml"), "utf8");
    const sourceId = readdirSync(join(dir, "sources"))[0]!.replace(".yaml", "");
    writeFileSync(
      join(dir, "orgs", "fictional-golf.yaml"),
      src.replace(
        "facts: []",
        `facts:\n  - { id: a_desc, predicate: description, value: "<script>alert(1)</script> drones", src: ["${sourceId}#about"] }`,
      ),
    );
    const out = join(cache, "r.html");
    expect(candef("report", "--dir", dir, "--cache", cache, "--out", out).status).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).toContain("a_desc");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toMatch(/Nothing on this page is approved/);
    expect(html).toMatch(/no capture/);
  });
});

describe("candef status", () => {
  it("shows each company's research progress", () => {
    const dir = temp("candef-cli-");
    candef("new", "company", "Fictional Juliet", "--dir", dir);
    candef(
      "ledger",
      "fictional-juliet",
      "financing",
      "none_found",
      "--searched",
      "site",
      "--at",
      "2026-10-13",
      "--next",
      "2099-01",
      "--dir",
      dir,
    );
    const out = candef("status", "--dir", dir);
    expect(out.status).toBe(0);
    const line = out.stdout.split("\n").find((l) => l.startsWith("Fictional Juliet"))!;
    expect(line).toMatch(/Fictional Juliet\s+—\s+—\s+none\s+—\s+—\s+0\s+no/);
  });
});

describe("candef private backup commands", () => {
  const secret = "fictional-cli-backup-passphrase";
  const backupCli = (passphrase: string | undefined, ...args: string[]) => {
    const env = { ...process.env };
    if (passphrase === undefined) delete env.CANDEF_BACKUP_PASSPHRASE;
    else env.CANDEF_BACKUP_PASSPHRASE = passphrase;
    return spawnSync(process.execPath, ["--import", "tsx", "pipeline/cli/candef.ts", ...args], {
      encoding: "utf8",
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
  const fixture = () => {
    const cache = temp("candef-cli-cache-");
    const target = temp("candef-cli-backup-");
    writeFileSync(join(cache, "report.txt"), "fictional source marker");
    return { cache, target };
  };

  it("backs up with a boolean flag in any order, repeats exclusions, verifies, and restores without exposing the secret", () => {
    const { cache, target } = fixture();
    mkdirSync(join(cache, "gov-data"));
    writeFileSync(join(cache, "gov-data", "fictional.csv"), "fictional dataset");
    writeFileSync(join(cache, "skip.txt"), "fictional excluded report");
    const backup = backupCli(
      secret,
      "backup",
      "--encrypt",
      "--cache",
      cache,
      "--exclude",
      "gov-data/",
      "--to",
      target,
      "--exclude",
      "skip",
    );
    expect(backup.status).toBe(0);
    expect(backup.stdout).toMatch(/1 files: 1 copied \(verified\), 0 unchanged, 2 excluded/);
    const storedOnly = backupCli(undefined, "backup-verify", "--from", target);
    expect(storedOnly.status).toBe(0);
    expect(JSON.parse(storedOnly.stdout)).toMatchObject({ ok: true, decrypted: false });
    const full = backupCli(secret, "backup-verify", "--from", target);
    expect(full.status).toBe(0);
    expect(JSON.parse(full.stdout)).toMatchObject({ ok: true, decrypted: true });
    const restored = temp("candef-cli-restored-");
    const restore = backupCli(secret, "restore", "--from", target, "--to", restored);
    expect(restore.status).toBe(0);
    expect(JSON.parse(restore.stdout)).toEqual({ restored: 1, failed: [] });
    expect(readFileSync(join(restored, "report.txt"), "utf8")).toBe("fictional source marker");
    expect(readdirSync(restored)).toEqual(["report.txt"]);
    for (const r of [backup, storedOnly, full, restore])
      expect(r.stdout + r.stderr).not.toContain(secret);
    for (const name of ["manifest.json", "backup-key.json"])
      expect(readFileSync(join(target, name), "utf8")).not.toContain(secret);
  }, 20000);

  it("refuses absent, short, or wrong passphrases without writing, and never accepts a secret flag", () => {
    const { cache, target } = fixture();
    for (const value of [undefined, "short"]) {
      const r = backupCli(value, "backup", "--cache", cache, "--to", target, "--encrypt");
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/CANDEF_BACKUP_PASSPHRASE.*16/);
      expect(readdirSync(target)).toEqual([]);
    }
    const flag = backupCli(
      undefined,
      "backup",
      "--cache",
      cache,
      "--to",
      target,
      "--encrypt",
      "--passphrase",
      secret,
    );
    expect(flag.status).toBe(1);
    expect(flag.stdout + flag.stderr).not.toContain(secret);
    expect(backupCli(secret, "backup", "--cache", cache, "--to", target, "--encrypt").status).toBe(
      0,
    );
    const before = readFileSync(join(target, "manifest.json"), "utf8");
    const wrong = backupCli(
      "fictional-wrong-passphrase",
      "backup",
      "--encrypt",
      "--cache",
      cache,
      "--to",
      target,
    );
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/wrong backup passphrase/);
    expect(wrong.stdout + wrong.stderr).not.toContain("fictional-wrong-passphrase");
    expect(readFileSync(join(target, "manifest.json"), "utf8")).toBe(before);
    const restored = join(temp("candef-cli-restore-parent-"), "not-created");
    expect(backupCli(undefined, "restore", "--from", target, "--to", restored).status).toBe(1);
    expect(existsSync(restored)).toBe(false);
  }, 20000);

  it("exits 1 on corrupt/missing stored files and failed restores with no partial plaintext", () => {
    const { cache, target } = fixture();
    expect(backupCli(secret, "backup", "--cache", cache, "--to", target, "--encrypt").status).toBe(
      0,
    );
    const file = join(target, "report.txt.enc");
    const bytes = readFileSync(file);
    bytes[20] = bytes[20]! ^ 1;
    writeFileSync(file, bytes);
    const verify = backupCli(undefined, "backup-verify", "--from", target);
    expect(verify.status).toBe(1);
    expect(JSON.parse(verify.stdout)).toMatchObject({ ok: false, corrupt: ["report.txt"] });
    const restored = temp("candef-cli-restore-");
    const restore = backupCli(secret, "restore", "--from", target, "--to", restored);
    expect(restore.status).toBe(1);
    expect(JSON.parse(restore.stdout)).toEqual({ restored: 0, failed: ["report.txt"] });
    expect(readdirSync(restored)).toEqual([]);
    rmSync(file);
    const missing = backupCli(undefined, "backup-verify", "--from", target);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ missing: ["report.txt"] });
  }, 20000);

  it("reports retained previous encrypted files and refuses a nonempty restore target", () => {
    const { cache, target } = fixture();
    expect(backupCli(secret, "backup", "--cache", cache, "--to", target, "--encrypt").status).toBe(
      0,
    );
    writeFileSync(join(cache, "report.txt"), "changed fictional content");
    const changed = backupCli(secret, "backup", "--cache", cache, "--to", target, "--encrypt");
    expect(changed.status).toBe(0);
    expect(changed.stdout).toMatch(
      /previous encrypted files kept: report.txt.enc.prev-[0-9a-f]{8}/,
    );
    const out = temp("candef-cli-nonempty-");
    writeFileSync(join(out, "existing.txt"), "fictional existing file");
    const restore = backupCli(secret, "restore", "--from", target, "--to", out);
    expect(restore.status).toBe(1);
    expect(restore.stderr).toMatch(/empty or missing/);
    expect(readdirSync(out)).toEqual(["existing.txt"]);
  }, 20000);

  it("preserves plain CLI behavior and requires command-specific values", () => {
    const { cache, target } = fixture();
    const backup = backupCli(undefined, "backup", "--cache", cache, "--to", target);
    expect(backup.status).toBe(0);
    expect(readFileSync(join(target, "report.txt"), "utf8")).toBe("fictional source marker");
    for (const args of [
      ["backup-verify"],
      ["restore", "--from", target],
      ["backup", "--to"],
      ["backup", "--exclude", "--to", target],
    ]) {
      const r = backupCli(undefined, ...args);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/required|requires a value/);
    }
  }, 20000);
});
