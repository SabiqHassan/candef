/**
 * Glue between the shared lens scene (src/features/explorer/sceneData.ts) and the 2D renderer.
 * The 2D view receives the very same scene (ids, edges, masks, selection); only the positions are
 * swapped for the 2D layout. Nothing is added, merged or dropped.
 */
import type { SnapshotIndex } from "../../domain";
import type { LensScene } from "./sceneData";
import {
  layoutInputFromSnapshot,
  type Layout2D,
  type LayoutInput,
  type LensId,
  computeLayout2D,
} from "../../graph/engine2d/layout2d";
import type { MapContext } from "../../graph/engine2d/NetworkCanvas2D";

export interface Prepared2D {
  input: LayoutInput;
  layout: Layout2D;
}

const cache = new WeakMap<SnapshotIndex, Prepared2D>();

/** The 2D layout for a snapshot, computed once per snapshot. */
export function prepare2D(ix: SnapshotIndex): Prepared2D {
  const hit = cache.get(ix);
  if (hit) return hit;
  const started = performance.now();
  const input = layoutInputFromSnapshot(ix.snap);
  const layout = computeLayout2D(input);
  performance.measure?.("candef:layout2d", { start: started, end: performance.now() });
  const prepared = { input, layout };
  cache.set(ix, prepared);
  return prepared;
}

/** Same scene, 2D positions. Reports ids the layout did not place (none expected). */
export function sceneFor2D(scene: LensScene, prepared: Prepared2D): LensScene {
  const { layout } = prepared;
  const positions = new Float32Array(scene.data.nodes.count * 3);
  const missing: string[] = [];
  scene.ids.forEach((id, i) => {
    const p = layout.positions.get(id) ?? layout.institutions[scene.lens].get(id);
    if (!p) {
      missing.push(id);
      return;
    }
    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1];
  });
  if (missing.length && import.meta.env.DEV)
    console.warn(`2D layout: ${missing.length} nodes without a position`, missing.slice(0, 5));
  return { ...scene, data: { ...scene.data, nodes: { ...scene.data.nodes, positions } } };
}

const HUB_LABEL: Record<LensId, string> = {
  capital: "Investors across several sectors",
  contracts: "Bodies across several sectors",
  industry: "Across several sectors",
};

export function mapContext(prepared: Prepared2D, lens: LensId): MapContext {
  const { layout, input } = prepared;
  const subIndex = new Map(layout.subsectors.map((s, i) => [s.id, i]));
  const membership = new Map<string, [number, number]>();
  for (const c of input.companies) {
    const s = layout.sectorOf.get(c.id);
    if (s !== undefined) membership.set(c.id, [s, subIndex.get(c.subsectorId) ?? -1]);
  }
  const hubUsed = [...layout.placement[lens].values()].includes("hub");
  return {
    sectors: layout.sectors,
    subsectors: layout.subsectors,
    membership,
    hub: layout.hub,
    hubLabel: hubUsed ? HUB_LABEL[lens] : null,
  };
}
