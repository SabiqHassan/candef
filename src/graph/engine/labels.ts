export interface LabelCandidate {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
  weight: number;
  related: boolean;
  /** Fallback x (label left of its node), tried when `x` collides or runs off the viewport. */
  altX?: number;
}
/**
 * A bounded grid; only accepted labels enter it. Related overflow includes budget/collision/offscreen
 * rejections. Accepted labels carry the x actually used (`x`, else `altX`).
 */
export function placeLabels(
  candidates: readonly LabelCandidate[],
  budget: number,
  width: number,
  height: number,
) {
  const labels: LabelCandidate[] = [],
    grid = new Map<string, LabelCandidate[]>();
  const cells = (c: LabelCandidate) => {
    const keys: string[] = [];
    for (let x = Math.floor(c.x / 64); x <= Math.floor((c.x + c.width) / 64); x++)
      for (let y = Math.floor(c.y / 24); y <= Math.floor((c.y + c.height) / 24); y++)
        keys.push(`${x}:${y}`);
    return keys;
  };
  let overflow = 0;
  for (const c of [...candidates].sort(
    (a, b) => a.priority - b.priority || b.weight - a.weight || a.index - b.index,
  )) {
    const fits = (x: number) => {
      if (x < 0 || c.y < 0 || x + c.width > width || c.y + c.height > height) return null;
      const at = { ...c, x };
      const collision = cells(at).some((key) =>
        (grid.get(key) || []).some(
          (o) =>
            at.x < o.x + o.width &&
            at.x + at.width > o.x &&
            at.y < o.y + o.height &&
            at.y + at.height > o.y,
        ),
      );
      return collision ? null : at;
    };
    const placed =
      labels.length < budget ? (fits(c.x) ?? (c.altX === undefined ? null : fits(c.altX))) : null;
    if (!placed) {
      if (c.related) overflow++;
      continue;
    }
    labels.push(placed);
    for (const key of cells(placed)) {
      const list = grid.get(key) || [];
      list.push(placed);
      grid.set(key, list);
    }
  }
  return { labels, overflow };
}
