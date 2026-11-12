import { describe, expect, it } from "vitest";
import { CkanClient, robotsPolicy } from "./client";

function harness(replies: Response[]) {
  let time = 0;
  const calls: { url: URL; at: number; init?: RequestInit }[] = [];
  const client = new CkanClient({
    termsReviewed: true,
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    fetch: async (url, init) => {
      calls.push({ url: new URL(String(url)), at: time, init });
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected network call");
      return reply;
    },
  });
  return { client, calls };
}
const json = (result: unknown) => Response.json({ success: true, result });
const allowed = () => [
  new Response("User-agent: *\nDisallow: /private\nCrawl-delay: 30"),
  new Response("Fictional terms accepted by test operator"),
];

describe("CKAN read-only transport", () => {
  it("spaces robots, terms, retries and API requests, and encodes exact filters", async () => {
    const { client, calls } = harness([
      ...allowed(),
      new Response("busy", { status: 503 }),
      json({ records: [], fields: [], total: 0 }),
    ]);
    await client.search("fictional-resource", {
      filters: { owner_org: "fictional-dept" },
      limit: 0,
    });
    expect(calls.map((c) => c.at)).toEqual([0, 30000, 60000, 100000]);
    expect(calls[3]!.url.searchParams.get("filters")).toBe('{"owner_org":"fictional-dept"}');
    expect(new Headers(calls[3]!.init?.headers).get("User-Agent")).toContain("CANDEF");
    expect(calls.every((call) => call.init?.method === "GET")).toBe(true);
  });
  it.each([403, 401, 429])("stops permanently on refusal %i", async (status) => {
    const { client, calls } = harness([new Response("refused", { status })]);
    await expect(client.packageShow("fictional")).rejects.toThrow(/refused/i);
    await expect(client.packageShow("fictional")).rejects.toThrow(/stopped/i);
    expect(calls).toHaveLength(1);
  });
  it("stops on HTML challenge without logging the captured body", async () => {
    const { client, calls } = harness([
      ...allowed(),
      new Response("<html>Captcha secret captured text</html>", {
        headers: { "content-type": "text/html" },
      }),
    ]);
    await expect(client.packageShow("fictional")).rejects.toThrow(/challenge|JSON/i);
    await expect(client.packageShow("fictional")).rejects.toThrow(/stopped/i);
    expect(calls).toHaveLength(3);
  });
  it("does not follow redirects or fetch disallowed paths", async () => {
    const { client, calls } = harness([new Response("User-agent: *\nDisallow: /data/")]);
    await expect(client.packageShow("fictional")).rejects.toThrow(/robots/i);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.redirect).toBe("manual");
  });
  it("does not retry a challenge even when it has a transient HTTP status", async () => {
    const { client, calls } = harness([
      ...allowed(),
      new Response("<html>captcha</html>", { status: 503 }),
    ]);
    await expect(client.packageShow("fictional")).rejects.toThrow(/challenge/i);
    expect(calls).toHaveLength(3);
    await expect(client.packageShow("fictional")).rejects.toThrow(/stopped/i);
  });
  it("caps pages and reports incomplete totals rather than implying completeness", async () => {
    const { client } = harness([
      ...allowed(),
      json({ total: 3, records: [{ _id: 1 }], fields: [] }),
    ]);
    const result = await client.pages("fictional", { limit: 1, maxPages: 1 });
    expect(result).toMatchObject({ total: 3, complete: false, pages: 1 });
    expect(result.records).toEqual([{ _id: 1 }]);
  });
  it("preserves offset paging, server totals, projected fields and exact list filters", async () => {
    const { client, calls } = harness([
      ...allowed(),
      json({ total: 2, records: [{ _id: 1 }], fields: [{ id: "_id", type: "int" }] }),
      json({ total: 2, records: [{ _id: 2 }], fields: [{ id: "_id", type: "int" }] }),
    ]);
    const result = await client.pages("fictional", {
      filters: { owner_org: ["fictional-a", "fictional-b"] },
      fields: ["_id"],
      limit: 1,
      maxPages: 2,
    });
    expect(result).toMatchObject({
      total: 2,
      complete: true,
      pages: 2,
      records: [{ _id: 1 }, { _id: 2 }],
    });
    expect(calls[2]!.url.searchParams.get("fields")).toBe("_id");
    expect(calls[3]!.url.searchParams.get("offset")).toBe("1");
    expect(calls[3]!.url.searchParams.get("filters")).toBe(
      '{"owner_org":["fictional-a","fictional-b"]}',
    );
    expect(calls[3]!.url.searchParams.has("maxPages")).toBe(false);
  });
  it("requires owner terms acknowledgement before network access", async () => {
    const client = new CkanClient({
      termsReviewed: false,
      fetch: async () => {
        throw new Error("Network must not run");
      },
    });
    await expect(client.packageShow("fictional")).rejects.toThrow(/review/);
  });
  it("does not fill in missing requested cells or parse JSONP", async () => {
    const { client } = harness([
      ...allowed(),
      json({ total: 1, fields: [], records: [{ _id: 1 }] }),
    ]);
    await expect(
      client.search("fictional", { fields: ["_id", "reference_number"] }),
    ).rejects.toThrow(/missing/);
    const other = harness([...allowed(), new Response('callback({"success":true})')]);
    await expect(other.client.packageShow("fictional")).rejects.toThrow(/JSON/);
  });
  it("stops rather than following a redirect", async () => {
    const { client, calls } = harness([
      new Response("", { status: 302, headers: { location: "https://elsewhere.invalid" } }),
    ]);
    await expect(client.packageShow("fictional")).rejects.toThrow(/redirect/);
    expect(calls).toHaveLength(1);
  });
  it("confirms package selection by exact title, then reads package_show", async () => {
    const { client, calls } = harness([
      ...allowed(),
      json({ count: 1, results: [{ id: "fictional-package", title: "Fictional Dataset" }] }),
      json({ id: "fictional-package", title: "Fictional Dataset", resources: [] }),
    ]);
    const id = await client.findPackage("Fictional Dataset");
    expect(await client.packageShow(id)).toMatchObject({ id: "fictional-package" });
    expect(calls[3]!.url.pathname).toContain("package_show");
    expect(calls[3]!.url.searchParams.get("id")).toBe("fictional-package");
  });
  it("rejects changing totals and ignores no caller-supplied page overflow", async () => {
    const { client } = harness([
      ...allowed(),
      json({ total: 2, records: [{ _id: 1 }], fields: [] }),
      json({ total: 3, records: [{ _id: 2 }], fields: [] }),
    ]);
    await expect(client.pages("fictional", { limit: 1, maxPages: 2 })).rejects.toThrow(/changed/i);
    await expect(client.pages("fictional", { maxPages: 101 })).rejects.toThrow(/cap/i);
  });
  it("enforces the hard cap across repeated search calls in one run", async () => {
    const { client, calls } = harness([
      ...allowed(),
      ...Array.from({ length: 100 }, () => json({ total: 0, records: [], fields: [] })),
    ]);
    for (let n = 0; n < 100; n++) await client.search("fictional");
    await expect(client.search("fictional")).rejects.toThrow(/cap/);
    expect(calls).toHaveLength(102);
  });
});

describe("robots rules", () => {
  it("uses longest matching rules, wildcard and specific agent groups", () => {
    const policy = robotsPolicy(
      "User-agent: *\nDisallow: /\n\nUser-agent: CANDEF\nDisallow: /data/*\nAllow: /data/en/api/\nCrawl-delay: 45",
    );
    expect(policy.allowed("/data/en/api/3/action/package_show?id=x")).toBe(true);
    expect(policy.allowed("/data/fr/a")).toBe(false);
    expect(policy.delayMs).toBe(45000);
  });
});
