/**
 * Quality-control sample of cleared records (policy section 7). Deterministic: seeded by the
 * batch hash, so nobody can choose the sample. Risk-weighted on top of a random floor:
 * - random: max(QC.randomMin, QC.randomFraction of cleared), spread across classes;
 * - the highest-value cleared events (a wrong big number does the most harm);
 * - records whose only corroboration re-read the same document CANDEF cites;
 * - records cleared under the original-authority rule (no corroboration at all);
 * - at least QC.perResearcherMin per researcher whose finding cleared a record, so one model's
 *   shared failure pattern shows up in the audit.
 * A record is drawn once, with every reason it was drawn.
 */
import { createHash } from "node:crypto";
import type { Corpus } from "../../../src/domain/schema/corpus";
import { QC } from "./policy";
import type { ClearanceRecord } from "./route";

export interface QcPick {
  id: string;
  reasons: string[];
}

function rank(seed: string, id: string): string {
  return createHash("sha256").update(`${seed}|${id}`).digest("hex");
}

export function qcSample(records: ClearanceRecord[], corpus: Corpus, seed: string): QcPick[] {
  const cleared = records.filter((r) => r.state === "cleared");
  const picks = new Map<string, Set<string>>();
  const pick = (id: string, why: string) => {
    if (!picks.has(id) && picks.size >= QC.cap) return;
    picks.set(id, (picks.get(id) ?? new Set()).add(why));
  };
  const ordered = (list: ClearanceRecord[]) =>
    [...list].sort((a, b) => rank(seed, a.id).localeCompare(rank(seed, b.id)));

  // Risk-weighted first (capped individually), then the random floor.
  const amount = (r: ClearanceRecord): number => {
    const round = corpus.rounds.find((x) => x.id === r.id);
    if (round) return Math.max(0, ...round.disclosures.map((d) => Number(d.amount.amount ?? 0)));
    const g = corpus.agreements.find((x) => x.id === r.id) as
      { currentValue?: { amount?: string | null } } | undefined;
    return Number(g?.currentValue?.amount ?? 0);
  };
  [...cleared]
    .filter((r) => r.cls === "K3")
    .sort((a, b) => amount(b) - amount(a))
    .slice(0, QC.highValueTop)
    .forEach((r) => pick(r.id, "high value"));
  ordered(
    cleared.filter((r) =>
      r.checks.some(
        (c) => c.id === "V-ind" && c.result === "pass" && /same document/.test(c.reason),
      ),
    ),
  )
    .slice(0, QC.sameOriginMax)
    .forEach((r) => pick(r.id, "corroboration re-read CANDEF's own source"));
  ordered(cleared.filter((r) => r.checks.some((c) => c.id === "V-ind" && c.result === "waived")))
    .slice(0, QC.authorityOnlyMax)
    .forEach((r) => pick(r.id, "cleared on an official record without corroboration"));
  const researchers = new Set(
    cleared.flatMap((r) =>
      r.relations.filter((x) => x.relation === "supports").map((x) => x.researcher),
    ),
  );
  for (const res of researchers)
    ordered(
      cleared.filter((r) =>
        r.relations.some((x) => x.relation === "supports" && x.researcher === res),
      ),
    )
      .slice(0, QC.perResearcherMin)
      .forEach((r) => pick(r.id, `cleared with ${res}'s support`));
  const want = QC.calibration
    ? QC.cap
    : Math.max(QC.randomMin, Math.ceil(cleared.length * QC.randomFraction));
  // Spread the random part across classes in proportion, at least one per class present.
  const classes = [...new Set(cleared.map((r) => r.cls))];
  for (const cls of classes) {
    const pool = ordered(cleared.filter((r) => r.cls === cls));
    const n = Math.max(1, Math.round((want * pool.length) / Math.max(1, cleared.length)));
    pool.slice(0, n).forEach((r) => pick(r.id, "random"));
  }
  // Calibration: top up to the cap with random records not drawn yet.
  if (QC.calibration)
    for (const r of ordered(cleared)) {
      if (picks.size >= Math.min(QC.cap, cleared.length)) break;
      if (!picks.has(r.id)) pick(r.id, "random (calibration)");
    }
  return [...picks.entries()].map(([id, why]) => ({ id, reasons: [...why] }));
}

/**
 * What a clean audit supports: with zero errors in n audited records, the error rate is below
 * 3/n with about 95% confidence ("rule of three"). Cumulative across batches it tightens.
 */
export function cleanAuditBound(n: number): number | null {
  return n > 0 ? Math.min(1, 3 / n) : null;
}
