/**
 * M3 acceptance: "100% of published facts trace to a verified, hash-valid assertion".
 *
 * A synthetic non-demo corpus mixes approved, proposed, tampered (edited after review), retracted and
 * superseded records. After compiling, every value in the snapshot is traced back to its record, and
 * every record behind a published value must carry a valid review (history: an intact one).
 */
import { describe, expect, it } from "vitest";
import type { Assertion, Corpus } from "../../src/domain/schema/corpus";
import { compile } from "./compile";
import { hasIntactReview, hasValidReview, reviewHashFor } from "./hash";

const TODAY = "2026-10-13";
const base = (): Corpus => ({
  schemaVersion: "0.3",
  isDemo: false,
  taxonomy: [
    { id: "tax:cyber", parentId: null, label: "Cyber", definition: "" },
    { id: "tax:cyber.1", parentId: "tax:cyber", label: "Identity", definition: "" },
  ],
  sources: [
    {
      id: "s1",
      kind: "company_release",
      tier: "T2",
      publisher: "P",
      title: "T",
      url: "https://example.org/p",
      publishedOn: null,
      retrievedAt: "2026-10-13T00:00:00Z",
      originGroup: "og:1",
      textSha256: null,
      sourceBasis: "named",
    },
  ],
  organizations: ["a", "b"].map((id) => ({
    id,
    kind: "company" as const,
    slug: id,
    name: `Audit ${id}`,
    mergedInto: null,
    isDemo: false,
  })),
  assertions: [],
  rounds: [],
  agreements: [],
  acquisitions: [],
  programs: [],
  research: [],
});

function make(
  id: string,
  subjectId: string,
  predicate: Assertion["predicate"],
  value: unknown,
  state: "approved" | "proposed" | "tampered" | "retracted" | "superseded",
  extra: Partial<Assertion> = {},
): Assertion {
  const a: Assertion = {
    id,
    subjectId,
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
    verification:
      state === "proposed"
        ? "proposed"
        : state === "retracted"
          ? "retracted"
          : state === "superseded"
            ? "superseded"
            : "verified",
    evidence: [{ sourceId: "s1", locator: "p1", locatorQuality: "body" }],
    review: null,
    createdBy: "test",
    ...extra,
  };
  if (state === "proposed") return a;
  const reviewed = {
    ...a,
    review: { by: "owner", at: TODAY, hash: reviewHashFor("assertion", a) },
  };
  return state === "tampered"
    ? { ...reviewed, value: `${String(value)} (edited after review)` }
    : reviewed;
}

describe("publish audit (M3 acceptance)", () => {
  it("every published value traces to a hash-valid approval", () => {
    const c = base();
    c.assertions.push(
      make("a_legal_old", "a", "legal_name", "Audit A Ltd.", "superseded"),
      make("a_legal", "a", "legal_name", "Audit A Inc.", "approved", { supersedes: "a_legal_old" }),
      make(
        "a_hq",
        "a",
        "hq_location",
        { city: null, region: null, province: "ON", country: "CA" },
        "approved",
      ),
      make("a_class", "a", "classified_as", "tax:cyber.1", "approved"),
      make(
        "a_elig",
        "a",
        "eligibility",
        { decision: "included", rationale: "Documented contract with a security agency (audit)." },
        "approved",
      ),
      make("a_founded", "a", "founded_year", 2015, "tampered"),
      make("a_desc", "a", "description", "Proposed description", "proposed"),
      make("a_web", "a", "website", "https://example.org", "retracted"),
      make("b_legal", "b", "legal_name", "Audit B Inc.", "proposed"),
      make(
        "b_elig",
        "b",
        "eligibility",
        { decision: "included", rationale: "Proposed only, never published." },
        "proposed",
      ),
    );
    const result = compile(c, { today: TODAY });
    expect(result.ok).toBe(true);
    const snap = result.snapshot!;
    const byId = new Map(c.assertions.map((a) => [a.id, a]));

    // 1. Every assertion exported in the snapshot is an approval that still matches its content.
    for (const id of Object.keys(snap.assertions)) {
      const a = byId.get(id)!;
      const ok =
        a.verification === "superseded"
          ? hasIntactReview("assertion", a)
          : hasValidReview("assertion", a);
      expect(ok, `${id} published without a valid review`).toBe(true);
    }
    // 2. Every verified fact on every organization cites only exported, valid assertions.
    for (const o of snap.organizations)
      for (const fact of [o.legalName, o.hq, o.founded, o.description, o.segment, o.listing])
        if (fact.state === "verified")
          for (const id of fact.assertionIds)
            expect(snap.assertions[id], `${o.id}: ${id}`).toBeDefined();

    // 3. What must never be published.
    expect(Object.keys(snap.assertions)).not.toContain("a_founded"); // tampered
    expect(Object.keys(snap.assertions)).not.toContain("a_desc"); // proposed
    expect(Object.keys(snap.assertions)).not.toContain("a_web"); // retracted
    expect(snap.organizations.find((o) => o.id === "b")?.scope ?? "absent").not.toBe("universe");
    const a = snap.organizations.find((o) => o.id === "a")!;
    expect(a.scope).toBe("universe");
    expect(a.founded.value).toBeNull();
    expect(a.description.value).toBeNull();
    expect(a.legalName.history?.map((h) => h.value)).toEqual(["Audit A Ltd."]);
    // No proposed value text anywhere in the published snapshot.
    const text = JSON.stringify(snap);
    for (const hidden of [
      "Proposed description",
      "Audit B Inc.",
      "edited after review",
      "Proposed only",
    ])
      expect(text).not.toContain(hidden);
  });
});
