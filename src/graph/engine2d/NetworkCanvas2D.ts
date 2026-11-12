/**
 * 2D network renderer (prototype). Implements the same contract as the 3D engine
 * (`ExplorerSceneApi`, src/graph/engine/types.ts), so the explorer page drives both views with the
 * same scene, masks, selection and commands. Canvas 2D, no WebGL and no new dependency.
 *
 * Positions arrive in `SceneData.nodes.positions` (x, y; z is ignored), computed by layout2d.ts.
 * The map context (sector discs, subsector captions) only adds orientation; it never adds data.
 *
 * No React, like the 3D engine (ARCHITECTURE §4).
 */
import { placeLabels, type LabelCandidate } from "../engine/labels";
import { edgeCandidates, type ProjectedSegment } from "../engine/math";
import { RenderScheduler } from "../engine/scheduler";
import {
  EdgeFamily,
  EdgeKind,
  EdgeStyle,
  NodeKind,
  ZoomLevel,
  type ExplorerSceneApi,
  type ExplorerSceneOptions,
  type SceneData,
  type SceneEventMap,
  type SceneStats,
  type ViewportInsets,
} from "../engine/types";
import { CAPTION_PX, DOT_R, LABEL_GAP, ROW_H, type Region } from "./layout2d";

export interface MapContext {
  sectors: Region[];
  subsectors: Region[];
  /** Company id → [sector index, subsector index]. */
  membership: Map<string, [number, number]>;
  hub: { x: number; y: number; rx: number; ry: number };
  /** Caption for the hub, or null to leave it unlabelled. */
  hubLabel: string | null;
}

/** On-screen sizes (CSS px). */
const COMPANY_R = [2.4, 6.5] as const;
const INSTITUTION_R = [4.2, 10] as const;
const NODE_SNAP_PX = 12;
const LABEL_FONT = '12px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const LABEL_FONT_STRONG = '500 12px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const SECTOR_FONT = '600 13px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif';
const CAPTION_FONT = `500 ${CAPTION_PX}px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif`;
/** Zoom bands by absolute scale: names become readable around scale 0.75 (boxes are sized for 1). */
const DETAIL_IN = 0.72;
const DETAIL_OUT = 0.62;
const REGION_IN = 0.44;
const REGION_OUT = 0.38;
/** Company names are offered from this scale; institutions are always offered. */
const COMPANY_LABEL_SCALE = 0.42;
const SUBSECTOR_CAPTION_SCALE = 0.42;
/** Up to this many visible companies (after search or filters), every name is offered. */
const SMALL_SET = 40;
const TWEEN_MS = 420;

type Camera = { cx: number; cy: number; scale: number };

function readToken(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function rgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16,
  );
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export class NetworkCanvas2D implements ExplorerSceneApi {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scheduler: RenderScheduler;
  private readonly observer: ResizeObserver;
  private readonly listeners = new Map<keyof SceneEventMap, Set<(event: never) => void>>();
  private readonly cleanup: (() => void)[] = [];
  private readonly reduced: boolean;
  private readonly budget: number;
  private readonly tolerance: number;
  private readonly colors: {
    node: string[];
    edge: string[];
    text: string;
    text2: string;
    muted: string;
    accent: string;
    ink: string;
    territory: string;
  };
  private data: SceneData = {
    nodes: {
      count: 0,
      ids: [],
      labels: [],
      kinds: new Uint8Array(),
      positions: new Float32Array(),
    },
    edges: {
      count: 0,
      source: new Uint32Array(),
      target: new Uint32Array(),
      kinds: new Uint8Array(),
      styles: new Uint8Array(),
      weight: new Uint16Array(),
    },
  };
  private positions = new Float32Array();
  /** Per edge: start, control and end points in world units (6 floats); rebuilt when positions move. */
  private geometry: Float32Array | null = null;
  private positionTween: { start: number; from: Float32Array; to: Float32Array } | null = null;
  private context: MapContext | null = null;
  /** Per node: sector / subsector index (companies), -1 otherwise. */
  private sectorIdx = new Int32Array();
  private subsectorIdx = new Int32Array();
  /** Region index → anchor node index in the current data, or -1. */
  private sectorAnchor: number[] = [];
  private subsectorAnchor: number[] = [];
  private mask: Uint8Array | null = null;
  private edgeMask: Uint8Array | null = null;
  private selected: number | null = null;
  private related = new Set<number>();
  private hovered: number | null = null;
  private labelsEnabled = true;
  /**
   * Zoomed in, a faint line whose two ends are both off-screen is skipped (it is drawn again as
   * soon as either end is in view). Selected, hovered and bundle lines are always drawn. Public
   * only so the prototype's measurement script can compare with and without it.
   */
  cullOffscreenLines = true;
  /**
   * Faint background lines are curved (bundled through sector gates) while at most this many lines
   * are drawn; beyond it they are straight, which the browser rasterises several times faster
   * (measured at 3,000 companies: 60 fps straight, 20-30 fps curved). Highlighted lines always curve.
   * Public only so the measurement script can compare.
   */
  faintCurveLimit = 2500;
  private insets: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private width = 1;
  private height = 1;
  private dpr = 1;
  private cam: Camera = { cx: 0, cy: 0, scale: 0.3 };
  private camTween: { start: number; from: Camera; to: Camera } | null = null;
  private overviewScale = 0.3;
  private level: ZoomLevel = ZoomLevel.Overview;
  private disposed = false;
  private labelWidths: number[] = [];
  private placedLabels: { index: number; x: number; y: number; w: number; h: number }[] = [];
  private captionHits: {
    kind: "sector" | "subsector" | "hub";
    region: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }[] = [];
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: {
    id: number;
    x: number;
    y: number;
    moved: number;
    cam: Camera;
    pinch?: { distance: number; mid: { x: number; y: number }; scale: number };
  } | null = null;
  private overflow = -1;
  private levelReported = false;
  /** What the last frame drew, so picking tests exactly the lines the person sees. */
  private drawnStraightFaint = false;
  private drawnCulled = false;
  private stats: SceneStats = {
    framesRendered: 0,
    lastDrawCalls: 0,
    lastFrameMs: 0,
    lastRenderAt: null,
    visibleNodes: 0,
    visibleEdges: 0,
    visibleLabels: 0,
  };

  constructor(
    private readonly host: HTMLElement,
    options: ExplorerSceneOptions = {},
  ) {
    this.reduced =
      options.reducedMotion ?? window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.budget = Math.max(0, Math.floor(options.labelBudget ?? 240));
    this.tolerance = Math.max(0, options.edgePickTolerancePx ?? 6);
    this.dpr = Math.min(window.devicePixelRatio || 1, Math.max(0.5, options.maxPixelRatio ?? 2));
    this.colors = {
      node: [
        readToken("--company", "#a9c7e0"),
        readToken("--investor", "#cdbe9c"),
        readToken("--government", "#86b3a3"),
        readToken("--institution", "#a49fb3"),
        "#708a9d",
      ],
      edge: [
        readToken("--edge-capital", "#99b3c4"),
        readToken("--edge-procurement", "#7bb39a"),
        readToken("--edge-grant", "#c4a661"),
        readToken("--edge-lineage", "#a0a6ab"),
      ],
      text: "#d3dee8",
      text2: readToken("--text-2", "#a7b4c1"),
      muted: readToken("--text-muted", "#8391a0"),
      accent: readToken("--accent", "#8fc3ea"),
      ink: "#080c10",
      territory: "#8fc3ea",
    };
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D is unavailable.");
    this.ctx = ctx;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    this.canvas.style.cssText =
      "display:block;width:100%;height:100%;touch-action:none;outline-offset:-2px;cursor:grab";
    this.canvas.setAttribute("role", "img");
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute(
      "aria-label",
      "Entity network, 2D. Use the directory for keyboard exploration.",
    );
    this.canvas.setAttribute("aria-roledescription", "network map");
    host.appendChild(this.canvas);
    this.scheduler = new RenderScheduler(
      (cb) => requestAnimationFrame(cb),
      (id) => cancelAnimationFrame(id),
      (time) => this.frame(time),
    );
    this.listen(this.canvas, "pointerdown", this.pointerDown as EventListener);
    this.listen(this.canvas, "pointermove", this.pointerMove as EventListener);
    this.listen(this.canvas, "pointerup", this.pointerUp as EventListener);
    this.listen(this.canvas, "pointercancel", this.pointerCancel as EventListener);
    this.listen(this.canvas, "pointerleave", () => {
      if (!this.gesture) this.setHover(null);
    });
    this.listen(this.canvas, "wheel", this.wheel as EventListener, { passive: false });
    this.listen(this.canvas, "dblclick", this.doubleClick as EventListener);
    this.listen(this.canvas, "keydown", this.keyDown as EventListener);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    void document.fonts?.ready.then(() => {
      if (!this.disposed) {
        this.measureLabels();
        this.invalidate();
      }
    });
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions,
  ) {
    target.addEventListener(type, listener, options);
    this.cleanup.push(() => target.removeEventListener(type, listener, options));
  }
  private emit<K extends keyof SceneEventMap>(event: K, payload: SceneEventMap[K]) {
    for (const cb of [...(this.listeners.get(event) || [])]) cb(payload as never);
  }
  on<K extends keyof SceneEventMap>(event: K, cb: (event: SceneEventMap[K]) => void): () => void {
    if (this.disposed) return () => {};
    const set = this.listeners.get(event) || new Set();
    set.add(cb as (e: never) => void);
    this.listeners.set(event, set);
    return () => set.delete(cb as (e: never) => void);
  }
  private invalidate() {
    if (!this.disposed) this.scheduler.invalidate();
  }

  // ---- Data ---------------------------------------------------------------------------------

  /** Sector discs and captions; call before or after setData (indices are resolved by id). */
  setContext(context: MapContext | null): void {
    this.context = context;
    this.resolveContext();
    this.geometry = null;
    this.invalidate();
  }

  private resolveContext() {
    const n = this.data.nodes.count;
    this.sectorIdx = new Int32Array(n).fill(-1);
    this.subsectorIdx = new Int32Array(n).fill(-1);
    const c = this.context;
    if (!c) return;
    const index = new Map(this.data.nodes.ids.map((id, i) => [id, i]));
    this.data.nodes.ids.forEach((id, i) => {
      const m = c.membership.get(id);
      if (m) {
        this.sectorIdx[i] = m[0];
        this.subsectorIdx[i] = m[1];
      }
    });
    this.sectorAnchor = c.sectors.map((s) => index.get(`anchor:${s.id}`) ?? -1);
    this.subsectorAnchor = c.subsectors.map((s) => index.get(`subanchor:${s.id}`) ?? -1);
  }

  setData(data: SceneData): void {
    if (this.disposed) return;
    const old = this.data;
    const byId = new Map(old.nodes.ids.map((id, i) => [id, i]));
    const selectedId = this.selected === null ? null : old.nodes.ids[this.selected];
    const relatedIds = new Set([...this.related].map((i) => old.nodes.ids[i]));
    const hoveredId = this.hovered === null ? null : old.nodes.ids[this.hovered];
    const visibility = this.mask
      ? new Map(old.nodes.ids.map((id, i) => [id, this.mask![i]!]))
      : null;
    const from = new Float32Array(data.nodes.positions);
    let changed = false;
    data.nodes.ids.forEach((id, i) => {
      const prev = byId.get(id);
      if (prev === undefined) return;
      for (let j = 0; j < 2; j++) {
        const p = this.positions[prev * 3 + j]!;
        from[i * 3 + j] = p;
        changed ||= p !== data.nodes.positions[i * 3 + j];
      }
    });
    this.data = data;
    this.edgeMask = null;
    const find = (id: string | null | undefined) => {
      if (id === null || id === undefined) return null;
      const i = data.nodes.ids.indexOf(id);
      return i === -1 ? null : i;
    };
    this.selected = find(selectedId);
    this.hovered = find(hoveredId);
    this.related = new Set(data.nodes.ids.flatMap((id, i) => (relatedIds.has(id) ? [i] : [])));
    this.mask = visibility
      ? Uint8Array.from(data.nodes.ids, (id) => visibility.get(id) ?? 1)
      : null;
    this.positions = this.reduced || !changed ? new Float32Array(data.nodes.positions) : from;
    this.positionTween =
      this.reduced || !changed
        ? null
        : { start: performance.now(), from, to: new Float32Array(data.nodes.positions) };
    this.resolveContext();
    this.geometry = null;
    this.measureLabels();
    if (old.nodes.count === 0) this.fitAll(false);
    this.invalidate();
  }

  setVisibility(mask: Uint8Array | null): void {
    if (this.disposed) return;
    if (mask && mask.length !== this.data.nodes.count)
      throw new RangeError("Visibility mask length must match node count");
    this.mask = mask ? new Uint8Array(mask) : null;
    if (this.hovered !== null && !this.isVisible(this.hovered)) this.setHover(null);
    this.invalidate();
  }
  setEdgeVisibility(mask: Uint8Array | null): void {
    if (this.disposed) return;
    if (mask && mask.length !== this.data.edges.count)
      throw new RangeError("Edge visibility mask length must match edge count");
    this.edgeMask = mask ? new Uint8Array(mask) : null;
    this.invalidate();
  }
  setHighlight(selected: number | null, related: Uint32Array | null): void {
    if (this.disposed) return;
    if (selected !== null && (selected < 0 || selected >= this.data.nodes.count))
      throw new RangeError("Invalid selected node");
    const changed = selected !== this.selected;
    this.selected = selected;
    this.related = new Set(related || []);
    // A new selection is never left off-screen: pan to it (same zoom). Nothing moves otherwise.
    if (changed && selected !== null && this.isVisible(selected)) {
      // During an animation, judge against where the camera is going, and retarget from there.
      const base = this.camTween?.to ?? this.cam;
      const [x, y] = this.toScreen(
        this.positions[selected * 3]!,
        this.positions[selected * 3 + 1]!,
        base,
      );
      const v = this.viewport();
      if (
        x < v.left + 30 ||
        y < v.top + 20 ||
        x > v.left + v.width - 160 ||
        y > v.top + v.height - 20
      )
        this.moveTo({
          ...base,
          cx: this.positions[selected * 3]! + 60 / base.scale,
          cy: this.positions[selected * 3 + 1]!,
        });
    }
    this.invalidate();
  }
  setViewportInsets(insets: ViewportInsets): void {
    if (this.disposed) return;
    const before = this.viewport();
    const centre = this.toWorld(before.left + before.width / 2, before.top + before.height / 2);
    this.insets = { ...insets };
    // Keep the same world point at the optical centre of the uncovered area.
    this.cam = { ...this.cam, cx: centre[0], cy: centre[1] };
    this.invalidate();
  }
  setLabelsEnabled(enabled: boolean): void {
    this.labelsEnabled = enabled;
    this.invalidate();
  }
  setDescription(text: string): void {
    if (!this.disposed)
      this.canvas.setAttribute(
        "aria-label",
        `${text} Network map: arrow keys pan, plus and minus zoom, 0 resets the view.`,
      );
  }

  private isVisible(i: number) {
    return i >= 0 && i < this.data.nodes.count && (!this.mask || !!this.mask[i]);
  }
  private edgeVisible(e: number) {
    const a = this.data.edges.source[e]!;
    const b = this.data.edges.target[e]!;
    return (!this.edgeMask || !!this.edgeMask[e]) && this.isVisible(a) && this.isVisible(b);
  }

  // ---- Camera -------------------------------------------------------------------------------

  private viewport() {
    const left = Math.min(this.insets.left, this.width - 1);
    const top = Math.min(this.insets.top, this.height - 1);
    const width = Math.max(1, this.width - left - this.insets.right);
    const height = Math.max(1, this.height - top - this.insets.bottom);
    return { left, top, width, height };
  }
  private toScreen(x: number, y: number, cam = this.cam): [number, number] {
    const v = this.viewport();
    return [
      (x - cam.cx) * cam.scale + v.left + v.width / 2,
      (y - cam.cy) * cam.scale + v.top + v.height / 2,
    ];
  }
  private toWorld(sx: number, sy: number, cam = this.cam): [number, number] {
    const v = this.viewport();
    return [
      (sx - v.left - v.width / 2) / cam.scale + cam.cx,
      (sy - v.top - v.height / 2) / cam.scale + cam.cy,
    ];
  }
  private get minScale() {
    return this.overviewScale * 0.5;
  }
  private get maxScale() {
    return Math.max(2.4, this.overviewScale * 4);
  }
  private clampScale(s: number) {
    return Math.min(this.maxScale, Math.max(this.minScale, s));
  }
  private moveTo(to: Camera, animate = true) {
    if (this.reduced || !animate) {
      this.camTween = null;
      this.cam = to;
    } else this.camTween = { start: performance.now(), from: { ...this.cam }, to };
    this.invalidate();
  }

  /** World bounds of the given nodes, including the room their names need. */
  private bounds(indices: Iterable<number>, withRegions: boolean) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = (x: number, y: number) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };
    for (const i of indices) {
      const x = this.positions[i * 3]!;
      const y = this.positions[i * 3 + 1]!;
      const kind = this.data.nodes.kinds[i];
      if (kind === NodeKind.Anchor) continue;
      add(x - 8, y - 12);
      add(x + 12 + (this.labelWidths[i] ?? 60), y + 12);
    }
    if (withRegions && this.context)
      this.context.sectors.forEach((s, k) => {
        const anchor = this.sectorAnchor[k] ?? -1;
        if (anchor >= 0 && !this.isVisible(anchor)) return;
        add(s.x - s.r, s.y - s.r - 34);
        add(s.x + s.r, s.y + s.r);
      });
    return minX === Infinity ? null : { minX, minY, maxX, maxY };
  }
  private fit(b: { minX: number; minY: number; maxX: number; maxY: number }, cap: number) {
    const v = this.viewport();
    const scale = Math.min(
      cap,
      (v.width * 0.9) / Math.max(1, b.maxX - b.minX),
      (v.height * 0.9) / Math.max(1, b.maxY - b.minY),
    );
    return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale };
  }
  resetCamera(): void {
    if (!this.disposed) this.fitAll(true);
  }
  private fitAll(animate: boolean) {
    const visible = [...Array(this.data.nodes.count).keys()].filter((i) => this.isVisible(i));
    const b = this.bounds(visible, true);
    if (!b) return;
    const to = this.fit(b, 3);
    this.overviewScale = to.scale;
    this.moveTo({ ...to, scale: this.clampScale(to.scale) }, animate);
  }
  frameNodes(indices: Uint32Array): void {
    if (this.disposed || indices.length === 0) return;
    const b = this.bounds(
      [...indices].filter((i) => this.isVisible(i)),
      false,
    );
    if (!b) return;
    // A small group is framed at reading size, never blown up past it.
    const to = this.fit(b, 1.25);
    this.moveTo({ ...to, scale: this.clampScale(to.scale) });
  }
  focusNode(index: number): void {
    if (this.disposed || !this.isVisible(index)) return;
    const x = this.positions[index * 3]!;
    const y = this.positions[index * 3 + 1]!;
    this.moveTo({ cx: x + 40, cy: y, scale: this.clampScale(Math.max(this.cam.scale, 1.1)) });
  }
  zoomBy(factor: number): void {
    if (this.disposed || !Number.isFinite(factor) || factor <= 0) return;
    this.moveTo({ ...this.cam, scale: this.clampScale(this.cam.scale * factor) });
  }
  private zoomAt(sx: number, sy: number, factor: number, animate = false) {
    const scale = this.clampScale(this.cam.scale * factor);
    const w = this.toWorld(sx, sy);
    const v = this.viewport();
    const to = {
      scale,
      cx: w[0] - (sx - v.left - v.width / 2) / scale,
      cy: w[1] - (sy - v.top - v.height / 2) / scale,
    };
    this.moveTo(to, animate);
  }
  /** True when the view is zoomed in or panned away from the overview (used on lens switches). */
  isExploring(): boolean {
    return this.cam.scale > this.overviewScale * 1.2;
  }

  private resize() {
    if (this.disposed) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);
    this.invalidate();
  }

  private measureLabels() {
    this.ctx.font = LABEL_FONT;
    this.labelWidths = this.data.nodes.labels.map((t) => Math.ceil(this.ctx.measureText(t).width));
  }

  // ---- Geometry -----------------------------------------------------------------------------

  private nodeRadius(i: number): number {
    const kind = this.data.nodes.kinds[i]!;
    const w = Math.sqrt(this.data.nodes.weights?.[i] ?? 1);
    const s = this.cam.scale;
    const [lo, hi] = kind === NodeKind.Company ? COMPANY_R : INSTITUTION_R;
    const base = kind === NodeKind.Company ? DOT_R * w * s : 7 * w * s;
    const scaled = Math.min(hi, Math.max(lo * Math.min(1.4, w), base));
    return i === this.selected ? scaled * 1.35 : i === this.hovered ? scaled * 1.2 : scaled;
  }

  /**
   * Edge paths in world units: start, control point, end. Bundles stop at the sector's edge; single
   * relationships bend through the gate of the company's sector, so lines into one sector share a
   * path (a light form of edge bundling) instead of crossing the cluster in every direction.
   * Computed once per data or position change, never per frame.
   */
  private edgeGeometry(): Float32Array {
    if (this.geometry) return this.geometry;
    const ed = this.data.edges;
    const g = new Float32Array(ed.count * 6);
    const p = this.positions;
    const regions = this.context?.sectors;
    const anchorRegion = new Map(this.sectorAnchor.map((node, k) => [node, k]));
    for (let e = 0; e < ed.count; e++) {
      const a = ed.source[e]!;
      const b = ed.target[e]!;
      const ax = p[a * 3]!;
      const ay = p[a * 3 + 1]!;
      let bx = p[b * 3]!;
      let by = p[b * 3 + 1]!;
      let qx = (ax + bx) / 2;
      let qy = (ay + by) / 2;
      if (ed.kinds[e] === EdgeKind.Bundle) {
        const k = anchorRegion.get(b);
        const s = k === undefined ? undefined : regions?.[k];
        if (s) {
          const d = Math.hypot(ax - s.x, ay - s.y) || 1;
          bx = s.x + ((ax - s.x) / d) * (s.r + 6);
          by = s.y + ((ay - s.y) / d) * (s.r + 6);
          qx = (ax + bx) / 2;
          qy = (ay + by) / 2;
        }
      } else {
        // The company end decides the gate (either endpoint may be the company).
        const company = this.sectorIdx[b]! >= 0 ? b : this.sectorIdx[a]! >= 0 ? a : -1;
        const other = company === b ? a : b;
        const s = company >= 0 ? regions?.[this.sectorIdx[company]!] : undefined;
        if (s && this.sectorIdx[other] !== this.sectorIdx[company]) {
          const ox = p[other * 3]!;
          const oy = p[other * 3 + 1]!;
          const d = Math.hypot(ox - s.x, oy - s.y) || 1;
          qx = s.x + ((ox - s.x) / d) * s.r * 0.95;
          qy = s.y + ((oy - s.y) / d) * s.r * 0.95;
        }
      }
      g[e * 6] = ax;
      g[e * 6 + 1] = ay;
      g[e * 6 + 2] = qx;
      g[e * 6 + 3] = qy;
      g[e * 6 + 4] = bx;
      g[e * 6 + 5] = by;
    }
    this.geometry = g;
    return g;
  }

  // ---- Frame --------------------------------------------------------------------------------

  private frame(time: number): boolean {
    if (this.disposed) return false;
    const started = performance.now();
    let moving = false;
    if (this.camTween) {
      const t = Math.min(1, (time - this.camTween.start) / TWEEN_MS);
      const k = t * t * (3 - 2 * t);
      const { from, to } = this.camTween;
      const ls = Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * k;
      this.cam = {
        cx: from.cx + (to.cx - from.cx) * k,
        cy: from.cy + (to.cy - from.cy) * k,
        scale: Math.exp(ls),
      };
      if (t === 1) this.camTween = null;
      else moving = true;
    }
    if (this.positionTween) {
      const t = Math.min(1, (time - this.positionTween.start) / 300);
      const k = t * t * (3 - 2 * t);
      const tw = this.positionTween;
      for (let i = 0; i < this.positions.length; i++)
        this.positions[i] = tw.from[i]! + (tw.to[i]! - tw.from[i]!) * k;
      this.geometry = null;
      if (t === 1) this.positionTween = null;
      else moving = true;
    }
    this.updateLevel();
    this.draw();
    this.stats.framesRendered++;
    this.stats.lastRenderAt = performance.now();
    this.stats.lastFrameMs = this.stats.lastRenderAt - started;
    return moving;
  }

  private updateLevel() {
    const s = this.cam.scale;
    let next = this.level;
    if (this.level === ZoomLevel.Overview)
      next = s >= DETAIL_IN ? ZoomLevel.Detail : s >= REGION_IN ? ZoomLevel.Region : next;
    else if (this.level === ZoomLevel.Region)
      next = s >= DETAIL_IN ? ZoomLevel.Detail : s < REGION_OUT ? ZoomLevel.Overview : next;
    else next = s < REGION_OUT ? ZoomLevel.Overview : s < DETAIL_OUT ? ZoomLevel.Region : next;
    // The first frame always reports the band, so a new renderer never leaves the page believing
    // in the band of the previous one (for example after the list, or a mode change).
    if (next !== this.level || !this.levelReported) {
      this.level = next;
      this.levelReported = true;
      this.emit("viewChange", { level: next, distance: 1 / s });
    }
  }

  private draw() {
    const ctx = this.ctx;
    const { width, height } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let calls = 0;
    const scale = this.cam.scale;
    const selection = this.selected !== null;
    const margin = 40;
    const onScreen = (x: number, y: number, pad = margin) =>
      x > -pad && y > -pad && x < width + pad && y < height + pad;

    // Sector territories: a faint disc per visible sector; position meaning made visible.
    const regionVisible = this.regionVisibility();
    if (this.context) {
      ctx.fillStyle = rgba(this.colors.territory, 0.035);
      ctx.beginPath();
      this.context.sectors.forEach((s, k) => {
        if (!regionVisible.sectors[k]) return;
        const [x, y] = this.toScreen(s.x, s.y);
        const r = (s.r + 10) * scale;
        if (!onScreen(x, y, r + margin)) return;
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      });
      ctx.fill();
      calls++;
    }

    // Edges, batched by family, evidence style and emphasis (numeric keys: no per-frame strings).
    const ed = this.data.edges;
    const geo = this.edgeGeometry();
    const v = this.viewport();
    const ox = v.left + v.width / 2 - this.cam.cx * scale;
    const oy = v.top + v.height / 2 - this.cam.cy * scale;
    let visibleEdges = 0;
    for (let e = 0; e < ed.count; e++) if (this.edgeVisible(e)) visibleEdges++;
    // Context, not focus: the full set of lines stays faint until something is selected or hovered.
    const base = Math.min(0.3, 4.2 / Math.sqrt(Math.max(1, visibleEdges)));
    const batches = new Map<
      number,
      { e: number[]; width: number; alpha: number; color: string; dashed: boolean; strong: boolean }
    >();
    for (let e = 0; e < ed.count; e++) {
      if (!this.edgeVisible(e)) continue;
      const a = ed.source[e]!;
      const b = ed.target[e]!;
      const family =
        ed.families?.[e] ??
        (ed.kinds[e] === EdgeKind.Agreement ? EdgeFamily.Procurement : EdgeFamily.Capital);
      const bundle = ed.kinds[e] === EdgeKind.Bundle;
      const emphasized =
        selection &&
        ((a === this.selected && this.related.has(b)) ||
          (b === this.selected && this.related.has(a)));
      const hovered =
        !selection && this.hovered !== null && (a === this.hovered || b === this.hovered);
      const lw = Math.log2(ed.weight[e]! + 1);
      let alpha: number;
      let lineWidth: number;
      if (emphasized) {
        alpha = 0.85;
        lineWidth = 1.5;
      } else if (selection) {
        alpha = 0.035;
        lineWidth = 1;
      } else if (hovered) {
        alpha = 0.7;
        lineWidth = bundle ? 1.2 + Math.min(3, lw * 0.7) : 1.4;
      } else {
        alpha = Math.min(0.45, base * (0.8 + lw * 0.14));
        lineWidth = bundle ? 0.6 + Math.min(2.2, lw * 0.45) : 0.8;
      }
      const dashed = ed.styles[e] === EdgeStyle.Dashed;
      const qa = Math.round(alpha * 40);
      const qw = Math.round(lineWidth * 4);
      const key =
        (((family * 2 + (dashed ? 1 : 0)) * 64 + qa) * 64 + qw) * 2 +
        (emphasized || hovered ? 1 : 0);
      let batch = batches.get(key);
      if (!batch) {
        batch = {
          e: [],
          width: qw / 4,
          alpha: qa / 40,
          color: this.colors.edge[family] ?? this.colors.edge[0]!,
          dashed,
          strong: emphasized || hovered,
        };
        batches.set(key, batch);
      }
      batch.e.push(e);
    }
    // Faint first, emphasized last, so highlighted lines sit on top.
    const ordered = [...batches.values()].sort((x, y) => x.alpha - y.alpha);
    const m = 24;
    const inView = (x: number, y: number) => x > -m && y > -m && x < width + m && y < height + m;
    const cull = this.cullOffscreenLines && this.level === ZoomLevel.Detail;
    const straightFaint = visibleEdges > this.faintCurveLimit;
    this.drawnStraightFaint = straightFaint;
    this.drawnCulled = cull;
    for (const batch of ordered) {
      ctx.strokeStyle = rgba(batch.color, batch.alpha);
      ctx.lineWidth = batch.width;
      ctx.setLineDash(batch.dashed ? [4, 3] : []);
      ctx.beginPath();
      for (const e of batch.e) {
        const o = e * 6;
        const ax = geo[o]! * scale + ox;
        const ay = geo[o + 1]! * scale + oy;
        const qx = geo[o + 2]! * scale + ox;
        const qy = geo[o + 3]! * scale + oy;
        const bx = geo[o + 4]! * scale + ox;
        const by = geo[o + 5]! * scale + oy;
        if (
          (ax < 0 && qx < 0 && bx < 0) ||
          (ay < 0 && qy < 0 && by < 0) ||
          (ax > width && qx > width && bx > width) ||
          (ay > height && qy > height && by > height)
        )
          continue;
        if (
          cull &&
          !batch.strong &&
          ed.kinds[e] !== EdgeKind.Bundle &&
          !inView(ax, ay) &&
          !inView(bx, by)
        )
          continue;
        ctx.moveTo(ax, ay);
        if (straightFaint && !batch.strong) ctx.lineTo(bx, by);
        else ctx.quadraticCurveTo(qx, qy, bx, by);
      }
      ctx.stroke();
      calls++;
    }
    ctx.setLineDash([]);

    // Nodes, batched by kind and emphasis (dimmed first).
    const nd = this.data.nodes;
    let visibleNodes = 0;
    const layers: { dim: boolean; kind: number; idx: number[] }[] = [];
    const layerOf = new Map<string, { dim: boolean; kind: number; idx: number[] }>();
    for (let i = 0; i < nd.count; i++) {
      if (!this.isVisible(i)) continue;
      const kind = nd.kinds[i]!;
      if (kind === NodeKind.Anchor) continue;
      visibleNodes++;
      const dim = selection && i !== this.selected && !this.related.has(i);
      const key = `${dim ? 0 : 1}:${kind}`;
      let layer = layerOf.get(key);
      if (!layer) {
        layer = { dim, kind, idx: [] };
        layerOf.set(key, layer);
        layers.push(layer);
      }
      layer.idx.push(i);
    }
    layers.sort((a, b) => Number(b.dim) - Number(a.dim) || a.kind - b.kind);
    for (const layer of layers) {
      const color = this.colors.node[layer.kind] ?? this.colors.node[0]!;
      ctx.fillStyle = layer.dim ? rgba(color, 0.22) : color;
      ctx.beginPath();
      for (const i of layer.idx) {
        const x = this.positions[i * 3]! * scale + ox;
        const y = this.positions[i * 3 + 1]! * scale + oy;
        const r = this.nodeRadius(i);
        if (!onScreen(x, y, r + 2)) continue;
        this.shape(layer.kind, x, y, r);
      }
      ctx.fill();
      calls++;
      if (!layer.dim && layer.kind !== NodeKind.Company) {
        // Institutions get a dark rim so they stay distinct where lines converge.
        ctx.strokeStyle = this.colors.ink;
        ctx.lineWidth = 1;
        ctx.stroke();
        calls++;
      }
    }
    if (this.selected !== null && this.isVisible(this.selected)) {
      const i = this.selected;
      const [x, y] = this.toScreen(this.positions[i * 3]!, this.positions[i * 3 + 1]!);
      ctx.strokeStyle = this.colors.accent;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, this.nodeRadius(i) + 4, 0, Math.PI * 2);
      ctx.stroke();
      calls++;
    }

    // Captions: sectors always (they orient the map), subsectors once zoomed in. Their boxes are
    // reserved before node labels are placed, so names never sit on top of a caption.
    this.captionHits = [];
    // Captions stay in the uncovered area: never under the lens bar, legend or toolbar.
    // One reservation list for the hub, sector and subsector captions, so none is drawn over another.
    const taken: { x: number; y: number; w: number; h: number }[] = [];
    const clash = (r: { x: number; y: number; w: number; h: number }) =>
      taken.some((t) => r.x < t.x + t.w && r.x + r.w > t.x && r.y < t.y + t.h && r.y + r.h > t.y);
    const clear = (x: number, y: number, w: number, h: number) =>
      x >= v.left && y >= v.top && x + w <= v.left + v.width && y + h <= v.top + v.height;
    if (this.context) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      if (this.context.hubLabel && this.context.hub.rx > 0) {
        const [x, y] = this.toScreen(this.context.hub.x, this.context.hub.y - this.context.hub.ry);
        ctx.font = CAPTION_FONT;
        const text = this.context.hubLabel.toUpperCase();
        const w = ctx.measureText(text).width;
        if (clear(x - w / 2 - 4, y - 21, w + 8, 18)) {
          taken.push({ x: x - w / 2 - 4, y: y - 21, w: w + 8, h: 18 });
          this.halo(text, x, y - 12, rgba(this.colors.muted, 0.8), 3);
          this.captionHits.push({
            kind: "hub",
            region: -1,
            x: x - w / 2 - 4,
            y: y - 21,
            w: w + 8,
            h: 18,
          });
        }
      }
      ctx.font = SECTOR_FONT;
      // Largest sectors first; a caption that would overlap one already drawn moves just below its
      // disc's top edge, then is skipped (small screens). Captions stay inside the canvas.
      const order = this.context.sectors
        .map((_, k) => k)
        .sort((a, b) => this.context!.sectors[b]!.r - this.context!.sectors[a]!.r || a - b);
      for (const k of order) {
        const s = this.context.sectors[k]!;
        if (!regionVisible.sectors[k]) continue;
        const w = ctx.measureText(s.label).width;
        const [cx, top] = this.toScreen(s.x, s.y - s.r);
        if (!onScreen(cx, top, s.r * scale + margin)) continue;
        const x = Math.min(v.left + v.width - w / 2 - 6, Math.max(v.left + w / 2 + 6, cx));
        let box = null as { x: number; y: number; w: number; h: number } | null;
        for (const y of [top - 12, top + 12])
          if (
            !clash({ x: x - w / 2 - 4, y: y - 10, w: w + 8, h: 20 }) &&
            clear(x - w / 2 - 4, y - 10, w + 8, 20)
          ) {
            box = { x: x - w / 2 - 4, y: y - 10, w: w + 8, h: 20 };
            break;
          }
        if (!box) continue;
        taken.push(box);
        const dimmed = selection && !this.regionTouched(k);
        this.halo(
          s.label,
          x,
          box.y + 10,
          dimmed ? rgba(this.colors.text2, 0.45) : this.colors.text2,
          4,
        );
        this.captionHits.push({ kind: "sector", region: k, ...box });
      }
      if (scale >= SUBSECTOR_CAPTION_SCALE && this.labelsEnabled) {
        ctx.font = CAPTION_FONT;
        this.context.subsectors.forEach((s, k) => {
          if (!regionVisible.subsectors[k] || s.r === 0) return;
          const [x, y] = this.toScreen(s.x, s.y);
          if (!onScreen(x, y)) return;
          const text = s.label.toUpperCase();
          const w = ctx.measureText(text).width;
          const box = { x: x - w / 2 - 4, y: y - 9, w: w + 8, h: 18 };
          if (!clear(box.x, box.y, box.w, box.h) || clash(box)) return;
          taken.push(box);
          this.halo(text, x, y, rgba(this.colors.muted, selection ? 0.5 : 0.95), 3);
          this.captionHits.push({
            kind: "subsector",
            region: k,
            x: x - w / 2 - 4,
            y: y - 9,
            w: w + 8,
            h: 18,
          });
        });
      }
      calls++;
    }

    // Node labels: selected, hovered, related, institutions, then companies once zoomed in.
    this.drawLabels();
    this.stats.visibleNodes = visibleNodes;
    this.stats.visibleEdges = visibleEdges;
    this.stats.lastDrawCalls = calls + 1;
  }

  private halo(text: string, x: number, y: number, fill: string, width: number) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.ink;
    ctx.lineWidth = width;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  private shape(kind: number, x: number, y: number, r: number) {
    const ctx = this.ctx;
    if (kind === NodeKind.Investor) {
      ctx.moveTo(x, y - r * 1.25);
      ctx.lineTo(x + r * 1.05, y);
      ctx.lineTo(x, y + r * 1.25);
      ctx.lineTo(x - r * 1.05, y);
      ctx.closePath();
    } else if (kind === NodeKind.Counterparty) {
      const s = r * 0.9;
      ctx.rect(x - s, y - s, s * 2, s * 2);
    } else if (kind === NodeKind.OtherInstitution) {
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + r * 1.1, y + r * 0.85);
      ctx.lineTo(x - r * 1.1, y + r * 0.85);
      ctx.closePath();
    } else {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  /** A sector or subsector is shown when at least one of its companies is visible. */
  private regionVisibility() {
    const c = this.context;
    const sectors = new Uint8Array(c?.sectors.length ?? 0);
    const subsectors = new Uint8Array(c?.subsectors.length ?? 0);
    for (let i = 0; i < this.data.nodes.count; i++) {
      if (!this.isVisible(i)) continue;
      const s = this.sectorIdx[i]!;
      if (s >= 0) sectors[s] = 1;
      const t = this.subsectorIdx[i]!;
      if (t >= 0) subsectors[t] = 1;
    }
    return { sectors, subsectors };
  }
  /** Does the current selection touch this sector (selected or related company in it)? */
  private regionTouched(k: number) {
    if (this.selected !== null && this.sectorIdx[this.selected] === k) return true;
    for (const i of this.related) if (this.sectorIdx[i] === k) return true;
    return false;
  }

  private drawLabels() {
    const ctx = this.ctx;
    const v = this.viewport();
    const scale = this.cam.scale;
    const selection = this.selected !== null;
    const candidates: LabelCandidate[] = [];
    const weights = new Map<number, number>();
    if (selection)
      for (let e = 0; e < this.data.edges.count; e++) {
        if (!this.edgeVisible(e)) continue;
        const a = this.data.edges.source[e]!;
        const b = this.data.edges.target[e]!;
        const other = a === this.selected ? b : b === this.selected ? a : null;
        if (other !== null)
          weights.set(other, (weights.get(other) ?? 0) + this.data.edges.weight[e]!);
      }
    // A short result list (a search, a narrow filter) is always named, whatever the zoom.
    let shownCompanies = 0;
    for (let i = 0; i < this.data.nodes.count; i++)
      if (this.isVisible(i) && this.data.nodes.kinds[i] === NodeKind.Company) shownCompanies++;
    const nameAll = scale >= COMPANY_LABEL_SCALE || shownCompanies <= SMALL_SET;
    for (let i = 0; i < this.data.nodes.count; i++) {
      if (!this.isVisible(i)) continue;
      const kind = this.data.nodes.kinds[i]!;
      if (kind === NodeKind.Anchor) continue;
      const highlighted = i === this.selected || this.related.has(i);
      const priority =
        i === this.selected
          ? 0
          : i === this.hovered
            ? 1
            : this.related.has(i)
              ? 2
              : kind !== NodeKind.Company
                ? 3
                : 4;
      if (priority === 4 && !nameAll) continue;
      if (priority >= 3 && selection && !nameAll) continue;
      const [x, y] = this.toScreen(this.positions[i * 3]!, this.positions[i * 3 + 1]!);
      const offscreen = x < v.left || y < v.top || x > v.left + v.width || y > v.top + v.height;
      if (offscreen && !highlighted) continue;
      const r = this.nodeRadius(i);
      const w = (this.labelWidths[i] ?? 60) + 8;
      candidates.push({
        index: i,
        x: offscreen ? -1 : x + r + 2 - v.left,
        altX: offscreen ? -1 : x - r - 2 - w - v.left,
        y: y - 10 - v.top,
        width: w,
        height: 20,
        priority,
        weight: weights.get(i) || this.data.nodes.weights?.[i] || 1,
        related: highlighted,
      });
    }
    // Captions first (index -1): they are already drawn and only reserve their space.
    const reserved: LabelCandidate[] = this.captionHits.map((c) => ({
      index: -1,
      x: Math.max(0, c.x - v.left),
      y: Math.max(0, c.y - v.top),
      width: Math.min(c.w, v.width - Math.max(0, c.x - v.left)),
      height: c.h,
      priority: -1,
      weight: 0,
      related: false,
    }));
    const placed = placeLabels(
      [...reserved, ...candidates],
      this.labelsEnabled ? this.budget + reserved.length : 0,
      v.width,
      v.height,
    );
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    this.placedLabels = [];
    for (const c of placed.labels) {
      const i = c.index;
      if (i < 0) continue;
      const strong = i === this.selected || i === this.hovered;
      const dim = selection && c.priority >= 3;
      ctx.font = strong ? LABEL_FONT_STRONG : LABEL_FONT;
      const x = c.x + v.left + 4;
      const y = c.y + v.top + 10;
      const kind = this.data.nodes.kinds[i]!;
      const fill = strong
        ? "#eef4f9"
        : dim
          ? rgba(this.colors.text2, 0.4)
          : kind === NodeKind.Company
            ? this.colors.text
            : this.tint(kind);
      this.halo(this.data.nodes.labels[i]!, x, y, fill, 3.5);
      this.placedLabels.push({
        index: i,
        x: c.x + v.left,
        y: c.y + v.top,
        w: c.width,
        h: c.height,
      });
    }
    this.stats.visibleLabels = placed.labels.filter((l) => l.index >= 0).length;
    if (this.overflow !== placed.overflow) {
      this.overflow = placed.overflow;
      this.emit("labelOverflow", { unlabelledRelated: placed.overflow });
    }
  }
  /** Institution names carry a light tint of their entity colour (shape and colour still lead). */
  private tint(kind: number) {
    return kind === NodeKind.Investor
      ? "#dfd5bd"
      : kind === NodeKind.Counterparty
        ? "#b9d6cb"
        : "#cbc7d6";
  }

  // ---- Picking and input --------------------------------------------------------------------

  private pickNode(sx: number, sy: number): number | null {
    for (let k = this.placedLabels.length - 1; k >= 0; k--) {
      const l = this.placedLabels[k]!;
      if (sx >= l.x && sx <= l.x + l.w && sy >= l.y && sy <= l.y + l.h) return l.index;
    }
    let best: number | null = null;
    let bestD = Infinity;
    // Once names are shown, a company's whole reserved box (dot and name) is its target, so a
    // click inside a cluster means a company, not one of the faint lines passing under it.
    const scale = this.cam.scale;
    const boxes = scale >= COMPANY_LABEL_SCALE;
    const [wx, wy] = this.toWorld(sx, sy);
    for (let i = 0; i < this.data.nodes.count; i++) {
      if (!this.isVisible(i) || this.data.nodes.kinds[i] === NodeKind.Anchor) continue;
      if (boxes && this.data.nodes.kinds[i] === NodeKind.Company) {
        const px = this.positions[i * 3]!;
        const py = this.positions[i * 3 + 1]!;
        if (
          wx >= px - DOT_R - 2 &&
          wx <= px + LABEL_GAP + (this.labelWidths[i] ?? 60) &&
          Math.abs(wy - py) <= ROW_H / 2
        ) {
          const d = Math.hypot(wx - px, wy - py) * scale;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
          continue;
        }
      }
      const [x, y] = this.toScreen(this.positions[i * 3]!, this.positions[i * 3 + 1]!);
      const d = Math.hypot(x - sx, y - sy);
      const reach = Math.max(NODE_SNAP_PX, this.nodeRadius(i) + 4);
      // Dimmed nodes are harder to hit than highlighted ones, so a selection's neighbours win ties.
      const bias = this.selected !== null && i !== this.selected && !this.related.has(i) ? 3 : 0;
      if (d <= reach && d + bias < bestD) {
        bestD = d + bias;
        best = i;
      }
    }
    return best;
  }
  private pickCaption(sx: number, sy: number) {
    const hit = this.captionHits.find(
      (c) => c.kind !== "hub" && sx >= c.x && sx <= c.x + c.w && sy >= c.y && sy <= c.y + c.h,
    );
    return hit ? (hit as typeof hit & { kind: "sector" | "subsector" }) : null;
  }
  /** Highlighted (selected's lines) or hovered lines: always drawn, always curved. */
  private edgeStrong(e: number): boolean {
    const a = this.data.edges.source[e]!;
    const b = this.data.edges.target[e]!;
    if (this.selected !== null)
      return (
        (a === this.selected && this.related.has(b)) || (b === this.selected && this.related.has(a))
      );
    return this.hovered !== null && (a === this.hovered || b === this.hovered);
  }
  private pickEdges(sx: number, sy: number): number[] {
    const segments: ProjectedSegment[] = [];
    const m = 24;
    const inView = (p: [number, number]) =>
      p[0] > -m && p[1] > -m && p[0] < this.width + m && p[1] < this.height + m;
    for (let e = 0; e < this.data.edges.count; e++) {
      if (!this.edgeVisible(e)) continue;
      const g = this.edgeGeometry();
      const A = this.toScreen(g[e * 6]!, g[e * 6 + 1]!);
      const Q = this.toScreen(g[e * 6 + 2]!, g[e * 6 + 3]!);
      const B = this.toScreen(g[e * 6 + 4]!, g[e * 6 + 5]!);
      // Exactly what draw() drew: lines it skipped cannot be hit, straight ones are straight.
      const strong = this.edgeStrong(e);
      const bundle = this.data.edges.kinds[e] === EdgeKind.Bundle;
      if (this.drawnCulled && !strong && !bundle && !inView(A) && !inView(B)) continue;
      if (this.drawnStraightFaint && !strong) {
        if (
          Math.max(A[0], B[0]) < sx - 10 ||
          Math.min(A[0], B[0]) > sx + 10 ||
          Math.max(A[1], B[1]) < sy - 10 ||
          Math.min(A[1], B[1]) > sy + 10
        )
          continue;
        segments.push({ index: e, ax: A[0], ay: A[1], bx: B[0], by: B[1], az: 0, bz: 0 });
        continue;
      }
      if (
        Math.max(A[0], Q[0], B[0]) < sx - 10 ||
        Math.min(A[0], Q[0], B[0]) > sx + 10 ||
        Math.max(A[1], Q[1], B[1]) < sy - 10 ||
        Math.min(A[1], Q[1], B[1]) > sy + 10
      )
        continue;
      let px = A[0];
      let py = A[1];
      for (let s = 1; s <= 12; s++) {
        const t = s / 12;
        const x = (1 - t) * (1 - t) * A[0] + 2 * (1 - t) * t * Q[0] + t * t * B[0];
        const y = (1 - t) * (1 - t) * A[1] + 2 * (1 - t) * t * Q[1] + t * t * B[1];
        segments.push({ index: e, ax: px, ay: py, bx: x, by: y, az: 0, bz: 0 });
        px = x;
        py = y;
      }
    }
    return edgeCandidates(sx, sy, segments, this.tolerance);
  }
  private local(event: PointerEvent | MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private setHover(index: number | null) {
    if (index === this.hovered || this.disposed) return;
    this.hovered = index;
    this.canvas.style.cursor = index === null ? "grab" : "pointer";
    this.invalidate();
    this.emit("hover", { index });
  }
  private pointerDown = (event: PointerEvent) => {
    if (this.disposed || (event.pointerType === "mouse" && event.button !== 0)) return;
    const p = this.local(event);
    this.pointers.set(event.pointerId, p);
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is already gone (or synthetic) cannot be captured; panning still works.
    }
    this.camTween = null;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      this.gesture = {
        id: event.pointerId,
        x: p.x,
        y: p.y,
        moved: 99,
        cam: { ...this.cam },
        pinch: {
          distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          scale: this.cam.scale,
        },
      };
    } else this.gesture = { id: event.pointerId, x: p.x, y: p.y, moved: 0, cam: { ...this.cam } };
  };
  private pointerMove = (event: PointerEvent) => {
    if (this.disposed) return;
    const p = this.local(event);
    if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, p);
    const g = this.gesture;
    if (!g) {
      const caption = this.pickCaption(p.x, p.y);
      const node = this.pickNode(p.x, p.y);
      this.setHover(node);
      if (node === null) this.canvas.style.cursor = caption ? "pointer" : "grab";
      return;
    }
    if (g.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [
        { x: number; y: number },
        { x: number; y: number },
      ];
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = this.clampScale((g.pinch.scale * distance) / g.pinch.distance);
      const anchor = this.toWorld(g.pinch.mid.x, g.pinch.mid.y, g.cam);
      const v = this.viewport();
      this.cam = {
        scale,
        cx: anchor[0] - (mid.x - v.left - v.width / 2) / scale,
        cy: anchor[1] - (mid.y - v.top - v.height / 2) / scale,
      };
      this.invalidate();
      return;
    }
    if (event.pointerId !== g.id) return;
    g.moved = Math.max(g.moved, Math.hypot(p.x - g.x, p.y - g.y));
    if (g.moved >= 4) {
      this.canvas.style.cursor = "grabbing";
      this.cam = {
        scale: g.cam.scale,
        cx: g.cam.cx - (p.x - g.x) / g.cam.scale,
        cy: g.cam.cy - (p.y - g.y) / g.cam.scale,
      };
      this.invalidate();
    }
  };
  private pointerUp = (event: PointerEvent) => {
    const g = this.gesture;
    this.pointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId))
      this.canvas.releasePointerCapture(event.pointerId);
    if (!g) return;
    if (g.pinch) {
      this.endPinch();
      return;
    }
    if (event.pointerId !== g.id) return;
    this.gesture = null;
    this.canvas.style.cursor = this.hovered === null ? "grab" : "pointer";
    if (g.moved >= 5 || this.disposed) return;
    const p = this.local(event);
    this.click(p.x, p.y);
  };
  private pointerCancel = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    if (this.gesture?.pinch) this.endPinch();
    else this.gesture = null;
    this.setHover(null);
  };
  /**
   * One finger is lifted during a pinch: the remaining finger continues as a pan from the current
   * camera (not the camera captured before the pinch), and its release is not a click.
   */
  private endPinch() {
    const rest = [...this.pointers.entries()][0];
    this.gesture = rest
      ? { id: rest[0], x: rest[1].x, y: rest[1].y, moved: 99, cam: { ...this.cam } }
      : null;
  }
  private click(x: number, y: number) {
    const node = this.pickNode(x, y);
    if (node !== null) {
      this.emit("nodeClick", { index: node });
      return;
    }
    const caption = this.pickCaption(x, y);
    if (caption) {
      const anchor =
        caption.kind === "sector"
          ? this.sectorAnchor[caption.region]
          : this.subsectorAnchor[caption.region];
      if (anchor !== undefined && anchor >= 0) this.emit("nodeClick", { index: anchor });
      else this.frameRegion(caption.kind, caption.region);
      return;
    }
    const edges = this.pickEdges(x, y);
    if (edges.length) this.emit("edgeClick", { candidates: edges });
    else this.emit("backgroundClick", {});
  }
  /** Subsector captions frame their own band when the scene has no anchor node for them. */
  private frameRegion(kind: "sector" | "subsector", region: number) {
    const nodes: number[] = [];
    for (let i = 0; i < this.data.nodes.count; i++)
      if (
        (kind === "sector" ? this.sectorIdx[i] : this.subsectorIdx[i]) === region &&
        this.isVisible(i)
      )
        nodes.push(i);
    this.frameNodes(Uint32Array.from(nodes));
  }
  private wheel = (event: WheelEvent) => {
    if (this.disposed) return;
    event.preventDefault();
    const p = this.local(event);
    const delta =
      event.deltaMode === 1
        ? event.deltaY * 16
        : event.deltaMode === 2
          ? event.deltaY * 400
          : event.deltaY;
    this.camTween = null;
    this.zoomAt(p.x, p.y, Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018)));
  };
  private doubleClick = (event: MouseEvent) => {
    const p = this.local(event);
    if (this.pickNode(p.x, p.y) !== null) return;
    this.zoomAt(p.x, p.y, event.shiftKey ? 1 / 2 : 2, true);
  };
  private keyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = 80 / this.cam.scale;
    const pan = (dx: number, dy: number) =>
      this.moveTo({ ...this.cam, cx: this.cam.cx + dx, cy: this.cam.cy + dy }, false);
    let handled = true;
    if (event.key === "ArrowLeft") pan(-step, 0);
    else if (event.key === "ArrowRight") pan(step, 0);
    else if (event.key === "ArrowUp") pan(0, -step);
    else if (event.key === "ArrowDown") pan(0, step);
    else if (event.key === "+" || event.key === "=") this.zoomBy(1.3);
    else if (event.key === "-" || event.key === "_") this.zoomBy(1 / 1.3);
    else if (event.key === "0") this.resetCamera();
    else if (event.key === "Escape") this.emit("backgroundClick", {});
    else handled = false;
    if (handled) event.preventDefault();
  };

  getStats(): SceneStats {
    return { ...this.stats };
  }
  /** Prototype diagnostics: the current camera and zoom band. */
  getView() {
    return { ...this.cam, overviewScale: this.overviewScale, level: this.level };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.dispose();
    this.observer.disconnect();
    this.cleanup.forEach((fn) => fn());
    this.canvas.remove();
    this.listeners.clear();
  }
}
