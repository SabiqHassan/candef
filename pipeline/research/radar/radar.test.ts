import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Corpus } from "../../../src/domain/schema/corpus";
import { limitToRecords } from "../clearance/run";
import { buildNameIndex, findMentions, matchName } from "./match";
import {
  extractAmounts,
  formDPrimaryDocUrl,
  parseDailyIndex,
  parseFeed,
  parseFormDSubmission,
  inScope,
} from "./parse";
import { isCanadianStateCode } from "./sources";
import { dailyIndexUrl, formDLead, sweep, weekdays } from "./sweep";

// Synthetic test data only: invented companies, numbers and URLs.

const INDEX = `Description:           Daily Index of EDGAR Dissemination Feed by Form Type
Last Data Received:    Oct 29, 2026

Form Type   Company Name                                                  CIK         Date Filed  File Name
---------------------------------------------------------------------------------------------------------------------------------------------
1-A/A            EXAMPLE ARTS RESEARCH, INC.                             1083468     20261029    edgar/data/1083468/0001683168-26-008153.txt
D                Example Robotics Inc.                                    2000001     20261029    edgar/data/2000001/0002000001-26-000001.txt
D/A              Example Fund LP                                          2000002     20261029    edgar/data/2000002/0002000002-26-000002.txt
SC 13G           Some Holder LLC                                          2000003     20261029    edgar/data/2000003/0002000003-26-000003.txt
`;

function submission(o: {
  accession: string;
  cik: string;
  name: string;
  state: string;
  city: string;
  industry?: string;
  fundType?: string;
  sold?: string;
  offered?: string;
  firstSale?: string;
  type?: string;
}) {
  return `<SEC-DOCUMENT>${o.accession}.txt : 20261029
<SEC-HEADER>${o.accession}.hdr.sgml : 20261029
ACCESSION NUMBER:		${o.accession}
CONFORMED SUBMISSION TYPE:	${o.type ?? "D"}
FILED AS OF DATE:		20261029

FILER:

	COMPANY DATA:
		COMPANY CONFORMED NAME:			${o.name}
		CENTRAL INDEX KEY:			000${o.cik}

	BUSINESS ADDRESS:
		STREET 1:		1 EXAMPLE STREET
		CITY:			${o.city}
		STATE:			${o.state}
		ZIP:			K1A 0A1
</SEC-HEADER>
<DOCUMENT>
<TYPE>${o.type ?? "D"}
<TEXT>
<XML>
<?xml version="1.0"?>
<edgarSubmission>
  <submissionType>${o.type ?? "D"}</submissionType>
  <primaryIssuer>
    <entityName>${o.name}</entityName>
    <issuerAddress><city>${o.city}</city><stateOrCountry>${o.state}</stateOrCountry></issuerAddress>
    <jurisdictionOfInc>CANADA</jurisdictionOfInc>
    <yearOfInc><withinFiveYears>true</withinFiveYears><value>2021</value></yearOfInc>
  </primaryIssuer>
  <relatedPersonsList><relatedPersonInfo><relatedPersonName><firstName>Should</firstName><lastName>NotAppear</lastName></relatedPersonName></relatedPersonInfo></relatedPersonsList>
  <offeringData>
    <industryGroup><industryGroupType>${o.industry ?? "Other Technology"}</industryGroupType>${o.fundType ? `<investmentFundInfo><investmentFundType>${o.fundType}</investmentFundType></investmentFundInfo>` : ""}</industryGroup>
    <typeOfFiling><newOrAmendment><isAmendment>${o.type === "D/A" ? "true" : "false"}</isAmendment></newOrAmendment><dateOfFirstSale>${o.firstSale ? `<value>${o.firstSale}</value>` : "<yetToOccur>true</yetToOccur>"}</dateOfFirstSale></typeOfFiling>
    <typesOfSecuritiesOffered><isEquityType>true</isEquityType><isOptionToAcquireType>true</isOptionToAcquireType></typesOfSecuritiesOffered>
    <offeringSalesAmounts><totalOfferingAmount>${o.offered ?? "5000000"}</totalOfferingAmount><totalAmountSold>${o.sold ?? "2500000"}</totalAmountSold></offeringSalesAmounts>
  </offeringData>
</edgarSubmission>
</XML>
</TEXT>
</DOCUMENT>
</SEC-DOCUMENT>`;
}

function corpus(): Corpus {
  return {
    organizations: [
      {
        id: "org_a",
        kind: "company",
        slug: "example-robotics",
        name: "Example Robotics",
        mergedInto: null,
        isDemo: false,
      },
      {
        id: "org_b",
        kind: "company",
        slug: "photonic-example",
        name: "Photonic",
        mergedInto: null,
        isDemo: false,
      },
      {
        id: "org_c",
        kind: "investor",
        slug: "example-capital",
        name: "Example Capital",
        mergedInto: null,
        isDemo: false,
      },
    ],
    assertions: [
      {
        id: "asr_1",
        subjectId: "org_b",
        predicate: "legal_name",
        value: "Photonic Inc.",
        verification: "proposed",
      },
      {
        id: "asr_2",
        subjectId: "org_a",
        predicate: "legal_name",
        value: "Example Robotics Inc.",
        verification: "proposed",
      },
    ],
    rounds: [],
  } as unknown as Corpus;
}

describe("radar parsers", () => {
  it("parses the daily index, including form types with spaces", () => {
    const e = parseDailyIndex(INDEX);
    expect(e.map((x) => x.formType)).toEqual(["1-A/A", "D", "D/A", "SC 13G"]);
    expect(e[1]).toEqual({
      formType: "D",
      company: "Example Robotics Inc.",
      cik: "2000001",
      dateFiled: "2026-10-29",
      path: "edgar/data/2000001/0002000001-26-000001.txt",
    });
  });

  it("reads issuer-level Form D fields and never the related persons", () => {
    const txt = submission({
      accession: "0002000001-26-000001",
      cik: "2000001",
      name: "Example Robotics Inc.",
      state: "A6",
      city: "OTTAWA",
      firstSale: "2026-10-01",
    });
    const d = parseFormDSubmission(txt)!;
    expect(d).toMatchObject({
      accession: "0002000001-26-000001",
      cik: "2000001",
      submissionType: "D",
      filedOn: "2026-10-29",
      businessState: "A6",
      businessCity: "OTTAWA",
      entityName: "Example Robotics Inc.",
      issuerState: "A6",
      yearOfInc: "2021",
      industryGroup: "Other Technology",
      isAmendment: false,
      dateOfFirstSale: "2026-10-01",
      firstSaleYetToOccur: false,
      totalOfferingAmount: "5000000",
      totalAmountSold: "2500000",
      securities: ["equity", "option or warrant"],
    });
    expect(JSON.stringify(d)).not.toContain("NotAppear");
    expect(
      parseFormDSubmission(
        txt.replace("CONFORMED SUBMISSION TYPE:\tD", "CONFORMED SUBMISSION TYPE:\t10-K"),
      ),
    ).toBeNull();
    expect(formDPrimaryDocUrl("2000001", "0002000001-26-000001")).toBe(
      "https://www.sec.gov/Archives/edgar/data/2000001/000200000126000001/primary_doc.xml",
    );
  });

  it("knows the EDGAR codes for Canada", () => {
    expect(["A0", "A6", "A8", "B0", "Z4", "a6"].every(isCanadianStateCode)).toBe(true);
    expect(["MD", "NY", "X0", "", null].some(isCanadianStateCode)).toBe(false);
  });

  it("parses Atom and RSS feeds, decoding entities and CDATA", () => {
    const atom = parseFeed(
      `<feed><entry><title>Example &amp; Co. gets $2 million</title><id>https://www.canada.ca/a.html</id><summary type="html">&lt;p&gt;Funding for drones&lt;/p&gt;</summary><author><name>National Defence</name></author><category term="news releases"/><updated>2026-10-30T15:07:12-04:00</updated><link href="https://www.canada.ca/a.html"/></entry></feed>`,
    );
    expect(atom).toEqual([
      {
        title: "Example & Co. gets $2 million",
        link: "https://www.canada.ca/a.html",
        published: "2026-10-30T15:07:12-04:00",
        summary: "Funding for drones",
        author: "National Defence",
        category: "news releases",
      },
    ]);
    const rss = parseFeed(
      `<rss><channel><item><title><![CDATA[Example raises $5M]]></title><link>https://example.test/a</link><pubDate>Fri, 30 Oct 2026 10:00:00 +0000</pubDate><description><![CDATA[<p>A seed round</p>]]></description></item></channel></rss>`,
    );
    expect(rss[0]).toMatchObject({
      title: "Example raises $5M",
      link: "https://example.test/a",
      summary: "A seed round",
    });
  });

  it("extracts dollar amounts as written", () => {
    expect(
      extractAmounts(
        "PrairiesCan provides $2,993,348; the US$4.5 million round and C$12M, again $2,993,348.",
      ),
    ).toEqual(["$2,993,348", "US$4.5 million", "C$12M"]);
    expect(extractAmounts("part of a $3.8-billion plan")).toEqual(["$3.8-billion"]);
  });

  it("keeps scope words narrow", () => {
    for (const text of [
      "a contract with the Canadian Space Agency",
      "space-based surveillance",
      "dual-use robotics",
      "Regional Defence Investment Initiative",
      "an IDEaS challenge award",
    ])
      expect(inScope(text), text).toBe(true);
    for (const text of [
      "a food security project in the Arctic",
      "new lab space for the college",
      "strengthening economic sovereignty",
      "new ideas for local businesses",
    ])
      expect(inScope(text), text).toBe(false);
  });
});

describe("radar matching", () => {
  it("matches filer names exactly and mentions only distinctive names", () => {
    const idx = buildNameIndex(corpus());
    expect(matchName(idx, "EXAMPLE ROBOTICS INC.").map((r) => r.slug)).toEqual([
      "example-robotics",
    ]);
    expect(matchName(idx, "Example Robotics Holdings Inc.")).toEqual([]);
    // Investors are not matched as companies.
    expect(matchName(idx, "Example Capital")).toEqual([]);
    expect(
      findMentions(idx, "Minister announces support for Example Robotics Inc. in Ottawa").map(
        (r) => r.slug,
      ),
    ).toEqual(["example-robotics"]);
    // A single ordinary word is never a mention.
    expect(findMentions(idx, "New photonic sensors for the Arctic")).toEqual([]);
  });

  it("ranks Form D leads: existing, fund, candidate, low", () => {
    const idx = buildNameIndex(corpus());
    const lead = (name: string, extra: Partial<Parameters<typeof submission>[0]> = {}) =>
      formDLead(
        parseFormDSubmission(
          submission({
            accession: "0000000001-26-000001",
            cik: "1",
            name,
            state: "A6",
            city: "TORONTO",
            ...extra,
          }),
        )!,
        idx,
      );
    expect(lead("Example Robotics Inc.").relevance).toBe("existing");
    expect(lead("Example Robotics Inc.").place).toBe("Toronto, ON");
    expect(
      lead("Some Fund LP", { industry: "Pooled Investment Fund", fundType: "Venture Capital Fund" })
        .relevance,
    ).toBe("fund");
    expect(lead("New Sensor Co.").relevance).toBe("candidate");
    expect(lead("Condo Partners Inc.", { industry: "Residential" }).relevance).toBe("low");
  });
});

describe("radar dates", () => {
  it("lists weekdays and builds index URLs", () => {
    expect(weekdays("2026-10-30", "2026-11-02")).toEqual(["2026-10-30", "2026-11-02"]);
    expect(dailyIndexUrl("2026-10-29")).toBe(
      "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261029.idx",
    );
    expect(dailyIndexUrl("2026-01-05")).toContain("/2026/QTR1/form.20260105.idx");
  });
});

describe("clearance record filter", () => {
  it("keeps only listed records, or all without a list", () => {
    const recs = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(limitToRecords(recs, ["c", "a"]).map((r) => r.id)).toEqual(["a", "c"]);
    expect(limitToRecords(recs, null)).toBe(recs);
  });
});

describe("sweep", () => {
  it("reads only allowed paths, writes leads and state, and does not repeat seen items", async () => {
    const pages: Record<string, { status: number; body: string }> = {
      "https://www.sec.gov/robots.txt": {
        status: 200,
        body: "User-agent: *\nDisallow: /cgi-bin\n",
      },
      [dailyIndexUrl("2026-10-29")]: { status: 200, body: INDEX },
      "https://www.sec.gov/Archives/edgar/data/2000001/0002000001-26-000001.txt": {
        status: 200,
        body: submission({
          accession: "0002000001-26-000001",
          cik: "2000001",
          name: "Example Robotics Inc.",
          state: "A6",
          city: "OTTAWA",
          firstSale: "2026-10-01",
        }),
      },
      "https://www.sec.gov/Archives/edgar/data/2000002/0002000002-26-000002.txt": {
        status: 200,
        body: submission({
          accession: "0002000002-26-000002",
          cik: "2000002",
          name: "Example Fund LP",
          state: "NY",
          city: "NEW YORK",
          type: "D/A",
        }),
      },
      "https://api.io.canada.ca/robots.txt": { status: 404, body: "" },
      "https://www.canada.ca/robots.txt": {
        status: 200,
        body: "User-agent: *\nDisallow: /en/sr/srb.html\n",
      },
      "https://www.canada.ca/en/news/a.html": {
        status: 200,
        body: "<html><nav>Menu</nav><main><h1>Support</h1><p>The Minister announced $1,500,000 for Example Robotics Inc. to build uncrewed vehicles for Arctic surveillance.</p></main></html>",
      },
    };
    const feed = `<feed><entry><title>Government invests in Arctic drones</title><summary>Investment in defence innovation</summary><author><name>National Defence</name></author><updated>2026-10-30T10:00:00-04:00</updated><link href="https://www.canada.ca/en/news/a.html"/></entry><entry><title>Minister visits a base</title><summary>A visit</summary><updated>2026-10-30T09:00:00-04:00</updated><link href="https://www.canada.ca/en/news/b.html"/></entry></feed>`;
    const asked: string[] = [];
    const fakeFetch = (async (input: string | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.startsWith("https://api.io.canada.ca/io-server/"))
        return new Response(
          url.includes("dept=departmentnationaldefense") ? feed : "<feed></feed>",
        );
      const p = pages[url];
      return p
        ? new Response(p.body, { status: p.status })
        : new Response("missing", { status: 404 });
    }) as typeof fetch;
    const cacheDir = mkdtempSync(join(tmpdir(), "radar-"));
    const opts = {
      corpus: corpus(),
      cacheDir,
      today: "2026-10-30",
      since: "2026-10-29",
      until: "2026-10-29",
      fetchImpl: fakeFetch,
      sleep: async () => {},
      now: () => Date.parse("2026-10-30T20:15:00Z"),
    };
    const r = await sweep(opts);
    expect(r.dir).toBe(join(cacheDir, "radar", "2026-10-30T2015Z"));
    const round = r.leads.find((l) => l.kind === "private_round")!;
    expect(round).toMatchObject({
      relevance: "existing",
      reportedName: "Example Robotics Inc.",
      place: "Ottawa, ON",
    });
    expect(round.matches.map((m) => m.how)).toEqual(["exact-name"]);
    // The New York fund is read once, then remembered as outside Canada.
    expect(r.leads.filter((l) => l.kind === "private_round")).toHaveLength(1);
    const gov = r.leads.find((l) => l.kind === "government_announcement")!;
    expect(gov).toMatchObject({
      relevance: "existing",
      amounts: ["$1,500,000"],
      department: "National Defence",
    });
    // The release without money words is not opened.
    expect(asked).not.toContain("https://www.canada.ca/en/news/b.html");
    expect(asked.some((u) => u.includes("/cgi-bin"))).toBe(false);
    const md = readFileSync(join(r.dir!, "leads.md"), "utf8");
    expect(md).toContain("## 1. Private rounds at companies already in CANDEF (1)");
    expect(md).toContain("$2,500,000 of $5,000,000");
    expect(md).toContain("## 2. Announcements naming CANDEF companies (1)");
    expect(existsSync(join(cacheDir, "radar", "state.json"))).toBe(true);

    // A second sweep over the same window finds nothing new.
    const again = await sweep({ ...opts, now: () => Date.parse("2026-10-30T21:00:00Z") });
    expect(again.leads).toHaveLength(0);
    expect(again.stats.sec.skippedKnownForeign).toBe(0);
  });
});
