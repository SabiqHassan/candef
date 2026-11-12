/**
 * Time view (docs/TIME_VIEW.md) in the running app, on the fictional demo snapshot: the URL state,
 * the control, honest reporting of what is left out, and agreement between what the page says and
 * what the shared time module computes from the same snapshot.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { applyTimeFilter, timeExtent, type TimeFilter } from "../../src/domain/time";
import { openExplorer, snapshot } from "./helpers";

const readDrawn = async (page: Page) =>
  Number(
    (await page.locator("canvas[role=img]").getAttribute("aria-label"))!.match(
      /(\d+) relationships drawn/,
    )![1],
  );

/**
 * The count depends on the zoom band, and the first camera move after a page load can change it.
 * Read it only once two readings 400 ms apart agree (a flake under load otherwise).
 */
const drawn = async (page: Page) => {
  let last = await readDrawn(page);
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400);
    const now = await readDrawn(page);
    if (now === last) return now;
    last = now;
  }
  return last;
};

test("a year in the URL draws fewer relationships and says what it shows", async ({ page }) => {
  await openExplorer(page);
  const all = await drawn(page);
  await openExplorer(page, "?asof=2019");
  await expect(page.locator("canvas[role=img]")).toHaveAttribute(
    "aria-label",
    /time filter: relationships that began by the end of 2019/,
  );
  expect(await drawn(page)).toBeLessThan(all);
  await expect(page.getByRole("status").filter({ hasText: "Showing relationships" })).toContainText(
    "Cards, dossiers and the list show current facts.",
  );
});

test("the record count on screen matches the time model for the same snapshot", async ({
  page,
}) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  const cases: [string, "capital" | "contracts", TimeFilter][] = [
    ["?asof=2019", "capital", { mode: "began", year: 2019 }],
    ["?lens=contracts&asof=2024&tmode=active", "contracts", { mode: "active", year: 2024 }],
  ];
  for (const [query, lens, filter] of cases) {
    const l = snap.graph.lenses[lens];
    const { stats } = applyTimeFilter([...l.edges, ...l.bundles], filter);
    await openExplorer(page, query);
    const status = page.getByRole("status").filter({ hasText: "Showing relationships" });
    await expect(status).toContainText(`: ${stats!.shown} record`);
    if (stats!.noEnd) await expect(status).toContainText(`${stats!.noEnd} agreement`);
    if (stats!.undated) await expect(status).toContainText(`${stats!.undated} record`);
  }
});

test("the control writes the URL, follows the keyboard, and turns off cleanly", async ({
  page,
}) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  const l = snap.graph.lenses.capital;
  const extent = timeExtent([...l.edges, ...l.bundles], snap.meta.builtAt)!;

  const group = page.getByRole("group", { name: "Time view" });
  await group.getByRole("combobox").selectOption("began");
  await expect(page).toHaveURL(new RegExp(`asof=${extent.max}`));
  const atMax = await drawn(page);

  const year = group.getByRole("slider", { name: "Year" });
  await year.focus();
  await page.keyboard.press("Home");
  await expect(page).toHaveURL(new RegExp(`asof=${extent.min}`));
  await expect.poll(() => drawn(page)).toBeLessThan(atMax);

  await group.getByRole("combobox").selectOption("active");
  await expect(page).toHaveURL(/tmode=active/);

  await group.getByRole("combobox").selectOption("all");
  await expect(page).not.toHaveURL(/asof=|tmode=/);
  await expect(page.getByRole("slider", { name: "Year" })).toHaveCount(0);
});

test("a selection survives moving the year", async ({ page }) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  const company = snap.organizations.find(
    (o) => o.scope === "universe" && (o.financing?.roundsKnown ?? 0) > 1,
  )!;
  await openExplorer(page, `?sel=${company.id}&asof=2024`);
  const card = page.getByRole("complementary", { name: "Selection details" });
  await expect(card.getByRole("heading", { level: 2, name: company.name })).toBeVisible();
  const year = page.getByRole("slider", { name: "Year" });
  await year.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page).toHaveURL(/asof=2023/);
  await expect(page).toHaveURL(new RegExp(`sel=${company.id}`));
  await expect(card.getByRole("heading", { level: 2, name: company.name })).toBeVisible();
});

test("invalid or out-of-range years are handled without guessing", async ({ page }) => {
  await openExplorer(page, "?asof=abc");
  await expect(page.getByRole("slider", { name: "Year" })).toHaveCount(0);
  await openExplorer(page, "?asof=1990");
  const snap = await snapshot(page);
  const l = snap.graph.lenses.capital;
  const extent = timeExtent([...l.edges, ...l.bundles], snap.meta.builtAt)!;
  // A year before the first dated record is clamped to the first year, never extrapolated.
  await expect(page.getByRole("slider", { name: "Year" })).toHaveValue(String(extent.min));
});

test("the Industry lens has no time control (it draws no relationships)", async ({ page }) => {
  await openExplorer(page, "?lens=industry&asof=2019");
  await expect(page.getByRole("group", { name: "Time view" })).toHaveCount(0);
});

test("no serious accessibility violations with the time view on", async ({ page }) => {
  await openExplorer(page, "?lens=contracts&asof=2024&tmode=active");
  const results = await new AxeBuilder({ page }).exclude("canvas").analyze();
  const serious = results.violations.filter((v) => ["serious", "critical"].includes(v.impact!));
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([]);
});

test("a relationship panel under a time filter lists only that time's records", async ({
  page,
}) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  const filter: TimeFilter = { mode: "began", year: 2019 };
  const all = snap.graph.lenses.capital.edges;
  const { edges } = applyTimeFilter(all, filter);
  // A line with records on both sides of the year, so the filter visibly narrows it.
  const line = edges.find(
    (e) => e.recordIds.length < all.find((a) => a.id === e.id)!.recordIds.length,
  )!;
  expect(line, "a capital line with records before and after 2019").toBeTruthy();
  await openExplorer(page, `?asof=2019&rel=${encodeURIComponent(line.id)}`);
  const panel = page.getByRole("complementary", { name: "Selection details" });
  await expect(panel).toContainText("Showing relationships that began by the end of 2019 only.");
  await expect(panel.locator("ul li")).toHaveCount(line.recordIds.length);
  // Moving past every record's date reveals the rest of the line's records.
  await openExplorer(page, `?rel=${encodeURIComponent(line.id)}`);
  await expect(panel.locator("ul li")).toHaveCount(
    all.find((a) => a.id === line.id)!.recordIds.length,
  );
});
