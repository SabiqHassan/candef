/**
 * Fixes from the first Antigravity UX review (docs/reports/ux-reviews/2026-10-13-gemini-3.8-flash-high.md):
 * #7 list view merges with the directory, #2 stacked list rows on phones, #14 dossier sub-nav
 * affordance, #21 shorter demo banner, #15 reduced motion in the 3D engine.
 */
import { expect, test } from "@playwright/test";
import { openExplorer, snapshot } from "./helpers";

test.describe("list view on a laptop (#7)", () => {
  test("the directory shrinks to the search and filters, and filters the table", async ({
    page,
  }) => {
    await openExplorer(page, "?view=list");
    await expect(page.getByRole("table")).toBeVisible();
    // The time filter only changes the drawn network, so it is not offered over the list.
    await expect(page.getByRole("group", { name: "Time view" })).toHaveCount(0);
    // No second, duplicate list of companies beside the table.
    await expect(page.getByRole("complementary", { name: "Company directory" })).toHaveCount(0);
    const rail = page.getByRole("complementary", { name: "List filters" });
    await expect(rail).toBeVisible();
    await expect(rail.locator("li")).toHaveCount(0);
    const rows = page.locator("table tbody tr");
    const before = await rows.count();
    await rail.getByRole("combobox", { name: "Province" }).selectOption({ index: 1 });
    await expect(rows).not.toHaveCount(before);
    await expect(rail.getByRole("status")).toContainText(/compan(y|ies) match/);
    // Back in the 3D view the full directory returns.
    await page.getByRole("button", { name: "Show 3D network" }).click();
    await expect(page.getByRole("complementary", { name: "Company directory" })).toBeVisible();
  });
});

test.describe("second review: list view on a laptop", () => {
  test("the table fits beside the filter rail and the view controls do not cover it", async ({
    page,
  }) => {
    await openExplorer(page, "?view=list");
    await expect(page.locator("table tbody tr").first()).toBeVisible();
    const m = await page.evaluate(() => {
      const box = document.querySelector("table")!.parentElement!;
      const controls = document.querySelector('[role="toolbar"]')!.getBoundingClientRect();
      return {
        overflow: box.scrollWidth - box.clientWidth,
        boxBottom: box.getBoundingClientRect().bottom,
        controlsTop: controls.top,
      };
    });
    expect(m.overflow).toBeLessThanOrEqual(0);
    expect(m.boxBottom).toBeLessThanOrEqual(m.controlsTop);
  });

  test("data states keep the text face inside numeric cells", async ({ page }) => {
    await openExplorer(page, "?view=list");
    const faces = await page.evaluate(() => {
      const state = document.querySelector("td.num [data-state]")!;
      const plain = document.querySelector("td:not(.num)")!;
      return [getComputedStyle(state).fontFamily, getComputedStyle(plain).fontFamily];
    });
    expect(faces[0]).toBe(faces[1]);
  });
});

test.describe("phones", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("list rows stack: every column stays visible, nothing scrolls sideways (#2)", async ({
    page,
  }) => {
    await openExplorer(page, "?view=list");
    const row = page.locator("table tbody tr").first();
    await expect(row).toBeVisible();
    await expect(page.getByRole("group", { name: "Time view" })).toHaveCount(0);
    const result = await row.evaluate((tr) => {
      const labels = [...tr.querySelectorAll("td")].map((td) => ({
        label: getComputedStyle(td, "::before").content.replace(/"/g, ""),
        right: td.getBoundingClientRect().right,
        visible: td.getBoundingClientRect().height > 0,
      }));
      const box = document.querySelector("table")!.parentElement!;
      return {
        labels,
        listOverflow: box.scrollWidth - box.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        headerRight: tr.querySelector("th")!.getBoundingClientRect().right,
      };
    });
    expect(result.labels.map((l) => l.label)).toEqual([
      "Sector",
      "Province",
      "Status",
      "Latest round",
      "Disclosed capital",
      "Procurement contracts",
    ]);
    for (const l of result.labels) {
      expect(l.visible).toBe(true);
      expect(l.right).toBeLessThanOrEqual(390);
    }
    expect(result.headerRight).toBeLessThanOrEqual(390);
    expect(result.listOverflow).toBeLessThanOrEqual(0);
    expect(result.pageOverflow).toBeLessThanOrEqual(0);
  });

  test("the filters are behind a labelled button, not a bare icon", async ({ page }) => {
    await openExplorer(page, "?view=list");
    const button = page.getByRole("button", { name: /Show company directory and filters/ });
    await expect(button).toContainText("Filters");
    await button.click();
    await expect(page.getByRole("combobox", { name: "Sector" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Province" })).toBeVisible();
  });

  test("dossier tables stack on a phone with a label on every cell", async ({ page }) => {
    await page.goto("/");
    const snap = await snapshot(page);
    const company = snap.organizations.find(
      (o) => o.scope === "universe" && o.financing?.roundsKnown && o.financing.totals.length,
    )!;
    await page.goto(`/company/${company.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: company.name })).toBeVisible();
    const m = await page.evaluate(() =>
      [...document.querySelectorAll("main table")].map((t) => {
        const cells = [...t.querySelectorAll("tbody td[data-label]")];
        return {
          headers: [...t.querySelectorAll("thead th")].map((th) => th.textContent!.trim()),
          overflow: t.scrollWidth - t.clientWidth,
          cellRight: Math.max(0, ...cells.map((c) => c.getBoundingClientRect().right)),
          labels: cells.map((c) => c.getAttribute("data-label")),
          unlabelled: [...t.querySelectorAll("tbody td")].filter(
            (c) => !c.hasAttribute("data-label") && !c.hasAttribute("colspan"),
          ).length,
        };
      }),
    );
    expect(m.length).toBeGreaterThan(1);
    for (const t of m) {
      expect(t.overflow).toBeLessThanOrEqual(0);
      expect(t.cellRight).toBeLessThanOrEqual(390);
      expect(t.unlabelled).toBe(0);
      // Every column header (except the row-name column) is a label somewhere in the table.
      for (const h of t.headers.slice(1)) expect(t.labels.includes(h)).toBe(true);
    }
  });

  test("the sort control replaces the hidden column headers", async ({ page }) => {
    await openExplorer(page, "?view=list");
    const table = page.getByRole("table");
    await page.getByLabel("Sort by").selectOption("province");
    await expect(table.getByRole("columnheader", { name: "Province" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await page.getByRole("button", { name: "Ascending order" }).click();
    await expect(table.getByRole("columnheader", { name: "Province" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  test("the dossier section links scroll sideways and show that more are hidden (#14)", async ({
    page,
  }) => {
    await page.goto("/");
    const snap = await snapshot(page);
    await page.goto(`/company/${snap.organizations.find((o) => o.scope === "universe")!.slug}`);
    const toc = page.getByRole("navigation", { name: "Dossier sections" });
    await expect(toc).toBeVisible();
    const m = await toc.evaluate((el) => ({
      scrollable: el.scrollWidth > el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
      background: getComputedStyle(el).backgroundImage,
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(m.scrollable).toBe(true);
    expect(m.overflowX).toBe("auto");
    expect(m.background).toContain("linear-gradient");
    expect(m.page).toBeLessThanOrEqual(0);
    // The last link can be reached.
    await toc.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    const last = toc.getByRole("link", { name: "Data quality" });
    const [box, tocBox] = [await last.boundingBox(), await toc.boundingBox()];
    expect(box!.x + box!.width).toBeLessThanOrEqual(tocBox!.x + tocBox!.width + 1);
    await last.click();
    await expect(page).toHaveURL(/#quality$/);
  });

  test("the demo banner shares the nav row and keeps its full sentence for screen readers (#21)", async ({
    page,
  }) => {
    await openExplorer(page);
    const note = page.getByRole("note");
    await expect(note).toBeVisible();
    await expect(note).toHaveAccessibleName(/Fictional demonstration data\. No company, person/);
    expect(await note.innerText()).toBe("Fictional data.");
    const topbar = await page.locator("header.topbar").boundingBox();
    expect(topbar!.height).toBeLessThanOrEqual(52);
  });
});

test("the banner keeps the longer sentence on a laptop (#21)", async ({ page }) => {
  await openExplorer(page);
  await expect(page.getByRole("note")).toContainText(
    "Fictional demonstration data. No company, person, amount or source here is real.",
  );
});

test.describe("reduced motion in the 3D engine (#15)", () => {
  /**
   * How long drawing continues after a zoom click. The camera tween is time-based (520 ms), so
   * this does not depend on how fast the machine renders: an animated move keeps drawing for the
   * whole tween, a jump draws once and goes idle.
   */
  async function drawingMsAfterZoom(page: import("@playwright/test").Page) {
    await openExplorer(page);
    // Wait until the scene is idle (the initial camera move is finished) before clicking.
    await expect
      .poll(
        () =>
          page.evaluate(
            () => performance.now() - (window as unknown as { __lastDraw: number }).__lastDraw,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(700);
    const clickedAt = await page.evaluate(() => performance.now());
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.waitForTimeout(1500);
    const last = await page.evaluate(
      () => (window as unknown as { __lastDraw: number }).__lastDraw,
    );
    return Math.max(0, last - clickedAt);
  }
  const trackDraws = () => {
    const w = window as unknown as { __lastDraw: number };
    w.__lastDraw = performance.now();
    for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype]) {
      for (const name of [
        "drawArrays",
        "drawElements",
        "drawArraysInstanced",
        "drawElementsInstanced",
      ]) {
        const original = (proto as unknown as Record<string, (...a: unknown[]) => void>)[name];
        if (!original) continue;
        (proto as unknown as Record<string, unknown>)[name] = function (...a: unknown[]) {
          w.__lastDraw = performance.now();
          return original.apply(this, a);
        };
      }
    }
  };

  test("a camera move is a single jump, not an animation", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(trackDraws);
    expect(await drawingMsAfterZoom(page)).toBeLessThan(400);
  });

  test("control: without the preference the same zoom animates for the whole tween", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.addInitScript(trackDraws);
    expect(await drawingMsAfterZoom(page)).toBeGreaterThan(480);
  });
});

test("a click a few pixels from a node still selects it (node snapping)", async ({ page }) => {
  await openExplorer(page);
  const snap = await snapshot(page);
  // The busiest investor: selecting it labels its portfolio companies.
  const portfolio = new Map<string, number>();
  for (const r of snap.rounds)
    if (r.verification === "verified")
      for (const p of r.participants)
        portfolio.set(p.investorId, (portfolio.get(p.investorId) ?? 0) + 1);
  const [investorId] = [...portfolio.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const investor = snap.organizations.find((o) => o.id === investorId)!;
  await page.goto(`/?dir=0&sel=${investorId}`);
  const panel = page.getByRole("complementary", { name: "Selection details" });
  await expect(panel.getByRole("heading", { level: 2, name: investor.name })).toBeVisible();
  await page.waitForTimeout(1500); // the framing move settles
  const companyNames = new Set(
    snap.organizations.filter((o) => o.scope === "universe").map((o) => o.name),
  );
  // Company labels sit 7 px right of the node's centre. The point 11 px left of that centre is
  // outside the label and outside a small node, but within the 12 px snap radius.
  const target = await page.locator(".explorer-label:visible").evaluateAll(
    (els, names) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { text: (el.textContent ?? "").trim(), cx: r.left - 7, cy: r.top + 10 };
        })
        .filter(
          (t) =>
            names.includes(t.text) &&
            t.cx > 460 &&
            t.cx < window.innerWidth - 480 &&
            t.cy > 150 &&
            t.cy < window.innerHeight - 100,
        )[0],
    [...companyNames],
  );
  expect(target, "a labelled company inside the open canvas").toBeTruthy();
  await page.mouse.click(target!.cx - 11, target!.cy);
  // A miss would clear the selection or open a relationship panel (the click lands near lines);
  // a snap selects a company, whose card heading is that company's name.
  await expect(async () => {
    const heading = await panel
      .getByRole("heading", { level: 2 })
      .first()
      .textContent({ timeout: 500 });
    expect(companyNames.has((heading ?? "").trim())).toBe(true);
  }).toPass({ timeout: 5000 });
});

test("a pinned citation card has a visible close button that returns focus to its chip", async ({
  page,
}) => {
  await page.goto("/");
  const snap = await snapshot(page);
  const company = snap.organizations.find(
    (o) => o.scope === "universe" && (o.financing?.roundsKnown ?? 0) >= 1,
  )!;
  await page.goto(`/company/${company.slug}`);
  const chip = page.locator("#financing [data-source-chip]").first();
  await chip.scrollIntoViewIfNeeded();
  const card = page.locator("[data-citation-card]");
  // A hover preview is dismissed by moving away, so it needs no close button.
  await chip.hover();
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Close citation" })).toHaveCount(0);
  await chip.click();
  const close = card.getByRole("button", { name: "Close citation" });
  await expect(close).toBeVisible();
  const box = await close.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(24);
  expect(box!.height).toBeGreaterThanOrEqual(24);
  await close.click();
  await expect(card).toBeHidden();
  await expect(chip).toBeFocused();
});

test("active filters show as chips that remove one filter at a time", async ({ page }) => {
  await openExplorer(page);
  const dir = page.getByRole("complementary", { name: "Company directory" });
  await expect(dir.getByRole("list", { name: "Active filters" })).toHaveCount(0);
  const province = dir.getByRole("combobox", { name: "Province" });
  const sector = dir.getByRole("combobox", { name: "Sector" });
  await province.selectOption({ index: 1 });
  await sector.selectOption({ index: 1 });
  const provinceLabel = await province.evaluate(
    (el: HTMLSelectElement) => el.options[el.selectedIndex]!.text,
  );
  const chips = dir.getByRole("list", { name: "Active filters" });
  await expect(chips.getByRole("listitem")).toHaveCount(2);
  await dir.getByRole("button", { name: `Remove filter: ${provinceLabel}` }).click();
  await expect(chips.getByRole("listitem")).toHaveCount(1);
  await expect(province).toHaveValue("");
  await expect(sector).not.toHaveValue("");
  await expect(page).not.toHaveURL(/province=/);
  // The search term is a chip too, and removing it clears the box.
  const box = dir.getByRole("searchbox", { name: "Search companies and institutions" });
  await box.fill("zzz-no-match");
  await expect(
    dir.getByRole("button", { name: "Remove filter: Search: zzz-no-match" }),
  ).toBeVisible();
  await dir.getByRole("button", { name: "Remove filter: Search: zzz-no-match" }).click();
  await expect(box).toHaveValue("");
});
