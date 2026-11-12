import type { Money } from "./schema/corpus";
import type { FieldState, MoneyTotal, FinancingSummary } from "./schema/snapshot";

const compact = (currency: string) =>
  new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
    notation: "compact",
    maximumFractionDigits: 1,
  });

/** Currency-explicit compact money ("CA$12.5M", "US$92M"). Never converts currencies. */
export function formatAmount(amount: string | number, currency: string): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (currency === "unknown") return `${compactNumber(n)} (currency not stated)`;
  try {
    const text = compact(currency).format(n);
    // en-CA renders CAD as a bare "$"; this product mixes CAD and USD, so CAD is always explicit.
    return currency === "CAD" ? text.replace(/^(-?)\$/, "$1CA$") : text;
  } catch {
    return `${currency} ${compactNumber(n)}`;
  }
}

export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

export function formatMoney(m: Money | null): string {
  if (!m) return "Undisclosed";
  if (m.disclosure === "not_applicable") return "No monetary value";
  if (m.disclosure === "undisclosed" || m.amount === null) return "Undisclosed";
  // A single amount disclosed as a range is its upper bound (e.g. a price with an earn-out).
  const prefix = m.disclosure === "approximate" ? "≈ " : m.disclosure === "range" ? "up to " : "";
  return prefix + formatAmount(m.amount, m.currency);
}

export function formatTotals(totals: MoneyTotal[]): string {
  return totals.map((t) => formatAmount(t.amount, t.currency)).join(" + ");
}

/** A missing primary-funding total does not mean the sources withheld every round's amount. */
export function formatFinancingSummary(
  financing: Pick<
    FinancingSummary,
    "totals" | "roundsKnown" | "roundsWithResolvedAmount" | "roundsWithStatedAmount"
  >,
): { headline: string; note: string } {
  const stated = financing.roundsWithStatedAmount ?? financing.roundsWithResolvedAmount;
  const coverage = `${stated} of ${financing.roundsKnown} verified rounds state an amount`;
  if (financing.totals.length) return { headline: formatTotals(financing.totals), note: coverage };
  if (!stated) return { headline: "Undisclosed", note: coverage };
  return {
    headline: "No total",
    note: `${coverage}. Their proceeds, currency or amount basis do not support a primary funding total`,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Preserves partial-date precision: "2024", "Mar 2024", "12 Mar 2024". */
export function formatPartialDate(d: string | null): string {
  if (!d) return "Date not stated";
  const [y, m, day] = d.split("-");
  if (!m) return y!;
  const month = MONTHS[Number(m) - 1] ?? m;
  return day ? `${Number(day)} ${month} ${y}` : `${month} ${y}`;
}

export const STATE_LABEL: Record<FieldState, string> = {
  verified: "Verified",
  unconfirmed: "Reported, not yet verified",
  undisclosed: "Undisclosed",
  not_found: "Not found in reviewed sources",
  not_researched: "Not yet researched",
  disputed: "Sources disagree",
  withheld: "Not shown in this edition",
};

export const STAGE_LABEL: Record<string, string> = {
  pre_seed: "Pre-seed",
  seed: "Seed",
  series_a: "Series A",
  series_b: "Series B",
  series_c: "Series C",
  series_d_plus: "Series D+",
  growth: "Growth",
};

export const BASIS_LABEL: Record<string, string> = {
  award_value: "award value",
  amended_total: "total after amendments",
  awarded: "award value",
  maximum: "maximum potential value",
  announced: "announced value",
  realized: "realized amount",
  unknown: "basis not stated",
};
