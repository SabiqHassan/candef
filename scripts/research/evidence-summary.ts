/**
 * Plain-language evidence summaries for the owner's review (P-37, P-38).
 *
 * Reads the proposed research corpus and prints, per company, what the records say and what they
 * rest on: the eligibility decision and rationale as written in the record, headquarters, how many
 * government agreements by funder and program, financing rounds, and the research ledger. It
 * states only what the records contain (no new facts, no source excerpts) and never approves or
 * changes anything.
 *
 *   npx tsx scripts/research/evidence-summary.ts <slug> [<slug>…] > out.md
 *   npx tsx scripts/research/evidence-summary.ts --weak > docs/research/weak-inclusions.md
 */
import { resolve } from "node:path";
import { loadResearchCorpus } from "../../pipeline/research/load";
import type { Agreement, Corpus, Organization } from "../../src/domain/schema/corpus";

const WEAK = [
  "sarcomere-dynamics",
  "sanctuary-cognitive-systems",
  "anyon-systems",
  "solace-power",
  "rutter",
  "wolf-advanced-technology-canada",
  "octasic",
  "spacebridge",
];

const cad = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0,
});

function agreementValue(a: Agreement): number | null {
  const last = a.disclosureRows[a.disclosureRows.length - 1];
  const v = last?.totalValue ?? a.valueStatements[0]?.money.amount ?? null;
  return v === null ? null : Number(v);
}

function summarize(corpus: Corpus, org: Organization): string[] {
  const out: string[] = [];
  const name = (id: string) => corpus.organizations.find((o) => o.id === id)?.name ?? id;
  const facts = corpus.assertions.filter((a) => a.subjectId === org.id);
  const fact = (p: string) => facts.filter((a) => a.predicate === p);
  const sourceIds = new Set<string>();
  for (const a of facts) for (const e of a.evidence) sourceIds.add(e.sourceId);

  const elig = fact("eligibility")[0]?.value as
    { decision?: string; rationale?: string } | undefined;
  const hq = fact("hq_location")[0]?.value as
    { city?: string | null; province?: string; country?: string } | undefined;
  const legal = fact("legal_name")[0]?.value as string | undefined;
  out.push(`## ${org.name}`, "");
  out.push(`- **Legal name on record:** ${legal ?? "not recorded"}`);
  out.push(
    `- **Headquarters on record:** ${hq ? [hq.city, hq.province, hq.country].filter(Boolean).join(", ") : "not recorded"}`,
  );
  out.push(
    `- **Eligibility (analyst interpretation, proposed):** ${elig?.decision ?? "not recorded"}`,
  );
  if (elig?.rationale) out.push("", `> ${elig.rationale.replace(/\s+/g, " ").trim()}`);

  const agreements = corpus.agreements.filter((a) => a.parties.some((p) => p.orgId === org.id));
  out.push("", `### Government agreements (${agreements.length})`, "");
  if (!agreements.length) out.push("None recorded.");
  else {
    const groups = new Map<string, Agreement[]>();
    for (const a of agreements) {
      const funder = a.parties.find((p) => ["buyer", "funder"].includes(p.role));
      const program =
        corpus.programs.find((p) => p.id === a.programId)?.name ??
        a.externalIds.find((x) => x.system === "tbs-grants:program")?.value ??
        "no program recorded";
      const key = `${funder ? name(funder.orgId) : "unknown funder"} | ${a.family === "procurement" ? "procurement contract" : a.family === "grant_contribution" ? "grant or contribution" : a.family === "other_transfer" ? "other transfer payment (neither grant nor purchase)" : a.family} | ${program}`;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    out.push(
      "| Funder | Kind | Program | Count | Value (CAD, as disclosed) | Named as recipient |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const [key, list] of [...groups].sort()) {
      const [funder, kind, program] = key.split(" | ");
      const values = list.map(agreementValue).filter((v): v is number => v !== null);
      const total = values.reduce((s, v) => s + v, 0);
      const cadOnly = list.every((a) => a.currency === "CAD");
      const named = list.filter((a) =>
        a.parties.some((p) => p.orgId === org.id && p.evidenceStrength === "named_in_description"),
      ).length;
      out.push(
        `| ${funder} | ${kind} | ${program} | ${list.length} | ${values.length ? (cadOnly ? cad.format(total) : `${total} (mixed currencies)`) : "not stated"} | ${named ? `${named} by description only` : "party of record"} |`,
      );
    }
  }

  const dnd = agreements.filter((a) =>
    a.parties.some(
      (p) => ["buyer", "funder"].includes(p.role) && name(p.orgId) === "National Defence",
    ),
  ).length;
  out.push(
    "",
    `Agreement records with National Defence as buyer or funder: **${dnd}**. If the rationale above cites defence-program rows (IDEaS, RDII, SADI) that are not in this table, those rows are evidence for the eligibility judgement only and are not yet agreement records.`,
  );

  const rounds = corpus.rounds.filter((r) => r.companyId === org.id);
  out.push("", `### Financing rounds recorded: ${rounds.length}`, "");
  for (const r of rounds)
    out.push(`- ${r.label ?? r.stage ?? "Round"}, ${r.date ?? "date not stated"}`);

  const ledger = corpus.research.filter((r) => r.subjectId === org.id);
  out.push("", "### Research ledger", "");
  if (!ledger.length) out.push("No entries.");
  for (const l of ledger)
    out.push(`- ${l.topic}: ${l.outcome} (${l.at}; ${l.sourcesSearched.length} sources searched)`);
  out.push("", `Distinct sources cited by the company's own facts: ${sourceIds.size}.`, "");
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const slugs = args.includes("--weak") ? WEAK : args.filter((a) => !a.startsWith("--"));
  const loaded = loadResearchCorpus(resolve("research"));
  if (!loaded.corpus) {
    console.error(loaded.issues.map((i) => `${i.file}: ${i.message}`).join("\n"));
    process.exit(1);
  }
  const lines: string[] = [
    "# Evidence summaries for the owner's review",
    "",
    "Generated by `scripts/research/evidence-summary.ts` from the proposed corpus. It restates what the records contain; it adds no facts and approves nothing. Every number below is traceable in the company's file under `research/orgs/`; open the sources in the review report (`candef report`).",
    "",
    "**Data caveat (found while generating this):** the program column is the name TBS published with each grant (the importer keeps it on the record). Department coverage was completed on 2026-10-14 (CED, ACOA and eight others added), so RDII rows now appear as agreements.",
    "",
    "**Reading the table:** defence-program funding (IDEaS, RDII, SADI) shows the company took part in a program run by or for government. It is not a procurement contract or a customer relationship (P-38).",
    "",
  ];
  for (const slug of slugs) {
    const org = loaded.corpus.organizations.find((o) => o.slug === slug);
    if (!org) {
      lines.push(`## ${slug}`, "", "No record with this slug.", "");
      continue;
    }
    lines.push(...summarize(loaded.corpus, org));
  }
  console.log(lines.join("\n"));
}

main();
