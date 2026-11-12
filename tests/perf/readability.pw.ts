import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load, settle } from "./helpers";
import { pixels } from "./pixels";

const results = fileURLToPath(new URL("../../bench/renderer/results/", import.meta.url));
test("overview saturation, portfolio contrast and unobstructed framing", async ({ page }) => {
  const measured: Record<string, unknown> = {};
  for (const mode of ["app", "all"]) {
    await load(page, "large", true, mode);
    const png = await page
      .locator("#host canvas")
      .screenshot({ path: `${results}/overview-${mode}.png` });
    const image = pixels(png);
    measured[mode] = {
      nearWhiteFraction: image.nearWhiteFraction,
      width: image.width,
      height: image.height,
    };
  }
  await load(page, "large", true, "app");
  const framing = [];
  for (const inset of [0, 400]) {
    await page.evaluate((inset) => {
      window.__bench.togglePanel(inset > 0);
      window.__bench.scene.resetCamera();
    }, inset);
    await settle(page);
    framing.push(
      await page.evaluate((inset) => {
        const bench = window.__bench,
          canvas = document.querySelector("#host canvas")!.getBoundingClientRect();
        const positions = Array.from({ length: bench.data.nodes.count }, (_, i) =>
          bench.projectNode(i),
        );
        const x = positions.map((p) => p.x - canvas.left),
          y = positions.map((p) => p.y - canvas.top);
        const bounds = {
          left: Math.min(...x),
          right: Math.max(...x),
          top: Math.min(...y),
          bottom: Math.max(...y),
        };
        return {
          inset,
          bounds,
          width: canvas.width - inset,
          height: canvas.height,
          occupancy: Math.max(
            (bounds.right - bounds.left) / (canvas.width - inset),
            (bounds.bottom - bounds.top) / canvas.height,
          ),
          labelsAvoidPanel: Array.from(document.querySelectorAll<HTMLElement>(".explorer-label"))
            .filter((l) => l.style.display !== "none")
            .every((l) => l.getBoundingClientRect().right <= canvas.right - inset),
        };
      }, inset),
    );
  }
  await page.evaluate(() => {
    window.__bench.togglePanel(false);
    window.__bench.scene.resetCamera();
    window.__bench.scene.setLabelsEnabled(false);
  });
  await settle(page);
  const investor = await page.evaluate(() => window.__bench.data.nodes.kinds.indexOf(1));
  const p = await page.evaluate((i) => window.__bench.projectNode(i), investor);
  await page.mouse.click(p.x, p.y);
  await settle(page);
  const selected = await page.evaluate((investor) => {
    const bench = window.__bench,
      related = new Set<number>();
    for (let e = 0; e < bench.data.edges.count; e++)
      if (bench.data.edges.kinds[e] === 0 && bench.data.edges.source[e] === investor)
        related.add(bench.data.edges.target[e]!);
    const rect = document.querySelector("#host canvas")!.getBoundingClientRect();
    const all = Array.from({ length: bench.data.nodes.count }, (_, i) => ({
      i,
      ...bench.projectNode(i),
    }));
    const samples = all.filter(
      (p) =>
        bench.data.nodes.kinds[p.i] === 0 &&
        p.z >= -1 &&
        p.z <= 1 &&
        p.x > rect.left + 5 &&
        p.x < rect.right - 5 &&
        p.y > rect.top + 5 &&
        p.y < rect.bottom - 5 &&
        !all.some((other) => other.i !== p.i && Math.hypot(p.x - other.x, p.y - other.y) < 7),
    );
    return {
      events: bench.events.filter((e) => e.type === "nodeClick").map((e) => e.payload),
      related: samples
        .filter((p) => related.has(p.i))
        .map((p) => ({ x: p.x - rect.left, y: p.y - rect.top })),
      background: samples
        .filter((p) => !related.has(p.i))
        .map((p) => ({ x: p.x - rect.left, y: p.y - rect.top })),
      visibleEdges: bench.scene.getStats().visibleEdges,
      expectedEdges: Array.from(bench.data.edges.source).filter(
        (source, e) => source === investor && bench.data.edges.kinds[e] === 0,
      ).length,
    };
  }, investor);
  const selectedPng = await page.locator("#host canvas").screenshot();
  const image = pixels(selectedPng),
    rect = (await page.locator("#host canvas").boundingBox())!;
  const mean = (points: { x: number; y: number }[]) =>
    points.reduce((total, p) => {
      const x = Math.round((p.x * image.width) / rect.width),
        y = Math.round((p.y * image.height) / rect.height);
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) sum += image.luminance(x + dx, y + dy);
      return total + sum / 9;
    }, 0) / points.length;
  const relatedMean = mean(selected.related),
    backgroundMean = mean(selected.background);
  measured.framing = framing;
  measured.contrast = {
    relatedMean,
    backgroundMean,
    ratio: relatedMean / backgroundMean,
    relatedSamples: selected.related.length,
    backgroundSamples: selected.background.length,
  };
  writeFileSync(`${results}/readability.json`, JSON.stringify(measured, null, 2) + "\n");
  expect((measured.app as { nearWhiteFraction: number }).nearWhiteFraction).toBeLessThan(0.03);
  expect(selected.events).toContainEqual({ index: investor });
  expect(selected.visibleEdges).toBe(selected.expectedEdges);
  expect(selected.related.length).toBeGreaterThan(4);
  expect(selected.background.length).toBeGreaterThan(4);
  expect(relatedMean / backgroundMean).toBeGreaterThanOrEqual(3);
  for (const view of framing) {
    expect(view.occupancy).toBeGreaterThanOrEqual(0.8);
    expect(view.occupancy).toBeLessThanOrEqual(0.92);
    expect(view.bounds.left).toBeGreaterThanOrEqual(0);
    expect(view.bounds.right).toBeLessThanOrEqual(view.width);
    expect(view.bounds.top).toBeGreaterThanOrEqual(0);
    expect(view.bounds.bottom).toBeLessThanOrEqual(view.height);
    expect(view.labelsAvoidPanel).toBe(true);
  }
  await page.evaluate(() => window.__bench.scene.setLabelsEnabled(true));
  await settle(page);
  await page.locator("#host canvas").screenshot({ path: `${results}/selected-investor-app.png` });
  const box = (await page.locator("#host").boundingBox())!;
  await page.mouse.click(box.x + 5, box.y + 5);
  await settle(page);
  expect(await page.evaluate(() => window.__bench.scene.getStats().visibleEdges)).toBe(
    await page.evaluate(
      () => Array.from(window.__bench.data.edges.kinds).filter((k) => k === 2).length,
    ),
  );
});

test("edge eligibility, frame subset and hysteretic zoom events", async ({ page }) => {
  await load(page, "small", true, "all");
  await page.evaluate(() => {
    const b = window.__bench;
    const mask = new Uint8Array(b.data.edges.count);
    mask[0] = 1;
    b.scene.setEdgeVisibility(mask);
    mask.fill(1);
  });
  await settle(page);
  expect(await page.evaluate(() => window.__bench.scene.getStats().visibleEdges)).toBe(1);
  await page.evaluate(() => {
    window.__bench.scene.setVisibility(
      Uint8Array.from({ length: window.__bench.data.nodes.count }, (_, i) => Number(i !== 0)),
    );
  });
  await settle(page);
  expect(await page.evaluate(() => window.__bench.scene.getStats().visibleEdges)).toBe(0);
  await page.evaluate(() => {
    const s = window.__bench.scene;
    s.setVisibility(null);
    s.resetCamera();
    window.__bench.events.length = 0;
    s.zoomBy(1 / 0.6);
  });
  await settle(page);
  expect(
    await page.evaluate(() =>
      window.__bench.events
        .filter((e) => e.type === "viewChange")
        .map((e) => (e.payload as { level: number }).level),
    ),
  ).toEqual([1]);
  await page.evaluate(() => window.__bench.scene.zoomBy(0.6 / 0.67));
  await settle(page);
  expect(
    await page.evaluate(() => window.__bench.events.filter((e) => e.type === "viewChange").length),
  ).toBe(1);
  await page.evaluate(() => window.__bench.scene.zoomBy(0.67 / 0.75));
  await settle(page);
  expect(
    await page.evaluate(() =>
      window.__bench.events
        .filter((e) => e.type === "viewChange")
        .map((e) => (e.payload as { level: number }).level),
    ),
  ).toEqual([1, 0]);
  await page.evaluate(() => window.__bench.scene.zoomBy(0.75 / 0.25));
  await settle(page);
  expect(
    await page.evaluate(() =>
      window.__bench.events
        .filter((e) => e.type === "viewChange")
        .map((e) => (e.payload as { level: number }).level),
    ),
  ).toEqual([1, 0, 2]);
  await page.evaluate(() => {
    const b = window.__bench;
    b.scene.setViewportInsets({ left: 80, top: 40, right: 400, bottom: 30 });
    b.scene.frameNodes(new Uint32Array([0, 1]));
  });
  await settle(page);
  const frame = await page.evaluate(() => {
    const b = window.__bench,
      r = document.querySelector("#host canvas")!.getBoundingClientRect();
    return [0, 1].map((i) => {
      const p = b.projectNode(i);
      return { x: p.x - r.left, y: p.y - r.top, w: r.width, h: r.height };
    });
  });
  for (const p of frame) {
    expect(p.x).toBeGreaterThan(80);
    expect(p.x).toBeLessThan(p.w - 400);
    expect(p.y).toBeGreaterThan(40);
    expect(p.y).toBeLessThan(p.h - 30);
  }
  const before = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await page.evaluate(() => window.__bench.scene.frameNodes(new Uint32Array()));
  await settle(page);
  expect(await page.evaluate(() => window.__bench.scene.getStats().framesRendered)).toBe(before);
});
