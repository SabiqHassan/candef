import { describe, expect, it } from "vitest";
import { ROW_H, visibleWindow } from "./Directory";

describe("directory windowing", () => {
  it("renders only the visible rows plus a margin", () => {
    const w = visibleWindow(3000, 0, 700);
    expect(w.start).toBe(0);
    expect(w.end - w.start).toBeLessThan(40);
  });
  it("follows the scroll position and never runs past the list", () => {
    const mid = visibleWindow(3000, 1000 * ROW_H, 700);
    expect(mid.start).toBeLessThanOrEqual(1000);
    expect(mid.end).toBeGreaterThan(1000 + Math.floor(700 / ROW_H));
    const end = visibleWindow(3000, 2990 * ROW_H, 700);
    expect(end.end).toBe(3000);
    expect(visibleWindow(0, 500, 700)).toEqual({ start: 0, end: 0 });
  });
});
