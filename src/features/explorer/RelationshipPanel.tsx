import { X } from "lucide-react";
import { useData } from "../../app/DataContext";
import { BASIS_LABEL, formatMoney, formatPartialDate } from "../../domain/format";
import type { GraphEdgeView } from "../../domain/schema/snapshot";
import { agreementEnd, describeTimeFilter, type TimeFilter } from "../../domain/time";
import { CitationChips } from "../../ui/provenance";
import type { Lens } from "./explorerState";
import styles from "./explorer.module.css";

const BUNDLE_NOUN = {
  capital: "portfolio companies",
  procurement: "companies with procurement contracts",
  grant: "companies with grants or contributions",
} as const;

/**
 * Lists the documented records behind one or more clicked edges. When several edges overlap under
 * the pointer the user chooses here instead of the app guessing (ARCHITECTURE §4 picking).
 */
export function RelationshipPanel({
  edgeIds,
  sceneEdges,
  time,
  onClose,
  onSelect,
}: {
  edgeIds: string[];
  lens: Lens;
  /** The lines as drawn (already time-filtered), so the panel lists exactly what was clicked. */
  sceneEdges: GraphEdgeView[];
  time: TimeFilter | null;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const ix = useData();
  const all = sceneEdges;
  const edges = edgeIds
    .map((id) => all.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => !!e);
  const name = (id: string) =>
    (id.startsWith("anchor:")
      ? ix.sectors.find((s) => `anchor:${s.id}` === id)?.label
      : ix.org.get(id)?.name) ?? id;

  return (
    <div className={styles.card}>
      <header className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <h2>{edges.length > 1 ? `${edges.length} overlapping relationships` : "Relationship"}</h2>
          <p className={styles.small}>
            {edges.length > 1 ? "Several lines pass under the pointer. Choose one." : ""}
            {time ? ` Showing ${describeTimeFilter(time)} only.` : ""}
          </p>
        </div>
        <button
          className={styles.iconBtn}
          aria-label="Close relationship details"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className={styles.cardBody}>
        {edges.map((e) => (
          <section key={e.id} className={styles.section}>
            <h3>
              <button className={styles.linkBtn} onClick={() => onSelect(e.source)}>
                {name(e.source)}
              </button>
              {" and "}
              {e.target.startsWith("anchor:") ? (
                name(e.target)
              ) : (
                <button className={styles.linkBtn} onClick={() => onSelect(e.target)}>
                  {name(e.target)}
                </button>
              )}
            </h3>
            <p className={styles.small}>
              {e.kind === "bundle"
                ? `Aggregate: ${e.weight} ${BUNDLE_NOUN[e.family ?? "capital"]} in this sector`
                : e.kind === "capital"
                  ? `${e.recordIds.length} verified financing round${e.recordIds.length > 1 ? "s" : ""}`
                  : e.kind === "lineage"
                    ? `${e.recordIds.length} verified corporate event${e.recordIds.length > 1 ? "s" : ""}`
                    : e.kind === "grant"
                      ? `${e.recordIds.length} grant or contribution agreement${e.recordIds.length > 1 ? "s" : ""}`
                      : `${e.recordIds.length} procurement contract${e.recordIds.length > 1 ? "s" : ""}`}
              {e.style === "dashed" ? "; independent reporting only" : ""}
            </p>
            {e.kind === "capital" && (
              <ul className={styles.records}>
                {e.recordIds.map((id) => {
                  const r = ix.snap.rounds.find((x) => x.id === id);
                  if (!r) return null;
                  return (
                    <li key={id}>
                      <span>
                        {r.label ?? "Round"}, {formatPartialDate(r.date)}
                      </span>
                      <span className="num">
                        {r.resolved.status === "resolved"
                          ? formatMoney(r.resolved.money)
                          : r.resolved.status === "unclear"
                            ? "Amount unclear"
                            : "Undisclosed"}
                      </span>
                      <CitationChips citations={r.citations} recordIds={[r.id]} />
                    </li>
                  );
                })}
              </ul>
            )}
            {e.kind === "lineage" && (
              <ul className={styles.records}>
                {e.recordIds.map((id) => {
                  const event = ix.org
                    .get(e.source)
                    ?.lineage?.find(
                      (h) => h.assertionIds.includes(id) && h.direction === "predecessor_of",
                    );
                  return event ? (
                    <li key={id}>
                      <span>
                        {name(e.source)} is predecessor of {name(e.target)} (
                        {event.event.replaceAll("_", " ")}, {formatPartialDate(event.date)})
                      </span>
                      <CitationChips
                        citations={ix.snap.assertions[id]?.evidence ?? []}
                        recordIds={[id]}
                      />
                    </li>
                  ) : null;
                })}
              </ul>
            )}
            {(e.kind === "procurement" || e.kind === "grant") && (
              <ul className={styles.records}>
                {e.recordIds.map((id) => {
                  const g = ix.snap.agreements.find((x) => x.id === id);
                  if (!g) return null;
                  const att = g.attributions.find((a) => a.orgId === e.target);
                  return (
                    <li key={id}>
                      <span>
                        {g.title}
                        {g.programName ? ` (${g.programName})` : ""},{" "}
                        {formatPartialDate(g.startOn ?? g.announcedOn)}
                        {agreementEnd(g.rows)
                          ? ` to ${formatPartialDate(agreementEnd(g.rows))}`
                          : ""}
                      </span>
                      <span className="num">
                        {att?.basis === "consortium_undisclosed"
                          ? `Consortium; total ${formatMoney(g.currentValue)}, share undisclosed`
                          : `${formatMoney(att?.money ?? g.currentValue)} (${BASIS_LABEL[g.valueBasis] ?? g.valueBasis})`}
                      </span>
                      <CitationChips citations={g.citations} recordIds={[g.id]} />
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
