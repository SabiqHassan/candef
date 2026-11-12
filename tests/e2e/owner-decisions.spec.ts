import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { foreignFixture } from "../../pipeline/compile/foreign.test-helpers";
import { compile } from "../../pipeline/compile/compile";
import { sealDemoCorpus } from "../../pipeline/compile/hash";

test("cited funding, foreign jurisdiction filtering and reciprocal corporate history", async ({
  page,
}, testInfo) => {
  const { corpus, companyId } = foreignFixture();
  for (const round of corpus.rounds) round.proceeds = "unknown";
  const predecessor = {
    id: "org_fictional_predecessor",
    name: "Fictional Aster Legacy Ltd.",
    slug: "fictional-aster-legacy",
    kind: "company" as const,
    isDemo: true,
    mergedInto: null,
  };
  corpus.organizations.push(predecessor);
  const base = corpus.assertions.find((a) => a.subjectId === companyId)!;
  corpus.assertions.push({
    ...base,
    id: "asr_fictional_predecessor",
    subjectId: predecessor.id,
    predicate: "predecessor_of",
    value: { orgId: companyId, event: "amalgamation", date: "2014" },
    verification: "verified",
    review: null,
  });
  const result = compile(sealDemoCorpus(corpus, "2026-10-16"), { today: "2026-10-16" });
  expect(result.failures).toEqual([]);
  const snap = result.snapshot!,
    company = snap.organizations.find((o) => o.id === companyId)!;
  await page.route("**/data/demo/manifest.json", (route) =>
    route.fulfill({
      json: {
        current: "snapshot.fictional-owner.json",
        schemaVersion: snap.meta.schemaVersion,
        isDemo: true,
        builtAt: "2026-10-16",
        previous: [],
      },
    }),
  );
  await page.route("**/data/demo/snapshot.fictional-owner.json", (route) =>
    route.fulfill({ json: snap }),
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/company/${company.slug}`);
  const financing = page.locator("#financing");
  await expect(financing.getByText("No total", { exact: true })).toBeVisible();
  await expect(
    financing
      .locator("p")
      .first()
      .getByRole("button", { name: /^Source:/ })
      .first(),
  ).toBeVisible();
  const government = page.locator("#government");
  await expect(government.getByText("Foreign government (US)", { exact: false })).toBeVisible();
  await government.getByLabel("Government counterparties").selectOption("canadian");
  await expect(page).toHaveURL(/government=canadian/);
  await expect(government.getByText("No agreements match this jurisdiction.")).toBeVisible();
  await page.reload();
  await expect(government.getByLabel("Government counterparties")).toHaveValue("canadian");
  await government.getByLabel("Government counterparties").selectOption("foreign");
  const jurisdictionChip = government
    .locator("tbody tr td")
    .filter({ hasText: "Foreign government (US)" })
    .getByRole("button", { name: /^Source:/ });
  await jurisdictionChip.first().click();
  await expect(
    page
      .getByRole("group", { name: "Citation: Fictional Foreign Agency" })
      .getByText("Fictional award notice", { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const history = page.locator("#corporate");
  await expect(history).toContainText(
    "Successor of Fictional Aster Legacy Ltd. (amalgamation, 2014)",
  );
  await expect(history.getByRole("button", { name: /^Source:/ }).first()).toBeVisible();
  await history.getByRole("link", { name: predecessor.name }).click();
  await expect(page.getByRole("heading", { level: 1, name: predecessor.name })).toBeVisible();
  await expect(page.locator("#corporate")).toContainText(
    `Predecessor of ${company.name} (amalgamation, 2014)`,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.locator("#corporate").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("corporate-history-desktop.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/company/${company.slug}?government=foreign`);
  await expect(government.getByLabel("Government counterparties")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await government.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("foreign-agreements-mobile.png"),
    fullPage: false,
  });
  expect(errors).toEqual([]);
});
