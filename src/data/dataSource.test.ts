import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SNAPSHOT_SCHEMA_VERSION } from "../domain/schema/snapshot";
import { DataLoadError, StaticSnapshotSource } from "./dataSource";

const manifest = (over: Record<string, unknown> = {}) => ({
  current: "snapshot.abc.json",
  schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  isDemo: true,
  builtAt: "2026-10-14T00:00:00Z",
  previous: [],
  ...over,
});
const goodSnapshot = () => ({
  meta: {},
  taxonomy: [],
  organizations: [],
  rounds: [],
  agreements: [],
  acquisitions: [],
  assertions: {},
  sources: {},
  graph: {},
  coverage: {},
});
const reply = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

/** Routes by URL suffix; a function value can throw or hang. */
function serve(routes: Record<string, () => Response | Promise<Response>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = Object.keys(routes).find((k) => String(url).endsWith(k));
      if (!key) return reply("", 404);
      return routes[key]!();
    }),
  );
}
const failure = async (source: StaticSnapshotSource) => {
  const e = await source.load().then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DataLoadError);
  return e as DataLoadError;
};

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe("StaticSnapshotSource failures are visitor-readable and classified", () => {
  it("loads a good snapshot", async () => {
    serve({
      "/manifest.json": () => reply(manifest()),
      "/snapshot.abc.json": () => reply(goodSnapshot()),
    });
    const snap = await new StaticSnapshotSource("/data/x").load();
    expect(snap.organizations).toEqual([]);
  });

  it("reports an unavailable manifest as an HTTP failure", async () => {
    serve({ "/manifest.json": () => reply("", 503) });
    const e = await failure(new StaticSnapshotSource("/data/x"));
    expect(e.kind).toBe("http");
    expect(e.message).toContain("503");
  });

  it("reports an unreachable network without leaking the browser's wording", async () => {
    serve({
      "/manifest.json": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const e = await failure(new StaticSnapshotSource("/data/x"));
    expect(e.kind).toBe("network");
    expect(e.message).not.toMatch(/Failed to fetch|TypeError/);
  });

  it("treats a truncated or HTML snapshot as damaged, not as a JSON error", async () => {
    for (const body of ['{"meta": {"x": 1', "<!doctype html><title>app</title>", ""]) {
      serve({
        "/manifest.json": () => reply(manifest()),
        "/snapshot.abc.json": () => reply(body),
      });
      const e = await failure(new StaticSnapshotSource("/data/x"));
      expect(e.kind).toBe("damaged");
      expect(e.message).not.toMatch(/JSON|Unexpected|position/);
    }
  });

  it("treats valid JSON of the wrong shape as damaged", async () => {
    for (const body of [{}, [], null, { ...goodSnapshot(), graph: null }, { organizations: {} }]) {
      serve({
        "/manifest.json": () => reply(manifest()),
        "/snapshot.abc.json": () => reply(JSON.stringify(body)),
      });
      expect((await failure(new StaticSnapshotSource("/data/x"))).kind).toBe("damaged");
    }
  });

  it("explains a schema mismatch and suggests a reload", async () => {
    serve({ "/manifest.json": () => reply(manifest({ schemaVersion: "99.0.0" })) });
    const e = await failure(new StaticSnapshotSource("/data/x"));
    expect(e.kind).toBe("incompatible");
    expect(e.message).toMatch(/Reload/i);
  });

  it("treats a malformed manifest as damaged", async () => {
    for (const m of ["not json", JSON.stringify({}), JSON.stringify(manifest({ current: 5 }))]) {
      serve({ "/manifest.json": () => reply(m) });
      expect((await failure(new StaticSnapshotSource("/data/x"))).kind).toBe("damaged");
    }
  });

  it("gives up on a request that never completes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("x", "AbortError")),
            );
          }),
      ),
    );
    const pending = failure(new StaticSnapshotSource("/data/x", 5_000));
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).kind).toBe("timeout");
  });
});
