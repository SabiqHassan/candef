import { EdgeFamily, EdgeKind } from "./types";
import type { SceneData } from "./types";

export const NODE_COLORS = [0xa6c4dd, 0xbcb196, 0x87a89b, 0xa1a8ae, 0x708a9d];
export const NODE_RADII = [1.25, 2.2, 1.8, 2.15, 2.4];
/**
 * Edge colours by EdgeFamily (linear; the shader encodes to sRGB, which desaturates, so these are
 * deliberately stronger than they look). On screen ≈ capital #99b3c4, procurement #7bb39a,
 * grant #c4a661, matching the `--edge-*` tokens.
 */
export const EDGE_COLORS: [number, number, number][] = [
  [0.32, 0.44, 0.55],
  [0.2, 0.45, 0.32],
  [0.55, 0.38, 0.12],
  [0.35, 0.38, 0.41], // Corporate lineage: neutral grey, separate from capital and government money.
];
export interface InstanceBuffer {
  indices: number[];
  alpha: Float32Array;
  scale: Float32Array;
}
export interface SegmentBuffer {
  indices: number[];
  /** One edge ID per tessellated segment, used by screen-space picking. */
  segmentIndices: number[];
  positions: Float32Array;
  colors: Float32Array;
  alpha: Float32Array;
  distance: Float32Array;
}
export function buildBuffers(
  data: SceneData,
  mask: Uint8Array | null,
  selected: number | null,
  related: ReadonlySet<number>,
  positions = data.nodes.positions,
  edgeMask: Uint8Array | null = null,
) {
  const grouped: number[][] = Array.from({ length: 5 }, () => []),
    styles: number[][] = [[], []];
  let visibleNodes = 0;
  for (let i = 0; i < data.nodes.count; i++) {
    grouped[data.nodes.kinds[i]!]!.push(i);
    if (!mask || mask[i]) visibleNodes++;
  }
  const nodes: InstanceBuffer[] = grouped.map((indices) => ({
    indices,
    alpha: Float32Array.from(indices, (i) =>
      mask && !mask[i] ? 0 : selected === null || selected === i || related.has(i) ? 1 : 0.24,
    ),
    scale: Float32Array.from(indices, (i) =>
      mask && !mask[i]
        ? 0
        : (i === selected ? 1.8 : related.has(i) ? 1.3 : 1) *
          Math.sqrt(data.nodes.weights?.[i] ?? 1),
    ),
  }));
  for (let i = 0; i < data.edges.count; i++) {
    const a = data.edges.source[i]!,
      b = data.edges.target[i]!;
    if ((!edgeMask || edgeMask[i]) && (!mask || (mask[a] && mask[b])))
      styles[data.edges.styles[i]!]!.push(i);
  }
  const visibleEdges = styles[0]!.length + styles[1]!.length;
  const densityAlpha = Math.min(0.18, 3 / Math.sqrt(Math.max(1, visibleEdges)));
  const edges: SegmentBuffer[] = styles.map((indices) => {
    const segmentIndices = indices.flatMap((e) =>
      Array<number>(data.edges.kinds[e] === EdgeKind.Bundle ? 12 : 1).fill(e),
    );
    const p = new Float32Array(segmentIndices.length * 6),
      colors = new Float32Array(p.length),
      alpha = new Float32Array(segmentIndices.length * 2),
      distance = new Float32Array(alpha.length);
    let j = 0;
    indices.forEach((e) => {
      const a = data.edges.source[e]!,
        b = data.edges.target[e]!;
      const family =
        data.edges.families?.[e] ??
        (data.edges.kinds[e] === EdgeKind.Agreement ? EdgeFamily.Procurement : EdgeFamily.Capital);
      const color = EDGE_COLORS[family] ?? EDGE_COLORS[EdgeFamily.Capital]!;
      const emphasized = (a === selected && related.has(b)) || (b === selected && related.has(a));
      const opacity =
        selected !== null
          ? emphasized
            ? 0.8
            : 0.012
          : Math.min(
              0.28,
              densityAlpha *
                (data.edges.kinds[e] === EdgeKind.Bundle ? 0.6 : 1) *
                (0.8 + Math.log2(data.edges.weight[e]! + 1) * 0.12),
            );
      const steps = data.edges.kinds[e] === EdgeKind.Bundle ? 12 : 1;
      let travelled = 0;
      for (let s = 0; s < steps; s++, j++) {
        const start = edgePoint(positions, a, b, s / steps, steps > 1);
        const end = edgePoint(positions, a, b, (s + 1) / steps, steps > 1);
        p.set(start, j * 6);
        p.set(end, j * 6 + 3);
        colors.set(color, j * 6);
        colors.set(color, j * 6 + 3);
        alpha[j * 2] = alpha[j * 2 + 1] = opacity;
        distance[j * 2] = travelled;
        travelled += Math.hypot(...end.map((v, k) => v - start[k]!));
        distance[j * 2 + 1] = travelled;
      }
    });
    return { indices, segmentIndices, positions: p, colors, alpha, distance };
  });
  return { nodes, edges, visibleNodes, visibleEdges };
}
/** Stable quadratic arc: bend perpendicular to the endpoints, with a vertical fallback. */
export function edgePoint(
  positions: Float32Array,
  a: number,
  b: number,
  t: number,
  curved: boolean,
): number[] {
  const dx = positions[b * 3]! - positions[a * 3]!,
    dy = positions[b * 3 + 1]! - positions[a * 3 + 1]!;
  const length = Math.hypot(dx, dy);
  const bend = curved ? 0.16 * 4 * t * (1 - t) : 0;
  return [
    positions[a * 3]! + dx * t - dy * bend,
    positions[a * 3 + 1]! + dy * t + (length > 0 ? dx : 20) * bend,
    positions[a * 3 + 2]! + (positions[b * 3 + 2]! - positions[a * 3 + 2]!) * t,
  ];
}
export function validateData(data: SceneData): void {
  const n = data.nodes,
    e = data.edges;
  if (
    !Number.isSafeInteger(n.count) ||
    n.count < 0 ||
    !Number.isSafeInteger(e.count) ||
    e.count < 0 ||
    n.ids.length !== n.count ||
    n.labels.length !== n.count ||
    n.kinds.length !== n.count ||
    n.positions.length !== n.count * 3 ||
    (n.weights !== undefined && n.weights.length !== n.count) ||
    (n.labelDetailOnly !== undefined && n.labelDetailOnly.length !== n.count) ||
    (e.families !== undefined && e.families.length !== e.count) ||
    [e.source, e.target, e.kinds, e.styles, e.weight].some((a) => a.length !== e.count)
  )
    throw new RangeError("Invalid scene buffer lengths");
  if (new Set(n.ids).size !== n.count) throw new RangeError("Node IDs must be unique");
  for (let i = 0; i < n.count; i++) if (n.kinds[i]! > 4) throw new RangeError("Invalid node kind");
  for (const p of n.positions)
    if (!Number.isFinite(p)) throw new RangeError("Positions must be finite");
  for (const weight of n.weights ?? [])
    if (!Number.isFinite(weight) || weight <= 0)
      throw new RangeError("Node weights must be positive and finite");
  for (let i = 0; i < e.count; i++)
    if (
      e.source[i]! >= n.count ||
      e.target[i]! >= n.count ||
      e.kinds[i]! > 2 ||
      e.styles[i]! > 1 ||
      (e.families?.[i] ?? 0) > 2 ||
      !e.weight[i]
    )
      throw new RangeError("Invalid edge");
}
