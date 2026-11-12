export interface ProjectedSegment {
  index: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  az: number;
  bz: number;
}
export function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) {
  const dx = bx - ax,
    dy = by - ay,
    length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return { distance: Math.hypot(px - ax - t * dx, py - ay - t * dy), t };
}
export function edgeCandidates(
  x: number,
  y: number,
  segments: readonly ProjectedSegment[],
  tolerance: number,
): number[] {
  return [
    ...new Set(
      segments
        .flatMap((s) => {
          const hit = pointSegmentDistance(x, y, s.ax, s.ay, s.bx, s.by);
          // NDC depth interpolates linearly in screen space (unlike camera-space z).
          return hit.distance <= tolerance
            ? [{ index: s.index, depth: s.az + (s.bz - s.az) * hit.t, distance: hit.distance }]
            : [];
        })
        .sort((a, b) => a.depth - b.depth || a.distance - b.distance || a.index - b.index)
        .map((s) => s.index),
    ),
  ];
}
export type ClipPoint = [number, number, number, number];
/** Homogeneous clipping against all six view-frustum planes, before dividing by w. */
export function clipSegment(a: ClipPoint, b: ClipPoint): [ClipPoint, ClipPoint] | null {
  let lo = 0,
    hi = 1;
  for (const [axis, sign] of [
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [2, 1],
    [2, -1],
  ] as const) {
    const da = a[3] + sign * a[axis],
      db = b[3] + sign * b[axis];
    if (da < 0 && db < 0) return null;
    if (da < 0) lo = Math.max(lo, da / (da - db));
    if (db < 0) hi = Math.min(hi, da / (da - db));
  }
  if (lo > hi) return null;
  const at = (t: number): ClipPoint => [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
    a[2] + t * (b[2] - a[2]),
    a[3] + t * (b[3] - a[3]),
  ];
  return [at(lo), at(hi)];
}

export interface ScreenPoint {
  index: number;
  /** CSS pixels from the top-left of the host. */
  x: number;
  y: number;
  /** NDC depth: smaller is nearer the camera; outside [-1, 1] is not drawn. */
  z: number;
}
/**
 * The point to snap a pointer to: the closest drawn point within `radius` CSS pixels. Ties on
 * distance go to the nearer point, then the lower index, so the result never depends on input order.
 * Used when the exact ray test misses: a distant node is only a few pixels wide.
 */
export function nearestScreenPoint(
  x: number,
  y: number,
  points: Iterable<ScreenPoint>,
  radius: number,
): number | null {
  let best: { index: number; distance: number; z: number } | null = null;
  for (const p of points) {
    if (p.z < -1 || p.z > 1) continue;
    const distance = Math.hypot(p.x - x, p.y - y);
    if (distance > radius) continue;
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && (p.z < best.z || (p.z === best.z && p.index < best.index)))
    )
      best = { index: p.index, distance, z: p.z };
  }
  return best ? best.index : null;
}
