/**
 * Random-interaction test. Scripted tests only cover the paths someone thought of; this performs a
 * seeded sequence of random clicks, key presses, typing, scrolling, history moves and URL jumps on
 * the real app and fails on any uncaught error or console error. A failure prints the seed and the
 * action log, so it can be replayed:  MONKEY_SEED=123 npm run test:e2e -- monkey
 */
import { errors, expect, test, type Page } from "@playwright/test";
import { snapshot } from "./helpers";

/** Playwright's own action timeout (not an app error). */
const isTimeout = (e: unknown): boolean => e instanceof errors.TimeoutError;

const SEED = Number(process.env.MONKEY_SEED ?? 20261014);
const STEPS = Number(process.env.MONKEY_STEPS ?? 100);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = [
  "Tab",
  "Shift+Tab",
  "Enter",
  "Space",
  "Escape",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageDown",
];
const WORDS = [
  "robot",
  "ottawa",
  "inc",
  "ÿ",
  "😀",
  "<b>",
  "a b c",
  "0",
  "' OR 1=1",
  "x".repeat(60),
];

async function run(page: Page, label: string, seed: number, urls: string[]) {
  const next = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!;
  const problems: string[] = [];
  const log: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon|net::ERR/i.test(m.text()))
      problems.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  await page.goto(pick(urls));

  for (let i = 0; i < STEPS; i++) {
    const roll = next();
    let action = "";
    try {
      if (roll < 0.4) {
        // Click a random visible interactive element.
        const targets = page.locator(
          "button:visible, a:visible, [role=tab]:visible, [role=button]:visible, summary:visible, select:visible, input:visible",
        );
        const n = await targets.count();
        if (n) {
          const el = targets.nth(Math.floor(next() * n));
          // The page changes under a random choice; every locator call must give up quickly.
          action = `click ${await el
            .evaluate(
              (e) =>
                `${e.tagName.toLowerCase()} "${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 40)}"`,
              undefined,
              { timeout: 1000 },
            )
            .catch(() => "(element gone)")}`;
          await el
            .click({ timeout: 1500, trial: false, force: next() < 0.15 })
            .catch(() => undefined);
        }
      } else if (roll < 0.55) {
        action = `key ${pick(KEYS)}`;
        await page.keyboard.press(action.slice(4));
      } else if (roll < 0.68) {
        const w = pick(WORDS);
        action = `type ${JSON.stringify(w)}`;
        const box = page.getByRole("searchbox").first();
        if (await box.isVisible().catch(() => false)) await box.fill(w, { timeout: 1000 });
        else await page.keyboard.type(w);
      } else if (roll < 0.78) {
        action = "scroll";
        await page.mouse.wheel(0, (next() - 0.5) * 1800);
      } else if (roll < 0.84) {
        action = "canvas drag";
        const vp = page.viewportSize()!;
        await page.mouse.move(vp.width * next(), vp.height * next());
        await page.mouse.down();
        await page.mouse.move(vp.width * next(), vp.height * next(), { steps: 4 });
        await page.mouse.up();
      } else if (roll < 0.9) {
        action = next() < 0.5 ? "back" : "forward";
        await (action === "back" ? page.goBack() : page.goForward()).catch(() => undefined);
      } else if (roll < 0.97) {
        const u = pick(urls);
        action = `goto ${u}`;
        await page.goto(u);
      } else {
        action = "resize";
        const sizes = [
          { width: 390, height: 844 },
          { width: 768, height: 900 },
          { width: 1366, height: 768 },
          { width: 1920, height: 1080 },
        ];
        await page.setViewportSize(pick(sizes));
      }
    } catch (e) {
      // A Playwright action timeout means the random target moved or was covered (a slow CI runner),
      // not that the app broke: count it as a skipped action. Page and console errors still fail.
      if (isTimeout(e)) action = `${action} (skipped: action timed out)`;
      else problems.push(`action threw (${action}): ${(e as Error).message.split("\n")[0]}`);
    }
    log.push(action);
    await page.waitForTimeout(40);
    if (problems.length) break;
  }
  // The page must still be a page: navigation present, not blank.
  const alive = await page
    .getByRole("link", { name: "CANDEF home" })
    .isVisible()
    .catch(() => false);
  if (!alive) problems.push("the page is blank or lost its navigation at the end");
  expect(problems, `${label} seed ${seed}\nlast actions:\n${log.slice(-12).join("\n")}`).toEqual(
    [],
  );
}

test.describe("random interaction", () => {
  let urls: string[] = [];
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto("/methodology");
    const snap = await snapshot(page);
    const companies = snap.organizations.filter((o) => o.scope === "universe");
    const investor = snap.graph.lenses.capital.institutionIds[0]!;
    urls = [
      "/",
      "/?view=list",
      "/?lens=contracts",
      "/?lens=industry",
      "/?lens=contracts&asof=2021",
      "/methodology",
      `/company/${companies[0]!.slug}`,
      `/company/${companies[Math.floor(companies.length / 2)]!.slug}`,
      `/?sel=${companies[1]!.id}`,
      `/?lens=capital&sel=${investor}`,
      "/no/such/page",
    ];
    await page.close();
  });

  test("desktop", async ({ page }) => {
    test.setTimeout(240_000);
    await run(page, "desktop", SEED, urls);
  });

  test("phone", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await run(page, "phone", SEED + 1, urls);
  });
});

test("a Playwright action timeout counts as a skipped action, other errors do not", async ({
  page,
}) => {
  await page.setContent("<p>No buttons here</p>");
  const timeout = await page
    .locator("button")
    .click({ timeout: 100 })
    .catch((e: unknown) => e);
  expect(isTimeout(timeout)).toBe(true);
  expect(isTimeout(new Error("page crashed"))).toBe(false);
});
