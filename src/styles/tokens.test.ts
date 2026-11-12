import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NODE_COLORS } from "../graph/engine/buffers";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const token = (name: string) => {
  const m = css.match(new RegExp(`--${name}: *(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found`);
  return m[1]!;
};

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("design tokens meet WCAG AA (4.5:1) for text", () => {
  const surfaces = ["ink", "surface-1", "surface-2", "surface-3"];
  const texts = ["text", "text-2", "text-muted", "state-missing", "accent"];
  for (const t of texts)
    for (const s of surfaces)
      it(`--${t} on --${s}`, () => {
        expect(contrast(token(t), token(s))).toBeGreaterThanOrEqual(4.5);
      });

  it("computes known ratios correctly", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });
});

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
/** The 3D scene is cleared to transparent over the explorer background; its darkest backdrop is this. */
const SCENE_BG = "#080c10";
const blend = (fg: string, bg: string, alpha: number) => {
  const channel = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(alpha * channel(fg, i) + (1 - alpha) * channel(bg, i))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

describe("3D scene colours (WCAG 1.4.11 non-text contrast, 3:1)", () => {
  NODE_COLORS.forEach((c, i) =>
    it(`node colour ${i} on the scene background`, () => {
      expect(contrast(hex(c), SCENE_BG)).toBeGreaterThanOrEqual(3);
    }),
  );
  for (const edge of ["edge-capital", "edge-procurement", "edge-grant", "edge-lineage"])
    it(`--${edge} at the emphasised-line opacity (0.8, a selected company's lines)`, () => {
      expect(contrast(blend(token(edge), SCENE_BG, 0.8), SCENE_BG)).toBeGreaterThanOrEqual(3);
    });
  it("documents that default overview lines are deliberately faint (opacity up to 0.28)", () => {
    // Known, accepted trade-off (docs/DESIGN.md): at full-network zoom the lines stay faint so the
    // network does not turn into a hairball; selecting a company or investor raises them to 0.8,
    // and every relationship is also available as text in the list view and the relationship panel.
    const faint = contrast(blend(token("edge-capital"), SCENE_BG, 0.28), SCENE_BG);
    expect(faint).toBeLessThan(3);
    expect(faint).toBeGreaterThan(1.5);
  });
});
