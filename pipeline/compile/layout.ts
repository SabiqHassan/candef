/**
 * Deterministic, compile-time layout (ARCHITECTURE §4 Layout, D-07).
 *
 * - Companies: positioned by primary classification (sector cluster → subsector sub-cluster),
 *   identical in every lens. Existing positions from a previous snapshot are kept (stability).
 * - Institutions: outer shell in the direction of the sectors they are related to; generalists
 *   (no sector ≥ 40% of relationships) sit in a distinct band above the universe.
 * - Distance carries one meaning only: same or different technology classification.
 */
export type Vec3 = [number, number, number];

export const DISTANCE_MEANING =
  "Companies are placed by primary technology classification: same subsector = same cluster, same sector = neighbouring clusters. Institutions sit outside the universe, toward the sectors of their documented relationships. Distance implies nothing else.";

/**
 * Bump whenever the geometry below changes. Previous positions are only reused (stability, D-07)
 * within the same layout version; a new version re-lays every company once.
 */
export const LAYOUT_VERSION = "2";

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Stable 32-bit hash for deterministic placement independent of input order. */
export function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function fibonacciPoint(i: number, n: number, radius: number, flatten = 1): Vec3 {
  const y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(1 - y * y);
  const t = i * GOLDEN;
  return [Math.cos(t) * r * radius, y * radius * flatten, Math.sin(t) * r * radius];
}

const addV = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

export interface LayoutInput {
  sectors: { id: string; label: string; subsectorIds: string[] }[];
  /** Subsector id → label, for subsector anchors (Industry lens, labelled when zoomed in). */
  subsectorLabels?: Record<string, string>;
  companies: { id: string; sectorId: string; subsectorId: string }[];
  previous?: Record<string, Vec3>;
}

export interface UniverseLayout {
  companies: Record<string, Vec3>;
  sectorCenters: Record<string, Vec3>;
  anchors: { id: string; label: string; position: Vec3 }[];
  subAnchors: {
    id: string;
    label: string;
    sectorId: string;
    subsectorId: string;
    position: Vec3;
  }[];
}

export function layoutUniverse(input: LayoutInput): UniverseLayout {
  const sectorCenters: Record<string, Vec3> = {};
  const subCenters: Record<string, Vec3> = {};
  const sectorRadius = 380;
  // A flattened sphere reads well on wide screens while keeping genuine depth.
  input.sectors.forEach((s, i) => {
    const c = fibonacciPoint(i, input.sectors.length, sectorRadius, 0.6);
    sectorCenters[s.id] = c;
    s.subsectorIds.forEach((sub, j) => {
      subCenters[sub] =
        s.subsectorIds.length === 1 ? c : addV(c, fibonacciPoint(j, s.subsectorIds.length, 72));
    });
  });

  const companies: Record<string, Vec3> = {};
  const bySub = new Map<string, string[]>();
  for (const c of input.companies) {
    const list = bySub.get(c.subsectorId) ?? [];
    list.push(c.id);
    bySub.set(c.subsectorId, list);
  }
  for (const [sub, ids] of bySub) {
    const center = subCenters[sub] ?? [0, 0, 0];
    // Order by stable hash so adding a company does not reshuffle its neighbours.
    const ordered = [...ids].sort((a, b) => hash32(a) - hash32(b));
    // Reuse a previous position only if it still belongs to this sub-cluster: a company whose
    // classification changed must move to its new cluster.
    const stillHere = (p: Vec3 | undefined): p is Vec3 =>
      !!p && len(addV(p, scale(center, -1))) < 140;
    const taken: Vec3[] = ordered.map((id) => input.previous?.[id]).filter(stillHere);
    let slot = 0;
    for (const id of ordered) {
      const prev = input.previous?.[id];
      if (stillHere(prev)) {
        companies[id] = prev;
        continue;
      }
      // Pack new (or reclassified) companies on growing shells around the sub-centre.
      for (;;) {
        const shell = Math.floor(Math.cbrt(slot)) + 1;
        const p = addV(center, fibonacciPoint(slot % 97, 97, 12 + shell * 15));
        slot++;
        if (taken.every((t) => len(addV(t, scale(p, -1))) > 8)) {
          companies[id] = p;
          taken.push(p);
          break;
        }
      }
    }
  }

  const anchors = input.sectors.map((s) => {
    const c = sectorCenters[s.id]!;
    return { id: `anchor:${s.id}`, label: s.label, position: addV(c, [0, 100, 0]) as Vec3 };
  });
  // Only sectors with several sub-clusters need subsector labels; above each cluster's centre.
  const subAnchors = input.sectors.flatMap((s) =>
    s.subsectorIds.length < 2
      ? []
      : s.subsectorIds.map((sub) => ({
          id: `subanchor:${sub}`,
          label: input.subsectorLabels?.[sub] ?? sub,
          sectorId: s.id,
          subsectorId: sub,
          position: addV(subCenters[sub]!, [0, 40, 0]),
        })),
  );
  return { companies, sectorCenters, anchors, subAnchors };
}

/**
 * Institutions on an outer shell toward their related sectors. `related` maps institution →
 * sector id → relationship count. Light deterministic repulsion keeps markers apart.
 */
export function layoutInstitutions(
  related: Map<string, Map<string, number>>,
  sectorCenters: Record<string, Vec3>,
): Record<string, Vec3> {
  const shell = 640;
  const out: Record<string, Vec3> = {};
  for (const [id, sectors] of related) {
    const total = [...sectors.values()].reduce((s, n) => s + n, 0);
    const [topSector, topCount] = [...sectors.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const h = hash32(id);
    const jitter = ((h % 1000) / 1000 - 0.5) * 0.5;
    if (total > 0 && topCount / total >= 0.4 && sectorCenters[topSector]) {
      const dir = sectorCenters[topSector]!;
      const d = len(dir) || 1;
      const angle = Math.atan2(dir[2], dir[0]) + jitter;
      const elev = (dir[1] / d) * 0.6 + (((h >> 10) % 100) / 100 - 0.5) * 0.25;
      out[id] = [
        Math.cos(angle) * shell * Math.cos(elev),
        Math.sin(elev) * shell * 0.75,
        Math.sin(angle) * shell * Math.cos(elev),
      ];
    } else {
      // Multi-sector band: a ring above the universe, so generalists never collapse to the centre.
      const angle = ((h % 3600) / 3600) * Math.PI * 2;
      out[id] = [Math.cos(angle) * 380, 460 + ((h >> 12) % 60), Math.sin(angle) * 380];
    }
  }
  const ids = Object.keys(out).sort();
  for (let iter = 0; iter < 30; iter++) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = out[ids[i]!]!;
        const b = out[ids[j]!]!;
        const delta: Vec3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const dist = len(delta);
        if (dist > 0 && dist < 42) {
          const push = scale(delta, ((42 - dist) / dist) * 0.5);
          out[ids[i]!] = addV(a, push);
          out[ids[j]!] = addV(b, scale(push, -1));
        }
      }
    }
  }
  return out;
}
