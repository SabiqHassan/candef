/**
 * The lead search query: one shape for the command line, the agent tools and the site's filters.
 * Zod is the source of truth. Pure: no file or network access.
 */
import { z } from "zod";
import { TAG_IDS } from "./vocabulary";

const DateText = z
  .string()
  .regex(/^\d{4}(-\d{2}-\d{2})?$/, "use YYYY or YYYY-MM-DD")
  .describe("YYYY or YYYY-MM-DD");

export const SearchQuery = z.object({
  text: z
    .string()
    .optional()
    .describe(
      "Keywords matched against company name, triage reason, project titles, descriptions, contract categories and programmes. Synonyms are added automatically (drone also finds UAS, UAV, RPAS).",
    ),
  tags: z
    .array(z.enum(TAG_IDS))
    .optional()
    .describe("Keep companies that have ANY of these topic tags."),
  tiers: z
    .array(z.enum(["A", "B", "C", "D"]))
    .default(["A"])
    .describe(
      "A real defence/space/security link, B National Defence or Space Agency supplier only, C public-safety supplier only, D judge-only. Default A.",
    ),
  provinces: z
    .array(z.string())
    .optional()
    .describe(
      "Province codes (ON, QC, NS ...) or the groups atlantic, prairies, territories. Contract-only vendors have no province and are never matched by this filter.",
    ),
  firstSeenAfter: DateText.optional().describe(
    "Companies whose first appearance in the government data is ON OR AFTER this date. This is not the founding date.",
  ),
  firstGrantAfter: DateText.optional().describe(
    "Companies whose first grant started ON OR AFTER this date (unknown for companies with many rows; those are excluded).",
  ),
  firstTimeGrantRecipient: z
    .boolean()
    .optional()
    .describe("True: exactly one grant agreement so far."),
  maxTotalValue: z
    .number()
    .nonnegative()
    .optional()
    .describe("Largest total of all grant and contract money, in CA$."),
  departments: z
    .array(z.string())
    .optional()
    .describe(
      "Part of a department name or its code, e.g. 'National Defence', 'dnd-mdn', 'Space Agency'.",
    ),
  programmes: z
    .array(z.string())
    .optional()
    .describe(
      "Part of a programme name on a stored grant row, e.g. 'IDEaS', 'Industrial Research Assistance'.",
    ),
  categories: z
    .array(z.string())
    .optional()
    .describe(
      "Part of a CONTRACT category name, e.g. 'communications', 'radar', 'ammunition'. With departments, one contract row must match both.",
    ),
  programmeSince: DateText.optional().describe(
    "With `programmes`: only grant rows dated ON OR AFTER this date count.",
  ),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchQuery = z.infer<typeof SearchQuery>;
export type SearchQueryInput = z.input<typeof SearchQuery>;
