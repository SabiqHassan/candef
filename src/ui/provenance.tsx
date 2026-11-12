/**
 * Provenance-aware display primitives. Every fact in the UI goes through <FactValue> so the data
 * state (verified, unconfirmed, undisclosed, not found, not researched, disputed) is always visible
 * and every verified value links to its evidence.
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { STATE_LABEL, formatPartialDate } from "../domain/format";
import { dedupe, type ClaimBasis } from "../domain/claims";
import type { Citation, Fact, VerificationView } from "../domain/schema/snapshot";
import { safeHref } from "../domain/url";
import { decodeGovLocator, departmentLookup, type DepartmentLookup } from "../domain/locator";
import type { SnapshotIndex } from "../domain/index";
import { useData } from "../app/DataContext";
import styles from "./provenance.module.css";

const departmentsByIndex = new WeakMap<SnapshotIndex, DepartmentLookup>();

/** A source locator: government row locators as labelled fields (fingerprint on demand), else raw. */
export function LocatorText({ locator }: { locator: string }) {
  const ix = useData();
  let departments = departmentsByIndex.get(ix);
  if (!departments) {
    departments = departmentLookup(ix.org.values());
    departmentsByIndex.set(ix, departments);
  }
  const decoded = decodeGovLocator(locator, departments);
  if (!decoded) return <code>{locator}</code>;
  return (
    <span className={styles.rowLocator} data-row-locator={decoded.form}>
      {decoded.fields.map((f) => (
        <span key={f.label} className={styles.rowField}>
          <span className={styles.rowLabel}>{f.label}:</span> {f.value}
        </span>
      ))}
      {decoded.fingerprint && (
        <details className={styles.fingerprint}>
          <summary>Row fingerprint</summary>
          <code>{decoded.fingerprint}</code>
        </details>
      )}
    </span>
  );
}

export function StateNote({
  state,
  asOf,
}: {
  state: Fact<unknown>["state"];
  asOf?: string | null;
}) {
  const text = STATE_LABEL[state];
  return (
    <span className={`${styles.state} ${styles[state]}`} data-state={state}>
      {text}
      {state === "not_found" && asOf ? `, as of ${formatPartialDate(asOf)}` : ""}
    </span>
  );
}

export function FactValue<T>({
  fact,
  render,
  showHistory = false,
}: {
  fact: Fact<T>;
  render: (v: T) => ReactNode;
  /** Dossier only: earlier approved values replaced by supersession. */
  showHistory?: boolean;
}) {
  if (fact.state === "verified" && fact.value !== null) {
    const current = (
      <span className={styles.fact}>
        <span>{render(fact.value)}</span>
        {fact.epistemic === "analyst_interpretation" && (
          <span className={styles.tag} title="Analyst interpretation based on cited sources">
            Analyst
          </span>
        )}
        <EvidenceChips
          assertionIds={fact.assertionIds}
          basis={fact.epistemic === "analyst_interpretation" ? "interpretation" : "sourced"}
        />
      </span>
    );
    if (!showHistory || !fact.history?.length) return current;
    return (
      <span className={styles.withHistory}>
        {current}
        {fact.history.map((h, i) => (
          <span key={i} className={styles.history} data-state="superseded">
            Previously {render(h.value)}
            {h.replacedOn ? ` (until ${formatPartialDate(h.replacedOn)})` : ""}{" "}
            <EvidenceChips assertionIds={h.assertionIds} />
          </span>
        ))}
      </span>
    );
  }
  if (fact.state === "disputed" && fact.alternatives) {
    return (
      <span className={styles.disputed}>
        <StateNote state="disputed" />
        {fact.alternatives.map((alt, i) => (
          <span key={i} className={styles.fact}>
            <span>{render(alt.value)}</span>
            <EvidenceChips assertionIds={alt.assertionIds} />
          </span>
        ))}
      </span>
    );
  }
  return <StateNote state={fact.state} asOf={fact.asOf} />;
}

export function EvidenceChips({
  assertionIds,
  basis,
}: {
  assertionIds: string[];
  basis?: ClaimBasis;
}) {
  const { snap } = useData();
  const citations = assertionIds.flatMap((id) => snap.assertions[id]?.evidence ?? []);
  return <CitationChips citations={citations} basis={basis} recordIds={assertionIds} />;
}

const MAX_CHIPS = 3;

/** One chip per cited source, each opening a card that shows the locators used for this claim. */
export function CitationChips({
  citations,
  basis = "sourced",
  recordIds = [],
}: {
  citations: Citation[];
  basis?: ClaimBasis;
  /** The records behind the claim: their verification basis is shown in the card (D-21 section 9). */
  recordIds?: string[];
}) {
  const bySource = new Map<string, Citation[]>();
  for (const c of dedupe(citations)) {
    const list = bySource.get(c.sourceId);
    if (list) list.push(c);
    else bySource.set(c.sourceId, [c]);
  }
  if (bySource.size === 0) return null;
  const entries = [...bySource.entries()];
  return (
    <span className={styles.chips}>
      {entries.slice(0, MAX_CHIPS).map(([id, list]) => (
        <SourceChip key={id} sourceId={id} citations={list} basis={basis} recordIds={recordIds} />
      ))}
      {entries.length > MAX_CHIPS && (
        <span className={styles.more}>+{entries.length - MAX_CHIPS}</span>
      )}
    </span>
  );
}

const QUALITY_LABEL: Record<Citation["quality"], string> = {
  body: "Stated in the source text",
  headline: "Headline or title only",
  related_link: "Reached through a related link",
  metadata: "Page or record metadata",
};

export const CLAIM_BASIS_LABEL: Record<ClaimBasis, string> = {
  sourced: "Sourced fact: the source states it",
  interpretation: "Analyst interpretation: reasoned from the cited sources",
  derived: "Derived: computed from cited records",
};

/**
 * A source chip and its citation card. The card opens BELOW the chip (so it never covers the
 * heading above a value) and flips above only when there is no room below.
 */
export function SourceChip({
  sourceId,
  citations,
  basis = "sourced",
  recordIds = [],
}: {
  sourceId: string;
  citations: Citation[];
  basis?: ClaimBasis;
  recordIds?: string[];
}) {
  const { snap } = useData();
  const checks = verificationLabels(snap.verification, recordIds);
  const [open, setOpen] = useState(false);
  /** Hover previews the card; a click pins it open (click again, Escape or leaving by keyboard closes). */
  const [pinned, setPinned] = useState(false);
  const [place, setPlace] = useState<{ above: boolean; alignRight: boolean }>({
    above: false,
    alignRight: false,
  });
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const s = snap.sources[sourceId];

  useLayoutEffect(() => {
    if (!open || !wrapRef.current || !popRef.current) return;
    const chip = wrapRef.current.getBoundingClientRect();
    const pop = popRef.current.getBoundingClientRect();
    const below = window.innerHeight - chip.bottom;
    setPlace({
      above: below < pop.height + 12 && chip.top > below,
      alignRight: chip.left + pop.width > window.innerWidth - 8,
    });
  }, [open]);

  if (!s) return null;
  const fictional = s.url.includes("example.invalid");
  return (
    <span
      ref={wrapRef}
      className={styles.chipWrap}
      onMouseLeave={() => !pinned && setOpen(false)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setPinned(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setOpen(false);
          setPinned(false);
        }
      }}
    >
      <button
        ref={chipRef}
        type="button"
        className={styles.chip}
        data-source-chip=""
        aria-expanded={open}
        aria-controls={popId}
        aria-label={`Source: ${s.publisher}, ${s.title}`}
        onClick={() => {
          const next = !(open && pinned);
          setOpen(next);
          setPinned(next);
        }}
        onMouseEnter={() => setOpen(true)}
      >
        {s.tier}
      </button>
      {open && (
        <span
          id={popId}
          ref={popRef}
          role="group"
          aria-label={`Citation: ${s.publisher}`}
          className={styles.pop}
          data-citation-card=""
          data-placement={place.above ? "above" : "below"}
          data-align={place.alignRight ? "right" : "left"}
        >
          {/* A visible way to dismiss a pinned card (touch and pointer users); Escape also works. */}
          {pinned && (
            <button
              type="button"
              className={styles.popClose}
              aria-label="Close citation"
              onClick={() => {
                setOpen(false);
                setPinned(false);
                chipRef.current?.focus();
              }}
            >
              ×
            </button>
          )}
          <strong>{s.publisher}</strong>
          <span>{s.title}</span>
          <span className={styles.popMeta}>
            {tierLabel(s.tier)}. Published {formatPartialDate(s.publishedOn)}. Retrieved{" "}
            {s.retrievedAt.slice(0, 10)}.
          </span>
          <span className={styles.popSection}>Where in the source</span>
          <ul className={styles.locators}>
            {citations.map((c) => (
              <li key={c.locator}>
                <LocatorText locator={c.locator} />
                <span className={styles.popMeta}> {QUALITY_LABEL[c.quality]}</span>
              </li>
            ))}
          </ul>
          <span className={styles.popMeta}>{CLAIM_BASIS_LABEL[basis]}</span>
          {checks.length > 0 && (
            <>
              <span className={styles.popSection}>Verification</span>
              {checks.map((c) => (
                <span key={c.label} className={styles.check} data-verification={c.kind}>
                  {c.label}
                </span>
              ))}
            </>
          )}
          {fictional ? (
            <span className={styles.popMeta}>Fictional source (demonstration data)</span>
          ) : safeHref(s.url) ? (
            <a href={safeHref(s.url)!} target="_blank" rel="noreferrer noopener">
              Open source
            </a>
          ) : (
            <span className={styles.popMeta}>Source link unavailable</span>
          )}
        </span>
      )}
    </span>
  );
}

/** Distinct verification labels of the records behind a claim, in record order. */
export function verificationLabels(
  verification: Record<string, VerificationView> | undefined,
  recordIds: string[],
): VerificationView[] {
  const seen = new Map<string, VerificationView>();
  for (const id of recordIds) {
    const v = verification?.[id];
    if (v && !seen.has(v.label)) seen.set(v.label, v);
  }
  return [...seen.values()];
}

export function tierLabel(tier: string): string {
  return (
    {
      T1: "Official record",
      T2: "First-party statement",
      T3: "Independent reporting",
      T4: "Other source",
    }[tier] ?? tier
  );
}

export function DemoTag() {
  return (
    <span className={styles.demoTag} title="Fictional demonstration entity">
      Fictional
    </span>
  );
}
