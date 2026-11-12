/** Review report on TEMPORARY SYNTHETIC corpora: before → after for proposed changes. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReviewReport } from "./report";
import { reviewRecords } from "./review";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("semantic review report", () => {
  it("shows the currently published value next to a proposed replacement", () => {
    const r = mkdtempSync(join(tmpdir(), "candef-report-"));
    roots.push(r);
    mkdirSync(join(r, "sources"));
    mkdirSync(join(r, "orgs"));
    writeFileSync(
      join(r, "sources", "src_h.yaml"),
      [
        "kind: company_release",
        "tier: T2",
        "publisher: Fictional Hotel",
        "title: About",
        "url: https://example.org/fictional-hotel",
        "publishedOn: null",
        'retrievedAt: "2026-10-13T00:00:00Z"',
        "originGroup: og:h",
        "textSha256: null",
        "",
      ].join("\n"),
    );
    const file = join(r, "orgs", "hotel.yaml");
    writeFileSync(
      file,
      [
        "org: { id: org_hotel, kind: company, slug: hotel, name: Fictional Hotel }",
        'defaults: { createdBy: "agent:test" }',
        "facts:",
        '  - { id: a_old, predicate: legal_name, value: Fictional Hotel Ltd., src: ["src_h#about"] }',
        "",
      ].join("\n"),
    );
    reviewRecords(r, { ids: ["a_old"], reviewer: "owner", at: "2026-10-13" });
    writeFileSync(
      file,
      readFileSync(file, "utf8") +
        '  - { id: a_new, predicate: legal_name, value: Fictional Hotel Inc., supersedes: a_old, src: ["src_h#about 2"] }\n',
    );
    const html = buildReviewReport(r, { today: "2026-10-13", cacheDir: join(r, "..", "cache") });
    const row = html.split("<tr>").find((t) => t.includes("<code>a_new</code>"))!;
    expect(row).toContain("Fictional Hotel Ltd."); // before
    expect(row).toContain("Fictional Hotel Inc."); // after
    expect(row).toContain("supersedes a_old");
    expect(html).not.toContain(
      "<tr><td>legal_name</td><td>Fictional Hotel Ltd.</td><td>Fictional Hotel Ltd.",
    ); // the approved one is not listed as proposed
  });
});

describe("value-in-capture check", () => {
  it("marks values found or not found in the captured page text", () => {
    const r = mkdtempSync(join(tmpdir(), "candef-report-"));
    const cache = mkdtempSync(join(tmpdir(), "candef-cache-"));
    roots.push(r, cache);
    mkdirSync(join(r, "sources"));
    mkdirSync(join(r, "orgs"));
    mkdirSync(join(cache, "captures", "src_k"), { recursive: true });
    writeFileSync(
      join(cache, "captures", "src_k", "cap_1.html"),
      "<html><body><h1>Fictional Kilo&nbsp;Inc.</h1><p>Founded in   2019.</p></body></html>",
    );
    writeFileSync(
      join(r, "sources", "src_k.yaml"),
      [
        "kind: company_release",
        "tier: T2",
        "publisher: Fictional Kilo",
        "title: About",
        "url: https://example.org/fictional-kilo",
        "publishedOn: null",
        'retrievedAt: "2026-10-13T00:00:00Z"',
        "originGroup: og:k",
        "textSha256: null",
        "captures:",
        '  - { id: cap_1, retrievedAt: "2026-10-13T00:00:00Z", method: http, rawSha256: x, textSha256: y, path: captures/src_k/cap_1.html }',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(r, "orgs", "kilo.yaml"),
      [
        "org: { id: org_kilo, kind: company, slug: kilo, name: Fictional Kilo }",
        'defaults: { createdBy: "agent:test" }',
        "facts:",
        '  - { id: k_legal, predicate: legal_name, value: Fictional Kilo Inc., src: ["src_k#h1"] }',
        '  - { id: k_founded, predicate: founded_year, value: 2019, src: ["src_k#para 1"] }',
        '  - { id: k_web, predicate: website, value: "https://kilo.example.org", src: ["src_k#footer"] }',
        "",
      ].join("\n"),
    );
    const html = buildReviewReport(r, { today: "2026-10-13", cacheDir: cache });
    const row = (id: string) => html.split("<tr>").find((t) => t.includes(`<code>${id}</code>`))!;
    expect(row("k_legal")).toContain("value found in capture");
    expect(row("k_founded")).toContain("value found in capture");
    expect(row("k_web")).toContain("value NOT found in capture");
    expect(html).not.toContain("Founded in"); // no capture text copied into the report
  });
});

describe("per-company approval command", () => {
  it("offers one review --org command listing only approvable records", () => {
    const r = mkdtempSync(join(tmpdir(), "candef-report-"));
    roots.push(r);
    mkdirSync(join(r, "sources"));
    mkdirSync(join(r, "orgs"));
    writeFileSync(
      join(r, "sources", "src_l.yaml"),
      'kind: company_release\ntier: T2\npublisher: Fictional Lima\ntitle: About\nurl: https://example.org/fictional-lima\npublishedOn: null\nretrievedAt: "2026-10-13T00:00:00Z"\noriginGroup: og:l\ntextSha256: null\n',
    );
    writeFileSync(
      join(r, "orgs", "lima.yaml"),
      'org: { id: org_lima, kind: company, slug: lima, name: Fictional Lima }\ndefaults: { createdBy: "agent:test" }\nfacts:\n  - { id: l_legal, predicate: legal_name, value: Fictional Lima Inc., src: ["src_l#about"] }\n  - { id: l_web, predicate: website, value: "https://lima.example.org", src: [{ source: src_l, locator: footer, quality: related_link }] }\n',
    );
    const html = buildReviewReport(r, { today: "2026-10-13", cacheDir: join(r, "..", "cache") });
    expect(html).toContain("npm run candef -- review --org lima");
    expect(html).toMatch(/approves the 1 record\(s\) that pass their evidence rule: l_legal\)/);
  });
});
