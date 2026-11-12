/**
 * Measures the real CANDEF app on the synthetic stress dataset. Every number is a wall-clock time
 * in the browser (ms) or a byte count; long tasks are main-thread blocks over 50 ms. Results are
 * merged into bench/stress/results/<companies>.json so runs at several sizes can be compared.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../../src/domain/schema/snapshot";

const companies = process.env.STRESS_COMPANIES ?? "3000";
const resultsFile = fileURLToPath(
  new URL(`../../bench/stress/results/${companies}.json`, import.meta.url),
);
const results: Record<string, unknown> = {};
test.afterAll(() => {
  mkdirSync(fileURLToPath(new URL("../../bench/stress/results/", import.meta.url)), {
    recursive: true,
  });
  let previous: Record<string, unknown> = {};
  try {
    previous = JSON.parse(readFileSync(resultsFile, "utf8"));
  } catch {
    /* first run */
  }
  let build: unknown = null;
  try {
    build = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../.stress/build-metrics.json", import.meta.url)),
        "utf8",
      ),
    );
  } catch {
    /* built elsewhere */
  }
  writeFileSync(
    resultsFile,
    JSON.stringify({ ...previous, build, ...results, at: new Date().toISOString() }, null, 2) +
      "\n",
  );
});

/** Collects main-thread long tasks so every measured action can report its blocking time. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __long: { start: number; duration: number }[] };
    w.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        w.__long.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  });
}
const now = (page: Page) => page.evaluate(() => performance.now());
async function blocking(page: Page, from: number) {
  return page.evaluate((t) => {
    const l = (
      window as unknown as { __long: { start: number; duration: number }[] }
    ).__long.filter((x) => x.start >= t);
    return {
      longTasks: l.length,
      blockingMs: Math.round(l.reduce((s, x) => s + Math.max(0, x.duration - 50), 0)),
      maxTaskMs: Math.round(Math.max(0, ...l.map((x) => x.duration))),
    };
  }, from);
}
/** Runs an action and waits for its visible result; reports elapsed time and main-thread blocking. */
async function measure(page: Page, label: string, action: () => Promise<void>) {
  const t0 = await now(page);
  const w0 = Date.now();
  await action();
  const elapsedMs = Date.now() - w0;
  // Let trailing long tasks (layout, React commits) land before reading them.
  await page.waitForTimeout(300);
  const b = await blocking(page, t0);
  results[label] = { elapsedMs, ...b };
  return results[label];
}
async function heapMB(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  const nodes = metrics.find((m) => m.name === "Nodes")?.value ?? 0;
  return { heapMB: Math.round(used / 1e6), domNodes: nodes };
}
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const manifest = await (await fetch("/data/stress/manifest.json")).json();
    return (await fetch(`/data/stress/${manifest.current}`)).json();
  });
}

// Every test fails on an uncaught page error: missing, conflicting and incomplete synthetic records
// must degrade to explicit states, never to a crash.
const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await instrument(page);
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

async function seriousViolations(page: Page) {
  const r = await new AxeBuilder({ page }).exclude("canvas").analyze();
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.length}`);
}

test("accessibility at scale: list view and heaviest dossier", async ({ page }) => {
  await page.goto("/?view=list");
  await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 60_000 });
  const list = await seriousViolations(page);
  const snap = await snapshot(page);
  const count = new Map<string, number>();
  for (const g of snap.agreements)
    for (const a of g.attributions) count.set(a.orgId, (count.get(a.orgId) ?? 0) + 1);
  const [heaviestId] = [...count.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const heaviest = snap.organizations.find((o) => o.id === heaviestId)!;
  await page.goto(`/company/${heaviest.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: heaviest.name })).toBeVisible({
    timeout: 60_000,
  });
  const dossier = await seriousViolations(page);
  results.accessibility = { list, dossier };
  expect(list).toEqual([]);
  expect(dossier).toEqual([]);
});

test("cold load of the explorer", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const w0 = Date.now();
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "Network view" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("canvas[role=img]")).toBeVisible();
  const readyMs = Date.now() - w0;
  await page.waitForTimeout(1500);
  const marks = await page.evaluate(() => {
    const m = Object.fromEntries(
      performance.getEntriesByType("mark").map((e) => [e.name, Math.round(e.startTime)]),
    );
    return m;
  });
  const b = await blocking(page, 0);
  results.coldLoad = {
    readyMs,
    downloadMs: marks["candef:snapshot-downloaded"]! - marks["candef:load-start"]!,
    parseMs: marks["candef:snapshot-parsed"]! - marks["candef:snapshot-downloaded"]!,
    indexMs: marks["candef:indexed"]! - marks["candef:snapshot-parsed"]!,
    ...b,
    ...(await heapMB(page)),
  };
  expect(errors).toEqual([]);
});

test("lens switching and time view", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "Network view" })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(1500);
  const canvas = page.locator("canvas[role=img]");
  await measure(page, "lensGovernment", async () => {
    await page.getByRole("tab", { name: "Government" }).click();
    await expect(canvas).toHaveAttribute("aria-label", /^Government view/);
  });
  await measure(page, "lensIndustry", async () => {
    await page.getByRole("tab", { name: "Industry" }).click();
    await expect(canvas).toHaveAttribute("aria-label", /^Industry view/);
  });
  await measure(page, "lensCapital", async () => {
    await page.getByRole("tab", { name: "Capital" }).click();
    await expect(canvas).toHaveAttribute("aria-label", /^Capital view/);
  });
  await measure(page, "timeFilterYear", async () => {
    await navigate(page, "/?asof=2020");
    await expect(canvas).toHaveAttribute("aria-label", /time filter/, { timeout: 60_000 });
  });
});

/** In-app navigation (no reload): the router reacts to history changes like a link click. */
async function navigate(page: Page, url: string) {
  await page.evaluate((u) => {
    history.pushState({}, "", u);
    dispatchEvent(new PopStateEvent("popstate"));
  }, url);
}

/** Frame times while an interaction runs: real rendering cost, not just DOM timing. */
async function frames(page: Page, label: string, interaction: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rafOn: boolean };
    w.__frames = [];
    w.__rafOn = true;
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (w.__rafOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const t0 = await now(page);
  await interaction();
  const f = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rafOn: boolean };
    w.__rafOn = false;
    const sorted = [...w.__frames].sort((a, b) => a - b);
    const q = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    return {
      frames: sorted.length,
      p50Ms: Math.round(q(0.5)),
      p95Ms: Math.round(q(0.95)),
      maxMs: Math.round(sorted.at(-1) ?? 0),
    };
  });
  results[label] = { ...f, ...(await blocking(page, t0)) };
}

test("graph navigation frame times", async ({ page }) => {
  await page.goto("/?dir=0");
  await expect(page.locator("canvas[role=img]")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(2000);
  const box = (await page.locator("canvas[role=img]").boundingBox())!;
  await frames(page, "graphZoom", async () => {
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.waitForTimeout(600);
    }
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "Zoom out" }).click();
      await page.waitForTimeout(600);
    }
  });
  await frames(page, "graphOrbit", async () => {
    const cx = box.x + box.width / 2,
      cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 40; i++) await page.mouse.move(cx + i * 8, cy + Math.sin(i / 4) * 30);
    await page.mouse.up();
    await page.waitForTimeout(800);
  });
  await frames(page, "graphGovernmentLens", async () => {
    await page.getByRole("tab", { name: "Government" }).click();
    await page.waitForTimeout(1500);
  });
});

test("search, filter and directory", async ({ page }) => {
  await page.goto("/");
  const dir = page.getByRole("complementary", { name: "Company directory" });
  await expect(dir).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const box = dir.getByRole("searchbox", { name: "Search companies and institutions" });
  await measure(page, "searchTyping", async () => {
    await box.pressSequentially("aryx", { delay: 40 });
    await expect(page).toHaveURL(/q=aryx/);
  });
  await measure(page, "searchClear", async () => {
    await dir.getByRole("button", { name: "Clear search" }).click();
    await expect(page).not.toHaveURL(/q=/);
  });
  await measure(page, "filterSector", async () => {
    await dir.getByRole("combobox", { name: "Sector" }).selectOption({ index: 1 });
    await expect(page).toHaveURL(/sector=/);
    await expect(dir.locator("li[aria-posinset]").first()).toBeVisible();
  });
  await measure(page, "directoryScrollToEnd", async () => {
    await dir
      .locator("ul:has(li[aria-posinset])")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(100);
  });
  results.directoryDom = await heapMB(page);
});

test("list view, sorting and selection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "Network view" })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(1000);
  await measure(page, "listOpen", async () => {
    await page.getByRole("button", { name: "Show as list" }).click();
    await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 60_000 });
  });
  results.listRows = await page.locator("table tbody tr").count();
  results.listDom = await heapMB(page);
  await measure(page, "listSortSector", async () => {
    await page.getByRole("table").getByRole("button", { name: "Sector" }).click();
    await expect(page.getByRole("columnheader", { name: "Sector" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });
  await measure(page, "listSelectRow", async () => {
    await page.locator("table tbody tr").nth(5).getByRole("button").first().click();
    await expect(page.getByRole("complementary", { name: "Selection details" })).toBeVisible();
  });
});

test("heaviest dossier and hub panels", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "Network view" })).toBeVisible({
    timeout: 60_000,
  });
  const snap = await snapshot(page);
  const count = new Map<string, number>();
  for (const g of snap.agreements)
    for (const a of g.attributions) count.set(a.orgId, (count.get(a.orgId) ?? 0) + 1);
  for (const r of snap.rounds) count.set(r.companyId, (count.get(r.companyId) ?? 0) + 3);
  const [heaviestId, weight] = [...count.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const heaviest = snap.organizations.find((o) => o.id === heaviestId)!;
  results.heaviestDossierWeight = weight;
  await page.waitForTimeout(1000);
  await measure(page, "dossierHeaviest", async () => {
    await navigate(page, `/company/${heaviest.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: heaviest.name })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.locator("#sources")).toBeVisible();
  });
  results.dossierChips = await page.locator("[data-source-chip]").count();
  results.dossierDom = await heapMB(page);

  // The busiest investor and the busiest department (hub nodes).
  const portfolio = new Map<string, Set<string>>();
  for (const r of snap.rounds)
    for (const p of r.participants)
      portfolio.set(p.investorId, (portfolio.get(p.investorId) ?? new Set()).add(r.companyId));
  const [hubInvestor] = [...portfolio.entries()].sort((a, b) => b[1].size - a[1].size)[0]!;
  results.hubInvestorPortfolio = portfolio.get(hubInvestor)!.size;
  await page.goto("/");
  await expect(page.getByRole("tablist", { name: "Network view" })).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(1000);
  const panel = page.getByRole("complementary", { name: "Selection details" });
  await measure(page, "hubInvestorPanel", async () => {
    await navigate(page, `/?sel=${hubInvestor}`);
    await expect(panel.getByRole("heading", { level: 2 })).toBeVisible({ timeout: 60_000 });
  });
  const deptCount = new Map<string, number>();
  for (const g of snap.agreements)
    if (g.counterpartyId)
      deptCount.set(g.counterpartyId, (deptCount.get(g.counterpartyId) ?? 0) + 1);
  const [hubDept, n] = [...deptCount.entries()].sort((a, b) => b[1] - a[1])[0]!;
  results.hubDepartmentAgreements = n;
  await measure(page, "hubDepartmentPanel", async () => {
    await navigate(page, `/?lens=contracts&sel=${hubDept}`);
    await expect(panel.getByRole("heading", { level: 2 })).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("phone list view load", async ({ page }) => {
    const w0 = Date.now();
    await page.goto("/");
    await expect(page.locator("table tbody tr").first()).toBeVisible({ timeout: 60_000 });
    results.phoneListLoad = {
      readyMs: Date.now() - w0,
      ...(await blocking(page, 0)),
      ...(await heapMB(page)),
    };
  });
});
