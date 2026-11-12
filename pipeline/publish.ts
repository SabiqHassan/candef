/**
 * Shared snapshot publishing for the demo and research builds (ARCHITECTURE §8).
 *
 * Writes a content-addressed `snapshot.<hash>.json` and atomically re-points `manifest.json`
 * (each file is replaced with write-then-rename, so a crash never leaves a torn file),
 * keeping the previous snapshots for rollback.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { Snapshot, SnapshotManifest } from "../src/domain/schema/snapshot";
import { writeFileAtomic } from "./atomic";
import { LAYOUT_VERSION } from "./compile/layout";

export type Positions = Record<string, [number, number, number]>;

/** Company positions from the current snapshot, reused only within the same layout version (D-07). */
export function readPreviousPositions(outDir: string): Positions | undefined {
  const manifestPath = join(outDir, "manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SnapshotManifest;
  const file = join(outDir, manifest.current);
  if (!existsSync(file)) return undefined;
  const prev = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
  if (prev.graph?.layout?.version !== LAYOUT_VERSION) return undefined;
  return Object.fromEntries(
    Object.entries(prev.graph.positions).filter(([id]) => !id.includes(":")),
  ) as Positions;
}

export interface PublishResult {
  file: string;
  bytes: number;
  gzipBytes: number;
}

/** A preview snapshot (simulated approvals) may only be written under a `.preview` folder. */
export function assertPreviewTarget(outDir: string, snap: Pick<Snapshot, "meta">): void {
  const inPreview = resolve(outDir).split(/[\\/]/).includes(".preview");
  if (snap.meta.preview && !inPreview)
    throw new Error(
      `refusing to write a preview snapshot (simulated approvals) outside .preview/: ${outDir}`,
    );
  if (snap.meta.preview && snap.meta.audience === "share")
    throw new Error("refusing a share build of a preview snapshot");
}

export function publishSnapshot(outDir: string, snap: Snapshot): PublishResult {
  assertPreviewTarget(outDir, snap);
  mkdirSync(outDir, { recursive: true });
  const manifestPath = join(outDir, "manifest.json");
  const previous: SnapshotManifest | null = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : null;
  const json = JSON.stringify(snap);
  const file = `snapshot.${snap.meta.contentHash}.json`;
  writeFileAtomic(join(outDir, file), json);
  const manifest: SnapshotManifest = {
    current: file,
    schemaVersion: snap.meta.schemaVersion,
    isDemo: snap.meta.isDemo,
    builtAt: snap.meta.builtAt,
    previous: [previous?.current, ...(previous?.previous ?? [])]
      .filter((f): f is string => !!f && f !== file)
      .slice(0, 3),
  };
  writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
  return { file, bytes: Buffer.byteLength(json), gzipBytes: gzipSync(json).length };
}
