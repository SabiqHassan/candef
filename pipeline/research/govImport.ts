/**
 * Connects research/ to the government-disclosure importer (M3-D4 loop):
 *
 *   research/ ──buildGovIndex──▶ entities.json + bodies.json ──importer──▶ proposed-agreements.json
 *        ▲                                                                  │ (human reads match report)
 *        └──────────────── acceptGovProposals (still `proposed`) ◀──────────┘
 *
 * Only the human-selected proposals enter research/, as proposed records awaiting owner review.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { Agreement, type Corpus } from "../../src/domain/schema/corpus";
import type { IndexEntity } from "../ingest/gov/match";
import { AuthoringError } from "./authoring";
import { loadResearchCorpus } from "./load";
import { postalFsa } from "./names";
import { existingIdentityMatches, readAliases } from "../ingest/gov/aliases";

const INACTIVE = new Set(["superseded", "retracted", "rejected", "disputed"]);

/** registry_id systems the importer understands. */
export const BN_SYSTEM = "cra-bn";
export const OWNER_ORG_SYSTEM = "tbs-owner-org";

export function buildGovIndex(corpus: Corpus): {
  entities: IndexEntity[];
  bodies: Record<string, string>;
} {
  const live = corpus.assertions.filter((a) => !INACTIVE.has(a.verification));
  const values = (subject: string, predicate: string) =>
    live.filter((a) => a.subjectId === subject && a.predicate === predicate).map((a) => a.value);
  const registry = (subject: string, system: string) =>
    (values(subject, "registry_id") as { system?: string; value?: string }[])
      .filter((v) => v?.system === system && v.value)
      .map((v) => v.value!);
  const active = corpus.organizations.filter((o) => !o.mergedInto);

  const entities: IndexEntity[] = active
    .filter((o) => o.kind === "company")
    .map((o) => ({
      orgId: o.id,
      names: [...new Set([o.name, ...(values(o.id, "legal_name") as string[])].filter(Boolean))],
      businessNumbers: registry(o.id, BN_SYSTEM),
      postalFsas: [
        ...new Set(
          [...values(o.id, "hq_location"), ...values(o.id, "operations_location")]
            .map((v) => postalFsa((v as { postalCode?: string } | null)?.postalCode))
            .filter((v): v is string => v !== null),
        ),
      ],
    }));

  const bodies: Record<string, string> = {};
  for (const o of active.filter((x) => x.kind === "government_body")) {
    for (const code of registry(o.id, OWNER_ORG_SYSTEM)) bodies[code] = o.id;
    for (const name of [o.name, ...(values(o.id, "legal_name") as string[])]) bodies[name] = o.id;
  }
  return { entities, bodies };
}

/**
 * Appends selected importer proposals to the recipient organizations' files, unchanged and still
 * `proposed`. Refuses anything pre-approved, already present, or citing an unregistered source.
 */
export function acceptGovProposals(
  root: string,
  proposalsFile: string,
  ids: string[],
): { accepted: string[] } {
  if (new Set(ids).size !== ids.length) throw new AuthoringError("Duplicate proposal selections");
  const proposals = (JSON.parse(readFileSync(proposalsFile, "utf8")) as unknown[]).map((p) =>
    Agreement.parse(p),
  );
  const loaded = loadResearchCorpus(root);
  if (!loaded.corpus)
    throw new AuthoringError("research/ does not validate; run `candef validate`");
  const corpus = loaded.corpus;
  const aliases = readAliases(root);
  if (new Set(proposals.map((p) => p.id)).size !== proposals.length)
    throw new AuthoringError("Duplicate proposal IDs");
  const sources = new Set(corpus.sources.map((s) => s.id));
  const present = new Set(corpus.agreements.map((g) => g.id));
  const byFile = new Map<string, Agreement[]>();
  for (const id of ids) {
    const g = proposals.find((p) => p.id === id);
    if (!g) throw new AuthoringError(`${id} is not in ${proposalsFile}`);
    if (g.verification !== "proposed" || g.review !== null)
      throw new AuthoringError(
        `${id} is not a plain proposal; only owner review may approve records`,
      );
    if (present.has(id)) throw new AuthoringError(`${id} is already in research/`);
    const collisions = existingIdentityMatches(
      g,
      [...corpus.agreements, ...[...byFile.values()].flat()],
      aliases,
    );
    if (collisions.length)
      throw new AuthoringError(
        `${id}: identity or alias already in research/ (${collisions.join(", ")}); use the reconciliation dry run`,
      );
    const missing = g.evidence.map((e) => e.sourceId).filter((s) => !sources.has(s));
    if (missing.length)
      throw new AuthoringError(
        `${id} cites unregistered source(s) ${[...new Set(missing)].join(", ")}; add the dataset with \`candef source add\` first`,
      );
    const recipient = g.parties.find((p) => p.role === "prime" || p.role === "recipient");
    const origin = recipient && loaded.origins.get(recipient.orgId);
    if (!origin)
      throw new AuthoringError(`${id}: recipient ${recipient?.orgId} has no file in research/`);
    byFile.set(origin.file, [...(byFile.get(origin.file) ?? []), g]);
  }
  const originals = new Map<string, string>();
  for (const [file, list] of byFile) {
    const abs = join(root, file);
    originals.set(abs, readFileSync(abs, "utf8"));
    const doc = parseDocument(originals.get(abs)!);
    if (!isMap(doc.contents)) throw new AuthoringError(`${file} is not a mapping`);
    let seq = doc.get("agreements", true);
    if (seq === undefined || seq === null) {
      doc.set("agreements", doc.createNode([]));
      seq = doc.get("agreements", true);
    }
    if (!isSeq(seq)) throw new AuthoringError(`${file}: agreements must be a list`);
    seq.flow = false;
    for (const g of list) seq.add(doc.createNode(g));
    writeFileSync(abs, doc.toString());
  }
  const after = loadResearchCorpus(root);
  if (!after.corpus) {
    for (const [abs, text] of originals) writeFileSync(abs, text);
    throw new AuthoringError(
      `research/ would no longer validate (edits reverted): ${after.issues.map((i) => `${i.file}:${i.path} ${i.message}`).join("; ")}`,
    );
  }
  return { accepted: ids };
}
