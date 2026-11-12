/**
 * Other transfer payments (TBS grants type O) are a family of their own: listed apart from
 * procurement contracts and grants, labelled with the source's own classification, described as
 * stated agreement amounts rather than confirmed payments, and never drawn as a relationship line.
 */
import { expect, test } from "@playwright/test";
import { openExplorer, snapshot } from "./helpers";

async function subject(page: import("@playwright/test").Page) {
  await openExplorer(page);
  const snap = await snapshot(page);
  const agreement = snap.agreements.find((g) => g.family === "other_transfer")!;
  const recipient = snap.organizations.find((o) => o.id === agreement.attributions[0]!.orgId)!;
  return { snap, agreement, recipient };
}

test("the dossier lists it under its own heading with the source classification and a plain caveat", async ({
  page,
}) => {
  const { agreement, recipient } = await subject(page);
  await page.goto(`/company/${recipient.slug}`);
  const gov = page.locator("#government");
  await expect(
    gov.getByRole("heading", { level: 3, name: /^Other transfer payments/ }),
  ).toBeVisible();
  await expect(gov.getByText(/not a confirmed payment/)).toBeVisible();
  const row = gov.getByRole("row").filter({ hasText: agreement.title });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("source classification: Other transfer payment (O)");
  // The same title is not listed under procurement contracts or grants.
  for (const name of [/^Procurement contracts/, /^Grants and contributions/])
    await expect(
      gov
        .locator("div", { has: page.getByRole("heading", { level: 3, name }) })
        .getByRole("row")
        .filter({ hasText: agreement.title }),
    ).toHaveCount(0);
});

test("the company card counts it separately and says it is not a payment", async ({ page }) => {
  const { recipient } = await subject(page);
  await page.goto(`/?sel=${recipient.id}`);
  const card = page.getByRole("complementary", { name: "Selection details" });
  await expect(card.getByText("Other transfer payments", { exact: true })).toBeVisible();
  await expect(card.getByText(/not confirmed payments/)).toBeVisible();
});

test("the funder's panel counts it and says it is not drawn", async ({ page }) => {
  const { agreement, snap } = await subject(page);
  const funder = snap.organizations.find(
    (o) => o.id === agreement.parties.find((p) => p.role === "funder")!.orgId,
  )!;
  await page.goto(`/?lens=contracts&sel=${funder.id}`);
  const panel = page.getByRole("complementary", { name: "Selection details" });
  await expect(panel.getByText("Other transfer payments", { exact: true })).toBeVisible();
  await expect(panel.getByText("not drawn as relationship lines")).toBeVisible();
});

test("the methodology page explains the category and counts it separately", async ({ page }) => {
  await page.goto("/methodology");
  await expect(page.getByText(/Other transfer payments" are a separate category/)).toBeVisible();
  await expect(
    page.locator("p", { hasText: "grants and contributions, 1 other transfer payment." }),
  ).toBeVisible();
});
