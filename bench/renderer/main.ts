import { ExplorerScene } from "../../src/graph/engine/ExplorerScene";
import type { SceneData, SceneEventMap } from "../../src/graph/engine/types";
import { EdgeKind, NodeKind } from "../../src/graph/engine/types";
import { generateData } from "./generate";
import "./style.css";

export interface BenchEvent {
  type: keyof SceneEventMap;
  payload: SceneEventMap[keyof SceneEventMap];
  at: number;
}
export interface Bench {
  scene: ExplorerScene;
  data: SceneData;
  events: BenchEvent[];
  frameTimes: number[];
  firstFrameAt: number | null;
  projectNode: (index: number) => { x: number; y: number; z: number };
  projectEdgeMidpoint: (index: number) => { x: number; y: number; z: number };
  highlight: (index: number) => void;
  restoreOverview: () => void;
  togglePanel: (open: boolean) => void;
  mode: "app" | "all";
  stopMonitoring: () => void;
}
declare global {
  interface Window {
    __bench: Bench;
  }
}
const params = new URLSearchParams(location.search),
  size = params.get("size") === "large" ? "large" : "small",
  mode = params.get("mode") === "all" ? "all" : "app";
const host = document.querySelector<HTMLElement>("#host")!,
  status = document.querySelector<HTMLOutputElement>("#status")!;
const sizeControl = document.querySelector<HTMLSelectElement>("#size")!,
  reduced = document.querySelector<HTMLInputElement>("#reduced")!;
sizeControl.value = size;
const modeControl = document.querySelector<HTMLSelectElement>("#mode")!;
modeControl.value = mode;
modeControl.addEventListener("change", () => {
  params.set("mode", modeControl.value);
  location.search = params.toString();
});
reduced.checked =
  params.get("reduced") === "1" || matchMedia("(prefers-reduced-motion: reduce)").matches;
sizeControl.addEventListener("change", () => {
  params.set("size", sizeControl.value);
  location.search = params.toString();
});
reduced.addEventListener("change", () => {
  params.set("reduced", reduced.checked ? "1" : "0");
  location.search = params.toString();
});
try {
  const data = generateData(size),
    scene = new ExplorerScene(host, { reducedMotion: reduced.checked, labelBudget: 40 });
  const events: BenchEvent[] = [],
    frameTimes: number[] = [];
  const overview = Uint8Array.from(data.edges.kinds, (kind) => Number(kind === EdgeKind.Bundle));
  const panel = document.querySelector<HTMLElement>("#panel")!;
  for (const event of ["pointerdown", "pointerup", "pointermove", "wheel"])
    panel.addEventListener(event, (e) => e.stopPropagation());
  const togglePanel = (open: boolean) => {
    panel.hidden = !open;
    document.querySelector("#panel-toggle")!.setAttribute("aria-pressed", String(open));
    scene.setViewportInsets({
      top: 0,
      left: 0,
      bottom: 0,
      right: open ? panel.getBoundingClientRect().width : 0,
    });
  };
  const restoreOverview = () => {
    scene.setHighlight(null, null);
    scene.setEdgeVisibility(mode === "app" ? overview : null);
    scene.resetCamera();
  };
  const highlight = (index: number) => {
    const neighbours = new Set<number>();
    const eligible = new Uint8Array(data.edges.count);
    for (let e = 0; e < data.edges.count; e++) {
      if (mode === "app" && data.edges.kinds[e] === EdgeKind.Bundle) continue;
      if (data.edges.source[e] === index) neighbours.add(data.edges.target[e]!);
      if (data.edges.target[e] === index) neighbours.add(data.edges.source[e]!);
      eligible[e] = Number(data.edges.source[e] === index || data.edges.target[e] === index);
    }
    if (mode === "app") scene.setEdgeVisibility(eligible);
    scene.setHighlight(index, Uint32Array.from(neighbours));
    if (mode === "app" && data.nodes.kinds[index] === NodeKind.Investor)
      scene.frameNodes(Uint32Array.from([index, ...neighbours]));
  };
  let monitor = 0,
    lastFrame = 0;
  const bench: Bench = {
    scene,
    data,
    events,
    frameTimes,
    firstFrameAt: null,
    highlight,
    restoreOverview,
    togglePanel,
    mode,
    projectNode: (i) => {
      const p = scene.projectNode(i),
        r = host.getBoundingClientRect();
      return { ...p, x: p.x + r.left, y: p.y + r.top };
    },
    projectEdgeMidpoint: (i) => {
      const p = scene.projectEdgeMidpoint(i),
        r = host.getBoundingClientRect();
      return { ...p, x: p.x + r.left, y: p.y + r.top };
    },
    stopMonitoring: () => cancelAnimationFrame(monitor),
  };
  window.__bench = bench;
  for (const event of [
    "nodeClick",
    "edgeClick",
    "backgroundClick",
    "hover",
    "labelOverflow",
    "contextLost",
    "contextRestored",
    "viewChange",
  ] as const)
    scene.on(event, (payload) => {
      events.push({ type: event, payload, at: performance.now() });
      if (event === "nodeClick") highlight((payload as SceneEventMap["nodeClick"]).index);
      if (event === "backgroundClick") restoreOverview();
    });
  scene.setDescription(
    `Synthetic ${size} network: ${data.nodes.count} nodes, ${data.edges.count} relationships. Drag to orbit. Use the application directory for keyboard exploration.`,
  );
  scene.setData(data);
  scene.setEdgeVisibility(mode === "app" ? overview : null);
  const sample = () => {
    const stats = scene.getStats();
    if (stats.framesRendered !== lastFrame) {
      lastFrame = stats.framesRendered;
      if (stats.lastRenderAt !== null) {
        frameTimes.push(stats.lastRenderAt);
        bench.firstFrameAt ??= stats.lastRenderAt;
      }
      status.value = `${stats.visibleNodes.toLocaleString()} nodes · ${stats.visibleEdges.toLocaleString()} edges · ${stats.lastDrawCalls} draws · ${stats.visibleLabels} labels`;
    }
    monitor = requestAnimationFrame(sample);
  };
  monitor = requestAnimationFrame(sample);
  document
    .querySelector("#highlight")!
    .addEventListener("click", () => highlight(data.nodes.kinds.indexOf(NodeKind.Investor)));
  let filtered = false;
  document.querySelector("#visibility")!.addEventListener("click", (event) => {
    filtered = !filtered;
    scene.setVisibility(
      filtered
        ? Uint8Array.from({ length: data.nodes.count }, (_, i) => Number(i % 2 === 0))
        : null,
    );
    (event.currentTarget as HTMLElement).setAttribute("aria-pressed", String(filtered));
  });
  document.querySelector("#reset")!.addEventListener("click", restoreOverview);
  document.querySelector("#panel-toggle")!.addEventListener("click", () => {
    togglePanel(Boolean(panel.hidden));
    scene.resetCamera();
  });
  document
    .querySelector("#labels")!
    .addEventListener("change", (event) =>
      scene.setLabelsEnabled((event.target as HTMLInputElement).checked),
    );
  window.addEventListener(
    "pagehide",
    () => {
      bench.stopMonitoring();
      scene.dispose();
    },
    { once: true },
  );
} catch (error) {
  status.value = error instanceof Error ? error.message : String(error);
  status.setAttribute("role", "alert");
}
