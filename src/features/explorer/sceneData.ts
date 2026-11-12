/**
 * Snapshot → renderer buffers, per lens, plus progressive-disclosure rules (M1-B readability).
 *
 * Disclosure policy (what is drawn, never what exists):
 * - Capital, overview/region zoom: investor→sector bundles only. Detail zoom: individual edges.
 * - Government, overview/region zoom: counterparty→sector bundles, procurement and grants kept
 *   separate. Detail zoom: procurement edges at or above the CA$ threshold (P-16), plus grants.
 *   A procurement bundle is drawn only if it contains an above-threshold relationship.
 *   Grants (edges and bundles) follow the grants toggle.
 * - Any selection: every documented relationship of the selected entity, regardless of threshold.
 * - Industry: only verified corporate lineage, on selection; position means classification.
 * - Time view (docs/TIME_VIEW.md): with a time filter, only relationships whose records fall in the
 *   selected time exist in the scene at all; bundles are recomputed from those.
 */
import {
  EdgeFamily,
  EdgeKind,
  EdgeStyle,
  NodeKind,
  ZoomLevel,
  type SceneData,
} from "../../graph/engine/types";
import type { SnapshotIndex } from "../../domain";
import type { GraphEdgeView, OrgView } from "../../domain/schema/snapshot";
import { applyTimeFilter, type TimeFilter, type TimeStats } from "../../domain/time";
import type { Lens } from "./explorerState";

export interface LensScene {
  lens: Lens;
  data: SceneData;
  ids: string[];
  indexOf: Map<string, number>;
  edges: GraphEdgeView[];
  /** node index → incident edge indices. */
  incident: number[][];
  anchorSector: Map<number, string>;
  /** Subsector anchors (Industry lens): node index → subsector id. */
  anchorSubsector: Map<number, string>;
  companyCount: number;
  institutionCount: number;
  /** What a time filter left out; null when no filter applies. */
  timeStats: TimeStats | null;
}

const ORIGIN: [number, number, number] = [0, 0, 0];

function institutionKind(o: OrgView, lens: Lens): number {
  if (lens === "capital") return NodeKind.Investor;
  if (o.kind === "government_body") return NodeKind.Counterparty;
  return NodeKind.OtherInstitution;
}

export function buildLensScene(
  ix: SnapshotIndex,
  lens: Lens,
  time: TimeFilter | null = null,
  showGrants = true,
): LensScene {
  const { snap } = ix;
  const ids: string[] = [];
  const labels: string[] = [];
  const kinds: number[] = [];
  const positions: number[] = [];
  const weights: number[] = [];
  const detailOnly: number[] = [];
  const anchorSector = new Map<number, string>();
  const anchorSubsector = new Map<number, string>();
  const add = (
    id: string,
    label: string,
    kind: number,
    pos: [number, number, number],
    weight: number,
  ) => {
    ids.push(id);
    labels.push(label);
    kinds.push(kind);
    positions.push(...pos);
    weights.push(weight);
    detailOnly.push(0);
  };

  for (const c of ix.companies)
    add(c.id, c.name, NodeKind.Company, snap.graph.positions[c.id] ?? ORIGIN, c.weight);
  // A company that also invests (or contracts) keeps its one company node; its lines attach there.
  const companyIds = new Set(ids);
  const institutionIds = snap.graph.lenses[lens].institutionIds.filter((id) => !companyIds.has(id));
  for (const id of institutionIds) {
    const o = ix.org.get(id);
    const pos = snap.graph.positions[`${lens}:${id}`];
    if (!o || !pos) continue;
    add(
      id,
      o.name,
      institutionKind(o, lens),
      pos,
      Math.min(3, 1 + (ix.portfolio.get(id)?.size ?? 0) / 12),
    );
  }
  for (const a of snap.graph.anchors) {
    anchorSector.set(ids.length, a.id.replace("anchor:", ""));
    add(a.id, a.label, NodeKind.Anchor, a.position, 1);
  }
  if (lens === "industry")
    for (const a of snap.graph.subAnchors ?? []) {
      anchorSector.set(ids.length, a.sectorId);
      anchorSubsector.set(ids.length, a.subsectorId);
      add(a.id, a.label, NodeKind.Anchor, a.position, 0.6);
      detailOnly[detailOnly.length - 1] = 1;
    }
  const indexOf = new Map(ids.map((id, i) => [id, i]));

  const lensEdges =
    lens === "capital"
      ? [...snap.graph.lenses.capital.edges, ...snap.graph.lenses.capital.bundles]
      : lens === "contracts"
        ? [...snap.graph.lenses.contracts.edges, ...snap.graph.lenses.contracts.bundles]
        : snap.graph.lenses.industry.edges;
  const timed = applyTimeFilter(lensEdges, lens === "industry" ? null : time, showGrants);
  const edges = timed.edges.filter((e) => indexOf.has(e.source) && indexOf.has(e.target));
  const n = edges.length;
  const source = new Uint32Array(n);
  const target = new Uint32Array(n);
  const ekinds = new Uint8Array(n);
  const styles = new Uint8Array(n);
  const weight = new Uint16Array(n);
  const families = new Uint8Array(n);
  const incident: number[][] = ids.map(() => []);
  edges.forEach((e, i) => {
    const s = indexOf.get(e.source)!;
    const t = indexOf.get(e.target)!;
    source[i] = s;
    target[i] = t;
    ekinds[i] =
      e.kind === "capital"
        ? EdgeKind.Capital
        : e.kind === "bundle"
          ? EdgeKind.Bundle
          : EdgeKind.Agreement;
    styles[i] = e.style === "solid" ? EdgeStyle.Solid : EdgeStyle.Dashed;
    const family = e.kind === "bundle" ? (e.family ?? "capital") : e.kind;
    families[i] =
      family === "lineage"
        ? EdgeFamily.Lineage
        : family === "grant"
          ? EdgeFamily.Grant
          : family === "procurement"
            ? EdgeFamily.Procurement
            : EdgeFamily.Capital;
    weight[i] = Math.min(65535, e.weight);
    incident[s]!.push(i);
    incident[t]!.push(i);
  });

  return {
    lens,
    ids,
    indexOf,
    edges,
    incident,
    anchorSector,
    anchorSubsector,
    companyCount: ix.companies.length,
    institutionCount: institutionIds.length,
    timeStats: timed.stats,
    data: {
      nodes: {
        count: ids.length,
        ids,
        labels,
        kinds: Uint8Array.from(kinds),
        positions: Float32Array.from(positions),
        weights: Float32Array.from(weights),
        labelDetailOnly: Uint8Array.from(detailOnly),
      },
      edges: { count: n, source, target, kinds: ekinds, styles, weight, families },
    },
  };
}

export interface DisclosureInput {
  selected: number | null;
  zoom: ZoomLevel;
  showGrants: boolean;
  thresholdCad: number;
}

export function edgeMask(scene: LensScene, input: DisclosureInput): Uint8Array {
  const mask = new Uint8Array(scene.edges.length);
  const grantOk = (e: GraphEdgeView) =>
    (e.kind !== "grant" && e.family !== "grant") || input.showGrants;
  if (input.selected !== null && !scene.anchorSector.has(input.selected)) {
    for (const i of scene.incident[input.selected] ?? []) {
      const e = scene.edges[i]!;
      if (e.kind !== "bundle" && grantOk(e)) mask[i] = 1;
    }
    return mask;
  }
  scene.edges.forEach((e, i) => {
    if (scene.lens === "capital") {
      mask[i] =
        input.zoom === ZoomLevel.Detail
          ? Number(e.kind === "capital")
          : Number(e.kind === "bundle");
    } else if (scene.lens === "contracts") {
      const detail = input.zoom === ZoomLevel.Detail;
      if ((e.kind === "bundle") === detail) return;
      if (!grantOk(e)) return;
      const isGrant = e.kind === "grant" || e.family === "grant";
      mask[i] = Number(isGrant || (e.valueCad ?? 0) >= input.thresholdCad);
    }
  });
  return mask;
}

/** Nodes related to a selection through any documented relationship in this lens. */
export function relatedNodes(scene: LensScene, selected: number, showGrants: boolean): Uint32Array {
  const out = new Set<number>();
  if (scene.anchorSector.has(selected)) return new Uint32Array();
  for (const i of scene.incident[selected] ?? []) {
    const e = scene.edges[i]!;
    if (e.kind === "bundle" || (e.kind === "grant" && !showGrants)) continue;
    const s = scene.data.edges.source[i]!;
    const t = scene.data.edges.target[i]!;
    out.add(s === selected ? t : s);
  }
  return Uint32Array.from(out);
}

/** Visibility from company filters; institutions/anchors shown only if they relate to a visible company. */
export function nodeMask(
  scene: LensScene,
  visibleCompanies: ReadonlySet<string>,
  ix: SnapshotIndex,
): Uint8Array {
  const mask = new Uint8Array(scene.ids.length);
  const visibleSectors = new Set<string>();
  const visibleSubsectors = new Set<string>();
  scene.ids.forEach((id, i) => {
    if (visibleCompanies.has(id)) {
      mask[i] = 1;
      const s = ix.org.get(id)?.segment.value?.sectorId;
      if (s) visibleSectors.add(s.replace("tax:", ""));
      const sub = ix.org.get(id)?.segment.value?.id;
      if (sub) visibleSubsectors.add(sub);
    }
  });
  scene.ids.forEach((_, i) => {
    if (mask[i]) return;
    const subsector = scene.anchorSubsector.get(i);
    if (subsector !== undefined) {
      mask[i] = Number(visibleSubsectors.has(subsector));
      return;
    }
    const anchor = scene.anchorSector.get(i);
    if (anchor !== undefined) {
      mask[i] = Number(visibleSectors.has(anchor.replace("tax:", "")));
      return;
    }
    mask[i] = Number(
      (scene.incident[i] ?? []).some((e) => {
        const ed = scene.data.edges;
        const other = ed.source[e] === i ? ed.target[e]! : ed.source[e]!;
        return visibleCompanies.has(scene.ids[other]!);
      }),
    );
  });
  return mask;
}
