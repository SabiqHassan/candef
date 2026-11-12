import { expect, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/domain/schema/snapshot";

/** Loads the same snapshot the app uses, so tests pick subjects by data properties, not names. */
export async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const manifest = await (await fetch("/data/demo/manifest.json")).json();
    return (await fetch(`/data/demo/${manifest.current}`)).json();
  });
}

export async function openExplorer(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.getByRole("tablist", { name: "Network view" })).toBeVisible();
}

export async function searchAndSelect(page: Page, name: string) {
  await page.getByRole("searchbox", { name: "Search companies and institutions" }).fill(name);
  await page
    .getByRole("complementary", { name: "Company directory" })
    .getByRole("button", { name: new RegExp(`^${escape(name)}`) })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
}

export function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
