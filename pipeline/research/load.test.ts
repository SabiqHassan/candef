import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../compile/compile";
import { loadResearchCorpus, loadResearchCorpusUncached } from "./load";

/** Builds a temporary research/ tree. Content is fictional and never committed. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "candef-research-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  roots.push(root);
  return root;
}
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const TAXONOMY = `
- { id: "tax:cyber", parentId: null, label: Cybersecurity, definition: "" }
- { id: "tax:cyber.1", parentId: "tax:cyber", label: Identity, definition: "" }
`;
const SOURCE = `
kind: company_release
tier: T2
publisher: Fictional Alpha Security
title: Fictional seed announcement
url: https://example.org/fictional-alpha-seed
publishedOn: "2024-03"
retrievedAt: "2026-10-13T00:00:00Z"
originGroup: og:alpha-seed
textSha256: null
`;
const ORG = `
org: { id: org_01FICTIONALALPHA0000000000, kind: company, slug: fictional-alpha, name: Fictional Alpha Security }
defaults: { createdBy: "agent:test" }
facts:
  - predicate: legal_name
    value: Fictional Alpha Security Inc.
    src: ["src_alpha_seed#paragraph 1"]
  - predicate: founded_year
    value: 2019
    src: ["src_alpha_seed#about"]
    verification: verified
    review: { by: owner, at: "2026-10-13", hash: "not-a-real-hash" }
rounds:
  - id: fin_alpha_seed
    eventState: announced
    roundLabelAsStated: Seed
    stage: seed
    instrument: equity
    proceeds: primary
    participantsCompleteness: partial_named
    src: ["src_alpha_seed#paragraph 2"]
    review: { by: owner, at: "2026-10-13", hash: "round-only" }
    disclosures:
      - { date: "2024-03", kind: single, amountBasis: cumulative_round_total,
          amount: { amount: 2500000, currency: CAD, disclosure: disclosed, asStated: "$2.5 million" } }
    participations:
      - { reportedName: Fictional Fund One, investorId: org_01FICTIONALFUND00000000000, role: lead }
research:
  - { topic: financing, sourcesSearched: [company site], outcome: found, by: "agent:test", at: "2026-10-13", nextReview: "2027-04" }
`;

describe("research loader (authoring YAML → canonical corpus)", () => {
  it("validates compact predecessor events", () => {
    const files = {
      "taxonomy.yaml": TAXONOMY,
      "sources/src_alpha_seed.yaml": SOURCE,
      "orgs/fictional-alpha.yaml": ORG + "\nfacts: []",
    };
    files["orgs/fictional-alpha.yaml"] = ORG.replace(
      "predicate: founded_year\n    value: 2019",
      'predicate: predecessor_of\n    value: { orgId: org_fictional_successor, event: amalgamation, date: "2014" }',
    );
    expect(loadResearchCorpus(tree(files)).issues).toEqual([]);
    files["orgs/fictional-alpha.yaml"] = files["orgs/fictional-alpha.yaml"].replace(
      "event: amalgamation",
      "event: guessed",
    );
    expect(loadResearchCorpus(tree(files)).issues.some((i) => i.path.includes("facts.1"))).toBe(
      true,
    );
  });
  it("expands shorthand, applies defaults and derives IDs", () => {
    const root = tree({
      "taxonomy.yaml": TAXONOMY,
      "sources/src_alpha_seed.yaml": SOURCE,
      "orgs/fictional-alpha.yaml": ORG,
    });
    const { corpus, issues, files } = loadResearchCorpus(root);
    expect(issues).toEqual([]);
    expect(files).toBe(3);
    const c = corpus!;
    expect(c.isDemo).toBe(false);
    expect(c.sources[0]!.id).toBe("src_alpha_seed");
    const legal = c.assertions.find((a) => a.predicate === "legal_name")!;
    expect(legal.subjectId).toBe("org_01FICTIONALALPHA0000000000");
    expect(legal.verification).toBe("proposed");
    expect(legal.evidence).toEqual([
      { sourceId: "src_alpha_seed", locator: "paragraph 1", locatorQuality: "body" },
    ]);
    expect(legal.id).toMatch(/^asr_[0-9a-f]{16}$/);
    const round = c.rounds[0]!;
    expect(round.companyId).toBe("org_01FICTIONALALPHA0000000000");
    expect(round.disclosures[0]!.id).toBe("fin_alpha_seed_d1");
    expect(round.disclosures[0]!.amount.amount).toBe("2500000");
    expect(round.disclosures[0]!.evidence[0]!.sourceId).toBe("src_alpha_seed");
    expect(c.research[0]!.id).toMatch(/^rsh_/);
  });

  it("accepts the M3 optional fields: source permissions, captures and registry IDs", () => {
    const root = tree({
      "sources/src_alpha_seed.yaml": `${SOURCE}
permissions: { capture: allowed, attributionRequired: true, basis: "Fictional terms page" }
captures:
  - { id: cap_1, retrievedAt: "2026-10-13T00:00:00Z", method: http, rawSha256: abc, textSha256: def, path: captures/cap_1.html }
`,
      "orgs/a.yaml": `
org: { id: org_01FICTIONALALPHA0000000000, kind: company, slug: a, name: Fictional Alpha }
defaults: { createdBy: "agent:test" }
facts:
  - predicate: registry_id
    value: { system: cra-bn, value: "000000000" }
    src: [{ source: src_alpha_seed, locator: "registry page", quality: metadata }]
`,
    });
    const { corpus, issues } = loadResearchCorpus(root);
    expect(issues).toEqual([]);
    const src = corpus!.sources[0]!;
    expect(src.permissions?.capture).toBe("allowed");
    expect(src.permissions?.redistributeExcerpt).toBe("unknown"); // unstated ⇒ unknown ⇒ denied
    expect(src.permissions?.attributionRequired).toBe(true);
    expect(src.captures?.[0]?.path).toBe("captures/cap_1.html");
    const reg = corpus!.assertions[0]!;
    expect(reg.predicate).toBe("registry_id");
    expect(reg.evidence[0]).toMatchObject({ locatorQuality: "metadata", locator: "registry page" });
  });

  it("never copies a round's review onto its disclosures or participations", () => {
    const root = tree({ "sources/src_alpha_seed.yaml": SOURCE, "orgs/a.yaml": ORG });
    const round = loadResearchCorpus(root).corpus!.rounds[0]!;
    expect(round.review?.hash).toBe("round-only");
    expect(round.disclosures[0]!.review).toBeNull();
    expect(round.participations[0]!.review).toBeNull();
  });

  it("derives the same assertion ID for the same content and a new one when the value changes", () => {
    const a = loadResearchCorpus(
      tree({ "sources/src_alpha_seed.yaml": SOURCE, "orgs/a.yaml": ORG }),
    ).corpus!.assertions[0]!.id;
    const b = loadResearchCorpus(
      tree({ "sources/src_alpha_seed.yaml": SOURCE, "orgs/a.yaml": ORG }),
    ).corpus!.assertions[0]!.id;
    const c = loadResearchCorpus(
      tree({
        "sources/src_alpha_seed.yaml": SOURCE,
        "orgs/a.yaml": ORG.replace("Fictional Alpha Security Inc.", "Fictional Alpha Ltd."),
      }),
    ).corpus!.assertions[0]!.id;
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("reports errors with file and path, and returns no corpus", () => {
    const root = tree({
      "orgs/bad.yaml": `
org: { id: org_x, kind: company, slug: bad, name: Bad }
facts:
  - { predicate: legal_name, value: X, src: ["no-locator"] }
  - { predicate: not_a_predicate, value: X, src: ["s#1"], createdBy: a }
`,
      "orgs/dupe.yaml": "a: 1\na: 2\n",
    });
    const { corpus, issues } = loadResearchCorpus(root);
    expect(corpus).toBeNull();
    const text = issues.map((i) => `${i.file}:${i.path}: ${i.message}`).join("\n");
    expect(text).toMatch(/orgs\/bad\.yaml:facts\.0\.src\.0: "no-locator" needs the form/);
    expect(text).toMatch(/orgs\/bad\.yaml:facts\.0: createdBy is required/);
    expect(text).toMatch(/orgs\/bad\.yaml:facts\.1\.predicate:/);
    expect(text).toMatch(/orgs\/dupe\.yaml:: YAML parse error/);
  });

  it("an empty research directory loads and compiles to an empty, honest snapshot", () => {
    const { corpus, issues } = loadResearchCorpus(tree({ "taxonomy.yaml": TAXONOMY }));
    expect(issues).toEqual([]);
    const result = compile(corpus!, { today: "2026-10-13" });
    expect(result.ok).toBe(true);
    expect(result.snapshot!.coverage.inUniverse).toBe(0);
    expect(result.snapshot!.meta.isDemo).toBe(false);
  });

  it("references to organizations missing from research/ fail the build", () => {
    const root = tree({ "sources/src_alpha_seed.yaml": SOURCE, "orgs/fictional-alpha.yaml": ORG });
    const result = compile(loadResearchCorpus(root).corpus!, { today: "2026-10-13" });
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.gate)).toEqual(["dangling-ids"]);
  });

  it("proposed records compile but publish nothing", () => {
    const root = tree({
      "taxonomy.yaml": TAXONOMY,
      "sources/src_alpha_seed.yaml": SOURCE,
      "orgs/fictional-alpha.yaml": ORG,
      "orgs/fictional-fund-one.yaml":
        "org: { id: org_01FICTIONALFUND00000000000, kind: investor_firm, slug: fictional-fund-one, name: Fictional Fund One }\n",
    });
    const result = compile(loadResearchCorpus(root).corpus!, { today: "2026-10-13" });
    expect(result.ok).toBe(true);
    const snap = result.snapshot!;
    expect(snap.coverage.inUniverse).toBe(0);
    expect(snap.rounds).toEqual([]);
    expect(Object.keys(snap.assertions)).toEqual([]);
  });
});

/** Docs may be checked out with CRLF (core.autocrlf on Windows); the regexes below expect LF. */
const lf = (text: string) => text.replace(/\r\n/g, "\n");

describe("research/README.md stays in sync with the loader", () => {
  it("the documented organization-file example loads without problems", () => {
    const readme = lf(readFileSync("research/README.md", "utf8"));
    const example = /## Organization file\s+```yaml\n([\s\S]*?)```/.exec(readme)?.[1];
    expect(example).toBeTruthy();
    const { issues } = loadResearchCorpus(tree({ "orgs/example-co.yaml": example! }));
    expect(issues).toEqual([]);
  });
});

describe("research/taxonomy.yaml (approved 2026-10-13, P-24)", () => {
  it("is valid and internally consistent", () => {
    const text = readFileSync("research/taxonomy.yaml", "utf8");
    const { corpus, issues } = loadResearchCorpus(tree({ "taxonomy.yaml": text }));
    expect(issues).toEqual([]);
    const nodes = corpus!.taxonomy;
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.size).toBe(nodes.length);
    const sectors = nodes.filter((n) => n.parentId === null);
    expect(sectors).toHaveLength(10);
    expect(nodes.length - sectors.length).toBe(30);
    for (const n of nodes) {
      expect(n.id).toMatch(/^tax:[a-z]+(\.[a-z-]+)?$/);
      if (n.parentId) {
        expect(ids.has(n.parentId)).toBe(true);
        expect(n.id.startsWith(`${n.parentId}.`)).toBe(true); // a subsector's ID names its sector
        expect(nodes.find((p) => p.id === n.parentId)!.parentId).toBeNull(); // two levels only
      }
      expect(n.label).toMatch(/^[A-Z][^,]*(, [^,]+)*[^,.]$/); // no split or truncated labels
      expect(n.definition.length).toBeGreaterThan(20);
    }
    for (const s of sectors) expect(nodes.some((n) => n.parentId === s.id)).toBe(true);
    expect(new Set(nodes.map((n) => n.label.toLowerCase())).size).toBe(nodes.length);
  });
});

describe("unknown fields", () => {
  it("rejects a misspelt field instead of silently dropping it, at any depth", () => {
    const { issues } = loadResearchCorpus(
      tree({
        "taxonomy.yaml": "- { id: tax:a, parentId: null, label: A, definition: d, lable: x }\n",
      }),
    );
    expect(issues).toEqual([
      expect.objectContaining({
        file: "taxonomy.yaml",
        path: "0.lable",
        message: expect.stringMatching(/unknown field/),
      }),
    ]);
  });
});

describe("docs/RESEARCH_PROTOCOL.md stays in sync with the loader", () => {
  it("the documented eligibility fact loads as written", () => {
    const doc = lf(readFileSync("docs/RESEARCH_PROTOCOL.md", "utf8"));
    const snippet = /### 3\. Eligibility[\s\S]*?```yaml\n([\s\S]*?)```/.exec(doc)?.[1];
    expect(snippet).toBeTruthy();
    const org = `org: { id: org_x, kind: company, slug: x, name: Fictional X }\ndefaults: { createdBy: "agent:test" }\nfacts:\n${snippet}`;
    const { corpus, issues } = loadResearchCorpus(tree({ "orgs/x.yaml": org }));
    expect(issues).toEqual([]);
    expect(corpus!.assertions[0]).toMatchObject({
      predicate: "eligibility",
      epistemic: "analyst_interpretation",
      verification: "proposed",
    });
  });
});

describe("source addresses", () => {
  it("refuses a source whose address is not a web address", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://x/y",
      "no scheme",
    ]) {
      const root = tree({
        "taxonomy.yaml": TAXONOMY,
        "sources/src_alpha_seed.yaml": SOURCE.replace(
          "https://example.org/fictional-alpha-seed",
          bad,
        ),
      });
      const { corpus, issues } = loadResearchCorpus(root);
      expect(corpus, bad).toBeNull();
      expect(
        issues.some((i) => /web address/.test(i.message)),
        bad,
      ).toBe(true);
    }
  });
});

// Each test loads 520+ files several times; the suite runs in parallel with the rest.
describe("research loader parse cache (large corpora)", { timeout: 120_000 }, () => {
  /** 520 tiny source files: past the cache threshold. The cache lands beside the folder, not in it. */
  function bigTree() {
    const base = mkdtempSync(join(tmpdir(), "candef-bigresearch-"));
    roots.push(base);
    const root = join(base, "research");
    mkdirSync(join(root, "sources"), { recursive: true });
    writeFileSync(join(root, "taxonomy.yaml"), TAXONOMY);
    for (let i = 0; i < 520; i++)
      writeFileSync(
        join(root, "sources", `src_${i}.yaml`),
        SOURCE.replace("alpha-seed", `seed-${i}`),
      );
    const cacheFile = () => {
      const dir = join(base, "research-cache", "yaml-parse");
      const f = existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".json")) : [];
      return f.length ? join(dir, f[0]!) : null;
    };
    return {
      base,
      root,
      cacheFile,
      src: (n: number | string) => join(root, "sources", `src_${n}.yaml`),
    };
  }
  /** Everything a caller can observe from a load. */
  const observed = (r: ReturnType<typeof loadResearchCorpus>) =>
    JSON.stringify({ corpus: r.corpus, issues: r.issues, files: r.files, origins: [...r.origins] });
  const uncached = (root: string) => observed(loadResearchCorpus(root, { parseCache: "off" }));
  const cachedEntries = (file: string) =>
    Object.keys(JSON.parse(readFileSync(file, "utf8")).entries as object);

  it("loads the same corpus uncached, cold and warm; small corpora never write a cache", () => {
    const t = bigTree();
    const plain = uncached(t.root);
    expect(t.cacheFile()).toBeNull();
    const cold = observed(loadResearchCorpus(t.root));
    expect(t.cacheFile()).not.toBeNull();
    expect(cold).toBe(plain);
    for (let i = 0; i < 3; i++) expect(observed(loadResearchCorpus(t.root))).toBe(plain);

    const small = tree({ "taxonomy.yaml": TAXONOMY, "sources/src_alpha_seed.yaml": SOURCE });
    loadResearchCorpus(small);
    expect(existsSync(join(dirname(small), "research-cache"))).toBe(false);
  });

  it("matches an uncached load after every step of a mixed edit sequence", () => {
    const t = bigTree();
    loadResearchCorpus(t.root);
    let seed = 20261014;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const steps = [
      (n: number) => writeFileSync(t.src(n), SOURCE.replace("Fictional seed", `Edited ${n}`)),
      (n: number) => rmSync(t.src(n), { force: true }),
      (n: number) => writeFileSync(t.src(`new_${n}`), SOURCE.replace("alpha-seed", `new-${n}`)),
      (n: number) => writeFileSync(t.src(n), "kind: [unclosed\n"),
      (n: number) => writeFileSync(t.src(n), ""),
      (n: number) => writeFileSync(t.src(n), "# only a comment\n"),
      (n: number) => writeFileSync(t.src(n), SOURCE.replace("\r", "").replace(/\n/g, "\r\n")),
      (n: number) => writeFileSync(t.src(n), SOURCE + "kind: company_release\n"),
    ];
    for (let round = 0; round < 12; round++) {
      steps[next(steps.length)]!(next(520));
      const warm = observed(loadResearchCorpus(t.root));
      expect(warm, `after step ${round}`).toBe(uncached(t.root));
      expect(observed(loadResearchCorpus(t.root)), `repeat ${round}`).toBe(warm);
    }
  });

  it("notices edits, deletions and additions, and prunes deleted files from the cache", () => {
    const t = bigTree();
    loadResearchCorpus(t.root);
    expect(cachedEntries(t.cacheFile()!)).toContain("sources/src_8.yaml");
    writeFileSync(t.src(7), SOURCE.replace("Fictional seed", "Edited"));
    expect(
      loadResearchCorpus(t.root).corpus!.sources.find((x) => x.id === "src_7")!.title,
    ).toContain("Edited");
    rmSync(t.src(8));
    expect(loadResearchCorpus(t.root).corpus!.sources).toHaveLength(519);
    expect(cachedEntries(t.cacheFile()!)).not.toContain("sources/src_8.yaml");
    writeFileSync(t.src("extra"), SOURCE.replace("alpha-seed", "extra"));
    expect(loadResearchCorpus(t.root).corpus!.sources).toHaveLength(520);
  });

  it("never caches a failed parse, and keeps reporting it", () => {
    const t = bigTree();
    loadResearchCorpus(t.root);
    writeFileSync(t.src(9), "kind: [unclosed\n");
    for (let pass = 0; pass < 3; pass++) {
      const r = loadResearchCorpus(t.root);
      expect(r.corpus).toBeNull();
      expect(r.issues.some((i) => i.file === "sources/src_9.yaml")).toBe(true);
    }
    expect(cachedEntries(t.cacheFile()!)).not.toContain("sources/src_9.yaml");
    expect(observed(loadResearchCorpus(t.root))).toBe(uncached(t.root));
  });

  it("starts cold, silently, from a damaged, outdated or tampered cache file", () => {
    const t = bigTree();
    const plain = uncached(t.root);
    loadResearchCorpus(t.root);
    const file = t.cacheFile()!;
    const good = readFileSync(file, "utf8");

    writeFileSync(file, good.slice(0, good.length >> 1)); // truncated
    expect(observed(loadResearchCorpus(t.root))).toBe(plain);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toBeTruthy(); // rewritten whole

    writeFileSync(file, "not json at all");
    expect(observed(loadResearchCorpus(t.root))).toBe(plain);

    const saved = JSON.parse(good);
    writeFileSync(file, JSON.stringify({ ...saved, yaml: "0.0.0" })); // other library version
    expect(observed(loadResearchCorpus(t.root))).toBe(plain);
    writeFileSync(file, JSON.stringify({ ...saved, format: 99 }));
    expect(observed(loadResearchCorpus(t.root))).toBe(plain);

    // An entry whose stored hash does not match the file content is a miss, not a wrong answer.
    saved.entries["sources/src_3.yaml"].h = "0000000000000000";
    saved.entries["sources/src_3.yaml"].doc = { kind: "registry", wrong: true };
    saved.entries["sources/src_4.yaml"] = "garbage";
    saved.entries["sources/src_5.yaml"] = { h: 5 };
    writeFileSync(file, JSON.stringify(saved));
    expect(observed(loadResearchCorpus(t.root))).toBe(plain);
  });

  it("does not cache documents that JSON cannot reproduce exactly", () => {
    const t = bigTree();
    writeFileSync(
      t.src(11),
      SOURCE.replace("title: Fictional seed announcement", "title: !!timestamp 2024-01-01"),
    );
    writeFileSync(t.src(12), SOURCE.replace("textSha256: null", "textSha256: null\nextra: .nan"));
    const plain = uncached(t.root);
    for (let pass = 0; pass < 2; pass++) expect(observed(loadResearchCorpus(t.root))).toBe(plain);
    const entries = cachedEntries(t.cacheFile()!);
    expect(entries).not.toContain("sources/src_11.yaml");
    expect(entries).not.toContain("sources/src_12.yaml");
    expect(entries).toContain("sources/src_13.yaml");
  });

  it("release and approval loads ignore a forged entry that carries the right content hash", () => {
    const t = bigTree();
    const plain = uncached(t.root);
    loadResearchCorpus(t.root);
    const file = t.cacheFile()!;
    const saved = JSON.parse(readFileSync(file, "utf8"));
    // Same file text, so the same hash: only the cached document is forged.
    saved.entries["sources/src_3.yaml"].doc = {
      ...saved.entries["sources/src_3.yaml"].doc,
      title: "Forged title",
    };
    writeFileSync(file, JSON.stringify(saved));
    // The ordinary load trusts it (why publish paths must not use the cache)…
    const cached = loadResearchCorpus(t.root).corpus!.sources.find((s) => s.id === "src_3")!;
    expect(cached.title).toBe("Forged title");
    // …the release loader reads the YAML itself.
    expect(observed(loadResearchCorpusUncached(t.root))).toBe(plain);
  });

  it("can be switched off with an option or CANDEF_PARSE_CACHE=off", () => {
    const t = bigTree();
    loadResearchCorpus(t.root, { parseCache: "off" });
    expect(t.cacheFile()).toBeNull();
    process.env.CANDEF_PARSE_CACHE = "off";
    try {
      loadResearchCorpus(t.root);
      expect(t.cacheFile()).toBeNull();
    } finally {
      delete process.env.CANDEF_PARSE_CACHE;
    }
  });
});
