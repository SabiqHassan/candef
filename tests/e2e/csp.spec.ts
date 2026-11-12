/**
 * The beta ships with a strict Content-Security-Policy (pipeline/release/beta.ts). A policy that
 * blocks something the application needs would only be discovered on the first deployment, so
 * this runs the real application under exactly that policy and fails on any violation.
 */
import { expect, test, type Page } from "@playwright/test";
import { CONTENT_SECURITY_POLICY } from "../../pipeline/release/beta";
import { openExplorer, snapshot } from "./helpers";

type Violation = { directive: string; blocked: string };

/** Adds the policy to every response and records every violation the browser reports. */
async function underPolicy(page: Page) {
  await page.route("**/*", async (route) => {
    const res = await route.fetch();
    await route.fulfill({
      response: res,
      headers: { ...res.headers(), "content-security-policy": CONTENT_SECURITY_POLICY },
    });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: Violation[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      w.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI || e.sample }),
    );
  });
}
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: Violation[] }).__csp);

test("the policy actually applies in this test (a blocked inline script is reported)", async ({
  page,
}) => {
  await underPolicy(page);
  await page.goto("/methodology");
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__ran = true";
    document.head.append(s);
  });
  expect(await page.evaluate(() => (window as { __ran?: boolean }).__ran)).toBeUndefined();
  expect((await violations(page)).length).toBeGreaterThan(0);
});

test("explorer, 3D view, lenses, list, dossier and methodology run without a violation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await underPolicy(page);

  await openExplorer(page);
  await expect(page.locator("canvas[role=img]")).toBeVisible();
  await page.getByRole("tab", { name: "Government" }).click();
  await page.getByRole("tab", { name: "Industry" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await page.waitForTimeout(600);

  const snap = await snapshot(page);
  const company = snap.organizations.find((o) => o.scope === "universe")!;
  await page.goto(`/?sel=${company.id}`);
  await expect(page.getByRole("heading", { level: 2, name: company.name })).toBeVisible();
  // A citation chip opens its card (inline styles and fonts load under the policy).
  await page.locator("[data-source-chip]").first().click();

  await page.goto("/?view=list");
  await expect(page.locator("table tbody tr").first()).toBeVisible();
  await page.goto(`/company/${company.slug}`);
  await expect(page.locator("#sources")).toBeVisible();
  await page.goto("/methodology");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("fonts, styles and the 2D map and 3D engine load under the policy on a phone too", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await underPolicy(page);
  await page.goto("/");
  await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
  await page
    .getByRole("group", { name: "Network dimensions" })
    .getByRole("button", { name: "3D" })
    .click();
  await expect(page.locator("canvas[role=img]")).toBeVisible({ timeout: 15_000 });
  expect(await violations(page)).toEqual([]);
});
