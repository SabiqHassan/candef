/**
 * Prints a company's proposed records with their evidence (source, capture, locator), for
 * primary-source evaluation. Read-only; prints record values and locators only (no source text).
 *
 *   npx tsx scripts/research/company-records.ts <slug> [--kinds assertion,round,acquisition]
 */
import { loadResearchCorpus } from "../../pipeline/research/load";

const slug = process.argv[2];
const kindsArg = process.argv.indexOf("--kinds");
const kinds = new Set(
  (kindsArg > 0 ? process.argv[kindsArg + 1]! : "assertion,round,acquisition,agreement").split(","),
);
const corpus = loadResearchCorpus("research").corpus!;
const org = corpus.organizations.find((o) => o.slug === slug);
if (!org) throw new Error(`no organization ${slug}`);
const name = (id: string) => corpus.organizations.find((o) => o.id === id)?.name ?? id;
const ev = (e: { sourceId: string; locator: string; captureId?: string | null }) =>
  `    ${e.sourceId}${e.captureId ? "@" + e.captureId.slice(0, 10) : ""} # ${e.locator}`;
if (kinds.has("assertion"))
  for (const a of corpus.assertions.filter((x) => x.subjectId === org.id)) {
    console.log(
      `${a.id} ${a.predicate} [${a.verification}/${a.epistemic}] ${JSON.stringify(a.value).slice(0, 240)}${a.validTo ? ` validTo ${a.validTo}` : ""}`,
    );
    a.evidence.forEach((e) => console.log(ev(e)));
  }
if (kinds.has("round"))
  for (const r of corpus.rounds.filter((x) => x.companyId === org.id)) {
    console.log(
      `${r.id} round "${r.roundLabelAsStated}" ${r.stage} ${r.instrument} [${r.verification}]`,
    );
    r.evidence.forEach((e) => console.log(ev(e)));
    for (const d of r.disclosures) {
      console.log(
        `  ${d.id} ${d.date} ${d.kind} ${d.amount.amount} ${d.amount.currency} "${d.amount.asStated}" ${d.amountBasis}`,
      );
      d.evidence.forEach((e) => console.log("  " + ev(e)));
    }
    for (const p of r.participations) {
      console.log(
        `  participant ${p.reportedName} -> ${name(p.investorId)} ${p.role} tranches ${p.disclosureIds.join(",")}`,
      );
      p.evidence.forEach((e) => console.log("  " + ev(e)));
    }
  }
if (kinds.has("acquisition"))
  for (const q of corpus.acquisitions.filter(
    (x) => x.targetId === org.id || x.acquirerId === org.id,
  )) {
    console.log(
      `${q.id} acquisition ${name(q.targetId)} by ${name(q.acquirerId)} ${JSON.stringify(q.history)} ${JSON.stringify(q.consideration)}`,
    );
    q.evidence.forEach((e) => console.log(ev(e)));
  }
if (kinds.has("agreement"))
  for (const g of corpus.agreements.filter((x) => x.parties.some((p) => p.orgId === org.id))) {
    const total = g.disclosureRows.at(-1)?.totalValue;
    console.log(
      `${g.id} ${g.family} "${g.title.slice(0, 70)}" ${g.currency} ${total} start ${g.startOn} [${g.verification}]`,
    );
  }
