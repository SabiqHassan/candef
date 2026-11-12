/**
 * The lead search page (P-59, option B) against the fictional demo leads: it is clearly labelled as
 * unverified, searching and filtering work, a lead shows its government records, the URL carries
 * the search, and the page is usable by keyboard, on a phone and with no accessibility violations.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const open = async (page: import("@playwright/test").Page, q = "") => {
  await page.goto(`/leads${q}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Leads from government data" }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search leads" })).toBeVisible();
};

test("is reachable from the navigation and says what it is", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Leads", exact: true })
    .click();
  await expect(page).toHaveTitle("Leads from government data | CANDEF");
  const note = page
    .getByRole("note")
    .filter({ hasText: "Unverified leads from public government data" });
  await expect(note).toContainText("not CANDEF companies");
  await expect(note).toContainText("Fictional demonstration leads");
});

test("search finds synonyms and the count updates", async ({ page }) => {
  await open(page);
  const all = await page.locator("#results-h").innerText();
  await page.getByRole("searchbox", { name: "Search leads" }).fill("drone");
  await expect(page.getByRole("button", { name: /Tidewater UAS Labs/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Alder Ridge Robotics/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Prairie Airframes/ })).toHaveCount(0);
  expect(await page.locator("#results-h").innerText()).not.toBe(all);
  await expect(page).toHaveURL(/q=drone/);
  await page.getByRole("searchbox", { name: "Search leads" }).fill("xylophone");
  await expect(page.getByText("No lead matches.")).toBeVisible();
});

test("filters narrow the list and can be cleared", async ({ page }) => {
  await open(page);
  await page.getByLabel("Province").selectOption("QC");
  await expect(page.getByRole("button", { name: /Orbit Line Space Systems/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Alder Ridge/ })).toHaveCount(0);
  await page.getByLabel("Province").selectOption("");
  await page.getByLabel("Space", { exact: true }).click();
  await expect(page.getByLabel("Space", { exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: /Orbit Line/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Northwind Optics/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  await expect(page.getByRole("button", { name: /Northwind Optics/ })).toBeVisible();
});

test("a lead shows its government records, why it is a lead, and what is unknown", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("button", { name: /Harbour Light Sonar/ }).click();
  const detail = page.getByRole("region", { name: "Lead: Harbour Light Sonar Inc. (fictional)" });
  await expect(detail).toBeFocused();
  await expect(detail).toContainText("Unverified lead. Not researched by CANDEF.");
  await expect(detail).toContainText("Regional Defence Investment Initiative");
  await expect(detail).toContainText("Funded through a defence programme");
  await expect(detail).toContainText("Founding year: not in government data.");
  // Demo records are invented: never linked to the real open-data portal.
  await expect(detail.getByRole("link", { name: /View the government record/ })).toHaveCount(0);
  await expect(page).toHaveURL(/sel=demo%3Aharbour-sonar/);
  await detail.getByRole("button", { name: "Copy research request" }).click();
});

test("the selection and search survive a reload and the back button", async ({ page }) => {
  await open(page, "?q=satellite");
  await page.getByRole("button", { name: /Orbit Line/ }).click();
  await page.reload();
  await expect(page.getByRole("region", { name: /Lead: Orbit Line/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("region", { name: "Lead details" })).toBeVisible();
});

test("works on a phone: filters sit behind a button and a lead replaces the list", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page);
  const toggle = page.getByRole("button", { name: /^Filters/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("Province")).toBeHidden();
  await toggle.click();
  await expect(page.getByLabel("Province")).toBeVisible();
  await page.getByRole("button", { name: /Tidewater UAS Labs/ }).click();
  await expect(page.getByRole("region", { name: /Lead: Tidewater/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^\d+ leads?/ })).toBeHidden();
  await page.getByRole("button", { name: "Back to results" }).click();
  await expect(page.getByRole("button", { name: /Tidewater UAS Labs/ })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(overflow).toBe(false);
});

test("has no accessibility violations (list, detail, phone)", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: /Alder Ridge/ }).click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 800 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
