/**
 * Reproducible analyst task tests (D-19). Each test scripts a task a VC analyst should be able to
 * complete, checks the answer against the snapshot (ground truth), and records time and the number
 * of user actions. The same task list is used with external human testers in M1/M2.
 */
import { expect, test } from "@playwright/test";
import { escape, openExplorer, snapshot } from "./helpers";

test.describe("analyst tasks", () => {
  test("T1: find a named company and see its headquarters (≤ 3 actions, < 30 s)", async ({
    page,
  }) => {
    await openExplorer(page);
    const snap = await snapshot(page);
    const target = snap.organizations.filter(
      (o) => o.scope === "universe" && o.hq.state === "verified",
    )[17]!;
    const start = Date.now();
    let actions = 0;
    await page
      .getByRole("searchbox", { name: "Search companies and institutions" })
      .fill(target.name.split(" ")[0]!);
    actions++;
    await page
      .getByRole("complementary", { name: "Company directory" })
      .getByRole("button", { name: new RegExp(`^${escape(target.name)}`) })
      .first()
      .click();
    actions++;
    const card = page.getByRole("complementary", { name: "Selection details" });
    await expect(
      card.getByText(target.hq.value!.province!, { exact: false }).first(),
    ).toBeVisible();
    expect(actions).toBeLessThanOrEqual(3);
    expect(Date.now() - start).toBeLessThan(30_000);
  });

  test("T2: state two investors' shared portfolio companies", async ({ page }) => {
    await openExplorer(page);
    const snap = await snapshot(page);
    const portfolio = new Map<string, Set<string>>();
    for (const r of snap.rounds)
      if (r.verification === "verified")
        for (const p of r.participants)
          portfolio.set(
            p.investorId,
            new Set([...(portfolio.get(p.investorId) ?? []), r.companyId]),
          );
    const [aId, aSet] = [...portfolio.entries()].sort((x, y) => y[1].size - x[1].size)[0]!;
    const [bId, shared] = [...portfolio.entries()]
      .filter(([id]) => id !== aId)
      .map(([id, set]) => [id, [...set].filter((c) => aSet.has(c))] as const)
      .sort((x, y) => y[1].length - x[1].length)[0]!;
    const name = (id: string) => snap.organizations.find((o) => o.id === id)!.name;
    await page.getByRole("tab", { name: /^Investors/ }).click();
    await page
      .getByRole("complementary", { name: "Company directory" })
      .getByRole("button", { name: new RegExp(`^${escape(name(aId))}`) })
      .click();
    const panel = page.getByRole("complementary", { name: "Selection details" });
    await panel.getByRole("button", { name: name(bId), exact: true }).click();
    const overlap = panel.locator("div", { hasText: `Shared with ${name(bId)}:` }).last();
    for (const id of shared)
      await expect(overlap.getByRole("button", { name: name(id), exact: true })).toBeVisible();
  });

  test("T3: explain what a company's position in the network means", async ({ page }) => {
    await openExplorer(page);
    await expect(page.getByText("Position reflects technology classification only.")).toBeVisible();
    await page.getByRole("link", { name: "Coverage and method" }).click();
    await expect(page.getByText(/placed by primary technology classification/)).toBeVisible();
  });

  test("T4: reconstruct a financing chronology and tell sourced from undisclosed", async ({
    page,
  }) => {
    await page.goto("/");
    const snap = await snapshot(page);
    const company = snap.organizations.find(
      (o) =>
        o.scope === "universe" &&
        snap.rounds.filter((r) => r.companyId === o.id && r.verification === "verified").length >=
          3 &&
        snap.rounds.some((r) => r.companyId === o.id && r.resolved.status === "undisclosed"),
    )!;
    await page.goto(`/company/${company.slug}`);
    const section = page.locator("#financing");
    const rows = section.locator("tbody tr");
    const verified = snap.rounds.filter((r) => r.companyId === company.id).length;
    await expect(rows).toHaveCount(verified);
    await expect(section.getByText("Undisclosed").first()).toBeVisible();
    await expect(section.getByRole("button", { name: /^Source:/ }).first()).toBeVisible();
    // Chronology: verified rounds appear newest first, matching the snapshot's dates.
    const expected = snap.rounds
      .filter((r) => r.companyId === company.id && r.verification === "verified")
      .sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? 1 : -1))
      .map((r) => r.label!);
    const shown = (await section.locator("tbody tr th").allTextContents()).map((t) =>
      t.replace(" (announced)", "").trim(),
    );
    expect(shown).toEqual(expected);
  });
});
