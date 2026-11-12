/** Search v2 (docs/BACKLOG.md): legal and former names, word order, ranking, institutions. */
import { expect, test } from "@playwright/test";
import { openExplorer, snapshot } from "./helpers";

const directory = (page: import("@playwright/test").Page) =>
  page.getByRole("complementary", { name: "Company directory" });
const box = (page: import("@playwright/test").Page) =>
  page.getByRole("searchbox", { name: "Search companies and institutions" });

test("a pasted legal name finds the company, first", async ({ page }) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  const c = snap.organizations.find((o) => o.scope === "universe" && o.legalName.value)!;
  await box(page).fill(c.legalName.value!);
  const first = directory(page).getByRole("button").filter({ hasText: c.name }).first();
  await expect(first).toBeVisible();
  await expect(page).toHaveURL(/q=/);
});

test("a former legal name still finds the renamed company", async ({ page }) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  const c = snap.organizations.find((o) => o.scope === "universe" && o.legalName.history?.length)!;
  await box(page).fill(c.legalName.history![0]!.value);
  await expect(
    directory(page)
      .getByRole("button", { name: new RegExp(c.name) })
      .first(),
  ).toBeVisible();
});

test("words can be typed in any order and across fields", async ({ page }) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  const c = snap.organizations.find(
    (o) => o.scope === "universe" && o.hq.value?.city && o.segment.value,
  )!;
  await box(page).fill(`${c.hq.value!.city} ${c.name.split(" ")[0]}`);
  await expect(directory(page).getByRole("button", { name: new RegExp(c.name) })).toBeVisible();
});

test("an investor is found by its name words in any order", async ({ page }) => {
  await openExplorer(page, "?lens=capital");
  const snap = await snapshot(page);
  const id = snap.graph.lenses.capital.institutionIds[0]!;
  const inv = snap.organizations.find((o) => o.id === id)!;
  await directory(page)
    .getByRole("tab", { name: /Investors/ })
    .click();
  await box(page).fill(inv.name.toLowerCase().split(" ").reverse().join(" "));
  await expect(
    directory(page)
      .getByRole("button", { name: new RegExp(inv.name.split(" ")[0]!) })
      .first(),
  ).toBeVisible();
});

test("a search with no match says so instead of showing an empty box", async ({ page }) => {
  await openExplorer(page);
  await box(page).fill("zzzz no such company");
  await expect(directory(page).getByText(/No (companies|matches)|nothing/i)).toBeVisible();
});
