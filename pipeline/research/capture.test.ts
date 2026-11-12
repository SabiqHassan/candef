import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addSource } from "./authoring";
import {
  USER_AGENT,
  captureSource,
  fingerprintSource,
  registerLocalCapture,
  robotsAllows,
  sha256File,
  visibleText,
} from "./capture";
import { loadResearchCorpus } from "./load";

describe("robots.txt", () => {
  const robots = `
User-agent: *
Disallow: /private/
Allow: /private/press/
Disallow: /*.pdf$

User-agent: CANDEF-research
Disallow: /no-candef/
`;
  it("applies the most specific group and the longest matching rule", () => {
    expect(robotsAllows(robots, USER_AGENT, "/news/item")).toBe(true);
    expect(robotsAllows(robots, USER_AGENT, "/no-candef/x")).toBe(false);
    // The CANDEF group replaces the * group entirely.
    expect(robotsAllows(robots, USER_AGENT, "/private/x")).toBe(true);
    expect(robotsAllows(robots, "OtherBot/1.0", "/private/x")).toBe(false);
    expect(robotsAllows(robots, "OtherBot/1.0", "/private/press/x")).toBe(true);
    expect(robotsAllows(robots, "OtherBot/1.0", "/files/a.pdf")).toBe(false);
    expect(robotsAllows(robots, "OtherBot/1.0", "/files/a.pdf?x=1")).toBe(true);
  });
  it("treats an empty Disallow as allowing everything", () => {
    expect(robotsAllows("User-agent: *\nDisallow:\n", USER_AGENT, "/anything")).toBe(true);
  });
});

describe("visible text for change detection", () => {
  it("ignores markup, scripts and whitespace", () => {
    const a = visibleText("<html><script>x=1</script><p>Alpha&nbsp;raised  <b>$2M</b></p></html>");
    const b = visibleText("<div>\n Alpha raised\n<span>$2M</span><style>p{}</style></div>");
    expect(a).toBe("Alpha raised $2M");
    expect(b).toBe(a);
  });
});

describe("candef capture (local test server)", () => {
  let server: Server;
  let base = "";
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.url} ${req.headers["user-agent"]}`);
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("User-agent: *\nDisallow: /blocked/\n");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><p>Fictional Alpha raised a seed round.</p></body></html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const setup = (path: string, capture: "allowed" | "unknown") => {
    const root = mkdtempSync(join(tmpdir(), "candef-cap-"));
    const cache = mkdtempSync(join(tmpdir(), "candef-cache-"));
    const { id, file } = addSource(root, {
      url: `${base}${path}`,
      kind: "company_release",
      tier: "T2",
      publisher: "Fictional Alpha",
      title: "Fictional page",
    });
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("capture: unknown", `capture: ${capture}`),
    );
    return {
      root,
      cache,
      id,
      cleanup: () => [root, cache].forEach((d) => rmSync(d, { recursive: true, force: true })),
    };
  };

  it("refuses when the capture permission has not been recorded as allowed", async () => {
    const t = setup("/news/a", "unknown");
    await expect(captureSource(t.root, t.id, { cacheDir: t.cache })).rejects.toThrow(
      /capture permission/,
    );
    t.cleanup();
  });
  it("refuses a path that robots.txt disallows", async () => {
    const t = setup("/blocked/page", "allowed");
    await expect(captureSource(t.root, t.id, { cacheDir: t.cache })).rejects.toThrow(
      /robots\.txt disallows/,
    );
    t.cleanup();
  });
  it("refuses a cache directory inside research/", async () => {
    const t = setup("/news/a", "allowed");
    await expect(captureSource(t.root, t.id, { cacheDir: join(t.root, "cache") })).rejects.toThrow(
      /outside research/,
    );
    t.cleanup();
  });
  it("stores the bytes outside research/, records hashes, and identifies CANDEF", async () => {
    const t = setup("/news/a", "allowed");
    const cap = await captureSource(t.root, t.id, { cacheDir: t.cache });
    expect(existsSync(join(t.cache, cap.path))).toBe(true);
    expect(cap.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cap.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.some((s) => s.startsWith("/news/a CANDEF-research/"))).toBe(true);
    const src = loadResearchCorpus(t.root).corpus!.sources[0]!;
    expect(src.captures?.[0]?.id).toBe(cap.id);
    expect(src.availability).toBe("ok");
    // No captured text is written into research/.
    expect(readFileSync(join(t.root, "sources", `${t.id}.yaml`), "utf8")).not.toMatch(/seed round/);
    t.cleanup();
  });

  it("fingerprints a source whose terms do not allow a copy: hashes only, no bytes kept", async () => {
    const t = setup("/news/a", "unknown");
    const fp = await fingerprintSource(t.root, t.id, {});
    expect(fp.id).toMatch(/^fp_/);
    expect(fp.textSha256).toBe(sha256Text("Fictional Alpha raised a seed round."));
    const src = loadResearchCorpus(t.root).corpus!.sources[0]!;
    expect(src.fingerprints?.[0]?.rawSha256).toBe(fp.rawSha256);
    expect(src.captures ?? []).toHaveLength(0);
    // Nothing is written to the cache, and the source file holds no page text.
    expect(existsSync(join(t.cache, "captures"))).toBe(false);
    expect(readFileSync(join(t.root, "sources", `${t.id}.yaml`), "utf8")).not.toMatch(/seed round/);
    t.cleanup();
  });
  it("fingerprinting still honours robots.txt", async () => {
    const t = setup("/blocked/page", "unknown");
    await expect(fingerprintSource(t.root, t.id, {})).rejects.toThrow(/robots\.txt disallows/);
    t.cleanup();
  });
});

const sha256Text = (s: string) => createHash("sha256").update(s).digest("hex");

describe("registering a local file as a capture", () => {
  const setup = (capture: "allowed" | "unknown") => {
    const root = mkdtempSync(join(tmpdir(), "candef-cap-"));
    const cache = mkdtempSync(join(tmpdir(), "candef-cache-"));
    const { id, file } = addSource(root, {
      url: "https://example.invalid/data",
      kind: "gov_dataset",
      tier: "T1",
      publisher: "Fictional Treasury",
      title: "Fictional dataset",
    });
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("capture: unknown", `capture: ${capture}`),
    );
    mkdirSync(join(cache, "gov-data"), { recursive: true });
    return {
      root,
      cache,
      id,
      cleanup: () => [root, cache].forEach((d) => rmSync(d, { recursive: true, force: true })),
    };
  };

  it("records a CSV in place: raw hash, text hash equal to it, cache-relative path", async () => {
    const t = setup("allowed");
    const csv = join(t.cache, "gov-data", "rows.csv");
    writeFileSync(csv, "a,b\n1,2\n");
    const cap = await registerLocalCapture(t.root, t.id, csv, {
      cacheDir: t.cache,
      method: "manual",
      retrievedAt: "2026-10-13T18:22:00.000Z",
    });
    expect(cap.path).toBe("gov-data/rows.csv");
    expect(cap.rawSha256).toBe(await sha256File(csv));
    expect(cap.textSha256).toBe(cap.rawSha256);
    expect(cap.method).toBe("manual");
    expect(cap.retrievedAt).toBe("2026-10-13T18:22:00.000Z");
    expect(loadResearchCorpus(t.root).corpus!.sources[0]!.captures?.[0]?.id).toBe(cap.id);
    t.cleanup();
  });
  it("hashes a browser save's visible text, or a supplied text file for a PDF", async () => {
    const t = setup("allowed");
    const html = join(t.cache, "gov-data", "page.html");
    writeFileSync(html, "<p>Fictional <b>Alpha</b></p><script>x</script>");
    const a = await registerLocalCapture(t.root, t.id, html, {
      cacheDir: t.cache,
      method: "browser",
    });
    expect(a.textSha256).toBe(sha256Text("Fictional Alpha"));
    const pdf = join(t.cache, "gov-data", "r.pdf");
    const txt = join(t.cache, "gov-data", "r.pdf.txt");
    writeFileSync(pdf, Buffer.from([0x25, 0x50, 0x44, 0x46]));
    writeFileSync(txt, "extracted");
    const b = await registerLocalCapture(t.root, t.id, pdf, {
      cacheDir: t.cache,
      method: "manual",
      textFile: txt,
    });
    expect(b.textSha256).toBe(sha256Text("extracted"));
    t.cleanup();
  });
  it("refuses without capture permission, and refuses files outside the cache", async () => {
    const t = setup("unknown");
    const csv = join(t.cache, "gov-data", "rows.csv");
    writeFileSync(csv, "a\n");
    await expect(
      registerLocalCapture(t.root, t.id, csv, { cacheDir: t.cache, method: "manual" }),
    ).rejects.toThrow(/capture permission/);
    const u = setup("allowed");
    const outside = join(u.root, "x.csv");
    writeFileSync(outside, "a\n");
    await expect(
      registerLocalCapture(u.root, u.id, outside, { cacheDir: u.cache, method: "manual" }),
    ).rejects.toThrow(/inside the capture cache/);
    t.cleanup();
    u.cleanup();
  });
});
