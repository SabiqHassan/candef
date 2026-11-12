import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { escape, openExplorer, searchAndSelect, snapshot } from "./helpers";

test.describe("explorer", () => {
  test("opens on the 3D universe with honest labelling", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openExplorer(page);
    await expect(page.getByRole("note")).toContainText("Fictional demonstration data");
    const canvas = page.locator("canvas[role=img]");
    await expect(canvas).toBeVisible();
    await expect(canvas).toHaveAttribute("aria-label", /Capital view: \d+ companies/);
    await expect(page.getByText("Position reflects technology classification only.")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("lens switching updates the URL and the drawn relationships", async ({ page }) => {
    await openExplorer(page);
    await page.getByRole("tab", { name: "Government" }).click();
    await expect(page).toHaveURL(/lens=contracts/);
    const canvas = page.locator("canvas[role=img]");
    const withGrants = Number(
      (await canvas.getAttribute("aria-label"))!.match(/(\d+) relationships drawn/)![1],
    );
    // click + retrying assertion, not .uncheck(): the box is controlled by the URL, so on a slow
    // runner the router can commit after Playwright's one-shot "did the state change" check
    const grantsBox = page.getByLabel("Show grants and contributions");
    await grantsBox.click();
    await expect(grantsBox).not.toBeChecked();
    await expect(page).toHaveURL(/grants=0/);
    await expect
      .poll(async () =>
        Number((await canvas.getAttribute("aria-label"))!.match(/(\d+) relationships drawn/)![1]),
      )
      .toBeLessThan(withGrants);
    await page.getByRole("tab", { name: "Industry" }).click();
    await expect(canvas).toHaveAttribute("aria-label", /Grouped by technology classification/);
  });

  test("company card shows provenance and opens the dossier", async ({ page }) => {
    await openExplorer(page);
    const snap = await snapshot(page);
    const company = snap.organizations.find(
      (o) =>
        o.scope === "universe" && o.hq.state === "verified" && (o.financing?.roundsKnown ?? 0) > 1,
    )!;
    await searchAndSelect(page, company.name);
    const card = page.getByRole("complementary", { name: "Selection details" });
    await expect(card.getByText("Fictional", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: /^Source:/ }).first()).toBeVisible();
    await expect(card.getByText(/\d+ of \d+ verified rounds state an amount/)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`sel=${company.id}`));
    await card.getByRole("link", { name: "Open dossier" }).click();
    await expect(page).toHaveURL(new RegExp(`/company/${company.slug}`));
    await expect(page.getByRole("heading", { level: 1, name: company.name })).toBeVisible();
    for (const h of [
      "Financing history",
      "Government relationships",
      "Ownership and corporate events",
      "Sources",
      "Research coverage and data quality",
    ]) {
      await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
    }
    await page.getByRole("link", { name: "Back to the explorer" }).click();
    await expect(page.getByRole("heading", { level: 2, name: company.name })).toBeVisible();
  });

  test("investor selection shows portfolio, co-investors and overlap", async ({ page }) => {
    await openExplorer(page);
    const snap = await snapshot(page);
    const counts = new Map<string, Set<string>>();
    for (const r of snap.rounds)
      if (r.verification === "verified")
        for (const p of r.participants)
          counts.set(p.investorId, new Set([...(counts.get(p.investorId) ?? []), r.companyId]));
    const [investorId, portfolio] = [...counts.entries()].sort((a, b) => b[1].size - a[1].size)[0]!;
    const investor = snap.organizations.find((o) => o.id === investorId)!;
    await page.getByRole("tab", { name: /^Investors/ }).click();
    await page
      .getByRole("complementary", { name: "Company directory" })
      .getByRole("button", { name: new RegExp(`^${escape(investor.name)}`) })
      .click();
    const panel = page.getByRole("complementary", { name: "Selection details" });
    await expect(panel.getByRole("heading", { name: investor.name })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Documented portfolio" })).toBeVisible();
    await expect(panel.getByText(String(portfolio.size), { exact: true })).toBeVisible();
    await panel.getByRole("heading", { name: "Co-investors" }).scrollIntoViewIfNeeded();
    await panel.locator("section", { hasText: "Co-investors" }).getByRole("button").first().click();
    await expect(panel.getByText(/^Shared with /)).toBeVisible();
  });

  test("unverified rounds are withheld and consortium shares are not attributed", async ({
    page,
  }) => {
    await openExplorer(page);
    const snap = await snapshot(page);
    const withUnverified = snap.organizations.find((o) =>
      snap.rounds.some((r) => r.companyId === o.id && r.verification !== "verified"),
    )!;
    await page.goto(`/company/${withUnverified.slug}`);
    await expect(
      page
        .getByText("A round was reported but has not been verified; its details are withheld.")
        .first(),
    ).toBeVisible();
    const consortium = snap.agreements.find((g) =>
      g.attributions.some((a) => a.basis === "consortium_undisclosed"),
    )!;
    const member = snap.organizations.find(
      (o) =>
        o.id === consortium.attributions.find((a) => a.basis === "consortium_undisclosed")!.orgId,
    )!;
    await page.goto(`/company/${member.slug}`);
    await expect(page.getByText("Share undisclosed (consortium)").first()).toBeVisible();
  });

  test("list mode is a complete alternative and sorts", async ({ page }) => {
    await openExplorer(page);
    await page.getByRole("button", { name: "Show as list" }).click();
    await expect(page).toHaveURL(/view=list/);
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).not.toHaveCount(1);
    await table.getByRole("button", { name: "Sector" }).click();
    await expect(table.getByRole("columnheader", { name: "Sector" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await table.getByRole("rowheader").first().getByRole("button").click();
    await expect(page.getByRole("complementary", { name: "Selection details" })).toBeVisible();
  });

  test("list mode never shows 'Undisclosed' for unresearched or empty financing", async ({
    page,
  }) => {
    await openExplorer(page);
    const snap = await snapshot(page);
    const universe = snap.organizations.filter((o) => o.scope === "universe");
    const unresearched = universe.find((o) => o.research.financing?.state === "not_researched")!;
    const noneFound = universe.find(
      (o) => o.research.financing?.state !== "not_researched" && !o.financing?.roundsKnown,
    );
    const rowFor = async (name: string) => {
      await page.goto(`/?view=list&q=${encodeURIComponent(name)}`);
      return page.getByRole("row").filter({ has: page.getByRole("rowheader", { name }) });
    };
    const a = await rowFor(unresearched.name);
    await expect(a.getByRole("cell", { name: "Not yet researched" })).toHaveCount(2);
    await expect(a.getByRole("cell", { name: "Undisclosed" })).toHaveCount(0);
    if (noneFound) {
      const b = await rowFor(noneFound.name);
      await expect(b.getByRole("cell", { name: "None found" })).toHaveCount(2);
    }
    await expect(page.getByRole("cell", { name: /^\$/ })).toHaveCount(0); // CAD is always "CA$"
  });

  test("Industry lens labels subsector clusters only once zoomed in", async ({ page }) => {
    await openExplorer(page, "?lens=industry");
    const snap = await snapshot(page);
    const subLabels = new Set((snap.graph.subAnchors ?? []).map((a) => a.label));
    expect(subLabels.size).toBeGreaterThan(0);
    const shownSubLabels = async () =>
      (await page.locator(".explorer-label:visible").allTextContents()).filter((t) =>
        subLabels.has(t),
      );
    await page.waitForTimeout(800);
    expect(await shownSubLabels()).toEqual([]);
    // Zoom in step by step (each is a 520 ms transition) until the view reaches Region zoom; under
    // CPU load a fixed number of steps is not reliable.
    let shown: string[] = [];
    for (let i = 0; i < 10 && shown.length === 0; i++) {
      await page.getByRole("button", { name: "Zoom in" }).click();
      await page.waitForTimeout(700);
      shown = await shownSubLabels();
    }
    expect(shown.length).toBeGreaterThan(0);
  });

  test("company directory is virtualized but every company stays reachable", async ({ page }) => {
    await openExplorer(page);
    const snap = await snapshot(page);
    const count = snap.organizations.filter((o) => o.scope === "universe").length;
    const dir = page.getByRole("complementary", { name: "Company directory" });
    const rows = dir.locator("li[aria-posinset]");
    await expect(rows.first()).toHaveAttribute("aria-setsize", String(count));
    expect(await rows.count()).toBeLessThan(60);
    await dir.getByRole("list").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(dir.locator(`li[aria-posinset="${count}"]`)).toBeVisible();
    expect(await rows.count()).toBeLessThan(60);
  });

  test("falls back to the 2D map when WebGL is unavailable", async ({ page }) => {
    await page.addInitScript(() => {
      // Simulate a device without WebGL: any WebGL context request fails.
      const original = HTMLCanvasElement.prototype.getContext as (
        this: HTMLCanvasElement,
        ...a: unknown[]
      ) => unknown;
      (
        HTMLCanvasElement.prototype as unknown as { getContext: (...a: unknown[]) => unknown }
      ).getContext = function (this: HTMLCanvasElement, type: unknown, ...rest: unknown[]) {
        if (type === "webgl2" || type === "webgl") return null;
        return original.call(this, type, ...rest);
      };
    });
    await page.goto("/");
    await expect(
      page.getByRole("status").filter({ hasText: "3D rendering is not available" }),
    ).toBeVisible();
    await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
    await expect(page.getByRole("button", { name: "3D", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Show as list" }).click();
    await expect(page.getByRole("table")).toBeVisible();
  });

  test("keyboard-only: search, select, open dossier", async ({ page }) => {
    await openExplorer(page);
    const snap = await snapshot(page);
    const company = snap.organizations.find((o) => o.scope === "universe")!;
    await page.getByRole("searchbox", { name: "Search companies and institutions" }).focus();
    await page.keyboard.type(company.name);
    const row = page
      .getByRole("complementary", { name: "Company directory" })
      .getByRole("button", { name: new RegExp(`^${escape(company.name)}`) })
      .first();
    await row.focus();
    await page.keyboard.press("Enter");
    const dossier = page.getByRole("link", { name: "Open dossier" });
    await dossier.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: company.name })).toBeVisible();
  });

  test("fast typing in search never drops characters (regression)", async ({ page }) => {
    await openExplorer(page);
    const box = page.getByRole("searchbox", { name: "Search companies and institutions" });
    await box.focus();
    const text = "Ostovao Security Analytics";
    await page.keyboard.type(text, { delay: 0 });
    await expect(box).toHaveValue(text);
    await expect(page).toHaveURL(/q=Ostovao/);
  });

  test("selecting during the search debounce keeps the selection (regression)", async ({
    page,
  }) => {
    await openExplorer(page);
    // Type and click in one synchronous step, so the click always lands inside the 160 ms
    // debounce before the URL search update fires.
    const name = await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="Company directory"] ul button',
      )!;
      const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
      const first = button.textContent!.split(" ")[0]!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, first);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      button.click();
      return first;
    });
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(new RegExp(`q=${name}`));
    await expect(page).toHaveURL(/sel=/);
    await expect(page.getByRole("complementary", { name: "Selection details" })).toBeVisible();
  });

  test("deep link to a selection restores the card", async ({ page }) => {
    await page.goto("/");
    const snap = await snapshot(page);
    const company = snap.organizations.find((o) => o.scope === "universe")!;
    await page.goto(`/?lens=industry&sel=${company.id}`);
    await expect(page.getByRole("heading", { level: 2, name: company.name })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Industry" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  for (const path of ["/", "/methodology"]) {
    test(`no serious accessibility violations on ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const results = await new AxeBuilder({ page }).exclude("canvas").analyze();
      const serious = results.violations.filter(
        (v) => v.impact === "serious" || v.impact === "critical",
      );
      expect(serious.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }

  test("no serious accessibility violations on a dossier", async ({ page }) => {
    await page.goto("/");
    const snap = await snapshot(page);
    await page.goto(`/company/${snap.organizations.find((o) => o.scope === "universe")!.slug}`);
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    );
    expect(serious.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});

test.describe("narrow screens", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("open the 2D map, and the list is one tap away", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
    await page.getByRole("button", { name: "Show as list" }).click();
    await expect(page.getByRole("table")).toBeVisible();
    await page.getByRole("button", { name: "Show 2D network" }).click();
    await expect(page).toHaveURL(/view=graph/);
    await expect(page.getByTestId("graph-host-2d").locator("canvas")).toBeVisible();
  });
});

test("back from a dossier keeps the explorer lens and filters", async ({ page }) => {
  await page.goto("/");
  const snap = await snapshot(page);
  const company = snap.organizations.find((o) => o.scope === "universe")!;
  await page.goto(`/?lens=contracts&sel=${company.id}`);
  await page.getByRole("link", { name: "Open dossier" }).click();
  await expect(page).toHaveURL(new RegExp(`/company/${company.slug}`));
  await page.getByRole("link", { name: "Back to the explorer" }).click();
  await expect(page).toHaveURL(/lens=contracts/);
});
