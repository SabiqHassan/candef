/**
 * M2 acceptance: every data state a company can be in renders with its own, explicit label on the
 * dossier. Subjects are chosen from the snapshot by property, never by name.
 */
import { expect, test, type Page } from "@playwright/test";
import type { OrgView, Snapshot } from "../../src/domain/schema/snapshot";
import { snapshot } from "./helpers";

let snap: Snapshot;
const universe = () => snap.organizations.filter((o) => o.scope === "universe");
const pick = (label: string, ok: (o: OrgView) => boolean): OrgView => {
  const o = universe().find(ok);
  if (!o) throw new Error(`demo data has no ${label} company`);
  return o;
};
const dossier = async (page: Page, o: OrgView) => {
  await page.goto(`/company/${o.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: o.name })).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await page.goto("/methodology");
  snap ??= await snapshot(page);
});

test.describe("data states on the dossier", () => {
  test("zero-round company: researched, nothing found (not 'undisclosed')", async ({ page }) => {
    const o = pick(
      "zero-round",
      (c) => c.research.financing?.state === "researched" && !c.financing?.roundsKnown,
    );
    await dossier(page, o);
    const fin = page.locator("#financing");
    await expect(fin.getByText("Not found in reviewed sources")).toBeVisible();
    await expect(fin.getByText("Undisclosed")).toHaveCount(0);
  });

  test("undisclosed round: shown as 'Undisclosed', never as a number", async ({ page }) => {
    const roundCo = new Set(
      snap.rounds
        .filter((r) => r.verification === "verified" && r.resolved.status === "undisclosed")
        .map((r) => r.companyId),
    );
    const o = pick("undisclosed-round", (c) => roundCo.has(c.id));
    await dossier(page, o);
    await expect(page.locator("#financing tbody").getByText("Undisclosed").first()).toBeVisible();
  });

  test("disputed field: both values shown with 'Sources disagree'", async ({ page }) => {
    const o = pick("disputed-HQ", (c) => c.hq.state === "disputed");
    await dossier(page, o);
    await expect(page.getByText("Sources disagree").first()).toBeVisible();
    for (const alt of o.hq.alternatives ?? []) {
      const city = (alt.value as { city: string | null }).city;
      if (city) await expect(page.getByText(city, { exact: false }).first()).toBeVisible();
    }
  });

  test("not-researched topic: 'Not yet researched', not 'not found'", async ({ page }) => {
    const o = pick("not-researched", (c) => c.research.financing?.state === "not_researched");
    await dossier(page, o);
    const fin = page.locator("#financing");
    await expect(fin.getByText("Not yet researched")).toBeVisible();
    await expect(fin.getByText("Not found in reviewed sources")).toHaveCount(0);
  });

  test("stale research: flagged 'Due for review' in data quality", async ({ page }) => {
    const o = pick("stale-research", (c) =>
      Object.values(c.research).some((r) => r?.state === "stale"),
    );
    await dossier(page, o);
    await expect(page.getByText("Due for review").first()).toBeVisible();
  });

  test("consortium contract: member share is not attributed", async ({ page }) => {
    const consortium = snap.agreements.find((g) =>
      g.attributions.some((a) => a.basis === "consortium_undisclosed"),
    );
    test.skip(!consortium, "demo data has no consortium agreement");
    const memberId = consortium!.attributions.find(
      (a) => a.basis === "consortium_undisclosed",
    )!.orgId;
    const o = snap.organizations.find((c) => c.id === memberId)!;
    await dossier(page, o);
    await expect(page.getByText("Share undisclosed (consortium)").first()).toBeVisible();
  });

  test("superseded value: current shown, earlier approved value kept as history", async ({
    page,
  }) => {
    const o = pick("renamed", (c) => (c.legalName.history?.length ?? 0) > 0);
    await dossier(page, o);
    const prev = o.legalName.history![0]!.value as string;
    const row = page.locator('[data-state="superseded"]').first();
    await expect(row).toContainText(`Previously ${prev}`);
    await expect(row.locator("[data-source-chip]").first()).toBeVisible();
    await expect(page.getByText(o.legalName.value as string, { exact: true })).toBeVisible();
  });

  test("subsidiary: parent named and labelled", async ({ page }) => {
    const o = pick("subsidiary", (c) => c.ownership.status === "subsidiary");
    await dossier(page, o);
    await expect(page.getByText(/Subsidiary of /).first()).toBeVisible();
  });
});

test("coverage page lists open data-quality flags with plain labels", async ({ page }) => {
  await page.goto("/methodology");
  const flags = page.getByTestId("quality-flags");
  await expect(flags).toContainText("research topics past their review date");
  await expect(flags).not.toContainText("stale-research"); // never the internal check name
});

test("coverage page shows the corrections contact and policy (P-33)", async ({ page }) => {
  await page.goto("/methodology");
  const section = page.getByRole("region", { name: "Corrections and takedowns" });
  await expect(section).toContainText("five business days");
  await expect(section.getByRole("link", { name: "sabiqhassan1234@gmail.com" })).toHaveAttribute(
    "href",
    "mailto:sabiqhassan1234@gmail.com",
  );
});
