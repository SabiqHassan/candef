/**
 * Snapshot rollback (ARCHITECTURE §8, D-18): re-points manifest.json at the previous snapshot.
 * Usage: npm run data:rollback -- <demo|research> [--dir public/data/<dataset>]
 *
 * Snapshots are content-addressed and immutable, so rolling back only switches the pointer. The
 * snapshot rolled away from stays at the front of `previous`, so the step can be reversed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Snapshot, SnapshotManifest } from "../src/domain/schema/snapshot";
import { writeFileAtomic } from "./atomic";

export function rollback(outDir: string): SnapshotManifest {
  const manifestPath = join(outDir, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`no manifest in ${outDir}`);
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
  const [target, ...rest] = m.previous;
  if (!target) throw new Error("no previous snapshot to roll back to");
  const file = join(outDir, target);
  if (!existsSync(file))
    throw new Error(`previous snapshot ${target} is missing; not rolling back`);
  const snap = JSON.parse(readFileSync(file, "utf8")) as Pick<Snapshot, "meta">;
  const next: SnapshotManifest = {
    current: target,
    schemaVersion: snap.meta.schemaVersion,
    isDemo: snap.meta.isDemo,
    builtAt: snap.meta.builtAt,
    previous: [m.current, ...rest].slice(0, 3),
  };
  writeFileAtomic(manifestPath, JSON.stringify(next, null, 2));
  return next;
}

if (process.argv[1]?.endsWith("rollback.ts")) {
  const dataset = process.argv[2];
  if (dataset !== "demo" && dataset !== "research") {
    console.error("usage: npm run data:rollback -- <demo|research> [--dir <dir>]");
    process.exit(1);
  }
  const i = process.argv.indexOf("--dir");
  const dir = resolve(i > 0 ? process.argv[i + 1]! : join("public", "data", dataset));
  try {
    const m = rollback(dir);
    console.log(
      `${dataset}: now serving ${m.current} (built ${m.builtAt}); previous: ${m.previous.join(", ")}`,
    );
  } catch (e) {
    console.error(`rollback refused: ${(e as Error).message}`);
    process.exit(1);
  }
}
