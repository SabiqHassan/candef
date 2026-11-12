import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { useData } from "../../app/DataContext";
import {
  BASIS_LABEL,
  formatMoney,
  formatPartialDate,
  formatFinancingSummary,
} from "../../domain/format";
import { companyClaims, financingCitations } from "../../domain/claims";
import { governmentJurisdiction } from "../../domain/government";
import type { AgreementView } from "../../domain/schema/snapshot";
import { Page } from "../../ui/Page";
import { safeHref } from "../../domain/url";
import {
  CitationChips,
  DemoTag,
  EvidenceChips,
  FactValue,
  LocatorText,
  StateNote,
  tierLabel,
  verificationLabels,
} from "../../ui/provenance";
import styles from "./dossier.module.css";

const IDENTIFIER_LABEL: Record<string, string> = {
  "corporations-canada": "Federal corporation number",
  "cra-bn": "Business number",
  "tbs-owner-org": "TBS department code",
};

/** Disclosure rows are in the agreement's own currency; never assume CAD. */
const rowCurrency = (g: AgreementView) => g.currency ?? g.currentValue?.currency ?? "unknown";

export function DossierPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const ix = useData();
  const [searchParams, setSearchParams] = useSearchParams();
  const org = slug ? ix.bySlug.get(slug) : undefined;
  const redirect = !org && slug ? ix.snap.redirects?.[slug] : undefined;
  if (redirect) return <Navigate to={`/company/${redirect}`} replace />;
  if (!org || (org.scope !== "universe" && !(org.kind === "company" && org.lineage?.length))) {
    return (
      <Page label="Company not found">
        <h1>Company not found</h1>
        <p>
          No company with this address is in the published universe.{" "}
          <Link to="/">Return to the explorer</Link>
        </p>
      </Page>
    );
  }
  const rounds = ix.roundsByCompany.get(org.id) ?? [];
  const allAgreements = ix.agreementsByOrg.get(org.id) ?? [];
  // Labels and the filter appear only once some counterparty has a cited country; otherwise every
  // row would read "not established" (no department carries a country fact yet).
  const showJurisdiction = allAgreements.some((g) =>
    ["canadian", "foreign"].includes(
      governmentJurisdiction(g.counterpartyId ? ix.org.get(g.counterpartyId) : undefined),
    ),
  );
  const rawJurisdiction = searchParams.get("government");
  const jurisdiction =
    showJurisdiction && ["canadian", "foreign", "unknown"].includes(rawJurisdiction ?? "")
      ? rawJurisdiction!
      : "all";
  const agreements = allAgreements.filter(
    (g) =>
      jurisdiction === "all" ||
      governmentJurisdiction(g.counterpartyId ? ix.org.get(g.counterpartyId) : undefined) ===
        jurisdiction,
  );
  const contracts = agreements.filter((g) => g.family === "procurement");
  const grants = agreements.filter((g) => g.family === "grant_contribution");
  const partnerships = agreements.filter((g) => g.family === "partnership");
  const otherTransfers = agreements.filter((g) => g.family === "other_transfer");
  const acquisitions = ix.snap.acquisitions.filter(
    (q) => q.targetId === org.id || q.acquirerId === org.id,
  );
  const parent = org.ownership.parentId ? ix.org.get(org.ownership.parentId) : undefined;
  // Sources section: every cited source with the claims and locators it supports (P-36).
  const claims = companyClaims(ix, org);
  const sourceUse = new Map<string, { label: string; locator: string; checks: string[] }[]>();
  for (const claim of claims)
    for (const c of claim.citations) {
      const list = sourceUse.get(c.sourceId) ?? [];
      const checks = verificationLabels(ix.snap.verification, claim.recordIds).map((v) => v.label);
      list.push({ label: claim.label, locator: c.locator, checks });
      sourceUse.set(c.sourceId, list);
    }
  const withheld = ix.snap.withheldByOrg?.[org.id] ?? 0;
  const sameSub = ix.companies
    .filter((c) => c.id !== org.id && c.segment.value?.id === org.segment.value?.id)
    .slice(0, 8);
  const myInvestors = new Set(rounds.flatMap((r) => r.participants.map((p) => p.investorId)));
  const sharedInvestors = ix.companies
    .filter((c) => c.id !== org.id)
    .map((c) => ({ c, n: [...myInvestors].filter((i) => ix.portfolio.get(i)?.has(c.id)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);

  return (
    <Page label={`${org.name} dossier`} className={styles.dossier}>
      <article>
        <Link
          to={`/?sel=${org.id}`}
          className={styles.back}
          onClick={(e) => {
            // Came from the explorer: go back so the filters, lens and view are kept.
            if (window.history.state?.idx > 0) {
              e.preventDefault();
              navigate(-1);
            }
          }}
        >
          <ArrowLeft size={14} /> Back to the explorer
        </Link>
        <header className={styles.head}>
          <h1>{org.name}</h1>
          <div className={styles.badges}>
            {org.scope === "contextual" && <span>Contextual company history</span>}
            {org.isDemo && !ix.snap.meta.preview && <DemoTag />}
            <span>
              {org.marketStatus === "public"
                ? "Public company"
                : org.marketStatus === "private"
                  ? "Private company"
                  : "Listing status unknown"}
            </span>
            {parent && <span>Subsidiary of {parent.name}</span>}
            {org.operating === "acquired" && <span>Acquired</span>}
          </div>
          <p className={styles.lede}>
            <FactValue fact={org.description} render={(d) => d} />
          </p>
        </header>

        <nav className={styles.toc} aria-label="Dossier sections">
          <a href="#overview">Overview</a>
          <a href="#financing">Financing</a>
          <a href="#government">Government</a>
          <a href="#corporate">Ownership</a>
          <a href="#sources">Sources</a>
          <a href="#quality">Data quality</a>
        </nav>

        <section id="overview" className={styles.section}>
          <h2>Overview</h2>
          <dl className={styles.facts} data-facts="">
            <dt>Legal name</dt>
            <dd>
              <FactValue fact={org.legalName} render={(v) => v} showHistory />
            </dd>
            <dt>Headquarters</dt>
            <dd>
              <FactValue
                fact={org.hq}
                render={(h) =>
                  [h.city, h.province, h.country === "CA" ? "Canada" : h.country]
                    .filter(Boolean)
                    .join(", ")
                }
              />
            </dd>
            <dt>Founded</dt>
            <dd>
              <FactValue fact={org.founded} render={(v) => String(v)} />
            </dd>
            {org.identifiers && org.identifiers.length > 0 && (
              <>
                <dt>Identifiers</dt>
                <dd>
                  {org.identifiers.map((i) => (
                    <span key={`${i.system}:${i.value}`} className={styles.identifier}>
                      {IDENTIFIER_LABEL[i.system] ?? i.system}{" "}
                      <span className="num">{i.value}</span>{" "}
                      <EvidenceChips assertionIds={i.assertionIds} />
                    </span>
                  ))}
                </dd>
              </>
            )}
            <dt>Classification</dt>
            <dd>
              <FactValue fact={org.segment} render={(s) => `${s.sectorLabel}: ${s.label}`} />
              {org.secondarySegments.length > 0 && (
                <span className={styles.muted}>
                  {" "}
                  Also: {org.secondarySegments.map((s) => s.label).join(", ")}
                </span>
              )}
            </dd>
            <dt>Eligibility</dt>
            <dd>
              {org.eligibility ? (
                <>
                  {
                    {
                      included: "Included",
                      excluded: "Excluded",
                      pending: "Pending",
                      ambiguous: "Ambiguous",
                    }[org.eligibility.decision]
                  }
                  . <span className={styles.muted}>{org.eligibility.rationale}</span>{" "}
                  <EvidenceChips
                    assertionIds={org.eligibility.assertionIds}
                    basis="interpretation"
                  />
                </>
              ) : (
                <StateNote state="not_researched" />
              )}
            </dd>
            {org.marketStatus === "public" && (
              <>
                <dt>Listing</dt>
                <dd>
                  <FactValue fact={org.listing} render={(l) => `${l.exchange}: ${l.ticker}`} />
                </dd>
              </>
            )}
          </dl>
        </section>

        <section id="financing" className={styles.section}>
          <h2>Financing history</h2>
          {org.research.financing?.state === "not_researched" ? (
            <StateNote state="not_researched" />
          ) : rounds.length === 0 ? (
            <StateNote state="not_found" asOf={org.research.financing?.lastAt} />
          ) : (
            <>
              <p className={styles.summary}>
                <span className="num">
                  {org.financing
                    ? formatFinancingSummary(org.financing).headline
                    : "No verified rounds"}
                </span>
                {": "}
                {org.financing ? formatFinancingSummary(org.financing).note : ""}. Totals are per
                currency and never converted; successive closes of one round are not added together.{" "}
                <CitationChips citations={financingCitations(ix, org).total} basis="derived" />
              </p>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Round</th>
                    <th scope="col">Date</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Investors</th>
                    <th scope="col">Sources</th>
                  </tr>
                </thead>
                <tbody>
                  {rounds.map((r) =>
                    r.verification !== "verified" ? (
                      <tr key={r.id} className={styles.unverified}>
                        <td colSpan={5}>
                          <StateNote state="unconfirmed" /> A round was reported but has not been
                          verified; its details are withheld.
                        </td>
                      </tr>
                    ) : (
                      <tr key={r.id}>
                        <th scope="row">
                          {r.label}
                          <span className={styles.muted}>
                            {r.eventState === "announced" ? " (announced)" : ""}
                          </span>
                        </th>
                        <td data-label="Date">{formatPartialDate(r.date)}</td>
                        <td data-label="Amount">
                          <span className="num">
                            {r.resolved.status === "resolved"
                              ? formatMoney(r.resolved.money)
                              : r.resolved.status === "unclear"
                                ? "Unclear"
                                : "Undisclosed"}
                          </span>
                          {r.resolved.note && (
                            <span className={styles.note}>{r.resolved.note}</span>
                          )}
                          {r.disclosures.length > 1 && (
                            <ul className={styles.tranches} aria-label="Disclosures">
                              {r.disclosures.map((d) => (
                                <li key={d.id}>
                                  {formatPartialDate(d.date)}: {d.kind.replace("_", " ")},{" "}
                                  <span className="num">{formatMoney(d.amount)}</span>{" "}
                                  <span className={styles.muted}>
                                    (
                                    {d.amountBasis === "cumulative_round_total"
                                      ? "round total"
                                      : d.amountBasis === "incremental"
                                        ? "this tranche"
                                        : "basis unclear"}
                                    )
                                  </span>{" "}
                                  <CitationChips citations={d.citations} recordIds={[r.id]} />
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td data-label="Investors">
                          {r.participants.map((p) => (
                            <span key={p.investorId} className={styles.investor}>
                              {ix.org.get(p.investorId)?.name}
                              {p.role === "lead" ? " (lead)" : ""}
                              {p.vehicleId ? (
                                <span className={styles.muted}>
                                  {" "}
                                  via {ix.org.get(p.vehicleId)?.name}
                                </span>
                              ) : null}
                            </span>
                          ))}
                          {r.participantsCompleteness === "partial_named" && (
                            <span className={styles.muted}>Other investors not named</span>
                          )}
                        </td>
                        <td data-label="Sources">
                          <CitationChips citations={r.citations} recordIds={[r.id]} />
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </>
          )}
        </section>

        <section id="government" className={styles.section}>
          <h2>Government relationships</h2>
          {showJurisdiction && (
            <p className={styles.jurisdiction}>
              <label htmlFor="government-jurisdiction">Government counterparties </label>
              <select
                id="government-jurisdiction"
                value={jurisdiction}
                onChange={(event) => {
                  const next = new URLSearchParams(searchParams);
                  if (event.target.value === "all") next.delete("government");
                  else next.set("government", event.target.value);
                  setSearchParams(next, { replace: true, preventScrollReset: true });
                }}
              >
                <option value="all">All jurisdictions</option>
                <option value="canadian">Canadian government</option>
                <option value="foreign">Foreign government</option>
                <option value="unknown">Jurisdiction unknown</option>
              </select>{" "}
              <span data-derived="jurisdiction filter count">
                {agreements.length} of {allAgreements.length} agreements
              </span>
            </p>
          )}
          {org.research.agreements?.state === "not_researched" ? (
            <StateNote state="not_researched" />
          ) : agreements.length === 0 ? (
            jurisdiction !== "all" ? (
              <p>No agreements match this jurisdiction.</p>
            ) : (
              <StateNote state="not_found" asOf={org.research.agreements?.lastAt} />
            )
          ) : (
            <>
              <AgreementTable
                title="Procurement contracts"
                rows={contracts}
                companyId={org.id}
                showJurisdiction={showJurisdiction}
              />
              <AgreementTable
                title="Grants and contributions"
                rows={grants}
                companyId={org.id}
                showJurisdiction={showJurisdiction}
                note="Funding agreements; the funder is not a customer."
              />
              <AgreementTable
                title="Other transfer payments"
                rows={otherTransfers}
                companyId={org.id}
                showJurisdiction={showJurisdiction}
                note="Other transfer payments are neither a grant or contribution nor a procurement contract, so they are listed apart. The value is the amount stated in the agreement record; it is not a confirmed payment. The funder is not a customer."
              />
              {partnerships.length > 0 && (
                <AgreementTable
                  title="Partnerships and MOUs"
                  rows={partnerships}
                  companyId={org.id}
                  showJurisdiction={showJurisdiction}
                />
              )}
            </>
          )}
        </section>

        <section id="corporate" className={styles.section}>
          <h2>Ownership and corporate events</h2>
          {!!org.lineage?.length && (
            <ul className={styles.events}>
              {org.lineage.map((event) => {
                const counterpart = ix.org.get(event.orgId);
                return (
                  <li key={`${event.direction}:${event.assertionIds.join(":")}`}>
                    {event.direction === "predecessor_of" ? "Predecessor of " : "Successor of "}
                    {counterpart ? (
                      <Link to={`/company/${counterpart.slug}`}>{counterpart.name}</Link>
                    ) : (
                      "Company"
                    )}
                    {` (${event.event.replaceAll("_", " ")}, ${formatPartialDate(event.date)})`}{" "}
                    <EvidenceChips assertionIds={event.assertionIds} />
                  </li>
                );
              })}
            </ul>
          )}
          <dl className={styles.facts} data-facts="">
            <dt>Ownership</dt>
            <dd>
              {parent ? (
                <>
                  Subsidiary of {parent.name}
                  {org.ownership.parentIsForeign ? " (foreign-headquartered parent)" : ""}
                  {org.ownership.since
                    ? ` since ${formatPartialDate(org.ownership.since)}`
                    : ""}{" "}
                  <EvidenceChips assertionIds={org.ownership.assertionIds} />
                </>
              ) : org.ownership.parentState ? (
                <>
                  Parent company:{" "}
                  <StateNote state={org.ownership.parentState} asOf={org.ownership.parentAsOf} />
                </>
              ) : (
                <span data-state="none_documented">No parent company documented</span>
              )}
            </dd>
          </dl>
          {acquisitions.length > 0 && (
            <ul className={styles.events}>
              {acquisitions.map((q) => (
                <li key={q.id}>
                  {q.targetId === org.id
                    ? `Acquired by ${ix.org.get(q.acquirerId)?.name}`
                    : `Acquired ${ix.org.get(q.targetId)?.name}`}
                  , completed {formatPartialDate(q.completedOn)}. Consideration:{" "}
                  {formatMoney(q.consideration)}.
                  {q.withheldReports > 0 && (
                    <span className={styles.muted}>
                      {" "}
                      {q.withheldReports} anonymously sourced price report withheld; such figures
                      are not published.
                    </span>
                  )}{" "}
                  <CitationChips citations={q.citations} recordIds={[q.id]} />
                </li>
              ))}
            </ul>
          )}
          {org.operating === "acquired" && (
            <p className={styles.muted}>
              Financing and contract history before the acquisition is preserved above.
            </p>
          )}
        </section>

        <section id="sources" className={styles.section}>
          <h2>Sources</h2>
          {withheld > 0 && (
            <p className={styles.muted} data-withheld={withheld}>
              {withheld} record{withheld === 1 ? " is" : "s are"} not shown in this edition: their
              sources do not allow sharing outside the licence.
            </p>
          )}
          <ul className={styles.sources}>
            {[...sourceUse.entries()]
              .filter(([id]) => ix.snap.sources[id])
              .map(([id, uses]) => {
                const s = ix.snap.sources[id]!;
                return (
                  <li key={id}>
                    <span className={styles.tier}>{s.tier}</span>
                    <span>
                      <strong>{s.publisher}</strong>, {s.title}. {tierLabel(s.tier)}. Published{" "}
                      {formatPartialDate(s.publishedOn)}; retrieved {s.retrievedAt.slice(0, 10)}.
                      {s.url.includes("example.invalid") ? (
                        <span className={styles.muted}> Fictional source.</span>
                      ) : safeHref(s.url) ? (
                        <>
                          {" "}
                          <a href={safeHref(s.url)!} target="_blank" rel="noreferrer noopener">
                            Open
                          </a>
                        </>
                      ) : (
                        <span className={styles.muted}> Link unavailable.</span>
                      )}
                      <ul className={styles.supports}>
                        {uses.map((u) => (
                          <li key={`${u.label}|${u.locator}`}>
                            <span className={styles.muted}>Supports</span> {u.label}{" "}
                            <LocatorText locator={u.locator} />
                            {u.checks.map((label) => (
                              <span key={label} className={styles.check}>
                                {" "}
                                {label}
                              </span>
                            ))}
                          </li>
                        ))}
                      </ul>
                    </span>
                  </li>
                );
              })}
          </ul>
        </section>

        <section id="quality" className={styles.section}>
          <h2>Research coverage and data quality</h2>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Topic</th>
                <th scope="col">Status</th>
                <th scope="col">Last researched</th>
                <th scope="col">Next review</th>
              </tr>
            </thead>
            <tbody>
              {(["identity", "financing", "agreements", "eligibility"] as const).map((t) => {
                const r = org.research[t];
                return (
                  <tr key={t}>
                    <th scope="row">
                      {
                        {
                          identity: "Identity and headquarters",
                          financing: "Financing",
                          agreements: "Government relationships",
                          eligibility: "Eligibility",
                        }[t]
                      }
                    </th>
                    <td data-label="Status">
                      {r?.state === "researched"
                        ? r.outcome === "none_found"
                          ? "Researched; nothing found"
                          : "Researched"
                        : r?.state === "stale"
                          ? "Due for review"
                          : "Not yet researched"}
                    </td>
                    <td data-label="Last researched">
                      {r?.lastAt ? formatPartialDate(r.lastAt) : "Never"}
                    </td>
                    <td data-label="Next review">
                      {r?.nextReview ? formatPartialDate(r.nextReview) : "Not scheduled"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {org.financing?.flags.map((f) => (
            <p key={f} className={styles.flag}>
              {f}
            </p>
          ))}
        </section>

        <section className={styles.section}>
          <h2>Related companies</h2>
          <div className={styles.related}>
            <div>
              <h3>Same subsector</h3>
              {sameSub.length ? (
                <ul>
                  {sameSub.map((c) => (
                    <li key={c.id}>
                      <Link to={`/company/${c.slug}`}>{c.name}</Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>None in the dataset.</p>
              )}
            </div>
            <div>
              <h3>Shared investors</h3>
              {sharedInvestors.length ? (
                <ul>
                  {sharedInvestors.map(({ c, n }) => (
                    <li key={c.id}>
                      <Link to={`/company/${c.slug}`}>{c.name}</Link>{" "}
                      <span className={styles.muted}>{n} shared</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.muted}>None in the dataset.</p>
              )}
            </div>
          </div>
        </section>
      </article>
    </Page>
  );
}

function AgreementTable({
  title,
  rows,
  companyId,
  note,
  showJurisdiction,
}: {
  title: string;
  rows: AgreementView[];
  companyId: string;
  note?: string;
  showJurisdiction: boolean;
}) {
  const ix = useData();
  if (rows.length === 0) return null;
  return (
    <div className={styles.block}>
      <h3>
        {title} <span className="num">{rows.length}</span>
      </h3>
      {note && <p className={styles.muted}>{note}</p>}
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Agreement</th>
            <th scope="col">Counterparty</th>
            <th scope="col">Attributable to this company</th>
            <th scope="col">Agreement value</th>
            <th scope="col">Sources</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => {
            const att = g.attributions.find((a) => a.orgId === companyId);
            const party = g.parties.find((p) => p.orgId === companyId);
            return (
              <tr key={g.id}>
                <th scope="row">
                  {g.title}
                  <span className={styles.note}>
                    {g.type.replaceAll("_", " ")}, {formatPartialDate(g.announcedOn ?? g.startOn)}
                    {g.programName ? `; ${g.programName}` : ""}
                    {g.sourceClassification
                      ? `; source classification: ${g.sourceClassification.label} (${g.sourceClassification.code})`
                      : ""}
                    {g.repayability && g.repayability !== "unknown"
                      ? `; ${g.repayability.replace("_", " ")}`
                      : ""}
                    {party && party.role !== "prime" && party.role !== "recipient"
                      ? `; role: ${party.role}`
                      : ""}
                  </span>
                  {party && party.reportedName !== ix.org.get(companyId)?.name && (
                    <span className={styles.note}>
                      Contracting entity as reported: {party.reportedName}
                    </span>
                  )}
                </th>
                <td data-label="Counterparty">
                  {g.counterpartyId ? ix.org.get(g.counterpartyId)?.name : "Not stated"}
                  {showJurisdiction &&
                    g.counterpartyId &&
                    (() => {
                      const counterparty = ix.org.get(g.counterpartyId);
                      const scope = governmentJurisdiction(counterparty);
                      if (scope === "other") return null;
                      return (
                        <span className={styles.note}>
                          {scope === "unknown" ? (
                            <span data-state="not_found">
                              Government jurisdiction not established
                            </span>
                          ) : (
                            <>
                              {scope === "foreign" ? "Foreign government" : "Canadian government"} (
                              {counterparty!.hq.value!.country}){" "}
                              <EvidenceChips assertionIds={counterparty!.hq.assertionIds} />
                            </>
                          )}
                        </span>
                      );
                    })()}
                </td>
                <td className="num" data-label="Attributable to this company">
                  {att?.basis === "consortium_undisclosed" ? (
                    <span className={styles.muted}>Share undisclosed (consortium)</span>
                  ) : att?.basis === "not_applicable" ? (
                    "No monetary value"
                  ) : (
                    formatMoney(att?.money ?? null)
                  )}
                </td>
                <td data-label="Agreement value">
                  <span className="num">{formatMoney(g.currentValue)}</span>
                  <span className={styles.note}>
                    {BASIS_LABEL[g.valueBasis] ?? g.valueBasis}
                    {g.originalValue && g.rows.length > 1
                      ? `; original ${formatMoney({ amount: g.originalValue, currency: rowCurrency(g), disclosure: "disclosed", asStated: "" })}`
                      : ""}
                  </span>
                  {g.rows.length > 1 && (
                    <ul className={styles.tranches} aria-label="Amendment history">
                      {g.rows.map((r) => (
                        <li key={r.reportingPeriod}>
                          {r.reportingPeriod}: {r.instrument}
                          {r.amendmentValue ? (
                            <span className="num">
                              {" "}
                              {Number(r.amendmentValue) < 0 ? "−" : "+"}
                              {formatMoney({
                                amount: String(Math.abs(Number(r.amendmentValue))),
                                currency: rowCurrency(g),
                                disclosure: "disclosed",
                                asStated: "",
                              })}
                            </span>
                          ) : null}
                          , total{" "}
                          <span className="num">
                            {formatMoney({
                              amount: r.totalValue,
                              currency: rowCurrency(g),
                              disclosure: "disclosed",
                              asStated: "",
                            })}
                          </span>{" "}
                          <CitationChips
                            citations={r.citation ? [r.citation] : g.citations}
                            recordIds={[g.id]}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                  {g.valueStatements
                    .filter((v) => v.basis.startsWith("maximum"))
                    .map((v, i) => (
                      <span key={i} className={styles.note}>
                        Maximum potential value {formatMoney(v.money)} (options included){" "}
                        <CitationChips citations={v.citations} recordIds={[g.id]} />
                      </span>
                    ))}
                </td>
                <td data-label="Sources">
                  <CitationChips citations={g.citations} recordIds={[g.id]} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
