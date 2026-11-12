import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { find, locatorOf, norm, rowMatches } from "./find";
import { parseLocator } from "./locators";

const CONTRACTS = [
  "reference_number,vendor_name,vendor_postal_code,owner_org,contract_value,description_en",
  "C-1,Fictional Space Inc.,K1A,dnd-mdn,1000.00,Services",
  "C-2,FICTIONAL SPACE INC,M5V,csa-asc,2000.00,Services",
  "C-3,Other Co,K1A,dnd-mdn,3000.00,Services",
].join("\n");

describe("gov find (researcher discovery)", () => {
  it("normalizes case, accents and punctuation", () => {
    expect(norm("Société  Fictive, Inc.")).toBe("societe fictive inc");
  });
  it("finds name hits with locators and narrows by owner", async () => {
    const hits = await find("contracts", Readable.from([CONTRACTS]), {
      names: ["fictional space"],
    });
    expect(hits.map((h) => parseLocator(h.locator)?.get("reference_number"))).toEqual([
      "C-1",
      "C-2",
    ]);
    const dnd = await find("contracts", Readable.from([CONTRACTS]), {
      names: [],
      owner: "dnd-mdn",
    });
    expect(dnd.map((h) => h.row.vendor_name)).toEqual(["Fictional Space Inc.", "Other Co"]);
  });
  it("matches grant operating names and program filters, with amendment locators", () => {
    const row = {
      ref_number: "G-1",
      amendment_number: "2",
      recipient_legal_name: "Fictional Holdings",
      recipient_operating_name: "Fictional Sensors",
      prog_name_en: "Regional Defence Investment Initiative (RDII)",
      owner_org: "x",
    };
    expect(rowMatches("grants", row, { names: ["fictional sensors"] })).toBe(true);
    expect(rowMatches("grants", row, { names: [], program: "defence investment" })).toBe(true);
    expect(rowMatches("grants", row, { names: [], program: "space" })).toBe(false);
    expect(locatorOf("grants", row)).toContain("ref_number=G-1;amendment_number=2;");
  });
});
