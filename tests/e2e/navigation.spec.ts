/**
 * Single-page-app basics found missing by the 2026-10-14 assessment (docs/BACKLOG.md): every page
 * has its own title (WCAG 2.4.2: bookmarks, history and tabs name the page), and an in-app page
 * change starts at the new page instead of on the link that was activated.
 */
import { expect, test } from "@playwright/test";
import { openExplorer, searchAndSelect, snapshot } from "./helpers";

test("every page has its own descriptive title", async ({ page }) => {
  const titles = new Map<string, string>();
  await openExplorer(page);
  titles.set("explorer", await page.title());
  const snap = await snapshot(page);
  const company = snap.organizations.find((o) => o.scope === "universe")!;

  await page.goto(`/?sel=${company.id}`);
  await expect(page).toHaveTitle(
    new RegExp(`^${company.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, `),
  );
  titles.set("selected", await page.title());

  await page.goto("/?view=list");
  await expect(page).toHaveTitle(/^Company list \| CANDEF Explorer$/);
  await page.goto("/?lens=contracts");
  await expect(page).toHaveTitle(/^Government view \| CANDEF Explorer$/);

  await page.goto(`/company/${company.slug}`);
  await expect(page).toHaveTitle(`${company.name} dossier | CANDEF`);
  titles.set("dossier", await page.title());
  await page.goto("/methodology");
  await expect(page).toHaveTitle("Coverage and method | CANDEF");
  titles.set("methodology", await page.title());
  await page.goto("/no/such/page");
  await expect(page).toHaveTitle("Page not found | CANDEF");
  await page.goto("/company/not-a-company");
  await expect(page).toHaveTitle("Company not found | CANDEF");

  expect(new Set(titles.values()).size).toBe(titles.size);
});

test("the title follows a selection made inside the explorer", async ({ page }) => {
  await openExplorer(page);
  const before = await page.title();
  const snap = await snapshot(page);
  const company = snap.organizations.find((o) => o.scope === "universe")!;
  await searchAndSelect(page, company.name);
  await expect.poll(() => page.title()).toContain(company.name);
  expect(await page.title()).not.toBe(before);
});

test("an in-app page change moves focus to the new page", async ({ page }) => {
  await openExplorer(page);
  const focused = () => page.evaluate(() => document.activeElement?.id ?? "");
  expect(await focused()).not.toBe("main"); // nothing is stolen on first load
  await page.getByRole("link", { name: "Coverage and method" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Coverage and method" })).toBeVisible();
  await expect.poll(focused).toBe("main");
  await page.getByRole("link", { name: "Explorer" }).click();
  await expect(page.getByRole("tablist", { name: "Network view" })).toBeVisible();
  await expect.poll(focused).toBe("main");
});

test("changing a filter or lens does not steal focus from the control being used", async ({
  page,
}) => {
  await openExplorer(page);
  const box = page.getByRole("searchbox", { name: "Search companies and institutions" });
  await box.click();
  await page.keyboard.type("ab");
  await page.waitForTimeout(400); // past the search debounce: the URL has changed
  await expect(page).toHaveURL(/q=ab/);
  await expect(box).toBeFocused();
  const lens = page
    .getByRole("tablist", { name: "Network view" })
    .getByRole("tab", { name: "Government" });
  await lens.click();
  await expect(page).toHaveURL(/lens=contracts/);
  await expect(lens).toBeFocused();
});
