import { useData } from "../../app/DataContext";
import { STATE_LABEL, formatAmount } from "../../domain/format";
import type { FieldState } from "../../domain/schema/snapshot";
import { Page } from "../../ui/Page";
import { StateNote } from "../../ui/provenance";
import styles from "./methodology.module.css";

/** The one contact address authorized for public display (owner decision P-33). */
const CORRECTIONS_EMAIL = "sabiqhassan1234@gmail.com";

const STATE_EXPLAINED: Record<FieldState, string> = {
  verified:
    "Checked by a reviewer against a source that was actually read. Click the source tag to see it.",
  unconfirmed:
    "Something was reported, but it has not been verified. CANDEF withholds the value rather than show an unchecked number.",
  undisclosed:
    "The event is documented, but the amount or term was never made public. CANDEF never estimates it.",
  not_found:
    "Researched in the listed sources and nothing was found, as of the date shown. It may still exist elsewhere.",
  not_researched: "Nobody has looked yet. This says nothing about whether the information exists.",
  disputed:
    "Reviewed sources disagree. Every value is shown with its source until the conflict is resolved.",
  withheld:
    "Verified, but every source behind it is licensed and does not allow sharing outside the licence. It appears only in the private edition.",
};

const QUALITY_LABEL: Record<string, string> = {
  "possible-duplicate-round": "possible duplicate funding rounds",
  "row-arithmetic": "contract disclosures whose amendments do not add up",
  "cross-dataset-duplicate": "contracts possibly listed in two datasets",
  "no-party-of-record-counterparty": "agreements without a documented buyer or funder",
  "stale-research": "research topics past their review date",
  "consortium-attribution": "consortium awards attributed to one company",
};

export function MethodologyPage() {
  const { snap } = useData();
  const c = snap.coverage;
  return (
    <Page label="Coverage and method" className={styles.page}>
      <h1>Coverage and method</h1>
      {snap.meta.isDemo && !snap.meta.preview && (
        <p className={styles.demo}>
          This build runs on <strong>fictional demonstration data</strong>. Every company, investor,
          government body, amount and source is invented to exercise the product. The verified
          research pilot replaces it with real, sourced records.
        </p>
      )}

      <section className={styles.section}>
        <h2>What the dataset covers</h2>
        <p className={styles.note}>
          Coverage is reported as four separate numbers, never as one percentage: how many companies
          were found, how many have an eligibility decision, which topics were researched, and how
          much researched financing is disclosed.
        </p>
        <ol className={styles.stats} aria-label="Four coverage numbers">
          <Stat n={1} value={c.companiesDiscovered} label="companies discovered" />
          <Stat
            n={2}
            value={c.eligibilityDecided}
            label={`with an eligibility decision; ${c.inUniverse} are in the universe`}
          />
          <Stat
            n={3}
            value={c.researchedByTopic.financing?.researched ?? 0}
            label="in the universe with financing researched (all topics in the table below)"
          />
          <Stat
            n={4}
            value={c.financing.roundsWithResolvedAmount}
            label={`of ${c.financing.roundsKnown} verified rounds have a disclosed amount`}
          />
        </ol>
        <p className={styles.note}>
          Outside the universe: {c.notInUniverse.excluded} excluded, {c.notInUniverse.undecided}{" "}
          without a decision yet, and {c.notInUniverse.awaitingEvidence} included in principle but
          awaiting headquarters or classification evidence. Records: {c.agreements.procurement}{" "}
          procurement contracts, {c.agreements.grants} grants and contributions
          {c.agreements.otherTransfers
            ? `, ${c.agreements.otherTransfers} other transfer payment${c.agreements.otherTransfers === 1 ? "" : "s"}`
            : ""}
          .
        </p>
        {c.quality && Object.keys(c.quality).length > 0 && (
          <p className={styles.note} data-testid="quality-flags">
            Open data-quality flags, each waiting for a human check:{" "}
            {Object.entries(c.quality)
              .map(([check, n]) => `${n} ${QUALITY_LABEL[check] ?? check}`)
              .join("; ")}
            .
          </p>
        )}
        <table className={styles.table}>
          <caption>Research completed, by topic, for companies in the universe</caption>
          <thead>
            <tr>
              <th scope="col">Topic</th>
              <th scope="col">Researched</th>
              <th scope="col">Not yet researched</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(c.researchedByTopic).map(([topic, v]) => (
              <tr key={topic}>
                <th scope="row">
                  {{
                    identity: "Identity and headquarters",
                    financing: "Financing",
                    agreements: "Government relationships",
                    eligibility: "Eligibility",
                  }[topic] ?? topic}
                </th>
                <td className="num">{v.researched}</td>
                <td className="num">{v.notResearched}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.note}>
          {c.isPilotSample
            ? "These counts describe the dataset, not the whole Canadian market. A pilot sample is not market coverage."
            : ""}{" "}
          Private-company financing is often undisclosed, so disclosed totals understate actual
          capital raised.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Who is included</h2>
        <p>
          A company enters the universe only when it has a documented Canadian headquarters and a
          documented reason for a defence-adjacent or dual-use classification. General environmental
          monitoring or a speculative defence application is not enough. Weapons manufacturers are
          in scope; coverage stays at company-level business information.
        </p>
        <p>
          Foreign-owned Canadian subsidiaries, acquired companies and public companies are included
          and labelled. Foreign companies, investors and government bodies appear only as context
          for a documented relationship.
        </p>
      </section>

      <section className={styles.section}>
        <h2>How to read a value</h2>
        <dl className={styles.states}>
          {(Object.keys(STATE_LABEL) as FieldState[]).map((s) => (
            <div key={s}>
              <dt>
                <StateNote state={s} />
              </dt>
              <dd>{STATE_EXPLAINED[s]}</dd>
            </div>
          ))}
        </dl>
        <h3>Source tags</h3>
        <p>
          <span className="num">T1</span> official records, <span className="num">T2</span>{" "}
          first-party statements, <span className="num">T3</span> independent reporting. Articles
          repeating the same announcement count as one source. Anonymously sourced financial figures
          are never published.
        </p>
      </section>

      <section className={styles.section}>
        <h2>Money rules</h2>
        <ul className={styles.rules}>
          <li>
            Successive closes, extensions or revisions of one round are never added together; the
            latest stated round total is used.
          </li>
          <li>A firm and the fund it invests through count as one investor.</li>
          <li>Totals are shown per currency and never converted.</li>
          <li>
            A consortium contract's total is not attributed to a member unless its share is
            disclosed.
          </li>
          <li>
            Contract values distinguish award, amended total and maximum potential value. Amendments
            can reduce a contract.
          </li>
          <li>Grants and contributions are funding, not purchases; a funder is not a customer.</li>
          <li>
            "Other transfer payments" are a separate category in the government disclosure data:
            neither a grant or contribution nor a purchase. They are listed apart, labelled with the
            source's own classification, never drawn as relationship lines, and their value is the
            amount stated in the agreement record, not a confirmed payment.
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>What the network shows</h2>
        <p>{snap.graph.layout.distanceMeaning}</p>
        <p>
          Lines are drawn only for documented relationships. To keep the overview readable, the
          Capital view starts with investor-to-sector bundles, and the Government view draws
          procurement contracts of {formatAmount(snap.meta.thresholdCad, "CAD")} or more. Selecting
          any company or institution shows every documented relationship it has. Smaller contracts
          are listed in company dossiers.
        </p>
      </section>

      <section className={styles.section} aria-labelledby="corrections-heading">
        <h2 id="corrections-heading">Corrections and takedowns</h2>
        <p>
          If a value is wrong, a source has changed, or you want information about you or your
          company reviewed or removed, write to{" "}
          <a href={`mailto:${CORRECTIONS_EMAIL}`}>{CORRECTIONS_EMAIL}</a>. Every request is
          acknowledged within five business days; significant factual, legal or privacy concerns are
          handled urgently, and a retracted record stops being published on the next build.
        </p>
      </section>
    </Page>
  );
}

function Stat({ n, value, label }: { n: number; value: number; label: string }) {
  return (
    <li className={styles.stat}>
      <span className={styles.statN}>{n}</span>
      <span className="num">{value}</span>
      <span>{label}</span>
    </li>
  );
}
