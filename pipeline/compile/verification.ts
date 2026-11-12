/**
 * Plain-words verification basis for a published record (docs/VERIFICATION_TIERS.md section 9).
 * Shown in citation cards and the dossier's evidence list, with the date the check ran.
 */
import type { Review, Source } from "../../src/domain/schema/corpus";
import type { VerificationView } from "../../src/domain/schema/snapshot";

/** The row reference in a dataset locator ("ref_number=…" or "reference_number=…"), if any. */
function rowReference(locator: string): string | null {
  const m = /(?:^|;)(?:reference_number|ref_number)=([^;]+)/.exec(locator);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

export function verificationView(
  review: Review,
  evidence: { sourceId: string; locator: string }[],
  /** "contracts" or "grants" for dataset agreements; anything else otherwise. */
  kind: string,
  sources: Map<string, Source>,
): VerificationView {
  const at = review.at;
  const cited = evidence.map((e) => sources.get(e.sourceId)).filter((s): s is Source => !!s);
  const first = cited[0];
  if (cited.length && cited.every((s) => s.kind === "licensed_database"))
    return {
      kind: "licensed",
      at,
      label: `Reported by ${first!.publisher} (licensed); original source not found`,
    };
  switch (review.basis?.kind ?? "owner_record") {
    case "tier1_dataset_match": {
      const ref = evidence.map((e) => rowReference(e.locator)).find(Boolean);
      const dataset = kind === "contracts" ? "contracts" : "grants";
      return {
        kind: "tier1_dataset_match",
        at,
        label: `Matches the federal ${dataset} dataset${ref ? `, row ${ref}` : ""}, checked ${at}`,
      };
    }
    case "tier2_source_check":
      return {
        kind: "tier2_source_check",
        at,
        label: first
          ? `Confirmed in ${first.publisher}'s ${first.title}; independently re-found, checked ${at}`
          : `Confirmed in a saved copy of the source; independently re-found, checked ${at}`,
      };
    case "policy_clearance":
      // Never "reviewed by the owner": the owner accepted the batch, the checks verified the record.
      return {
        kind: "policy_clearance",
        at,
        label: first
          ? `Passed CANDEF's verification checks against ${first.publisher}; batch accepted by the owner ${at}`
          : `Passed CANDEF's verification checks; batch accepted by the owner ${at}`,
      };
    case "owner_judgement":
      return { kind: "owner_judgement", at, label: "CANDEF assessment, reviewed by the owner" };
    default:
      return {
        kind: "owner_record",
        at,
        label: first ? `Reviewed by the owner against ${first.publisher}` : "Reviewed by the owner",
      };
  }
}
