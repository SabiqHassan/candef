/** WCAG 2.5.8 target size (24 px minimum) on phone-sized screens, all routes. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { snapshot } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const routes = async (page: import("@playwright/test").Page) => {
  await page.goto("/?view=list");
  const snap = await snapshot(page);
  const company = snap.organizations.find((o) => o.scope === "universe")!;
  return [
    ["list", "/?view=list"],
    ["graph", "/?view=graph"],
    ["dossier", `/company/${company.slug}`],
    ["methodology", "/methodology"],
  ] as const;
};

test("interactive targets are at least 24 px on a phone", async ({ page }) => {
  const report: string[] = [];
  for (const [name, url] of await routes(page)) {
    await page.goto(url);
    await page.waitForTimeout(1200);
    const results = await new AxeBuilder({ page }).withRules(["target-size"]).analyze();
    for (const v of results.violations)
      for (const n of v.nodes)
        report.push(`${name}: ${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1] ?? ""}`);
  }
  console.log(report.join("\n"));
  expect(report).toEqual([]);
});

test("control: the rule does flag a tiny target, so a pass means something", async ({ page }) => {
  await page.goto("/methodology");
  await page.evaluate(() => {
    const b = document.createElement("button");
    b.textContent = "x";
    b.style.cssText = "position:fixed;top:100px;left:10px;width:10px;height:10px;padding:0;";
    const c = b.cloneNode(true) as HTMLButtonElement;
    c.style.left = "14px";
    document.body.append(b, c);
  });
  const results = await new AxeBuilder({ page }).withRules(["target-size"]).analyze();
  expect(results.violations.length).toBeGreaterThan(0);
});
