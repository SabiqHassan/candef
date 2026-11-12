/**
 * React wrapper for the 2D renderer. Same props as the 3D GraphView (src/features/explorer/
 * GraphView.tsx) plus the map context, so the explorer page can swap one for the other without
 * changing anything else.
 *
 * Two deliberate differences from 3D, both about keeping the user's place:
 * - On mount, a current selection is framed (a mode switch keeps the user where they were).
 * - On a lens switch, a zoomed-in view is kept: companies never move between lenses here.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { NodeKind } from "../../graph/engine/types";
import type { GraphViewProps } from "./GraphView";
import { NetworkCanvas2D, type MapContext } from "../../graph/engine2d/NetworkCanvas2D";

export interface GraphView2DProps extends GraphViewProps {
  context: MapContext;
}

declare global {
  interface Window {
    /** Prototype diagnostics for browser tests (never in production code). */
    __candef2d?: NetworkCanvas2D;
  }
}

export function GraphView2D(props: GraphView2DProps) {
  const host = useRef<HTMLDivElement>(null);
  const engineRef = useRef<NetworkCanvas2D | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  // Which lens the engine last showed; null = a new engine that has not framed anything yet.
  const shownLens = useRef<string | null>(null);
  useEffect(() => {
    let engine: NetworkCanvas2D;
    shownLens.current = null;
    try {
      engine = new NetworkCanvas2D(host.current!, { labelBudget: 240 });
    } catch {
      latest.current.onUnavailable("The 2D view could not start.");
      return;
    }
    engineRef.current = engine;
    window.__candef2d = engine;
    const offs = [
      engine.on("nodeClick", (e) => latest.current.onNode(e.index)),
      engine.on("edgeClick", (e) => latest.current.onEdges(e)),
      engine.on("backgroundClick", () => latest.current.onBackground()),
      engine.on("viewChange", (e) => latest.current.onZoom(e.level)),
    ];
    return () => {
      offs.forEach((off) => off());
      engine.dispose();
      engineRef.current = null;
      if (window.__candef2d === engine) delete window.__candef2d;
    };
  }, []);

  useEffect(() => {
    const s = engineRef.current;
    if (!s) return;
    // Insets first, so the very first framing already avoids the panels and toolbars.
    s.setViewportInsets(latest.current.insets);
    s.setContext(props.context);
    s.setData(props.scene.data);
    s.setVisibility(latest.current.nodeMask);
    s.setEdgeVisibility(latest.current.edgeMask);
    s.setHighlight(latest.current.selected, latest.current.related);
    const first = shownLens.current === null;
    if (first) {
      // Mode switch or first visit: frame the selection if there is one, else the whole network.
      const sel = latest.current.selected;
      if (sel !== null) {
        if (props.scene.data.nodes.kinds[sel] === NodeKind.Company) s.focusNode(sel);
        else s.frameNodes(Uint32Array.from([sel, ...(latest.current.related ?? [])]));
      } else s.resetCamera();
    } else if (shownLens.current !== props.scene.lens && !s.isExploring()) s.resetCamera();
    shownLens.current = props.scene.lens;
  }, [props.scene, props.context]);
  useEffect(() => engineRef.current?.setVisibility(props.nodeMask), [props.nodeMask]);
  useEffect(() => engineRef.current?.setEdgeVisibility(props.edgeMask), [props.edgeMask]);
  const { top, right, bottom, left } = props.insets;
  useEffect(
    () => engineRef.current?.setViewportInsets({ top, right, bottom, left }),
    [top, right, bottom, left],
  );
  useEffect(
    () => engineRef.current?.setHighlight(props.selected, props.related),
    [props.selected, props.related],
  );
  useEffect(() => engineRef.current?.setLabelsEnabled(props.labels), [props.labels]);
  useEffect(() => engineRef.current?.setDescription(props.description), [props.description]);

  // Commands issued before this view existed (for example in the other mode) are not replayed.
  const mountedNonce = useRef(props.command.nonce);
  useEffect(() => {
    const s = engineRef.current;
    const c = latest.current.command;
    if (!s || c.nonce === mountedNonce.current) return;
    if (c.kind === "reset") s.resetCamera();
    else if (c.kind === "zoomIn") s.zoomBy(1.3);
    else if (c.kind === "zoomOut") s.zoomBy(1 / 1.3);
    else if (c.kind === "focus" && latest.current.selected !== null)
      s.focusNode(latest.current.selected);
    else if (c.kind === "frame" && c.nodes) s.frameNodes(c.nodes);
  }, [props.command.nonce]);

  return <div ref={host} className="graph-host" data-testid="graph-host-2d" />;
}
