/**
 * What each kind of visit downloads. The 3D engine (three.js, ~130 KB gzipped) is a separate chunk:
 * phones (list by default), shared dossier links and the methodology page must not pay for it, and
 * a desktop visit must still get it without a second wait. (docs/BACKLOG.md; before this, every
 * route loaded 914 KB of JavaScript.)
 */
import { expect, test, type Page } from "@playwright/test";

/** JavaScript files a page load pulls in, by chunk name, in bytes. */
async function loadedScripts(page: Page, url: string) {
  const js: Record<string, number> = {};
  page.on("response", async (r) => {
    if (r.url().endsWith(".js"))
      js[
        r
          .url()
          .split("/")
          .pop()!
          .replace(/-[\w-]{8}\.js$/, "")
      ] = (await r.body()).length;
  });
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  return js;
}
const kb = (js: Record<string, number>) =>
  Math.round(Object.values(js).reduce((a, b) => a + b, 0) / 1024);

async function firstSlug(page: Page) {
  await page.goto("/methodology");
  return page.evaluate(async () => {
    const m = await (await fetch("/data/demo/manifest.json")).json();
    const s = await (await fetch(`/data/demo/${m.current}`)).json();
    return s.organizations.find((o: { scope: string }) => o.scope === "universe").slug as string;
  });
}

test("a dossier deep link does not download the 3D engine", async ({ page }) => {
  const slug = await firstSlug(page);
  const js = await loadedScripts(await page.context().newPage(), `/company/${slug}`);
  expect(Object.keys(js).some((k) => k.startsWith("three"))).toBe(false);
  expect(kb(js)).toBeLessThan(500);
});

test("the methodology page does not download the 3D engine", async ({ page }) => {
  const js = await loadedScripts(page, "/methodology");
  expect(Object.keys(js).some((k) => k.startsWith("three"))).toBe(false);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("opens the flat 2D map without the 3D engine, and fetches 3D only when asked", async ({
    page,
  }) => {
    const js = await loadedScripts(page, "/");
    expect(Object.keys(js).some((k) => k.startsWith("three"))).toBe(false);
    await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
    const more: string[] = [];
    page.on("response", (r) => r.url().endsWith(".js") && more.push(r.url()));
    await page
      .getByRole("group", { name: "Network dimensions" })
      .getByRole("button", { name: "3D" })
      .click();
    await expect(page.locator("canvas[role=img]")).toBeVisible({ timeout: 15_000 });
    expect(more.some((u) => /three/.test(u))).toBe(true);
  });
});

test("a desktop visit still gets the 3D view, with the engine fetched at boot", async ({
  page,
}) => {
  const js = await loadedScripts(page, "/");
  expect(Object.keys(js).some((k) => k.startsWith("three"))).toBe(true);
  await expect(page.locator("canvas[role=img]")).toBeVisible();
});

test("if the 3D engine cannot be downloaded, the explorer shows the 2D map instead", async ({
  page,
}) => {
  await page.route(/three-.*\.js$/, (r) => r.abort());
  await page.goto("/");
  await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/3D view could not be loaded/i)).toBeVisible();
});

test("while the 3D engine downloads, a centred, quiet loading note shows", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/three-.*\.js$/, async (r) => {
    await held;
    await r.continue();
  });
  await page.goto("/");
  const note = page.getByRole("status").filter({ hasText: "Loading the 3D view" });
  await expect(note).toBeVisible({ timeout: 15_000 });
  const style = await note.evaluate((e) => {
    const s = getComputedStyle(e);
    return { display: s.display, justify: s.justifyContent, align: s.alignItems };
  });
  expect(style).toEqual({ display: "flex", justify: "center", align: "center" });
  release();
  await expect(page.locator("canvas[role=img]")).toBeVisible({ timeout: 15_000 });
});
