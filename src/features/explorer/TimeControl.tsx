/**
 * Time view control (docs/TIME_VIEW.md): all years, relationships that began by a year, or those
 * active during a year. State lives in the URL (asof, tmode) like every other explorer setting.
 */
import { describeTimeFilter, type TimeFilter, type TimeStats } from "../../domain/time";
import styles from "./explorer.module.css";

export function TimeControl({
  filter,
  extent,
  onChange,
}: {
  filter: TimeFilter | null;
  extent: { min: number; max: number };
  onChange: (filter: TimeFilter | null) => void;
}) {
  const year = filter ? Math.min(extent.max, Math.max(extent.min, filter.year)) : extent.max;
  return (
    <div className={styles.time} role="group" aria-label="Time view">
      <label>
        <span>Time</span>
        <select
          value={filter?.mode ?? "all"}
          onChange={(e) => {
            const mode = e.target.value;
            onChange(mode === "all" ? null : { mode: mode as TimeFilter["mode"], year });
          }}
        >
          <option value="all">All years</option>
          <option value="began">Began by end of</option>
          <option value="active">Active during</option>
        </select>
      </label>
      {filter && (
        <>
          <input
            type="range"
            min={extent.min}
            max={extent.max}
            step={1}
            value={year}
            aria-label="Year"
            aria-valuetext={String(year)}
            onChange={(e) => onChange({ mode: filter.mode, year: Number(e.target.value) })}
          />
          <output className={styles.timeYear} aria-hidden="true">
            {year}
          </output>
        </>
      )}
    </div>
  );
}

/** One plain sentence on what the time filter shows and what it leaves out, and why. */
export function timeStatus(filter: TimeFilter, stats: TimeStats): string {
  const parts = [
    `Showing ${describeTimeFilter(filter)}: ${stats.shown} record${stats.shown === 1 ? "" : "s"}.`,
  ];
  if (stats.undated)
    parts.push(
      `${stats.undated} record${stats.undated === 1 ? " has" : "s have"} no date and ${stats.undated === 1 ? "is" : "are"} not placed in time.`,
    );
  if (stats.noEnd)
    parts.push(
      `${stats.noEnd} agreement${stats.noEnd === 1 ? " has" : "s have"} no disclosed end date, so ${stats.noEnd === 1 ? "it is" : "they are"} not counted as active.`,
    );
  parts.push("Cards, dossiers and the list show current facts.");
  return parts.join(" ");
}
