/**
 * Research corpus loader (M3-A2): compact authoring YAML in `research/` → canonical `Corpus`.
 *
 * Authoring layout (documented in research/README.md):
 *   taxonomy.yaml        TaxonomyNode[]
 *   programs.yaml        Program[]
 *   sources/<id>.yaml    one Source (id defaults to the file name)
 *   orgs/<slug>.yaml     { org, defaults?, facts?, rounds?, agreements?, acquisitions?, research? }
 *
 * Conveniences, all expanded here so the compiler only ever sees canonical records:
 *   - `src: ["sourceId#locator", …]` → `evidence` (object form `{ source, locator, quality }` too);
 *     `sourceId@captureId#locator` (object form `capture`) records the capture the locator was read in;
 *   - per-file `defaults` for createdBy / verification / epistemic (verification defaults to
 *     `proposed`: nothing is ever verified implicitly);
 *   - subject/company IDs implied by the file's org; assertion and ledger IDs derived from content;
 *   - integer money written as a YAML number is accepted and stored as a decimal string.
 *
 * Review blocks are passed through untouched; only `candef review` writes them.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { parse } from "yaml";
import type { ZodType } from "zod";
import {
  Acquisition,
  Agreement,
  Assertion,
  Corpus,
  FinancingRound,
  Organization,
  Program,
  ResearchAttempt,
  Source,
  TaxonomyNode,
} from "../../src/domain/schema/corpus";
import { canonicalJson } from "../compile/hash";

export interface LoadIssue {
  file: string;
  path: string;
  message: string;
}

/** Where a canonical record was authored: file (relative to research/) and YAML path in it. */
export interface Origin {
  file: string;
  path: (string | number)[];
}

export interface LoadResult {
  corpus: Corpus | null;
  issues: LoadIssue[];
  files: number;
  /** Record ID → authored location (assertions, rounds, agreements, acquisitions, sources, orgs). */
  origins: Map<string, Origin>;
}

type Obj = Record<string, unknown>;

/** Paths of fields present in `raw` but missing from the parsed `out` (dropped by Zod). */
function unknownFields(raw: unknown, out: unknown, at = ""): string[] {
  const join = (k: string | number) => (at ? `${at}.${k}` : String(k));
  if (Array.isArray(raw) && Array.isArray(out) && raw.length === out.length)
    return raw.flatMap((v, i) => unknownFields(v, out[i], join(i)));
  if (!isObj(raw) || !isObj(out)) return [];
  return Object.keys(raw).flatMap((k) =>
    k in out ? unknownFields(raw[k], out[k], join(k)) : [join(k)],
  );
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const hash16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Parsing YAML is ~99% of load time and linear in size (about 1 MB/s: 20 s for 6,900 files). Past
 * `CACHE_MIN_FILES` files a parse cache, keyed by file content and the YAML library version, makes
 * an unchanged corpus load in a fraction of that. Real research (about 100 files) and tests never
 * reach it, so they behave exactly as before.
 *
 * The cache must be invisible: a cached document is only stored when it survives a JSON round trip
 * unchanged (`sameJson`: no -0, NaN, dates, undefined), failed parses are never stored, and the
 * loader never mutates a parsed document. `CANDEF_PARSE_CACHE=off` (or `parseCache: "off"`) turns it
 * off for debugging; the cache file is disposable and any problem reading it means a plain parse.
 */
const CACHE_MIN_FILES = 500;
const CACHE_FORMAT = 1;
const yamlVersion = (createRequire(import.meta.url)("yaml/package.json") as { version: string })
  .version;

interface CacheEntry {
  h: string;
  doc: unknown;
}

/** Deep equality for JSON-shaped values; false where JSON would change the value. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && sameJson(a[k], b[k]));
  }
  return Object.is(a, b);
}

const validEntry = (e: unknown): e is CacheEntry =>
  isObj(e) && typeof e.h === "string" && "doc" in e;

class ParseCache {
  private entries = new Map<string, CacheEntry>();
  private dirty = false;
  constructor(private readonly file: string) {
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as {
        format?: number;
        yaml?: string;
        entries?: Record<string, unknown>;
      };
      if (saved.format === CACHE_FORMAT && saved.yaml === yamlVersion && isObj(saved.entries))
        for (const [k, e] of Object.entries(saved.entries))
          if (validEntry(e)) this.entries.set(k, e);
    } catch {
      // No cache yet, or unreadable: start empty.
    }
  }
  get(rel: string, text: string): { hit: true; doc: unknown } | { hit: false; h: string } {
    const h = hash16(text);
    const e = this.entries.get(rel);
    return e && e.h === h ? { hit: true, doc: e.doc } : { hit: false, h };
  }
  /** Stores a freshly parsed document, unless JSON could not reproduce it exactly. */
  put(rel: string, h: string, doc: unknown) {
    let copy: unknown;
    try {
      copy = JSON.parse(JSON.stringify(doc));
    } catch {
      this.entries.delete(rel);
      return;
    }
    if (!sameJson(doc, copy)) {
      this.entries.delete(rel);
      return;
    }
    this.entries.set(rel, { h, doc: copy });
    this.dirty = true;
  }
  /** A file that no longer parses must not leave an older, valid parse behind. */
  drop(rel: string) {
    if (this.entries.delete(rel)) this.dirty = true;
  }
  save(seen: Set<string>) {
    let pruned = false;
    for (const k of [...this.entries.keys()])
      if (!seen.has(k)) {
        this.entries.delete(k);
        pruned = true;
      }
    if (!this.dirty && !pruned) return;
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        tmp,
        JSON.stringify({
          format: CACHE_FORMAT,
          yaml: yamlVersion,
          entries: Object.fromEntries(this.entries),
        }),
      );
      renameSync(tmp, this.file);
    } catch {
      // A cache that cannot be written only costs time.
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Nothing more to do.
      }
    }
  }
}

const MONEY_KEYS = new Set(["amount", "originalValue", "amendmentValue", "totalValue"]);

/** Numbers written for money fields become decimal strings; everything else is left alone. */
function coerceMoney(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(coerceMoney);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, val] of Object.entries(v))
    out[k] =
      MONEY_KEYS.has(k) && typeof val === "number" && Number.isFinite(val)
        ? String(val)
        : coerceMoney(val);
  return out;
}

export class ResearchLoader {
  readonly issues: LoadIssue[] = [];
  readonly origins = new Map<string, Origin>();
  private file = "";
  private cache: ParseCache | null = null;
  private readonly seen = new Set<string>();

  private origin(id: string, path: (string | number)[]) {
    this.origins.set(id, { file: this.file, path });
  }

  constructor(
    private readonly root: string,
    private readonly options: { parseCache?: "auto" | "off" } = {},
  ) {}

  private issue(path: string, message: string) {
    this.issues.push({ file: this.file, path, message });
  }

  private readYaml(abs: string): unknown {
    this.file = relative(this.root, abs).replace(/\\/g, "/");
    try {
      const text = readFileSync(abs, "utf8");
      if (!this.cache) return parse(text, { uniqueKeys: true });
      this.seen.add(this.file);
      const found = this.cache.get(this.file, text);
      if (found.hit) return found.doc;
      const doc = parse(text, { uniqueKeys: true });
      this.cache.put(this.file, found.h, doc);
      return doc;
    } catch (e) {
      this.cache?.drop(this.file);
      this.issue("", `YAML parse error: ${(e as Error).message.split("\n")[0]}`);
      return undefined;
    }
  }

  /**
   * Parses with Zod; reports every issue with its path inside the file. Zod drops fields it does
   * not know, so a misspelt field (`verifcation:`) would vanish silently: any field present in the
   * input but absent from the parsed record is reported as unknown, and the record is rejected.
   */
  private check<T>(schema: ZodType<T>, value: unknown, path: string, scanUnknown = true): T | null {
    const r = schema.safeParse(value);
    if (r.success) {
      const unknown = scanUnknown ? unknownFields(value, r.data) : [];
      for (const field of unknown)
        this.issue([path, field].filter(Boolean).join("."), "unknown field (misspelt?)");
      return unknown.length ? null : r.data;
    }
    for (const i of r.error.issues)
      this.issue([path, ...i.path.map(String)].filter(Boolean).join("."), i.message);
    return null;
  }

  /** `src` shorthand → Evidence[]; keeps an explicit `evidence` array. */
  private evidence(rec: Obj, path: string): unknown[] {
    if (Array.isArray(rec.evidence) && rec.src === undefined) return rec.evidence;
    if (rec.src === undefined) return [];
    if (!Array.isArray(rec.src)) {
      this.issue(`${path}.src`, "src must be a list");
      return [];
    }
    return rec.src.map((s, i) => {
      if (typeof s === "string") {
        const at = s.indexOf("#");
        if (at <= 0) this.issue(`${path}.src.${i}`, `"${s}" needs the form sourceId#locator`);
        // `sourceId@captureId#locator` binds the evidence to the capture it was read in.
        const head = at > 0 ? s.slice(0, at) : s;
        const [sourceId, captureId] = head.split("@");
        return {
          sourceId,
          locator: at > 0 ? s.slice(at + 1) : "",
          ...(captureId ? { captureId } : {}),
        };
      }
      if (isObj(s))
        return {
          sourceId: s.source,
          locator: s.locator ?? "",
          locatorQuality: s.quality,
          ...(s.capture ? { captureId: s.capture } : {}),
        };
      this.issue(`${path}.src.${i}`, "src entries are 'sourceId#locator' strings or objects");
      return { sourceId: "", locator: "" };
    });
  }

  /** Provenance envelope: record fields override file defaults; verification defaults to proposed. */
  private provenance(rec: Obj, defaults: Obj, path: string): Obj {
    const createdBy = rec.createdBy ?? defaults.createdBy;
    if (createdBy === undefined)
      this.issue(path, "createdBy is required (set it in `defaults` or on the record)");
    return {
      epistemic: rec.epistemic ?? defaults.epistemic ?? "sourced_fact",
      verification: rec.verification ?? defaults.verification ?? "proposed",
      evidence: this.evidence(rec, path),
      review: rec.review ?? null,
      createdBy,
    };
  }

  private strip(rec: Obj): Obj {
    const { src: _src, subject: _subject, ...rest } = rec;
    void _src;
    void _subject;
    return rest;
  }

  /**
   * A child record (disclosure, participation) inherits authorship, state and sources from its
   * round, but NEVER its review: approvals are hash-bound to exactly one record.
   */
  private inherit(parent: Obj, child: Obj): Obj {
    return {
      createdBy: child.createdBy ?? parent.createdBy,
      verification: child.verification ?? parent.verification,
      epistemic: child.epistemic ?? parent.epistemic,
      src: child.src ?? (child.evidence === undefined ? parent.src : undefined),
      evidence: child.evidence,
      review: child.review,
    };
  }

  private list(doc: Obj, key: string): Obj[] {
    const v = doc[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      this.issue(key, "must be a list");
      return [];
    }
    return v.filter((x, i) =>
      isObj(x) ? true : (this.issue(`${key}.${i}`, "must be a mapping"), false),
    );
  }

  load(): LoadResult {
    const corpus: Corpus = {
      schemaVersion: "0.3",
      isDemo: false,
      taxonomy: [],
      sources: [],
      organizations: [],
      assertions: [],
      rounds: [],
      agreements: [],
      acquisitions: [],
      programs: [],
      research: [],
    };
    let files = 0;
    if (!existsSync(this.root)) {
      this.issues.push({
        file: "",
        path: "",
        message: `research directory not found: ${this.root}`,
      });
      return { corpus: null, issues: this.issues, files, origins: this.origins };
    }

    const sourceFiles = yamlFiles(join(this.root, "sources"));
    const orgFiles = yamlFiles(join(this.root, "orgs"));
    const cacheOff = (this.options.parseCache ?? process.env.CANDEF_PARSE_CACHE) === "off";
    if (!cacheOff && sourceFiles.length + orgFiles.length >= CACHE_MIN_FILES)
      this.cache = new ParseCache(
        join(dirname(this.root), "research-cache", "yaml-parse", `${hash16(this.root)}.json`),
      );

    for (const [name, key, schema] of [
      ["taxonomy.yaml", "taxonomy", TaxonomyNode],
      ["programs.yaml", "programs", Program],
    ] as const) {
      const abs = join(this.root, name);
      if (!existsSync(abs)) continue;
      files++;
      const doc = this.readYaml(abs);
      if (doc === undefined || doc === null) continue;
      if (!Array.isArray(doc)) {
        this.issue("", "must be a list");
        continue;
      }
      doc.forEach((item, i) => {
        const parsed = this.check(schema as ZodType<unknown>, item, String(i));
        if (parsed) (corpus[key] as unknown[]).push(parsed);
      });
    }

    for (const abs of sourceFiles) {
      files++;
      const doc = this.readYaml(abs);
      if (!isObj(doc)) {
        if (doc !== undefined) this.issue("", "a source file must be a mapping");
        continue;
      }
      const parsed = this.check(Source, { id: basename(abs, ".yaml"), ...doc }, "");
      if (parsed) {
        corpus.sources.push(parsed);
        this.origin(parsed.id, []);
      }
    }

    for (const abs of orgFiles) {
      files++;
      const doc = this.readYaml(abs);
      if (!isObj(doc)) {
        if (doc !== undefined) this.issue("", "an organization file must be a mapping");
        continue;
      }
      this.loadOrgFile(coerceMoney(doc) as Obj, corpus);
    }

    this.cache?.save(this.seen);
    // Every record was already parsed and scanned one by one; the scan is not repeated here.
    const whole = this.check(Corpus, corpus, "(corpus)", false);
    return {
      corpus: this.issues.length ? null : whole,
      issues: this.issues,
      files,
      origins: this.origins,
    };
  }

  private loadOrgFile(doc: Obj, corpus: Corpus) {
    const org = this.check(Organization, { isDemo: false, ...(doc.org as Obj) }, "org");
    if (!org) return;
    corpus.organizations.push(org);
    this.origin(org.id, ["org"]);
    const defaults = isObj(doc.defaults) ? doc.defaults : {};

    this.list(doc, "facts").forEach((f, i) => {
      const path = `facts.${i}`;
      const subjectId = (f.subject as string | undefined) ?? org.id;
      const base = { ...this.strip(f), subjectId };
      const prov = this.provenance(f, defaults, path);
      const id =
        (f.id as string | undefined) ??
        `asr_${hash16(
          canonicalJson({
            subjectId,
            predicate: f.predicate,
            value: f.value ?? null,
            sources: (prov.evidence as { sourceId: string }[]).map((e) => e.sourceId).sort(),
          }),
        )}`;
      const parsed = this.check(Assertion, { ...base, ...prov, id }, path);
      if (parsed) {
        corpus.assertions.push(parsed);
        this.origin(parsed.id, ["facts", i]);
      }
    });

    this.list(doc, "rounds").forEach((r, i) => {
      const path = `rounds.${i}`;
      const roundId = r.id as string | undefined;
      if (!roundId) this.issue(path, "a round needs an explicit id (fin_…)");
      const disclosures = (Array.isArray(r.disclosures) ? r.disclosures : []).map((d, j) =>
        isObj(d)
          ? {
              ...this.strip(d),
              id: d.id ?? `${roundId}_d${j + 1}`,
              ...this.provenance(this.inherit(r, d), defaults, `${path}.disclosures.${j}`),
            }
          : d,
      );
      const participations = (Array.isArray(r.participations) ? r.participations : []).map(
        (p, j) =>
          isObj(p)
            ? {
                ...this.strip(p),
                ...this.provenance(this.inherit(r, p), defaults, `${path}.participations.${j}`),
              }
            : p,
      );
      const parsed = this.check(
        FinancingRound,
        {
          ...this.strip(r),
          companyId: r.companyId ?? org.id,
          ...this.provenance(r, defaults, path),
          disclosures,
          participations,
        },
        path,
      );
      if (parsed) {
        corpus.rounds.push(parsed);
        this.origin(parsed.id, ["rounds", i]);
        parsed.disclosures.forEach((d, j) => this.origin(d.id, ["rounds", i, "disclosures", j]));
      }
    });

    for (const [key, schema, target] of [
      ["agreements", Agreement, corpus.agreements],
      ["acquisitions", Acquisition, corpus.acquisitions],
    ] as const) {
      this.list(doc, key).forEach((a, i) => {
        const path = `${key}.${i}`;
        if (!a.id) this.issue(path, `an ${key.slice(0, -1)} needs an explicit id`);
        const expanded: Obj = { ...this.strip(a), ...this.provenance(a, defaults, path) };
        if (key === "agreements" && Array.isArray(a.valueStatements))
          expanded.valueStatements = a.valueStatements.map((v, j) =>
            isObj(v)
              ? { ...this.strip(v), evidence: this.evidence(v, `${path}.valueStatements.${j}`) }
              : v,
          );
        const parsed = this.check(schema as ZodType<unknown>, expanded, path);
        if (parsed) {
          (target as unknown[]).push(parsed);
          this.origin((parsed as { id: string }).id, [key, i]);
        }
      });
    }

    this.list(doc, "research").forEach((r, i) => {
      const subjectId = (r.subjectId as string | undefined) ?? org.id;
      const id = (r.id as string | undefined) ?? `rsh_${hash16(`${subjectId}|${r.topic}|${r.at}`)}`;
      const parsed = this.check(ResearchAttempt, { ...r, subjectId, id }, `research.${i}`);
      if (parsed) corpus.research.push(parsed);
    });
  }
}

function yamlFiles(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
    .sort()
    .map((f) => join(dir, f));
}

export function loadResearchCorpus(
  root: string,
  options?: { parseCache?: "auto" | "off" },
): LoadResult {
  return new ResearchLoader(root, options).load();
}

/**
 * Publish and approval paths (build:research, apply-decisions, apply-tiers) never read the parse
 * cache: an entry forged with the right content hash would otherwise be trusted (BACKLOG item 4).
 */
export function loadResearchCorpusUncached(root: string): LoadResult {
  return loadResearchCorpus(root, { parseCache: "off" });
}
