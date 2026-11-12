import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  List,
  Maximize2,
  Minus,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  Tag,
  Waypoints,
} from "lucide-react";
import { Link } from "react-router";
import { useData } from "../../app/DataContext";
import { filterCompanies } from "../../domain";
import { describeTimeFilter, timeExtent, type TimeFilter } from "../../domain/time";
import { ZoomLevel, type EdgeClickEvent } from "../../graph/engine/types";
import { ErrorBoundary } from "../../ui/ErrorBoundary";
import { CompanyCard } from "./CompanyCard";
import { Directory } from "./Directory";
import { LENSES, useExplorerState, type Lens, type Mode } from "./explorerState";
import type { GraphViewProps } from "./GraphView";
import { LazyGraphView, LazyGraphView2D } from "./graphLoader";
import { InstitutionPanel } from "./InstitutionPanel";
import { ListMode } from "./ListMode";
import { RelationshipPanel } from "./RelationshipPanel";
import { buildLensScene, edgeMask, nodeMask, relatedNodes } from "./sceneData";
import { TimeControl, timeStatus } from "./TimeControl";
import styles from "./explorer.module.css";
import { mapContext, prepare2D, sceneFor2D } from "./scene2d";

function useMediaQuery(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

export function ExplorerPage() {
  const ix = useData();
  const { state, update } = useExplorerState();
  const narrow = useMediaQuery("(max-width: 900px)");
  // Desktop opens the 3D constellation; phones open the flat 2D map unless the address names a mode.
  // If 3D cannot start (no WebGL, engine download failed) the 2D map takes its place.
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const mode: Mode = unavailable ? "2d" : (state.mode ?? (narrow ? "2d" : "3d"));
  const wide = useMediaQuery("(min-width: 1700px)");
  const [zoom, setZoom] = useState<ZoomLevel>(ZoomLevel.Overview);
  const [labels, setLabels] = useState(true);
  // Last resort: if even the 2D map cannot start, the list takes over (as 3D failures once did).
  const [failed2d, setFailed2d] = useState(false);
  const [command, setCommand] = useState<GraphViewProps["command"]>({ kind: "reset", nonce: 0 });
  const run = (kind: GraphViewProps["command"]["kind"], nodes?: Uint32Array) =>
    setCommand((c) => ({ kind, nodes, nonce: c.nonce + 1 }));

  // Time view: the year range comes from the dated records of the current lens.
  const extent = useMemo(() => {
    if (state.lens === "industry") return null;
    const l = ix.snap.graph.lenses[state.lens];
    return timeExtent([...l.edges, ...l.bundles], ix.snap.meta.builtAt);
  }, [ix, state.lens]);
  const time: TimeFilter | null = useMemo(
    () =>
      state.asof === null || !extent
        ? null
        : { mode: state.tmode, year: Math.min(extent.max, Math.max(extent.min, state.asof)) },
    [state.asof, state.tmode, extent],
  );
  const scenes = useMemo(
    () => ({
      capital: buildLensScene(ix, "capital", time),
      contracts: buildLensScene(ix, "contracts", time, state.grants),
      industry: buildLensScene(ix, "industry"),
    }),
    [ix, time, state.grants],
  );
  const scene = scenes[state.lens];
  // 2D: the same scene with 2D positions, and the sector map for orientation.
  const prepared = useMemo(() => (mode === "2d" ? prepare2D(ix) : null), [ix, mode]);
  const scene2d = useMemo(() => (prepared ? sceneFor2D(scene, prepared) : null), [scene, prepared]);
  const context2d = useMemo(
    () => (prepared ? mapContext(prepared, state.lens) : null),
    [prepared, state.lens],
  );
  const filtered = useMemo(() => filterCompanies(ix, state), [ix, state]);
  const visibleIds = useMemo(() => new Set(filtered.map((c) => c.id)), [filtered]);
  const nMask = useMemo(() => nodeMask(scene, visibleIds, ix), [scene, visibleIds, ix]);

  const selectedOrg = state.sel ? ix.org.get(state.sel) : undefined;
  const selectedIndex = state.sel ? (scene.indexOf.get(state.sel) ?? null) : null;
  const related = useMemo(
    () => (selectedIndex === null ? null : relatedNodes(scene, selectedIndex, state.grants)),
    [scene, selectedIndex, state.grants],
  );
  const eMask = useMemo(
    () =>
      edgeMask(scene, {
        selected: selectedIndex,
        zoom,
        showGrants: state.grants,
        thresholdCad: ix.snap.meta.thresholdCad,
      }),
    [scene, selectedIndex, zoom, state.grants, ix.snap.meta.thresholdCad],
  );

  const select = useCallback(
    (id: string | null) => {
      update({ sel: id, rel: [] }, false);
      // Selecting an institution frames its documented relationships (a user-initiated move).
      const index = id ? scene.indexOf.get(id) : undefined;
      if (id && index !== undefined && ix.org.get(id)?.scope === "contextual") {
        const rel = relatedNodes(scene, index, state.grants);
        if (rel.length)
          setCommand((c) => ({
            kind: "frame",
            nodes: Uint32Array.from([index, ...rel]),
            nonce: c.nonce + 1,
          }));
      }
    },
    [update, scene, ix, state.grants],
  );

  const onNode = (index: number) => {
    const subsector = scene.anchorSubsector.get(index);
    if (subsector) {
      const nodes = scene.ids.flatMap((id, i) =>
        ix.org.get(id)?.segment.value?.id === subsector ? [i] : [],
      );
      run("frame", Uint32Array.from(nodes));
      return;
    }
    const sector = scene.anchorSector.get(index);
    if (sector) {
      // Sector anchor: frame its companies rather than "selecting" a non-entity.
      const nodes = scene.ids.flatMap((id, i) =>
        ix.org.get(id)?.segment.value?.sectorId === sector ? [i] : [],
      );
      run("frame", Uint32Array.from(nodes));
      return;
    }
    select(scene.ids[index] ?? null);
  };
  const onEdges = (e: EdgeClickEvent) =>
    update({ rel: e.candidates.map((i) => scene.edges[i]!.id), sel: null }, false);
  // Lines from the URL that exist in the scene as drawn (a time filter can remove them).
  const edgePick = useMemo(() => {
    const ids = state.rel.filter((id) => scene.edges.some((e) => e.id === id));
    return ids.length ? ids : null;
  }, [state.rel, scene]);

  // 2D: switching modes keeps everything in the URL; the newly shown view frames the selection.
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    update({ mode: next }, false);
    // Each view reports its own zoom band once it has framed something; start from the overview.
    setZoom(ZoomLevel.Overview);
    // 3D's own close-up ("focus") lands very near; the selection with its relationships gives
    // context. A selection with no relationships in this lens gets the close-up.
    if (next === "3d") {
      if (selectedIndex === null) run("reset");
      else if (!related?.length) run("focus");
      else run("frame", Uint32Array.from([selectedIndex, ...related]));
    }
  };

  const panelOpen = !!selectedOrg || !!edgePick;
  // Phones: the directory is an overlay, closed by default and closed again after a pick.
  const [mobileDirectory, setMobileDirectory] = useState(false);
  const directoryOpen = narrow ? mobileDirectory : state.directory;
  const directoryDocked = directoryOpen && !narrow;
  const toggleDirectory = () =>
    narrow ? setMobileDirectory((v) => !v) : update({ directory: !state.directory });
  const insets = {
    top: 64,
    bottom: 56,
    left: directoryDocked ? 336 : 0,
    right: panelOpen && !narrow ? 416 : 0,
  };
  // Overlays stop short of the right panel (and, at the bottom, of the view controls).
  const overlayRight = panelOpen && !narrow ? 432 : 16;
  const controlsWidth = 290 + 76; // 2D: the switch adds 76 px to the toolbar
  // With both side panels open on a laptop, the strip beside the controls is too narrow for the
  // legend; it moves above the controls and uses the full middle width instead.
  const legendAbove = directoryDocked && panelOpen && !narrow && !wide;
  const lensInfo = LENSES.find((l) => l.id === state.lens)!;
  const drawnEdges = eMask.reduce((n, v) => n + v, 0);
  const description = `${lensInfo.label} view: ${filtered.length} companies and ${scene.institutionCount} institutions. ${
    state.lens === "industry"
      ? "Grouped by technology classification."
      : `${drawnEdges} relationships drawn${time ? ` (time filter: ${describeTimeFilter(time)})` : ""}.`
  }${ix.snap.meta.preview ? " Local preview of unverified drafts." : ix.snap.meta.isDemo ? " Fictional demonstration data." : ""} Use the company directory to explore with a keyboard.`;

  // Phones open the 2D map by default (owner decision); the list is one tap away.
  // 2D: a failed 3D start no longer forces the list while 2D is chosen (2D needs no WebGL).
  const listMode = state.view === "list" || failed2d;
  // A docked directory beside the table would list every company twice, so it keeps only the
  // search and filters. The phone overlay covers the list while open and stays complete.
  const filtersOnly = listMode && !narrow;
  const modeLabel = mode === "2d" ? "2D" : "3D"; // 2D

  const title = `${selectedOrg ? `${selectedOrg.name}, ` : ""}${listMode ? "Company list" : `${lensInfo.label} view${mode === "2d" ? " (2D)" : ""}`} | CANDEF Explorer`;
  useEffect(() => {
    document.title = title;
  }, [title]);

  const graphProps = {
    nodeMask: nMask,
    edgeMask: eMask,
    selected: selectedIndex,
    related,
    insets,
    labels,
    description,
    command,
    onNode,
    onEdges,
    onBackground: () => select(null),
    onZoom: setZoom,
    onUnavailable: setUnavailable,
  };

  return (
    <div className={styles.explorer}>
      {!listMode && mode === "3d" && (
        <ErrorBoundary
          resetKey={state.lens}
          fallback={null}
          onError={() => setUnavailable("The 3D view could not be loaded.")}
        >
          <Suspense
            fallback={
              <div className={`graph-host ${styles.graphLoading}`} role="status">
                Loading the 3D view…
              </div>
            }
          >
            <LazyGraphView scene={scene} {...graphProps} />
          </Suspense>
        </ErrorBoundary>
      )}
      {/* 2D: same props as the 3D view, plus the sector map. */}
      {!listMode && mode === "2d" && scene2d && context2d && (
        <ErrorBoundary resetKey={state.lens} fallback={null} onError={() => setFailed2d(true)}>
          <Suspense
            fallback={
              <div className={`graph-host ${styles.graphLoading}`} role="status">
                Loading the 2D view…
              </div>
            }
          >
            <LazyGraphView2D
              scene={scene2d}
              context={context2d}
              {...graphProps}
              // Escape on the map clears a selection or relationship; with nothing open it does nothing.
              onBackground={() => (state.sel || state.rel.length) && select(null)}
              onUnavailable={() => setFailed2d(true)}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      <div
        className={styles.lensBar}
        style={{ left: directoryDocked ? 352 : 16, right: overlayRight }}
      >
        <div role="tablist" aria-label="Network view" className={styles.lensTabs}>
          {LENSES.map((l) => (
            <button
              key={l.id}
              role="tab"
              aria-selected={state.lens === l.id}
              className={state.lens === l.id ? styles.lensActive : undefined}
              onClick={() => update({ lens: l.id as Lens, rel: [] })}
            >
              {l.label}
            </button>
          ))}
        </div>
        <p className={styles.lensSummary}>
          {lensInfo.summary}
          {state.lens === "capital" &&
            !state.sel &&
            (zoom === ZoomLevel.Detail
              ? ". Zoomed in: individual investments shown."
              : ". Lines are investor-to-sector bundles; select an investor or zoom in for individual investments.")}
          {state.lens === "contracts" &&
            !state.sel &&
            `${
              zoom === ZoomLevel.Detail
                ? ". Zoomed in: individual relationships shown"
                : ". Lines are body-to-sector bundles; select a body or zoom in for individual contracts and grants"
            }. Contracts under CA$${(ix.snap.meta.thresholdCad / 1000).toFixed(0)}K are listed in dossiers, not drawn.`}
        </p>
        {/* The time filter and grants toggle only change the drawn network; the list shows current facts. */}
        {!listMode && extent && (
          <TimeControl
            filter={time}
            extent={extent}
            onChange={(f) => update({ asof: f?.year ?? null, tmode: f?.mode ?? "began" })}
          />
        )}
        {!listMode && time && scene.timeStats && (
          <p className={styles.timeStatus} role="status" data-derived="time filter summary">
            {timeStatus(time, scene.timeStats)}
          </p>
        )}
        {!listMode && state.lens === "contracts" && (
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={state.grants}
              onChange={(e) => update({ grants: e.target.checked })}
            />
            Show grants and contributions
          </label>
        )}
      </div>

      {directoryOpen && (
        <Directory
          key={filtersOnly ? "filters" : "full"}
          filtersOnly={filtersOnly}
          state={state}
          update={update}
          companies={filtered}
          lens={state.lens}
          onSelect={(id) => {
            select(id);
            if (narrow) setMobileDirectory(false);
          }}
        />
      )}

      {panelOpen && (
        <aside className={styles.panel} aria-label="Selection details">
          {edgePick ? (
            <RelationshipPanel
              edgeIds={edgePick}
              lens={state.lens}
              sceneEdges={scene.edges}
              time={time}
              onClose={() => update({ rel: [] })}
              onSelect={select}
            />
          ) : selectedOrg?.scope === "universe" ? (
            <CompanyCard
              key={selectedOrg.id}
              org={selectedOrg}
              lens={state.lens}
              onClose={() => select(null)}
              onSelect={select}
              onFocus={() => run("focus")}
            />
          ) : selectedOrg ? (
            <InstitutionPanel
              key={selectedOrg.id}
              org={selectedOrg}
              lens={state.lens}
              onClose={() => select(null)}
              onSelect={select}
              onFrame={() =>
                related &&
                selectedIndex !== null &&
                run("frame", Uint32Array.from([selectedIndex, ...related]))
              }
            />
          ) : null}
        </aside>
      )}

      {!listMode && ix.companies.length === 0 && (
        <div
          className={styles.emptyGraph}
          role="status"
          style={{ left: insets.left, right: insets.right }}
        >
          <p>
            <strong>No companies are published yet.</strong> Records appear only after the owner has
            verified them against their sources; nothing is shown before that.
          </p>
          <Link className={styles.secondary} to="/methodology">
            Coverage and method
          </Link>
        </div>
      )}

      {!listMode && ix.companies.length > 0 && filtered.length === 0 && (
        <div
          className={styles.emptyGraph}
          role="status"
          style={{ left: insets.left, right: insets.right }}
        >
          <p>No companies match these filters.</p>
          <button
            className={styles.secondary}
            onClick={() => update({ q: "", sector: "", province: "", stage: "", market: "" })}
          >
            Clear filters
          </button>
        </div>
      )}

      {listMode && (
        <ListMode
          companies={filtered}
          reason={null}
          onSelect={select}
          selected={state.sel}
          offsetLeft={directoryDocked ? 336 : 0}
          offsetRight={panelOpen && !narrow ? 416 : 0}
          onBackToGraph={() => update({ view: "graph" })}
        />
      )}

      <div
        className={styles.controls}
        style={{ right: overlayRight }}
        role="toolbar"
        aria-label="View controls"
      >
        <button
          aria-label={`${directoryOpen ? "Hide" : "Show"} company directory${narrow ? " and filters" : ""}`}
          aria-pressed={directoryOpen}
          className={narrow ? styles.labelled : undefined}
          onClick={toggleDirectory}
        >
          {narrow ? <Search size={16} /> : <PanelLeft size={16} />}
          {/* On phones the filters live behind this button; a bare icon hid them (UX review 2). */}
          {narrow && <span>Filters</span>}
        </button>
        <button
          aria-label={listMode ? `Show ${modeLabel} network` : "Show as list"}
          aria-pressed={listMode}
          className={styles.labelled}
          onClick={() => update({ view: listMode ? "graph" : "list" })}
        >
          {listMode ? <Waypoints size={16} /> : <List size={16} />}
          <span>{listMode ? modeLabel : "List"}</span>
        </button>
        {/* 2D: the switch itself. Two pressed-state buttons; 3D stays the default. */}
        {!listMode && (
          <div className={styles.modeSwitch} role="group" aria-label="Network dimensions">
            {(["3d", "2d"] as const).map((m) => (
              <button
                key={m}
                aria-pressed={mode === m}
                disabled={m === "3d" && !!unavailable}
                title={
                  m === "3d" ? "3D constellation (default)" : "Flat 2D map of the same network"
                }
                onClick={() => switchMode(m)}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        {!listMode && (
          <>
            <button aria-label="Zoom in" title="Zoom in" onClick={() => run("zoomIn")}>
              <Plus size={16} />
            </button>
            <button aria-label="Zoom out" title="Zoom out" onClick={() => run("zoomOut")}>
              <Minus size={16} />
            </button>
            <button
              aria-label="Reset view"
              title="Reset the camera view (filters are kept)"
              onClick={() => run("reset")}
            >
              <RotateCcw size={15} />
            </button>
            {state.sel && (
              <button
                aria-label="Focus selection"
                title="Frame in view: centre the camera on the selection"
                onClick={() => run("focus")}
              >
                <Maximize2 size={15} />
              </button>
            )}
            <button
              aria-label="Toggle labels"
              title="Show or hide node labels"
              aria-pressed={labels}
              onClick={() => setLabels((v) => !v)}
            >
              <Tag size={15} />
            </button>
          </>
        )}
      </div>

      {!listMode && (
        <Legend
          lens={state.lens}
          left={directoryDocked ? 352 : 16}
          right={overlayRight + (narrow || legendAbove ? 0 : controlsWidth)}
          bottom={legendAbove ? 64 : undefined}
        />
      )}
      {!listMode && unavailable && (
        <p className={styles.modeNotice} role="status">
          {unavailable} Showing the 2D map of the same network instead.
        </p>
      )}
      <p className="visually-hidden" aria-live="polite">
        {selectedOrg ? `Selected ${selectedOrg.name}.` : ""}
      </p>
    </div>
  );
}

function Legend({
  lens,
  left,
  right,
  bottom,
}: {
  lens: Lens;
  left: number;
  right: number;
  bottom?: number;
}) {
  return (
    <div className={styles.legend} style={{ left, right, bottom }}>
      <span>
        <i className={styles.dotCompany} /> Company
      </span>
      {lens === "capital" && (
        <span>
          <i className={styles.dotInvestor} /> Investor
        </span>
      )}
      {lens === "contracts" && (
        <>
          <span>
            <i className={styles.dotGov} /> Government body
          </span>
          <span>
            <i className={styles.lineProcurement} /> Procurement contract
          </span>
          <span>
            <i className={styles.lineGrant} /> Grant or contribution
          </span>
        </>
      )}
      {lens !== "industry" && (
        <>
          <span>
            <i className={styles.lineSolid} /> Official or first-party source
          </span>
          <span>
            <i className={styles.lineDashed} /> Independent reporting only
          </span>
        </>
      )}
      <span className={styles.legendNote}>Position reflects technology classification only.</span>
    </div>
  );
}
