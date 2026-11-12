/**
 * Zod schemas for the lead-search data file. Used when the file is written (pipeline) and in tests;
 * NOT imported by the site (see siteTypes.ts). The `satisfies` lines make the compiler prove the
 * schemas and the plain types describe the same data.
 */
import { z } from "zod";
import {
  LEADS_FILE_VERSION,
  LEADS_LABEL,
  type LeadsFile as LeadsFileType,
  type SiteLead as SiteLeadType,
  type SiteLine as SiteLineType,
} from "./siteTypes";
import { TAG_IDS } from "./vocabulary";

export { LEADS_FILE_VERSION, LEADS_LABEL, recordUrl, RULE_TEXT, ruleText } from "./siteTypes";

export const SiteLineSchema = z.object({
  kind: z.enum(["grant", "contract"]),
  date: z.string(),
  department: z.string(),
  ownerOrg: z.string(),
  programme: z.string(),
  title: z.string(),
  description: z.string(),
  value: z.number(),
  ref: z.string(),
  tags: z.array(z.enum(TAG_IDS)),
}) satisfies z.ZodType<SiteLineType>;

export const SiteLeadSchema = z.object({
  key: z.string(),
  name: z.string(),
  otherNames: z.array(z.string()),
  businessNumber: z.string().nullable(),
  cities: z.array(z.string()),
  provinces: z.array(z.string()),
  tier: z.enum(["A", "B", "C", "D"]),
  tags: z.array(z.enum(TAG_IDS)),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
  firstGrantDate: z.string().nullable(),
  firstTimeGrantRecipient: z.boolean(),
  grantAgreements: z.number(),
  grantCount: z.number(),
  contractCount: z.number(),
  grantValue: z.number(),
  contractValue: z.number(),
  dndContractValue: z.number(),
  csaValue: z.number(),
  reason: z.string(),
  judgeSaidNo: z.boolean(),
  tierEvidence: z.array(z.object({ rule: z.string(), line: z.number().nullable() })),
  lines: z.array(SiteLineSchema),
}) satisfies z.ZodType<SiteLeadType>;

export const LeadsFileSchema = z.object({
  format: z.literal("candef-leads"),
  version: z.literal(LEADS_FILE_VERSION),
  label: z.literal(LEADS_LABEL),
  meta: z.object({
    dataDate: z.string(),
    generatedAt: z.string(),
    tiers: z.array(z.enum(["A", "B", "C", "D"])),
    count: z.number(),
    isDemo: z.boolean(),
    sources: z.array(z.string()),
    licence: z.string(),
  }),
  leads: z.array(SiteLeadSchema),
}) satisfies z.ZodType<LeadsFileType>;
