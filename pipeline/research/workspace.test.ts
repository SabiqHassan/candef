import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspace } from "./workspace";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SOURCE = `kind: company_release
tier: T2
publisher: Fictional
title: Fictional page
url: https://example.org/fictional
publishedOn: "2025"
retrievedAt: "2026-10-13T00:00:00Z"
originGroup: og:fictional
textSha256: null
`;
const org = (
  slug: string,
  name: string,
  decision: "included" | "excluded",
) => `org: { id: org_${slug}, kind: company, slug: ${slug}, name: ${name} }
defaults: { createdBy: "agent:test" }
facts:
  - id: a_${slug}_legal
    predicate: legal_name
    value: ${name} Inc.
    src: ["src_fictional#about"]
  - id: a_${slug}_elig
    predicate: eligibility
    epistemic: analyst_interpretation
    value: { decision: ${decision}, rationale: "Fictional rationale for the test." }
    src: ["src_fictional#about"]
`;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "candef-ws-unit-"));
  dirs.push(root);
  mkdirSync(join(root, "sources"));
  mkdirSync(join(root, "orgs"));
  writeFileSync(join(root, "sources", "src_fictional.yaml"), SOURCE);
  // Alphabetically the excluded company would come first.
  writeFileSync(join(root, "orgs", "aaa.yaml"), org("aaa", "Aaa Excluded", "excluded"));
  writeFileSync(join(root, "orgs", "bbb.yaml"), org("bbb", "Bbb Included", "included"));
  writeFileSync(join(root, "orgs", "ccc.yaml"), org("ccc", "Ccc Included", "included"));
  return buildWorkspace(root, { today: "2026-10-13", cacheDir: join(root, "cache") });
}

describe("review workspace ordering", () => {
  it("lists companies excluded from the dataset last, marked as publishing nothing", () => {
    const html = workspace();
    const order = [...html.matchAll(/<h2 data-org="(org_[a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["org_bbb", "org_ccc", "org_aaa"]);
    const excluded = html.slice(html.indexOf('<h2 data-org="org_aaa"'));
    expect(excluded.slice(0, 400)).toContain("approving these claims publishes nothing");
    const included = html.slice(
      html.indexOf('<h2 data-org="org_bbb"'),
      html.indexOf('<h2 data-org="org_ccc"'),
    );
    expect(included).not.toContain("approving these claims publishes nothing");
  });
});

describe("review workspace citations", () => {
  it("shows a government row locator as labelled fields with the fingerprint folded away", () => {
    const root = mkdtempSync(join(tmpdir(), "candef-ws-unit-"));
    dirs.push(root);
    mkdirSync(join(root, "sources"));
    mkdirSync(join(root, "orgs"));
    writeFileSync(join(root, "sources", "src_fictional.yaml"), SOURCE);
    const sha = "b".repeat(64);
    const locator = `reference_number=C-2023-2024-Q2-00001;procurement_id=FICT-9;vendor_name=Fictional%20Aster%20Ltd.;owner_org=fict-dept;locator_version=1;row_sha256=${sha}`;
    writeFileSync(
      join(root, "orgs", "dept.yaml"),
      `org: { id: org_dept, kind: government_body, slug: dept, name: Fictional Department of Testing }
defaults: { createdBy: "agent:test" }
facts:
  - id: a_dept_code
    predicate: registry_id
    value: { system: tbs-owner-org, value: fict-dept }
    src: ["src_fictional#about"]
`,
    );
    writeFileSync(
      join(root, "orgs", "aster.yaml"),
      org("aster", "Fictional Aster", "included").replace(
        'src: ["src_fictional#about"]',
        `src: ["src_fictional#${locator}"]`,
      ),
    );
    const html = buildWorkspace(root, { today: "2026-10-16", cacheDir: join(root, "cache") });
    expect(html).toContain("Vendor (as stated): <b>Fictional Aster Ltd.</b>");
    expect(html).toContain("Department: <b>Fictional Department of Testing (fict-dept)</b>");
    expect(html).toContain("Reporting period: <b>2023-2024, Q2</b>");
    expect(html).toContain(`<summary>row fingerprint</summary><code>${sha}</code>`);
    expect(html).not.toContain("vendor_name=Fictional%20Aster");
  });
});
