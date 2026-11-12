/**
 * Replace a file all at once: write a temporary file next to it, then rename over the target. A
 * reader (the site, a rollback, a build) sees either the old file or the new one, never half of a
 * file, even if the process dies mid-write. The snapshot manifest is the publish step, so it must
 * never be torn (ARCHITECTURE §8).
 */
import { renameSync, rmSync, writeFileSync } from "node:fs";

export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    // Windows can refuse to replace a file that another process holds open for a moment. Fall back
    // to a plain write rather than failing the publish; the temporary file never survives.
    rmSync(tmp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw e;
    writeFileSync(path, data);
  }
}
