/**
 * Corrections and takedowns (ARCHITECTURE §8, docs/CORRECTIONS.md).
 *
 * OWNER ONLY, like review: retracting changes what the public sees. `candef retract` requires an
 * interactive terminal; tests use temporary synthetic corpora.
 *
 * A retraction sets `verification: retracted` (the compiler never publishes it) and appends an entry
 * to research/takedowns.yaml. The `takedown-respected` gate then fails any build in which a logged
 * ID is publishable again; assertion IDs derive from content, so re-adding the same fact is caught.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isSeq, parse, parseDocument, type YAMLSeq } from "yaml";
import { z } from "zod";
import type { Corpus } from "../../src/domain/schema/corpus";
import { AuthoringError } from "./authoring";
import { loadResearchCorpus } from "./load";
import { NOT_A_REVIEWER } from "./review";

export const Takedown = z.object({
  date: z.string(),
  ids: z.array(z.string()).min(1),
  /** Why, in plain words. Never personal details of whoever asked. */
  reason: z.string().min(3),
  by: z.string(),
});
export type Takedown = z.infer<typeof Takedown>;

export const TAKEDOWN_FILE = "takedowns.yaml";

export function readTakedowns(root: string): Takedown[] {
  const file = join(root, TAKEDOWN_FILE);
  if (!existsSync(file)) return [];
  return z.array(Takedown).parse(parse(readFileSync(file, "utf8")) ?? []);
}

/** Gate: nothing in the takedown log may be publishable. */
export function takedownFailures(corpus: Corpus, takedowns: Takedown[]) {
  const logged = new Set(takedowns.flatMap((t) => t.ids));
  const live = [
    ...corpus.assertions,
    ...corpus.rounds,
    ...corpus.agreements,
    ...corpus.acquisitions,
  ].filter((r) => logged.has(r.id) && r.verification === "verified");
  return live.length
    ? [
        {
          gate: "takedown-respected",
          message: "Records in research/takedowns.yaml are publishable again; retract them",
          ids: live.map((r) => r.id),
        },
      ]
    : [];
}

export function retractRecords(
  root: string,
  req: { ids: string[]; by: string; at: string; reason: string },
): { retracted: string[] } {
  if (!req.by.trim() || NOT_A_REVIEWER.test(req.by))
    throw new AuthoringError(`"${req.by}" cannot retract records; takedowns are the owner's`);
  const entry = Takedown.parse({ date: req.at, ids: req.ids, reason: req.reason, by: req.by });
  const loaded = loadResearchCorpus(root);
  if (!loaded.corpus)
    throw new AuthoringError("research/ does not validate; run `candef validate`");

  const edits = new Map<string, ReturnType<typeof parseDocument>>();
  for (const id of req.ids) {
    const origin = loaded.origins.get(id);
    const known = [
      ...loaded.corpus.assertions,
      ...loaded.corpus.rounds,
      ...loaded.corpus.agreements,
      ...loaded.corpus.acquisitions,
    ].some((r) => r.id === id);
    if (!origin || !known) throw new AuthoringError(`unknown or unretractable record ${id}`);
    if (!edits.has(origin.file))
      edits.set(origin.file, parseDocument(readFileSync(join(root, origin.file), "utf8")));
    const node = edits.get(origin.file)!.getIn(origin.path, true);
    if (!isMap(node))
      throw new AuthoringError(`${origin.file}:${origin.path.join(".")} is not a mapping`);
    node.set("verification", "retracted");
  }
  for (const [file, doc] of edits) writeFileSync(join(root, file), doc.toString());

  const logFile = join(root, TAKEDOWN_FILE);
  const log = parseDocument(existsSync(logFile) ? readFileSync(logFile, "utf8") : "[]\n");
  if (!isSeq(log.contents)) throw new AuthoringError(`${TAKEDOWN_FILE} must be a list`);
  const seq = log.contents as YAMLSeq<unknown>;
  seq.flow = false;
  seq.add(log.createNode(entry));
  writeFileSync(logFile, log.toString());
  return { retracted: req.ids };
}
