import { randomUUID } from "node:crypto";
import { lstat, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function assertRegularOutput(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Refusing linked output: ${path}`);
    if (!stat.isFile()) throw new Error(`Refusing non-file output: ${path}`);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
}

/** Replace directory entries instead of following existing symbolic or hard links. */
export async function writeReviewOutputs(
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  for (const name of Object.keys(files)) await assertRegularOutput(join(directory, name));
  for (const [name, content] of Object.entries(files)) {
    const target = join(directory, name);
    const temporary = join(directory, `.tbs-${randomUUID()}.tmp`);
    await writeFile(temporary, content, { flag: "wx" });
    try {
      await assertRegularOutput(target);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          throw error;
      });
    }
  }
}
