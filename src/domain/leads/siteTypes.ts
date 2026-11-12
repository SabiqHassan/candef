/**
 * The static data file behind the site's lead search (`/data/<dataset>/leads.json`): plain types and
 * helpers, no zod, so the browser bundle stays free of the validation library (which evaluates code
 * at start-up, forbidden by the site's content-security policy). The zod schemas that check the file
 * when it is written live in siteData.ts (pipeline and tests only).
 *
 * Leads are UNVERIFIED lines from public government data; nothing here is a CANDEF fact, and
 * nothing here comes from `research/`.
 */
import type { TagId } from "./vocabulary";

export const LEADS_FILE_VERSION = 1;
export const LEADS_LABEL = "Unverified leads from public government data" as const;

export interface SiteLine {
  kind: "grant" | "contract";
  date: string;
  department: string;
  /** Department code in the open-data portal (for example dnd-mdn); used to link the record. */
  ownerOrg: string;
  /** Grants: the programme. Contracts: empty (the category is in `description`). */
  programme: string;
  title: string;
  /** Grants: the project description. Contracts: the goods or services category. Trimmed. */
  description: string;
  value: number;
  ref: string;
  /** Topic tags this row supports (precomputed; the keyword lists stay in the pipeline). */
  tags: TagId[];
}

export interface SiteLead {
  key: string;
  name: string;
  otherNames: string[];
  businessNumber: string | null;
  cities: string[];
  /** Two-letter province or territory codes; contract-only vendors have none. */
  provinces: string[];
  tier: "A" | "B" | "C" | "D";
  tags: TagId[];
  /** First and last appearance in government data. NOT the founding date. */
  firstDate: string | null;
  lastDate: string | null;
  firstGrantDate: string | null;
  firstTimeGrantRecipient: boolean;
  grantAgreements: number;
  grantCount: number;
  contractCount: number;
  grantValue: number;
  contractValue: number;
  dndContractValue: number;
  csaValue: number;
  /** The triage judge's one-line reason (an AI judgement, shown as such). */
  reason: string;
  judgeSaidNo: boolean;
  /** Tier rules that fired; `line` indexes `lines` (null for company-level rules). */
  tierEvidence: { rule: string; line: number | null }[];
  /** The stored government rows behind the lead (at most ten; the company may have more). */
  lines: SiteLine[];
}

export interface LeadsFile {
  format: "candef-leads";
  version: typeof LEADS_FILE_VERSION;
  label: typeof LEADS_LABEL;
  meta: {
    /** The government data release the leads were built from (YYYY-MM-DD). */
    dataDate: string;
    generatedAt: string;
    tiers: ("A" | "B" | "C" | "D")[];
    count: number;
    /** Fictional demonstration data (the demo build); never real companies. */
    isDemo: boolean;
    sources: string[];
    licence: string;
  };
  leads: SiteLead[];
}

/** Plain-words reasons for the tier rules, shown on a lead (`tierEvidence[].rule`). */
export const RULE_TEXT: Record<string, string> = {
  "1:candef-organization": "Already a CANDEF organization record",
  "1:national-defence-grant": "Received a grant or contribution from National Defence",
  "1:defence-programme": "Funded through a defence programme (IDEaS, RDII, SADI or similar)",
  "1:space-agency-grant": "Received a Canadian Space Agency grant",
  "2:strong-category": "Federal contract in a defence-type goods or services category",
  "2:defence-buyer-category":
    "Contract for equipment a defence buyer typically orders (radio, electronics)",
  "3:medium-category": "National Defence or Space Agency contract in a technical category",
  "4:defence-text": "Defence, security or space wording in a project title or description",
  "5:large-defence-total": "National Defence contracts totalling CA$10 million or more",
  "B:defence-supplier": "Ordinary National Defence or Space Agency supplier",
  "C:public-safety-supplier": "Ordinary public-safety supplier",
  "D:judge-only": "Flagged by the AI judge only; no rule evidence",
};
export const ruleText = (rule: string) => RULE_TEXT[rule] ?? rule;

/**
 * Link to the government's own record of a row, so a reader can check it. Open-data portal pattern:
 * grants `/grants/record/<owner>,<ref>,current`; contracts `/contracts/record/<owner>,<ref>`.
 * Amendment suffixes ("…#1", "…;amendment_number=1") are dropped: the portal keys on the reference.
 */
export function recordUrl(line: Pick<SiteLine, "kind" | "ownerOrg" | "ref">): string | null {
  const ref = line.ref.split(/[;#]/)[0]?.trim();
  if (!ref || !line.ownerOrg) return null;
  const id = encodeURIComponent(`${line.ownerOrg},${ref}`);
  return line.kind === "grant"
    ? `https://search.open.canada.ca/grants/record/${id}%2Ccurrent`
    : `https://search.open.canada.ca/contracts/record/${id}`;
}
