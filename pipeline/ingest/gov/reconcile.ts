import { mkdir, readFile, readdir, lstat, realpath, writeFile, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { Agreement, type Corpus } from "../../../src/domain/schema/corpus";
import { loadResearchCorpus } from "../../research/load";
import { ALIAS_FILE, readAliases } from "./aliases";
import { assertOutputPath } from "./cli";
import { canonical, compare, digest } from "./locators";
import { planMigration, resolveAlias } from "./migration";
import { writeReviewOutputs } from "./output";

const Metadata = z.object({
  version: z.literal(1),
  identities: z.array(
    z.object({
      id: z.string(),
      legacyIds: z.array(z.string()),
      rowIds: z.array(z.string()),
      key: z.string(),
      reason: z.string(),
    }),
  ),
  decisions: z.array(z.object({ outcome: z.string() }).passthrough()),
  warnings: z.array(z.unknown()).default([]),
});
async function filesUnder(root: string, dir = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(join(root, dir), { withFileTypes: true })).sort((a, b) =>
    compare(a.name, b.name),
  )) {
    const name = join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) throw new Error(`Refusing linked input: ${name}`);
    if (entry.isDirectory()) Object.assign(result, await filesUnder(root, name));
    else if (/\.ya?ml$/i.test(name) || name === ALIAS_FILE) {
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.nlink > 1)
        throw new Error(`Refusing nonregular or hard-linked input: ${name}`);
      result[name] = await readFile(join(root, name), "utf8");
    }
  }
  return result;
}
export async function createMigrationBundle(researchPath: string, importPath: string) {
  const research = await realpath(researchPath),
    imported = await realpath(importPath);
  const originals = await filesUnder(research);
  const loaded = loadResearchCorpus(research);
  if (!loaded.corpus)
    throw new Error(
      `Invalid research corpus: ${loaded.issues.map((i) => `${i.file}:${i.path} ${i.message}`).join("; ")}`,
    );
  const incomingText = await readFile(join(imported, "all-agreements.json"), "utf8");
  const metadataText = await readFile(join(imported, "linkage.json"), "utf8");
  const incoming = z.array(Agreement).parse(JSON.parse(incomingText));
  const metadata = Metadata.parse(JSON.parse(metadataText));
  const aliases = readAliases(research);
  const plan = planMigration(loaded.corpus.agreements, incoming, metadata.identities, aliases);
  const payload = {
    version: 1 as const,
    research,
    imported,
    inputs: Object.fromEntries(
      Object.entries(originals).map(([name, content]) => [name, digest(content)]),
    ),
    importHashes: { agreements: digest(incomingText), linkage: digest(metadataText) },
    plan,
    newLinks: metadata.decisions.filter((d) => d.outcome === "linked"),
    candidates: metadata.decisions.filter((d) => d.outcome === "candidate"),
    warnings: metadata.warnings,
  };
  return { ...payload, hash: digest(payload) };
}
export type MigrationBundle = Awaited<ReturnType<typeof createMigrationBundle>>;

/**
 * Records the owner has reviewed (or that are no longer plain proposals), keyed by kind and id, with
 * their canonical content. A migration may share a file with them but must leave each one exactly
 * as it was (BACKLOG item 7, owner go-ahead 2026-10-16).
 */
export function protectedRecords(corpus: Corpus): Map<string, string> {
  const out = new Map<string, string>();
  const kinds = {
    assertion: corpus.assertions,
    round: corpus.rounds,
    agreement: corpus.agreements,
    acquisition: corpus.acquisitions,
  } as const;
  for (const [kind, records] of Object.entries(kinds))
    for (const r of records as { id: string; review: unknown; verification: string }[])
      if (r.review !== null || r.verification !== "proposed")
        out.set(`${kind}:${r.id}`, canonical(r));
  return out;
}

/** Protected records that are missing or different after a write. */
export function changedProtectedRecords(before: Corpus, after: Corpus): string[] {
  const now = protectedRecords(after);
  const all = {
    assertion: after.assertions,
    round: after.rounds,
    agreement: after.agreements,
    acquisition: after.acquisitions,
  } as const;
  const content = (key: string) => {
    if (now.has(key)) return now.get(key);
    const [kind, ...rest] = key.split(":");
    const record = (all[kind as keyof typeof all] as { id: string }[]).find(
      (r) => r.id === rest.join(":"),
    );
    return record ? canonical(record) : undefined;
  };
  return [...protectedRecords(before)]
    .filter(([key, value]) => content(key) !== value)
    .map(([key]) => key)
    .sort(compare);
}

/** A file's `defaults` expand into every record in it, so a migration must not change them. */
export function defaultsChanged(original: string, next: string): boolean {
  const defaults = (text: string) =>
    canonical((parseDocument(text).toJS() as { defaults?: unknown } | null)?.defaults ?? null);
  return defaults(original) !== defaults(next);
}
/** Explicit apply only. History is immutable; a stale bundle never authorizes new content. */
export async function applyMigrationBundle(
  bundle: MigrationBundle,
  expectedHash: string,
  outputPath: string,
): Promise<void> {
  const { hash, ...payload } = bundle;
  if (hash !== expectedHash || digest(payload) !== hash) throw new Error("Migration hash mismatch");
  const output = await assertOutputPath(outputPath);
  if (!output.split(/[\\/]/).includes("research-cache"))
    throw new Error("Migration output must be inside research-cache/");
  if ((await createMigrationBundle(bundle.research, bundle.imported)).hash !== hash)
    throw new Error("Stale migration: regenerate the dry run");
  if (
    bundle.plan.changes.some((c) => c.blocked && c.action !== "unchanged" && c.action !== "missing")
  )
    throw new Error("Migration touches a reviewed or non-proposed record");
  const loaded = loadResearchCorpus(bundle.research);
  if (!loaded.corpus) throw new Error("Invalid research corpus");
  const sources = new Set(loaded.corpus.sources.map((s) => s.id));
  const orgs = new Set(loaded.corpus.organizations.map((o) => o.id));
  const changes = bundle.plan.changes.filter(
    (c) => !c.blocked && !["candidate", "missing", "unchanged"].includes(c.action),
  );
  const removing = new Set(changes.flatMap((c) => c.oldIds));
  const guarded = protectedRecords(loaded.corpus);
  for (const id of removing)
    if (guarded.has(`agreement:${id}`))
      throw new Error(`Migration would remove a reviewed or non-proposed record: ${id}`);
  const adding = new Set(changes.flatMap((c) => c.newIds));
  const replacements = bundle.plan.replacements.filter((a) => adding.has(a.id));
  const remaining = new Set([
    ...loaded.corpus.agreements.filter((a) => !removing.has(a.id)).map((a) => a.id),
    ...replacements.map((a) => a.id),
  ]);
  for (const alias of bundle.plan.aliases)
    if (resolveAlias(alias.from, bundle.plan.aliases).some((id) => !remaining.has(id)))
      throw new Error(`Dangling alias: ${alias.from}`);
  const touched = new Set<string>();
  for (const id of removing) {
    const origin = loaded.origins.get(id);
    if (!origin) throw new Error(`Missing origin: ${id}`);
    touched.add(origin.file);
  }
  const byFile = new Map<string, Agreement[]>();
  for (const a of replacements) {
    Agreement.parse(a);
    if (a.review !== null || a.verification !== "proposed")
      throw new Error("Only plain proposals may be applied");
    if (
      a.evidence.some((e) => !sources.has(e.sourceId)) ||
      a.parties.some((p) => !orgs.has(p.orgId))
    )
      throw new Error(`Unregistered source or party: ${a.id}`);
    const recipients = a.parties.filter((p) => p.role === "prime" || p.role === "recipient");
    const origin = recipients.length === 1 && loaded.origins.get(recipients[0]!.orgId);
    if (!origin) throw new Error(`No unique recipient file: ${a.id}`);
    touched.add(origin.file);
    byFile.set(origin.file, [...(byFile.get(origin.file) ?? []), a]);
  }
  const originals = await filesUnder(bundle.research),
    writes = new Map<string, string>();
  for (const file of [...touched].sort(compare)) {
    // Files with reviewed records are allowed; those records are compared after the write below.
    const doc = parseDocument(originals[file]!);
    if (!isMap(doc.contents)) throw new Error(`Invalid mapping: ${file}`);
    const seq = doc.get("agreements", true);
    if (seq !== undefined && !isSeq(seq)) throw new Error(`Invalid agreement list: ${file}`);
    if (isSeq(seq))
      for (let i = seq.items.length - 1; i >= 0; i--) {
        const node = seq.items[i];
        if (isMap(node) && removing.has(String(node.get("id")))) seq.delete(i);
      }
    if (!isSeq(seq)) doc.set("agreements", []);
    const target = doc.get("agreements", true);
    if (!isSeq(target)) throw new Error("Expected agreement sequence");
    for (const a of byFile.get(file) ?? []) target.add(doc.createNode(a));
    const text = doc.toString();
    if (defaultsChanged(originals[file]!, text))
      throw new Error(`Migration would change the defaults block: ${file}`);
    writes.set(file, text);
  }
  const aliasText = canonical({ version: 1, aliases: bundle.plan.aliases }) + "\n";
  if (originals[ALIAS_FILE] !== aliasText) writes.set(ALIAS_FILE, aliasText);
  if (!writes.size) return;
  const lock = join(bundle.research, ".gov-linkage.lock");
  await writeFile(lock, hash, { flag: "wx" });
  const applied: string[] = [];
  try {
    if ((await createMigrationBundle(bundle.research, bundle.imported)).hash !== hash)
      throw new Error("Stale migration after acquiring lock");
    const history = join(output, "history", hash);
    if ((await assertOutputPath(history)).toLowerCase() !== history.toLowerCase())
      throw new Error("Refusing linked history directory");
    await mkdir(dirname(history), { recursive: true });
    await mkdir(history); // Never overwrite an earlier attempt's history.
    for (const file of writes.keys())
      if (originals[file] !== undefined) {
        await mkdir(dirname(join(history, file)), { recursive: true });
        await writeFile(join(history, file), originals[file]!, { flag: "wx" });
      }
    await writeFile(join(history, "migration.json"), canonical(bundle) + "\n", { flag: "wx" });
    for (const [file, content] of writes) {
      const current = await readFile(join(bundle.research, file), "utf8").catch(
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return undefined;
          throw e;
        },
      );
      if (current !== originals[file]) throw new Error(`Concurrent edit: ${file}`);
      await writeReviewOutputs(dirname(join(bundle.research, file)), {
        [relative(dirname(file), file)]: content,
      });
      applied.push(file);
    }
    const after = loadResearchCorpus(bundle.research);
    if (!after.corpus) throw new Error("Applied corpus did not validate");
    // Approvals are bound to content: any difference in a reviewed record undoes the whole apply.
    const changed = changedProtectedRecords(loaded.corpus, after.corpus);
    if (changed.length)
      throw new Error(`Migration would change reviewed records: ${changed.join(", ")}`);
    await writeFile(join(history, "complete.json"), canonical({ hash, files: applied }) + "\n", {
      flag: "wx",
    });
  } catch (error) {
    for (const file of applied.reverse()) {
      if ((await readFile(join(bundle.research, file), "utf8")) !== writes.get(file))
        throw new Error(`Concurrent edit prevents rollback; restore from history: ${file}`, {
          cause: error,
        });
      if (originals[file] === undefined) await unlink(join(bundle.research, file));
      else
        await writeReviewOutputs(dirname(join(bundle.research, file)), {
          [relative(dirname(file), file)]: originals[file]!,
        });
    }
    throw error;
  } finally {
    await unlink(lock);
  }
}
export function renderMigration(bundle: MigrationBundle): string {
  return [
    "# Government linkage migration — DRY RUN",
    "",
    `Plan hash: ${bundle.hash}`,
    "",
    "Apply only after the owner's review. No approval is carried to changed content.",
    "",
    `Reviewed records: ${bundle.plan.reviewedIds.join(", ") || "none"}`,
    `Linked rows: ${bundle.newLinks.length}; candidates: ${bundle.candidates.length}.`,
    "",
    ...bundle.plan.changes.map(
      (c) =>
        `- ${c.action}${c.blocked ? " [BLOCKED]" : ""}: ${c.oldIds.join(", ") || "new"} → ${c.newIds.join(", ") || "absent"}; fields: ${c.fields.join(", ") || "none"}. ${c.reason}`,
    ),
    "",
    "Full row decisions, hashes, aliases and unresolved cases are in migration.json.",
    "",
  ].join("\n");
}
