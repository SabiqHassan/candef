/**
 * Authoring operations behind the `candef` CLI (M3-B1, B2, B6). Every write creates or edits YAML
 * in research/ and leaves records `proposed`; nothing here can verify or approve anything.
 * Edits go through the `yaml` Document API so comments and layout survive.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Document, isMap, isSeq, parseDocument } from "yaml";
import { OrgKind, ResearchAttempt, Source, Tier } from "../../src/domain/schema/corpus";
import { loadResearchCorpus } from "./load";
import { nameKey } from "./names";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit millisecond time + 80 random bits, Crockford base32 (26 chars). */
export function ulid(now = Date.now(), random: Uint8Array = randomBytes(10)): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const b of random) bits = (bits << 8n) | BigInt(b);
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(bits & 31n)] + rand;
    bits >>= 5n;
  }
  return time + rand;
}

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Canonical URL for source identity: lowercase host, no fragment, no tracking params, no trailing slash. */
export function canonicalUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  for (const key of [...u.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  let s = u.toString();
  if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
  return s;
}

/** Source IDs are derived from the canonical URL (F-12), so the same page is never added twice. */
export function sourceIdForUrl(url: string): string {
  return `src_${createHash("sha256").update(canonicalUrl(url)).digest("hex").slice(0, 12)}`;
}

export class AuthoringError extends Error {}

/**
 * Today's date (YYYY-MM-DD) on the researcher's own clock. A UTC date would stamp evening work in
 * Canada with tomorrow's date. Timestamps (retrievedAt) stay in UTC.
 */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function existing(root: string) {
  const loaded = loadResearchCorpus(root);
  if (!loaded.corpus)
    throw new AuthoringError(
      `research/ has ${loaded.issues.length} problem(s); run \`candef validate\` first`,
    );
  return loaded.corpus;
}

export interface NewOrgInput {
  kind: string;
  name: string;
  slug?: string;
  by: string;
}

/** Creates research/orgs/<slug>.yaml; refuses a duplicate slug or a name that normalizes to an existing one. */
export function newOrg(root: string, input: NewOrgInput): { id: string; file: string } {
  const kind = OrgKind.parse(input.kind);
  const slug = input.slug ?? slugify(input.name);
  if (!slug) throw new AuthoringError("name produces an empty slug");
  const file = join(root, "orgs", `${slug}.yaml`);
  if (existsSync(file)) throw new AuthoringError(`orgs/${slug}.yaml already exists`);
  if (existsSync(root)) {
    const corpus = existing(root);
    const key = nameKey(input.name);
    const legal = new Map<string, string[]>();
    for (const a of corpus.assertions)
      if (a.predicate === "legal_name" && typeof a.value === "string")
        legal.set(a.subjectId, [...(legal.get(a.subjectId) ?? []), a.value]);
    const clash = corpus.organizations.find(
      (o) =>
        o.kind === kind && [o.name, ...(legal.get(o.id) ?? [])].some((n) => nameKey(n) === key),
    );
    if (clash)
      throw new AuthoringError(
        `"${input.name}" matches existing ${clash.kind} ${clash.id} (${clash.name}); add facts there, or record a distinctFrom decision`,
      );
    if (corpus.organizations.some((o) => o.slug === slug))
      throw new AuthoringError(`slug "${slug}" is already used`);
  }
  const id = `org_${ulid()}`;
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(
    file,
    [
      `# Created by candef new (${localDate()}). Everything here stays proposed until the owner reviews it.`,
      `# Research topics with no ledger entry show as "not yet researched": identity, financing, agreements, eligibility.`,
      // Block style: Prettier leaves it unchanged whatever the name length (CI runs prettier --check).
      `org:`,
      `  id: ${id}`,
      `  kind: ${kind}`,
      `  slug: ${slug}`,
      `  name: ${JSON.stringify(input.name)}`,
      `defaults:`,
      `  createdBy: ${JSON.stringify(input.by)}`,
      `facts: []`,
      `rounds: []`,
      `agreements: []`,
      `research: []`,
      ``,
    ].join("\n"),
  );
  return { id, file };
}

export interface AddSourceInput {
  url: string;
  kind: string;
  tier: string;
  publisher: string;
  title: string;
  publishedOn?: string | null;
  originGroup?: string;
}

/** Creates research/sources/<id>.yaml with every permission `unknown` (treated as denied). */
export function addSource(root: string, input: AddSourceInput): { id: string; file: string } {
  const url = canonicalUrl(input.url);
  const id = sourceIdForUrl(url);
  const file = join(root, "sources", `${id}.yaml`);
  if (existsSync(file)) throw new AuthoringError(`source ${id} already exists for ${url}`);
  if (existsSync(root)) {
    const dup = existing(root).sources.find((s) => canonicalUrl(s.url) === url);
    if (dup) throw new AuthoringError(`source ${dup.id} already points at ${url}`);
  }
  const source = Source.parse({
    id,
    kind: input.kind,
    tier: Tier.parse(input.tier),
    publisher: input.publisher,
    title: input.title,
    url,
    publishedOn: input.publishedOn ?? null,
    retrievedAt: new Date().toISOString(),
    originGroup: input.originGroup ?? `og:${id}`,
    textSha256: null,
    permissions: {},
    captures: [],
    availability: "unknown",
  });
  mkdirSync(join(root, "sources"), { recursive: true });
  const { id: _id, ...body } = source;
  void _id;
  const doc = new Document(body);
  doc.commentBefore =
    " Permissions stay `unknown` (= denied) until a human reads the site's terms and records them.";
  writeFileSync(file, doc.toString());
  return { id, file };
}

export interface LedgerInput {
  topic: string;
  outcome: string;
  sourcesSearched: string[];
  by: string;
  at?: string;
  nextReview?: string | null;
}

/** Appends a research-ledger entry to research/orgs/<slug>.yaml, preserving the file's comments. */
export function appendLedger(root: string, slug: string, input: LedgerInput): void {
  const file = join(root, "orgs", `${slug}.yaml`);
  if (!existsSync(file)) throw new AuthoringError(`orgs/${slug}.yaml not found`);
  const entry = ResearchAttempt.omit({ id: true, subjectId: true }).parse({
    topic: input.topic,
    outcome: input.outcome,
    sourcesSearched: input.sourcesSearched,
    by: input.by,
    at: input.at ?? localDate(),
    nextReview: input.nextReview ?? null,
  });
  const doc = parseDocument(readFileSync(file, "utf8"));
  if (!isMap(doc.contents)) throw new AuthoringError(`orgs/${slug}.yaml is not a mapping`);
  const seq = doc.get("research", true);
  if (seq === undefined || seq === null) doc.set("research", doc.createNode([entry]));
  else if (isSeq(seq)) {
    seq.flow = false; // `research: []` from the skeleton becomes a block list
    seq.add(doc.createNode(entry));
  } else throw new AuthoringError(`orgs/${slug}.yaml: research must be a list`);
  writeFileSync(file, doc.toString());
}
