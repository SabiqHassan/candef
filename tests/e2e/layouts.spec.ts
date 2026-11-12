/**
 * M2 acceptance: 390 px phone and 1366 px laptop layouts. Demo labelling stays visible, nothing
 * scrolls the page sideways, and task T1 (find a company, see its HQ) works at both sizes.
 */
import { expect, test, type Page } from "@playwright/test";
import { escape, snapshot } from "./helpers";

async function findCompanyAndSeeHq(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("note")).toBeVisible();
  await expect(page.getByRole("note")).toContainText("Fictional demonstration data");
  const snap = await snapshot(page);
  const target = snap.organizations.filter(
    (o) => o.scope === "universe" && o.hq.state === "verified",
  )[5]!;
  const show = page.getByRole("button", { name: "Show company directory" });
  if (await show.isVisible()) await show.click();
  await page
    .getByRole("searchbox", { name: "Search companies and institutions" })
    .fill(target.name.split(" ")[0]!);
  await page
    .getByRole("complementary", { name: "Company directory" })
    .getByRole("button", { name: new RegExp(`^${escape(target.name)}`) })
    .first()
    .click();
  const card = page.getByRole("complementary", { name: "Selection details" });
  await expect(card.getByRole("heading", { level: 2, name: target.name })).toBeVisible();
  await expect(card.getByText(target.hq.value!.province!, { exact: false }).first()).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("phone, 390 px", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("demo label visible; directory is an overlay that closes after a pick", async ({ page }) => {
    await findCompanyAndSeeHq(page);
    await expect(page.getByRole("complementary", { name: "Company directory" })).toHaveCount(0);
  });
  test("dossier fits the width", async ({ page }) => {
    await page.goto("/");
    const snap = await snapshot(page);
    await page.goto(`/company/${snap.organizations.find((o) => o.scope === "universe")!.slug}`);
    await expect(page.getByRole("note")).toBeVisible();
    await expect(page.getByRole("note")).toContainText("Fictional demonstration data");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("laptop, 1366 px", () => {
  test.use({ viewport: { width: 1366, height: 768 } });
  test("docked directory and card side by side; T1 works", async ({ page }) => {
    await findCompanyAndSeeHq(page);
    await expect(page.getByRole("complementary", { name: "Company directory" })).toBeVisible();
  });
});
