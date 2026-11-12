import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { useData } from "../../app/DataContext";
import { compareNames, institutionLabel, parseQuery, scoreOrg } from "../../domain";
import { STAGE_LABEL } from "../../domain/format";
import type { OrgView } from "../../domain/schema/snapshot";
import type { ExplorerState, Lens } from "./explorerState";
import styles from "./explorer.module.css";

interface Props {
  state: ExplorerState;
  update: (patch: Partial<ExplorerState>) => void;
  companies: OrgView[];
  lens: Lens;
  onSelect: (id: string) => void;
  /**
   * List view already shows every company, so the directory shrinks to the search and filters
   * (UX review #7). The parent remounts the directory when this changes.
   */
  filtersOnly?: boolean;
}

const PAGE = 120;
/** Fixed row height (CSS `.row`) so the company list can be windowed. */
export const ROW_H = 49;
const OVERSCAN = 10;

/** Rows to render for a scroll position: only the visible window plus a margin (M2). */
export function visibleWindow(count: number, scrollTop: number, viewport: number) {
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN);
  return { start, end: Math.max(start, end) };
}

export function Directory({ state, update, companies, lens, onSelect, filtersOnly }: Props) {
  const ix = useData();
  const [tab, setTab] = useState<"companies" | "institutions">("companies");
  const [limit, setLimit] = useState(PAGE);
  const listRef = useRef<HTMLUListElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 800 });
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setScroll({ top: el.scrollTop, height: el.clientHeight || 800 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    // A new result set starts at the top; a stale offset could point past the end of the list.
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = 0;
    setScroll((v) => ({ ...v, top: 0 }));
  }, [companies]);
  // The search box owns its text; the URL is updated after a short pause. Binding the input
  // directly to the (asynchronous) URL dropped characters when typing quickly.
  const [query, setQuery] = useState(state.q);
  const pending = useRef<number | undefined>(undefined);
  const lastSent = useRef(state.q);
  useEffect(() => {
    // Adopt external changes (back/forward, "Clear filters") without fighting the user's typing.
    if (state.q !== lastSent.current) {
      lastSent.current = state.q;
      setQuery(state.q);
    }
  }, [state.q]);
  useEffect(() => () => window.clearTimeout(pending.current), []);
  const changeQuery = (value: string, immediate = false) => {
    setQuery(value);
    window.clearTimeout(pending.current);
    const send = () => {
      lastSent.current = value;
      update({ q: value });
    };
    if (immediate) send();
    else pending.current = window.setTimeout(send, 160);
  };

  const institutions = useMemo(() => {
    if (lens === "industry") return [];
    const query = parseQuery(state.q);
    return ix.snap.graph.lenses[lens].institutionIds
      .map((id) => ix.org.get(id))
      .filter((o): o is OrgView => !!o && !!scoreOrg(o, query))
      .sort(
        (a, b) =>
          (ix.portfolio.get(b.id)?.size ?? 0) - (ix.portfolio.get(a.id)?.size ?? 0) ||
          compareNames(a.name, b.name),
      );
  }, [ix, lens, state.q]);

  const activeFilters = !!(
    state.q ||
    state.sector ||
    state.province ||
    state.stage ||
    state.market
  );
  const showInstitutions = tab === "institutions" && lens !== "industry";

  return (
    <aside
      className={filtersOnly ? `${styles.directory} ${styles.directoryFilters}` : styles.directory}
      aria-label={filtersOnly ? "List filters" : "Company directory"}
    >
      <div className={styles.dirHead}>
        <label className={styles.search}>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="Search companies and institutions"
            placeholder="Search by name, sector or city"
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
          />
          {query && (
            <button aria-label="Clear search" onClick={() => changeQuery("", true)}>
              <X size={14} />
            </button>
          )}
        </label>
        <div className={styles.filters}>
          <select
            aria-label="Sector"
            value={state.sector}
            onChange={(e) => update({ sector: e.target.value })}
          >
            <option value="">All sectors</option>
            {ix.sectors.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Province"
            value={state.province}
            onChange={(e) => update({ province: e.target.value })}
          >
            <option value="">All provinces</option>
            {ix.provinces.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            aria-label="Latest verified funding stage"
            value={state.stage}
            onChange={(e) => update({ stage: e.target.value })}
          >
            <option value="">Any funding stage</option>
            {Object.entries(STAGE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            aria-label="Public or private"
            value={state.market}
            onChange={(e) => update({ market: e.target.value as ExplorerState["market"] })}
          >
            <option value="">Public and private</option>
            <option value="private">Private</option>
            <option value="public">Public</option>
          </select>
        </div>
        {activeFilters && (
          <ul className={styles.chips} aria-label="Active filters">
            {(
              [
                ["q", state.q ? `Search: ${state.q}` : ""],
                ["sector", ix.sectors.find((x) => x.id === state.sector)?.label ?? state.sector],
                ["province", state.province],
                ["stage", state.stage ? (STAGE_LABEL[state.stage] ?? state.stage) : ""],
                [
                  "market",
                  state.market === "private"
                    ? "Private"
                    : state.market === "public"
                      ? "Public"
                      : "",
                ],
              ] as const
            )
              .filter(([, label]) => label)
              .map(([key, label]) => (
                <li key={key}>
                  <button
                    type="button"
                    aria-label={`Remove filter: ${label}`}
                    onClick={() => (key === "q" ? changeQuery("", true) : update({ [key]: "" }))}
                  >
                    {label} <X size={11} aria-hidden="true" />
                  </button>
                </li>
              ))}
          </ul>
        )}
        {activeFilters && (
          <button
            className={styles.reset}
            onClick={() => update({ q: "", sector: "", province: "", stage: "", market: "" })}
          >
            Clear filters
          </button>
        )}
        {filtersOnly && (
          <p className={styles.small} role="status">
            {companies.length} {companies.length === 1 ? "company matches" : "companies match"}.
          </p>
        )}
      </div>

      {!filtersOnly && (
        <>
          <div className={styles.tabs} role="tablist" aria-label="Directory">
            <button
              role="tab"
              aria-selected={!showInstitutions}
              onClick={() => setTab("companies")}
            >
              Companies <span className="num">{companies.length}</span>
            </button>
            {lens !== "industry" && (
              <button
                role="tab"
                aria-selected={showInstitutions}
                onClick={() => setTab("institutions")}
              >
                {lens === "capital" ? "Investors" : "Government"}{" "}
                <span className="num">{institutions.length}</span>
              </button>
            )}
          </div>

          <ul
            className={styles.list}
            ref={listRef}
            onScroll={(e) =>
              setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
            }
          >
            {showInstitutions
              ? institutions.slice(0, limit).map((o) => (
                  <li key={o.id}>
                    <button
                      className={state.sel === o.id ? styles.rowActive : styles.row}
                      onClick={() => onSelect(o.id)}
                    >
                      <i
                        className={lens === "capital" ? styles.dotInvestor : styles.dotGov}
                        aria-hidden="true"
                      />
                      <span className={styles.rowText}>
                        <span className={styles.rowName}>{o.name}</span>
                        <span
                          className={styles.rowMeta}
                          data-derived="facts cited on the company card and dossier"
                        >
                          {institutionLabel(o)}
                          {lens === "capital" && ix.portfolio.get(o.id)
                            ? `, ${ix.portfolio.get(o.id)!.size} portfolio companies`
                            : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))
              : (() => {
                  const { start, end } = visibleWindow(companies.length, scroll.top, scroll.height);
                  return [
                    start > 0 && (
                      <li key="pad-top" aria-hidden="true" style={{ height: start * ROW_H }} />
                    ),
                    ...companies.slice(start, end).map((c, i) => (
                      <li key={c.id} aria-setsize={companies.length} aria-posinset={start + i + 1}>
                        <button
                          className={state.sel === c.id ? styles.rowActive : styles.row}
                          onClick={() => onSelect(c.id)}
                        >
                          <i className={styles.dotCompany} aria-hidden="true" />
                          <span className={styles.rowText}>
                            <span className={styles.rowName}>{c.name}</span>
                            <span
                              className={styles.rowMeta}
                              data-derived="facts cited on the company card and dossier"
                            >
                              {c.segment.value?.label ?? "Unclassified"}
                              {c.hq.value?.province ? `, ${c.hq.value.province}` : ""}
                              {c.marketStatus === "public" ? ", public" : ""}
                              {c.operating === "acquired" ? ", acquired" : ""}
                            </span>
                          </span>
                        </button>
                      </li>
                    )),
                    end < companies.length && (
                      <li
                        key="pad-bottom"
                        aria-hidden="true"
                        style={{ height: (companies.length - end) * ROW_H }}
                      />
                    ),
                  ];
                })()}
            {showInstitutions && institutions.length > limit && (
              <li>
                <button className={styles.more} onClick={() => setLimit((l) => l + PAGE)}>
                  Show more
                </button>
              </li>
            )}
            {!showInstitutions && ix.companies.length === 0 && (
              <li className={styles.empty}>No companies are published yet.</li>
            )}
            {!showInstitutions && ix.companies.length > 0 && companies.length === 0 && (
              <li className={styles.empty}>
                No companies match these filters.{" "}
                <button
                  onClick={() => update({ q: "", sector: "", province: "", stage: "", market: "" })}
                >
                  Clear filters
                </button>
              </li>
            )}
          </ul>
        </>
      )}
    </aside>
  );
}
