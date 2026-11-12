/**
 * Shapes shared by the leads search: the query, a lead card, claims with sources, and the final
 * answer. Zod is the source of truth; the tool schemas for API mode are generated from it.
 *
 * Rules the shapes enforce (P-36): a claim without a source cannot be built, and a lead is always
 * labelled as an unverified lead from public government data. "Unknown", "not found" and "not
 * researched" are different states and are kept apart.
 */
import { z } from "zod";

export const LEAD_LABEL = "Unverified lead from public government data" as const;

export { SearchQuery, type SearchQueryInput } from "../../../../../src/domain/leads/query";

export const GovGrantSource = z.object({
  kind: z.literal("gov_grant"),
  key: z.string(),
  line: z.number().int().min(0),
  date: z.string(),
  department: z.string(),
  programme: z.string(),
  value: z.number(),
  ref: z.string(),
});
export const GovContractSource = z.object({
  kind: z.literal("gov_contract"),
  key: z.string(),
  line: z.number().int().min(0),
  date: z.string(),
  department: z.string(),
  category: z.string(),
  value: z.number(),
  ref: z.string(),
});
export const WebSource = z.object({
  kind: z.literal("web"),
  url: z.string().url(),
  title: z.string(),
  accessed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export const Source = z.discriminatedUnion("kind", [GovGrantSource, GovContractSource, WebSource]);
export type Source = z.infer<typeof Source>;
export type GovSource = z.infer<typeof GovGrantSource> | z.infer<typeof GovContractSource>;

/** A statement shown to a reader. It cannot exist without at least one source. */
export const Claim = z.object({
  text: z.string().min(1),
  sources: z.array(Source).min(1),
});
export type Claim = z.infer<typeof Claim>;

export const UnknownField = z.object({
  field: z.string(),
  state: z.enum(["unknown", "not_found", "not_researched"]),
  note: z.string().optional(),
});
export type UnknownField = z.infer<typeof UnknownField>;

export const Tier = z.enum(["A", "B", "C", "D"]);

export const LeadCard = z.object({
  key: z.string(),
  name: z.string(),
  location: z.string(),
  tier: Tier,
  tierRules: z.array(z.string()),
  tags: z.array(z.string()),
  firstSeen: z.string().nullable(),
  firstGrantDate: z.string().nullable(),
  firstTimeGrantRecipient: z.boolean(),
  totals: z.object({
    grantCount: z.number(),
    contractCount: z.number(),
    grantValue: z.number(),
    contractValue: z.number(),
    dndContractValue: z.number(),
    csaValue: z.number(),
  }),
  triage: z.object({
    verdict: z.enum(["yes", "no", "unsure"]).nullable(),
    reason: z.string(),
    judgeSaidNo: z.boolean(),
  }),
  matchedOn: z.array(
    z.object({
      field: z.enum(["name", "reason", "line"]),
      line: z.number().optional(),
      terms: z.array(z.string()),
    }),
  ),
  score: z.number(),
  claims: z.array(Claim),
  unknowns: z.array(UnknownField),
  label: z.literal(LEAD_LABEL),
});
export type LeadCard = z.infer<typeof LeadCard>;

export const AnswerLead = z.object({
  key: z.string(),
  name: z.string(),
  tier: Tier,
  whyMatched: z.string().min(1),
  claims: z.array(Claim).min(1),
  unknowns: z.array(UnknownField),
});
export type AnswerLead = z.infer<typeof AnswerLead>;

export const Answer = z.object({
  question: z.string(),
  summary: z
    .string()
    .describe("One to three sentences; every fact in it is also a cited claim of a lead."),
  leads: z.array(AnswerLead).max(100),
  searchesRun: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
  label: z.literal(LEAD_LABEL),
});
export type Answer = z.infer<typeof Answer>;

export const GetCompanyArgs = z.object({ key: z.string().min(1) });
export const WebLookupArgs = z.object({ name: z.string().min(1), question: z.string().min(1) });
