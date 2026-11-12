/**
 * Financing resolution (DATA_SCHEMA §8, P-19).
 *
 * - Successive closes / extensions / revisions of one round are never added together when a
 *   cumulative round total exists; the latest cumulative total wins.
 * - Incremental tranches are summed only when every tranche is disclosed in one currency and no
 *   cumulative total exists.
 * - Mixed or unknown bases resolve to "unclear" and are excluded from totals.
 * - A firm and its fund are one economic investor (roll-up by `investorId`).
 */
import type { Disclosure, FinancingRound, Money, Source } from "../../src/domain/schema/corpus";
import type { MoneyTotal, RoundView } from "../../src/domain/schema/snapshot";
import { toCitations } from "./citations";
import { hasValidReview } from "./hash";

const add = (a: string, b: string) =>
  (Number(a) + Number(b)).toFixed(Number.isInteger(Number(a) + Number(b)) ? 0 : 2);

export interface ResolvedAmount {
  status: "resolved" | "unclear" | "undisclosed";
  money: Money | null;
  note: string | null;
}

export function publishableDisclosures(
  round: FinancingRound,
  sources: Map<string, Source>,
): Disclosure[] {
  return round.disclosures.filter((d) => {
    if (!hasValidReview("disclosure", d)) return false;
    // Money never rests on anonymous sourcing (P-18).
    return d.evidence.every((e) => sources.get(e.sourceId)?.sourceBasis !== "anonymous_sources");
  });
}

export function resolveRoundAmount(disclosures: Disclosure[]): ResolvedAmount {
  if (disclosures.length === 0)
    return { status: "undisclosed", money: null, note: "No verified amount" };
  const disclosed = disclosures.filter(
    (d) => d.amount.disclosure === "disclosed" && d.amount.amount !== null,
  );
  if (disclosed.length === 0)
    return { status: "undisclosed", money: null, note: "Amount not disclosed" };

  const byDate = [...disclosed].sort((a, b) => (a.date < b.date ? -1 : 1));
  const cumulative = byDate.filter((d) => d.amountBasis === "cumulative_round_total");
  const incremental = byDate.filter((d) => d.amountBasis === "incremental");
  const unknown = byDate.filter((d) => d.amountBasis === "unknown");

  if (cumulative.length > 0) {
    const latest = cumulative[cumulative.length - 1]!;
    const sameCurrency = incremental.filter((d) => d.amount.currency === latest.amount.currency);
    const incSum = sameCurrency.reduce((s, d) => s + Number(d.amount.amount), 0);
    if (incSum > Number(latest.amount.amount) * 1.01) {
      return {
        status: "unclear",
        money: null,
        note: "Sources inconsistent: tranches exceed the stated round total",
      };
    }
    return {
      status: "resolved",
      money: latest.amount,
      note: incremental.length ? "Latest stated round total (tranches not added)" : null,
    };
  }
  if (unknown.length > 0) {
    return {
      status: "unclear",
      money: null,
      note: "Amount basis unclear (possible extension); excluded from totals",
    };
  }
  const currencies = new Set(incremental.map((d) => d.amount.currency));
  const allDisclosed = disclosures.every((d) => d.amount.disclosure === "disclosed");
  if (currencies.size === 1 && allDisclosed && !currencies.has("unknown")) {
    const sum = incremental.reduce((s, d) => add(s, d.amount.amount!), "0");
    const currency = incremental[0]!.amount.currency;
    return {
      status: "resolved",
      money: {
        amount: sum,
        currency,
        disclosure: "disclosed",
        asStated: `sum of ${incremental.length} disclosed tranches`,
      },
      note: incremental.length > 1 ? "Sum of separately disclosed tranches" : null,
    };
  }
  return {
    status: "unclear",
    money: null,
    note: "Tranches in mixed currencies or partly undisclosed",
  };
}

export function buildRoundView(round: FinancingRound, sources: Map<string, Source>): RoundView {
  const verified = hasValidReview("round", round);
  const disclosures = verified ? publishableDisclosures(round, sources) : [];
  const resolved: ResolvedAmount = verified
    ? resolveRoundAmount(disclosures)
    : { status: "unclear", money: null, note: "Reported round; not yet verified" };
  // A tranche link survives only if that disclosure is itself published.
  const published = new Set(disclosures.map((d) => d.id));
  const participants = verified
    ? rollUpParticipants(round).map((p) => ({
        ...p,
        disclosureIds: (p.disclosureIds ?? []).filter((id) => published.has(id)),
      }))
    : [];
  const dates = disclosures.map((d) => d.date).sort();
  return {
    id: round.id,
    companyId: round.companyId,
    label: verified ? round.roundLabelAsStated : null,
    stage: verified ? round.stage : null,
    date: dates[dates.length - 1] ?? null,
    eventState: round.eventState,
    instrument: round.instrument,
    proceeds: round.proceeds,
    resolved,
    disclosures: disclosures.map((d) => ({
      id: d.id,
      date: d.date,
      kind: d.kind,
      amount: d.amount,
      amountBasis: d.amountBasis,
      amountNature: d.amountNature,
      citations: toCitations(d.evidence),
    })),
    participants,
    participantsCompleteness: round.participantsCompleteness,
    verification: verified ? "verified" : round.verification,
    epistemic: round.epistemic,
    sourceIds: verified
      ? [
          ...new Set(
            [...round.evidence, ...disclosures.flatMap((d) => d.evidence)].map((e) => e.sourceId),
          ),
        ]
      : [],
    citations: verified ? toCitations(round.evidence) : [],
  };
}

/** One entry per economic investor; a fund is shown as the vehicle, never as a second investor. */
export function rollUpParticipants(round: FinancingRound): RoundView["participants"] {
  const byInvestor = new Map<string, RoundView["participants"][number]>();
  const rank = { lead: 0, co_lead: 1, participant: 2, unknown: 3 } as const;
  for (const p of round.participations) {
    if (!hasValidReview("participation", p)) continue;
    const existing = byInvestor.get(p.investorId);
    // A firm and its fund are one investor: their evidence is combined under that investor.
    const citations = toCitations([
      ...(existing?.citations ?? []).map((c) => ({
        sourceId: c.sourceId,
        locator: c.locator,
        locatorQuality: c.quality,
      })),
      ...p.evidence,
    ]);
    const disclosureIds = [...new Set([...(existing?.disclosureIds ?? []), ...p.disclosureIds])];
    if (!existing || rank[p.role] < rank[existing.role as keyof typeof rank]) {
      byInvestor.set(p.investorId, {
        investorId: p.investorId,
        vehicleId: p.vehicleId ?? existing?.vehicleId ?? null,
        role: p.role,
        reportedName: p.reportedName,
        citations,
        disclosureIds,
      });
    } else {
      existing.citations = citations;
      existing.disclosureIds = disclosureIds;
    }
  }
  return [...byInvestor.values()];
}

export function totalsByCurrency(rounds: RoundView[]): MoneyTotal[] {
  const totals = new Map<string, string>();
  for (const r of rounds) {
    if (r.verification !== "verified" || r.resolved.status !== "resolved" || !r.resolved.money)
      continue;
    if (r.proceeds !== "primary") continue;
    const { currency, amount } = r.resolved.money;
    if (currency === "unknown" || amount === null) continue;
    totals.set(currency, add(totals.get(currency) ?? "0", amount));
  }
  return [...totals.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));
}
