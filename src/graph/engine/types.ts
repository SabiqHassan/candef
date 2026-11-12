/**
 * ExplorerScene public contract.
 *
 * Owned by the lead architect. The engine implementation may propose changes,
 * but every change must be listed in the delegation report so the app side
 * can be integrated deliberately.
 *
 * Design rules:
 * - The engine knows nothing about companies, rounds or evidence. It renders
 *   indexed nodes and edges that the app has already resolved.
 * - Inputs are typed arrays so 3,000+ nodes / 15,000+ edges stay cheap to pass.
 * - No React. No DOM outside the host element given to the constructor.
 */

/** Visual node categories. Shapes/colors are engine concerns (see docs/DESIGN.md §2). */
export const NodeKind = {
  Company: 0,
  Investor: 1,
  Counterparty: 2,
  OtherInstitution: 3,
  /** Sector anchor: target for Capital-overview bundles; labelled, not a company. */
  Anchor: 4,
} as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

export const EdgeKind = {
  Capital: 0,
  Agreement: 1,
  /** Aggregated investor→sector-anchor bundle (Capital overview). */
  Bundle: 2,
} as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

/**
 * Relationship family: drives edge colour only (geometry comes from EdgeKind). Grants are a
 * separate family from procurement so a grant never reads as a paying customer (P-16).
 */
export const EdgeFamily = {
  Capital: 0,
  Procurement: 1,
  Grant: 2,
  Lineage: 3,
} as const;
export type EdgeFamily = (typeof EdgeFamily)[keyof typeof EdgeFamily];

export const EdgeStyle = {
  /** Every underlying record has primary / first-party evidence. */
  Solid: 0,
  /** At least one underlying record relies on independent reporting only. */
  Dashed: 1,
} as const;
export type EdgeStyle = (typeof EdgeStyle)[keyof typeof EdgeStyle];

export interface NodeBuffer {
  count: number;
  /** Stable opaque IDs (length = count). Used to preserve state across setData calls. */
  ids: readonly string[];
  /** Display labels (length = count). */
  labels: readonly string[];
  /** NodeKind per node (length = count). */
  kinds: Uint8Array;
  /** World positions, xyz interleaved (length = 3 * count). Precomputed by the app; the engine never lays out. */
  positions: Float32Array;
  /**
   * Optional relative prominence per node (length = count, default 1; typical range 0.5–3).
   * Used for node size and label priority at overview (e.g., number of documented relationships).
   * Never encodes unverified data — the app decides what it represents.
   */
  weights?: Float32Array;
  /** Optional per-node flag (length = count): 1 = label only at Region/Detail zoom (e.g. subsectors). */
  labelDetailOnly?: Uint8Array;
}

/**
 * Visual edges. The app has already aggregated parallel records per node pair;
 * one visual edge may stand for many records (`weight`).
 */
export interface EdgeBuffer {
  count: number;
  /** Node indices into the NodeBuffer. */
  source: Uint32Array;
  target: Uint32Array;
  kinds: Uint8Array; // EdgeKind
  styles: Uint8Array; // EdgeStyle
  /** Number of underlying records (≥1). May influence line weight/opacity. */
  weight: Uint16Array;
  /** Optional EdgeFamily per edge; when absent, Agreement edges are Procurement, others Capital. */
  families?: Uint8Array;
}

export interface SceneData {
  nodes: NodeBuffer;
  edges: EdgeBuffer;
}

export interface ExplorerSceneOptions {
  /** Default: matchMedia('(prefers-reduced-motion: reduce)'). When true, no camera/state tweening. */
  reducedMotion?: boolean;
  /** Default 2. */
  maxPixelRatio?: number;
  /** Maximum simultaneously visible node labels. Default 40. */
  labelBudget?: number;
  /** Screen-space edge pick tolerance in CSS px. Default 6. */
  edgePickTolerancePx?: number;
}

/** CSS pixels of the canvas covered by app overlays (side panels, header). Framing and labels avoid them. */
export interface ViewportInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Coarse camera distance band, for progressive disclosure decided by the app. */
export const ZoomLevel = {
  Overview: 0,
  Region: 1,
  Detail: 2,
} as const;
export type ZoomLevel = (typeof ZoomLevel)[keyof typeof ZoomLevel];

export interface ViewChangeEvent {
  level: ZoomLevel;
  /** Camera distance to the orbit target, world units. */
  distance: number;
}

export interface NodeClickEvent {
  index: number;
}
export interface EdgeClickEvent {
  /** Edge indices within tolerance, nearest first (depth-aware). length > 1 ⇒ the app shows a chooser. */
  candidates: number[];
}
export interface HoverEvent {
  index: number | null;
}
export interface LabelOverflowEvent {
  /** Highlighted (selected + related) nodes that are visible but could not be labelled within the budget. */
  unlabelledRelated: number;
}

export interface SceneEventMap {
  nodeClick: NodeClickEvent;
  edgeClick: EdgeClickEvent;
  /** Click on empty space (no node/edge within tolerance). */
  backgroundClick: Record<string, never>;
  hover: HoverEvent;
  labelOverflow: LabelOverflowEvent;
  contextLost: Record<string, never>;
  contextRestored: Record<string, never>;
  /** Emitted when the zoom level band changes (with hysteresis), not on every camera move. */
  viewChange: ViewChangeEvent;
}

export interface SceneStats {
  /** Total frames actually rendered since construction. */
  framesRendered: number;
  /** Draw calls in the most recent rendered frame (diagnostic only). */
  lastDrawCalls: number;
  /** CPU time of the most recent rendered frame, ms. */
  lastFrameMs: number;
  /** performance.now() of the most recent rendered frame, or null. */
  lastRenderAt: number | null;
  visibleNodes: number;
  visibleEdges: number;
  visibleLabels: number;
}

export interface ExplorerSceneApi {
  /** Replace data. Nodes whose IDs persist keep identity (highlight/selection state); new positions apply (tweened unless reducedMotion). */
  setData(data: SceneData): void;
  /** 1 = visible, 0 = filtered out (length = node count). Edges hide when either endpoint is hidden. null = all visible. */
  setVisibility(mask: Uint8Array | null): void;
  /**
   * Highlight a selection. `related` nodes stay at full intensity; all others dim.
   * Edges between the selected node and related nodes are emphasized. (null, null) clears.
   */
  setHighlight(selected: number | null, related: Uint32Array | null): void;
  /**
   * Per-edge visibility (length = edge count; 1 = shown). Combined with node visibility.
   * Lets the app switch cheaply between overview bundles and individual relationships
   * (progressive disclosure) without setData. null = all edges eligible.
   */
  setEdgeVisibility(mask: Uint8Array | null): void;
  /** Regions of the canvas hidden by overlays; reset/frame/focus centre content in the remaining area. */
  setViewportInsets(insets: ViewportInsets): void;
  /** Animate (unless reduced motion) to fit the given nodes in the unoccluded viewport. Empty = no-op. */
  frameNodes(indices: Uint32Array): void;
  setLabelsEnabled(enabled: boolean): void;
  /** Accessible text summary applied to the canvas (role="img" aria-label). */
  setDescription(text: string): void;
  focusNode(index: number): void;
  /** Fit all visible nodes to the unoccluded viewport (target: content spans ~85–90% of its limiting dimension). */
  resetCamera(): void;
  zoomBy(factor: number): void;
  on<K extends keyof SceneEventMap>(event: K, cb: (e: SceneEventMap[K]) => void): () => void;
  getStats(): SceneStats;
  dispose(): void;
}
