/**
 * Research-build gates (M3-A4): a real build must contain no fixture data and no fixture approvals.
 * These run in addition to the compiler's own gates (`demo-isolation` etc.).
 */
import type { Corpus } from "../../src/domain/schema/corpus";

export interface ResearchGateFailure {
  gate: "no-fixture-data";
  message: string;
  ids: string[];
}

/** Reviews stamped by the demo sealer; they must never appear in the real corpus. */
export const FIXTURE_REVIEWER = "demo-fixture";

export function researchBuildGates(corpus: Corpus): ResearchGateFailure[] {
  const failures: ResearchGateFailure[] = [];
  const add = (message: string, ids: string[]) => {
    if (ids.length) failures.push({ gate: "no-fixture-data", message, ids });
  };
  if (corpus.isDemo) add("Corpus is marked demo", ["(corpus)"]);
  add(
    "Organizations marked demo",
    corpus.organizations.filter((o) => o.isDemo).map((o) => o.id),
  );
  add(
    "Sources pointing at fixture URLs",
    corpus.sources.filter((s) => /example\.invalid/i.test(s.url)).map((s) => s.id),
  );
  const reviewed = [
    ...corpus.assertions,
    ...corpus.rounds,
    ...corpus.rounds.flatMap((r) => [
      ...r.disclosures,
      ...r.participations.map((p, i) => ({ ...p, id: `${r.id}#p${i}` })),
    ]),
    ...corpus.agreements,
    ...corpus.acquisitions,
  ];
  add(
    "Records carrying a fixture review",
    reviewed.filter((r) => r.review?.by === FIXTURE_REVIEWER).map((r) => r.id),
  );
  add(
    "Records with demo epistemic class",
    reviewed.filter((r) => r.epistemic === "demo").map((r) => r.id),
  );
  return failures;
}
