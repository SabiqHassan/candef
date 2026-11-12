/**
 * The 3D | 2D switch (docs/prototypes/network-2d.md): the same network and the same research state
 * in either view; 3D stays the desktop default and phones open 2D.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openExplorer, searchAndSelect, snapshot } from "./helpers";

const lens = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("tablist", { name: "Network view" }).getByRole("tab", { name });
const switchGroup = (page: import("@playwright/test").Page) =>
  page.getByRole("group", { name: "Network dimensions" });

test("desktop opens in 3D, and 2D is one click away", async ({ page }) => {
  await openExplorer(page);
  await expect(page.getByTestId("graph-host")).toBeVisible();
  await expect(switchGroup(page).getByRole("button", { name: "3D" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await switchGroup(page).getByRole("button", { name: "2D" }).click();
  await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
  await expect(page).toHaveURL(/mode=2d/);
});

test("switching modes keeps the selection, lens, filters and open panel", async ({ page }) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  const company = snap.organizations.find((o) => o.scope === "universe")!;
  await searchAndSelect(page, company.name);
  await lens(page, "Government").click();
  const before = new URL(page.url()).searchParams;
  await switchGroup(page).getByRole("button", { name: "2D" }).click();
  await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: company.name })).toBeVisible();
  await expect(lens(page, "Government")).toHaveAttribute("aria-selected", "true");
  const after = new URL(page.url()).searchParams;
  for (const k of ["sel", "lens", "q"]) expect(after.get(k)).toBe(before.get(k));
  await switchGroup(page).getByRole("button", { name: "3D" }).click();
  await expect(page.getByTestId("graph-host")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: company.name })).toBeVisible();
});

test("2D shows every lens, selects by clicking, and the map is keyboard operable", async ({
  page,
}) => {
  await openExplorer(page, "?mode=2d");
  for (const name of ["Capital", "Government", "Industry"]) {
    await lens(page, name).click();
    await expect(lens(page, name)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
  }
  const canvas = page.getByTestId("graph-host-2d").locator("canvas");
  await expect(canvas).toHaveAttribute("role", "img");
  await expect(canvas).toHaveAttribute("aria-label", /arrow keys pan/);
  await canvas.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("+");
  await page.keyboard.press("0");
  await expect(canvas).toBeFocused();
});

test("the 2D view has no accessibility violations", async ({ page }) => {
  await openExplorer(page, "?mode=2d");
  await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("opens 2D by default; the address can still ask for 3D or the list", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
    await page.goto("/?mode=3d");
    await expect(page.getByTestId("graph-host")).toBeVisible();
    await page.goto("/?view=list");
    await expect(page.locator("table, [role=table]").first()).toBeVisible();
  });
});
