import { expect, it } from "vitest";
import * as T from "three";
import { GpuBatches } from "./gpu";
import { NODE_RADII } from "./buffers";
import { generateData } from "../../../bench/renderer/generate";

it("updates instanced bounds when positions move, so raycasts see the new location", () => {
  const world = new T.Scene(),
    data = generateData("small"),
    batches = new GpuBatches(world, data);
  batches.update(data, data.nodes.positions, null, null, new Set(), null);
  const mesh = batches.nodes[0]!;
  mesh.computeBoundingSphere();
  const moved = new Float32Array(data.nodes.positions);
  for (let i = 0; i < data.nodes.count; i++) moved[i * 3] = moved[i * 3]! + 10000;
  batches.update(data, moved, null, null, new Set(), null);
  const ray = new T.Raycaster(
    new T.Vector3(moved[0]!, moved[1]!, moved[2]! + 20),
    new T.Vector3(0, 0, -1),
  );
  world.updateMatrixWorld(true);
  expect(ray.intersectObject(mesh).some((hit) => hit.instanceId === 0)).toBe(true);
  batches.dispose();
  batches.dispose();
  expect(world.children).toHaveLength(0);
});
it("selection remains largest across kinds and unequal prominence", () => {
  const world = new T.Scene(),
    data = generateData("small"),
    batches = new GpuBatches(world, data);
  data.nodes.weights!.fill(1);
  data.nodes.weights![0] = 0.5;
  data.nodes.weights![100] = 3;
  const mask = new Uint8Array(data.nodes.count);
  mask[0] = 1;
  mask[100] = 1;
  batches.update(data, data.nodes.positions, mask, 0, new Set([100]), null);
  const camera = new T.PerspectiveCamera(42, 1440 / 900, 0.1, 10000);
  camera.position.z = 2000;
  camera.updateMatrixWorld();
  batches.updateProjection(camera, 1440, 900);
  const radius = (kind: number, instance: number, index: number) => {
    const matrix = new T.Matrix4();
    batches.nodes[kind]!.getMatrixAt(instance, matrix);
    return (
      (new T.Vector3().setFromMatrixScale(matrix).x * NODE_RADII[kind]!) /
      (2000 - data.nodes.positions[index * 3 + 2]!)
    );
  };
  expect(radius(0, 0, 0)).toBeGreaterThan(radius(1, 0, 100));
  batches.dispose();
});
it("represents hidden nodes with zero scale/alpha and removes incident line vertices", () => {
  const world = new T.Scene(),
    data = generateData("small"),
    batches = new GpuBatches(world, data);
  const mask = new Uint8Array(data.nodes.count);
  mask[0] = 1;
  batches.update(data, data.nodes.positions, mask, 0, new Set(), null);
  expect(batches.visibleNodes).toBe(1);
  expect(batches.visibleEdges).toBe(0);
  expect(batches.edges.every((e) => !e.visible)).toBe(true);
  const matrix = new T.Matrix4();
  batches.nodes[0]!.getMatrixAt(1, matrix);
  expect(matrix.elements[0]).toBe(0);
  expect(batches.nodes[0]!.geometry.getAttribute("nodeAlpha").getX(1)).toBe(0);
  batches.dispose();
});
it("minimum screen size stays pickable and camera changes preserve edge geometry", () => {
  const world = new T.Scene(),
    data = generateData("small"),
    batches = new GpuBatches(world, data);
  const mask = new Uint8Array(data.nodes.count);
  mask[0] = 1;
  batches.update(data, data.nodes.positions, mask, null, new Set(), null);
  const camera = new T.PerspectiveCamera(42, 1440 / 900, 0.1, 10000);
  camera.position.set(
    data.nodes.positions[0]!,
    data.nodes.positions[1]!,
    data.nodes.positions[2]! + 2000,
  );
  camera.updateMatrixWorld();
  const geometries = batches.edges.map((e) => e.geometry);
  batches.updateProjection(camera, 1440, 900);
  world.updateMatrixWorld(true);
  const ray = new T.Raycaster(
    camera.position.clone().add(new T.Vector3(2.5, 0, 0)),
    new T.Vector3(0, 0, -1),
  );
  expect(ray.intersectObject(batches.nodes[0]!).some((hit) => hit.instanceId === 0)).toBe(true);
  expect(batches.edges.map((e) => e.geometry)).toEqual(geometries);
  batches.dispose();
});
