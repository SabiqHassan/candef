import { describe, expect, it } from "vitest";
import { linkRows, contractLink, grantLink } from "./linkage";
import { buildIndex } from "./match";
import { toContractRow, toGrantRow } from "./tbs";

const entity = {
  orgId: "org_fictional_orbit",
  names: ["Fictional Orbit Inc."],
  businessNumbers: ["123456789"],
  postalFsas: ["Z1Z"],
};
const index = buildIndex([entity]);
const contract = (
  ref: string,
  postal = "",
  procurement = "fictional-p",
  name = "Fictional Orbit Incorporated",
) =>
  contractLink(
    toContractRow({
      reference_number: ref,
      procurement_id: procurement,
      vendor_name: name,
      vendor_postal_code: postal,
      owner_org: "fictional",
      reporting_period: "2025-2026-Q1",
      contract_value: "100",
      instrument_type: "C",
    }),
  );
const grant = (ref: string, bn: string, postal: string) =>
  grantLink(
    toGrantRow({
      ref_number: ref,
      agreement_number: ref,
      amendment_number: "0",
      recipient_legal_name: "FICTIONAL ORBIT INC.",
      recipient_business_number: bn,
      recipient_postal_code: postal,
      owner_org: "fictional",
      agreement_type: "C",
      agreement_value: "100",
    }),
  );

describe("anchored evidence linkage", () => {
  it("blocks conflicting source BN roots even when both match a researched postal area", () => {
    const postalOnly = buildIndex([{ ...entity, businessNumbers: [] }]);
    const rows = [
      grant("fictional-shared", "123456789", "Z1Z"),
      grant("fictional-shared", "987654321", "Z1Z"),
    ];
    expect(linkRows(rows, postalOnly).every((d) => d.outcome === "candidate")).toBe(true);
    const suffixes = [
      grant("fictional-shared", "123456789RC0001", "Z1Z"),
      grant("fictional-shared", "123456789RC0002", "Z1Z"),
    ];
    expect(linkRows(suffixes, postalOnly).every((d) => d.outcome === "linked")).toBe(true);
  });
  it("requires a real second identifier; never confirms a name-only component", () => {
    expect(
      linkRows([contract("fictional-a"), contract("fictional-b")], index).every(
        (d) => d.outcome === "candidate",
      ),
    ).toBe(true);
  });
  it("accumulates a procurement anchor across reporting periods with explanation", () => {
    const rows = [contract("fictional-a", "Z1Z"), contract("fictional-b")];
    const decisions = linkRows(rows, index);
    expect(decisions.every((d) => d.status === "confirmed")).toBe(true);
    expect(decisions.find((d) => d.rowId === rows[1]!.rowId)).toMatchObject({
      method: "agreement_anchor",
      anchors: [rows[0]!.rowId],
    });
    expect(linkRows(rows, index)).toEqual(linkRows([...rows].reverse(), index));
  });
  it("learns a postal area from a BN anchor across datasets but never confirms a blank-postal contract by name", () => {
    const rows = [
      grant("fictional-g", "123456789RC0002", "Y2Y"),
      contract("fictional-c", "Y2Y"),
      contract("fictional-n", "", "other-p"),
    ];
    const decisions = linkRows(rows, index);
    expect(decisions.find((d) => d.rowId === rows[1]!.rowId)).toMatchObject({
      status: "confirmed",
      method: "anchor+postal",
    });
    expect(decisions.find((d) => d.rowId === rows[2]!.rowId)?.status).toBe("ambiguous");
  });
  it("keeps malformed BNs and explicit conflicts as human candidates even with matching postal areas", () => {
    for (const bn of ["1234567890001", "987654321"]) {
      expect(linkRows([grant("fictional-g", bn, "Z1Z")], index)[0]?.status).toBe("ambiguous");
    }
  });
  it("blocks an entire procurement when an unknown vendor or consortium shares its key", () => {
    for (const name of ["Fictional Other Inc.", "Fictional Orbit joint venture Fictional Other"]) {
      const rows = [
        contract("fictional-a", "Z1Z"),
        contract("fictional-b", "", "fictional-p", name),
      ];
      expect(linkRows(rows, index).some((d) => d.status === "confirmed")).toBe(false);
    }
  });
  it("keeps parent/subsidiary and department boundaries separate", () => {
    const shared = buildIndex([
      entity,
      { ...entity, orgId: "org_fictional_subsidiary", names: ["Fictional Orbit Sensors Inc."] },
    ]);
    const rows = [
      contract("fictional-a", "Z1Z"),
      contract("fictional-b", "Z1Z", "fictional-p", "Fictional Orbit Sensors Inc."),
    ];
    expect(linkRows(rows, shared).every((d) => d.status !== "confirmed")).toBe(true);
    const other = {
      ...rows[1]!,
      keys: rows[1]!.keys.map((k) => k.replace('"fictional"', '"other-department"')),
    };
    expect(linkRows([rows[0]!, other], shared).every((d) => d.status === "confirmed")).toBe(true);
  });
});
