import { test, expect } from "@playwright/test";
import { clearEvents, load, point, settle, expectFrame } from "./helpers";

test.beforeEach(async ({ page }) => load(page));
test("node picking, canvas description and DOM label accessibility", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const canvas = page.locator("#host canvas");
  await expect(canvas).toHaveAttribute("role", "img");
  await expect(canvas).toHaveAttribute("aria-label", /Synthetic small network/);
  const p = await point(page, 0);
  await page.mouse.click(p.x, p.y);
  expect(
    await page.evaluate(() =>
      window.__bench.events.filter((e) => e.type === "nodeClick").map((e) => e.payload),
    ),
  ).toContainEqual({ index: 0 });
  await expectFrame(page, () => page.evaluate(() => window.__bench.scene.focusNode(0)));
  const labels = page.locator(".explorer-label");
  expect(await labels.count()).toBeLessThanOrEqual(40);
  expect(
    await labels.evaluateAll((elements) =>
      elements.every(
        (e) =>
          e.getAttribute("aria-hidden") === "true" &&
          !e.hasAttribute("tabindex") &&
          (e as HTMLElement).tabIndex === -1,
      ),
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("overlapping edges return every nearby candidate", async ({ page }) => {
  await page.evaluate(() => window.__bench.scene.setLabelsEnabled(false));
  await settle(page);
  await clearEvents(page);
  const p = await point(page, 0, true);
  await page.mouse.click(p.x, p.y);
  const event = await page.evaluate(() =>
    window.__bench.events.find((e) => e.type === "edgeClick"),
  );
  expect(event).toBeDefined();
  const candidates = (event!.payload as { candidates: number[] }).candidates;
  expect(candidates.length).toBeGreaterThan(1);
  expect(candidates).toEqual(expect.arrayContaining([0, 1, 2]));
});
test("background click and outbound/return orbit drag discrimination", async ({ page }) => {
  const box = (await page.locator("#host").boundingBox())!;
  await clearEvents(page);
  await page.mouse.click(box.x + 12, box.y + 12);
  expect(
    await page.evaluate(() => window.__bench.events.some((e) => e.type === "backgroundClick")),
  ).toBe(true);
  await clearEvents(page);
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 80, { steps: 12 });
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.up();
  expect(
    await page.evaluate(() =>
      window.__bench.events.filter((e) =>
        ["nodeClick", "edgeClick", "backgroundClick"].includes(e.type),
      ),
    ),
  ).toEqual([]);
});
// Integrator regression test (Claude): a drag that starts on a DOM label must orbit the camera;
// a click on a label must still select its node exactly once.
test("drag starting on a label orbits; label click selects once", async ({ page }) => {
  const label = page.locator(".explorer-label:visible").first();
  await expect(label).toBeVisible();
  const box = (await label.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const camBefore = await page.evaluate(() => window.__bench.projectNode(0));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 160, y + 60, { steps: 15 });
  await page.mouse.up();
  await settle(page);
  const camAfter = await page.evaluate(() => window.__bench.projectNode(0));
  expect(Math.hypot(camAfter.x - camBefore.x, camAfter.y - camBefore.y)).toBeGreaterThan(5);
  await clearEvents(page);
  const again = page.locator(".explorer-label:visible").first();
  const b2 = (await again.boundingBox())!;
  await page.mouse.click(b2.x + b2.width / 2, b2.y + b2.height / 2);
  expect(
    await page.evaluate(() => window.__bench.events.filter((e) => e.type === "nodeClick").length),
  ).toBe(1);
});
test("visibility hides endpoints, prevents hidden node picks and invalidates labels", async ({
  page,
}) => {
  const p = await point(page, 0);
  await expectFrame(page, () =>
    page.evaluate(() => {
      const mask = new Uint8Array(window.__bench.data.nodes.count);
      mask[1] = 1;
      window.__bench.scene.setVisibility(mask);
    }),
  );
  await clearEvents(page);
  await page.mouse.click(p.x, p.y);
  expect(await page.evaluate(() => window.__bench.scene.getStats())).toMatchObject({
    visibleNodes: 1,
    visibleEdges: 0,
  });
  expect(await page.evaluate(() => window.__bench.events.some((e) => e.type === "nodeClick"))).toBe(
    false,
  );
});
test("reduced-motion camera changes render once without tween frames", async ({ page }) => {
  for (const command of ["focus", "zoom", "reset"]) {
    const before = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
    await page.evaluate((command) => {
      const s = window.__bench.scene;
      if (command === "focus") s.focusNode(0);
      else if (command === "zoom") s.zoomBy(1.2);
      else s.resetCamera();
    }, command);
    await settle(page);
    expect(await page.evaluate(() => window.__bench.scene.getStats().framesRendered)).toBe(
      before + 1,
    );
  }
});
test("reapplying unchanged visibility, highlight and label state requests no frame", async ({
  page,
}) => {
  const before = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await page.evaluate(() => {
    const s = window.__bench.scene;
    s.setVisibility(null);
    s.setHighlight(null, null);
    s.setLabelsEnabled(true);
    s.zoomBy(1);
  });
  await settle(page);
  expect(await page.evaluate(() => window.__bench.scene.getStats().framesRendered)).toBe(before);
});
test("WEBGL_lose_context stops frames and restores GPU resources", async ({ page }) => {
  const supported = await page.evaluate(() => {
    const gl = document.querySelector("canvas")!.getContext("webgl2")!;
    const ext = gl.getExtension("WEBGL_lose_context");
    if (!ext) return false;
    // Integrator fix (Claude): getExtension() returns null on a lost context, so keep this reference for restore.
    (window as unknown as { __loseCtx: WEBGL_lose_context }).__loseCtx = ext;
    ext.loseContext();
    return true;
  });
  test.skip(!supported, "WEBGL_lose_context unavailable");
  await page.waitForFunction(() => window.__bench.events.some((e) => e.type === "contextLost"));
  const before = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await page.evaluate(() => window.__bench.scene.setHighlight(0, new Uint32Array([1])));
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__bench.scene.getStats().framesRendered)).toBe(before);
  await page.evaluate(() =>
    (window as unknown as { __loseCtx: WEBGL_lose_context }).__loseCtx.restoreContext(),
  );
  await page.waitForFunction(() => window.__bench.events.some((e) => e.type === "contextRestored"));
  await expect
    .poll(() => page.evaluate(() => window.__bench.scene.getStats().framesRendered))
    .toBeGreaterThan(before);
  expect(await page.evaluate(() => window.__bench.scene.getStats().lastDrawCalls)).toBeGreaterThan(
    0,
  );
});
test("dispose is idempotent and removes owned DOM without affecting host children", async ({
  page,
}) => {
  await page.evaluate(() => {
    const child = document.createElement("span");
    child.id = "unowned";
    document.querySelector("#host")!.appendChild(child);
    window.__bench.stopMonitoring();
    window.__bench.scene.dispose();
    window.__bench.scene.dispose();
    window.__bench.scene.resetCamera();
    window.__bench.scene.setLabelsEnabled(false);
  });
  await expect(page.locator("#host canvas,.explorer-label")).toHaveCount(0);
  await expect(page.locator("#unowned")).toHaveCount(1);
  const frames = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__bench.scene.getStats().framesRendered)).toBe(frames);
});
test("pointer labels click their displayed index", async ({ page }) => {
  await page.evaluate(() => window.__bench.highlight(0));
  await settle(page);
  const label = page.locator('.explorer-label[data-node-index="0"]');
  await expect(label).toBeVisible();
  await clearEvents(page);
  await label.click();
  expect(
    await page.evaluate(() =>
      window.__bench.events.filter((e) => e.type === "nodeClick").map((e) => e.payload),
    ),
  ).toEqual([{ index: 0 }]);
});
test("data replacement preserves selection and related nodes by stable IDs", async ({ page }) => {
  await page.evaluate(() => {
    const s = window.__bench.scene;
    s.setData({
      nodes: {
        count: 3,
        ids: ["a", "b", "c"],
        labels: ["A", "B", "Unrelated"],
        kinds: new Uint8Array([0, 1, 0]),
        positions: new Float32Array([-200, 0, 0, 200, 0, 0, 0, 150, 0]),
      },
      edges: {
        count: 1,
        source: new Uint32Array([0]),
        target: new Uint32Array([1]),
        kinds: new Uint8Array([0]),
        styles: new Uint8Array([0]),
        weight: new Uint16Array([2]),
      },
    });
    s.setHighlight(0, new Uint32Array([1]));
    s.setData({
      nodes: {
        count: 3,
        ids: ["b", "a", "c"],
        labels: ["B", "A", "Unrelated"],
        kinds: new Uint8Array([1, 0, 0]),
        positions: new Float32Array([200, 0, 0, -200, 0, 0, 0, 150, 0]),
      },
      edges: {
        count: 1,
        source: new Uint32Array([1]),
        target: new Uint32Array([0]),
        kinds: new Uint8Array([0]),
        styles: new Uint8Array([0]),
        weight: new Uint16Array([2]),
      },
    });
    s.resetCamera();
  });
  await settle(page);
  // Both highlighted nodes stay eligible for labels after ID reordering.
  await expect(page.locator('.explorer-label[data-node-index="1"]')).toBeVisible();
  await expect(page.locator('.explorer-label[data-node-index="0"]')).toBeVisible();
  await expect(page.locator('.explorer-label[data-node-index="2"]')).toHaveCount(0);
  await page.evaluate(() => {
    const s = window.__bench.scene;
    s.setData({
      nodes: {
        count: 3,
        ids: ["b", "a", "c"],
        labels: ["B", "A", "Unrelated"],
        kinds: new Uint8Array([1, 0, 0]),
        positions: new Float32Array([0, 0, 0, 0, 0, 0, 400, 0, 0]),
      },
      edges: {
        count: 1,
        source: new Uint32Array([1]),
        target: new Uint32Array([0]),
        kinds: new Uint8Array([0]),
        styles: new Uint8Array([0]),
        weight: new Uint16Array([2]),
      },
    });
    s.resetCamera();
  });
  await settle(page);
  // Selected A must outrank related B when their labels collide after reordering: A keeps the
  // preferred spot right of the shared point; B may only take the fallback spot to its left, never
  // overlapping A.
  const selected = page.locator('.explorer-label[data-node-index="1"]');
  await expect(selected).toBeVisible();
  const a = (await selected.boundingBox())!;
  const related = page.locator('.explorer-label[data-node-index="0"]');
  if (await related.count()) {
    const b = (await related.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(a.x);
  }
});
test("normal camera movement animates and eventually renders zero idle frames", async ({
  page,
}) => {
  await load(page, "small", false);
  const before = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await page.evaluate(() => window.__bench.scene.focusNode(0));
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => window.__bench.scene.getStats().framesRendered)).toBeGreaterThan(
    before + 1,
  );
  const settled = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__bench.scene.getStats().framesRendered)).toBe(settled);
});
test("nodes beyond the camera far plane cannot steal a background click", async ({ page }) => {
  await page.evaluate(() => {
    const s = window.__bench.scene;
    const edges = {
      count: 0,
      source: new Uint32Array(),
      target: new Uint32Array(),
      kinds: new Uint8Array(),
      styles: new Uint8Array(),
      weight: new Uint16Array(),
    };
    s.setData({
      nodes: {
        count: 1,
        ids: ["visible"],
        labels: ["Visible"],
        kinds: new Uint8Array([0]),
        positions: new Float32Array([0, 0, 0]),
      },
      edges,
    });
    s.focusNode(0);
    s.setData({
      nodes: {
        count: 2,
        ids: ["visible", "clipped"],
        labels: ["Visible", "Clipped"],
        kinds: new Uint8Array([0, 0]),
        positions: new Float32Array([0, 0, 0, 0, 0, -20000]),
      },
      edges,
    });
    s.setVisibility(new Uint8Array([0, 1]));
    s.setLabelsEnabled(false);
  });
  await settle(page);
  await clearEvents(page);
  const p = await point(page, 1);
  await page.mouse.click(p.x, p.y);
  expect(
    await page.evaluate(() => window.__bench.events.filter((e) => e.type === "nodeClick")),
  ).toEqual([]);
  expect(
    await page.evaluate(() => window.__bench.events.some((e) => e.type === "backgroundClick")),
  ).toBe(true);
});
test("pointer cancellation ends orbit input and suppresses clicks", async ({ page }) => {
  const box = (await page.locator("#host").boundingBox())!,
    x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 30);
  await page.locator("#host canvas").dispatchEvent("pointercancel", {
    pointerId: 1,
    pointerType: "mouse",
    clientX: x + 60,
    clientY: y + 30,
  });
  await page.mouse.up();
  await settle(page);
  await clearEvents(page);
  const before = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await page.mouse.move(x + 150, y + 100);
  await settle(page);
  // A hover may invalidate once; cancelled controls must not continue an orbit.
  expect(
    await page.evaluate(() => window.__bench.scene.getStats().framesRendered),
  ).toBeLessThanOrEqual(before + 1);
  expect(
    await page.evaluate(() => window.__bench.events.some((e) => e.type.endsWith("Click"))),
  ).toBe(false);
});
test("WebGL2 failure leaves the host intact and reports the typed fallback error", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<typeof original>
    ): ReturnType<typeof original> {
      if (String(args[0]) === "webgl2") return null;
      return original.apply(this, args);
    } as typeof original;
  });
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute("role", "alert");
  await expect(page.locator("#status")).toContainText("WebGL2 is unavailable");
  await expect(page.locator("#host canvas,.explorer-label")).toHaveCount(0);
});
test("wheel input takes control during a running camera tween", async ({ page }) => {
  await load(page, "small", false);
  await page.evaluate(() => window.__bench.scene.focusNode(0));
  await page.waitForTimeout(60);
  const box = (await page.locator("#host").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__bench.scene.getStats().framesRendered)).toBe(before);
});
test("dispose during context loss cancels restoration and removes every owned element", async ({
  page,
}) => {
  await page.evaluate(() => window.__bench.highlight(0));
  await settle(page);
  const label = page.locator('.explorer-label[data-node-index="0"]');
  await expect(label).toBeVisible();
  const box = (await label.boundingBox())!;
  await page.mouse.move(box.x + 3, box.y + 3);
  await page.mouse.down();
  expect(await page.locator("#host").evaluate((host) => host.hasPointerCapture(1))).toBe(true);
  const supported = await page.evaluate(() => {
    const ext = document
      .querySelector("canvas")!
      .getContext("webgl2")!
      .getExtension("WEBGL_lose_context");
    if (!ext) return false;
    ext.loseContext();
    return true;
  });
  test.skip(!supported, "WEBGL_lose_context unavailable");
  await page.waitForFunction(() => window.__bench.events.some((e) => e.type === "contextLost"));
  expect(await page.locator("#host").evaluate((host) => host.hasPointerCapture(1))).toBe(false);
  await page.evaluate(() => {
    window.__bench.stopMonitoring();
    window.__bench.scene.dispose();
    window.__bench.scene.dispose();
  });
  await expect(page.locator("#host canvas,.explorer-label")).toHaveCount(0);
  const count = await page.evaluate(() => window.__bench.scene.getStats().framesRendered);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__bench.scene.getStats().framesRendered)).toBe(count);
  await page.mouse.up();
});
