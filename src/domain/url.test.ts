import { describe, expect, it } from "vitest";
import { isHttpUrl, safeHref } from "./url";

describe("isHttpUrl", () => {
  it("accepts web addresses", () => {
    for (const u of [
      "https://example.org/a?b=c#d",
      "http://example.org",
      "HTTPS://EXAMPLE.ORG/x",
      "https://example.invalid/stress/1",
    ])
      expect(isHttpUrl(u), u).toBe(true);
  });
  it("rejects anything a click could run or that is not a web address", () => {
    for (const u of [
      "javascript:alert(1)",
      " javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///C:/secret.txt",
      "ftp://example.org/x",
      "vbscript:msgbox(1)",
      "//example.org/x",
      "example.org/x",
      "/relative",
      "",
      "not a url",
    ])
      expect(isHttpUrl(u), JSON.stringify(u)).toBe(false);
    for (const v of [null, undefined, 5, {}, []]) expect(isHttpUrl(v)).toBe(false);
  });
  it("safeHref returns the address unchanged or null", () => {
    expect(safeHref("https://example.org/a")).toBe("https://example.org/a");
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });
});
