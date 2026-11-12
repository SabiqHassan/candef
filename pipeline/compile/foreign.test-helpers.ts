import { generateDemoCorpus } from "../demo/generate";
import { compile } from "./compile";
import type { Agreement, Corpus } from "../../src/domain/schema/corpus";

/** Entirely fictional; used only by compiler and rendered UI tests. */
export function foreignFixture(): { corpus: Corpus; agreement: Agreement; companyId: string } {
  const corpus = generateDemoCorpus({ companies: 5 });
  const companyId = compile(corpus, { today: "2026-10-16" }).snapshot!.organizations.find(
    (o) => o.scope === "universe",
  )!.id;
  const source = {
    ...corpus.sources[0]!,
    id: "src_fictional_foreign",
    kind: "gov_disclosure" as const,
    tier: "T1" as const,
    publisher: "Fictional Foreign Agency",
    title: "Fictional award notice",
    url: "https://example.invalid/fictional-foreign-award",
    originGroup: "og:fictional-foreign",
  };
  corpus.sources.push(source);
  const evidence = [
    {
      sourceId: source.id,
      locator: "award notice, sections 1 and 2",
      locatorQuality: "body" as const,
    },
  ];
  corpus.organizations.push({
    id: "org_fictional_foreign",
    name: "Fictional Foreign Agency",
    slug: "fictional-foreign-agency",
    kind: "government_body",
    isDemo: true,
    mergedInto: null,
  });
  corpus.organizations.push({
    id: "org_fictional_unrelated_foreign",
    name: "Fictional Unrelated Agency",
    slug: "fictional-unrelated-agency",
    kind: "government_body",
    isDemo: true,
    mergedInto: null,
  });
  corpus.assertions.push({
    ...corpus.assertions[0]!,
    id: "asr_fictional_foreign_country",
    subjectId: "org_fictional_foreign",
    predicate: "hq_location",
    value: { city: null, region: null, province: null, country: "US" },
    evidence,
    verification: "verified",
    review: null,
  });
  const agreement: Agreement = {
    ...corpus.agreements[0]!,
    id: "agr_fictional_foreign",
    title: "Fictional orbital research award",
    family: "procurement",
    type: "contract_award",
    currency: "USD",
    programId: null,
    externalIds: [{ system: "fictional-agency:award", value: "FICT-001" }],
    disclosureRows: [],
    allocations: [],
    parties: [
      {
        orgId: "org_fictional_foreign",
        role: "buyer",
        evidenceStrength: "party_of_record",
        reportedName: "Fictional Foreign Agency",
      },
      {
        orgId: companyId,
        role: "prime",
        evidenceStrength: "party_of_record",
        reportedName: corpus.organizations.find((o) => o.id === companyId)!.name,
      },
    ],
    valueStatements: [
      {
        money: {
          amount: "123456",
          currency: "USD",
          disclosure: "disclosed",
          asStated: "USD 123456",
        },
        basis: { options: "unknown", taxes: "unknown", stage: "awarded" },
        evidence,
      },
    ],
    evidence,
    verification: "verified",
    review: null,
  };
  corpus.agreements = [agreement];
  return { corpus, agreement, companyId };
}
