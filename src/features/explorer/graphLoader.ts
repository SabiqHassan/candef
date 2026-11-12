/**
 * The 3D view (three.js, about 130 KB gzipped) is a separate download: phones open the 2D map by
 * default and a shared dossier link never needs it, so neither pays for it. A visit that will
 * probably show the graph starts the download at boot, in parallel with the data, so desktop users
 * do not wait for it twice. Measured 2026-10-14: every route used to load 914 KB of JavaScript.
 */
import { lazy } from "react";

let pending: Promise<typeof import("./GraphView")> | null = null;

export function loadGraphView() {
  pending ??= import("./GraphView").catch((e: unknown) => {
    pending = null; // A failed download may be retried (for example after the network returns).
    throw e;
  });
  return pending;
}

export const LazyGraphView = lazy(() => loadGraphView().then((m) => ({ default: m.GraphView })));

/** The flat 2D map is its own small chunk (no three.js), fetched only when 2D is shown. */
let pending2d: Promise<typeof import("./GraphView2D")> | null = null;
export function loadGraphView2D() {
  pending2d ??= import("./GraphView2D").catch((e: unknown) => {
    pending2d = null;
    throw e;
  });
  return pending2d;
}
export const LazyGraphView2D = lazy(() =>
  loadGraphView2D().then((m) => ({ default: m.GraphView2D })),
);

/** Same breakpoint as the explorer's phone layout. */
const NARROW = "(max-width: 900px)";

/** Starts the download when this page load will probably render the graph. */
export function preloadGraphForLikelyVisit(
  location: Pick<Location, "pathname" | "search"> = window.location,
  narrow: boolean = window.matchMedia(NARROW).matches,
) {
  if (location.pathname !== "/") return;
  const params = new URLSearchParams(location.search);
  if (params.get("view") === "list") return;
  // Desktop opens 3D and phones open 2D, unless the address names a mode.
  const mode = params.get("mode") ?? (narrow ? "2d" : "3d");
  void (mode === "2d" ? loadGraphView2D() : loadGraphView()).catch(() => undefined);
}
