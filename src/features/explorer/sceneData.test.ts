/**
 * Properties of what each lens draws (docs/ARCHITECTURE.md, TIME_VIEW.md), checked over the
 * synthetic stress snapshot: hubs, grants, procurement above and below the threshold, other
 * transfers, renamed and disputed companies. The product's rule is "graph edges only from verified
 * documented events"; these tests hold the client side of that rule.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../../../pipeline/compile/compile";
import { generateStressCorpus } from "../../../pipeline/synthetic/stress";
import { ZoomLevel } from "../../graph/engine/types";
import { indexSnapshot } from "../../domain";
import { buildLensScene, edgeMask, nodeMask, relatedNodes } from "./sceneData";

const { corpus, manifest } = generateStressCorpus({ companies: 500, seed: 21 });
const snap = compile(corpus, { today: "2026-10-13" }).snapshot!;
const ix = indexSnapshot(snap);
const THRESHOLD = snap.meta.thresholdCad;

const roundIds = new Set(snap.rounds.filter((r) => r.verification === "verified").map((r) => r.id));
const agreementById = new Map(snap.agreements.map((g) => [g.id, g]));

const capital = buildLensScene(ix, "capital");
const contracts = buildLensScene(ix, "contracts");
const industry = buildLensScene(ix, "industry");
type Scene = typeof capital;
const singles = (s: Scene) => s.edges.filter((e) => e.kind !== "bundle");

describe("lens scenes", () => {
  it("have unique node ids, valid edge endpoints and consistent incidence", () => {
    for (const s of [capital, contracts, industry]) {
      expect(new Set(s.ids).size).toBe(s.ids.length);
      const { source, target, count } = s.data.edges;
      for (let i = 0; i < count; i++) {
        expect(source[i]).toBeLessThan(s.ids.length);
        expect(target[i]).toBeLessThan(s.ids.length);
        expect(s.incident[source[i]!]).toContain(i);
        expect(s.incident[target[i]!]).toContain(i);
      }
      expect(s.incident.reduce((n, l) => n + l.length, 0)).toBe(count * 2);
    }
  });

  it("draw a company that also invests as one node, with its investor lines attached", () => {
    // Real case: a universe company is a participant in another company's round.
    const [investor, target] = ix.companies;
    const edge = {
      id: `cap:${investor!.id}|${target!.id}`,
      source: investor!.id,
      target: target!.id,
      kind: "capital" as const,
      recordIds: [],
      style: "solid" as const,
      weight: 1,
      valueCad: null,
      timeline: [],
    };
    const lenses = snap.graph.lenses;
    const both = {
      ...snap,
      graph: {
        ...snap.graph,
        positions: { ...snap.graph.positions, [`capital:${investor!.id}`]: [1, 2, 3] },
        lenses: {
          ...lenses,
          capital: {
            ...lenses.capital,
            institutionIds: [...lenses.capital.institutionIds, investor!.id],
            edges: [...lenses.capital.edges, edge],
          },
        },
      },
    } as typeof snap;
    const s = buildLensScene(indexSnapshot(both), "capital");
    expect(new Set(s.ids).size).toBe(s.ids.length);
    expect(s.ids.filter((id) => id === investor!.id)).toHaveLength(1);
    const i = s.indexOf.get(investor!.id)!;
    expect(s.incident[i]!.some((e) => s.data.edges.target[e] === s.indexOf.get(target!.id))).toBe(
      true,
    );
  });

  it("keep every company at the same place in every lens (D-07)", () => {
    const at = (s: Scene, id: string) => {
      const i = s.indexOf.get(id)!;
      return Array.from(s.data.nodes.positions.slice(i * 3, i * 3 + 3));
    };
    for (const c of ix.companies.slice(0, 80)) {
      expect(at(contracts, c.id)).toEqual(at(capital, c.id));
      expect(at(industry, c.id)).toEqual(at(capital, c.id));
    }
  });

  it("draw no relationship lines at all in the Industry lens", () => {
    expect(industry.data.edges.count).toBe(0);
  });

  it("draw every single line only from verified, published records", () => {
    expect(singles(capital).length).toBeGreaterThan(100);
    for (const e of singles(capital)) {
      expect(e.recordIds.length).toBeGreaterThan(0);
      for (const id of e.recordIds) expect(roundIds.has(id), id).toBe(true);
    }
    expect(singles(contracts).length).toBeGreaterThan(100);
    for (const e of singles(contracts)) {
      expect(e.recordIds.length).toBeGreaterThan(0);
      for (const id of e.recordIds) {
        const g = agreementById.get(id);
        expect(g, id).toBeTruthy();
        expect(g!.verification).toBe("verified");
        expect(g!.family, `${id} is not a drawable family`).not.toBe("other_transfer");
      }
    }
    for (const id of manifest.unpublishable)
      for (const s of [capital, contracts])
        expect(s.edges.some((e) => e.recordIds.includes(id))).toBe(false);
  });

  it("never draw an other transfer payment, single or bundled", () => {
    const other = new Set(manifest.otherTransfers);
    expect(other.size).toBeGreaterThan(0);
    for (const s of [capital, contracts])
      for (const e of s.edges) expect(e.recordIds.some((id) => other.has(id))).toBe(false);
  });

  it("only bundle lines that summarize drawn single lines", () => {
    for (const s of [capital, contracts]) {
      const ids = new Set(singles(s).map((e) => e.id));
      for (const b of s.edges.filter((e) => e.kind === "bundle"))
        for (const m of b.memberEdgeIds ?? []) expect(ids.has(m), m).toBe(true);
    }
  });
});

describe("what is drawn at each zoom level", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    selected: null as number | null,
    zoom: ZoomLevel.Overview as ZoomLevel,
    showGrants: true,
    thresholdCad: THRESHOLD,
    ...over,
  });
  const drawn = (s: Scene, mask: Uint8Array) => s.edges.filter((_, i) => mask[i]);

  it("Capital: bundles from far away, individual lines up close", () => {
    for (const zoom of [ZoomLevel.Overview, ZoomLevel.Region]) {
      const shown = drawn(capital, edgeMask(capital, input({ zoom })));
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every((e) => e.kind === "bundle")).toBe(true);
    }
    const detail = drawn(capital, edgeMask(capital, input({ zoom: ZoomLevel.Detail })));
    expect(detail.length).toBeGreaterThan(0);
    expect(detail.every((e) => e.kind === "capital")).toBe(true);
  });

  it("Government: procurement below the threshold is not drawn, grants follow the toggle", () => {
    const detail = drawn(contracts, edgeMask(contracts, input({ zoom: ZoomLevel.Detail })));
    for (const e of detail)
      if (e.kind === "procurement") expect(e.valueCad ?? 0).toBeGreaterThanOrEqual(THRESHOLD);
    expect(detail.some((e) => e.kind === "grant")).toBe(true);
    for (const zoom of [ZoomLevel.Overview, ZoomLevel.Detail]) {
      const off = drawn(contracts, edgeMask(contracts, input({ zoom, showGrants: false })));
      expect(off.some((e) => e.kind === "grant" || e.family === "grant")).toBe(false);
    }
  });

  it("a selection shows all of that entity's documented lines and nothing else", () => {
    const hub = contracts.indexOf.get(manifest.hubDepartment)!;
    const mask = edgeMask(contracts, input({ selected: hub, zoom: ZoomLevel.Overview }));
    const shown = drawn(contracts, mask);
    expect(shown.length).toBeGreaterThan(50);
    expect(shown.every((e) => e.kind !== "bundle")).toBe(true);
    const incident = new Set(contracts.incident[hub]);
    mask.forEach((m, i) => {
      if (m) expect(incident.has(i)).toBe(true);
    });
    // Below-threshold relationships are shown for a selected entity: nothing is hidden from it.
    expect(shown.some((e) => (e.valueCad ?? Infinity) < THRESHOLD)).toBe(true);
  });

  it("related nodes are exactly the other ends of the selected entity's single lines", () => {
    const inv = capital.indexOf.get(manifest.hubInvestor)!;
    const related = new Set(relatedNodes(capital, inv, true));
    const expected = new Set<number>();
    const { source, target } = capital.data.edges;
    for (const i of capital.incident[inv]!) {
      if (capital.edges[i]!.kind === "bundle") continue;
      expected.add(source[i] === inv ? target[i]! : source[i]!);
    }
    expect(related).toEqual(expected);
    expect(related.size).toBeGreaterThan(50);
    expect(related.has(inv)).toBe(false);
  });
});

describe("company filters and node visibility", () => {
  it("show an institution only while one of its companies is visible", () => {
    const company = ix.companies.find(
      (c) => (capital.incident[capital.indexOf.get(c.id)!] ?? []).length,
    )!;
    const mask = nodeMask(capital, new Set([company.id]), ix);
    const ci = capital.indexOf.get(company.id)!;
    expect(mask[ci]).toBe(1);
    const { source, target } = capital.data.edges;
    for (let i = 0; i < capital.ids.length; i++) {
      if (!mask[i] || i === ci || capital.anchorSector.has(i)) continue;
      const neighbours = (capital.incident[i] ?? []).map((e) =>
        source[e] === i ? target[e]! : source[e]!,
      );
      expect(neighbours.includes(ci), capital.ids[i]).toBe(true);
    }
    expect(Array.from(nodeMask(capital, new Set(), ix)).every((m) => m === 0)).toBe(true);
  });
});

describe("the time view", () => {
  const years = [2015, 2018, 2021, 2024];
  const idsAt = (year: number) =>
    new Set(
      singles(buildLensScene(ix, "capital", { mode: "began", year })).flatMap((e) => e.recordIds),
    );

  it("with 'began', only ever adds relationships as the year moves forward", () => {
    let previous = new Set<string>();
    for (const y of years) {
      const now = idsAt(y);
      for (const id of previous) expect(now.has(id), `${id} vanished by ${y}`).toBe(true);
      previous = now;
    }
  });

  it("draws a subset of the all-time network, and reports what it left out", () => {
    const all = new Set(singles(capital).flatMap((e) => e.recordIds));
    for (const y of years) {
      for (const id of idsAt(y)) expect(all.has(id)).toBe(true);
      expect(buildLensScene(ix, "capital", { mode: "began", year: y }).timeStats).not.toBeNull();
    }
    expect(buildLensScene(ix, "capital", null).timeStats).toBeNull();
  });

  it("never applies to the Industry lens", () => {
    expect(buildLensScene(ix, "industry", { mode: "began", year: 2000 }).timeStats).toBeNull();
  });

  it("bundles in a time view summarize only the lines that survive", () => {
    const s = buildLensScene(ix, "capital", { mode: "began", year: 2018 });
    const ids = new Set(singles(s).map((e) => e.id));
    for (const b of s.edges.filter((e) => e.kind === "bundle"))
      for (const m of b.memberEdgeIds ?? []) expect(ids.has(m)).toBe(true);
  });
});
