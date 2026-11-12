import { describe, expect, it } from "vitest";
import { pointSegmentDistance, edgeCandidates, clipSegment, nearestScreenPoint } from "./math";
import { placeLabels } from "./labels";
import { EDGE_COLORS, buildBuffers, validateData } from "./buffers";
import { RenderScheduler } from "./scheduler";
import type { SceneData } from "./types";

const data: SceneData = {
  nodes: {
    count: 5,
    ids: ["a", "b", "c", "d", "e"],
    labels: ["a", "b", "c", "d", "e"],
    kinds: new Uint8Array([0, 1, 2, 3, 4]),
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0]),
  },
  edges: {
    count: 3,
    source: new Uint32Array([0, 0, 1]),
    target: new Uint32Array([1, 2, 4]),
    kinds: new Uint8Array([0, 1, 2]),
    styles: new Uint8Array([0, 1, 0]),
    weight: new Uint16Array([1, 4, 2]),
  },
};
describe("segment picking", () => {
  it("uses a clamped CSS-pixel distance, including zero-length segments", () => {
    expect(pointSegmentDistance(5, 3, 0, 0, 10, 0)).toEqual({ distance: 3, t: 0.5 });
    expect(pointSegmentDistance(12, 0, 0, 0, 10, 0)).toEqual({ distance: 2, t: 1 });
    expect(pointSegmentDistance(3, 4, 0, 0, 0, 0)).toEqual({ distance: 5, t: 0 });
  });
  it("returns all within tolerance by interpolated camera depth, then distance", () => {
    expect(
      edgeCandidates(
        5,
        1,
        [
          { index: 9, ax: 0, ay: 0, bx: 10, by: 0, az: 20, bz: 30 },
          { index: 2, ax: 0, ay: 2, bx: 10, by: 2, az: 4, bz: 8 },
          { index: 3, ax: 0, ay: 30, bx: 10, by: 30, az: 1, bz: 1 },
        ],
        6,
      ),
    ).toEqual([2, 9]);
  });
  it("clips near-plane crossings and rejects segments behind camera", () => {
    expect(clipSegment([0, 0, -2, 1], [0, 0, 0, 1])).toEqual([
      [0, 0, -1, 1],
      [0, 0, 0, 1],
    ]);
    expect(clipSegment([0, 0, -3, 1], [0, 0, -2, 1])).toBeNull();
  });
});
describe("buffers", () => {
  it("makes one instance group per kind and two style batches", () => {
    const b = buildBuffers(data, null, null, new Set());
    expect(b.nodes.map((n) => n.indices.length)).toEqual([1, 1, 1, 1, 1]);
    expect(b.edges.map((e) => e.indices.length)).toEqual([2, 1]);
  });
  it("colours edges by family when given, else by kind (agreement = procurement)", () => {
    const byKind = buildBuffers(data, null, null, new Set());
    const solid = byKind.edges[0]!; // edges 0 (capital) and 2 (bundle)
    expect(Array.from(solid.colors.slice(0, 3))).toEqual(EDGE_COLORS[0]!.map(Math.fround));
    expect(Array.from(byKind.edges[1]!.colors.slice(0, 3))).toEqual(
      EDGE_COLORS[1]!.map(Math.fround),
    );
    const withFamilies = buildBuffers(
      { ...data, edges: { ...data.edges, families: new Uint8Array([0, 2, 2]) } },
      null,
      null,
      new Set(),
    );
    expect(Array.from(withFamilies.edges[1]!.colors.slice(0, 3))).toEqual(
      EDGE_COLORS[2]!.map(Math.fround),
    );
    expect(() =>
      validateData({ ...data, edges: { ...data.edges, families: new Uint8Array([0, 3, 0]) } }),
    ).toThrow(RangeError);
    expect(() =>
      validateData({ ...data, edges: { ...data.edges, families: new Uint8Array([0]) } }),
    ).toThrow(RangeError);
    expect(() =>
      validateData({ ...data, nodes: { ...data.nodes, labelDetailOnly: new Uint8Array([1]) } }),
    ).toThrow(RangeError);
  });
  it("hides nodes and every edge incident to a hidden endpoint", () => {
    const b = buildBuffers(data, new Uint8Array([1, 0, 1, 1, 1]), 0, new Set([2]));
    expect(b.visibleNodes).toBe(4);
    expect(b.visibleEdges).toBe(1);
    expect(b.nodes[1]!.alpha[0]).toBe(0);
    expect(b.nodes[3]!.alpha[0]).toBeCloseTo(0.24);
    expect(b.edges[1]!.alpha[0]).toBeCloseTo(0.8);
  });
  it("combines edge eligibility with endpoint masks and curves bundle geometry", () => {
    const b = buildBuffers(
      data,
      null,
      null,
      new Set(),
      data.nodes.positions,
      new Uint8Array([0, 0, 1]),
    );
    expect(b.visibleEdges).toBe(1);
    expect(b.edges[0]!.indices).toEqual([2]);
    expect(b.edges[0]!.positions.length).toBeGreaterThan(6);
    expect(Array.from(b.edges[0]!.positions).some((p, i) => i % 3 === 1 && p !== 0)).toBe(true);
  });
  it("uses prominence and separates selected, related and background sizes", () => {
    const weighted = {
      ...data,
      nodes: { ...data.nodes, weights: new Float32Array([1, 1, 3, 1, 1]) },
    };
    const b = buildBuffers(weighted, null, 0, new Set([1]));
    expect(b.nodes[0]!.scale[0]).toBeGreaterThan(b.nodes[1]!.scale[0]!);
    expect(b.nodes[1]!.scale[0]).toBeCloseTo(1.3);
    expect(b.nodes[2]!.scale[0]).toBeGreaterThan(1);
  });
  it("reduces overview edge ink with visible density without weakening selection", () => {
    const dense = {
      ...data,
      edges: {
        count: 15000,
        source: new Uint32Array(15000),
        target: new Uint32Array(15000).fill(1),
        kinds: new Uint8Array(15000),
        styles: new Uint8Array(15000),
        weight: new Uint16Array(15000).fill(1),
      },
    };
    const all = buildBuffers(dense, null, null, new Set());
    const sparse = buildBuffers(
      dense,
      null,
      null,
      new Set(),
      dense.nodes.positions,
      Uint8Array.from({ length: 15000 }, (_, i) => Number(i < 10)),
    );
    expect(all.edges[0]!.alpha[0]!).toBeLessThan(sparse.edges[0]!.alpha[0]! / 3);
    const selected = buildBuffers(dense, null, 0, new Set([1]));
    expect(selected.edges[0]!.alpha[0]!).toBeCloseTo(0.8);
  });
  it("rejects malformed prominence instead of putting invalid matrices on the GPU", () => {
    for (const weights of [
      new Float32Array(1),
      new Float32Array([1, 1, 1, 1, NaN]),
      new Float32Array([1, 1, 1, 1, -1]),
    ])
      expect(() => validateData({ ...data, nodes: { ...data.nodes, weights } })).toThrow(
        RangeError,
      );
  });
});
describe("labels", () => {
  const candidate = (index: number, x: number, priority: number, weight = 0) => ({
    index,
    x,
    y: 20,
    width: 40,
    height: 20,
    priority,
    weight,
    related: index === 1 || index === 2,
  });
  it("honours selected/hovered/weighted-related/anchor ordering and budget", () => {
    const r = placeLabels(
      [candidate(3, 180, 3), candidate(1, 60, 2, 1), candidate(0, 0, 0), candidate(2, 120, 2, 10)],
      3,
      300,
      100,
    );
    expect(r.labels.map((l) => l.index)).toEqual([0, 2, 1]);
    expect(r.overflow).toBe(0);
  });
  it("rejects grid collisions, counts related overflow and obeys zero budget", () => {
    const c = [candidate(0, 0, 0), candidate(1, 10, 2), candidate(2, 100, 2)];
    expect(placeLabels(c, 1, 300, 100).overflow).toBe(2);
    expect(placeLabels(c, 10, 300, 100).labels.map((l) => l.index)).toEqual([0, 2]);
    expect(placeLabels(c, 0, 300, 100).labels).toHaveLength(0);
  });
  it("falls back to the left of the node when the right side runs off-view or collides", () => {
    const edge = { ...candidate(0, 280, 3), altX: 226 };
    expect(placeLabels([edge], 10, 300, 100).labels.map((l) => l.x)).toEqual([226]);
    const crowd = [candidate(0, 100, 0), { ...candidate(1, 120, 3), altX: 40 }];
    expect(placeLabels(crowd, 10, 300, 100).labels.map((l) => [l.index, l.x])).toEqual([
      [0, 100],
      [1, 40],
    ]);
    // Neither side fits: rejected and counted as related overflow.
    const stuck = [candidate(0, 100, 0), { ...candidate(1, 120, 2), altX: 110 }];
    expect(placeLabels(stuck, 10, 300, 100)).toMatchObject({ overflow: 1 });
  });
});
describe("on-demand scheduler", () => {
  it("starts idle, coalesces every invalidating input and stops when settled", () => {
    let callback: ((time: number) => void) | undefined;
    let requests = 0;
    let renders = 0;
    const s = new RenderScheduler(
      (cb) => {
        callback = cb;
        return ++requests;
      },
      () => {},
      () => {
        renders++;
        return false;
      },
    );
    expect(requests).toBe(0);
    for (const _ of [
      "camera",
      "tween",
      "data",
      "visibility",
      "highlight",
      "labels",
      "resize",
      "hover",
    ])
      s.invalidate();
    expect(requests).toBe(1);
    callback!(0);
    expect(renders).toBe(1);
    expect(requests).toBe(1);
    s.invalidate();
    expect(requests).toBe(2);
    callback!(16);
    expect(renders).toBe(2);
    s.dispose();
    s.dispose();
    s.invalidate();
    expect(requests).toBe(2);
  });
  it("continues animation and cancels a pending frame on suspend/dispose", () => {
    let cb: ((time: number) => void) | undefined;
    const cancelled: number[] = [];
    let requests = 0;
    const s = new RenderScheduler(
      (f) => {
        cb = f;
        return ++requests;
      },
      (id) => cancelled.push(id),
      () => true,
    );
    s.invalidate();
    cb!(0);
    expect(requests).toBe(2);
    s.suspend();
    expect(cancelled).toEqual([2]);
    s.invalidate();
    expect(requests).toBe(2);
    s.resume();
    expect(requests).toBe(3);
    s.dispose();
    expect(cancelled).toEqual([2, 3]);
  });
});
describe("node snapping", () => {
  const pts = [
    { index: 0, x: 100, y: 100, z: 0.5 },
    { index: 1, x: 108, y: 100, z: 0.2 },
    { index: 2, x: 300, y: 300, z: 0.1 },
    { index: 3, x: 101, y: 101, z: 2 },
  ];
  it("returns the closest drawn point within the radius", () => {
    expect(nearestScreenPoint(103, 100, pts, 12)).toBe(0);
    expect(nearestScreenPoint(107, 100, pts, 12)).toBe(1);
  });
  it("returns null outside the radius, so empty space still deselects", () => {
    expect(nearestScreenPoint(200, 200, pts, 12)).toBeNull();
    expect(nearestScreenPoint(113, 100, [pts[0]!], 12)).toBeNull();
    expect(nearestScreenPoint(112, 100, [pts[0]!], 12)).toBe(0);
  });
  it("ignores points behind the camera or beyond the far plane", () => {
    expect(nearestScreenPoint(101, 101, [pts[3]!], 12)).toBeNull();
    expect(nearestScreenPoint(101, 101, [{ index: 9, x: 101, y: 101, z: -1.5 }], 12)).toBeNull();
  });
  it("breaks distance ties by depth, then index, independent of input order", () => {
    const tie = [
      { index: 5, x: 90, y: 100, z: 0.4 },
      { index: 6, x: 110, y: 100, z: 0.1 },
      { index: 4, x: 100, y: 90, z: 0.1 },
    ];
    expect(nearestScreenPoint(100, 100, tie, 20)).toBe(4);
    expect(nearestScreenPoint(100, 100, [...tie].reverse(), 20)).toBe(4);
  });
  it("accepts any iterable, so nothing needs to be materialised", () => {
    function* gen() {
      yield { index: 1, x: 10, y: 10, z: 0 };
    }
    expect(nearestScreenPoint(12, 10, gen(), 5)).toBe(1);
  });
});
