import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
export async function load(
  page: Page,
  size = "small",
  reduced = true,
  mode = "all",
): Promise<void> {
  await page.goto(`/?size=${size}&reduced=${reduced ? 1 : 0}&mode=${mode}`);
  await page.waitForFunction(() => window.__bench?.scene.getStats().framesRendered > 0);
  await settle(page);
}
export async function settle(page: Page): Promise<void> {
  // This is intentional waiting for the acceptance idle window, not polling the agent.
  await page.waitForTimeout(750);
}
export async function clearEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__bench.events.length = 0;
  });
}
export async function point(page: Page, index: number, edge = false) {
  return page.evaluate(
    ({ index, edge }) =>
      edge ? window.__bench.projectEdgeMidpoint(index) : window.__bench.projectNode(index),
    { index, edge },
  );
}
export async function expectFrame(page: Page, action: () => Promise<unknown>): Promise<number> {
  const before = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await action();
  await expect
    .poll(() => page.evaluate(() => window.__bench.scene.getStats().framesRendered), {
      timeout: 1000,
    })
    .toBeGreaterThan(before);
  return before;
}
