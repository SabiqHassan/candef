import { describe, expect, it } from "vitest";
import {
  captureText,
  matchDate,
  matchIdentifier,
  matchMoney,
  matchName,
  matchProvince,
  matchTicker,
  matchYear,
  normalize,
} from "./match";

// All page text below is fictional.
const page = (html: string) => captureText(html, "html");

describe("normalization", () => {
  it("folds accents, case, entities, typographic quotes and dashes, and whitespace", () => {
    expect(normalize("Nüvü  Caméras Inc. — “Québec” l’entreprise")).toBe(
      'nuvu cameras inc. - "quebec" l\'entreprise',
    );
    expect(page("<p>Fran&ccedil;ais &eacute;t&eacute; &ndash; A&amp;B</p><script>x</script>")).toBe(
      "francais ete - a&b",
    );
  });
});

describe("names", () => {
  const text = page("<p>Fictional Robotics Incorporated (the Company) and Alpha Labs Ltée</p>");
  it("treats legal-form variants as equivalent", () => {
    expect(matchName(text, "Fictional Robotics Inc.").found).toBe(true);
    expect(matchName(text, "Fictional Robotics Inc").found).toBe(true);
    expect(matchName(text, "Alpha Labs Limited").found).toBe(true);
    expect(matchName(text, "Alpha Labs Ltd.").found).toBe(true);
  });
  it("folds accents in names", () => {
    expect(matchName(page("<p>Nuvu Cameras Inc.</p>"), "Nüvü Caméras Inc.").found).toBe(true);
  });
  it("never matches a partial name", () => {
    expect(matchName(text, "Fictional Robotics Systems Inc.").found).toBe(false);
    expect(matchName(page("<p>Fictional Roboticsware Inc.</p>"), "Fictional Robotics").found).toBe(
      false,
    );
    expect(matchName(page("<p>Superfictional Robotics</p>"), "Fictional Robotics").found).toBe(
      false,
    );
  });
  it("records the offset of the match", () => {
    const t = normalize("intro text. Alpha Labs Ltd.");
    expect(matchName(t, "Alpha Labs Limited").offset).toBe(t.indexOf("alpha"));
  });
});

describe("identifiers", () => {
  it("compares digits exactly, ignoring hyphens and spaces", () => {
    const t = normalize("Corporation number: 1234567-8 Business number (BN): 123456789RC0001");
    expect(matchIdentifier(t, "1234567-8").found).toBe(true);
    expect(matchIdentifier(t, "123456789").found).toBe(true);
    expect(matchIdentifier(t, "23456789").found).toBe(false);
    expect(matchIdentifier(t, "1234567").found).toBe(false);
  });
  it("finds a number inside a run of several numbers, but never a partial one", () => {
    const t = normalize("BN 123 456 789 1234567-8");
    expect(matchIdentifier(t, "123456789").found).toBe(true);
    expect(matchIdentifier(t, "12345678").found).toBe(true); // the corporation number
    expect(matchIdentifier(t, "45678912").found).toBe(false);
  });
  it("matches a ticker only as a whole word", () => {
    const t = normalize("Listed on the TSX Venture Exchange as FICT; ficticious is not it");
    expect(matchTicker(t, "FICT").found).toBe(true);
    expect(matchTicker(normalize("FICTX holdings"), "FICT").found).toBe(false);
  });
});

describe("years and dates", () => {
  it("matches a year only as a whole word", () => {
    expect(matchYear(normalize("Incorporated 2017-07-19"), 2017).found).toBe(true);
    expect(matchYear(normalize("serial 120175"), 2017).found).toBe(false);
    expect(matchYear(normalize("$2,017 raised"), 2017).found).toBe(false);
  });
  it("matches English and French full dates", () => {
    for (const s of [
      "on 2023-04-13 the",
      "on April 13, 2023 the",
      "on Apr. 13 2023 the",
      "on 13 April 2023 the",
      "le 13 avril 2023, la",
    ])
      expect(matchDate(normalize(s), "2023-04-13").found, s).toBe(true);
    expect(matchDate(normalize("le 1er juin 2020"), "2020-06-01").found).toBe(true);
    expect(matchDate(normalize("le 11 juin 2020"), "2020-06-01").found).toBe(false);
    expect(matchDate(normalize("April 14, 2023"), "2023-04-13").found).toBe(false);
  });
  it("matches a month-precision date", () => {
    expect(matchDate(normalize("in October 2018, the"), "2018-10").found).toBe(true);
    expect(matchDate(normalize("en octobre 2018"), "2018-10").found).toBe(true);
    expect(matchDate(normalize("in November 2018"), "2018-10").found).toBe(false);
  });
});

describe("places", () => {
  it("matches a province by name anywhere, or by abbreviation in an address", () => {
    expect(matchProvince(normalize("based in Ontario"), "ON").found).toBe(true);
    expect(matchProvince(normalize("Ottawa, ON K1A 0B1"), "ON", "Ottawa").found).toBe(true);
    expect(matchProvince(normalize("Halifax, N.S."), "NS", "Halifax").found).toBe(true);
    expect(matchProvince(normalize("Montreal, Québec"), "QC").found).toBe(true);
  });
  it("never takes an ordinary word for a province abbreviation", () => {
    expect(matchProvince(normalize("Read more on our blog"), "ON").found).toBe(false);
    expect(matchProvince(normalize("ce que nous faisons"), "QC").found).toBe(false);
  });
});

describe("money", () => {
  const usd = (amount: string, asStated: string) => ({ amount, currency: "USD", asStated });
  it("does not read table columns with mixed separators as one number (and does not throw)", () => {
    const m = usd("2772209", "$2,772,209");
    expect(() => matchMoney(normalize("balances 2,772 209,477 271 total"), m)).not.toThrow();
    expect(matchMoney(normalize("balances 2,772 209,477 271 total"), m).found).toBe(false);
    expect(matchMoney(normalize("proceeds of $2,772,209 were"), m).found).toBe(true);
  });
  it("matches common written forms", () => {
    const m = usd("92000000", "US$92 million");
    expect(matchMoney(normalize("raised US$92 million in a"), m).found).toBe(true);
    expect(matchMoney(normalize("raised US$92M in a"), m).found).toBe(true);
    expect(matchMoney(normalize("raised USD 92,000,000 in a"), m).found).toBe(true);
    expect(matchMoney(normalize("a 92 million USD round"), m).found).toBe(true);
  });
  it("accepts a rounded amount only to the precision of asStated", () => {
    const m = usd("402505000", "$402.5 million");
    expect(matchMoney(normalize("a $402.5 million round"), m).found).toBe(true);
    expect(matchMoney(normalize("a $400 million round"), m).found).toBe(false);
    expect(matchMoney(normalize("a $403 million round"), m).found).toBe(false);
    // An exact record value needs the exact figure on the page.
    const exact = { amount: "4655725.77", currency: "CAD", asStated: "$4,655,725.77" };
    expect(matchMoney(normalize("value: $4,655,725.77"), exact).found).toBe(true);
    expect(matchMoney(normalize("value: $4.7 million"), exact).found).toBe(false);
  });
  it("matches an amount written in words", () => {
    const m = usd("32000000", "US$32 million");
    expect(matchMoney(normalize("a thirty-two million US dollar round"), m).found).toBe(true);
    expect(matchMoney(normalize("a thirty million US dollar round"), m).found).toBe(false);
  });
  it("refuses a different currency", () => {
    const m = usd("92000000", "US$92 million");
    expect(matchMoney(normalize("raised CA$92 million in a"), m).found).toBe(false);
    expect(matchMoney(normalize("raised €92 million in a"), m).found).toBe(false);
    // The nearest marker decides: a USD figure next to a CAD one.
    expect(matchMoney(normalize("CA$120 million, or US$92 million"), m).found).toBe(true);
  });
  it("counts a bare $ only when asStated uses a bare $", () => {
    const bare = { amount: "25000000", currency: "CAD", asStated: "$25 million" };
    expect(matchMoney(normalize("secured $25 million in funding"), bare).found).toBe(true);
    const marked = { amount: "25000000", currency: "CAD", asStated: "CAD 25,000,000" };
    expect(matchMoney(normalize("secured $25 million in funding"), marked).found).toBe(false);
    expect(matchMoney(normalize("a 25 M$ financing"), bare).found).toBe(true);
  });
  it("needs no marker when the currency is unknown, and ignores metres", () => {
    const m = { amount: "5000000", currency: "unknown", asStated: "5 million" };
    expect(matchMoney(normalize("a 5 million round"), m).found).toBe(true);
    expect(matchMoney(normalize("rated to 5 m depth"), m).found).toBe(false);
  });
  it("does not read an amount inside a larger number", () => {
    const m = usd("92000000", "US$92 million");
    expect(matchMoney(normalize("US$1,092,000,000 in total"), m).found).toBe(false);
  });
  it("reports where a value appears elsewhere on the page (known limit, for the audit)", () => {
    // The amount is the company's total raised, not the round: it still matches, and the offset
    // shows the auditor where. Requiring every key value, T2-e and the audit address this.
    const t = normalize("Fictional Alpha has raised US$92 million to date. Its seed round closed.");
    const r = matchMoney(t, usd("92000000", "US$92 million"));
    expect(r.found).toBe(true);
    expect(r.offset).toBe(t.indexOf("92 million"));
  });
});
