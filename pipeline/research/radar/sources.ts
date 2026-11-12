/**
 * Rounds radar (P-68): the sources a sweep may read, and why each one is allowed.
 *
 * A source is read only when `enabled` is true. Before a source is added or enabled, its robots.txt
 * and terms are read and the basis is written here (docs/RADAR.md, "Sources and terms"). The sweep
 * finds leads only: nothing it reads is evidence until the primary source is read and cited.
 */

export type RadarSourceKind = "sec-form-d" | "gc-news" | "rss";

export interface RadarSource {
  id: string;
  kind: RadarSourceKind;
  label: string;
  enabled: boolean;
  /** Index root, feed URL or feed URL template. */
  url: string;
  /** Requests per second this host is read at (SEC allows up to 10; we stay well below). */
  ratePerSecond: number;
  termsBasis: string;
  termsReviewedAt: string;
}

export const SEC_FORM_D: RadarSource = {
  id: "sec-form-d",
  kind: "sec-form-d",
  label: "SEC EDGAR Form D (issuers with a Canadian business address)",
  enabled: true,
  url: "https://www.sec.gov/Archives/edgar/daily-index/",
  ratePerSecond: 4,
  termsBasis:
    "SEC privacy and website policies (https://www.sec.gov/privacy), read 2026-10-17: information on sec.gov is public; automated access is limited to 10 requests per second with a declared user agent. robots.txt (read 2026-10-31) allows /Archives/edgar/ and disallows /cgi-bin and /search, which the sweep never uses.",
  termsReviewedAt: "2026-10-31",
};

/**
 * Government of Canada news feeds (Atom), one per department. canada.ca publishes these feed URLs
 * for subscription; api.io.canada.ca has no robots.txt and www.canada.ca's robots.txt allows the
 * news pages (read 2026-10-31).
 */
export const GC_NEWS: RadarSource & { departments: string[] } = {
  id: "gc-news",
  kind: "gc-news",
  label: "Government of Canada news releases (defence, space, innovation and regional agencies)",
  enabled: true,
  url: "https://api.io.canada.ca/io-server/gc/news/en/v2?dept={dept}&sort=publishedDate&orderBy=desc&publishedDate%3E={since}&pick=100&format=atom",
  ratePerSecond: 1,
  termsBasis:
    "Government of Canada terms and conditions (https://www.canada.ca/en/transparency/terms.html), read 2026-10-15: non-commercial reproduction is permitted with attribution. The feeds are published for subscription on canada.ca (read 2026-10-31).",
  termsReviewedAt: "2026-10-31",
  departments: [
    "departmentnationaldefense",
    "defenceinvestmentagency",
    "departmentofindustry",
    "spaceagency",
    "nationalresearchcouncil",
    "communicationssecurity",
    "publicsafetycanada",
    "departmentofpublicworksandgovernmentservices",
    "economicdevelopmentsouthernontario",
    "economicdevelopmentquebecregions",
    "prairieseconomicdevelopment",
    "pacificeconomicdevelopment",
    "atlanticcanadaopportunities",
    "fednor",
    "canadiannortherneconomicdevelopmentagency",
  ],
};

/** Off until the owner agrees (DECISION_QUEUE.md): the terms do not forbid automated reading. */
export const RSS_SOURCES: RadarSource[] = [
  {
    id: "spaceq",
    kind: "rss",
    label: "SpaceQ (Canadian space news)",
    enabled: false,
    url: "https://spaceq.ca/feed/",
    ratePerSecond: 1,
    termsBasis:
      "SpaceQ terms of service (https://spaceq.ca/terms-of-service/), read 2026-10-15 and 2026-10-31: commercial reproduction is prohibited; automated reading is not addressed; robots.txt allows the site. Headlines and links only, kept in research-cache/ as leads.",
    termsReviewedAt: "2026-10-31",
  },
];

/** Hosts checked and left out, so later sessions do not add them again without new terms. */
export const EXCLUDED_SOURCES: { host: string; reason: string; checkedAt: string }[] = [
  {
    host: "betakit.com",
    reason: "Terms exclude data-mining tools and downloading beyond page caching.",
    checkedAt: "2026-10-15",
  },
  {
    host: "finsmes.com",
    reason: "Terms forbid systematic or automated data collection.",
    checkedAt: "2026-10-31",
  },
  {
    host: "prnewswire.com, newswire.ca",
    reason:
      "Cision terms (newswire.ca links to prnewswire.com/terms-of-use) forbid automated access.",
    checkedAt: "2026-10-31",
  },
  {
    host: "globenewswire.com",
    reason: "robots.txt refuses our requests (HTTP 403); terms not readable automatically.",
    checkedAt: "2026-10-31",
  },
  {
    host: "businesswire.com",
    reason: "No response to the terms check; not read.",
    checkedAt: "2026-10-31",
  },
  {
    host: "canadiandefencereview.com",
    reason: "robots.txt refuses our requests (HTTP 403).",
    checkedAt: "2026-10-31",
  },
  {
    host: "vanguardcanada.com",
    reason: "No terms of use found (privacy policy only).",
    checkedAt: "2026-10-31",
  },
  {
    host: "justraised.io",
    reason: "A compiled tracker: its rounds are not evidence and copying its data is out of scope.",
    checkedAt: "2026-10-31",
  },
];

/** SEC EDGAR state codes for Canada (https://www.sec.gov/submit-filings/filer-support-resources/edgar-state-country-codes, read 2026-10-31). */
export const CANADA_STATE_CODES: Record<string, string> = {
  A0: "AB",
  A1: "BC",
  A2: "MB",
  A3: "NB",
  A4: "NL",
  A5: "NS",
  A6: "ON",
  A7: "PE",
  A8: "QC",
  A9: "SK",
  B0: "YT",
  Z4: "CA",
};

export function isCanadianStateCode(code: string | null | undefined): boolean {
  return Boolean(code && Object.hasOwn(CANADA_STATE_CODES, code.trim().toUpperCase()));
}
