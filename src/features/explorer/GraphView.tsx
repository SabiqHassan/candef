/**
 * Thin React wrapper around the framework-agnostic ExplorerScene (ARCHITECTURE §4).
 * Mounts once; forwards prop changes as cheap engine calls; reports engine events upward.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { ExplorerScene, WebGLUnavailableError } from "../../graph/engine";
import type { EdgeClickEvent, ViewportInsets, ZoomLevel } from "../../graph/engine/types";
import type { LensScene } from "./sceneData";

export interface GraphViewProps {
  scene: LensScene;
  nodeMask: Uint8Array;
  edgeMask: Uint8Array;
  selected: number | null;
  related: Uint32Array | null;
  insets: ViewportInsets;
  labels: boolean;
  description: string;
  /** Increment to request an action; the value change is the trigger. */
  command: {
    kind: "reset" | "zoomIn" | "zoomOut" | "focus" | "frame";
    nodes?: Uint32Array;
    nonce: number;
  };
  onNode: (index: number) => void;
  onEdges: (e: EdgeClickEvent) => void;
  onBackground: () => void;
  onZoom: (level: ZoomLevel) => void;
  onUnavailable: (reason: string) => void;
}

export function GraphView(props: GraphViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ExplorerScene | null>(null);
  const latest = useRef(props);
  // Keep the latest props for engine callbacks without re-subscribing.
  useLayoutEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    let scene: ExplorerScene;
    try {
      scene = new ExplorerScene(host.current!, { labelBudget: 44 });
    } catch (e) {
      latest.current.onUnavailable(
        e instanceof WebGLUnavailableError
          ? "3D rendering is not available on this device."
          : "The 3D view could not start.",
      );
      return;
    }
    sceneRef.current = scene;
    const offs = [
      scene.on("nodeClick", (e) => latest.current.onNode(e.index)),
      scene.on("edgeClick", (e) => latest.current.onEdges(e)),
      scene.on("backgroundClick", () => latest.current.onBackground()),
      scene.on("viewChange", (e) => latest.current.onZoom(e.level)),
      scene.on("contextLost", () => latest.current.onUnavailable("The graphics context was lost.")),
    ];
    return () => {
      offs.forEach((off) => off());
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Data first, then masks, highlight and insets. Only a lens change moves the camera: moving the
  // time filter rebuilds the scene in place so the user keeps their view.
  const shownLens = useRef<string | null>(null);
  useEffect(() => {
    const s = sceneRef.current;
    if (!s) return;
    s.setData(props.scene.data);
    s.setVisibility(latest.current.nodeMask);
    s.setEdgeVisibility(latest.current.edgeMask);
    if (shownLens.current !== props.scene.lens) s.resetCamera();
    shownLens.current = props.scene.lens;
  }, [props.scene]);
  useEffect(() => sceneRef.current?.setVisibility(props.nodeMask), [props.nodeMask]);
  useEffect(() => sceneRef.current?.setEdgeVisibility(props.edgeMask), [props.edgeMask]);
  useEffect(
    () => sceneRef.current?.setHighlight(props.selected, props.related),
    [props.selected, props.related],
  );
  useEffect(() => sceneRef.current?.setLabelsEnabled(props.labels), [props.labels]);
  useEffect(() => sceneRef.current?.setDescription(props.description), [props.description]);
  const { top, right, bottom, left } = props.insets;
  useEffect(
    () => sceneRef.current?.setViewportInsets({ top, right, bottom, left }),
    [top, right, bottom, left],
  );

  useEffect(() => {
    const s = sceneRef.current;
    const c = latest.current.command;
    if (!s || c.nonce === 0) return;
    if (c.kind === "reset") s.resetCamera();
    else if (c.kind === "zoomIn") s.zoomBy(1.3);
    else if (c.kind === "zoomOut") s.zoomBy(1 / 1.3);
    else if (c.kind === "focus" && latest.current.selected !== null)
      s.focusNode(latest.current.selected);
    else if (c.kind === "frame" && c.nodes) s.frameNodes(c.nodes);
  }, [props.command.nonce]);

  return <div ref={host} className="graph-host" data-testid="graph-host" />;
}
