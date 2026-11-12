import { describe, expect, it } from "vitest";
import { assertionCitations, dedupe } from "./claims";
import type { SnapshotIndex } from "./index";
import type { Citation } from "./schema/snapshot";

const cite = (sourceId: string, locator: string): Citation => ({
  sourceId,
  locator,
  quality: "body",
});

describe("dedupe", () => {
  it("drops repeats of the same source and locator, keeping the first and the order", () => {
    const out = dedupe([cite("s1", "p1"), cite("s2", "p1"), cite("s1", "p1"), cite("s1", "p2")]);
    expect(out.map((c) => `${c.sourceId}#${c.locator}`)).toEqual(["s1#p1", "s2#p1", "s1#p2"]);
  });
  it("does not confuse a source id and locator that concatenate to the same text", () => {
    expect(dedupe([cite("a", "bc"), cite("ab", "c")])).toHaveLength(2);
  });
  it("returns an empty list unchanged", () => {
    expect(dedupe([])).toEqual([]);
  });
});

describe("assertionCitations", () => {
  const ix = {
    snap: {
      assertions: {
        a1: { epistemic: "sourced_fact", evidence: [cite("s1", "p1")] },
        a2: { epistemic: "sourced_fact", evidence: [cite("s1", "p1"), cite("s2", "p9")] },
        a3: { epistemic: "analyst_interpretation", evidence: [cite("s3", "p3")] },
      },
    },
  } as unknown as SnapshotIndex;

  it("merges evidence across assertions without duplicates", () => {
    const r = assertionCitations(ix, ["a1", "a2"]);
    expect(r.citations.map((c) => `${c.sourceId}#${c.locator}`)).toEqual(["s1#p1", "s2#p9"]);
    expect(r.basis).toBe("sourced");
  });
  it("is an interpretation as soon as one assertion is", () => {
    expect(assertionCitations(ix, ["a1", "a3"]).basis).toBe("interpretation");
  });
  it("ignores unknown assertion ids instead of inventing evidence", () => {
    const r = assertionCitations(ix, ["missing"]);
    expect(r.citations).toEqual([]);
    expect(r.basis).toBe("sourced");
  });
});
