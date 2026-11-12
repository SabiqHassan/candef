import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addSource } from "./authoring";
import { loadResearchCorpus } from "./load";
import { checkLinks, isCosmeticRedirect, isErrorPageAddress } from "./links";

describe("candef check-links (local test server)", () => {
  let server: Server;
  let base = "";
  const hits: string[] = [];
  const glitched = new Set<string>();
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("User-agent: *\nDisallow: /private/\n");
      }
      if (req.url === "/old") {
        res.writeHead(301, { location: "/new" });
        return res.end();
      }
      if (req.url === "/new" || req.url === "/ok") {
        res.writeHead(200);
        return res.end("fine");
      }
      if (req.url === "/slash") {
        res.writeHead(301, { location: "/slash/" });
        return res.end();
      }
      if (req.url === "/slash/") {
        res.writeHead(200);
        return res.end("fine");
      }
      if (req.url === "/vanished") {
        res.writeHead(302, { location: "/errors/404.html" });
        return res.end();
      }
      if (req.url === "/glitch") {
        // Only the first request is bounced to the error page; the next one is served normally.
        if (!glitched.has(req.url)) {
          glitched.add(req.url);
          res.writeHead(302, { location: "/errors/404.html" });
          return res.end();
        }
        res.writeHead(200);
        return res.end("fine");
      }
      if (req.url === "/errors/404.html") {
        res.writeHead(200);
        return res.end("Page not found");
      }
      if (req.url === "/gone") {
        res.writeHead(410);
        return res.end();
      }
      if (req.url === "/no-head") {
        res.writeHead(req.method === "HEAD" ? 405 : 200);
        return res.end();
      }
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("classifies ok, moved, gone, transient and robots-blocked sources and records them", async () => {
    const root = mkdtempSync(join(tmpdir(), "candef-links-"));
    const id = (path: string) =>
      addSource(root, {
        url: `${base}${path}`,
        kind: "news",
        tier: "T3",
        publisher: "Fictional",
        title: path,
      }).id;
    const ids = {
      ok: id("/ok"),
      old: id("/old"),
      gone: id("/gone"),
      flaky: id("/flaky"),
      private: id("/private/page"),
      noHead: id("/no-head"),
      slash: id("/slash"),
      vanished: id("/vanished"),
      glitch: id("/glitch"),
    };
    const results = await checkLinks(root, {
      perHostDelayMs: 0,
      now: new Date("2026-10-13T12:00:00Z"),
    });
    const by = Object.fromEntries(results.map((r) => [r.sourceId, r.availability]));
    expect(by[ids.ok]).toBe("ok");
    expect(by[ids.old]).toBe("moved");
    expect(by[ids.gone]).toBe("unavailable");
    expect(by[ids.flaky]).toBe("unknown"); // a 503 never marks a source as gone
    expect(by[ids.private]).toBe("unknown");
    expect(by[ids.noHead]).toBe("ok"); // HEAD refused, GET fallback
    expect(by[ids.slash]).toBe("ok"); // a trailing-slash redirect is not a move
    expect(by[ids.vanished]).toBe("unavailable"); // an error page on two separate requests
    expect(by[ids.glitch]).toBe("ok"); // one odd answer is not enough to call a source gone
    expect(hits).not.toContain("HEAD /private/page");
    expect(hits.filter((h) => h === "GET /robots.txt")).toHaveLength(1);
    const src = loadResearchCorpus(root).corpus!.sources.find((s) => s.id === ids.gone)!;
    expect(src.availability).toBe("unavailable");
    expect(src.lastCheckedAt).toBe("2026-10-13T12:00:00.000Z");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("address comparison", () => {
  it("treats only address normalisation as cosmetic", () => {
    const same: [string, string][] = [
      ["http://example.org/a", "https://example.org/a"],
      ["https://example.org/a", "https://www.example.org/a/"],
      ["https://Example.org/A", "https://example.org/a#top"],
    ];
    for (const [a, b] of same) expect(isCosmeticRedirect(a, b), `${a} ${b}`).toBe(true);
    const different: [string, string][] = [
      ["https://example.org/company", "https://example.org/careers"],
      ["https://example.org/a?id=1", "https://example.org/a?id=2"],
      ["https://example.org/a", "https://other.example/a"],
      ["https://example.org/a", "not a url"],
    ];
    for (const [a, b] of different) expect(isCosmeticRedirect(a, b), `${a} ${b}`).toBe(false);
  });

  it("recognises generic error pages but not articles that mention them", () => {
    for (const u of [
      "https://www.canada.ca/errors/404.html",
      "https://example.org/404",
      "https://example.org/404/",
      "https://example.org/page-not-found",
      "https://example.org/en/not-found.html",
      "https://example.org/error",
    ])
      expect(isErrorPageAddress(u), u).toBe(true);
    for (const u of [
      "https://example.org/news/2022/error-in-the-404-report",
      "https://example.org/company/overview",
      "https://example.org/",
      "not a url",
    ])
      expect(isErrorPageAddress(u), u).toBe(false);
  });
});
