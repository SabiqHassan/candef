import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertOutputPath } from "./cli";
import { createMigrationBundle, applyMigrationBundle, renderMigration } from "./reconcile";
import type { MigrationBundle } from "./reconcile";
import { writeReviewOutputs } from "./output";
import { canonical } from "./locators";

export async function runReconcile(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      research: { type: "string" },
      imported: { type: "string" },
      out: { type: "string" },
      apply: { type: "boolean", default: false },
      plan: { type: "string" },
      "expect-hash": { type: "string" },
    },
  });
  if (!values.out) throw new Error("Supply --out research-cache/<directory>");
  const output = await assertOutputPath(values.out);
  if (!output.split(/[\\/]/).includes("research-cache"))
    throw new Error("Output must be inside research-cache/");
  if (values.apply) {
    if (!values.plan || !values["expect-hash"] || values.research || values.imported)
      throw new Error("Apply requires --plan and --expect-hash; paths come from the reviewed plan");
    const bundle = JSON.parse(await readFile(values.plan, "utf8")) as MigrationBundle;
    await applyMigrationBundle(bundle, values["expect-hash"], output);
    return bundle;
  }
  if (!values.research || !values.imported || values.plan || values["expect-hash"])
    throw new Error("Dry run requires --research and --imported");
  const bundle = await createMigrationBundle(values.research, values.imported);
  await mkdir(output, { recursive: true });
  await writeReviewOutputs(output, {
    ".gitignore": "*\n",
    "migration.json": canonical(bundle) + "\n",
    "migration.md": renderMigration(bundle),
  });
  return bundle;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runReconcile(process.argv.slice(2))
    .then((b) =>
      process.stdout.write(
        `Migration ${b.hash}: ${b.plan.changes.length} components; ${b.plan.reviewedIds.length} reviewed records.\n`,
      ),
    )
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    });
}
