/**
 * Failure modes a real deployment will meet: a dataset that cannot be loaded, a snapshot with a
 * record the UI did not expect, and hostile or stale URLs. A visitor must always see an honest,
 * recoverable page, never a blank screen. (Found by the 2026-10-14 assessment: docs/BACKLOG.md.)
 */
import { expect, test, type Page } from "@playwright/test";
import { openExplorer } from "./helpers";

const SNAPSHOT = /\/data\/demo\/snapshot\.[0-9a-f]+\.json$/;

/** Serves the real snapshot after `mutate` has changed it. */
async function mutateSnapshot(page: Page, mutate: (snap: Record<string, unknown>) => void) {
  await page.route(SNAPSHOT, async (route) => {
    const res = await route.fetch();
    const snap = (await res.json()) as Record<string, unknown>;
    mutate(snap);
    await route.fulfill({ response: res, json: snap });
  });
}

const visibleText = (page: Page) => page.locator("body").innerText();

test.describe("dataset cannot be loaded", () => {
  test("a missing manifest explains itself and offers a retry", async ({ page }) => {
    await page.route("**/data/demo/manifest.json", (r) => r.fulfill({ status: 503, body: "" }));
    await page.goto("/");
    await expect(page.getByRole("alert")).toContainText("could not be loaded");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("a truncated snapshot is reported as a failed download, not a JSON error", async ({
    page,
  }) => {
    await page.route(SNAPSHOT, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).slice(0, 5000) });
    });
    await page.goto("/");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("could not be loaded");
    await expect(alert).not.toContainText("JSON");
    await expect(alert).not.toContainText("Unexpected");
  });

  test("a visitor is never told to run developer commands", async ({ page }) => {
    await page.route("**/data/demo/manifest.json", (r) => r.fulfill({ status: 404, body: "" }));
    await page.goto("/");
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await visibleText(page)).not.toMatch(/npm run|data:demo/);
  });

  test("a retry loads the dataset once the network recovers", async ({ page }) => {
    let up = false;
    await page.route("**/data/demo/manifest.json", (r) =>
      up ? r.continue() : r.fulfill({ status: 503, body: "" }),
    );
    await page.goto("/");
    await expect(page.getByRole("alert")).toBeVisible();
    up = true;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("tablist", { name: "Network view" })).toBeVisible();
  });

  test("a snapshot that never arrives gives up with a message instead of loading forever", async ({
    page,
  }) => {
    await page.clock.install();
    await page.route(SNAPSHOT, () => new Promise(() => undefined));
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("Loading");
    await page.clock.fastForward(60_000);
    await expect(page.getByRole("alert")).toContainText("took too long");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});

test.describe("a record the UI did not expect", () => {
  test("a dataset the app cannot index gives a plain message and a retry, not a blank page", async ({
    page,
  }) => {
    await mutateSnapshot(page, (snap) => {
      for (const o of snap.organizations as Record<string, unknown>[]) {
        o.hq = null;
        o.segment = null;
      }
    });
    await page.goto("/");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("could not be loaded");
    await expect(alert).not.toContainText(/TypeError|undefined|null/);
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("an error inside one page leaves the other pages working", async ({ page }) => {
    await mutateSnapshot(page, (snap) => {
      snap.coverage = {};
    });
    await page.goto("/methodology");
    await page.waitForTimeout(1000);
    await expect(page.getByRole("link", { name: "CANDEF home" })).toBeVisible();
    await page.getByRole("link", { name: "CANDEF home" }).click();
    await expect(page.getByRole("main")).toBeVisible();
  });
});

test.describe("hostile and stale URLs", () => {
  const hostile = [
    "/?lens=%00&sel=%3Cscript%3Ealert(1)%3C/script%3E",
    "/?sel=org_does_not_exist&rel=a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p",
    "/?asof=99999999999999999999&tmode=%7B%7D",
    "/?asof=-5&asof=2020&asof=abc",
    "/?market=zzz&sector=%25%25&province=%00&stage=constructor",
    "/?q=" + "a".repeat(5000),
    "/?q=%5B&sector=%5C",
    "/?view=list&sel=__proto__&rel=__proto__,constructor",
    "/?lens=industry&asof=2020&grants=maybe&dir=2",
    "/company/__proto__",
    "/company/" + "x".repeat(3000),
    "/methodology?x=" + "y".repeat(3000),
    "/no/such/route",
  ];
  for (const url of hostile) {
    test(`survives ${url.slice(0, 60)}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url);
      await expect(page.getByRole("link", { name: "CANDEF home" })).toBeVisible();
      await expect(page.getByRole("main")).toBeVisible();
      await page.waitForTimeout(400);
      expect(errors).toEqual([]);
      expect((await visibleText(page)).trim().length).toBeGreaterThan(20);
    });
  }

  test("a malformed percent-encoding inside the app is handled", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openExplorer(page);
    await page.evaluate(() => {
      history.pushState({}, "", "/company/%E0%A4%A");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.waitForTimeout(400);
    await expect(page.getByRole("link", { name: "CANDEF home" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("an unknown selection in the URL opens the explorer with nothing selected", async ({
    page,
  }) => {
    await openExplorer(page, "?sel=org_does_not_exist");
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
  });
});

test.describe("a tampered snapshot", () => {
  test("a source with a script address is shown as text, never as a link", async ({ page }) => {
    await mutateSnapshot(page, (snap) => {
      for (const src of Object.values(snap.sources as Record<string, { url: string }>))
        src.url = "javascript:window.__pwned=true";
    });
    await page.goto("/");
    const snap = await page.evaluate(async () => {
      const m = await (await fetch("/data/demo/manifest.json")).json();
      return (await fetch(`/data/demo/${m.current}`)).json();
    });
    const company = snap.organizations.find((o: { scope: string }) => o.scope === "universe");
    await page.goto(`/company/${company.slug}`);
    await expect(page.locator("#sources")).toBeVisible();
    expect(await page.locator("a[href^='javascript:']").count()).toBe(0);
    await expect(page.locator("#sources")).toContainText(/Link unavailable|Fictional source/);
    expect(await page.evaluate(() => (window as { __pwned?: boolean }).__pwned)).toBeUndefined();
  });
});
