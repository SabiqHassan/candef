/**
 * M2 acceptance: automated DOM audit. Every displayed fact carries a source chip or an explicit
 * data-state label. Summaries computed from listed records declare themselves with `data-derived`.
 *
 * Audited surfaces: fact lists (`[data-facts] dd`) on the card and dossier, every record row in the
 * dossier's financing and government tables, the list view, the institution panel and the
 * directory. A second audit fails any money amount that is not inside a claim element (one that
 * holds a source chip, a data-state label or a `data-derived` declaration). Runs over a sample that
 * covers each company state.
 *
 * The relationship panel is reached through its deep link (`rel=`), the same state a click on a
 * line in the 3D view writes.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { OrgView, Snapshot } from "../../src/domain/schema/snapshot";
import { snapshot } from "./helpers";

const EVIDENCE = "[data-source-chip], [data-state]";

async function unlabelled(rows: Locator): Promise<string[]> {
  return rows.evaluateAll(
    (els, sel) =>
      els
        .filter((el) => !el.hasAttribute("data-derived") && !el.querySelector(sel))
        .map((el) => {
          const term =
            el.previousElementSibling?.tagName === "DT" ? el.previousElementSibling : null;
          return `${term?.textContent ?? el.tagName}: ${(el.textContent ?? "").trim().slice(0, 80)}`;
        }),
    EVIDENCE,
  );
}

function sample(snap: Snapshot): OrgView[] {
  const u = snap.organizations.filter((o) => o.scope === "universe");
  const pickers: ((o: OrgView) => boolean)[] = [
    (o) => o.ownership.status === "subsidiary",
    (o) => o.hq.state === "disputed",
    (o) => o.marketStatus === "public",
    (o) => o.operating === "acquired",
    (o) => o.research.financing?.state === "not_researched",
    (o) => o.research.agreements?.state === "not_researched",
    (o) => (o.financing?.roundsKnown ?? 0) >= 3,
    (o) => o.founded.state !== "verified",
    (o) => o.legalName.state !== "verified",
  ];
  const chosen = new Map<string, OrgView>();
  for (const p of pickers) {
    const o = u.find((c) => p(c) && !chosen.has(c.id));
    if (o) chosen.set(o.id, o);
  }
  for (const o of u.slice(0, 6)) chosen.set(o.id, o);
  return [...chosen.values()];
}

async function auditDossier(page: Page, o: OrgView): Promise<string[]> {
  await page.goto(`/company/${o.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: o.name })).toBeVisible();
  return [
    ...(await unlabelled(page.locator("[data-facts] dd"))),
    ...(await unlabelled(page.locator("#financing tbody tr"))),
    ...(await unlabelled(page.locator("#government tbody tr"))),
  ].map((m) => `${o.name} dossier · ${m}`);
}

async function auditCard(page: Page, o: OrgView): Promise<string[]> {
  await page.goto(`/?sel=${o.id}`);
  const card = page.getByRole("complementary", { name: "Selection details" });
  await expect(card.getByRole("heading", { level: 2, name: o.name })).toBeVisible();
  return (await unlabelled(card.locator("[data-facts] dd"))).map((m) => `${o.name} card · ${m}`);
}

test("every displayed fact has a source chip or a data-state label", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/methodology");
  const snap = await snapshot(page);
  const companies = sample(snap);
  expect(companies.length).toBeGreaterThanOrEqual(10);
  const problems: string[] = [];
  for (const o of companies) {
    problems.push(...(await auditDossier(page, o)));
    problems.push(...(await auditCard(page, o)));
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

/** Money amounts (CA$…, US$…, $…) must sit inside an element that carries its own evidence. */
async function moneyOutsideClaims(scope: Locator, where: string): Promise<string[]> {
  const found = await scope.evaluate((root, evidence) => {
    const money = /(?:CA|US)?\$\s?\d/;
    const bad: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!money.test(n.textContent ?? "")) continue;
      const el = n.parentElement;
      if (!el || el.closest("[data-derived]")) continue;
      const claim = el.closest("tr, li, dd, p");
      if (claim && claim.querySelector(evidence)) continue;
      bad.push((claim?.textContent ?? n.textContent ?? "").trim().slice(0, 80));
    }
    return bad;
  }, EVIDENCE);
  return found.map((m) => `${where} · money outside a claim: ${m}`);
}

test("list view cells carry a source chip, a declaration or an explicit state", async ({
  page,
}) => {
  await page.goto("/?view=list");
  const rows = page.locator("table tbody tr");
  await expect(rows.first()).toBeVisible();
  const problems = await rows.evaluateAll(
    (trs, args) =>
      trs.flatMap((tr) =>
        [...tr.querySelectorAll("td")]
          .filter((td) => {
            const text = (td.textContent ?? "").trim();
            return text && !td.hasAttribute("data-derived") && !td.querySelector(args.evidence);
          })
          .map(
            (td) =>
              `${tr.querySelector("th")?.textContent}: ${(td.textContent ?? "").trim().slice(0, 60)}`,
          ),
      ),
    { evidence: EVIDENCE },
  );
  expect(problems, problems.join("\n")).toEqual([]);
  expect(await moneyOutsideClaims(page.locator("table"), "list view")).toEqual([]);
});

test("no money amount sits outside a cited claim on any surface", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/methodology");
  const snap = await snapshot(page);
  const problems: string[] = [];
  for (const o of sample(snap)) {
    await page.goto(`/company/${o.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: o.name })).toBeVisible();
    problems.push(...(await moneyOutsideClaims(page.locator("main"), `${o.name} dossier`)));
    await page.goto(`/?sel=${o.id}`);
    const card = page.getByRole("complementary", { name: "Selection details" });
    await expect(card.getByRole("heading", { level: 2, name: o.name })).toBeVisible();
    problems.push(...(await moneyOutsideClaims(card, `${o.name} card`)));
  }
  const institutions = snap.organizations.filter((o) => o.scope === "contextual").slice(0, 6);
  for (const inst of institutions)
    for (const lens of ["capital", "contracts"]) {
      await page.goto(`/?lens=${lens}&sel=${inst.id}`);
      const panel = page.getByRole("complementary", { name: "Selection details" });
      if (!(await panel.isVisible())) continue;
      problems.push(...(await moneyOutsideClaims(panel, `${inst.name} (${lens})`)));
    }
  expect(problems, problems.join("\n")).toEqual([]);
});

test("the citation card shows the locator and opens below the chip", async ({ page }) => {
  await page.goto("/methodology");
  const snap = await snapshot(page);
  const o = sample(snap).find((c) => (c.financing?.roundsKnown ?? 0) >= 1)!;
  await page.goto(`/company/${o.slug}`);
  const chip = page.locator("#financing [data-source-chip]").first();
  await chip.scrollIntoViewIfNeeded();
  await chip.focus();
  await chip.click();
  const card = page.locator("[data-citation-card]");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Where in the source");
  expect(await card.locator("code").count()).toBeGreaterThan(0);
  const [c, k] = await Promise.all([chip.boundingBox(), card.boundingBox()]);
  if (k!.y < c!.y) {
    // allowed only when there is no room below
    const room = await page.evaluate((bottom) => window.innerHeight - bottom, c!.y + c!.height);
    expect(room).toBeLessThan(k!.height + 12);
  }
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
});

test("relationship panels cite every record and keep money inside claims", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/methodology");
  const snap = await snapshot(page);
  const { capital, contracts } = snap.graph.lenses;
  const picks: [string, string | undefined][] = [
    ["capital", capital.edges.find((e) => e.recordIds.length > 1)?.id],
    ["contracts", contracts.edges.find((e) => e.kind === "procurement")?.id],
    ["contracts", contracts.edges.find((e) => e.kind === "grant")?.id],
    ["capital", capital.bundles[0]?.id],
    ["contracts", contracts.bundles[0]?.id],
  ];
  const problems: string[] = [];
  for (const [lens, id] of picks) {
    expect(id, `a ${lens} line to audit`).toBeTruthy();
    await page.goto(`/?lens=${lens}&rel=${encodeURIComponent(id!)}`);
    const panel = page.getByRole("complementary", { name: "Selection details" });
    await expect(panel.getByRole("heading", { level: 2 })).toBeVisible();
    const rows = panel.locator("ul li");
    const line = [...capital.edges, ...contracts.edges].find((e) => e.id === id);
    // Single lines list one row per record; bundles summarize and list none.
    if (line) await expect(rows).toHaveCount(line.recordIds.length);
    const uncited = await rows.evaluateAll(
      (lis, sel) =>
        lis.filter((li) => !li.querySelector(sel)).map((li) => (li.textContent ?? "").slice(0, 80)),
      EVIDENCE,
    );
    problems.push(...uncited.map((t) => `${id} · record without a citation: ${t}`));
    problems.push(...(await moneyOutsideClaims(panel, `${id} panel`)));
  }
  expect(problems, problems.join("\n")).toEqual([]);
});
