/**
 * Records source permissions (D-15) per host, from the site terms Claude read on 2026-10-15
 * (docs/OVERNIGHT_2026-10-15.md task 1). Bases are paraphrases, never quotations. A host whose terms
 * say nothing about keeping a copy allows a private research copy (owner decision 2026-10-15);
 * a host that forbids copying stays denied. Edits only the `permissions` block of matching source files, preserving comments.
 *
 *   npx tsx scripts/research/set-permissions.ts [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

type P = "allowed" | "denied" | "unknown";
interface Rule {
  capture: P;
  retainInternal: P;
  quoteInternal: P;
  redistributeExcerpt: P;
  automatedCollection: P;
  attributionRequired: boolean | null;
  basis: string;
  /** Date the terms were read, when not the first pass (batch 2: 2026-10-17). */
  reviewedAt?: string;
}

const REVIEWED = "2026-10-15";
const BATCH2 = "2026-10-17";
const BATCH3 = "2026-10-17";
const BATCH4 = "2026-10-20";
// Owner decision 2026-10-15 (docs/DECISION_LOG.md P-43): where a site's terms are silent about
// copying, a private research copy is allowed. Nothing else is: excerpts are never redistributed
// from such a copy (redistributeExcerpt stays unknown = denied), and a site that explicitly forbids
// copying stays denied (see `denied` below). robots.txt is still respected by the capture tool.
const silent = (where: string, on = REVIEWED): Rule => ({
  capture: "allowed",
  retainInternal: "allowed",
  quoteInternal: "unknown",
  redistributeExcerpt: "unknown",
  automatedCollection: "unknown",
  attributionRequired: null,
  basis: `Terms sought ${on} (${where}); no provision on copying or keeping pages found. Owner decision 2026-10-15: silent terms allow a private research copy (never redistributed or published). robots.txt allows a one-off retrieval by CANDEF.`,
  ...(on === REVIEWED ? {} : { reviewedAt: on }),
});
const gc = (terms: string, on = REVIEWED): Rule => ({
  capture: "allowed",
  retainInternal: "allowed",
  quoteInternal: "allowed",
  redistributeExcerpt: "allowed",
  automatedCollection: "unknown",
  attributionRequired: true,
  basis: `Government of Canada terms and conditions (${terms}), read ${on}: non-commercial reproduction in whole or part is permitted without further permission, with title, author and source URL attributed and accuracy checked. Commercial redistribution needs written permission.`,
  ...(on === REVIEWED ? {} : { reviewedAt: on }),
});
const denied = (why: string, on = REVIEWED): Rule => ({
  capture: "denied",
  retainInternal: "denied",
  quoteInternal: "unknown",
  redistributeExcerpt: "denied",
  automatedCollection: "denied",
  attributionRequired: null,
  basis: `Site terms read ${on}: ${why} No copy is kept; hashes only (candef fingerprint).`,
  ...(on === REVIEWED ? {} : { reviewedAt: on }),
});
/** Terms that restrict only public or commercial reuse, or allow internal download (BDC pattern). */
const privateCopy = (why: string, on = BATCH2): Rule => ({
  capture: "allowed",
  retainInternal: "allowed",
  quoteInternal: "unknown",
  redistributeExcerpt: "denied",
  automatedCollection: "unknown",
  attributionRequired: null,
  basis: `Site terms read ${on}: ${why} A private, non-commercial research copy is outside the restriction; nothing may be republished. Owner may revisit.`,
  reviewedAt: on,
});

export const RULES: Record<string, Rule> = {
  "www.canada.ca": gc("https://www.canada.ca/en/transparency/terms.html"),
  "ised-isde.canada.ca": gc(
    "https://ised-isde.canada.ca/site/ised/en/terms-and-conditions/terms-and-conditions",
  ),
  "www.bdc.ca": {
    capture: "allowed",
    retainInternal: "allowed",
    quoteInternal: "allowed",
    redistributeExcerpt: "denied",
    automatedCollection: "unknown",
    attributionRequired: null,
    basis: `BDC legal notice (https://www.bdc.ca/en/legal-notice), read ${REVIEWED}: written authorization is required for public or commercial use of site content (copying and storage are listed among such uses). A private, non-commercial research copy is outside that clause; nothing may be republished. Owner may revisit.`,
  },
  "spaceq.ca": {
    capture: "allowed",
    retainInternal: "allowed",
    quoteInternal: "allowed",
    redistributeExcerpt: "denied",
    automatedCollection: "unknown",
    attributionRequired: null,
    basis: `SpaceQ terms of service (https://spaceq.ca/terms-of-service/), read ${REVIEWED}: reproducing or copying the service for commercial purposes is prohibited; a private non-commercial research copy is not addressed as prohibited. Some articles sit behind a membership. Owner may revisit.`,
  },
  "betakit.com": denied(
    "the licence covers personal use only and excludes downloading other than page caching, and excludes data-mining tools (https://betakit.com/terms-of-use/).",
  ),
  "clearpathrobotics.com": denied(
    "copying, redistribution, use or publication of any portion of the website is prohibited (https://clearpathrobotics.com/terms-of-service).",
  ),
  "gx.space": denied(
    "scraping, copying or harvesting data without authorization is prohibited; other uses need written permission (https://gx.space/terms-of-service).",
  ),
  "ociana.com": denied(
    "personal non-commercial use only; downloading and storing material is prohibited, as is any robot or automatic means of access (https://ociana.com/resources/terms-conditions/).",
  ),
  "www.privateequitywire.co.uk": denied(
    "copying to any other location, including caching of any kind, is prohibited (https://www.privateequitywire.co.uk/terms-conditions/).",
  ),
  "www.rockwellautomation.com": denied(
    "material may not be copied or downloaded without prior written permission (https://www.rockwellautomation.com/en-us/company/about-us/legal-notices/terms-and-conditions-of-access.html).",
  ),
  "ac-ada.ca": silent("no terms page linked from the home page"),
  "ccxtechnologies.com": silent("no terms page linked; robots.txt absent (404)"),
  "kepler.space": silent("only a privacy policy is linked"),
  "kyodonewsprwire.jp": silent("only a privacy policy is linked"),
  "mcrockcapital.com": silent("no terms page linked"),
  "persportaal.anp.nl": silent("no terms page linked from the portal home page"),
  "www.kinovarobotics.com": silent("no terms page found; robots.txt absent (404)"),
  "www.krakenrobotics.com": silent(
    "the policies page holds privacy and sales/purchase terms, none on website content",
  ),
  "www.reactiondynamics.space": silent(
    "no terms page found; robots.txt blocks AI crawlers but allows other agents",
  ),
  "www.virtualmarine.ca": silent(
    "only a privacy policy is linked; robots.txt blocks AI crawlers but allows other agents",
  ),
  "www.kognitivspark.com": silent(
    "the /terms page is an end-user licence for the RemoteSpark application, not website terms; robots.txt blocks AI crawlers but allows other agents",
  ),
  "www.nuvucameras.com": silent(
    "terms page of 2020-06-10 covers links, governing law and changes, but not copying",
  ),
  // Batch 2 (docs/verification/batch2/cards.json), terms read 2026-10-17.
  "canadabuys.canada.ca": gc("https://www.canada.ca/en/transparency/terms.html", BATCH2),
  "rutter.ca": silent("no terms page linked from the home page", BATCH2),
  "www.sec.gov": {
    capture: "allowed",
    retainInternal: "allowed",
    quoteInternal: "allowed",
    redistributeExcerpt: "allowed",
    automatedCollection: "unknown",
    attributionRequired: true,
    basis: `SEC privacy and website policies (https://www.sec.gov/privacy), read ${BATCH2}: information on sec.gov is public and may be copied or redistributed without permission, citing the SEC as the source. Automated access is limited to 10 requests per second and undeclared bots are not allowed; CANDEF retrieves single filings with a declared user agent.`,
    reviewedAt: BATCH2,
  },
  "www.bluedropts.com": silent("no terms page linked from the home page", BATCH2),
  "www.solace.ca": silent("only a privacy policy is linked", BATCH2),
  "www.civitanavi.com": silent(
    "only Honeywell privacy and cookie notices are linked; no website terms",
    BATCH2,
  ),
  "www.edisonpartners.com": silent("no terms page linked from the home page", BATCH2),
  "www.ghgsat.com": privateCopy(
    "copying or reproducing the site for public or commercial purposes is restricted (https://www.ghgsat.com/terms-and-conditions/).",
  ),
  "www.wolfadvancedtechnology.com": privateCopy(
    "materials may be downloaded for internal, informational purposes; reproduction or republication needs written consent (https://www.wolfadvancedtechnology.com/policies).",
  ),
  "earthdaily.com": denied(
    "copying or storing any significant portion of the site, scraping and automated access are prohibited (https://earthdaily.com/terms-of-use).",
    BATCH2,
  ),
  "fieldeffect.com": denied(
    "reproducing or storing site material, compiling it into an internal database and automated access are prohibited (https://fieldeffect.com/terms-use).",
    BATCH2,
  ),
  "www.ecopiatech.com": denied(
    "reproduction without written consent and data mining or extraction are prohibited (https://www.ecopiatech.com/terms-of-use).",
    BATCH2,
  ),
  // Batch 3 (docs/research/batch3-seed-leads-2026-10-17.md), terms read 2026-10-17.
  "www.northvectordynamics.com": silent(
    "no terms or privacy page is linked and /terms returns 404",
    BATCH3,
  ),
  "www.tactiql.com": silent("no terms or privacy page is linked and /terms returns 404", BATCH3),
  "www.calian.com": silent(
    "no website terms found (/terms-of-use returns 404); robots.txt allows the news pages",
    BATCH3,
  ),
  "defendthedominion.com": silent(
    "no terms page (/terms returns 404); the privacy policy covers only sign-in and rate limits on its Aurion database, not copying of the site; robots.txt allows the pages",
    BATCH3,
  ),
  "www.nordspace.com": silent(
    "no terms page is linked; the footer carries a copyright notice only",
    BATCH3,
  ),
  "sarcomeredynamics.com": silent("no terms page is linked from the home page", BATCH3),
  "qeynet.com": silent(
    "no terms page is linked; the footer carries a copyright notice only",
    BATCH3,
  ),
  "www.trackgen.com": silent(
    "no terms page is linked; the footer carries a copyright notice only",
    BATCH3,
  ),
  "www.einpresswire.com": denied(
    "the terms prohibit bots, scrapers and systematic retrieval of content (https://www.einpresswire.com/terms).",
    BATCH3,
  ),
  "www.anvil.ai": silent(
    "no terms page is linked; the privacy and disclosure policies say nothing about copying the site; robots.txt allows all pages",
    BATCH3,
  ),
  "canadarocketcompany.com": denied(
    "copying, reproducing or republishing site content and automated extraction are prohibited (https://canadarocketcompany.com/terms-of-use).",
    BATCH3,
  ),
  "www.octasic.com": denied(
    "copying or reproducing site information needs advance written permission (https://www.octasic.com/terms-of-service).",
    BATCH2,
  ),
  "www.prnewswire.com": denied(
    "reproduction needs written permission beyond one personal copy, and automated downloading is prohibited (https://www.prnewswire.com/terms-of-use/).",
    BATCH2,
  ),
  "www.climateinvestment.com": denied(
    "copying beyond incidental viewing copies is prohibited (https://www.climateinvestment.com/terms-of-use).",
    BATCH2,
  ),
  // Batch 4 (the eight drafted companies not yet in a cohort), terms read 2026-10-20.
  "anyonsys.com": silent("only a privacy policy is linked; no website terms found", BATCH4),
  "indrorobotics.ca": silent("no terms page is linked from the contact page", BATCH4),
  "m1composites.com": silent(
    "only a privacy policy, corporate policies and supplier sales terms are linked; none covers copying website content",
    BATCH4,
  ),
  "secureorbit.ca": silent("no terms page is linked from the contact page", BATCH4),
  "sensortechcanada.com": silent("no terms page is linked from the about page", BATCH4),
  "spacebridge.com": silent(
    "only a privacy policy, codes of conduct and standard terms of sale are linked; none covers copying website content",
    BATCH4,
  ),
  "www.integran.com": silent(
    "the online policy is a privacy policy; it says nothing about copying the site or automated access",
    BATCH4,
  ),
  "sanctuary.ai": denied(
    "copying, mirroring and scraping the site are barred, and systematically collecting content with bots or crawlers is prohibited (https://sanctuary.ai/terms/, https://sanctuary.ai/ip-notice/).",
    BATCH4,
  ),
  "sanctuaryai.substack.com": denied(
    "crawling, scraping or spidering any page, and copying or storing a large share of the material, are prohibited (https://substack.com/tos).",
    BATCH4,
  ),
};

if (process.argv[1]?.endsWith("set-permissions.ts")) {
  const dry = process.argv.includes("--dry-run");
  const dir = join(process.cwd(), "research", "sources");
  let changed = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
    const file = join(dir, f);
    const doc = parseDocument(readFileSync(file, "utf8"));
    const url = String(doc.get("url"));
    const rule = RULES[new URL(url).host];
    if (!rule) continue;
    const current = doc.get("permissions");
    const { reviewedAt, ...fields } = rule;
    const next = { ...fields, termsReviewedAt: reviewedAt ?? REVIEWED };
    if (
      JSON.stringify((current as { toJSON?: () => unknown })?.toJSON?.()) === JSON.stringify(next)
    )
      continue;
    doc.set("permissions", doc.createNode(next));
    changed++;
    console.log(`${f.replace(".yaml", "")}\t${rule.capture}\t${url}`);
    if (!dry) writeFileSync(file, doc.toString());
  }
  console.log(`${changed} source files ${dry ? "would change" : "changed"}`);
}
