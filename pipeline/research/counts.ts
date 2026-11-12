import type { Corpus } from "../../src/domain/schema/corpus";

/** Records awaiting the owner: facts, rounds, agreements and acquisitions (one rule for every report). */
export function proposedRecordCount(c: Corpus): number {
  return [...c.assertions, ...c.rounds, ...c.agreements, ...c.acquisitions].filter(
    (r) => r.verification === "proposed",
  ).length;
}
