import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GpuBatches } from "./gpu";
import { validateData, edgePoint } from "./buffers";
import { clipSegment, edgeCandidates, nearestScreenPoint } from "./math";
import type { ClipPoint, ProjectedSegment } from "./math";
import { placeLabels } from "./labels";
import type { LabelCandidate } from "./labels";
import { RenderScheduler } from "./scheduler";
import { NodeKind, EdgeKind, ZoomLevel } from "./types";
import type {
  ExplorerSceneApi,
  ExplorerSceneOptions,
  SceneData,
  SceneEventMap,
  SceneStats,
  ViewportInsets,
} from "./types";

/** OrbitControls damping per frame at 60 fps; other frame rates are scaled to match in time. */
const DAMPING_AT_60FPS = 0.25;
/** Pointer snap radius for nodes when the exact ray test misses (CSS pixels). */
const NODE_SNAP_PX = 12;

export class WebGLUnavailableError extends Error {
  readonly code = "WEBGL2_UNAVAILABLE";
  constructor(options?: ErrorOptions) {
    super("WebGL2 is unavailable; use list mode.", options);
    this.name = "WebGLUnavailableError";
  }
}
const emptyData = (): SceneData => ({
  nodes: { count: 0, ids: [], labels: [], kinds: new Uint8Array(), positions: new Float32Array() },
  edges: {
    count: 0,
    source: new Uint32Array(),
    target: new Uint32Array(),
    kinds: new Uint8Array(),
    styles: new Uint8Array(),
    weight: new Uint16Array(),
  },
});
type CameraTween = {
  start: number;
  from: T.Vector3;
  to: T.Vector3;
  targetFrom: T.Vector3;
  targetTo: T.Vector3;
};
type PositionTween = { start: number; from: Float32Array; to: Float32Array };

export class ExplorerScene implements ExplorerSceneApi {
  private readonly renderer: T.WebGLRenderer;
  private readonly world = new T.Scene();
  private readonly camera = new T.PerspectiveCamera(42, 1, 0.1, 10000);
  private readonly controls: OrbitControls;
  private readonly scheduler: RenderScheduler;
  private readonly observer: ResizeObserver;
  private readonly listeners = new Map<keyof SceneEventMap, Set<(event: never) => void>>();
  private readonly cleanup: (() => void)[] = [];
  private readonly labels: HTMLDivElement[] = [];
  private labelWidths: number[] = [];
  private readonly reduced: boolean;
  private readonly budget: number;
  private readonly tolerance: number;
  private readonly originalPosition: string;
  private readonly originalCursor: string;
  private data: SceneData = emptyData();
  private positions = new Float32Array();
  private mask: Uint8Array | null = null;
  private edgeMask: Uint8Array | null = null;
  private insets: ViewportInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private overviewDistance = 350;
  private level: ZoomLevel = ZoomLevel.Overview;
  private selected: number | null = null;
  private related = new Set<number>();
  private hovered: number | null = null;
  private labelsEnabled = true;
  private labelsDirty = true;
  private gpuDirty = true;
  private disposed = false;
  private lost = false;
  private inFrame = false;
  private readonly prevCamPos = new T.Vector3();
  private readonly prevCamQuat = new T.Quaternion();
  private batches: GpuBatches | null = null;
  private width = 1;
  private height = 1;
  private cameraTween: CameraTween | null = null;
  private positionTween: PositionTween | null = null;
  private down: {
    x: number;
    y: number;
    id: number;
    maxDistance: number;
    label: number | null;
  } | null = null;
  private projectedEdges: ProjectedSegment[] | null = null;
  private overflow = -1;
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
    this.budget = Math.max(0, Math.floor(options.labelBudget ?? 40));
    this.tolerance = Math.max(0, options.edgePickTolerancePx ?? 6);
    const canvas = document.createElement("canvas");
    let context: WebGL2RenderingContext | null;
    try {
      context = canvas.getContext("webgl2", {
        alpha: true,
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch (cause) {
      throw new WebGLUnavailableError({ cause });
    }
    if (!context) throw new WebGLUnavailableError();
    try {
      this.renderer = new T.WebGLRenderer({ canvas, context, alpha: true, antialias: true });
    } catch (cause) {
      throw new WebGLUnavailableError({ cause });
    }
    this.originalPosition = host.style.position;
    this.originalCursor = host.style.cursor;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "Entity network. Use the directory for keyboard exploration.",
    );
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, Math.max(0.5, options.maxPixelRatio ?? 2)),
    );
    this.renderer.setClearColor(0x080c10, 0);
    host.appendChild(canvas);
    this.camera.position.set(0, 0, 350);
    // Integrator fix (Claude): controls listen on the host, not the canvas, so drags that start on a
    // node label still orbit. Label clicks are still resolved by this.pointerUp (labels have pointer-events).
    this.controls = new OrbitControls(this.camera, host);
    this.controls.enableDamping = !this.reduced;
    this.controls.dampingFactor = DAMPING_AT_60FPS;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 8000;
    this.scheduler = new RenderScheduler(
      (cb) => requestAnimationFrame(cb),
      (id) => cancelAnimationFrame(id),
      (time) => this.frame(time),
    );
    const change = () => {
      this.labelsDirty = true;
      this.projectedEdges = null;
      if (!this.inFrame) this.scheduler.invalidate();
    };
    this.controls.addEventListener("change", change);
    this.cleanup.push(() => this.controls.removeEventListener("change", change));
    const inputStart = () => {
      this.cameraTween = null;
    };
    this.controls.addEventListener("start", inputStart);
    this.cleanup.push(() => this.controls.removeEventListener("start", inputStart));
    for (let i = 0; i < this.budget; i++) {
      const label = document.createElement("div");
      label.className = "explorer-label";
      label.setAttribute("aria-hidden", "true");
      label.style.cssText =
        'position:absolute;left:0;top:0;display:none;box-sizing:border-box;white-space:nowrap;font:12px "IBM Plex Sans",Arial,sans-serif;line-height:20px;padding:0 4px;color:#c5d3df;background:#080c10;pointer-events:auto;cursor:pointer';
      this.labels.push(label);
      host.appendChild(label);
    }
    this.listen(host, "pointerdown", this.pointerDown as EventListener);
    this.listen(host, "pointermove", this.pointerMove as EventListener);
    this.listen(host, "pointerup", this.pointerUp as EventListener);
    this.listen(host, "pointercancel", () => {
      this.cancelPointer();
      this.setHover(null);
    });
    this.listen(host, "pointerleave", () => {
      if (!this.down) this.setHover(null);
    });
    this.listen(canvas, "webglcontextlost", (event) => {
      event.preventDefault();
      if (this.disposed) return;
      this.lost = true;
      this.scheduler.suspend();
      this.cancelPointer();
      this.labels.forEach((l) => (l.style.display = "none"));
      this.stats.visibleLabels = 0;
      this.emit("contextLost", {});
    });
    this.listen(canvas, "webglcontextrestored", () => {
      if (this.disposed) return;
      this.lost = false;
      this.batches?.dispose();
      this.batches = new GpuBatches(this.world, this.data);
      this.gpuDirty = true;
      this.labelsDirty = true;
      this.scheduler.resume();
      this.emit("contextRestored", {});
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    void document.fonts.ready.then(() => {
      if (!this.disposed) {
        this.measureLabels();
        this.invalidate();
      }
    });
  }
  private listen(target: EventTarget, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.cleanup.push(() => target.removeEventListener(type, listener));
  }
  private emit<K extends keyof SceneEventMap>(event: K, payload: SceneEventMap[K]): void {
    for (const cb of [...(this.listeners.get(event) || [])]) cb(payload as never);
  }
  on<K extends keyof SceneEventMap>(event: K, cb: (event: SceneEventMap[K]) => void): () => void {
    if (this.disposed) return () => {};
    const callbacks = this.listeners.get(event) || new Set();
    callbacks.add(cb as (e: never) => void);
    this.listeners.set(event, callbacks);
    return () => callbacks.delete(cb as (e: never) => void);
  }
  private invalidate(gpu = false): void {
    if (this.disposed) return;
    this.gpuDirty ||= gpu;
    this.labelsDirty = true;
    this.projectedEdges = null;
    this.scheduler.invalidate();
  }
  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.host.clientWidth),
      height = Math.max(1, this.host.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applyInsets();
    this.renderer.setSize(width, height, false);
    this.invalidate();
  }
  setData(data: SceneData): void {
    if (this.disposed) return;
    validateData(data);
    const old = this.data,
      byId = new Map(old.nodes.ids.map((id, i) => [id, i]));
    const selectedId = this.selected === null ? null : old.nodes.ids[this.selected];
    const relatedIds = new Set([...this.related].map((i) => old.nodes.ids[i]));
    const hoveredId = this.hovered === null ? null : old.nodes.ids[this.hovered];
    const visibility = this.mask
      ? new Map(old.nodes.ids.map((id, i) => [id, this.mask![i]!]))
      : null;
    const from = new Float32Array(data.nodes.positions);
    let changed = false;
    data.nodes.ids.forEach((id, i) => {
      const previous = byId.get(id);
      if (previous !== undefined)
        for (let j = 0; j < 3; j++) {
          const p = this.positions[previous * 3 + j]!;
          from[i * 3 + j] = p;
          changed ||= p !== data.nodes.positions[i * 3 + j];
        }
    });
    this.data = data;
    // Edges have no stable IDs in this contract; a replacement resets their eligibility.
    this.edgeMask = null;
    this.selected =
      selectedId !== null && selectedId !== undefined ? data.nodes.ids.indexOf(selectedId) : null;
    this.measureLabels();
    if (this.selected === -1) this.selected = null;
    this.related = new Set(data.nodes.ids.flatMap((id, i) => (relatedIds.has(id) ? [i] : [])));
    this.hovered =
      hoveredId !== null && hoveredId !== undefined ? data.nodes.ids.indexOf(hoveredId) : null;
    if (this.hovered === -1) this.hovered = null;
    this.mask = visibility
      ? Uint8Array.from(data.nodes.ids, (id) => visibility.get(id) ?? 1)
      : null;
    this.positions = this.reduced || !changed ? new Float32Array(data.nodes.positions) : from;
    this.positionTween =
      this.reduced || !changed
        ? null
        : { start: performance.now(), from, to: new Float32Array(data.nodes.positions) };
    this.batches?.dispose();
    this.batches = new GpuBatches(this.world, data);
    this.invalidate(true);
    if (old.nodes.count === 0) this.resetCamera();
  }
  setVisibility(mask: Uint8Array | null): void {
    if (this.disposed) return;
    if (mask && mask.length !== this.data.nodes.count)
      throw new RangeError("Visibility mask length must match node count");
    if (
      (mask === null && this.mask === null) ||
      (mask !== null && this.mask !== null && mask.every((value, i) => value === this.mask![i]))
    )
      return;
    this.mask = mask ? new Uint8Array(mask) : null;
    if (this.hovered !== null && !this.isVisible(this.hovered)) this.setHover(null);
    this.invalidate(true);
  }
  setHighlight(selected: number | null, related: Uint32Array | null): void {
    if (this.disposed) return;
    if (
      selected !== null &&
      (!Number.isInteger(selected) || selected < 0 || selected >= this.data.nodes.count)
    )
      throw new RangeError("Invalid selected node");
    for (const i of related || [])
      if (i >= this.data.nodes.count) throw new RangeError("Invalid related node");
    const nextRelated = new Set(related || []);
    if (
      selected === this.selected &&
      nextRelated.size === this.related.size &&
      [...nextRelated].every((i) => this.related.has(i))
    )
      return;
    this.selected = selected;
    this.related = nextRelated;
    this.invalidate(true);
  }
  setEdgeVisibility(mask: Uint8Array | null): void {
    if (this.disposed) return;
    if (mask && mask.length !== this.data.edges.count)
      throw new RangeError("Edge visibility mask length must match edge count");
    if (
      (mask === null && this.edgeMask === null) ||
      (mask && this.edgeMask && mask.every((v, i) => v === this.edgeMask![i]))
    )
      return;
    this.edgeMask = mask ? new Uint8Array(mask) : null;
    this.invalidate(true);
  }
  setViewportInsets(insets: ViewportInsets): void {
    if (this.disposed) return;
    for (const value of Object.values(insets))
      if (!Number.isFinite(value) || value < 0)
        throw new RangeError("Insets must be finite and nonnegative");
    if (
      (Object.keys(insets) as (keyof ViewportInsets)[]).every(
        (key) => insets[key] === this.insets[key],
      )
    )
      return;
    this.insets = { ...insets };
    this.applyInsets();
    this.invalidate();
  }
  private availableViewport() {
    const left = Math.min(this.insets.left, this.width - 1),
      top = Math.min(this.insets.top, this.height - 1);
    const width = Math.max(1, this.width - left - this.insets.right),
      height = Math.max(1, this.height - top - this.insets.bottom);
    return { left, top, width, height };
  }
  private applyInsets(): void {
    const view = this.availableViewport();
    // Shift the optical centre; the orbit target remains the data's centre.
    this.camera.setViewOffset(
      this.width,
      this.height,
      (this.width - view.width) / 2 - view.left,
      (this.height - view.height) / 2 - view.top,
      this.width,
      this.height,
    );
  }
  setLabelsEnabled(enabled: boolean): void {
    if (this.labelsEnabled === enabled || this.disposed) return;
    this.labelsEnabled = enabled;
    this.invalidate();
  }
  setDescription(text: string): void {
    if (!this.disposed) this.renderer.domElement.setAttribute("aria-label", text);
  }
  private isVisible(index: number): boolean {
    return index >= 0 && index < this.data.nodes.count && (!this.mask || !!this.mask[index]);
  }
  private moveCamera(to: T.Vector3, target: T.Vector3): void {
    if (this.disposed) return;
    // Flush any residual damping before starting a controlled transition.
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    if (this.reduced) {
      this.cameraTween = null;
      this.camera.position.copy(to);
      this.controls.target.copy(target);
      this.controls.update();
    } else
      this.cameraTween = {
        start: performance.now(),
        from: this.camera.position.clone(),
        to,
        targetFrom: this.controls.target.clone(),
        targetTo: target,
      };
    this.invalidate();
  }
  focusNode(index: number): void {
    if (this.disposed || !this.isVisible(index)) return;
    const target = new T.Vector3().fromArray(this.positions, index * 3);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.moveCamera(target.clone().addScaledVector(direction, 65), target);
  }
  resetCamera(): void {
    if (this.disposed) return;
    const indices = Uint32Array.from({ length: this.data.nodes.count }, (_, i) => i).filter((i) =>
      this.isVisible(i),
    );
    this.fitNodes(indices, true);
  }
  frameNodes(indices: Uint32Array): void {
    if (this.disposed || indices.length === 0) return;
    for (const i of indices)
      if (i >= this.data.nodes.count) throw new RangeError("Invalid framed node");
    this.fitNodes(
      indices.filter((i) => this.isVisible(i)),
      false,
    );
  }
  private fitNodes(indices: Uint32Array, overview: boolean): void {
    if (!indices.length && !overview) return;
    const direction = overview
      ? new T.Vector3(0, 0, 1)
      : this.camera.position.clone().sub(this.controls.target).normalize();
    const orientation = new T.Quaternion().setFromRotationMatrix(
      new T.Matrix4().lookAt(direction, new T.Vector3(), this.camera.up),
    );
    const inverse = orientation.clone().invert(),
      box = new T.Box3(),
      p = new T.Vector3();
    for (const i of indices)
      box.expandByPoint(p.fromArray(this.positions, i * 3).applyQuaternion(inverse));
    const centre = box.isEmpty() ? new T.Vector3() : box.getCenter(new T.Vector3());
    const view = this.availableViewport(),
      tan = Math.tan(T.MathUtils.degToRad(this.camera.fov / 2));
    const horizontal = ((tan * view.width) / this.height) * 0.88,
      vertical = ((tan * view.height) / this.height) * 0.88;
    let distance = 12;
    for (const i of indices) {
      p.fromArray(this.positions, i * 3)
        .applyQuaternion(inverse)
        .sub(centre);
      distance = Math.max(
        distance,
        p.z + Math.abs(p.x) / horizontal,
        p.z + Math.abs(p.y) / vertical,
      );
    }
    const target = centre.applyQuaternion(orientation);
    if (overview) {
      this.overviewDistance = distance;
      this.controls.maxDistance = distance * 1.65;
      this.controls.minDistance = Math.max(3, distance * 0.025);
    }
    distance = T.MathUtils.clamp(distance, this.controls.minDistance, this.controls.maxDistance);
    this.camera.far = Math.max(10000, distance * 4);
    this.camera.updateProjectionMatrix();
    this.moveCamera(target.clone().addScaledVector(direction, distance), target);
  }
  zoomBy(factor: number): void {
    if (this.disposed || !Number.isFinite(factor) || factor <= 0 || factor === 1) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.setLength(
      T.MathUtils.clamp(
        offset.length() / factor,
        this.controls.minDistance,
        this.controls.maxDistance,
      ),
    );
    this.moveCamera(this.controls.target.clone().add(offset), this.controls.target.clone());
  }
  /** CSS coordinates local to the host; useful for overlays and the standalone harness. */
  projectNode(index: number): { x: number; y: number; z: number } {
    this.camera.updateMatrixWorld();
    const p = new T.Vector3().fromArray(this.positions, index * 3).project(this.camera);
    return { x: ((p.x + 1) * this.width) / 2, y: ((1 - p.y) * this.height) / 2, z: p.z };
  }
  projectEdgeMidpoint(index: number): { x: number; y: number; z: number } {
    this.camera.updateMatrixWorld();
    const a = new T.Vector3().fromArray(
      edgePoint(
        this.positions,
        this.data.edges.source[index]!,
        this.data.edges.target[index]!,
        0.5,
        this.data.edges.kinds[index] === EdgeKind.Bundle,
      ),
    );
    a.project(this.camera);
    return { x: ((a.x + 1) * this.width) / 2, y: ((1 - a.y) * this.height) / 2, z: a.z };
  }
  private lastFrameTime: number | null = null;
  private frame(time: number): boolean {
    if (this.disposed || this.lost) return false;
    this.inFrame = true;
    const start = performance.now();
    if (this.cameraTween) {
      const t = Math.min(1, (time - this.cameraTween.start) / 520),
        blend = t * t * (3 - 2 * t),
        tw = this.cameraTween;
      this.camera.position.lerpVectors(tw.from, tw.to, blend);
      this.controls.target.lerpVectors(tw.targetFrom, tw.targetTo, blend);
      if (t === 1) this.cameraTween = null;
      this.labelsDirty = true;
      this.projectedEdges = null;
    }
    if (this.positionTween) {
      const t = Math.min(1, (time - this.positionTween.start) / 280),
        blend = t * t * (3 - 2 * t),
        tw = this.positionTween;
      for (let i = 0; i < this.positions.length; i++)
        this.positions[i] = tw.from[i]! + (tw.to[i]! - tw.from[i]!) * blend;
      if (t === 1) this.positionTween = null;
      this.gpuDirty = true;
      this.labelsDirty = true;
      this.projectedEdges = null;
    }
    // Integrator fix (Claude): OrbitControls damping reports motion until a microscopic epsilon (~0.8 s tail).
    // Stop scheduling once per-frame camera motion is below ~0.25 px, so the scene settles to zero frames.
    this.prevCamPos.copy(this.camera.position);
    this.prevCamQuat.copy(this.camera.quaternion);
    // Frame-rate-independent damping (Claude, M2): OrbitControls decays per frame, so a slow device
    // stretched the same ~30-frame tail over seconds. Scale the factor by elapsed time so the tail
    // lasts the same wall-clock time everywhere; at 60 fps this is exactly the configured 0.25.
    const dt = Math.min(250, Math.max(1000 / 240, time - (this.lastFrameTime ?? time - 1000 / 60)));
    this.lastFrameTime = time;
    this.controls.dampingFactor = 1 - Math.pow(1 - DAMPING_AT_60FPS, dt / (1000 / 60));
    let moving = this.controls.update();
    this.camera.updateMatrixWorld();
    if (moving && !this.cameraTween) {
      const distance = Math.max(1e-6, this.camera.position.distanceTo(this.controls.target));
      if (
        this.camera.position.distanceTo(this.prevCamPos) / distance < 2e-4 &&
        this.camera.quaternion.angleTo(this.prevCamQuat) < 2e-4
      )
        moving = false;
    }
    if (this.gpuDirty && this.batches) {
      this.batches.update(
        this.data,
        this.positions,
        this.mask,
        this.selected,
        this.related,
        this.hovered,
        this.edgeMask,
      );
      this.stats.visibleNodes = this.batches.visibleNodes;
      this.stats.visibleEdges = this.batches.visibleEdges;
      this.gpuDirty = false;
    }
    this.updateZoomLevel();
    if (this.batches && this.labelsDirty)
      this.batches.updateProjection(this.camera, this.width, this.height);
    if (this.labelsDirty) this.updateLabels();
    if (this.disposed || this.lost) {
      this.inFrame = false;
      return false;
    }
    this.renderer.render(this.world, this.camera);
    this.stats.framesRendered++;
    this.stats.lastDrawCalls = this.renderer.info.render.calls;
    this.stats.lastRenderAt = performance.now();
    this.stats.lastFrameMs = this.stats.lastRenderAt - start;
    this.inFrame = false;
    return moving || !!this.cameraTween || !!this.positionTween;
  }
  private updateLabels(): void {
    this.labelsDirty = false;
    const candidates: LabelCandidate[] = [],
      weights = new Map<number, number>();
    for (let e = 0; e < this.data.edges.count; e++) {
      const a = this.data.edges.source[e]!,
        b = this.data.edges.target[e]!;
      if ((this.edgeMask && !this.edgeMask[e]) || !this.isVisible(a) || !this.isVisible(b))
        continue;
      const neighbour = a === this.selected ? b : b === this.selected ? a : null;
      if (neighbour !== null)
        weights.set(neighbour, (weights.get(neighbour) || 0) + this.data.edges.weight[e]!);
    }
    const close = this.level !== ZoomLevel.Overview;
    const view = this.availableViewport();
    for (let i = 0; i < this.data.nodes.count; i++) {
      if (!this.isVisible(i)) continue;
      const highlighted = i === this.selected || this.related.has(i);
      const priority =
        i === this.selected
          ? 0
          : i === this.hovered
            ? 1
            : this.related.has(i)
              ? 2
              : this.data.nodes.kinds[i] === NodeKind.Anchor
                ? 3
                : 4;
      if (priority === 4 && !close) continue;
      // Detail-only labels (e.g. subsector anchors) appear once zoomed in, unless highlighted.
      if (priority >= 3 && !close && this.data.nodes.labelDetailOnly?.[i]) continue;
      const p = this.projectNode(i);
      // Retain offscreen highlighted candidates in overflow, but never place them.
      const behind = p.z < -1 || p.z > 1;
      candidates.push({
        index: i,
        x: behind ? -1 : p.x + 7 - view.left,
        // Near the right edge (or when crowded) the label may sit left of its node instead.
        altX: behind ? -1 : p.x - 7 - this.labelWidths[i]! - view.left,
        y: p.y - 10 - view.top,
        width: this.labelWidths[i]!,
        height: 20,
        priority,
        weight: weights.get(i) || this.data.nodes.weights?.[i] || 1,
        related: highlighted,
      });
    }
    const placed = placeLabels(
      candidates,
      this.labelsEnabled ? this.budget : 0,
      view.width,
      view.height,
    );
    this.labels.forEach((label, j) => {
      const c = placed.labels[j];
      label.style.display = c ? "block" : "none";
      if (c) {
        label.textContent = this.data.nodes.labels[c.index]!;
        label.dataset.nodeIndex = String(c.index);
        label.style.transform = `translate(${c.x + view.left}px,${c.y + view.top}px)`;
        label.style.width = `${c.width}px`;
      } else delete label.dataset.nodeIndex;
    });
    this.stats.visibleLabels = placed.labels.length;
    if (this.overflow !== placed.overflow) {
      this.overflow = placed.overflow;
      this.emit("labelOverflow", { unlabelledRelated: placed.overflow });
    }
  }
  private updateZoomLevel(): void {
    const distance = this.camera.position.distanceTo(this.controls.target),
      ratio = distance / this.overviewDistance;
    let next = this.level;
    if (this.level === ZoomLevel.Overview)
      next = ratio < 0.28 ? ZoomLevel.Detail : ratio < 0.62 ? ZoomLevel.Region : this.level;
    else if (this.level === ZoomLevel.Region)
      next = ratio > 0.72 ? ZoomLevel.Overview : ratio < 0.28 ? ZoomLevel.Detail : this.level;
    else next = ratio > 0.72 ? ZoomLevel.Overview : ratio > 0.36 ? ZoomLevel.Region : this.level;
    if (next !== this.level) {
      this.level = next;
      this.labelsDirty = true;
      this.emit("viewChange", { level: next, distance });
    }
  }
  private measureLabels(): void {
    // Off-DOM canvas, one measurement per label on data/font changes; no per-frame layout reads.
    const context = document.createElement("canvas").getContext("2d");
    if (context)
      context.font = this.labels[0]
        ? getComputedStyle(this.labels[0]).font
        : "12px Arial,sans-serif";
    this.labelWidths = this.data.nodes.labels.map(
      (text) => Math.ceil(context?.measureText(text).width ?? text.length * 12) + 8,
    );
  }
  private labelIndex(event: PointerEvent): number | null {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.classList.contains("explorer-label") &&
      this.labels.includes(target as HTMLDivElement)
    ) {
      const index = Number(target.dataset.nodeIndex);
      return this.isVisible(index) ? index : null;
    }
    return null;
  }
  private coordinates(event: PointerEvent): { x: number; y: number } {
    const rect = this.host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  private pickNode(x: number, y: number): number | null {
    if (!this.batches || this.lost || this.disposed) return null;
    this.camera.updateMatrixWorld();
    this.world.updateMatrixWorld(true);
    const ray = new T.Raycaster();
    ray.setFromCamera(
      new T.Vector2((x / this.width) * 2 - 1, 1 - (y / this.height) * 2),
      this.camera,
    );
    const hits = ray.intersectObjects(this.batches.nodes, false);
    for (const hit of hits) {
      const kind = this.batches.nodes.indexOf(
        hit.object as T.InstancedMesh<T.BufferGeometry, T.ShaderMaterial>,
      );
      const index = this.batches.nodeIndices[kind]?.[hit.instanceId ?? -1];
      const depth = hit.point.clone().project(this.camera).z;
      if (index !== undefined && this.isVisible(index) && depth >= -1 && depth <= 1) return index;
    }
    return this.snapNode(x, y);
  }
  /** Snap to the nearest drawn node within a few pixels when the ray misses (small, distant nodes). */
  private snapNode(x: number, y: number): number | null {
    const visible = (function* (scene: ExplorerScene) {
      for (let i = 0; i < scene.data.nodes.count; i++) {
        if (!scene.isVisible(i)) continue;
        const p = scene.projectNode(i);
        yield { index: i, x: p.x, y: p.y, z: p.z };
      }
    })(this);
    return nearestScreenPoint(x, y, visible, NODE_SNAP_PX);
  }
  private edgeSegments(): ProjectedSegment[] {
    if (this.projectedEdges) return this.projectedEdges;
    this.camera.updateMatrixWorld();
    const transform = new T.Matrix4().multiplyMatrices(
      this.camera.projectionMatrix,
      this.camera.matrixWorldInverse,
    );
    const p = new T.Vector4();
    const clip = (values: Float32Array, offset: number): ClipPoint => {
      p.set(values[offset]!, values[offset + 1]!, values[offset + 2]!, 1).applyMatrix4(transform);
      return [p.x, p.y, p.z, p.w];
    };
    const segments: ProjectedSegment[] = [];
    for (const buffer of this.batches?.segments ?? [])
      for (let j = 0; j < buffer.segmentIndices.length; j++) {
        const i = buffer.segmentIndices[j]!;
        const clipped = clipSegment(
          clip(buffer.positions, j * 6),
          clip(buffer.positions, j * 6 + 3),
        );
        if (!clipped) continue;
        const [v, w] = clipped;
        if (v[3] <= 0 || w[3] <= 0) continue;
        segments.push({
          index: i,
          ax: ((v[0] / v[3] + 1) * this.width) / 2,
          ay: ((1 - v[1] / v[3]) * this.height) / 2,
          bx: ((w[0] / w[3] + 1) * this.width) / 2,
          by: ((1 - w[1] / w[3]) * this.height) / 2,
          az: v[2] / v[3],
          bz: w[2] / w[3],
        });
      }
    this.projectedEdges = segments;
    return segments;
  }
  private setHover(index: number | null): void {
    if (index === this.hovered || this.disposed) return;
    this.hovered = index;
    this.host.style.cursor = index === null ? "grab" : "pointer";
    this.invalidate(true);
    this.emit("hover", { index });
  }
  private pointerDown = (event: PointerEvent): void => {
    if (this.disposed || this.lost || event.button !== 0) return;
    this.cameraTween = null;
    const label = this.labelIndex(event);
    this.down = { x: event.clientX, y: event.clientY, id: event.pointerId, maxDistance: 0, label };
    // OrbitControls owns host capture for orbit drags, including its pointercancel lifecycle.
    if (label !== null) this.host.setPointerCapture(event.pointerId);
  };
  private pointerMove = (event: PointerEvent): void => {
    if (this.disposed || this.lost) return;
    if (this.down) {
      this.down.maxDistance = Math.max(
        this.down.maxDistance,
        Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y),
      );
      return;
    }
    const p = this.coordinates(event);
    this.setHover(this.labelIndex(event) ?? this.pickNode(p.x, p.y));
  };
  private pointerUp = (event: PointerEvent): void => {
    const down = this.down;
    if (!down || down.id !== event.pointerId) return;
    this.down = null;
    if (this.host.hasPointerCapture(event.pointerId))
      this.host.releasePointerCapture(event.pointerId);
    if (
      this.disposed ||
      this.lost ||
      Math.max(down.maxDistance, Math.hypot(event.clientX - down.x, event.clientY - down.y)) >= 5
    )
      return;
    const p = this.coordinates(event),
      node = down.label ?? this.pickNode(p.x, p.y);
    if (node !== null && this.isVisible(node)) {
      this.emit("nodeClick", { index: node });
      return;
    }
    const edges = edgeCandidates(p.x, p.y, this.edgeSegments(), this.tolerance);
    if (edges.length) this.emit("edgeClick", { candidates: edges });
    else this.emit("backgroundClick", {});
  };
  private cancelPointer(): void {
    const down = this.down;
    this.down = null;
    if (!down) return;
    if (this.host.hasPointerCapture(down.id)) this.host.releasePointerCapture(down.id);
    const canvas = this.renderer.domElement;
    // Cancel an in-flight OrbitControls gesture as well as pointer-only labels.
    if (canvas.hasPointerCapture(down.id))
      canvas.dispatchEvent(
        new PointerEvent("pointercancel", { pointerId: down.id, bubbles: true }),
      );
  }
  getStats(): SceneStats {
    return { ...this.stats };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.dispose();
    this.observer.disconnect();
    this.cancelPointer();
    this.cleanup.forEach((fn) => fn());
    this.controls.dispose();
    this.batches?.dispose();
    this.batches = null;
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.forEach((l) => l.remove());
    this.labels.length = 0;
    this.listeners.clear();
    this.host.style.position = this.originalPosition;
    this.host.style.cursor = this.originalCursor;
    this.cameraTween = null;
    this.positionTween = null;
    this.stats.visibleLabels = 0;
  }
}
