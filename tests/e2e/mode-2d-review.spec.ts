/**
 * Regressions from the independent Codex review of the 2D view (docs/prototypes/network-2d.md):
 * download failures, returning from the list, the details panel and animations, touch pinch release,
 * Escape on a relationship, and a real click on a name.
 */
import { expect, test, type Page } from "@playwright/test";
import { openExplorer, searchAndSelect, snapshot } from "./helpers";

/** The renderer's own diagnostics handle (set by GraphView2D). */
interface Engine {
  data: { nodes: { kinds: Uint8Array; labels: string[]; count: number } };
  positions: Float32Array;
  canvas: HTMLCanvasElement;
  toScreen(x: number, y: number): [number, number];
  getStats(): { visibleEdges: number; visibleLabels: number };
  getView(): { scale: number; overviewScale: number; level: number };
  zoomBy(f: number): void;
  resetCamera(): void;
  setHighlight(s: number | null, r: Uint32Array | null): void;
  selected: number | null;
  cam: { cx: number; cy: number; scale: number };
}
type W = { __candef2d: Engine };
const map = (page: Page) => page.getByTestId("graph-host-2d").locator("canvas");
const ready = async (page: Page) => {
  await expect(map(page)).toBeVisible();
  await page.waitForFunction(
    () => ((window as unknown as Partial<W>).__candef2d?.getStats().visibleLabels ?? 0) > 0,
  );
  await page.waitForTimeout(600);
};

test("if the 2D download fails, the list takes over; if both views fail, the list too", async ({
  page,
}) => {
  await page.route(/GraphView2D-.*\.js$/, (r) => r.abort());
  await page.goto("/?mode=2d");
  await expect(page.getByRole("table")).toBeVisible({ timeout: 15_000 });
  // Both renderers unavailable: 3D falls back to 2D, 2D fails, so the list shows.
  await page.route(/three-.*\.js$/, (r) => r.abort());
  await page.goto("/");
  await expect(page.getByRole("table")).toBeVisible({ timeout: 15_000 });
});

test("returning from the list shows the overview lines again, not the zoomed-in ones", async ({
  page,
}) => {
  await openExplorer(page, "?mode=2d");
  await ready(page);
  const overviewEdges = await page.evaluate(
    () => (window as unknown as W).__candef2d.getStats().visibleEdges,
  );
  await page.evaluate(() => {
    const e = (window as unknown as W).__candef2d;
    e.zoomBy(2 / e.getView().overviewScale);
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as W).__candef2d.getStats().visibleEdges))
    .toBeGreaterThan(overviewEdges * 2);
  await page.getByRole("button", { name: "Show as list" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.getByRole("button", { name: "Show 2D network" }).click();
  await ready(page);
  expect(
    await page.evaluate(() => (window as unknown as W).__candef2d.getStats().visibleEdges),
  ).toBe(overviewEdges);
});

test("selecting a company far to the right is kept in view when the details panel opens", async ({
  page,
}) => {
  await openExplorer(page, "?mode=2d");
  await ready(page);
  // A company that, before the panel opens, sits in the strip the panel is about to cover:
  // inside the free area minus 160 px (the old check), but not inside it minus 416 px (the panel).
  const name = await page.evaluate(async () => {
    const e = (window as unknown as W).__candef2d;
    e.zoomBy(1 / e.getView().overviewScale);
    await new Promise((r) => setTimeout(r, 700));
    let i = 0;
    while (e.data.nodes.kinds[i] !== 0) i++;
    const w = e.canvas.clientWidth;
    const [x, y] = e.toScreen(e.positions[i * 3]!, e.positions[i * 3 + 1]!);
    e.cam = {
      ...e.cam,
      cx: e.cam.cx - (w - 230 - x) / e.cam.scale,
      cy: e.cam.cy - (e.canvas.clientHeight / 2 - y) / e.cam.scale,
    };
    return e.data.nodes.labels[i]!;
  });
  await searchAndSelect(page, name!);
  await page.waitForTimeout(900);
  const x = await page.evaluate(() => {
    const e = (window as unknown as W).__candef2d;
    const i = e.selected!;
    return e.toScreen(e.positions[i * 3]!, e.positions[i * 3 + 1]!)[0];
  });
  const width = await page.evaluate(() => (window as unknown as W).__candef2d.canvas.clientWidth);
  // Comfortably inside the area the panel leaves free (the old code left it about 20 px from the edge).
  expect(x).toBeLessThan(width - 416 - 120);
});

test("a selection made while the camera is zooming is still brought into view", async ({
  page,
}) => {
  await openExplorer(page, "?mode=2d");
  await ready(page);
  const result = await page.evaluate(async () => {
    const e = (window as unknown as W).__candef2d;
    e.zoomBy(1.2 / e.getView().overviewScale);
    await new Promise((r) => setTimeout(r, 700));
    const w = e.canvas.clientWidth;
    // A company inside the view now (right of centre), that a 3x zoom would push past the right edge.
    let pick = 0;
    while (e.data.nodes.kinds[pick] !== 0) pick++;
    const [x0, y0] = e.toScreen(e.positions[pick * 3]!, e.positions[pick * 3 + 1]!);
    e.cam = {
      ...e.cam,
      cx: e.cam.cx - (w * 0.78 - x0) / e.cam.scale,
      cy: e.cam.cy - (e.canvas.clientHeight / 2 - y0) / e.cam.scale,
    };
    await new Promise((r) => setTimeout(r, 100));
    e.zoomBy(3);
    e.setHighlight(pick, null); // while the zoom animation is running
    await new Promise((r) => setTimeout(r, 1200));
    const [x, y] = e.toScreen(e.positions[pick * 3]!, e.positions[pick * 3 + 1]!);
    return { x, y, w, h: e.canvas.clientHeight };
  });
  expect(result.x).toBeGreaterThan(0);
  expect(result.x).toBeLessThan(result.w - 100);
  expect(result.y).toBeGreaterThan(0);
  expect(result.y).toBeLessThan(result.h);
});

test("clicking a company's name on the map selects it", async ({ page }) => {
  await openExplorer(page, "?mode=2d");
  await ready(page);
  const target = await page.evaluate(async () => {
    const e = (window as unknown as W).__candef2d;
    e.zoomBy(1.2 / e.getView().overviewScale);
    await new Promise((r) => setTimeout(r, 700));
    // Bring the first company into the open middle of the map (clear of the directory and panels).
    let i = 0;
    while (e.data.nodes.kinds[i] !== 0) i++;
    const r = e.canvas.getBoundingClientRect();
    const [x, y] = e.toScreen(e.positions[i * 3]!, e.positions[i * 3 + 1]!);
    e.cam = {
      ...e.cam,
      cx: e.cam.cx - (r.width * 0.6 - x) / e.cam.scale,
      cy: e.cam.cy - (r.height * 0.5 - y) / e.cam.scale,
    };
    await new Promise((res) => setTimeout(res, 300));
    return {
      name: e.data.nodes.labels[i]!,
      x: r.left + r.width * 0.6 + 4,
      y: r.top + r.height * 0.5,
    };
  });
  await page.mouse.click(target.x, target.y);
  await expect(page.getByRole("heading", { level: 2, name: target.name })).toBeVisible();
});

test("Escape on the map closes an open relationship", async ({ page }) => {
  await page.goto("/");
  const snap = await snapshot(page);
  const edge = snap.graph.lenses.capital.edges[0]!;
  await openExplorer(page, `?mode=2d&rel=${encodeURIComponent(edge.id)}`);
  await ready(page);
  await expect(page.getByRole("heading", { level: 2, name: /Relationship/ })).toBeVisible();
  await map(page).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { level: 2, name: /Relationship/ })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("rel")).toBeNull();
});

test.describe("touch pinch", () => {
  /** Two fingers down, spread, then one lifted; returns the scale after the pinch and after more moves. */
  async function pinch(page: Page, lift: "first" | "second") {
    return page.evaluate(async (which) => {
      const e = (window as unknown as W).__candef2d;
      const c = e.canvas;
      const r = c.getBoundingClientRect();
      const ev = (type: string, id: number, x: number, y: number) =>
        c.dispatchEvent(
          new PointerEvent(type, {
            pointerId: id,
            pointerType: "touch",
            isPrimary: id === 1,
            button: 0,
            bubbles: true,
            clientX: r.left + x,
            clientY: r.top + y,
          }),
        );
      const cx = r.width / 2;
      const cy = r.height / 2;
      (window as unknown as { __pinchFrom: number }).__pinchFrom = e.getView().scale;
      ev("pointerdown", 1, cx - 60, cy);
      ev("pointerdown", 2, cx + 60, cy);
      ev("pointermove", 2, cx + 140, cy);
      await new Promise((res) => setTimeout(res, 50));
      const during = e.getView().scale;
      const started = (window as unknown as { __pinchFrom: number }).__pinchFrom;
      const [liftId, restId, restX] = which === "first" ? [1, 2, cx + 140] : [2, 1, cx - 60];
      ev("pointerup", liftId, liftId === 1 ? cx - 60 : cx + 140, cy);
      ev("pointermove", restId, restX + 6, cy);
      await new Promise((res) => setTimeout(res, 50));
      const after = e.getView().scale;
      ev("pointerup", restId, restX + 6, cy);
      return { started, during, after, selected: e.selected };
    }, lift);
  }
  for (const lift of ["first", "second"] as const) {
    test(`lifting the ${lift} finger keeps the zoom and does not select anything`, async ({
      page,
    }) => {
      await openExplorer(page, "?mode=2d");
      await ready(page);
      const r = await pinch(page, lift);
      // The pinch itself must have zoomed in (otherwise this test would prove nothing).
      expect(r.during).toBeGreaterThan(r.started * 1.3);
      expect(Math.abs(r.after - r.during) / r.during).toBeLessThan(0.02);
      expect(r.selected).toBeNull();
    });
  }
});
