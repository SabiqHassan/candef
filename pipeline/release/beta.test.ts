import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Assertion, Corpus } from "../../src/domain/schema/corpus";
import type { Snapshot, SnapshotManifest } from "../../src/domain/schema/snapshot";
import { compile } from "../compile/compile";
import { reviewHashFor } from "../compile/hash";
import { auditBeta, prepareBeta } from "./beta";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
}

function snapshot(builtAt = "2026-10-13T12:00:00Z") {
  return {
    meta: {
      schemaVersion: "0.6.0",
      snapshotVersion: "test",
      builtAt,
      isDemo: false as boolean,
      contentHash: "test",
      thresholdCad: 100000,
    } satisfies Snapshot["meta"],
    organizations: [] as Record<string, unknown>[],
    rounds: [] as Record<string, unknown>[],
    agreements: [] as Record<string, unknown>[],
    acquisitions: [] as Record<string, unknown>[],
    assertions: {} as Record<string, unknown>,
    sources: {} as Record<string, unknown>,
  };
}

function fixture(previous: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "candef-beta-"));
  roots.push(root);
  const dist = join(root, "dist");
  const researchDir = join(root, "research");
  const data = join(dist, "data", "research");
  const manifest: SnapshotManifest = {
    current: "snapshot.current.json",
    previous,
    isDemo: false,
    schemaVersion: "0.6.0",
    builtAt: "2026-10-13T12:00:00Z",
  };
  write(join(data, "manifest.json"), manifest);
  write(join(data, manifest.current), snapshot());
  for (const file of previous) write(join(data, file), snapshot());
  write(
    join(dist, "index.html"),
    '<html><head><script type="module" src="/assets/app.js"></script></head><body></body></html>',
  );
  write(join(dist, "assets", "app.js"), "console.log('beta');");
  mkdirSync(researchDir, { recursive: true });
  return { root, dist, data, researchDir, manifest, options: { researchDir } };
}

function takedowns(researchDir: string) {
  write(
    join(researchDir, "takedowns.yaml"),
    JSON.stringify([
      {
        date: "2026-10-12",
        ids: ["assertion_removed"],
        reason: "Synthetic correction",
        by: "owner",
      },
      { date: "2026-10-11", ids: ["other_removed"], reason: "Earlier correction", by: "owner" },
    ]),
  );
}

function tree(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(dir.length + 1).replaceAll("\\", "/"), readFileSync(path, "utf8")];
      }),
  );
}

describe("prepareBeta", () => {
  it("keeps current and ordered valid rollbacks, removes every other research file", () => {
    const f = fixture(["snapshot.second.json", "snapshot.first.json"]);
    write(join(f.data, "metrics.json"), {});
    write(join(f.data, "snapshot.stale.json"), snapshot());
    write(join(f.data, "nested", "internal.txt"), "internal");
    const result = prepareBeta(f.dist, f.options);
    expect(readdirSync(f.data).sort()).toEqual([
      "manifest.json",
      "snapshot.current.json",
      "snapshot.first.json",
      "snapshot.second.json",
    ]);
    expect(JSON.parse(readFileSync(join(f.data, "manifest.json"), "utf8")).previous).toEqual([
      "snapshot.second.json",
      "snapshot.first.json",
    ]);
    expect(result.kept).toEqual([
      "data/research/manifest.json",
      "data/research/snapshot.current.json",
      "data/research/snapshot.second.json",
      "data/research/snapshot.first.json",
    ]);
    expect(result.removed).toEqual([
      "data/research/metrics.json",
      "data/research/nested/internal.txt",
      "data/research/snapshot.stale.json",
    ]);
    expect(result.droppedRollbacks).toEqual([]);
    expect(readFileSync(join(f.dist, "robots.txt"), "utf8")).toBe("User-agent: *\nDisallow: /\n");
    expect(readFileSync(join(f.dist, "_headers"), "utf8")).toBe(
      "/*\n  X-Robots-Tag: noindex, nofollow\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'\n",
    );
  });

  it("drops retracted and pre-takedown rollbacks with reasons, retaining the date boundary", () => {
    const f = fixture(["snapshot.id.json", "snapshot.old.json", "snapshot.equal.json"]);
    takedowns(f.researchDir);
    write(join(f.data, "snapshot.id.json"), {
      ...snapshot(),
      assertions: { assertion_removed: {} },
    });
    write(join(f.data, "snapshot.old.json"), snapshot("2026-10-11T23:59:59Z"));
    write(join(f.data, "snapshot.equal.json"), snapshot("2026-10-12T00:00:00Z"));
    const result = prepareBeta(f.dist, f.options);
    expect(result.droppedRollbacks).toEqual([
      { file: "snapshot.id.json", reasons: [expect.stringContaining("assertion_removed")] },
      { file: "snapshot.old.json", reasons: [expect.stringContaining("2026-10-12")] },
    ]);
    expect(JSON.parse(readFileSync(join(f.data, "manifest.json"), "utf8")).previous).toEqual([
      "snapshot.equal.json",
    ]);
    expect(existsSync(join(f.data, "snapshot.id.json"))).toBe(false);
    expect(existsSync(join(f.data, "snapshot.old.json"))).toBe(false);
  });

  it("refuses a retracted current snapshot before modifying any file", () => {
    const f = fixture();
    takedowns(f.researchDir);
    write(join(f.data, f.manifest.current), {
      ...snapshot(),
      rounds: [{ id: "assertion_removed" }],
    });
    write(join(f.data, "metrics.json"), {});
    const before = tree(f.dist);
    expect(() => prepareBeta(f.dist, f.options)).toThrow(/current.*assertion_removed/i);
    expect(tree(f.dist)).toEqual(before);
  });

  it.each(["manifest", "demo manifest", "demo folder"])("refuses %s", (kind) => {
    const f = fixture();
    if (kind === "manifest") rmSync(join(f.data, "manifest.json"));
    if (kind === "demo manifest")
      write(join(f.data, "manifest.json"), { ...f.manifest, isDemo: true });
    if (kind === "demo folder") mkdirSync(join(f.dist, "data", "demo"));
    const before = tree(f.dist);
    expect(() => prepareBeta(f.dist, f.options)).toThrow(/manifest|demo/i);
    expect(tree(f.dist)).toEqual(before);
  });

  it.each([
    '<script>alert("inline")</script>',
    '<SCRIPT type="module">console.log("inline")</SCRIPT>',
    '<script src="">console.log("inline")</script>',
  ])("refuses inline scripts without weakening the CSP: %s", (script) => {
    const f = fixture();
    write(join(f.dist, "index.html"), `<html><head>${script}</head></html>`);
    const before = tree(f.dist);
    expect(() => prepareBeta(f.dist, f.options)).toThrow(
      /script-src 'self'.*inline|inline.*script-src 'self'/i,
    );
    expect(tree(f.dist)).toEqual(before);
  });

  it("is idempotent and inserts the robots meta tag only once", () => {
    const f = fixture();
    write(join(f.data, "metrics.json"), {});
    const first = prepareBeta(f.dist, f.options);
    const before = tree(f.dist);
    const second = prepareBeta(f.dist, f.options);
    expect(tree(f.dist)).toEqual(before);
    expect(second.kept).toEqual(first.kept);
    expect(second.removed).toEqual([]);
    expect(second.droppedRollbacks).toEqual([]);
    expect(readFileSync(join(f.dist, "index.html"), "utf8").match(/name="robots"/g)).toHaveLength(
      1,
    );
  });

  it("hardens an existing permissive robots tag and handles HTML attribute variations", () => {
    const f = fixture();
    write(
      join(f.dist, "index.html"),
      "<HTML><HEAD><META content='index, follow' NAME='ROBOTS'><!-- <script>comment</script> --><script data-note='src=fake' src='/app.js'></script></HEAD></HTML>",
    );
    prepareBeta(f.dist, f.options);
    expect(auditBeta(f.dist, f.options)).toEqual({ ok: true, problems: [] });
    expect(readFileSync(join(f.dist, "index.html"), "utf8")).not.toContain("index, follow");
  });

  it("inserts robots metadata in the head even if another tag exists in the body", () => {
    const f = fixture();
    write(
      join(f.dist, "index.html"),
      '<!-- before head --><html><head></head><body><meta name="robots" content="noindex, nofollow"></body></html>',
    );
    prepareBeta(f.dist, f.options);
    expect(readFileSync(join(f.dist, "index.html"), "utf8")).toMatch(
      /<head>\s*<meta name="robots" content="noindex, nofollow">\s*<\/head>/,
    );
  });

  it("refuses directory links without pruning their external target", () => {
    const f = fixture();
    const external = join(f.root, "external");
    write(join(external, "private.txt"), "leave alone");
    symlinkSync(external, join(f.data, "linked"), "junction");
    expect(() => prepareBeta(f.dist, f.options)).toThrow(/symbolic link/i);
    expect(readFileSync(join(external, "private.txt"), "utf8")).toBe("leave alone");
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(/symbolic link/i);
  });

  it.each(["../outside.json", "..\\outside.json", "/outside.json"])(
    "refuses unsafe manifest paths: %s",
    (current) => {
      const f = fixture();
      write(join(f.data, "manifest.json"), { ...f.manifest, current });
      expect(() => prepareBeta(f.dist, f.options)).toThrow(/snapshot.*(name|path)|unsafe/i);
    },
  );
});

describe("auditBeta", () => {
  function ready() {
    const f = fixture(["snapshot.previous.json"]);
    prepareBeta(f.dist, f.options);
    return f;
  }

  it("accepts a clean beta and never modifies the files", () => {
    const f = ready();
    const before = tree(f.dist);
    expect(auditBeta(f.dist, f.options)).toEqual({ ok: true, problems: [] });
    expect(tree(f.dist)).toEqual(before);
  });

  it("detects demo data paths, including empty directories", () => {
    const f = ready();
    mkdirSync(join(f.dist, "data", "demo"));
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(/data\/demo/);
  });

  it("detects the synthetic stress dataset path", () => {
    const f = ready();
    mkdirSync(join(f.dist, "data", "stress"));
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(/data\/stress/);
  });

  it("detects unreferenced research files", () => {
    const f = ready();
    write(join(f.data, "snapshot.stale.json"), snapshot());
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(
      /unexpected.*snapshot.stale.json/i,
    );
  });

  it("also audits the contents of unreferenced snapshots", () => {
    const f = ready();
    write(join(f.data, "snapshot.stale.json"), {
      ...snapshot(),
      rounds: [{ verification: "proposed" }],
    });
    const problems = auditBeta(f.dist, f.options).problems.join("\n");
    expect(problems).toMatch(/unexpected.*snapshot.stale.json/i);
    expect(problems).toContain("snapshot.stale.json: $.rounds[0].verification");
  });

  it("detects demo snapshot metadata in rollback snapshots", () => {
    const f = ready();
    const snap = snapshot();
    snap.meta.isDemo = true;
    write(join(f.data, "snapshot.previous.json"), snap);
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(
      /snapshot.previous.json.*meta.isDemo/,
    );
  });

  it("detects demo organizations", () => {
    const f = ready();
    write(join(f.data, f.manifest.current), {
      ...snapshot(),
      organizations: [{ id: "org_test", isDemo: true }],
    });
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(/organizations\[0\].isDemo/);
  });

  it("detects example.invalid URLs", () => {
    const f = ready();
    write(join(f.data, f.manifest.current), {
      ...snapshot(),
      sources: { test: { url: "https://example.invalid/test" } },
    });
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(/example.invalid/);
  });

  it.each(["person@example.org", "+1 (613) 555-0123", "613.555.0123"])(
    "detects contact data: %s",
    (name) => {
      const f = ready();
      write(join(f.data, f.manifest.current), { ...snapshot(), organizations: [{ name }] });
      expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(/email|phone/i);
    },
  );

  it("allows only the owner-authorized corrections address (P-33)", () => {
    const f = ready();
    const methodology = { contact: "Corrections: SabiqHassan1234@gmail.com" };
    write(join(f.data, f.manifest.current), { ...snapshot(), methodology });
    expect(auditBeta(f.dist, f.options).problems.join(" | ")).not.toMatch(/email/i);
    // Any other address beside it is still reported.
    write(join(f.data, f.manifest.current), {
      ...snapshot(),
      methodology: { contact: "sabiqhassan1234@gmail.com or person@example.org" },
    });
    expect(auditBeta(f.dist, f.options).problems.join(" | ")).toMatch(/email/i);
  });

  it("detects contact data in JSON object keys too", () => {
    const f = ready();
    write(join(f.data, f.manifest.current), {
      ...snapshot(),
      sources: { "person@example.org": {}, "613-555-0123": {} },
    });
    const problems = auditBeta(f.dist, f.options).problems.join("\n");
    expect(problems).toMatch(/email/i);
    expect(problems).toMatch(/phone/i);
  });

  it("detects retracted record IDs in any snapshot without matching ID prefixes", () => {
    const f = ready();
    takedowns(f.researchDir);
    write(join(f.data, f.manifest.current), {
      ...snapshot(),
      assertions: { assertion_removed_new: {} },
    });
    expect(auditBeta(f.dist, f.options).ok).toBe(true);
    write(join(f.data, "snapshot.previous.json"), {
      ...snapshot(),
      assertions: { assertion_removed: {} },
    });
    const before = tree(f.dist);
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(
      /snapshot.previous.json.*assertion_removed/,
    );
    expect(tree(f.dist)).toEqual(before);
  });

  it("detects snapshots older than the latest takedown", () => {
    const f = ready();
    takedowns(f.researchDir);
    write(join(f.data, "snapshot.previous.json"), snapshot("2026-10-11T00:00:00Z"));
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(
      /snapshot.previous.json.*2026-10-12/,
    );
  });

  it.each(["proposed", "rejected", "retracted", "superseded"])(
    "detects unpublished record states with their JSON path: %s",
    (state) => {
      const f = ready();
      write(join(f.data, f.manifest.current), {
        ...snapshot(),
        rounds: [{ id: "round_test", verification: state }],
        assertions: { test: { id: "assertion_test", state } },
      });
      const problems = auditBeta(f.dist, f.options).problems.join("\n");
      expect(problems).toContain("$.rounds[0].verification");
      expect(problems).toContain('$.assertions["test"].state');
      expect(problems).toContain(state);
    },
  );

  it("allows historical supersession and the real read-model field states", () => {
    const f = ready();
    write(join(f.data, f.manifest.current), {
      ...snapshot(),
      organizations: [
        {
          id: "org_test",
          isDemo: false,
          legalName: {
            state: "verified",
            value: "Testco",
            history: [{ state: "superseded", verification: "superseded", value: "Old Testco" }],
          },
          description: { state: "unconfirmed", value: null },
          research: { financing: { state: "not_researched" } },
        },
      ],
    });
    expect(auditBeta(f.dist, f.options)).toEqual({ ok: true, problems: [] });
  });

  it("allows superseded assertion evidence only when referenced exclusively by history", () => {
    const f = ready();
    const snap = snapshot();
    snap.organizations.push({
      id: "org_test",
      isDemo: false,
      legalName: {
        state: "verified",
        assertionIds: ["current"],
        history: [{ assertionIds: ["old"] }],
      },
    });
    snap.assertions = {
      current: { id: "current", verification: "verified" },
      old: { id: "old", verification: "superseded" },
    };
    write(join(f.data, f.manifest.current), snap);
    expect(auditBeta(f.dist, f.options)).toEqual({ ok: true, problems: [] });
    snap.rounds.push({ id: "round_test", assertionIds: ["old"] });
    write(join(f.data, f.manifest.current), snap);
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toContain(
      '$.assertions["old"].verification',
    );
  });

  it.each([
    "research-cache/private.txt",
    "research/source.yaml",
    ".env.production",
    "nested/metrics.json",
    "assets/app.js.map",
    "captures/page.txt",
  ])("detects files that must never ship: %s", (file) => {
    const f = ready();
    write(join(f.dist, file), "internal");
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toContain(file);
    expect(auditBeta(f.dist, f.options).ok).toBe(false);
  });

  it.each(["robots.txt", "_headers", "meta"])("detects missing hardening: %s", (file) => {
    const f = ready();
    if (file === "meta") write(join(f.dist, "index.html"), "<html><head></head></html>");
    else rmSync(join(f.dist, file));
    expect(auditBeta(f.dist, f.options).problems.join("\n")).toMatch(/robots|_headers/);
  });

  it.each(["missing snapshot", "invalid snapshot", "invalid manifest", "missing manifest"])(
    "reports unreadable data rather than throwing: %s",
    (kind) => {
      const f = ready();
      if (kind === "missing snapshot") rmSync(join(f.data, f.manifest.current));
      if (kind === "invalid snapshot") write(join(f.data, f.manifest.current), "{");
      if (kind === "invalid manifest") write(join(f.data, "manifest.json"), {});
      if (kind === "missing manifest") rmSync(join(f.data, "manifest.json"));
      const before = tree(f.dist);
      const result = auditBeta(f.dist, f.options);
      expect(result.ok).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(tree(f.dist)).toEqual(before);
    },
  );
});

it("prepares and audits real compiler output from a reviewed synthetic non-demo corpus", () => {
  const f = fixture();
  const corpus: Corpus = {
    schemaVersion: "0.3",
    isDemo: false,
    taxonomy: [{ id: "tax:cyber", parentId: null, label: "Cybersecurity", definition: "" }],
    sources: [
      {
        id: "src_test",
        kind: "company_release",
        tier: "T2",
        publisher: "Testco",
        title: "About Testco",
        url: "https://example.org/testco/about",
        publishedOn: "2026-01",
        retrievedAt: "2026-10-13T00:00:00Z",
        originGroup: "og:testco",
        textSha256: null,
        sourceBasis: "named",
      },
    ],
    organizations: [
      {
        id: "org_testco",
        kind: "company",
        slug: "testco",
        name: "Testco",
        mergedInto: null,
        isDemo: false,
      },
    ],
    assertions: [],
    rounds: [],
    agreements: [],
    acquisitions: [],
    programs: [],
    research: [],
  };
  const reviewed = (
    id: string,
    predicate: Assertion["predicate"],
    value: unknown,
    supersedes: string | null = null,
  ): Assertion => {
    const assertion: Assertion = {
      id,
      subjectId: "org_testco",
      predicate,
      value,
      primary: true,
      validFrom: null,
      validTo: null,
      asOf: "2026-10-13",
      supersedes,
      epistemic:
        predicate === "eligibility" || predicate === "classified_as"
          ? "analyst_interpretation"
          : "sourced_fact",
      verification: "verified",
      evidence: [{ sourceId: "src_test", locator: "about page", locatorQuality: "body" }],
      review: null,
      createdBy: "test",
    };
    return {
      ...assertion,
      review: { by: "owner", at: "2026-10-13", hash: reviewHashFor("assertion", assertion) },
    };
  };
  corpus.assertions.push(
    { ...reviewed("old_name", "legal_name", "Earlier Testco"), verification: "superseded" },
    reviewed("name", "legal_name", "Testco Inc.", "old_name"),
    reviewed("hq", "hq_location", { city: "Ottawa", region: null, province: "ON", country: "CA" }),
    reviewed("segment", "classified_as", "tax:cyber"),
    reviewed("eligibility", "eligibility", {
      decision: "included",
      rationale: "Documented security work.",
    }),
  );
  const result = compile(corpus, { today: "2026-10-13" });
  expect(result.failures).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.snapshot?.coverage.inUniverse).toBe(1);
  expect(result.snapshot?.organizations[0]?.legalName.history).toHaveLength(1);
  write(join(f.data, f.manifest.current), result.snapshot);
  prepareBeta(f.dist, f.options);
  expect(auditBeta(f.dist, f.options)).toEqual({ ok: true, problems: [] });
});

describe("beta CLI", () => {
  function cli(dist: string, researchDir: string, extra: string[] = []) {
    return spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        resolve("pipeline/release/beta.ts"),
        "--dist",
        dist,
        "--research",
        researchDir,
        ...extra,
      ],
      { encoding: "utf8", timeout: 20000 },
    );
  }

  it("prepares, audits and explicitly reports no deployment", () => {
    const f = fixture();
    const result = cli(f.dist, f.researchDir);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/audit.*pass|audit.*ok/i);
    expect(result.stdout).toMatch(/no.*upload.*deploy|never.*upload.*deploy/i);
    expect(auditBeta(f.dist, f.options).ok).toBe(true);
  });

  it("exits 1 and reports audit problems", () => {
    const f = fixture();
    write(join(f.dist, "assets/app.js.map"), "internal");
    const result = cli(f.dist, f.researchDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("assets/app.js.map");
    expect(result.stdout).toMatch(/no.*upload.*deploy|never.*upload.*deploy/i);
  });

  it("refuses to prepare a beta that contains the synthetic stress dataset", () => {
    const f = fixture();
    mkdirSync(join(f.dist, "data/stress"));
    expect(() => prepareBeta(f.dist, f.options)).toThrow(/data\/stress/);
  });

  it("exits 1 on a preparation refusal", () => {
    const f = fixture();
    mkdirSync(join(f.dist, "data/demo"));
    const result = cli(f.dist, f.researchDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/demo/i);
  });

  it("rejects unsupported arguments", () => {
    const f = fixture();
    expect(cli(f.dist, f.researchDir, ["--upload"]).status).toBe(1);
  });
});
