import { expect, it } from "vitest";
import { generateData } from "./generate";
it("generates exactly the requested reproducible workload with every visual kind", () => {
  const data = generateData("large");
  expect(data.nodes.count).toBe(3310);
  expect(data.edges.count).toBe(15000);
  expect(Array.from(data.nodes.kinds).filter((k) => k === 0)).toHaveLength(3000);
  expect(Array.from(data.nodes.kinds).filter((k) => k === 4)).toHaveLength(10);
  expect(new Set(data.nodes.kinds).size).toBe(5);
  expect(data.nodes.positions).toEqual(generateData("large").nodes.positions);
  expect(data.edges.source).toEqual(generateData("large").edges.source);
  expect(data.edges.target.every((i) => i < data.nodes.count)).toBe(true);
});
it("overview bundles cover each investor-sector pair with its record weight", () => {
  const data = generateData("large"),
    records = new Map<string, number>(),
    bundles = new Map<string, number>();
  for (let e = 3; e < data.edges.count; e++) {
    const a = data.edges.source[e]!,
      b = data.edges.target[e]!;
    if (data.edges.kinds[e] === 0) {
      expect(data.nodes.kinds[a]).toBe(1);
      const key = `${a}:${b % 10}`;
      records.set(key, (records.get(key) ?? 0) + data.edges.weight[e]!);
    }
    if (data.edges.kinds[e] === 2) {
      expect(data.nodes.kinds[a]).toBe(1);
      expect(data.nodes.kinds[b]).toBe(4);
      const key = `${a}:${b - 3300}`;
      expect(bundles.has(key)).toBe(false);
      bundles.set(key, data.edges.weight[e]!);
    }
  }
  expect(bundles).toEqual(records);
});
