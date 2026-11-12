import { EdgeKind, EdgeStyle, NodeKind } from "../../src/graph/engine/types";
import type { SceneData } from "../../src/graph/engine/types";

export function generateData(size: "small" | "large", seed = 20261012): SceneData {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const companies = size === "large" ? 3000 : 100,
    institutions = size === "large" ? 300 : 20,
    anchors = 10;
  const count = companies + institutions + anchors,
    edgeCount = size === "large" ? 15000 : 400;
  const kinds = new Uint8Array(count),
    positions = new Float32Array(count * 3),
    ids: string[] = [],
    labels: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(`synthetic-${i}`);
    if (i < companies) {
      kinds[i] = NodeKind.Company;
      labels.push(`Company ${String(i + 1).padStart(4, "0")}`);
      const sector = i % 10,
        angle = (sector * Math.PI * 2) / 10;
      const azimuth = random() * Math.PI * 2,
        radius = 48 * Math.cbrt(random()),
        z = (random() * 2 - 1) * radius;
      const radial = Math.sqrt(radius * radius - z * z);
      positions.set(
        [
          Math.cos(angle) * 105 + Math.cos(azimuth) * radial,
          Math.sin(angle) * 75 + Math.sin(azimuth) * radial,
          z + ((sector % 3) - 1) * 25,
        ],
        i * 3,
      );
    } else if (i < companies + institutions) {
      kinds[i] = 1 + ((i - companies) % 3);
      labels.push(`Institution ${String(i - companies + 1).padStart(3, "0")}`);
      const j = i - companies,
        y = 1 - (2 * (j + 0.5)) / institutions,
        r = Math.sqrt(1 - y * y),
        angle = j * Math.PI * (3 - Math.sqrt(5));
      positions.set([240 * Math.cos(angle) * r, 180 * y, 200 * Math.sin(angle) * r], i * 3);
    } else {
      const j = i - companies - institutions,
        angle = (j * Math.PI * 2) / 10;
      kinds[i] = NodeKind.Anchor;
      labels.push(`Sector ${String(j + 1).padStart(2, "0")}`);
      positions.set([Math.cos(angle) * 105, Math.sin(angle) * 75, ((j % 3) - 1) * 25], i * 3);
    }
  }
  // Deliberate coincident and near-coincident segments in empty space for chooser testing.
  positions.set([-85, -140, 75], 0);
  positions.set([85, -140, 75], 3);
  positions.set([-85, -140.3, 74.8], 6);
  positions.set([85, -140.3, 74.8], 9);
  const source = new Uint32Array(edgeCount),
    target = new Uint32Array(edgeCount),
    edgeKinds = new Uint8Array(edgeCount),
    styles = new Uint8Array(edgeCount),
    weight = new Uint16Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    if (e < 3) {
      source[e] = e === 2 ? 2 : 0;
      target[e] = e === 2 ? 3 : 1;
    } else {
      source[e] = companies + Math.floor(random() * institutions);
      target[e] = Math.floor(random() * companies);
    }
    edgeKinds[e] =
      kinds[source[e]!] === NodeKind.Investor || e < 3 ? EdgeKind.Capital : EdgeKind.Agreement;
    styles[e] = e % 4 === 0 ? EdgeStyle.Dashed : EdgeStyle.Solid;
    weight[e] = 1 + Math.floor(random() * 24);
  }
  // Reserve enough slots for every investor-sector pair while retaining the exact stress workload.
  const recordCount = edgeCount - Math.ceil(institutions / 3) * anchors;
  const aggregates = new Map<string, { weight: number; dashed: boolean }>();
  for (let e = 3; e < recordCount; e++)
    if (edgeKinds[e] === EdgeKind.Capital) {
      const key = `${source[e]}:${target[e]! % anchors}`;
      const previous = aggregates.get(key);
      aggregates.set(key, {
        weight: (previous?.weight ?? 0) + weight[e]!,
        dashed: Boolean(previous?.dashed || styles[e] === EdgeStyle.Dashed),
      });
    }
  let cursor = recordCount;
  for (const [key, aggregate] of aggregates) {
    const [investor, sector] = key.split(":").map(Number);
    source[cursor] = investor!;
    target[cursor] = companies + institutions + sector!;
    edgeKinds[cursor] = EdgeKind.Bundle;
    weight[cursor] = Math.min(65535, aggregate.weight);
    styles[cursor] = aggregate.dashed ? EdgeStyle.Dashed : EdgeStyle.Solid;
    cursor++;
  }
  // Unused slots in the smaller fixture remain agreement records, outside the Capital overview.
  for (; cursor < edgeCount; cursor++) {
    source[cursor] = companies + 1;
    edgeKinds[cursor] = EdgeKind.Agreement;
  }
  const weights = new Float32Array(count).fill(1);
  const degree = new Uint32Array(count);
  for (let e = 0; e < edgeCount; e++) {
    degree[source[e]!]!++;
    degree[target[e]!]!++;
  }
  for (let i = 0; i < count; i++)
    weights[i] = Math.min(
      3,
      Math.max(0.5, Math.sqrt(degree[i]! / (kinds[i] === NodeKind.Company ? 8 : 50))),
    );
  return {
    nodes: { count, ids, labels, kinds, positions, weights },
    edges: { count: edgeCount, source, target, kinds: edgeKinds, styles, weight },
  };
}
