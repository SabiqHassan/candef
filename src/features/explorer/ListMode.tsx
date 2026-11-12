import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useData } from "../../app/DataContext";
import { compareNames } from "../../domain";
import { financingCitations } from "../../domain/claims";
import { formatTotals } from "../../domain/format";
import type { OrgView } from "../../domain/schema/snapshot";
import { CitationChips, EvidenceChips } from "../../ui/provenance";
import styles from "./explorer.module.css";

type SortKey = "name" | "sector" | "province" | "stage" | "contracts";
/**
 * Rows rendered at first and added per step. Rendering every company at once cost 2 s and 142,000
 * DOM nodes at 3,000 companies (bench/stress); the rest render as the reader scrolls or asks.
 */
export const LIST_PAGE = 100;
const SORT_LABEL: Record<SortKey, string> = {
  name: "Company",
  sector: "Sector",
  province: "Province",
  stage: "Latest round",
  contracts: "Procurement contracts",
};

/**
 * Accessible table view of the filtered universe. Also the automatic fallback when 3D is
 * unavailable; it offers the same selection, card and dossier as the graph.
 */
export function ListMode({
  companies,
  reason,
  onSelect,
  selected,
  offsetLeft,
  offsetRight,
  onBackToGraph,
}: {
  companies: OrgView[];
  reason: string | null;
  onSelect: (id: string) => void;
  selected: string | null;
  offsetLeft: number;
  offsetRight: number;
  onBackToGraph?: () => void;
}) {
  const ix = useData();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
  const rows = useMemo(() => {
    // Keys are computed once per sort, not inside every comparison.
    const key = (c: OrgView): string | number => {
      switch (sort.key) {
        case "sector":
          return c.segment.value?.sectorLabel ?? "";
        case "province":
          return c.hq.value?.province ?? "";
        case "stage":
          return c.financing?.latestStage ?? "";
        case "contracts":
          return (ix.agreementsByOrg.get(c.id) ?? []).filter((g) => g.family === "procurement")
            .length;
        default:
          return c.name;
      }
    };
    const keyed = companies.map((c) => ({ c, k: key(c) }));
    keyed.sort(
      (a, b) =>
        (typeof a.k === "number" ? a.k - (b.k as number) : compareNames(String(a.k), String(b.k))) *
        sort.dir,
    );
    return keyed.map((x) => x.c);
  }, [companies, sort, ix]);

  // Progressive rendering: a fresh result or a new order starts from the first page again.
  // The limit belongs to one row set; a new set (filter or sort) derives the first page again.
  const [paging, setPaging] = useState({ rows, limit: LIST_PAGE });
  const limit = paging.rows === rows ? paging.limit : LIST_PAGE;
  const setLimit = (next: number) => setPaging({ rows, limit: next });
  // A selected company (for example from a shared link) is always rendered.
  const selectedIndex = selected ? rows.findIndex((c) => c.id === selected) : -1;
  const shown = Math.min(rows.length, Math.max(limit, selectedIndex + 1));
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  // A new row set starts at the top; otherwise the old scroll offset would sit at the end of the
  // shorter first page and immediately load the next one.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [rows]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || shown >= rows.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting))
          setPaging({ rows, limit: Math.min(rows.length, shown + LIST_PAGE) });
      },
      { root: scroller.current, rootMargin: "600px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [shown, rows]);

  const header = (key: SortKey, label: string, numeric = false) => (
    <th
      scope="col"
      className={numeric ? "num" : undefined}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
      >
        {label}
      </button>
    </th>
  );

  return (
    <div
      ref={scroller}
      className={styles.listMode}
      style={{ left: offsetLeft + 16, right: offsetRight + 16 }}
    >
      {reason && (
        <p className={styles.fallback} role="status">
          {reason} Showing the list view instead; every company, card and dossier remains available.
        </p>
      )}
      {onBackToGraph && !reason && (
        <p className={styles.small}>
          {companies.length} companies.{" "}
          <button className={styles.linkBtn} onClick={onBackToGraph}>
            Return to the 3D network
          </button>
        </p>
      )}
      {/* Phones hide the column headers (rows stack), so sorting moves to this control. */}
      <div className={styles.mobileSort}>
        <label>
          Sort by
          <select
            value={sort.key}
            onChange={(e) => setSort((s) => ({ ...s, key: e.target.value as SortKey }))}
          >
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <button
          aria-label={sort.dir === 1 ? "Ascending order" : "Descending order"}
          onClick={() => setSort((s) => ({ ...s, dir: s.dir === 1 ? -1 : 1 }))}
        >
          {sort.dir === 1 ? "↑" : "↓"}
        </button>
      </div>
      <table className={styles.table}>
        <caption className="visually-hidden">Companies matching the current filters</caption>
        <thead>
          <tr>
            {header("name", "Company")}
            {header("sector", "Sector")}
            {header("province", "Province")}
            <th scope="col">Status</th>
            {header("stage", "Latest round")}
            <th scope="col" className="num">
              Disclosed capital
            </th>
            {header("contracts", "Procurement contracts", true)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, shown).map((c) => (
            <ListRow key={c.id} c={c} selected={selected === c.id} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
      <div ref={sentinel} aria-hidden="true" />
      {rows.length > LIST_PAGE && (
        <p className={styles.small} role="status">
          Showing {shown} of {rows.length} companies.{" "}
          {shown < rows.length && (
            <button
              className={styles.linkBtn}
              onClick={() => setLimit(Math.min(rows.length, shown + LIST_PAGE))}
            >
              Show {Math.min(LIST_PAGE, rows.length - shown)} more
            </button>
          )}
        </p>
      )}
    </div>
  );
}

/** One company row. Memoised so a selection re-renders two rows, not the whole list. */
const ListRow = memo(function ListRow({
  c,
  selected,
  onSelect,
}: {
  c: OrgView;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const ix = useData();
  const fin = financingCitations(ix, c);
  const agreements = ix.agreementsByOrg.get(c.id) ?? [];
  return (
    <tr aria-selected={selected}>
      <th scope="row">
        <button className={styles.linkBtn} onClick={() => onSelect(c.id)}>
          {c.name}
        </button>
      </th>
      <td data-label="Sector">
        {c.segment.value?.sectorLabel ?? <span data-state={c.segment.state}>Unclassified</span>}{" "}
        <EvidenceChips
          assertionIds={c.segment.assertionIds}
          basis={c.segment.epistemic === "analyst_interpretation" ? "interpretation" : "sourced"}
        />
      </td>
      <td data-label="Province">
        {c.hq.value?.province ?? <span data-state={c.hq.state}>Not stated</span>}{" "}
        <EvidenceChips assertionIds={c.hq.assertionIds} />
      </td>
      <td
        data-label="Status"
        data-derived="listing and ownership facts cited on the card and dossier"
      >
        {[
          c.marketStatus === "public"
            ? "Public"
            : c.marketStatus === "private"
              ? "Private"
              : "Listing status unknown",
          c.ownership.status === "subsidiary" ? "Subsidiary" : null,
          c.operating === "acquired" ? "Acquired" : null,
        ]
          .filter(Boolean)
          .join(", ")}{" "}
        <EvidenceChips assertionIds={[...c.listing.assertionIds, ...c.ownership.assertionIds]} />
      </td>
      <td data-label="Latest round">
        {c.financing?.latestStage ??
          (c.research.financing?.state === "not_researched" ? (
            <span data-state="not_researched">Not yet researched</span>
          ) : (
            <span data-state="not_found">None found</span>
          ))}{" "}
        <CitationChips citations={fin.latest} />
      </td>
      <td className="num" data-label="Disclosed capital">
        {c.research.financing?.state === "not_researched" ? (
          <span data-state="not_researched">Not yet researched</span>
        ) : !c.financing?.roundsKnown ? (
          <span data-state="not_found">None found</span>
        ) : c.financing.totals.length ? (
          formatTotals(c.financing.totals)
        ) : (
          <span data-state="undisclosed">Undisclosed</span>
        )}{" "}
        <CitationChips citations={fin.total} basis="derived" />
      </td>
      <td
        className="num"
        data-label="Procurement contracts"
        data-derived="procurement contracts listed in the dossier"
      >
        {c.research.agreements?.state === "not_researched" && !agreements.length
          ? "Not yet researched"
          : agreements.filter((g) => g.family === "procurement").length}
      </td>
    </tr>
  );
});
