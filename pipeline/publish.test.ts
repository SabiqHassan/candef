import { describe, expect, it } from "vitest";
import { assertPreviewTarget } from "./publish";

describe("preview snapshots never leave .preview/", () => {
  const preview = { meta: { preview: true } } as Parameters<typeof assertPreviewTarget>[1];
  it("refuses a preview snapshot outside a .preview folder", () => {
    expect(() => assertPreviewTarget("public/data/research", preview)).toThrow(/outside .preview/);
    expect(() => assertPreviewTarget("dist", preview)).toThrow(/outside .preview/);
    expect(() => assertPreviewTarget(".preview/data/research", preview)).not.toThrow();
  });
  it("refuses a share build of a preview, and lets ordinary snapshots through anywhere", () => {
    const share = { meta: { preview: true, audience: "share" } } as typeof preview;
    expect(() => assertPreviewTarget(".preview/x", share)).toThrow(/share build/);
    expect(() =>
      assertPreviewTarget("public/data/research", { meta: {} } as typeof preview),
    ).not.toThrow();
  });
});
