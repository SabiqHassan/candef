/**
 * Does a long session leak? Repeats the actions a person repeats (graph <-> list, lens switches,
 * opening and closing a company, moving the time view) and compares JS heap and DOM size after a
 * forced garbage collection, early and late. Synthetic stress dataset only.
 * Results go to bench/stress/results/leak-<companies>.json.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const companies = process.env.STRESS_COMPANIES ?? "1000";
const results: Record<string, unknown> = {};
test.afterAll(() => {
  const dir = fileURLToPath(new URL("../../bench/stress/results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}leak-${companies}.json`,
    JSON.stringify({ at: new Date().toISOString(), ...results }, null, 2) + "\n",
  );
});

async function memory(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const g = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
  await cdp.detach();
  return {
    heapMB: +(g("JSHeapUsedSize") / 1e6).toFixed(1),
    domNodes: g("Nodes"),
    listeners: g("JSEventListeners"),
  };
}

test("repeated view and lens switching does not grow memory", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?dir=0");
  await expect(page.locator("canvas[role=img]")).toBeVisible({ timeout: 60_000 });
  const lensTab = (name: string) =>
    page.getByRole("tablist", { name: "Network view" }).getByRole("tab", { name });
  const toggle = page.getByRole("button", { name: /Show as list|Show 3D network/ });

  const cycle = async () => {
    await toggle.click(); // to list
    await expect(page.locator("table tbody tr").first()).toBeVisible();
    await toggle.click(); // back to 3D (a new engine instance)
    await expect(page.locator("canvas[role=img]")).toBeVisible();
    for (const lens of ["Government", "Industry", "Capital"]) {
      await lensTab(lens).click();
      await page.waitForTimeout(120);
    }
  };

  for (let i = 0; i < 3; i++) await cycle(); // warm-up: caches, lazy chunk, fonts
  const early = await memory(page);
  const cycles = Number(process.env.LEAK_CYCLES ?? 25);
  for (let i = 0; i < cycles; i++) await cycle();
  const late = await memory(page);

  results.viewAndLensSwitching = { cycles, early, late };
  // A leak per cycle would add up to megabytes over 25 cycles; allow ordinary noise.
  expect(late.heapMB - early.heapMB).toBeLessThan(Math.max(8, early.heapMB * 0.15));
  expect(late.domNodes - early.domNodes).toBeLessThan(500);
  expect(late.listeners - early.listeners).toBeLessThan(200);
  expect(errors).toEqual([]);
});

test("opening and closing companies and moving the time view does not grow memory", async ({
  page,
}) => {
  await page.goto("/?dir=1");
  await expect(page.locator("canvas[role=img]")).toBeVisible({ timeout: 60_000 });
  const ids = await page.evaluate(async () => {
    const m = await (await fetch("/data/stress/manifest.json")).json();
    const s = await (await fetch(`/data/stress/${m.current}`)).json();
    return s.organizations
      .filter((o: { scope: string }) => o.scope === "universe")
      .slice(0, 60)
      .map((o: { id: string }) => o.id) as string[];
  });
  const cycle = async (n: number) => {
    for (let i = 0; i < n; i++) {
      const id = ids[i % ids.length]!;
      await page.evaluate((sel) => {
        history.pushState({}, "", `/?sel=${sel}&asof=${2015 + (sel.length % 9)}`);
        dispatchEvent(new PopStateEvent("popstate"));
      }, id);
      await page.waitForTimeout(60);
    }
    await page.evaluate(() => {
      history.pushState({}, "", "/");
      dispatchEvent(new PopStateEvent("popstate"));
    });
  };
  await cycle(10);
  const early = await memory(page);
  await cycle(60);
  const late = await memory(page);
  results.selectionAndTime = { cycles: 60, early, late };
  expect(late.heapMB - early.heapMB).toBeLessThan(Math.max(8, early.heapMB * 0.15));
  expect(late.domNodes - early.domNodes).toBeLessThan(500);
});
