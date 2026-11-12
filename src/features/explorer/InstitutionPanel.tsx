import { useMemo, useState } from "react";
import { Maximize2, X } from "lucide-react";
import { useData } from "../../app/DataContext";
import { coInvestors, compareNames, institutionLabel, sectorExposure } from "../../domain";
import { formatAmount } from "../../domain/format";
import type { OrgView } from "../../domain/schema/snapshot";
import { DemoTag, EvidenceChips, FactValue } from "../../ui/provenance";
import type { Lens } from "./explorerState";
import styles from "./explorer.module.css";

interface Props {
  org: OrgView;
  lens: Lens;
  onClose: () => void;
  onSelect: (id: string) => void;
  onFrame: () => void;
}

export function InstitutionPanel({ org, lens, onClose, onSelect, onFrame }: Props) {
  const ix = useData();
  const [compare, setCompare] = useState<string | null>(null);
  const portfolio = useMemo(
    () =>
      [...(ix.portfolio.get(org.id) ?? [])]
        .map((id) => ix.org.get(id)!)
        .filter(Boolean)
        .sort((a, b) => compareNames(a.name, b.name)),
    [ix, org.id],
  );
  const co = useMemo(() => coInvestors(ix, org.id).slice(0, 8), [ix, org.id]);
  const agreements = ix.agreementsByOrg.get(org.id) ?? [];
  const contracts = agreements.filter(
    (g) => g.family === "procurement" && g.counterpartyId === org.id,
  );
  const grants = agreements.filter(
    (g) => g.family === "grant_contribution" && g.counterpartyId === org.id,
  );
  const otherTransfers = agreements.filter(
    (g) => g.family === "other_transfer" && g.counterpartyId === org.id,
  );
  const relatedCompanies =
    lens === "capital"
      ? portfolio.map((p) => p.id)
      : [...new Set(agreements.flatMap((g) => g.attributions.map((a) => a.orgId)))];
  const exposure = sectorExposure(ix, relatedCompanies);
  const funds = ix.snap.organizations.filter((o) => o.managedBy === org.id);
  const compareWith = compare ? co.find((c) => c.id === compare) : undefined;
  const sumCad = (list: typeof contracts) =>
    list.reduce(
      (s, g) =>
        s +
        (g.currentValue?.currency === "CAD" && g.currentValue.amount
          ? Number(g.currentValue.amount)
          : 0),
      0,
    );

  return (
    <div className={styles.card}>
      <header className={styles.cardHead}>
        <div className={styles.cardTitle}>
          <h2>{org.name}</h2>
          <div className={styles.badges}>
            {org.isDemo && !ix.snap.meta.preview && <DemoTag />}
            <span className={styles.badge}>{institutionLabel(org)}</span>
            <span className={styles.badge}>Contextual entity</span>
          </div>
        </div>
        <button className={styles.iconBtn} aria-label="Close details" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className={styles.cardBody}>
        <dl className={styles.facts}>
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
          {funds.length > 0 && (
            <>
              <dt>Funds</dt>
              <dd>
                {funds.map((f) => f.name).join("; ")}{" "}
                <EvidenceChips assertionIds={funds.flatMap((f) => f.managedByAssertionIds ?? [])} />
              </dd>
            </>
          )}
        </dl>

        {lens === "capital" && (
          <>
            <section className={styles.section} aria-labelledby="pf-h">
              <h3 id="pf-h">Documented portfolio</h3>
              <p className={styles.metric}>
                <span className="num">{portfolio.length}</span>
                <span className={styles.metricNote}>companies with a verified investment</span>
              </p>
              <Exposure rows={exposure} />
              <ul className={styles.compactList}>
                {portfolio.slice(0, 30).map((p) => (
                  <li key={p.id}>
                    <button className={styles.linkBtn} onClick={() => onSelect(p.id)}>
                      {p.name}
                    </button>
                    <span className={styles.muted}>{p.segment.value?.sectorLabel}</span>
                  </li>
                ))}
              </ul>
              {portfolio.length > 30 && (
                <p className={styles.small}>
                  And {portfolio.length - 30} more; use the list view to see all.
                </p>
              )}
            </section>
            <section className={styles.section} aria-labelledby="co-h">
              <h3 id="co-h">Co-investors</h3>
              {co.length === 0 ? (
                <p className={styles.small}>No shared portfolio companies in the dataset.</p>
              ) : (
                <ul className={styles.compactList}>
                  {co.map((c) => (
                    <li key={c.id}>
                      <button
                        className={styles.linkBtn}
                        aria-pressed={compare === c.id}
                        onClick={() => setCompare(compare === c.id ? null : c.id)}
                      >
                        {ix.org.get(c.id)?.name}
                      </button>
                      <span className="num">{c.companyIds.length} shared</span>
                    </li>
                  ))}
                </ul>
              )}
              {compareWith && (
                <div className={styles.overlap}>
                  <p className={styles.small}>Shared with {ix.org.get(compareWith.id)?.name}:</p>
                  <ul className={styles.compactList}>
                    {compareWith.companyIds.map((id) => (
                      <li key={id}>
                        <button className={styles.linkBtn} onClick={() => onSelect(id)}>
                          {ix.org.get(id)?.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          </>
        )}

        {lens !== "capital" && (
          <section className={styles.section} aria-labelledby="ag-h">
            <h3 id="ag-h">Documented relationships</h3>
            <dl className={styles.facts}>
              <dt>Procurement contracts</dt>
              <dd data-derived="agreements listed on the relationship panel; select a relationship line">
                <span className="num">{contracts.length}</span>
                {contracts.length > 0 && (
                  <span className={styles.metricNote}>
                    {" "}
                    {formatAmount(sumCad(contracts), "CAD")} current disclosed value
                  </span>
                )}
              </dd>
              <dt>Grants and contributions</dt>
              <dd data-derived="agreements listed on the relationship panel; select a relationship line">
                <span className="num">{grants.length}</span>
                {grants.length > 0 && (
                  <span className={styles.metricNote}>
                    {" "}
                    {formatAmount(sumCad(grants), "CAD")} awarded
                  </span>
                )}
              </dd>
              {otherTransfers.length > 0 && (
                <>
                  <dt>Other transfer payments</dt>
                  <dd data-derived="agreements listed in the dossiers of the recipients">
                    <span className="num">{otherTransfers.length}</span>
                    <span className={styles.metricNote}> not drawn as relationship lines</span>
                  </dd>
                </>
              )}
            </dl>
            <p className={styles.small}>
              Grants are funding, not purchases; recipients are not customers.
            </p>
            <Exposure rows={exposure} />
          </section>
        )}
      </div>
      <footer className={styles.cardFoot}>
        <button className={styles.secondary} onClick={onFrame}>
          <Maximize2 size={14} /> Frame relationships
        </button>
      </footer>
    </div>
  );
}

function Exposure({ rows }: { rows: { label: string; n: number; share: number }[] }) {
  if (!rows.length) return null;
  return (
    <ul className={styles.exposure} aria-label="Sector exposure">
      {rows.slice(0, 6).map((r) => (
        <li key={r.label}>
          <span>{r.label}</span>
          <span className={styles.bar} aria-hidden="true">
            <span style={{ width: `${Math.max(4, r.share * 100)}%` }} />
          </span>
          <span className="num">{r.n}</span>
        </li>
      ))}
    </ul>
  );
}
