/** Opens .stress/workspace.html in Chrome and times the review page's controls. */
import { chromium } from "@playwright/test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const file = pathToFileURL(join(process.cwd(), ".stress", "workspace.html")).href;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
const t0 = Date.now();
await page.goto(file, { waitUntil: "load", timeout: 180_000 });
const loadMs = Date.now() - t0;
const m = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const g = (n: string) => metrics.find((x) => x.name === n)?.value ?? 0;
  return { heapMB: Math.round(g("JSHeapUsedSize") / 1e6), nodes: g("Nodes") };
};
const timed = async (label: string, f: () => Promise<unknown>) => {
  const s = Date.now();
  await f();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  return { [label]: Date.now() - s };
};
const out: Record<string, unknown> = { loadMs, ...(await m()) };
const units = await page.locator("section.unit").count();
out.units = units;
Object.assign(
  out,
  await timed("filterUndecidedMs", () => page.selectOption("#f-state", "undecided")),
);
Object.assign(out, await timed("filterAllMs", () => page.selectOption("#f-state", "")));
const orgValue = await page.locator("#f-org option").nth(5).getAttribute("value");
Object.assign(out, await timed("filterOrgMs", () => page.selectOption("#f-org", orgValue!)));
Object.assign(out, await timed("clearOrgMs", () => page.selectOption("#f-org", "")));
Object.assign(out, await timed("searchMs", () => page.fill("#f-q", "robotics")));
Object.assign(out, await timed("clearSearchMs", () => page.fill("#f-q", "")));
// Marking a decision updates progress and writes the browser's local storage.
await page.selectOption("#f-org", orgValue!);
Object.assign(
  out,
  await timed("markApproveMs", () =>
    page.locator("section.unit:visible input[value=approve]:not([disabled])").first().check(),
  ),
);
Object.assign(
  out,
  await timed("exportMs", async () => {
    const dl = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
    await page.click("#export");
    await dl;
  }),
);
out.after = await m();
out.errors = errors;
console.log(JSON.stringify(out, null, 1));
await browser.close();
