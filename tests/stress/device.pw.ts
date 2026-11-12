/**
 * Slow-device measurements on the SYNTHETIC stress dataset: the same actions as app.pw.ts with the
 * CPU slowed down the way Chrome DevTools does it (4x about a mid-range phone, 6x a low-end one).
 * Results go to bench/stress/results/device-<companies>.json.
 *
 * What this does and does not measure: CPU throttling slows JavaScript, layout and painting on the
 * main thread, which is where parsing, indexing and rendering time goes. It does not slow the GPU.
 * Network time is not measured here (the local preview server does not compress); it is computed
 * from the compressed snapshot size in the report instead.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const companies = process.env.STRESS_COMPANIES ?? "3000";
const results: Record<string, Record<string, unknown>> = {};
test.afterAll(() => {
  const dir = fileURLToPath(new URL("../../bench/stress/results/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    `${dir}device-${companies}.json`,
    JSON.stringify({ at: new Date().toISOString(), ...results }, null, 2) + "\n",
  );
});

const profiles = [
  { name: "desktop", cpu: 1, viewport: { width: 1440, height: 900 } },
  { name: "phone-4x", cpu: 4, viewport: { width: 390, height: 844 } },
  { name: "phone-6x", cpu: 6, viewport: { width: 390, height: 844 } },
] as const;

async function throttle(page: Page, cpu: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
}

async function marks(page: Page) {
  return page.evaluate(() => {
    const m = (n: string) => Math.round(performance.getEntriesByName(n).at(0)?.startTime ?? -1);
    return {
      downloaded: m("candef:snapshot-downloaded"),
      parsed: m("candef:snapshot-parsed"),
      indexed: m("candef:indexed"),
    };
  });
}

async function frameTimes(page: Page, act: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { __f: number[]; __on: boolean };
    w.__f = [];
    w.__on = true;
    let last = performance.now();
    const tick = (t: number) => {
      w.__f.push(t - last);
      last = t;
      if (w.__on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  return page.evaluate(() => {
    const w = window as unknown as { __f: number[]; __on: boolean };
    w.__on = false;
    const s = [...w.__f].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
    return { frames: s.length, p50Ms: Math.round(q(0.5)), p95Ms: Math.round(q(0.95)) };
  });
}

for (const profile of profiles) {
  test.describe(profile.name, () => {
    test.use({ viewport: profile.viewport, hasTouch: profile.name !== "desktop" });

    test("load, list actions and graph", async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await throttle(page, profile.cpu);
      const out: Record<string, unknown> = { cpuThrottle: profile.cpu };

      const t0 = Date.now();
      await page.goto("/?view=list");
      await expect(page.locator("table tbody tr, [role=row]").first()).toBeVisible({
        timeout: 120_000,
      });
      out.listReadyMs = Date.now() - t0;
      out.loadMarks = await marks(page);

      if (profile.name === "desktop") {
        const s0 = Date.now();
        await page.getByRole("table").getByRole("button", { name: "Sector" }).click();
        await page.waitForTimeout(50);
        out.sortMs = Date.now() - s0;
      } else {
        const s0 = Date.now();
        await page.getByRole("combobox", { name: /sort/i }).first().selectOption({ index: 2 });
        await page.waitForTimeout(50);
        out.sortMs = Date.now() - s0;
      }

      const g0 = Date.now();
      await page.goto("/?view=graph&dir=0");
      await expect(page.locator("canvas[role=img]")).toBeVisible({ timeout: 120_000 });
      out.graphReadyMs = Date.now() - g0;
      await page.waitForTimeout(1500);
      const box = (await page.locator("canvas[role=img]").boundingBox())!;
      out.orbit = await frameTimes(page, async () => {
        const cx = box.x + box.width / 2,
          cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let i = 0; i < 30; i++) await page.mouse.move(cx + i * 6, cy + Math.sin(i / 4) * 20);
        await page.mouse.up();
        await page.waitForTimeout(600);
      });
      results[profile.name] = out;
      expect(errors).toEqual([]);
    });
  });
}
