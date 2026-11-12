/**
 * Rounds radar (P-68): pure parsers for what a sweep downloads. No network, no file access.
 *
 * Form D: only issuer-level fields are read. The "related persons" section (executives and
 * directors) is never parsed, so no personal data enters the leads (D-17).
 */
import { visibleText } from "../capture";

// ---- EDGAR daily form index -----------------------------------------------------------------------

export interface IndexEntry {
  formType: string;
  company: string;
  cik: string;
  /** YYYY-MM-DD */
  dateFiled: string;
  /** Path under https://www.sec.gov/Archives/, e.g. edgar/data/123/0001234567-26-000001.txt */
  path: string;
}

/** Parses an EDGAR daily form index (form.YYYYMMDD.idx): fixed columns separated by 2+ spaces. */
export function parseDailyIndex(text: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  let body = false;
  for (const line of text.split(/\r?\n/)) {
    if (!body) {
      if (/^-{20,}\s*$/.test(line)) body = true;
      continue;
    }
    const m = /^(\S(?:.*?\S)?)\s{2,}(\S.*?)\s{2,}(\d{1,10})\s+(\d{8})\s+(edgar\/\S+)\s*$/.exec(
      line,
    );
    if (!m) continue;
    const d = m[4]!;
    out.push({
      formType: m[1]!,
      company: m[2]!.trim(),
      cik: String(Number(m[3]!)),
      dateFiled: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      path: m[5]!,
    });
  }
  return out;
}

export const FORM_D_TYPES = new Set(["D", "D/A"]);

// ---- Form D full submission (.txt) ---------------------------------------------------------------

export interface FormD {
  accession: string;
  cik: string;
  submissionType: string;
  /** FILED AS OF DATE, YYYY-MM-DD. */
  filedOn: string | null;
  filerName: string;
  /** Header business address of the first filer (EDGAR state code, e.g. A6 = Ontario). */
  businessState: string | null;
  businessCity: string | null;
  /** Primary issuer in the XML. */
  entityName: string | null;
  issuerState: string | null;
  issuerCity: string | null;
  jurisdictionOfInc: string | null;
  yearOfInc: string | null;
  industryGroup: string | null;
  investmentFundType: string | null;
  isAmendment: boolean;
  previousAccession: string | null;
  dateOfFirstSale: string | null;
  firstSaleYetToOccur: boolean;
  /** As filed: a whole number of US dollars, or "Indefinite". */
  totalOfferingAmount: string | null;
  totalAmountSold: string | null;
  securities: string[];
}

const SECURITY_TAGS: [string, string][] = [
  ["isEquityType", "equity"],
  ["isDebtType", "debt"],
  ["isOptionToAcquireType", "option or warrant"],
  ["isSecurityToBeAcquiredType", "security acquired on exercise"],
  ["isPooledInvestmentFundType", "pooled investment fund interest"],
  ["isTenantInCommonType", "tenant-in-common"],
  ["isMineralPropertyType", "mineral property"],
  ["isOtherType", "other"],
];

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? decode(m[1]!).trim() || null : null;
}

function headerField(header: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m").exec(header);
  return m ? m[1]! : null;
}

const yyyymmdd = (s: string | null) =>
  s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;

/** Parses a Form D full submission text file; returns null for anything that is not a Form D. */
export function parseFormDSubmission(text: string): FormD | null {
  const headerEnd = text.indexOf("</SEC-HEADER>");
  if (headerEnd < 0) return null;
  const header = text.slice(0, headerEnd);
  const submissionType = headerField(header, "CONFORMED SUBMISSION TYPE");
  if (!submissionType || !FORM_D_TYPES.has(submissionType)) return null;
  const accession = headerField(header, "ACCESSION NUMBER") ?? "";
  const filerBlock = header.slice(header.indexOf("FILER:"));
  const business = /BUSINESS ADDRESS:\s*\n((?:[ \t]+\S.*\n?)+)/.exec(filerBlock)?.[1] ?? "";
  const xmlStart = text.indexOf("<edgarSubmission");
  const xml = xmlStart >= 0 ? text.slice(xmlStart) : "";
  const issuer = /<primaryIssuer>([\s\S]*?)<\/primaryIssuer>/.exec(xml)?.[1] ?? "";
  const address = /<issuerAddress>([\s\S]*?)<\/issuerAddress>/.exec(issuer)?.[1] ?? "";
  const yearOfInc = /<yearOfInc>([\s\S]*?)<\/yearOfInc>/.exec(issuer)?.[1] ?? "";
  const firstSale = /<dateOfFirstSale>([\s\S]*?)<\/dateOfFirstSale>/.exec(xml)?.[1] ?? "";
  const types =
    /<typesOfSecuritiesOffered>([\s\S]*?)<\/typesOfSecuritiesOffered>/.exec(xml)?.[1] ?? "";
  return {
    accession,
    cik: String(Number(headerField(header, "CENTRAL INDEX KEY") ?? "0")),
    submissionType,
    filedOn: yyyymmdd(headerField(header, "FILED AS OF DATE")),
    filerName: headerField(header, "COMPANY CONFORMED NAME") ?? "",
    businessState: headerField(business, "STATE"),
    businessCity: headerField(business, "CITY"),
    entityName: tag(issuer, "entityName"),
    issuerState: tag(address, "stateOrCountry"),
    issuerCity: tag(address, "city"),
    jurisdictionOfInc: tag(issuer, "jurisdictionOfInc"),
    yearOfInc: tag(yearOfInc, "value"),
    industryGroup: tag(xml, "industryGroupType"),
    investmentFundType: tag(xml, "investmentFundType"),
    isAmendment: tag(xml, "isAmendment") === "true",
    previousAccession: tag(xml, "previousAccessionNumber"),
    dateOfFirstSale: tag(firstSale, "value"),
    firstSaleYetToOccur: tag(firstSale, "yetToOccur") === "true",
    totalOfferingAmount: tag(xml, "totalOfferingAmount"),
    totalAmountSold: tag(xml, "totalAmountSold"),
    securities: SECURITY_TAGS.filter(([t]) => tag(types, t) === "true").map(([, label]) => label),
  };
}

/** URL of the Form D primary document (the XML the runbook registers and captures as the source). */
export function formDPrimaryDocUrl(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/primary_doc.xml`;
}

// ---- Atom and RSS feeds -----------------------------------------------------------------------------

export interface FeedItem {
  title: string;
  link: string;
  /** ISO date-time or RFC 822 date as given by the feed. */
  published: string | null;
  summary: string;
  author: string | null;
  category: string | null;
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, e: string) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)),
      );
    return (
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[
        e.toLowerCase()
      ] ?? all
    );
  });
}

function feedText(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  if (!m) return "";
  const raw = m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  // Summaries may carry escaped HTML: decode first, then drop the tags.
  return visibleText(decode(raw));
}

/** Parses an Atom feed (<entry>) or an RSS 2.0 feed (<item>). */
export function parseFeed(xml: string): FeedItem[] {
  const atom = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]!);
  if (atom.length)
    return atom.map((e) => ({
      title: feedText(e, "title"),
      link: /<link\b[^>]*href="([^"]+)"/.exec(e)?.[1] ?? feedText(e, "id"),
      published: feedText(e, "published") || feedText(e, "updated") || null,
      summary: feedText(e, "summary") || feedText(e, "content"),
      author: feedText(e, "name") || null,
      category: /<category\b[^>]*term="([^"]+)"/.exec(e)?.[1] ?? null,
    }));
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const e = m[1]!;
    return {
      title: feedText(e, "title"),
      link: feedText(e, "link"),
      published: feedText(e, "pubDate") || null,
      summary: feedText(e, "description"),
      author: feedText(e, "dc:creator") || null,
      category: feedText(e, "category") || null,
    };
  });
}

// ---- Amounts and signals in announcement text -----------------------------------------------------

/** Dollar amounts as written ("$2,993,348", "US$4.5 million", "C$12M", "$3.8-billion"); at most `limit`, in order. */
export function extractAmounts(text: string, limit = 6): string[] {
  const re = /(?:US|CA|C|CAD|USD)?\s?\$\s?\d[\d,]*(?:\.\d+)?(?:[\s-]?(?:million|billion|M|B)\b)?/g;
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    const v = m[0].trim().replace(/\s+/g, " ");
    if (!seen.has(v)) seen.add(v);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Money words: the title or summary is worth opening when one of these appears. */
export const FUNDING_SIGNAL =
  /\b(invest(?:s|ed|ing|ment|ments)?|fund(?:s|ed|ing)?|financing|contribution|contracts?|award(?:s|ed)?|million|billion|support(?:s|ed|ing)?|innovat\w*|challenge|selected|procure\w*|raise[sd]?|round)\b|\$/i;

/**
 * Defence, security, space and dual-use words (CANDEF scope, P-01). Deliberately narrow: plain
 * "security" (food security), "space" (lab space), "Arctic" and "sovereignty" matched ordinary
 * regional releases in the first live sweep (2026-10-31), so they need a qualifier or are left out.
 */
export const SCOPE_SIGNAL =
  /\b(defen[cs]e|military|armed forces|national security|cyber\w*|space[- ](?:agency|sector|industry|based|domain|situational|station|exploration|systems?|technolog\w*)|outer space|spacecraft|satellites?|lunar|quantum|drones?|uncrewed|unmanned|autonomous|robot\w*|sonar|radar|aerospace|NORAD|dual-use|surveillance|munitions?|naval|Regional Defence Investment Initiative)\b/i;

/** Programme names that are ordinary words in lower case ("ideas", "Diana"): matched with their exact case. */
const SCOPE_PROGRAMMES = /\b(IDEaS|DIANA)\b/;

/** True when the text has a defence, security, space or dual-use word. */
export function inScope(text: string): boolean {
  return SCOPE_SIGNAL.test(text) || SCOPE_PROGRAMMES.test(text);
}
