/**
 * The 2D prototype's promises, checked on the synthetic stress snapshot (hubs, companies that
 * invest, grants, lineage): same information as the 3D scene, every node placed, names never
 * overlapping at zoom 1, positions meaning classification and identical across lenses.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../../../pipeline/compile/compile";
import { generateStressCorpus } from "../../../pipeline/synthetic/stress";
import { indexSnapshot } from "../../domain";
import { buildLensScene } from "./sceneData";
import {
  computeLayout2D,
  DOT_R,
  LABEL_GAP,
  LENS_IDS,
  layoutInputFromSnapshot,
  packSector,
  ROW_H,
} from "../../graph/engine2d/layout2d";
import { mapContext, prepare2D, sceneFor2D } from "./scene2d";
import { estimateTextWidth } from "../../graph/engine2d/textWidth";

const { corpus } = generateStressCorpus({ companies: 500, seed: 21 });
const snap = compile(corpus, { today: "2026-10-13" }).snapshot!;
const ix = indexSnapshot(snap);
const prepared = prepare2D(ix);
const { layout, input } = prepared;

describe("2D scene carries exactly the 3D scene's information", () => {
  for (const lens of LENS_IDS) {
    it(`${lens}: same nodes, labels, kinds, weights and relationships; only positions change`, () => {
      const scene = buildLensScene(ix, lens);
      const flat = sceneFor2D(scene, prepared);
      expect(flat.ids).toEqual(scene.ids);
      expect(flat.edges).toBe(scene.edges);
      expect(flat.data.edges).toBe(scene.data.edges);
      const a = scene.data.nodes;
      const b = flat.data.nodes;
      expect(b.count).toBe(a.count);
      expect(b.labels).toEqual(a.labels);
      expect([...b.kinds]).toEqual([...a.kinds]);
      expect([...(b.weights ?? [])]).toEqual([...(a.weights ?? [])]);
      expect(b.positions).not.toBe(a.positions);
    });
    it(`${lens}: every node has a 2D position`, () => {
      const scene = buildLensScene(ix, lens);
      for (const id of scene.ids)
        expect(
          layout.positions.has(id) || layout.institutions[lens].has(id),
          `${id} has no position`,
        ).toBe(true);
    });
  }
});

describe("2D layout", () => {
  it("is deterministic and independent of input order", () => {
    const again = computeLayout2D(layoutInputFromSnapshot(snap));
    const shuffled = computeLayout2D({
      ...input,
      companies: [...input.companies].reverse(),
      lenses: {
        capital: [...input.lenses.capital].reverse(),
        contracts: [...input.lenses.contracts].reverse(),
        industry: [...input.lenses.industry].reverse(),
      },
    });
    for (const c of input.companies) {
      expect(again.positions.get(c.id)).toEqual(layout.positions.get(c.id));
      expect(shuffled.positions.get(c.id)).toEqual(layout.positions.get(c.id));
    }
    for (const lens of LENS_IDS)
      for (const [id, p] of layout.institutions[lens])
        expect(again.institutions[lens].get(id)).toEqual(p);
    // Institutions too: reversing their order must not move any of them.
    for (const lens of LENS_IDS)
      for (const [id, p] of layout.institutions[lens])
        expect(shuffled.institutions[lens].get(id), `${lens} ${id}`).toEqual(p);
  });

  it("stays fast with a thousand institutions (the overlap pass is not quadratic)", () => {
    const companies = input.companies;
    const many = Array.from({ length: 1000 }, (_, k) => ({
      id: `inst_${String(k).padStart(4, "0")}`,
      name: `Fictional Capital Partners ${k}`,
      related: new Map([[companies[k % companies.length]!.id, 1]]),
    }));
    const started = performance.now();
    const big = computeLayout2D({
      ...input,
      lenses: { capital: many, contracts: [], industry: [] },
    });
    // Measured 2,049 ms before the sweep and about 465 ms after. Generous for slow CI.
    expect(performance.now() - started).toBeLessThan(1500);
    expect(big.institutions.capital.size).toBe(1000);
  });

  it("keeps every company at one position in every lens (D-07)", () => {
    const capital = sceneFor2D(buildLensScene(ix, "capital"), prepared);
    const contracts = sceneFor2D(buildLensScene(ix, "contracts"), prepared);
    for (const c of ix.companies) {
      const i = capital.indexOf.get(c.id)!;
      const j = contracts.indexOf.get(c.id)!;
      expect(contracts.data.nodes.positions[j * 3]).toBe(capital.data.nodes.positions[i * 3]);
      expect(contracts.data.nodes.positions[j * 3 + 1]).toBe(
        capital.data.nodes.positions[i * 3 + 1],
      );
    }
  });

  it("never lets two company names overlap at zoom 1", () => {
    const boxes = input.companies.map((c) => {
      const [x, y] = layout.positions.get(c.id)!;
      return [
        x - DOT_R - 2,
        y - ROW_H / 2 + 1,
        x + LABEL_GAP + estimateTextWidth(c.name),
        y + ROW_H / 2 - 1,
      ] as const;
    });
    const grid = new Map<string, number[]>();
    boxes.forEach((b, i) => {
      for (let gx = Math.floor(b[0] / 100); gx <= Math.floor(b[2] / 100); gx++) {
        const key = `${gx}:${Math.round((b[1] + b[3]) / 2 / ROW_H)}`;
        grid.set(key, [...(grid.get(key) ?? []), i]);
      }
    });
    let overlaps = 0;
    for (const list of grid.values())
      for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
          const p = boxes[list[a]!]!;
          const q = boxes[list[b]!]!;
          if (p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1]) overlaps++;
        }
    expect(overlaps).toBe(0);
  });

  it("places companies inside their own sector, and sectors apart from each other", () => {
    for (const c of input.companies) {
      const s = layout.sectors[layout.sectorOf.get(c.id)!]!;
      expect(s.id).toBe(c.sectorId);
      const [x, y] = layout.positions.get(c.id)!;
      expect(Math.hypot(x - s.x, y - s.y)).toBeLessThanOrEqual(s.r);
    }
    for (let i = 0; i < layout.sectors.length; i++)
      for (let j = i + 1; j < layout.sectors.length; j++) {
        const a = layout.sectors[i]!;
        const b = layout.sectors[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
      }
  });

  it("puts specialists outside the ring and generalists in the hub (the 3D 40% rule)", () => {
    for (const lens of ["capital", "contracts"] as const)
      for (const inst of input.lenses[lens]) {
        const counts = new Map<string, number>();
        for (const c of inst.related.keys()) {
          const s = input.companies.find((x) => x.id === c)?.sectorId;
          if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        const total = [...counts.values()].reduce((a, b) => a + b, 0);
        const top = Math.max(0, ...counts.values());
        const specialist = total > 0 && top / total >= 0.4;
        expect(layout.placement[lens].get(inst.id)).toBe(specialist ? "outer" : "hub");
        const [x, y] = layout.institutions[lens].get(inst.id)!;
        for (const s of layout.sectors)
          expect(Math.hypot(x - s.x, y - s.y), `${inst.id} sits on ${s.label}`).toBeGreaterThan(
            s.r,
          );
        // The hub is a soft region: a name may reach a little past its edge, never into a sector.
        const inHub = (x / layout.hub.rx) ** 2 + (y / layout.hub.ry) ** 2 <= 1.25 ** 2;
        expect(inHub).toBe(!specialist);
      }
  });

  it("gives the hub a caption only in lenses that use it", () => {
    expect(mapContext(prepared, "industry").hubLabel).toBeNull();
    expect(mapContext(prepared, "capital").hubLabel).not.toBeNull();
  });
});

describe("packSector", () => {
  it("keeps every name inside the disc and in reading order within a band", () => {
    const groups = [
      {
        id: "a",
        caption: 80,
        items: ["Alpha", "Bravo Systems", "Charlie"].map((n) => ({
          id: n,
          width: estimateTextWidth(n),
        })),
      },
      {
        id: "b",
        caption: 90,
        items: ["Delta Robotics", "Echo"].map((n) => ({ id: n, width: estimateTextWidth(n) })),
      },
    ];
    const packed = packSector(groups);
    for (const g of groups)
      for (const it of g.items) {
        const [x, y] = packed.offsets.get(it.id)!;
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(packed.r);
      }
    const ys = groups[0]!.items.map((it) => packed.offsets.get(it.id)!);
    for (let i = 1; i < ys.length; i++)
      expect(
        ys[i]![1] > ys[i - 1]![1] || (ys[i]![1] === ys[i - 1]![1] && ys[i]![0] > ys[i - 1]![0]),
      ).toBe(true);
    // Band b starts below band a's caption and items.
    const lastA = Math.max(...groups[0]!.items.map((it) => packed.offsets.get(it.id)![1]));
    expect(packed.captions.get("b")![1]).toBeGreaterThan(lastA);
  });
});
