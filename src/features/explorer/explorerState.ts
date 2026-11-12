/**
 * Explorer state lives in the URL (shareable views, back/forward work). Only transient UI state
 * (hover, zoom band, chooser) stays in React.
 */
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import type { CompanyFilters, MarketFilter } from "../../domain";
import type { TimeMode } from "../../domain/time";

export type Lens = "capital" | "contracts" | "industry";
/** Network dimensions: the same network as the 3D constellation or as a flat 2D map. */
export type Mode = "3d" | "2d";
export const LENSES: { id: Lens; label: string; summary: string }[] = [
  {
    id: "capital",
    label: "Capital",
    summary: "Investors and the companies they have documented investments in",
  },
  {
    id: "contracts",
    label: "Government",
    summary: "Procurement contracts and grants between government bodies and companies",
  },
  {
    id: "industry",
    label: "Industry",
    summary: "Companies grouped by technology classification; no relationship lines",
  },
];

export interface ExplorerState extends CompanyFilters {
  lens: Lens;
  sel: string | null;
  view: "graph" | "list";
  /** 3D or 2D as named in the URL; null when it names none (desktop 3D, phones 2D). */
  mode: Mode | null;
  /** True when the URL names a view; otherwise narrow screens default to the list. */
  viewExplicit: boolean;
  grants: boolean;
  directory: boolean;
  /** Time view: the selected year, or null for all years (docs/TIME_VIEW.md). */
  asof: number | null;
  tmode: TimeMode;
  /** Relationship lines whose records are open in the panel (clicked, or from a shared link). */
  rel: string[];
}

function parseYear(raw: string | null): number | null {
  if (!raw || !/^\d{4}$/.test(raw)) return null;
  const y = Number(raw);
  return y >= 1900 && y <= 2100 ? y : null;
}

const LENS_IDS = new Set<string>(LENSES.map((l) => l.id));

export function useExplorerState() {
  const [params, setParams] = useSearchParams();
  const state: ExplorerState = useMemo(
    () => ({
      lens: (LENS_IDS.has(params.get("lens") ?? "") ? params.get("lens") : "capital") as Lens,
      q: params.get("q") ?? "",
      sector: params.get("sector") ?? "",
      province: params.get("province") ?? "",
      stage: params.get("stage") ?? "",
      market: (params.get("market") ?? "") as MarketFilter,
      sel: params.get("sel"),
      view: params.get("view") === "list" ? "list" : "graph",
      viewExplicit: params.has("view"),
      mode: params.get("mode") === "2d" ? "2d" : params.get("mode") === "3d" ? "3d" : null,
      grants: params.get("grants") !== "0",
      directory: params.get("dir") !== "0",
      asof: parseYear(params.get("asof")),
      tmode: params.get("tmode") === "active" ? "active" : "began",
      rel: (params.get("rel") ?? "").split(",").filter(Boolean).slice(0, 12),
    }),
    [params],
  );

  const update = useCallback(
    (patch: Partial<ExplorerState>, replace = true) => {
      setParams(
        () => {
          // Build from the live URL, not the router's `prev`: `prev` is the params of the render
          // that created this callback, so a delayed update (the search box's 160 ms debounce)
          // would otherwise overwrite a selection made in the meantime.
          const next = new URLSearchParams(window.location.search);
          const set = (k: string, v: string | null, dflt = "") =>
            v === null || v === dflt ? next.delete(k) : next.set(k, v);
          for (const [key, value] of Object.entries(patch)) {
            if (key === "grants") set("grants", value ? "1" : "0", "1");
            else if (key === "directory") set("dir", value ? "1" : "0", "1");
            else if (key === "lens") set("lens", value as string, "capital");
            else if (key === "view") set("view", value as string);
            else if (key === "viewExplicit") continue;
            else if (key === "mode") set("mode", value as string | null);
            else if (key === "asof") set("asof", value === null ? null : String(value));
            else if (key === "tmode") set("tmode", value as string, "began");
            else if (key === "rel") set("rel", (value as string[]).join(",") || null);
            else set(key, (value as string | null) ?? null);
          }
          return next;
        },
        { replace },
      );
    },
    [setParams],
  );

  return { state, update };
}
