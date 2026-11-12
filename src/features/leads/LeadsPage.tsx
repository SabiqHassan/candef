import { AskPanel } from "./AskPanel";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useNavigationType, useSearchParams } from "react-router";
import { formatAmount } from "../../domain/format";
import {
  ruleText,
  recordUrl,
  type LeadsFile,
  type SiteLead,
  type SiteLine,
} from "../../domain/leads/siteTypes";
import { TAG_LABELS, TAG_IDS, type TagId } from "../../domain/leads/vocabulary";
import { Page } from "../../ui/Page";
import { indexLeads, searchLeadsIn, useLeads } from "./leadsData";
import {
  EMPTY_STATE,
  PROGRAMME_CHOICES,
  PROVINCE_CHOICES,
  SINCE_CHOICES,
  VALUE_CHOICES,
  activeFilterCount,
  parseState,
  toParams,
  toQuery,
  type LeadsState,
} from "./leadsState";
import styles from "./leads.module.css";

const cad = (n: number) => formatAmount(n, "CAD");
/** Tags that describe an ordinary supplier rather than a technology area are not offered as filters. */
const TOPIC_TAGS = TAG_IDS.filter(
  (t) =>
    ![
      "construction_facilities",
      "logistics_supply",
      "food_hospitality",
      "professional_services",
    ].includes(t),
);

export function LeadsPage() {
  const load = useLeads();
  if (load.status === "loading")
    return (
      <Page label="Leads from government data" className={styles.page}>
        <h1>Leads from government data</h1>
        <p role="status">Loading the leads…</p>
      </Page>
    );
  if (load.status === "missing")
    return (
      <Page label="Leads from government data" className={styles.page}>
        <h1>Leads from government data</h1>
        <p>This edition of CANDEF does not include the lead search.</p>
      </Page>
    );
  if (load.status === "error")
    return (
      <Page label="Leads from government data" className={styles.page}>
        <h1>Leads from government data</h1>
        <p role="alert">{load.message}</p>
        <p>
          <button type="button" className={styles.action} onClick={load.retry}>
            Try again
          </button>
        </p>
      </Page>
    );
  return <Workspace data={load.data} />;
}

function Workspace({ data }: { data: LeadsFile }) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => parseState(params), [params]);
  const index = useMemo(() => indexLeads(data), [data]);
  const byKey = useMemo(() => new Map(data.leads.map((l) => [l.key, l])), [data]);
  const set = (patch: Partial<LeadsState>, replace = true) =>
    setParams(toParams({ ...state, ...patch }), { replace });
  // Typing stays responsive: ranking runs on a deferred copy of the filters.
  const deferred = useDeferredValue(state);
  const result = useMemo(() => searchLeadsIn(index, toQuery(deferred)), [index, deferred]);
  const selected = state.selected ? byKey.get(state.selected) : undefined;
  const filters = activeFilterCount(state);
  const detailRef = useRef<HTMLDivElement>(null);
  // Opening a lead moves focus to its details (set in the click handler, used once).
  const focusNext = useRef(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // The search box keeps its own text so typing never waits for the URL: the router applies URL
  // changes in a transition, and a controlled box that waits for it can drop fast keystrokes.
  // The URL replaces the text only on back/forward (and when Clear is pressed, below).
  const navType = useNavigationType();
  const [qText, setQText] = useState(state.q);
  const [seenQ, setSeenQ] = useState(state.q);
  if (state.q !== seenQ) {
    setSeenQ(state.q);
    if (navType === "POP") setQText(state.q);
  }
  const onQ = (v: string) => {
    setQText(v);
    set({ q: v, selected: "" });
  };
  useEffect(() => {
    if (focusNext.current && selected) {
      detailRef.current?.focus({ preventScroll: false });
      focusNext.current = false;
    }
  }, [selected]);
  const meta = data.meta;

  return (
    <Page label="Leads from government data" className={styles.page}>
      <h1>Leads from government data</h1>
      <p className={styles.notice} role="note">
        <strong>{data.label}.</strong> These companies appear in federal grant and contract records
        with a plausible defence, security or space link. They are <b>not CANDEF companies</b>:
        nobody has researched or reviewed them, and a government payment does not show a customer
        relationship, an investment or a product.{" "}
        {meta.isDemo ? (
          <span className={styles.demo}>
            Fictional demonstration leads. No company here is real.
          </span>
        ) : (
          <>
            Grants and contracts only, as of {meta.dataDate}. Dates are the first and last
            appearance in this data, not a founding date. Only companies with a clear link (tier A)
            are included: {meta.count.toLocaleString("en-CA")} of 271,398 read.
          </>
        )}
      </p>

      <AskPanel index={index} />

      <div className={styles.workspace}>
        <form
          className={styles.controls}
          role="search"
          aria-label="Search leads"
          onSubmit={(e) => e.preventDefault()}
        >
          <label className={styles.searchLabel}>
            <span>Search leads</span>
            <input
              type="search"
              value={qText}
              placeholder="drone, sonar, IDEaS, satellite"
              onChange={(e) => onQ(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={filtersOpen}
            aria-controls="lead-filters"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            Filters{filters > 0 ? ` (${filters})` : ""}
          </button>
          <div
            id="lead-filters"
            className={styles.filterBody}
            data-open={filtersOpen ? "true" : "false"}
          >
            <div className={styles.filters}>
              <label>
                <span>Province</span>
                <select
                  value={state.province}
                  onChange={(e) => set({ province: e.target.value, selected: "" })}
                >
                  <option value="">Any</option>
                  {PROVINCE_CHOICES.map(([c, n]) => (
                    <option key={c} value={c}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Funded through</span>
                <select
                  value={state.programme}
                  onChange={(e) => set({ programme: e.target.value, selected: "" })}
                >
                  <option value="">Any programme</option>
                  {PROGRAMME_CHOICES.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>First in the data</span>
                <select
                  value={state.since}
                  onChange={(e) => set({ since: e.target.value, selected: "" })}
                >
                  <option value="">Any year</option>
                  {SINCE_CHOICES.map((y) => (
                    <option key={y} value={y}>
                      {y} or later
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Total government money</span>
                <select
                  value={state.maxValue}
                  onChange={(e) => set({ maxValue: Number(e.target.value), selected: "" })}
                >
                  <option value={0}>Any amount</option>
                  {VALUE_CHOICES.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={state.firstGrantOnly}
                  onChange={(e) => set({ firstGrantOnly: e.target.checked, selected: "" })}
                />
                <span>One grant so far</span>
              </label>
            </div>
            <fieldset className={styles.tags}>
              <legend>Sector</legend>
              {TOPIC_TAGS.map((t) => {
                const on = state.tags.includes(t);
                return (
                  <label key={t} className={on ? styles.tagOn : styles.tag}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        set({
                          tags: on ? state.tags.filter((x) => x !== t) : [...state.tags, t],
                          selected: "",
                        })
                      }
                    />
                    <span>{TAG_LABELS[t]}</span>
                  </label>
                );
              })}
            </fieldset>
            <p className={styles.hint}>
              Province is known only for grant recipients: contract-only vendors have no address in
              the data, so the province filter leaves them out.
              {filters > 0 || state.q ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => {
                      setQText("");
                      set({ ...EMPTY_STATE });
                    }}
                  >
                    Clear search and filters
                  </button>
                </>
              ) : null}
            </p>
          </div>
        </form>

        <div className={styles.layout} data-detail={selected ? "open" : "closed"}>
          <section aria-labelledby="results-h" className={styles.results}>
            <h2 id="results-h" className={styles.resultsH}>
              <span aria-live="polite">
                {result.total.toLocaleString("en-CA")} {result.total === 1 ? "lead" : "leads"}
                {result.total > result.hits.length ? `, best ${result.hits.length} shown` : ""}
              </span>
            </h2>
            {result.total === 0 ? (
              <p className={styles.empty}>
                No lead matches. Remove a filter or try a related word (a search for “drone” also
                finds UAS and UAV).
              </p>
            ) : (
              <ul className={styles.list}>
                {result.hits.map(({ d }) => (
                  <li key={d.key}>
                    <button
                      type="button"
                      className={d.key === state.selected ? styles.rowOn : styles.row}
                      aria-current={d.key === state.selected ? "true" : undefined}
                      onClick={() => {
                        set({ selected: d.key }, false);
                        focusNext.current = true;
                      }}
                    >
                      <span className={styles.name}>{d.name}</span>
                      <span className={styles.where}>{where(d)}</span>
                      <span className={styles.why}>{whyLine(d)}</span>
                      <span className={styles.meta}>{metaLine(d)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div
            className={styles.detail}
            ref={detailRef}
            tabIndex={-1}
            role="region"
            aria-label={selected ? `Lead: ${selected.name}` : "Lead details"}
          >
            {selected ? (
              <LeadDetail
                lead={selected}
                isDemo={meta.isDemo}
                onClose={() => set({ selected: "" }, false)}
              />
            ) : (
              <p className={styles.empty}>Select a lead to see the government records behind it.</p>
            )}
          </div>
        </div>
      </div>
      <p className={styles.foot}>
        Source: {meta.sources.join("; ")}. Licence: {meta.licence}.
      </p>
    </Page>
  );
}

/** One entry per rule, with the (1-based) record numbers it fired on, in order. */
export function groupRules(evidence: SiteLead["tierEvidence"]) {
  const groups: { rule: string; lines: number[] }[] = [];
  for (const e of evidence) {
    let g = groups.find((x) => x.rule === e.rule);
    if (!g) groups.push((g = { rule: e.rule, lines: [] }));
    if (e.line !== null && !g.lines.includes(e.line + 1)) g.lines.push(e.line + 1);
  }
  return groups;
}

/** "record 3 below", "records 3, 4 and 5 below", "records 3, 4, 5 and 4 more below". */
export function recordsPhrase(lines: number[]): string {
  if (lines.length === 1) return `record ${lines[0]} below`;
  if (lines.length <= 3)
    return `records ${lines.slice(0, -1).join(", ")} and ${lines.at(-1)} below`;
  return `records ${lines.slice(0, 3).join(", ")} and ${lines.length - 3} more below`;
}

// ---- Row text ------------------------------------------------------------------------------------

const where = (d: SiteLead) =>
  d.cities.length || d.provinces.length
    ? [d.cities[0], d.provinces.join(", ")].filter(Boolean).join(", ")
    : "Location not in the data";

const whyLine = (d: SiteLead) => {
  const first = d.tierEvidence[0];
  return first ? ruleText(first.rule) : "Flagged by the AI judge";
};

const metaLine = (d: SiteLead) => {
  const parts = [d.firstDate ? `First in the data ${d.firstDate.slice(0, 7)}` : null];
  if (d.grantValue) parts.push(`${cad(d.grantValue)} in grants`);
  if (d.contractValue) parts.push(`${cad(d.contractValue)} in contracts`);
  return parts.filter(Boolean).join(" · ");
};

// ---- Detail --------------------------------------------------------------------------------------

function LeadDetail({
  lead,
  isDemo,
  onClose,
}: {
  lead: SiteLead;
  isDemo: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const request = `Research request: ${lead.name}${lead.businessNumber ? ` (business number ${lead.businessNumber})` : ""}. Found as a lead in federal grants and contracts data; not yet researched.`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(request);
      setCopied(true);
    } catch {
      window.prompt("Copy this research request:", request);
    }
  };
  return (
    <article className={styles.card}>
      <button type="button" className={styles.back} onClick={onClose}>
        Back to results
      </button>
      <h2>{lead.name}</h2>
      <p className={styles.badge}>Unverified lead. Not researched by CANDEF.</p>
      <dl className={styles.facts}>
        <dt>Location</dt>
        <dd>{where(lead)}</dd>
        {lead.businessNumber && (
          <>
            <dt>Business number</dt>
            <dd className="num">{lead.businessNumber}</dd>
          </>
        )}
        {lead.otherNames.length > 0 && (
          <>
            <dt>Also appears as</dt>
            <dd>{lead.otherNames.join("; ")}</dd>
          </>
        )}
        <dt>In the data</dt>
        <dd>
          {lead.firstDate ?? "unknown"} to {lead.lastDate ?? "unknown"}
        </dd>
        <dt>Grants</dt>
        <dd>
          {lead.grantAgreements} agreement{lead.grantAgreements === 1 ? "" : "s"},{" "}
          {cad(lead.grantValue)}
        </dd>
        <dt>Contracts</dt>
        <dd>
          {lead.contractCount} contract{lead.contractCount === 1 ? "" : "s"},{" "}
          {cad(lead.contractValue)}
          {lead.dndContractValue ? ` (${cad(lead.dndContractValue)} National Defence)` : ""}
        </dd>
        {lead.tags.length > 0 && (
          <>
            <dt>Topics</dt>
            <dd>{lead.tags.map((t) => TAG_LABELS[t as TagId]).join(", ")}</dd>
          </>
        )}
      </dl>

      <h3>Why it is a lead</h3>
      <ul className={styles.rules}>
        {lead.tierEvidence.length === 0 && <li>Flagged by the AI judge only.</li>}
        {groupRules(lead.tierEvidence).map((g) => (
          <li key={g.rule}>
            {ruleText(g.rule)}
            {g.lines.length ? ` (${recordsPhrase(g.lines)})` : ""}
          </li>
        ))}
      </ul>
      {lead.reason && (
        <p className={styles.judge}>
          <b>AI judge’s note (unverified):</b> {lead.reason}
          {lead.judgeSaidNo && " The judge said no; a rule kept it on the list."}
        </p>
      )}

      <h3>
        Government records ({lead.lines.length}
        {lead.grantCount + lead.contractCount > lead.lines.length
          ? ` of ${lead.grantCount + lead.contractCount}`
          : ""}
        )
      </h3>
      <ol className={styles.records}>
        {lead.lines.map((l, i) => (
          <Record key={i} line={l} isDemo={isDemo} />
        ))}
      </ol>

      <h3>Not in this data</h3>
      <ul className={styles.unknown}>
        <li>Founding year: not in government data.</li>
        <li>What the company makes: only what the records above say.</li>
        <li>Ownership, financing and customers: not researched.</li>
      </ul>
      <p>
        <button type="button" className={styles.action} onClick={copy}>
          Copy research request
        </button>{" "}
        <span role="status" className={styles.copied}>
          {copied ? "Copied. Send it to Claude to put this company in the research queue." : ""}
        </span>
      </p>
    </article>
  );
}

function Record({ line, isDemo }: { line: SiteLine; isDemo: boolean }) {
  const url = isDemo ? null : recordUrl(line);
  return (
    <li className={styles.record}>
      <span className={styles.recordHead}>
        <b>{line.kind === "grant" ? "Grant" : "Contract"}</b> · {line.date} · {line.department}
        {line.programme ? ` · ${line.programme}` : ""}
      </span>
      {line.title && <span className={styles.recordTitle}>{line.title}</span>}
      {line.description && <span className={styles.recordText}>{line.description}</span>}
      <span className={styles.recordFoot}>
        <span className="num">{cad(line.value)}</span>
        <span className="num">Ref {line.ref}</span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            View the government record
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        )}
      </span>
    </li>
  );
}
