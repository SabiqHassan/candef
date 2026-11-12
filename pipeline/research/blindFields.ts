/**
 * Field catalogue for blind independent verification (docs/verification/blind-v2-internal/
 * RECONCILIATION_PLAN.md). One source of truth for three things that must never drift apart:
 *
 *   1. the field inventory given to external researchers (no CANDEF values, only questions);
 *   2. the internal inventory, which maps every CANDEF record and derived display to a field ID;
 *   3. the reconciliation worksheet, which aligns researcher findings with that inventory.
 *
 * Derived from the real product, not from the docs: `src/domain/schema/snapshot.ts` (what the
 * compiler publishes), `pipeline/compile/*.ts` (how values and derived displays are computed) and
 * `src/features/**` (what each surface shows). `display` says how CANDEF uses the field today:
 *   displayed - shown to users when verified;
 *   stored    - held in research records but not shown yet;
 *   planned   - a product question (docs/PRODUCT.md) with no records or UI yet;
 *   context   - needed to attribute other findings to the right entity; not shown on its own.
 */

export type FieldDisplay = "displayed" | "stored" | "planned" | "context";

export interface BlindField {
  id: string;
  category: string;
  title: string;
  /** The research question, phrased neutrally (never hints at an expected answer). */
  question: string;
  /** What to report, at which specificity. */
  report: string;
  /** Where CANDEF shows the field (empty for fields not shown). */
  shownIn: string[];
  display: FieldDisplay;
  /** Derived displays: how CANDEF computes the value from base findings. */
  rule?: string;
}

export const CATEGORIES: Record<string, string> = {
  A: "Entity identity and corporate structure",
  B: "Technology classification and eligibility",
  C: "Financing (private and public)",
  D: "Investors and other counterparties",
  E: "Government relationships",
  F: "Commercial, research and industry relationships",
  G: "Intellectual property",
  H: "People (optional; professional roles only)",
  X: "Derived displays (computed from your own findings)",
};

export const BLIND_FIELDS: BlindField[] = [
  // ---- A. Entity identity and corporate structure ----------------------------------------------
  {
    id: "A01",
    category: "A",
    title: "Names in use",
    question:
      "Under which names does the business operate (brand, trading and display names), and has it changed names?",
    report:
      "Each name with the entity that uses it, the date range if known, and for any rename the old name, new name and effective date.",
    shownIn: ["company name on every surface", "search"],
    display: "displayed",
  },
  {
    id: "A02",
    category: "A",
    title: "Current legal name",
    question: "What is the exact current legal name of each legal entity involved in the business?",
    report:
      "Exact spelling and punctuation (Inc., Ltd., Corp., Ltée), French form if registered, and which entity it is (operating company, parent, subsidiary). Prefer a corporate registry or filing.",
    shownIn: ["company card", "dossier overview", "search"],
    display: "displayed",
  },
  {
    id: "A03",
    category: "A",
    title: "Former legal names",
    question: "Has any of these legal entities had a different legal name before?",
    report: "Former legal name, the entity, and the date it changed (registry history preferred).",
    shownIn: ["dossier legal-name history", "search"],
    display: "displayed",
  },
  {
    id: "A04",
    category: "A",
    title: "Incorporation and registry record",
    question:
      "Where and when was each entity incorporated, under which corporation number, and what is its registry status?",
    report:
      "Jurisdiction (federal or province, or foreign), corporation or registry number, incorporation date, status (active, dissolved, amalgamated) with the status date, and registered office city/province. Name the registry consulted.",
    shownIn: ["dossier identifiers (corporation number)", "search (registry numbers)"],
    display: "displayed",
  },
  {
    id: "A05",
    category: "A",
    title: "Business number (CRA)",
    question:
      "Which Canada Revenue Agency business number (BN) does each entity use, where published?",
    report:
      "The nine-digit BN root, plus the program-account suffix if the source shows one, the entity, and the source that publishes it (for example a government dataset row or registry page).",
    shownIn: ["dossier identifiers", "search", "used to link government records"],
    display: "displayed",
  },
  {
    id: "A06",
    category: "A",
    title: "Headquarters",
    question: "Where is the company headquartered, according to the company itself?",
    report:
      "City, province/region and country as stated by a first-party source or filing, with the date of the source. Report separately (as A04) the registered office, and do not treat a mailing address, a sales office or a press-release dateline as the headquarters unless a source calls it that.",
    shownIn: [
      "company card",
      "dossier overview",
      "directory (province)",
      "province filter",
      "list view (province)",
      "search (city, province)",
    ],
    display: "displayed",
  },
  {
    id: "A07",
    category: "A",
    title: "Other offices and facilities",
    question:
      "Which other offices, plants, labs or facilities does the company operate, and where?",
    report: "City, province/country, function (manufacturing, R&D, sales…), entity, as-of date.",
    shownIn: [],
    display: "stored",
  },
  {
    id: "A08",
    category: "A",
    title: "Founding year",
    question: "When was the company founded?",
    report:
      "The founding year as the company states it; if different, the incorporation year (A04). Say which one each source gives.",
    shownIn: ["company card", "dossier overview"],
    display: "displayed",
  },
  {
    id: "A09",
    category: "A",
    title: "Official websites",
    question: "Which websites does the company operate (current and former domains)?",
    report: "Domain, what it is (main site, product site, former domain), as-of date.",
    shownIn: [],
    display: "context",
  },
  {
    id: "A10",
    category: "A",
    title: "Business description",
    question: "What does the company make or sell, and to which markets?",
    report:
      "A short factual description in your own words (main products or services, technology, markets), each element sourced. No marketing adjectives.",
    shownIn: ["company card and dossier description (when verified)"],
    display: "displayed",
  },
  {
    id: "A11",
    category: "A",
    title: "Public listing or private status",
    question:
      "Are any of the entities publicly listed? If not, is there evidence that the company is privately held?",
    report:
      "For a listing: exchange, ticker, which entity, listing date and status (listed, delisted, suspended). For private status: the source that establishes it (confirmed_absent), or not_found if nothing says either way.",
    shownIn: [
      "badge 'Public company' / 'Private company'",
      "dossier listing line",
      "list view status",
      "public/private filter",
      "search (ticker)",
    ],
    display: "displayed",
  },
  {
    id: "A12",
    category: "A",
    title: "Ownership and parent company",
    question:
      "Is the company owned or controlled by another corporation? If so, which one, since when, and where is that parent headquartered?",
    report:
      "Immediate parent legal entity, ultimate parent if different, ownership percentage if disclosed, effective date, and parent headquarters country. If the company is independent, the source that establishes it (confirmed_absent) or not_found. A minority stake is not a parent relationship; report it as a financing participant (C03) or an M&A event (A15).",
    shownIn: [
      "badge 'Subsidiary of …'",
      "dossier ownership ('since', foreign-headquartered parent)",
      "company card parent line",
      "list view status",
    ],
    display: "displayed",
  },
  {
    id: "A13",
    category: "A",
    title: "Subsidiaries, divisions and brands",
    question:
      "Which subsidiaries, divisions or brands belong to the group, and which entity does what?",
    report:
      "Entity or division name, relationship to the operating company (subsidiary, division, brand), jurisdiction, and which entity signs contracts, receives grants or holds IP where a source says so.",
    shownIn: [],
    display: "context",
  },
  {
    id: "A14",
    category: "A",
    title: "Operating status",
    question:
      "Is the company still operating as an independent business, operating under new ownership, merged, or discontinued?",
    report: "Status, effective date, and the source.",
    shownIn: ["badge 'Acquired'", "directory row ('acquired')"],
    display: "displayed",
  },
  {
    id: "A15",
    category: "A",
    title: "Mergers and acquisitions",
    question: "Has the company been acquired, or acquired another business?",
    report:
      "For each event: target and acquirer legal entities, announcement date, completion date (or termination), consideration (amount, currency, cash/shares if stated, or 'undisclosed'), and whether a reported price comes from named or anonymous sources.",
    shownIn: ["dossier ownership and corporate events", "company card acquisition line"],
    display: "displayed",
  },

  // ---- B. Classification and eligibility -------------------------------------------------------
  {
    id: "B01",
    category: "B",
    title: "Primary technology segment",
    question:
      "Which single subsector of the CANDEF taxonomy (below) best describes the company's main business?",
    report:
      "One subsector ID from the taxonomy, a one-sentence rationale, and the findings (A10, B03) that support it. If none fits, say so.",
    shownIn: [
      "company card",
      "dossier classification",
      "directory and list view (sector)",
      "sector filter",
      "position in the 3D network",
      "dossier 'Same subsector' related companies",
    ],
    display: "displayed",
  },
  {
    id: "B02",
    category: "B",
    title: "Secondary segments",
    question: "Do other taxonomy subsectors also apply to a material part of the business?",
    report: "Subsector IDs with a one-sentence justification each, or none.",
    shownIn: ["dossier classification ('Also: …')"],
    display: "displayed",
  },
  {
    id: "B03",
    category: "B",
    title: "Defence, security and public-safety relevance",
    question:
      "What documented connections does the company have to defence, security or public-safety customers, programs or products?",
    report:
      "Each connection with its type (contract, grant or program award, product line marketed for defence/security, named customer, certification such as ITAR registration or Controlled Goods), the counterparty, the date, and whether it is current or historical. Company-level facts only: no operational or technical weapons detail.",
    shownIn: ["dossier eligibility rationale"],
    display: "displayed",
  },
  {
    id: "B04",
    category: "B",
    title: "Civil and commercial markets",
    question: "Which civil or commercial markets does the company serve?",
    report: "Market, example customers or products where documented, date.",
    shownIn: ["dossier eligibility rationale"],
    display: "displayed",
  },
  {
    id: "B05",
    category: "B",
    title: "Weapons check",
    question:
      "Does the company's primary business involve weapons, munitions or lethal systems, or does it take part in any weapons-adjacent program or product?",
    report:
      "Yes/no for primary business, and a list of any weapons-adjacent programs, products or components with the source. Company-level description only.",
    shownIn: ["eligibility decision (exclusion check)"],
    display: "displayed",
  },
  {
    id: "B06",
    category: "B",
    title: "Independent eligibility assessment",
    question:
      "Applying the CANDEF eligibility rule (below) to your own findings, should the company be included, excluded, pending or ambiguous?",
    report:
      "Decision and a short rationale that cites your finding IDs (A06, B01, B03, B05). This is your judgement; label it as such.",
    shownIn: ["dossier 'Eligibility: Included' with rationale"],
    display: "displayed",
  },

  // ---- C. Financing -------------------------------------------------------------------------------
  {
    id: "C01",
    category: "C",
    title: "Financing events",
    question:
      "Which financing events has the company had (venture rounds, grants of equity, convertible notes, SAFEs, venture debt, public offerings, private placements)?",
    report:
      "One finding per event: round label exactly as stated, normalized stage (pre_seed, seed, series_a, series_b, series_c, series_d_plus, growth, or null), event state (announced, closed, reported), instrument (equity, convertible, safe, venture_debt, public_offering, private_placement, mixed, unknown), proceeds (primary, secondary, mixed, unknown), and dates (announced, closed). Which entity raised the money.",
    shownIn: [
      "dossier financing table",
      "company card 'Latest verified round'",
      "funding-stage filter",
      "list view 'Latest round'",
      "relationship panel",
    ],
    display: "displayed",
  },
  {
    id: "C02",
    category: "C",
    title: "Amount disclosures per event",
    question: "What amounts were disclosed for each event, close by close?",
    report:
      "One finding per disclosure (first close, extension, final close, single announcement): date, amount exactly as stated, currency (never convert), basis (cumulative round total, or this tranche only), nature (committed vs received), and whether it is approximate or undisclosed. Link it to its C01 event.",
    shownIn: [
      "dossier amount and tranche list",
      "company card total",
      "list view 'Disclosed capital'",
    ],
    display: "displayed",
  },
  {
    id: "C03",
    category: "C",
    title: "Investors per event",
    question: "Who invested in each event?",
    report:
      "One finding per investor per event: investor firm as named, the investing vehicle (named fund) if stated, role (lead, co-lead, participant, unknown), which close/tranche they joined if stated, and whether the source names all investors or only some.",
    shownIn: [
      "dossier investors column",
      "company card investor list",
      "Capital network lines (investor to company)",
      "investor panel portfolio and co-investors",
      "dossier 'Shared investors'",
    ],
    display: "displayed",
  },
  {
    id: "C04",
    category: "C",
    title: "Company-stated total raised",
    question: "Has the company stated a cumulative total raised ('raised $X to date')?",
    report: "Amount as stated, currency, the as-of date, and the source.",
    shownIn: [],
    display: "stored",
  },

  // ---- D. Investors and other counterparties -----------------------------------------------------
  {
    id: "D01",
    category: "D",
    title: "Investor and counterparty identity",
    question:
      "For each investor, fund, parent, acquirer or partner you found, who is it and where is it based?",
    report:
      "Legal name, kind (venture firm, fund, corporate, government body, angel group, other), headquarters city and country, and for a named fund the firm that manages it.",
    shownIn: ["investor panel (headquarters, funds)", "network nodes", "foreign-parent label"],
    display: "displayed",
  },

  // ---- E. Government relationships ----------------------------------------------------------------
  {
    id: "E01",
    category: "E",
    title: "Federal procurement contracts",
    question: "Which Government of Canada contracts has each entity been awarded?",
    report:
      "One finding per contract (group the amendments of one contract together): buying department, vendor name exactly as reported and which entity it is, description, procurement ID or contract number, reporting batch reference, contract date, start and end dates, original value, each amendment (date, amount of change, new total), current total, maximum or option value if stated, and whether it is a joint venture or consortium award. Give the dataset row identifiers listed in the method notes.",
    shownIn: [
      "dossier 'Procurement contracts' table with amendment history",
      "company card count and attributable CAD value",
      "Government network lines (department to company; overview draws CA$100K and up)",
      "relationship panel and time view",
      "list view count",
      "department panel",
    ],
    display: "displayed",
  },
  {
    id: "E02",
    category: "E",
    title: "Federal grants and contributions",
    question: "Which Government of Canada grants or contributions has each entity received?",
    report:
      "One finding per agreement (group its amendments together): funding department, program name, recipient legal and operating name as reported, BN and postal code area (first three characters) as reported, agreement number and reference number(s), type (grant, contribution), title or purpose, agreement value for each amendment, start and end dates, and repayability if stated.",
    shownIn: [
      "dossier 'Grants and contributions' table",
      "company card count and value",
      "Government network lines (funder to company)",
      "relationship panel and time view",
      "department panel",
    ],
    display: "displayed",
  },
  {
    id: "E03",
    category: "E",
    title: "Federal other transfer payments",
    question:
      "Has any entity received payments the government classifies as 'other transfer payments' (neither grant, contribution nor contract)?",
    report: "Same detail as E02, plus the source's own classification code and label.",
    shownIn: ["dossier 'Other transfer payments' table", "company card count"],
    display: "displayed",
  },
  {
    id: "E04",
    category: "E",
    title: "Defence and security programs",
    question:
      "Has any entity taken part in a defence or security innovation program (for example IDEaS, RDII, SADI, CSSP, space-agency programs, NATO DIANA)?",
    report:
      "Program, contest or challenge, the award type (contract, grant, contribution, prize), amount, dates, and the entity. If the same award is also an E01/E02 finding, cross-reference its finding ID instead of duplicating it.",
    shownIn: ["dossier government tables (program name)", "eligibility rationale"],
    display: "displayed",
  },
  {
    id: "E05",
    category: "E",
    title: "Provincial, municipal and crown-corporation agreements",
    question:
      "Has any entity received provincial, municipal or crown-corporation contracts, grants or loans?",
    report: "Counterparty, program, type, amount, currency, dates, entity.",
    shownIn: [],
    display: "planned",
  },
  {
    id: "E06",
    category: "E",
    title: "Foreign government and international contracts or awards",
    question:
      "Has any entity been awarded contracts or funding by a foreign government or an international organization (for example NATO, ESA, a US agency)?",
    report: "Counterparty, program, type, amount, currency, dates, entity, official source.",
    shownIn: [],
    display: "planned",
  },
  {
    id: "E07",
    category: "E",
    title: "Government partnerships, MOUs and pilots",
    question:
      "Does any entity have a documented partnership, MOU, pilot or challenge award with a government body that is not a contract or grant above?",
    report: "Counterparty, nature, date, monetary value if any, official source.",
    shownIn: ["dossier 'Partnerships and MOUs' table"],
    display: "displayed",
  },

  // ---- F. Commercial, research and industry relationships -----------------------------------------
  {
    id: "F01",
    category: "F",
    title: "Commercial customers, partners and consortia",
    question:
      "Which commercial customers, partners, distributors, OEM relationships or consortium memberships are documented?",
    report:
      "Counterparty, nature of the relationship, date, and a first-party or counterparty source. A logo wall or 'trusted by' list is weak evidence: say so.",
    shownIn: [],
    display: "planned",
  },
  {
    id: "F02",
    category: "F",
    title: "Research partnerships",
    question: "Which universities, research councils or labs does the company formally work with?",
    report: "Institution, nature, program, date, source.",
    shownIn: [],
    display: "planned",
  },

  // ---- G. Intellectual property ------------------------------------------------------------------
  {
    id: "G01",
    category: "G",
    title: "Patents and applications",
    question: "Which patents or published applications are assigned to the company's entities?",
    report:
      "Number, jurisdiction (CIPO, USPTO, EPO/WIPO), title, filing and grant dates, assignee exactly as recorded. A sample of the most relevant is enough if there are many; give the total count and the search used.",
    shownIn: [],
    display: "planned",
  },

  // ---- H. People ------------------------------------------------------------------------------------
  {
    id: "H01",
    category: "H",
    title: "Founders and chief executive",
    question: "Who founded the company and who leads it now?",
    report:
      "Name, role title, organization and as-of date, from first-party or filing sources only. Never contact details, photos, personal social profiles, home location or anything non-professional.",
    shownIn: [],
    display: "planned",
  },

  // ---- X. Derived displays -----------------------------------------------------------------------
  {
    id: "X01",
    category: "X",
    title: "Disclosed capital total",
    question: "What total disclosed capital follows from your C01-C03 findings under the rule?",
    report: "One total per currency, with the finding IDs used.",
    rule: "Per round, use the latest stated cumulative round total; never add successive closes, extensions or revisions of one round. Add incremental tranches only when every tranche is disclosed in one currency and no cumulative total exists. Count primary proceeds only; leave out rounds whose amount is unclear or undisclosed. Totals are per currency and never converted.",
    shownIn: ["company card", "dossier financing summary", "list view 'Disclosed capital'"],
    display: "displayed",
  },
  {
    id: "X02",
    category: "X",
    title: "Rounds with disclosed amounts",
    question:
      "Of the financing events you found, how many have a resolved amount under the X01 rule?",
    report: "'N of M rounds'.",
    rule: "M counts every financing event; N counts those with a resolved amount under X01.",
    shownIn: ["company card", "dossier financing summary"],
    display: "displayed",
  },
  {
    id: "X03",
    category: "X",
    title: "Latest round",
    question: "Which financing event is the most recent, and when was it?",
    report: "Round label as stated and the date of its latest disclosure.",
    rule: "The event whose latest disclosure date is the most recent.",
    shownIn: ["company card", "list view", "funding-stage filter"],
    display: "displayed",
  },
  {
    id: "X04",
    category: "X",
    title: "Number of federal procurement contracts",
    question: "How many distinct federal contracts (E01) does each entity have?",
    report: "Count per entity.",
    rule: "A contract and all its amendments count once.",
    shownIn: ["company card", "dossier heading count", "list view"],
    display: "displayed",
  },
  {
    id: "X05",
    category: "X",
    title: "Contract value attributable to the company",
    question: "What CAD total of contract value is attributable to the company?",
    report: "Total and the number of contracts it covers.",
    rule: "For each contract where the company is the only named vendor, take the latest total after amendments. For a consortium award, count only a disclosed share. Add CAD amounts only.",
    shownIn: ["company card"],
    display: "displayed",
  },
  {
    id: "X06",
    category: "X",
    title: "Grants and contributions: count and value",
    question:
      "How many distinct grant or contribution agreements (E02) are there, and what is their CAD total?",
    report: "Count and total.",
    rule: "Each agreement counts once with its latest agreement value; never add amendment rows (each amendment states a replacement total). Add CAD amounts only.",
    shownIn: ["company card ('awarded')", "dossier heading count"],
    display: "displayed",
  },
  {
    id: "X07",
    category: "X",
    title: "Government counterparties",
    question:
      "Which departments are counterparties, and how many agreements does each have with the company, by type?",
    report: "Department, type (procurement or grant/contribution), count.",
    rule: "One line per department and type; its record count is the number of distinct agreements.",
    shownIn: ["Government network lines", "relationship panel"],
    display: "displayed",
  },
  {
    id: "X08",
    category: "X",
    title: "Status labels",
    question:
      "Which labels follow from A11, A12 and A14: public or private, independent or subsidiary, operating or acquired?",
    report: "The three labels with the finding IDs behind them.",
    rule: "Public only with an evidenced listing; subsidiary only with an evidenced parent; acquired only with an evidenced completed acquisition.",
    shownIn: ["badges", "list view status", "directory row"],
    display: "displayed",
  },
  {
    id: "X09",
    category: "X",
    title: "Investor list across rounds",
    question: "Which investors appear across all financing events?",
    report: "Each investor once, marked lead if it led any event, with its vehicle.",
    rule: "A firm and the fund it invests through count as one investor.",
    shownIn: ["company card investor list"],
    display: "displayed",
  },
  {
    id: "X10",
    category: "X",
    title: "Agreement date ranges",
    question: "For each government agreement, what period does it cover?",
    report: "Start date and latest stated end date per agreement.",
    rule: "Start as disclosed; end is the latest end date stated in any amendment.",
    shownIn: ["time view", "relationship panel"],
    display: "displayed",
  },
];

export const FIELD_IDS = new Set(BLIND_FIELDS.map((f) => f.id));

/** Fields that are compared as lists of events (matched by identifiers, dates and amounts). */
export const EVENT_FIELDS = new Set([
  "C01",
  "C02",
  "C03",
  "A15",
  "E01",
  "E02",
  "E03",
  "E04",
  "E07",
]);

/**
 * Fields whose findings can corroborate one another's records: an E04 program award is the same
 * record as an E01 or E02 finding, and a C02 or C03 finding lives inside a C01 event.
 */
export const FIELD_GROUP: Record<string, string> = {
  E01: "gov",
  E02: "gov",
  E03: "gov",
  E04: "gov",
  E07: "gov",
  C01: "fin",
  C02: "fin",
  C03: "fin",
};
export const groupOf = (fieldId: string): string => FIELD_GROUP[fieldId] ?? fieldId;

/**
 * Every field of the published snapshot that can carry information about a company, mapped to the
 * catalogue field (or to why it needs no external research). A test fails when the snapshot gains a
 * field that is not listed here, so the inventory cannot silently fall behind the product.
 */
export const SNAPSHOT_FIELD_MAP: Record<string, string> = {
  "org.id": "internal identifier",
  "org.slug": "internal identifier",
  "org.name": "A01",
  "org.kind": "D01 (kind of organization)",
  "org.isDemo": "internal flag",
  "org.scope": "X08 (universe membership follows from A06, B01, B06)",
  "org.legalName": "A02 / A03 (history)",
  "org.hq": "A06",
  "org.founded": "A08",
  "org.description": "A10",
  "org.segment": "B01",
  "org.secondarySegments": "B02",
  "org.listing": "A11",
  "org.marketStatus": "X08",
  "org.ownership": "A12 / X08",
  "org.operating": "A14 / X08",
  "org.eligibility": "B06",
  "org.managedBy": "D01",
  "org.managedByAssertionIds": "D01 (evidence)",
  "org.identifiers": "A04 / A05",
  "org.financing": "X01 / X02 / X03",
  "org.research": "process (research ledger)",
  "org.weight": "derived graph prominence (relationship count); no external research",
  "round.id": "internal identifier",
  "round.companyId": "C01 (which entity raised)",
  "round.label": "C01",
  "round.stage": "C01",
  "round.date": "C02 (latest disclosure date)",
  "round.eventState": "C01",
  "round.instrument": "C01",
  "round.proceeds": "C01",
  "round.resolved": "C02 / X01 (resolved amount)",
  "round.disclosures": "C02",
  "round.participants": "C03",
  "round.participantsCompleteness": "C03",
  "round.verification": "review state",
  "round.epistemic": "evidence class",
  "round.sourceIds": "evidence",
  "round.citations": "evidence",
  "agreement.id": "internal identifier",
  "agreement.family": "E01 / E02 / E03 / E07",
  "agreement.type": "E01 / E02",
  "agreement.sourceClassification": "E03",
  "agreement.title": "E01 / E02",
  "agreement.programName": "E02 / E04",
  "agreement.counterpartyId": "E01 / E02 (department) / X07",
  "agreement.parties": "E01 / E02 (vendor or recipient as reported, role)",
  "agreement.currentValue": "E01 / E02 (latest total)",
  "agreement.originalValue": "E01 / E02",
  "agreement.currency": "E01 / E02",
  "agreement.valueBasis": "E01 / E02",
  "agreement.valueStatements": "E01 (maximum or announced values)",
  "agreement.rows": "E01 / E02 (amendment history) / X10",
  "agreement.attributions": "X05 / X06 (attributable value)",
  "agreement.announcedOn": "E01 / E02",
  "agreement.startOn": "E01 / E02 / X10",
  "agreement.status": "E01 / E02",
  "agreement.repayability": "E02",
  "agreement.externalIds": "E01 / E02 (identifiers)",
  "agreement.verification": "review state",
  "agreement.epistemic": "evidence class",
  "agreement.sourceIds": "evidence",
  "agreement.citations": "evidence",
  "agreement.thresholdValueCad": "X07 (drawn at overview when CA$100K or more)",
  "acquisition.id": "internal identifier",
  "acquisition.targetId": "A15",
  "acquisition.acquirerId": "A15",
  "acquisition.announcedOn": "A15",
  "acquisition.completedOn": "A15",
  "acquisition.consideration": "A15",
  "acquisition.withheldReports": "A15 (anonymous price reports withheld)",
  "acquisition.sourceIds": "evidence",
  "acquisition.citations": "evidence",
};
