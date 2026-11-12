import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { load, point, settle } from "./helpers";

const resultsDir = fileURLToPath(new URL("../../bench/renderer/results/", import.meta.url));
function save(value: unknown, mode: string, lowend: boolean) {
  mkdirSync(resultsDir, { recursive: true });
  const filename = `${resultsDir}/${lowend ? "lowend" : "latest"}.json`;
  let previous: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(filename, "utf8")) as Record<string, unknown>;
    previous = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key === "app" || key === "all"),
    );
  } catch {
    /* First measurement. */
  }
  writeFileSync(filename, JSON.stringify({ ...previous, [mode]: value }, null, 2) + "\n");
}
function bundleGzip(): number {
  const root = fileURLToPath(new URL("../../bench/renderer/dist/", import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = `${dir}/${name}`;
      return statSync(path).isDirectory() ? walk(path) : path.endsWith(".js") ? [path] : [];
    });
  return walk(root).reduce((total, path) => total + gzipSync(readFileSync(path)).length, 0);
}
for (const mode of ["app", "all"])
  test(`large ${mode} fixture render and interaction measurements`, async ({ page }, testInfo) => {
    const lowend = testInfo.project.name === "lowend";
    if (lowend) {
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    }
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await load(page, "large", false, mode);
    const gpu = await page.evaluate(() => {
      const gl = document.querySelector("canvas")!.getContext("webgl2")!,
        ext = gl.getExtension("WEBGL_debug_renderer_info");
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
    });
    const software =
      !gpu || /swiftshader|llvmpipe|softpipe|software|basic render|webkit webgl/i.test(gpu);
    if (software && !lowend)
      save(
        {
          status: "skipped",
          at: new Date().toISOString(),
          gpuRenderer: gpu,
          reason:
            "Hardware GPU not verified (software or unavailable renderer string); no performance numbers reported.",
        },
        mode,
        lowend,
      );
    test.skip(
      software && !lowend,
      `Hardware performance skipped: ${gpu ?? "GPU renderer string unavailable"}`,
    );
    const coldLoadMs = await page.evaluate(() => window.__bench.firstFrameAt!);
    const box = (await page.locator("#host").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45);
    await page.mouse.down();
    const orbitStart = await page.evaluate(() => {
      window.__bench.frameTimes.length = 0;
      return performance.now();
    });
    const deadline = Date.now() + 3000;
    let steps = 0;
    while (Date.now() < deadline) {
      const angle = steps++ * 0.07;
      await page.mouse.move(
        box.x + box.width * 0.45 + Math.sin(angle) * 110,
        box.y + box.height * 0.45 + Math.cos(angle) * 70,
      );
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    const orbitEnd = await page.evaluate(() => performance.now());
    const frameTimes = await page.evaluate(
      ({ start, end }) => window.__bench.frameTimes.filter((t) => t >= start && t <= end),
      { start: orbitStart, end: orbitEnd },
    );
    const intervals = frameTimes
      .slice(1)
      .map((time, i) => time - frameTimes[i]!)
      .sort((a, b) => a - b);
    const p95 = intervals[Math.max(0, Math.ceil(intervals.length * 0.95) - 1)] ?? Infinity;
    await page.waitForTimeout(500);
    const idleStart = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
    await page.waitForTimeout(2000);
    const idleFrames =
      (await page.evaluate(() => window.__bench.scene.getStats().framesRendered)) - idleStart;
    await page.evaluate(() => window.__bench.scene.resetCamera());
    await settle(page);
    const investor = await page.evaluate(() => window.__bench.data.nodes.kinds.indexOf(1));
    const click = await point(page, investor);
    await page.mouse.click(click.x, click.y);
    await page.waitForFunction(() => {
      const event = [...window.__bench.events].reverse().find((e) => e.type === "nodeClick");
      return event && window.__bench.scene.getStats().lastRenderAt! >= event.at;
    });
    const clickMs = await page.evaluate(
      () =>
        window.__bench.scene.getStats().lastRenderAt! -
        [...window.__bench.events].reverse().find((e) => e.type === "nodeClick")!.at,
    );
    async function measureChange(action: "visibility" | "hover" | "resize") {
      await settle(page);
      if (action === "hover") {
        await page.mouse.move(box.x + 5, box.y + 5);
        await settle(page);
      }
      let start = await page.evaluate((action) => {
        const start = performance.now();
        if (action === "visibility")
          window.__bench.scene.setVisibility(
            Uint8Array.from({ length: window.__bench.data.nodes.count }, (_, i) =>
              Number(i % 2 === 0),
            ),
          );
        if (action === "resize") document.querySelector<HTMLElement>("#host")!.style.width = "95%";
        return start;
      }, action);
      if (action === "hover") {
        // Portfolio framing can put unrelated node 0 outside the canvas. The investor is framed in both modes.
        const p = await point(page, investor);
        await page.mouse.move(p.x, p.y);
        // Measure from the engine hover event, excluding Playwright transport/lookup time.
        start = await page.evaluate(
          (after) =>
            [...window.__bench.events].reverse().find((e) => e.type === "hover" && e.at >= after)!
              .at,
          start,
        );
      }
      await page.waitForFunction(
        (start) => window.__bench.scene.getStats().lastRenderAt! > start,
        start,
      );
      const latency =
        (await page.evaluate(() => window.__bench.scene.getStats().lastRenderAt!)) - start;
      await page.waitForTimeout(500);
      const before = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
      await page.waitForTimeout(2000);
      const idle =
        (await page.evaluate(() => window.__bench.scene.getStats().framesRendered)) - before;
      return { latencyMs: latency, idleFrames: idle };
    }
    const hover = await measureChange("hover"),
      visibility = await measureChange("visibility"),
      resize = await measureChange("resize");
    const stats = await page.evaluate(() => window.__bench.scene.getStats());
    const metrics = {
      coldLoadMs,
      orbitP95IntervalMs: p95,
      orbitDurationMs: orbitEnd - orbitStart,
      orbitFrames: frameTimes.length,
      clickToHighlightMs: clickMs,
      idleFrames,
      hover,
      visibility,
      resize,
      bundleJsGzipBytes: bundleGzip(),
      drawCalls: stats.lastDrawCalls,
    };
    const budgetsPassed =
      p95 <= 20 &&
      clickMs <= 100 &&
      idleFrames === 0 &&
      coldLoadMs < 2500 &&
      metrics.bundleJsGzipBytes < 1000000 &&
      [hover, visibility, resize].every((m) => m.latencyMs <= 100 && m.idleFrames === 0) &&
      errors.length === 0 &&
      intervals.length > 30;
    save(
      {
        status: lowend ? "diagnostic" : budgetsPassed ? "passed" : "failed",
        profile: lowend
          ? "Software-rendering lower bound: SwiftShader + CPU x4; no performance budgets"
          : "Hardware GPU",
        at: new Date().toISOString(),
        gpuRenderer: gpu,
        metrics,
        errors,
      },
      mode,
      lowend,
    );
    if (lowend) return;
    expect(errors).toEqual([]);
    expect(intervals.length).toBeGreaterThan(30);
    expect(p95).toBeLessThanOrEqual(20);
    expect(clickMs).toBeLessThanOrEqual(100);
    expect(idleFrames).toBe(0);
    expect(coldLoadMs).toBeLessThan(2500);
    expect(metrics.bundleJsGzipBytes).toBeLessThan(1000000);
    for (const value of [hover, visibility, resize]) {
      expect(value.latencyMs).toBeLessThanOrEqual(100);
      expect(value.idleFrames).toBe(0);
    }
  });
