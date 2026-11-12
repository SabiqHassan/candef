/**
 * The safety net of the triage stage ("never subtract", owner decision 2026-10-18). The AI judge
 * may add a company to the lead list; it may never remove one that carries a structured defence
 * signal or that CANDEF already tracks. A company the judge calls "no" but that has a signal here
 * stays in the list, marked as kept by the safety net, so a bad judgement cannot lose it.
 *
 * Signals are facts in the government rows (a National Defence contract, a defence-programme
 * grant, space-agency funding) or membership of CANDEF's own corpus. They are leads, not evidence.
 */
import type { CompanyProfile } from "./profiles";

export interface KnownCompanies {
  /** Nine-digit business number roots of organizations already in research/. */
  businessNumbers: ReadonlySet<string>;
}

/** Programme names that identify a defence or security programme (not a bare "space" word). */
export const DEFENCE_PROGRAMME_NAMES =
  /innovation for defence|\bideas\b|\bdiana\b|\brdii\b|regional defence investment|strategic aerospace and defence|\bsadi\b|defence industrial|canadian armed forces|national defence/i;

export interface SignalOptions {
  /**
   * Smallest total of National Defence contracts (CA$) that counts as a safety-net signal. The
   * default is 0: any National Defence contract counts, because finding small companies is a goal
   * of the tool and a size floor would hide them (owner decision 2026-10-18). The option exists so
   * a reader can tighten a list, never so a default can drop small companies.
   */
  dndContractMinTotal: number;
}
export const DEFAULT_SIGNAL_OPTIONS: SignalOptions = { dndContractMinTotal: 0 };

const dndContractTotal = (p: CompanyProfile): number => p.dndContractValue;

/** Signals strong enough that a judge's "no" must not remove the company. */
export function safetyNetSignals(
  p: CompanyProfile,
  known?: KnownCompanies,
  opts: SignalOptions = DEFAULT_SIGNAL_OPTIONS,
): string[] {
  const out: string[] = [];
  if (known && p.businessNumber && known.businessNumbers.has(p.businessNumber))
    out.push("already a CANDEF organization");
  if (dndContractTotal(p) > 0 && dndContractTotal(p) >= opts.dndContractMinTotal)
    out.push("National Defence contract");
  if (p.lines.some((l) => l.ownerOrg === "dnd-mdn" && l.kind === "grant"))
    out.push("National Defence grant or contribution");
  const programmes = new Set(
    p.lines.filter((l) => DEFENCE_PROGRAMME_NAMES.test(l.programme)).map((l) => l.programme),
  );
  for (const prog of [...programmes].slice(0, 2)) out.push(`defence programme: ${prog}`);
  if (p.lines.some((l) => l.ownerOrg === "csa-asc")) out.push("Canadian Space Agency funding");
  return [...new Set(out)];
}

/** Facts shown to a reader that did not meet a tightened --min threshold (none by default). */
export function weakNotes(
  p: CompanyProfile,
  opts: SignalOptions = DEFAULT_SIGNAL_OPTIONS,
): string[] {
  const total = dndContractTotal(p);
  return total > 0 && total < opts.dndContractMinTotal
    ? [`National Defence contracts totalling CA$${Math.round(total).toLocaleString("en-CA")}`]
    : [];
}
