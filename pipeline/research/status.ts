/**
 * Pilot progress at a glance (`candef status`): per company, the eligibility decision, the state of
 * each research topic, how many records await review, and whether it is published.
 */
import type { Corpus } from "../../src/domain/schema/corpus";
import { compile } from "../compile/compile";
import { FactIndex } from "../compile/facts";

export interface CompanyStatus {
  id: string;
  name: string;
  eligibility: string;
  topics: Record<"identity" | "financing" | "agreements" | "eligibility", string>;
  proposed: number;
  published: boolean;
}

const TOPICS = ["identity", "financing", "agreements", "eligibility"] as const;

export function pilotStatus(corpus: Corpus, today: string): CompanyStatus[] {
  const facts = new FactIndex(corpus, today);
  const result = compile(corpus, { today });
  const published = new Set(
    (result.snapshot?.organizations ?? []).filter((o) => o.scope === "universe").map((o) => o.id),
  );
  return corpus.organizations
    .filter((o) => o.kind === "company" && !o.mergedInto)
    .map((o) => {
      const elig = facts.fact<{ decision: string }>(o.id, "eligibility");
      const proposed =
        corpus.assertions.filter((a) => a.subjectId === o.id && a.verification === "proposed")
          .length +
        corpus.rounds.filter((r) => r.companyId === o.id && r.verification === "proposed").length +
        corpus.agreements.filter(
          (g) => g.verification === "proposed" && g.parties.some((p) => p.orgId === o.id),
        ).length;
      const topics = Object.fromEntries(
        TOPICS.map((t) => {
          const r = facts.researchState(o.id, t);
          return [
            t,
            r.state === "not_researched"
              ? "—"
              : r.state === "stale"
                ? "stale"
                : r.outcome === "none_found"
                  ? "none"
                  : r.outcome === "partial"
                    ? "partial"
                    : "done",
          ];
        }),
      ) as CompanyStatus["topics"];
      return {
        id: o.id,
        name: o.name,
        eligibility:
          elig.state === "verified"
            ? (elig.value?.decision ?? "?")
            : elig.state === "unconfirmed"
              ? "proposed"
              : "—",
        topics,
        proposed,
        published: published.has(o.id),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function formatStatus(rows: CompanyStatus[]): string {
  const header = [
    "Company",
    "Eligibility",
    "Identity",
    "Financing",
    "Agreements",
    "Elig. research",
    "Proposed",
    "Published",
  ];
  const lines = rows.map((r) => [
    r.name,
    r.eligibility,
    r.topics.identity,
    r.topics.financing,
    r.topics.agreements,
    r.topics.eligibility,
    String(r.proposed),
    r.published ? "yes" : "no",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...lines.map(fmt)].join("\n");
}
