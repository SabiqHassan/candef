import type { ContractRow, GrantRow } from "./tbs";
export interface ChainIssue {
  code: string;
  row: number;
  reason: string;
}
/** Exact decimal sum; used for checks only, never for choosing an agreement's value. */
export function decimalSum(values: string[]): string {
  const scale = Math.max(0, ...values.map((v) => v.split(".")[1]?.length ?? 0));
  let sum = 0n;
  for (const value of values) {
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error("Invalid decimal in arithmetic check");
    const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
    sum += (value.startsWith("-") ? -1n : 1n) * BigInt(whole! + fraction.padEnd(scale, "0"));
  }
  const digits = (sum < 0n ? -sum : sum).toString().padStart(scale + 1, "0");
  const result = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "")
    : digits;
  return (sum < 0n ? "-" : "") + (result || "0");
}
export function auditContractChain(rows: ContractRow[]): ChainIssue[] {
  const issues: ChainIssue[] = [];
  let previous: string | null = null;
  let complete = rows[0]?.instrument_type !== "A";
  if (!complete)
    issues.push({
      code: "missing_original",
      row: 0,
      reason: "No original disclosure; running-total arithmetic cannot be established",
    });
  rows.forEach((r, i) => {
    const tied =
      i > 0 &&
      r.reporting_period === rows[i - 1]!.reporting_period &&
      r.contract_date === rows[i - 1]!.contract_date;
    if (tied) {
      complete = false;
      issues.push({
        code: "chronology_ambiguous",
        row: i,
        reason:
          "Same reporting period/date; fingerprint order is deterministic but does not establish chronology",
      });
    }
    if (
      r.instrument_type === "A" &&
      complete &&
      previous !== null &&
      r.amendment_value !== null &&
      r.contract_value !== null &&
      decimalSum([previous, r.amendment_value]) !== decimalSum([r.contract_value])
    )
      issues.push({
        code: "arithmetic_mismatch",
        row: i,
        reason:
          "Previous disclosed total plus signed amendment differs from disclosed total; source values retained",
      });
    if (r.contract_value === null || (r.instrument_type === "A" && r.amendment_value === null)) {
      complete = false;
      issues.push({
        code: "incomplete_arithmetic",
        row: i,
        reason: "Missing total or delta; no zero or inferred delta substituted",
      });
    }
    if (i > 0 && r.instrument_type !== "A")
      issues.push({
        code: "repeated_original",
        row: i,
        reason:
          "Another original in the same contract history; possible revision or identifier reuse",
      });
    previous = r.contract_value;
  });
  return issues;
}
export function auditGrantChain(rows: GrantRow[]): ChainIssue[] {
  const issues: ChainIssue[] = [];
  if (rows[0]?.amendment_number !== 0)
    issues.push({
      code: "missing_original",
      row: 0,
      reason: "Amendment zero absent; original amount remains unknown",
    });
  rows.forEach((r, i) => {
    const previous = rows[i - 1];
    if (previous && r.amendment_number === previous.amendment_number)
      issues.push({
        code: "repeated_amendment",
        row: i,
        reason: "Repeated amendment number; conflicting disclosures require review",
      });
    if (previous && r.amendment_number > previous.amendment_number + 1)
      issues.push({
        code: "amendment_gap",
        row: i,
        reason: "Missing intermediate amendment; replacement totals are retained, never summed",
      });
    if (r.agreement_value === null)
      issues.push({ code: "missing_total", row: i, reason: "Replacement total not disclosed" });
    if (previous?.amendment_date && r.amendment_date && r.amendment_date < previous.amendment_date)
      issues.push({
        code: "date_reversal",
        row: i,
        reason: "Amendment dates disagree with sequence numbers",
      });
  });
  return issues;
}
