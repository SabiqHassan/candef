/**
 * 2D layout for the network prototype (a proposal under review, not production).
 *
 * Same meaning as the 3D layout (D-07, pipeline/compile/layout.ts):
 * - Companies are placed by primary technology classification only (sector region → subsector
 *   band) and sit at the same place in every lens.
 * - Institutions sit toward the sectors of their documented relationships. Specialists (one sector
 *   holds at least 40% of their relationships, the 3D rule) sit just outside that sector; generalists
 *   sit in the central hub, pulled toward the centre of gravity of their related companies.
 * - Distance between companies means only "same or different classification".
 *
 * What is new in 2D: every company keeps a reserved box wide enough for its name, so at zoom 1
 * (world units = CSS pixels) no two names overlap. Sectors sit on a ring around an open hub, so lines
 * from generalists run outward through empty space instead of across other clusters.
 *
 * Deterministic: the same input gives the same output (no randomness, no simulation, no font
 * measurement), so the layout could move to compile time unchanged.
 */
import { compareNames } from "../../domain";
import type { Snapshot } from "../../domain/schema/snapshot";
import { estimateTextWidth } from "./textWidth";

export type Vec2 = [number, number];
export type LensId = "capital" | "contracts" | "industry";
export const LENS_IDS: readonly LensId[] = ["capital", "contracts", "industry"];

export const LAYOUT2D_VERSION = "proto-2";

/** World units per company row; world units equal CSS pixels at zoom 1. */
export const ROW_H = 22;
/** Company dot radius at zoom 1 (world units); the renderer clamps the on-screen size. */
export const DOT_R = 4;
/** Dot centre to label start, in CSS pixels (the renderer uses the same constant). */
export const LABEL_GAP = 8;
/** Subsector captions are drawn smaller than names (the renderer uses the same size). */
export const CAPTION_PX = 10.5;
const ITEM_GAP = 14;
const SECTOR_GAP = 70;
const RING_GAP = 90;
const INST_H = 28;
const INST_R = 7;
/** Wider than tall, like the screens the explorer runs on (semi-axis ratio² ≈ 1.35). */
const ASPECT = Math.sqrt(1.35);
/** The 3D rule for "specialist" institutions (pipeline/compile/layout.ts). */
const SPECIALIST_SHARE = 0.4;
const UNCLASSIFIED = "__unclassified";

export interface LayoutInput {
  sectors: { id: string; label: string }[];
  subsectors: { id: string; sectorId: string; label: string }[];
  companies: {
    id: string;
    name: string;
    sectorId: string;
    subsectorId: string;
    /** Documented-relationship prominence; more connected companies come first in their band. */
    weight: number;
  }[];
  /** Per lens: institutions and their related companies (company id → number of records). */
  lenses: Record<LensId, { id: string; name: string; related: Map<string, number> }[]>;
}

export interface Region {
  id: string;
  kind: "sector" | "subsector";
  label: string;
  sectorId: string;
  /** Sector: disc centre. Subsector: caption centre (top of its band). */
  x: number;
  y: number;
  /** Sector: disc radius. Subsector: half the caption width. */
  r: number;
}

export interface Layout2D {
  version: string;
  /** Companies, sector anchors (`anchor:<id>`) and subsector anchors (`subanchor:<id>`); every lens. */
  positions: Map<string, Vec2>;
  /** Institutions, per lens (an institution may sit elsewhere in another lens, as in 3D). */
  institutions: Record<LensId, Map<string, Vec2>>;
  sectors: Region[];
  subsectors: Region[];
  /** Company id → index into `sectors`. */
  sectorOf: Map<string, number>;
  /** Institution id → "hub" or "outer", per lens (for the legend and tests). */
  placement: Record<LensId, Map<string, "hub" | "outer">>;
  /** The open centre: an ellipse with semi-axes rx, ry (0 when there is no hub). */
  hub: { x: number; y: number; rx: number; ry: number };
  ms: number;
}

export interface LayoutOptions {
  /** "hub": generalists in the centre (default). "outer": every institution outside the ring. */
  institutions?: "hub" | "outer";
  /** Sector order around the ring. "taxonomy" (default) is stable as data grows. */
  order?: "taxonomy" | "affinity";
}

/** Builds the layout input from a snapshot (pure; usable in the browser, in Node and at compile time). */
export function layoutInputFromSnapshot(snap: Snapshot): LayoutInput {
  const sectors = snap.taxonomy
    .filter((t) => t.parentId === null)
    .map((t) => ({ id: t.id, label: t.label }));
  const sectorIds = new Set(sectors.map((s) => s.id));
  const subsectors = snap.taxonomy
    .filter((t) => t.parentId !== null && sectorIds.has(t.parentId))
    .map((t) => ({ id: t.id, sectorId: t.parentId!, label: t.label }));
  const companies = snap.organizations
    .filter((o) => o.scope === "universe")
    .map((o) => ({
      id: o.id,
      name: o.name,
      sectorId: o.segment.value?.sectorId ?? UNCLASSIFIED,
      subsectorId: o.segment.value?.id ?? UNCLASSIFIED,
      weight: o.weight,
    }));
  if (companies.some((c) => c.sectorId === UNCLASSIFIED)) {
    sectors.push({ id: UNCLASSIFIED, label: "Not yet classified" });
    subsectors.push({ id: UNCLASSIFIED, sectorId: UNCLASSIFIED, label: "Not yet classified" });
  }
  const companyIds = new Set(companies.map((c) => c.id));
  const names = new Map(snap.organizations.map((o) => [o.id, o.name]));
  const lens = (id: LensId) => {
    const l = snap.graph.lenses[id];
    const institutionIds = l.institutionIds.filter((i) => !companyIds.has(i));
    const related = new Map(institutionIds.map((i) => [i, new Map<string, number>()]));
    for (const e of l.edges) {
      for (const [a, b] of [
        [e.source, e.target],
        [e.target, e.source],
      ] as const) {
        const m = related.get(a);
        if (m && companyIds.has(b)) m.set(b, (m.get(b) ?? 0) + Math.max(1, e.recordIds.length));
      }
    }
    return institutionIds.map((i) => ({
      id: i,
      name: names.get(i) ?? i,
      related: related.get(i)!,
    }));
  };
  return {
    sectors,
    subsectors,
    companies,
    lenses: { capital: lens("capital"), contracts: lens("contracts"), industry: lens("industry") },
  };
}

const len = (x: number, y: number) => Math.hypot(x, y);

export interface SectorGroup {
  id: string;
  /** Caption width in world units; 0 = no caption row (single-subsector sectors). */
  caption: number;
  items: { id: string; width: number }[];
}

export interface PackedSector {
  /** Company id → dot centre, relative to the disc centre. */
  offsets: Map<string, Vec2>;
  /** Subsector id → caption centre, relative to the disc centre. */
  captions: Map<string, Vec2>;
  r: number;
}

/**
 * One disc per sector. Each subsector is a band: a caption row, then its companies as [dot + name]
 * items in rows, most connected first (ties by name). The smallest disc that holds everything wins.
 */
export function packSector(groups: SectorGroup[]): PackedSector {
  const itemW = (w: number) => DOT_R + 2 + LABEL_GAP + w;
  const area =
    groups.reduce(
      (s, g) => s + g.caption + g.items.reduce((t, it) => t + itemW(it.width) + ITEM_GAP, 0),
      0,
    ) * ROW_H;
  type Row = { group: number; caption: boolean; items: number[] };
  const attempt = (R: number): { rows: Row[]; total: number } | null => {
    const total = Math.max(1, Math.floor((2 * R) / ROW_H));
    const rows: Row[] = [];
    let g = 0;
    let i = 0;
    let needCaption = (groups[0]?.caption ?? 0) > 0;
    for (let k = 0; k < total && g < groups.length; k++) {
      const yc = (k + 0.5) * ROW_H - (total * ROW_H) / 2;
      const edge = Math.abs(yc) + ROW_H / 2;
      const chord = edge >= R ? 0 : 2 * Math.sqrt(R * R - edge * edge);
      const group = groups[g]!;
      if (needCaption) {
        if (chord >= group.caption) {
          rows.push({ group: g, caption: true, items: [] });
          needCaption = false;
        } else rows.push({ group: g, caption: false, items: [] });
        continue;
      }
      const row: Row = { group: g, caption: false, items: [] };
      let used = 0;
      while (i < group.items.length && used + itemW(group.items[i]!.width) <= chord) {
        row.items.push(i);
        used += itemW(group.items[i]!.width) + ITEM_GAP;
        i++;
      }
      rows.push(row);
      if (i >= group.items.length) {
        g++;
        i = 0;
        needCaption = (groups[g]?.caption ?? 0) > 0;
      }
    }
    return g < groups.length ? null : { rows, total };
  };
  if (!groups.length) return { offsets: new Map(), captions: new Map(), r: ROW_H };
  let lo = Math.max(ROW_H / 2, Math.sqrt(area / Math.PI) * 0.8);
  let hi =
    lo * 2 +
    Math.max(...groups.flatMap((g) => [g.caption, ...g.items.map((it) => itemW(it.width))]));
  while (!attempt(hi)) hi *= 1.5;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (attempt(mid)) hi = mid;
    else lo = mid;
  }
  const { rows, total } = attempt(hi)!;
  const offsets = new Map<string, Vec2>();
  const captions = new Map<string, Vec2>();
  const boxes: [number, number, number][] = []; // left, right, y
  rows.forEach((row, k) => {
    const y = (k + 0.5) * ROW_H - (total * ROW_H) / 2;
    const group = groups[row.group]!;
    if (row.caption) {
      captions.set(group.id, [0, y]);
      boxes.push([-group.caption / 2, group.caption / 2, y]);
      return;
    }
    if (!row.items.length) return;
    const width =
      row.items.reduce((s, i) => s + itemW(group.items[i]!.width), 0) +
      ITEM_GAP * (row.items.length - 1);
    let x = -width / 2;
    for (const i of row.items) {
      const w = itemW(group.items[i]!.width);
      offsets.set(group.items[i]!.id, [x + DOT_R + 2, y]);
      boxes.push([x, x + w, y]);
      x += w + ITEM_GAP;
    }
  });
  // Empty rows at the top or bottom would leave the band off-centre: centre what was used.
  const top = Math.min(...boxes.map((b) => b[2]));
  const bottom = Math.max(...boxes.map((b) => b[2]));
  const shift = -(top + bottom) / 2;
  for (const o of [...offsets.values(), ...captions.values()]) o[1] += shift;
  let r = 0;
  for (const [left, right, y] of boxes)
    for (const x of [left, right])
      for (const dy of [-ROW_H / 2, ROW_H / 2]) r = Math.max(r, len(x, y + shift + dy));
  return { offsets, captions, r: Math.max(r, ROW_H) };
}

interface Box {
  id: string;
  x: number;
  y: number;
  /** Extent left of / right of the node centre, and half height. */
  left: number;
  right: number;
  half: number;
}

/**
 * Pushes overlapping boxes apart along their smaller overlap; `constrain` runs after each pass.
 * Candidate pairs come from a sweep over the boxes sorted by left edge, so a pass costs about
 * n log n plus the overlaps, not n squared (1,000 institutions: 2 s before, see layout2d.test.ts).
 * Pair order is by original index, so results do not depend on the sweep.
 */
function relaxBoxes(boxes: Box[], iterations: number, constrain: (b: Box) => void, margin = 6) {
  const order = boxes.map((_, i) => i);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    order.sort((p, q) => boxes[p]!.x - boxes[p]!.left - (boxes[q]!.x - boxes[q]!.left) || p - q);
    const pairs: [number, number][] = [];
    for (let k = 0; k < order.length; k++) {
      const a = boxes[order[k]!]!;
      const aRight = a.x + a.right + margin;
      for (let l = k + 1; l < order.length; l++) {
        const b = boxes[order[l]!]!;
        if (b.x - b.left >= aRight) break;
        if (b.y - b.half >= a.y + a.half || a.y - a.half >= b.y + b.half) continue;
        const [i, j] = order[k]! < order[l]! ? [order[k]!, order[l]!] : [order[l]!, order[k]!];
        pairs.push([i, j]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    for (const [i, j] of pairs) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const ox =
        Math.min(a.x + a.right, b.x + b.right) - Math.max(a.x - a.left, b.x - b.left) + margin;
      const oy = Math.min(a.y + a.half, b.y + b.half) - Math.max(a.y - a.half, b.y - b.half);
      if (ox <= 0 || oy <= 0) continue;
      moved = true;
      if (oy < ox) {
        const s = (a.y < b.y || (a.y === b.y && i < j) ? -1 : 1) * (oy / 2 + 0.5);
        a.y += s;
        b.y -= s;
      } else {
        const ac = a.x + (a.right - a.left) / 2;
        const bc = b.x + (b.right - b.left) / 2;
        const s = (ac < bc || (ac === bc && i < j) ? -1 : 1) * (ox / 2 + 0.5);
        a.x += s;
        b.x -= s;
      }
    }
    boxes.forEach(constrain);
    if (!moved) break;
  }
}

/** Distance from a circle centre to the nearest point of a box. */
function boxDistance(b: Box, cx: number, cy: number) {
  const nx = Math.max(b.x - b.left, Math.min(cx, b.x + b.right));
  const ny = Math.max(b.y - b.half, Math.min(cy, b.y + b.half));
  return len(nx - cx, ny - cy);
}

function affinityOrder(input: LayoutInput, sectorOfCompany: Map<string, string>): string[] {
  const ids = input.sectors.map((s) => s.id);
  if (ids.length > 10) return ids; // brute force only for small rings
  const index = new Map(ids.map((id, i) => [id, i]));
  const sim = ids.map(() => ids.map(() => 0));
  for (const lens of LENS_IDS)
    for (const inst of input.lenses[lens]) {
      const counts = new Map<number, number>();
      for (const c of inst.related.keys()) {
        const s = index.get(sectorOfCompany.get(c) ?? "");
        if (s !== undefined) counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      for (const [a, na] of counts)
        for (const [b, nb] of counts) if (a < b) sim[a]![b]! += Math.min(na, nb);
    }
  const S = (a: number, b: number) => (a < b ? sim[a]![b]! : sim[b]![a]!);
  let best = ids.map((_, i) => i);
  let bestScore = -1;
  const permute = (arr: number[], k: number) => {
    if (k === arr.length) {
      const order = [0, ...arr];
      let score = 0;
      for (let i = 0; i < order.length; i++) score += S(order[i]!, order[(i + 1) % order.length]!);
      if (score > bestScore) {
        bestScore = score;
        best = order;
      }
      return;
    }
    for (let i = k; i < arr.length; i++) {
      [arr[k], arr[i]] = [arr[i]!, arr[k]!];
      permute(arr, k + 1);
      [arr[k], arr[i]] = [arr[i]!, arr[k]!];
    }
  };
  permute(best.slice(1), 0);
  return best.map((i) => ids[i]!);
}

/** Points along an ellipse (semi-axes a, b) by arc length, starting at the top, clockwise. */
function ellipseWalker(a: number, b: number) {
  const N = 2048;
  const pts: Vec2[] = [];
  const cum: number[] = [0];
  for (let j = 0; j <= N; j++) {
    const t = -Math.PI / 2 + (j / N) * Math.PI * 2;
    pts.push([Math.cos(t) * a, Math.sin(t) * b]);
    if (j > 0)
      cum.push(cum[j - 1]! + len(pts[j]![0] - pts[j - 1]![0], pts[j]![1] - pts[j - 1]![1]));
  }
  const perimeter = cum[N]!;
  const at = (s: number): Vec2 => {
    const target = ((s % perimeter) + perimeter) % perimeter;
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! <= target) lo = mid;
      else hi = mid;
    }
    const f = (target - cum[lo]!) / Math.max(1e-9, cum[hi]! - cum[lo]!);
    return [
      pts[lo]![0] + (pts[hi]![0] - pts[lo]![0]) * f,
      pts[lo]![1] + (pts[hi]![1] - pts[lo]![1]) * f,
    ];
  };
  return { perimeter, at };
}

/** Distance from the centre to an ellipse (semi-axes a, b) in the direction of angle t. */
const ellipseRadius = (a: number, b: number, t: number) =>
  a === 0 || b === 0 ? 0 : 1 / Math.sqrt((Math.cos(t) / a) ** 2 + (Math.sin(t) / b) ** 2);

export function computeLayout2D(input: LayoutInput, options: LayoutOptions = {}): Layout2D {
  const started = performance.now();
  const hubMode = (options.institutions ?? "hub") === "hub";
  const positions = new Map<string, Vec2>();
  const sectorOfCompany = new Map(input.companies.map((c) => [c.id, c.sectorId]));

  // 1. One disc per sector; subsectors are bands in it, names in alphabetical order.
  const bySub = new Map<string, LayoutInput["companies"]>();
  for (const c of input.companies) {
    const list = bySub.get(c.subsectorId) ?? [];
    list.push(c);
    bySub.set(c.subsectorId, list);
  }
  const ordered =
    options.order === "affinity"
      ? affinityOrder(input, sectorOfCompany).map((id) => input.sectors.find((s) => s.id === id)!)
      : input.sectors;
  const shapes = ordered
    .map((sector) => {
      const subs = input.subsectors.filter((t) => t.sectorId === sector.id && bySub.has(t.id));
      // Companies classified at sector level only, if any, form their own band.
      if (bySub.has(sector.id) && !subs.some((t) => t.id === sector.id))
        subs.push({ id: sector.id, sectorId: sector.id, label: sector.label });
      const captioned = subs.length > 1;
      const groups: SectorGroup[] = subs.map((t) => ({
        id: t.id,
        caption: captioned ? estimateTextWidth(t.label.toUpperCase(), CAPTION_PX) * 1.12 : 0,
        items: [...bySub.get(t.id)!]
          .sort(
            (a, b) => b.weight - a.weight || compareNames(a.name, b.name) || (a.id < b.id ? -1 : 1),
          )
          .map((c) => ({ id: c.id, width: estimateTextWidth(c.name) })),
      }));
      return { sector, subs, packed: packSector(groups) };
    })
    .filter((s) => s.subs.length > 0);

  // 2. Hub size: room for the generalists of the busiest lens.
  const shares = (related: Map<string, number>) => {
    const counts = new Map<string, number>();
    for (const c of related.keys()) {
      const s = sectorOfCompany.get(c);
      if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    return { total, topSector: top?.[0] ?? null, topShare: top && total ? top[1] / total : 0 };
  };
  const instRight = (name: string) => LABEL_GAP + INST_R + estimateTextWidth(name);
  let hubArea = 0;
  if (hubMode)
    for (const lens of LENS_IDS) {
      let area = 0;
      for (const inst of input.lenses[lens]) {
        const sh = shares(inst.related);
        if (sh.total === 0 || sh.topShare < SPECIALIST_SHARE)
          area += (instRight(inst.name) + INST_R + 24) * INST_H * 2.8;
      }
      hubArea = Math.max(hubArea, area);
    }
  const hubR = hubMode && hubArea > 0 ? Math.max(140, Math.sqrt(hubArea / Math.PI)) : 0;
  let hubA = hubR * ASPECT;
  let hubB = hubR / ASPECT;

  // 3. Sector ring (an ellipse) around the hub, clockwise from the top.
  const rho = shapes.map((s) => s.packed.r + ROW_H); // + room for the sector caption
  const arcNeeded = rho.reduce((a, r) => a + 2 * r + SECTOR_GAP, 0);
  const unit = ellipseWalker(ASPECT, 1 / ASPECT);
  let R = arcNeeded / unit.perimeter;
  const centres: Vec2[] = [];
  for (let attempt = 0; attempt < 80; attempt++) {
    const ring = ellipseWalker(R * ASPECT, R / ASPECT);
    const extra = (ring.perimeter - arcNeeded) / Math.max(1, shapes.length);
    let cum = 0;
    centres.length = 0;
    for (let i = 0; i < shapes.length; i++) {
      const arc = 2 * rho[i]! + SECTOR_GAP + extra;
      centres.push(shapes.length === 1 ? [0, 0] : ring.at(cum + arc / 2));
      cum += arc;
    }
    let ok = true;
    for (let i = 0; i < centres.length && ok; i++) {
      const [x, y] = centres[i]!;
      if (hubR > 0 && len(x, y) - rho[i]! < ellipseRadius(hubA, hubB, Math.atan2(y, x)) + RING_GAP)
        ok = false;
      for (let j = i + 1; j < centres.length && ok; j++)
        if (len(x - centres[j]![0], y - centres[j]![1]) < rho[i]! + rho[j]! + SECTOR_GAP * 0.5)
          ok = false;
    }
    if (ok) break;
    R *= 1.03;
  }

  // The ring's size is usually set by its circumference, which leaves more open centre than the
  // generalists need: let the hub fill most of it, so their names have room at overview zoom.
  if (hubR > 0 && centres.length > 1) {
    let k = Infinity;
    centres.forEach(([x, y], i) => {
      const t = Math.atan2(y, x);
      k = Math.min(k, (len(x, y) - rho[i]! - RING_GAP) / ellipseRadius(ASPECT, 1 / ASPECT, t));
    });
    const grown = Math.max(hubR, k * 0.92);
    hubA = grown * ASPECT;
    hubB = grown / ASPECT;
  }

  const sectors: Region[] = [];
  const subsectors: Region[] = [];
  const sectorOf = new Map<string, number>();
  shapes.forEach((shape, i) => {
    const [cx, cy] = centres[i]!;
    sectors.push({
      id: shape.sector.id,
      kind: "sector",
      label: shape.sector.label,
      sectorId: shape.sector.id,
      x: cx,
      y: cy,
      r: shape.packed.r,
    });
    positions.set(`anchor:${shape.sector.id}`, [cx, cy]);
    for (const sub of shape.subs) {
      const caption = shape.packed.captions.get(sub.id);
      const ids = bySub.get(sub.id)!.map((c) => c.id);
      // Without a caption row (one band only) the subsector anchor sits at the band's centre.
      const anchor: Vec2 = caption
        ? [cx + caption[0], cy + caption[1]]
        : [
            cx + ids.reduce((s, id) => s + shape.packed.offsets.get(id)![0], 0) / ids.length,
            cy + ids.reduce((s, id) => s + shape.packed.offsets.get(id)![1], 0) / ids.length,
          ];
      subsectors.push({
        id: sub.id,
        kind: "subsector",
        label: sub.label,
        sectorId: shape.sector.id,
        x: anchor[0],
        y: anchor[1],
        r: caption ? estimateTextWidth(sub.label.toUpperCase(), CAPTION_PX) / 2 : 0,
      });
      positions.set(`subanchor:${sub.id}`, anchor);
      for (const id of ids) {
        const o = shape.packed.offsets.get(id)!;
        positions.set(id, [cx + o[0], cy + o[1]]);
        sectorOf.set(id, i);
      }
    }
  });

  // 4. Institutions, per lens.
  const sectorIndex = new Map(sectors.map((s, i) => [s.id, i]));
  const institutions = {} as Record<LensId, Map<string, Vec2>>;
  const placement = {} as Record<LensId, Map<string, "hub" | "outer">>;
  const ringA = R * ASPECT;
  const ringB = R / ASPECT;
  for (const lens of LENS_IDS) {
    const hub: Box[] = [];
    const outer: Box[] = [];
    const where = new Map<string, "hub" | "outer">();
    const bary = new Map<string, Vec2>();
    // Sorted by id: the layout must not depend on the order institutions arrive in.
    const insts = [...input.lenses[lens]].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    for (const inst of insts) {
      let x = 0;
      let y = 0;
      let n = 0;
      for (const c of inst.related.keys()) {
        const p = positions.get(c);
        if (!p) continue;
        x += p[0];
        y += p[1];
        n++;
      }
      const b: Vec2 = n ? [x / n, y / n] : [0, 0];
      bary.set(inst.id, b);
      const sh = shares(inst.related);
      const box: Box = {
        id: inst.id,
        x: 0,
        y: 0,
        left: INST_R + 2,
        right: instRight(inst.name),
        half: INST_H / 2,
      };
      const specialist = sh.total > 0 && sh.topShare >= SPECIALIST_SHARE;
      if (hubR > 0 && !specialist) {
        hub.push(box);
        where.set(inst.id, "hub");
      } else {
        // Toward the barycentre; an institution with no placed relationships keeps a stable angle.
        const t =
          n > 0 && len(b[0], b[1]) > 1e-6
            ? Math.atan2(b[1], b[0])
            : (hashAngle(inst.id) * Math.PI) / 180;
        const top = sh.topSector ? sectorIndex.get(sh.topSector) : undefined;
        const reach =
          ellipseRadius(ringA, ringB, t) +
          (top === undefined ? Math.max(0, ...rho) : rho[top]!) +
          30;
        box.x = Math.cos(t) * reach;
        box.y = Math.sin(t) * reach;
        outer.push(box);
        where.set(inst.id, "outer");
      }
    }
    // Generalists: barycentres (relative to the ring) scaled to fill the hub, then pushed apart.
    let spread = 1e-6;
    for (const b of hub) {
      const [x, y] = bary.get(b.id)!;
      spread = Math.max(spread, len(x / ringA, y / ringB));
    }
    for (const b of hub) {
      const [x, y] = bary.get(b.id)!;
      b.x = ((x / ringA) * hubA * 0.7) / spread - (b.right - b.left) / 2;
      b.y = ((y / ringB) * hubB * 0.7) / spread;
    }
    const inHub = (b: Box) => {
      const cx = b.x + (b.right - b.left) / 2;
      const ax = Math.max(10, hubA - (b.left + b.right) / 2);
      const ay = Math.max(10, hubB - b.half);
      const k = Math.sqrt((cx / ax) ** 2 + (b.y / ay) ** 2);
      if (k > 1) {
        b.x = cx / k - (b.right - b.left) / 2;
        b.y = b.y / k;
      }
    };
    // Fewer generalists than the hub was sized for (it fits the busiest lens): spread them over it
    // by pushing apart inflated boxes, so their names have room at overview zoom too.
    const boxArea = hub.reduce((t, b) => t + (b.left + b.right) * b.half * 2, 0);
    const inflate = Math.min(
      4,
      Math.max(1, Math.sqrt((0.5 * Math.PI * hubA * hubB) / Math.max(1, boxArea))),
    );
    for (const b of hub) {
      b.left *= inflate;
      b.right *= inflate;
      b.half *= inflate;
    }
    relaxBoxes(hub, 500, inHub);
    for (const b of hub) {
      b.left /= inflate;
      b.right /= inflate;
      b.half /= inflate;
    }
    relaxBoxes(hub, 100, inHub);
    // Outer institutions: never on top of a sector or its caption.
    const clearOfSectors = (b: Box) => {
      for (let guard = 0; guard < 80; guard++) {
        const hit = sectors.some((s) => boxDistance(b, s.x, s.y) < s.r + ROW_H + 10);
        if (!hit) break;
        const d = Math.max(1e-6, len(b.x, b.y));
        b.x += (b.x / d) * 8;
        b.y += (b.y / d) * 8;
      }
    };
    outer.forEach(clearOfSectors);
    relaxBoxes(outer, 300, clearOfSectors);
    institutions[lens] = new Map([...hub, ...outer].map((b) => [b.id, [b.x, b.y] as Vec2]));
    placement[lens] = where;
  }

  return {
    version: LAYOUT2D_VERSION,
    positions,
    institutions,
    sectors,
    subsectors,
    sectorOf,
    placement,
    hub: { x: 0, y: 0, rx: hubA, ry: hubB },
    ms: performance.now() - started,
  };
}

function hashAngle(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 360;
}
