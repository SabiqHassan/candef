/**
 * Regressions found by the synthetic stress harness (bench/stress, docs/reports/scalability-2026-10-14.md).
 * The list view renders progressively: rendering every company at once cost 2 s and 142,000 DOM
 * nodes at 3,000 companies.
 */
import { expect, test, type Page } from "@playwright/test";
import { openExplorer, snapshot } from "./helpers";

const PAGE = 100;

/**
 * Brings the next page in. Scrolling the button into view also triggers the automatic loading, so
 * the button can re-render under the click: a click that loses that race is not a failure.
 */
async function showMore(page: Page) {
  const rows = page.locator("table tbody tr");
  const before = await rows.count();
  await page
    .getByRole("button", { name: `Show ${PAGE} more` })
    .click({ timeout: 3000 })
    .catch(() => undefined);
  await expect.poll(() => rows.count()).toBeGreaterThan(before);
}

test("the list renders the first page, then more on request and on scroll", async ({ page }) => {
  await openExplorer(page, "?view=list");
  const snap = await snapshot(page);
  const total = snap.organizations.filter((o) => o.scope === "universe").length;
  test.skip(total <= PAGE * 2, "the demo needs more than two pages of companies");
  const rows = page.locator("table tbody tr");
  await expect(rows).toHaveCount(PAGE);
  await expect(
    page.getByRole("status").filter({ hasText: `Showing ${PAGE} of ${total}` }),
  ).toBeVisible();
  await showMore(page);
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(PAGE * 2);
  // Scrolling to the end of the list adds the next page by itself.
  await page
    .locator("table")
    .evaluate((t) => (t.parentElement!.scrollTop = t.parentElement!.scrollHeight));
  await expect.poll(() => rows.count()).toBeGreaterThan(PAGE * 2);
});

test("a selected company beyond the first page is still rendered and marked", async ({ page }) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  const companies = snap.organizations
    .filter((o) => o.scope === "universe")
    .sort((a, b) => a.name.localeCompare(b.name, "en-CA", { numeric: true, sensitivity: "base" }));
  test.skip(companies.length <= PAGE, "needs more than one page");
  const late = companies[companies.length - 1]!;
  await page.goto(`/?view=list&sel=${late.id}`);
  const row = page.locator('table tbody tr[aria-selected="true"]');
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("rowheader")).toHaveText(late.name);
});

test("a new sort starts again from the first page", async ({ page }) => {
  await openExplorer(page, "?view=list");
  const rows = page.locator("table tbody tr");
  const more = page.getByRole("button", { name: `Show ${PAGE} more` });
  test.skip((await more.count()) === 0, "needs more than one page");
  await showMore(page);
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(PAGE * 2);
  await page.getByRole("table").getByRole("button", { name: "Sector" }).click();
  await expect(rows).toHaveCount(PAGE);
});
