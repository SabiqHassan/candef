/**
 * The same formatting check CI runs (`prettier --check .`), limited to the research folder, so a
 * researcher sees it in `candef validate` before committing instead of in a failed CI run.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as prettier from "prettier";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

/** Files under `root` that `prettier --check` would report, relative to `root`. */
export async function unformattedFiles(root: string, repoRoot = process.cwd()): Promise<string[]> {
  const ignorePath = resolve(repoRoot, ".prettierignore");
  const out: string[] = [];
  for (const file of walk(root)) {
    const info = await prettier.getFileInfo(file, { ignorePath });
    if (info.ignored || !info.inferredParser) continue;
    const options = { ...(await prettier.resolveConfig(file)), filepath: file };
    if (!(await prettier.check(readFileSync(file, "utf8"), options)))
      out.push(relative(root, file).replace(/\\/g, "/"));
  }
  return out;
}
