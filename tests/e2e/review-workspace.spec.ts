/**
 * The owner's review workspace in a real browser, on a TEMPORARY SYNTHETIC corpus (never research/).
 * Builds the page, marks decisions like the owner would, exports, and checks the exported file with
 * the same validator and planner `candef apply-decisions` uses. Nothing is applied here.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { planDecisions, readDecisionsFile } from "../../pipeline/research/decisions";
import { loadResearchCorpus } from "../../pipeline/research/load";
import { buildWorkspace } from "../../pipeline/research/workspace";

const AT = "2026-10-13";
const SOURCE = `kind: company_release
tier: T2
publisher: Fictional Gamma
title: Fictional page
url: https://example.org/fictional-gamma
publishedOn: "2025"
retrievedAt: "2026-10-13T00:00:00Z"
originGroup: og:gamma
textSha256: null
`;
const ORG = `org: { id: org_gamma, kind: company, slug: gamma, name: Fictional Gamma <b>Co</b> }
defaults: { createdBy: "agent:test" }
facts:
  - id: a_legal
    predicate: legal_name
    value: Fictional Gamma Inc.
    src: ["src_gamma#about"]
  - id: a_weak
    predicate: website
    value: https://example.org
    src: [{ source: src_gamma, locator: "footer", quality: related_link }]
`;

let root = "";
test.beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "candef-ws-"));
  mkdirSync(join(root, "sources"));
  mkdirSync(join(root, "orgs"));
  writeFileSync(join(root, "sources", "src_gamma.yaml"), SOURCE);
  writeFileSync(join(root, "orgs", "gamma.yaml"), ORG);
});
test.afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the owner can approve and reject claims and export a valid decisions file", async ({
  page,
}) => {
  const html = buildWorkspace(root, { today: AT, cacheDir: join(root, "cache") });
  // An app origin first, so the page can keep decisions in local storage.
  await page.context().route("https://example.org/**", (r) => r.abort());
  await page.goto("/methodology");
  await page.setContent(html);

  // Names are escaped, never interpreted as markup.
  await expect(page.getByRole("heading", { level: 2 })).toContainText("Fictional Gamma <b>Co</b>");
  const legal = page.locator('section.unit[data-id="a_legal"]');
  const weak = page.locator('section.unit[data-id="a_weak"]');
  await expect(legal).toContainText("Fictional Gamma Inc.");
  await expect(legal).toContainText("about");
  // A claim failing its evidence rule cannot be approved, only rejected.
  await expect(weak.getByRole("radio", { name: "Approve" })).toBeDisabled();

  await expect(legal.locator(".opened")).toHaveText("Source not opened yet");
  await legal
    .locator(".ev a")
    .first()
    .click({ modifiers: ["ControlOrMeta"] });
  await expect(legal.locator(".opened")).toHaveText("Source opened");
  await legal.getByRole("radio", { name: "Approve" }).check();
  await weak.getByRole("radio", { name: "Reject" }).check();

  // A rejection without a reason cannot be exported.
  let alertText = "";
  page.once("dialog", async (d) => {
    alertText = d.message();
    await d.dismiss();
  });
  await page.getByRole("button", { name: "Export decisions" }).click();
  await expect.poll(() => alertText).toContain("no reason");

  await weak.getByLabel(/Reason for rejecting/).fill("Footer link only; not evidence");
  await weak.getByLabel(/Reason for rejecting/).blur();
  await expect(page.locator("#progress")).toContainText("1 approve · 1 reject");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export decisions" }).click();
  const path = join(root, "decisions.json");
  await (await download).saveAs(path);

  const file = readDecisionsFile(path);
  expect(file.decisions.map((d) => [d.id, d.decision, d.sourceOpened])).toEqual([
    ["a_legal", "approve", true],
    ["a_weak", "reject", false],
  ]);
  const plan = planDecisions(loadResearchCorpus(root).corpus!, file, AT);
  expect(plan.approve.map((d) => d.id)).toEqual(["a_legal"]);
  expect(plan.reject.map((d) => d.id)).toEqual(["a_weak"]);
  expect(plan.stale).toEqual([]);

  // Decisions survive a reload of the same workspace.
  await page.setContent(html);
  await expect(
    page.locator('section.unit[data-id="a_legal"]').getByRole("radio", { name: "Approve" }),
  ).toBeChecked();
  expect(readFileSync(join(root, "orgs", "gamma.yaml"), "utf8")).toBe(ORG);
});

test("filters, search and resume work across several organizations", async ({ page }) => {
  const many = mkdtempSync(join(tmpdir(), "candef-ws-many-"));
  try {
    mkdirSync(join(many, "sources"));
    mkdirSync(join(many, "orgs"));
    writeFileSync(join(many, "sources", "src_gamma.yaml"), SOURCE);
    for (const [slug, name, legal] of [
      ["alpha", "Fictional Alpha", "Alpha Quokka Inc."],
      ["beta", "Fictional Beta", "Beta Wombat Inc."],
      ["gamma", "Fictional Gamma", "Gamma Numbat Inc."],
    ]) {
      writeFileSync(
        join(many, "orgs", `${slug}.yaml`),
        `org: { id: org_${slug}, kind: company, slug: ${slug}, name: ${name} }
defaults: { createdBy: "agent:test" }
facts:
  - id: a_${slug}_legal
    predicate: legal_name
    value: ${legal}
    src: ["src_gamma#about"]
  - id: a_${slug}_site
    predicate: website
    value: https://example.org/${slug}
    src: ["src_gamma#footer"]
`,
      );
    }
    const html = buildWorkspace(many, { today: AT, cacheDir: join(many, "cache") });
    await page.context().route("https://example.org/**", (r) => r.abort());
    await page.goto("/methodology");
    await page.setContent(html);

    const units = page.locator("section.unit");
    const headings = page.getByRole("heading", { level: 2 });
    await expect(units).toHaveCount(6);
    await expect(units.locator(".opened").first()).toHaveText("Source not opened yet");

    // Organization filter hides other claims and their headings.
    await page.getByLabel("Organization").selectOption("org_beta");
    await expect(page.locator("section.unit:visible")).toHaveCount(2);
    await expect(headings.filter({ visible: true })).toHaveCount(1);
    await page.getByLabel("Organization").selectOption("");
    await expect(page.locator("section.unit:visible")).toHaveCount(6);

    // Search matches text anywhere in a claim and is case-insensitive; no match hides everything.
    await page.getByRole("searchbox", { name: "Search claims" }).fill("WOMBAT");
    await expect(page.locator("section.unit:visible")).toHaveCount(1);
    await expect(page.locator("section.unit:visible")).toContainText("Beta Wombat");
    await page.getByRole("searchbox", { name: "Search claims" }).fill("no such text");
    await expect(page.locator("section.unit:visible")).toHaveCount(0);
    await expect(headings.filter({ visible: true })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search claims" }).fill("");
    await expect(page.locator("section.unit:visible")).toHaveCount(6);

    // Decisions drive the state filter and the progress line.
    await page
      .locator('section.unit[data-id="a_alpha_legal"]')
      .getByRole("radio", { name: "Approve" })
      .check();
    await page
      .locator('section.unit[data-id="a_beta_site"]')
      .getByRole("radio", { name: "Reject" })
      .check();
    await page
      .locator('section.unit[data-id="a_beta_site"]')
      .getByLabel(/Reason for rejecting/)
      .fill("not evidence");
    await expect(page.locator("#progress")).toContainText(
      "1 approve · 1 reject · 4 undecided of 6",
    );
    await page.getByLabel("Show").selectOption("undecided");
    await expect(page.locator("section.unit:visible")).toHaveCount(4);
    await page.getByLabel("Show").selectOption("approve");
    await expect(page.locator("section.unit:visible")).toHaveCount(1);
    await page.getByLabel("Show").selectOption("");

    // Export, wipe the page's memory, and resume from the file.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export decisions" }).click();
    const file = join(many, "decisions.json");
    await (await download).saveAs(file);
    await page.evaluate(() => localStorage.clear());
    await page.setContent(html);
    await expect(page.locator("#progress")).toContainText("0 approve · 0 reject · 6 undecided");
    page.once("dialog", (d) => d.dismiss());
    await page.locator("#import").setInputFiles(file);
    await expect(page.locator("#progress")).toContainText("1 approve · 1 reject · 4 undecided");
    await expect(
      page.locator('section.unit[data-id="a_alpha_legal"]').getByRole("radio", { name: "Approve" }),
    ).toBeChecked();
    await expect(
      page.locator('section.unit[data-id="a_beta_site"]').getByLabel(/Reason for rejecting/),
    ).toHaveValue("not evidence");
  } finally {
    rmSync(many, { recursive: true, force: true });
  }
});
