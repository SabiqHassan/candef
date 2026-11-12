import { Link } from "react-router";
import { ArrowUpRight, Crosshair, X } from "lucide-react";
import { useData } from "../../app/DataContext";
import { financingCitations } from "../../domain/claims";
import {
  formatAmount,
  formatMoney,
  formatPartialDate,
  formatFinancingSummary,
} from "../../domain/format";
import type { AgreementView, OrgView } from "../../domain/schema/snapshot";
import { CitationChips, DemoTag, EvidenceChips, FactValue, StateNote } from "../../ui/provenance";
import type { Lens } from "./explorerState";
import styles from "./explorer.module.css";

interface Props {
  org: OrgView;
  lens: Lens;
  onClose: () => void;
  onSelect: (id: string) => void;
  onFocus: () => void;
}

/** CAD sum of values attributable to this company (sole party or disclosed allocation only). */
export function attributableCad(agreements: AgreementView[], companyId: string) {
  let total = 0;
  let counted = 0;
  for (const g of agreements) {
    const a = g.attributions.find((x) => x.orgId === companyId);
    if (a?.money?.amount && a.money.currency === "CAD") {
      total += Number(a.money.amount);
      counted++;
    }
  }
  return { total, counted };
}

export function CompanyCard({ org, onClose, onSelect, onFocus }: Props) {
  const ix = useData();
  const rounds = ix.roundsByCompany.get(org.id) ?? [];
  const verified = rounds.filter((r) => r.verification === "verified");
  const investors = new Map<string, { role: string; vehicle: string | null }>();
  for (const r of verified)
    for (const p of r.participants) {
      const prev = investors.get(p.investorId);
      if (!prev || p.role === "lead")
        investors.set(p.investorId, { role: p.role, vehicle: p.vehicleId });
    }
  const agreements = ix.agreementsByOrg.get(org.id) ?? [];
  const contracts = agreements.filter((g) => g.family === "procurement");
  const grants = agreements.filter((g) => g.family === "grant_contribution");
  const otherTransfers = agreements.filter((g) => g.family === "other_transfer");
  const parent = org.ownership.parentId ? ix.org.get(org.ownership.parentId) : undefined;
  const acquisition = ix.snap.acquisitions.find((q) => q.targetId === org.id);
  const fin = org.financing;
  const c = attributableCad(contracts, org.id);
  const gr = attributableCad(grants, org.id);

  return (
    <div className={styles.card}>
      <header className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <h2>{org.name}</h2>
          <div className={styles.badges}>
            {org.isDemo && !ix.snap.meta.preview && <DemoTag />}
            <span className={styles.badge}>
              {org.marketStatus === "public"
                ? "Public"
                : org.marketStatus === "private"
                  ? "Private"
                  : "Listing status unknown"}
            </span>
            {org.ownership.status === "subsidiary" && parent && (
              <span className={styles.badge}>
                Subsidiary{org.ownership.parentIsForeign ? " of a foreign parent" : ""}
              </span>
            )}
            {org.operating === "acquired" && <span className={styles.badge}>Acquired</span>}
          </div>
        </div>
        <button className={styles.iconBtn} aria-label="Close company details" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <div className={styles.cardBody}>
        <p className={styles.segment}>
          <FactValue fact={org.segment} render={(s) => `${s.sectorLabel}: ${s.label}`} />
        </p>
        <p className={styles.description}>
          <FactValue fact={org.description} render={(d) => d} />
        </p>

        <dl className={styles.facts} data-facts="">
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
          <dt>Legal name</dt>
          <dd>
            <FactValue fact={org.legalName} render={(v) => v} />
          </dd>
          <dt>Founded</dt>
          <dd>
            <FactValue fact={org.founded} render={(v) => String(v)} />
          </dd>
          {org.marketStatus === "public" && (
            <>
              <dt>Listing</dt>
              <dd>
                <FactValue fact={org.listing} render={(l) => `${l.exchange}: ${l.ticker}`} />
              </dd>
            </>
          )}
          {parent && (
            <>
              <dt>Parent company</dt>
              <dd>
                <button className={styles.linkBtn} onClick={() => onSelect(parent.id)}>
                  {parent.name}
                </button>
                {org.ownership.since ? `, since ${formatPartialDate(org.ownership.since)}` : ""}{" "}
                <EvidenceChips assertionIds={org.ownership.assertionIds} />
              </dd>
            </>
          )}
          {acquisition && (
            <>
              <dt>Acquisition</dt>
              <dd>
                Completed {formatPartialDate(acquisition.completedOn)}; consideration{" "}
                {formatMoney(acquisition.consideration).toLowerCase()}{" "}
                <CitationChips citations={acquisition.citations} recordIds={[acquisition.id]} />
              </dd>
            </>
          )}
        </dl>

        <section className={styles.section} aria-labelledby="fin-h">
          <h3 id="fin-h">Financing</h3>
          {org.research.financing?.state === "not_researched" ? (
            <StateNote state="not_researched" />
          ) : !fin || fin.roundsKnown === 0 ? (
            <StateNote state="not_found" asOf={org.research.financing?.lastAt} />
          ) : (
            <>
              <p className={styles.metric}>
                <span className="num">{formatFinancingSummary(fin).headline}</span>
                <CitationChips citations={financingCitations(ix, org).total} basis="derived" />
                <span className={styles.metricNote}>{formatFinancingSummary(fin).note}</span>
              </p>
              {fin.latestStage && (
                <p className={styles.small}>
                  Latest verified round: {fin.latestStage}, {formatPartialDate(fin.latestRoundDate)}{" "}
                  <CitationChips citations={financingCitations(ix, org).latest} />
                </p>
              )}
              {fin.flags.map((f) => (
                <p key={f} className={styles.flag}>
                  {f}
                </p>
              ))}
              {investors.size > 0 && (
                <ul className={styles.chipList} aria-label="Investors">
                  {[...investors.entries()].map(([id, info]) => {
                    const inv = ix.org.get(id);
                    const vehicle = info.vehicle ? ix.org.get(info.vehicle) : undefined;
                    return (
                      <li key={id}>
                        <button className={styles.entityChip} onClick={() => onSelect(id)}>
                          <i className={styles.dotInvestor} aria-hidden="true" />
                          {inv?.name ?? "Unknown investor"}
                          {info.role === "lead" && <span className={styles.lead}>lead</span>}
                        </button>
                        {vehicle && <span className={styles.via}>via {vehicle.name}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </section>

        <section className={styles.section} aria-labelledby="gov-h">
          <h3 id="gov-h">Government relationships</h3>
          {org.research.agreements?.state === "not_researched" ? (
            <StateNote state="not_researched" />
          ) : contracts.length + grants.length + otherTransfers.length === 0 ? (
            <StateNote state="not_found" asOf={org.research.agreements?.lastAt} />
          ) : (
            <dl className={styles.facts} data-facts="">
              <dt>Procurement contracts</dt>
              <dd data-derived="agreements listed in the dossier">
                <span className="num">{contracts.length}</span>
                {c.counted > 0 && (
                  <span className={styles.metricNote}>
                    {" "}
                    {formatAmount(c.total, "CAD")} attributable across {c.counted}
                  </span>
                )}
              </dd>
              <dt>Grants and contributions</dt>
              <dd data-derived="agreements listed in the dossier">
                <span className="num">{grants.length}</span>
                {gr.counted > 0 && (
                  <span className={styles.metricNote}>
                    {" "}
                    {formatAmount(gr.total, "CAD")} awarded
                  </span>
                )}
              </dd>
              {otherTransfers.length > 0 && (
                <>
                  <dt>Other transfer payments</dt>
                  <dd data-derived="agreements listed in the dossier">
                    <span className="num">{otherTransfers.length}</span>
                    <span className={styles.metricNote}>
                      {" "}
                      stated agreement amounts, not confirmed payments; listed in the dossier
                    </span>
                  </dd>
                </>
              )}
            </dl>
          )}
          {contracts.some(
            (g) =>
              g.attributions.find((a) => a.orgId === org.id)?.basis === "consortium_undisclosed",
          ) && (
            <p className={styles.flag}>
              Includes consortium awards where this company's share is not disclosed.
            </p>
          )}
        </section>

        <section className={styles.section} aria-labelledby="cov-h">
          <h3 id="cov-h">Research coverage</h3>
          <ul className={styles.coverage}>
            {(["identity", "financing", "agreements", "eligibility"] as const).map((t) => {
              const r = org.research[t];
              return (
                <li key={t}>
                  <span>
                    {
                      {
                        identity: "Identity",
                        financing: "Financing",
                        agreements: "Government",
                        eligibility: "Eligibility",
                      }[t]
                    }
                  </span>
                  <span className={r?.state === "researched" ? styles.ok : styles.muted}>
                    {r?.state === "researched"
                      ? `Researched ${formatPartialDate(r.lastAt)}`
                      : r?.state === "stale"
                        ? `Due for review (last ${formatPartialDate(r.lastAt)})`
                        : "Not yet researched"}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <footer className={styles.cardFoot}>
        <button className={styles.secondary} onClick={onFocus}>
          <Crosshair size={14} /> Frame in view
        </button>
        <Link className={styles.primary} to={`/company/${org.slug}`}>
          Open dossier <ArrowUpRight size={14} />
        </Link>
      </footer>
    </div>
  );
}
