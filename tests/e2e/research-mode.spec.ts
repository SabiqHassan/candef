/**
 * M3-E2: the app on REAL (non-demo) snapshots. Corpora are compiled in the test process and served
 * in place of the demo snapshot, so the full compile → snapshot → UI path is exercised without a
 * second build. Content is synthetic and lives only in this test.
 */
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Assertion, Corpus } from "../../src/domain/schema/corpus";
import type { Snapshot } from "../../src/domain/schema/snapshot";
import { compile } from "../../pipeline/compile/compile";
import { reviewHashFor } from "../../pipeline/compile/hash";

const TODAY = "2026-10-13";
const base = (): Corpus => ({
  schemaVersion: "0.3",
  isDemo: false,
  taxonomy: [
    { id: "tax:cyber", parentId: null, label: "Cybersecurity", definition: "" },
    { id: "tax:cyber.1", parentId: "tax:cyber", label: "Identity and access", definition: "" },
  ],
  sources: [
    {
      id: "src_release",
      kind: "company_release",
      tier: "T2",
      publisher: "Testco",
      title: "About Testco",
      url: "https://example.org/testco/about",
      publishedOn: "2026-01",
      retrievedAt: "2026-10-13T00:00:00Z",
      originGroup: "og:testco",
      textSha256: null,
      sourceBasis: "named",
    },
  ],
  organizations: [],
  assertions: [],
  rounds: [],
  agreements: [],
  acquisitions: [],
  programs: [],
  research: [],
});

/** A verified assertion with a valid review, as `candef review` would produce (test-only). */
function reviewed(id: string, predicate: Assertion["predicate"], value: unknown): Assertion {
  const a: Assertion = {
    id,
    subjectId: "org_testco",
    predicate,
    value,
    primary: true,
    validFrom: null,
    validTo: null,
    asOf: null,
    supersedes: null,
    epistemic:
      predicate === "eligibility" || predicate === "classified_as"
        ? "analyst_interpretation"
        : "sourced_fact",
    verification: "verified",
    evidence: [{ sourceId: "src_release", locator: "about page", locatorQuality: "body" }],
    review: null,
    createdBy: "test",
  };
  return { ...a, review: { by: "owner", at: TODAY, hash: reviewHashFor("assertion", a) } };
}

function snapshotOf(corpus: Corpus): Snapshot {
  const r = compile(corpus, { today: TODAY });
  if (!r.ok || !r.snapshot) throw new Error(JSON.stringify(r.failures));
  return r.snapshot;
}

async function serve(page: Page, snap: Snapshot) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/data/demo/manifest.json", (route) =>
    route.fulfill({
      json: {
        current: "snapshot.test.json",
        schemaVersion: snap.meta.schemaVersion,
        isDemo: snap.meta.isDemo,
        builtAt: snap.meta.builtAt,
        previous: [],
      },
    }),
  );
  await page.route("**/data/demo/snapshot.test.json", (route) => route.fulfill({ json: snap }));
  return errors;
}

test("empty real dataset: honest empty states and no demo labelling", async ({ page }) => {
  const errors = await serve(page, snapshotOf(base()));
  await page.goto("/");
  await expect(page.getByText("No companies are published yet.").first()).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(0); // no "Fictional demonstration data" label
  await expect(page.getByText("No companies match these filters.")).toHaveCount(0);
  const axe = await new AxeBuilder({ page }).exclude("canvas").analyze();
  expect(axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
    [],
  );
  await page.goto("/?view=list");
  await expect(page.getByText("0 companies.")).toBeVisible();
  await page.goto("/methodology");
  await expect(page.getByText("fictional demonstration data")).toHaveCount(0);
  await expect(page.getByText(/not market coverage/)).toBeVisible();
  expect(errors).toEqual([]);
});

function oneCompany(): Corpus {
  const c = base();
  c.organizations.push({
    id: "org_testco",
    kind: "company",
    slug: "testco",
    name: "Testco",
    mergedInto: null,
    isDemo: false,
  });
  c.assertions.push(
    reviewed("a1", "legal_name", "Testco Inc."),
    reviewed("a2", "hq_location", { city: "Ottawa", region: null, province: "ON", country: "CA" }),
    reviewed("a3", "classified_as", "tax:cyber.1"),
    reviewed("a4", "eligibility", { decision: "included", rationale: "Documented security work." }),
    reviewed("a5", "registry_id", { system: "corporations-canada", value: "1234567" }),
  );
  c.research.push({
    id: "r1",
    subjectId: "org_testco",
    topic: "financing",
    sourcesSearched: ["company site"],
    outcome: "none_found",
    by: "test",
    at: TODAY,
    nextReview: "2027-04",
  });
  return c;
}

test("one verified real company renders end to end without demo tags", async ({ page }) => {
  const snap = snapshotOf(oneCompany());
  expect(snap.coverage.inUniverse).toBe(1);
  const errors = await serve(page, snap);

  await page.goto("/?sel=org_testco");
  const card = page.getByRole("complementary", { name: "Selection details" });
  await expect(card.getByRole("heading", { level: 2, name: "Testco" })).toBeVisible();
  await expect(card.getByText("Fictional")).toHaveCount(0);
  await expect(card.getByText("Ottawa, ON, Canada")).toBeVisible();

  await page.goto("/company/testco");
  await expect(page.getByRole("heading", { level: 1, name: "Testco" })).toBeVisible();
  await expect(page.locator("#financing").getByText("Not found in reviewed sources")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Source: Testco/ }).first()).toBeVisible();
  await expect(page.getByText("Federal corporation number")).toBeVisible();
  await expect(page.getByText("1234567")).toBeVisible();
  // Absence is reported by research state, never as a claim (independence, zero contracts, private).
  const corporate = page.locator("#corporate");
  await expect(corporate.getByText("Parent company:")).toBeVisible();
  await expect(corporate.locator('[data-state="not_researched"]')).toBeVisible();
  await expect(page.getByText(/Independent/)).toHaveCount(0);
  await expect(page.getByText(/^\s*Also:/)).toHaveCount(0); // one classification, shown once

  await page.goto("/?view=list");
  const row = page.getByRole("row", { name: /Testco/ });
  await expect(row.getByRole("cell", { name: "Listing status unknown" })).toBeVisible();
  await expect(row.getByRole("cell", { name: "Not yet researched" })).toBeVisible();
  await expect(row.getByRole("cell", { name: "0", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a USD contract is shown in US dollars, never relabelled as CAD", async ({ page }) => {
  const c = oneCompany();
  c.organizations.push({
    id: "org_agency",
    kind: "government_body",
    slug: "agency",
    name: "Test Agency",
    mergedInto: null,
    isDemo: false,
  });
  c.research.push({
    id: "r2",
    subjectId: "org_testco",
    topic: "agreements",
    sourcesSearched: ["disclosure"],
    outcome: "found",
    by: "test",
    at: TODAY,
    nextReview: "2027-04",
  });
  const g: Corpus["agreements"][number] = {
    id: "agr_usd",
    family: "procurement",
    type: "contract_award",
    title: "Test services",
    programId: null,
    groupId: null,
    externalIds: [],
    parties: [
      {
        orgId: "org_agency",
        role: "buyer",
        evidenceStrength: "party_of_record",
        reportedName: "Test Agency",
      },
      {
        orgId: "org_testco",
        role: "prime",
        evidenceStrength: "party_of_record",
        reportedName: "TESTCO INC",
      },
    ],
    currency: "USD",
    disclosureRows: [
      {
        reportingPeriod: "2025-2026-Q1",
        instrument: "original",
        originalValue: "1000000",
        amendmentValue: null,
        totalValue: "1000000",
        endOnAsStated: null,
      },
      {
        reportingPeriod: "2025-2026-Q2",
        instrument: "amendment",
        originalValue: "1000000",
        amendmentValue: "500000",
        totalValue: "1500000",
        endOnAsStated: null,
      },
    ],
    valueStatements: [],
    allocations: [],
    repayability: null,
    announcedOn: "2025-05",
    startOn: null,
    statusAsOf: { state: "unknown", asOf: TODAY },
    epistemic: "sourced_fact",
    verification: "verified",
    evidence: [{ sourceId: "src_release", locator: "contracts page", locatorQuality: "body" }],
    review: null,
    createdBy: "test",
  };
  c.agreements.push({
    ...g,
    review: { by: "owner", at: TODAY, hash: reviewHashFor("agreement", g) },
  });
  const errors = await serve(page, snapshotOf(c));
  await page.goto("/company/testco");
  const gov = page.locator("#government");
  await expect(gov.getByText("US$1.5M").first()).toBeVisible();
  await expect(gov.getByText(/CA\$1\.5M|CA\$1M/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the old address of a merged company redirects to the surviving dossier", async ({ page }) => {
  const c = oneCompany();
  c.organizations.push({
    id: "org_testco_old",
    kind: "company",
    slug: "testco-old-name",
    name: "Testco (old record)",
    mergedInto: "org_testco",
    isDemo: false,
  });
  const errors = await serve(page, snapshotOf(c));
  await page.goto("/company/testco-old-name");
  await expect(page).toHaveURL(/\/company\/testco$/);
  await expect(page.getByRole("heading", { level: 1, name: "Testco" })).toBeVisible();
  expect(errors).toEqual([]);
});
