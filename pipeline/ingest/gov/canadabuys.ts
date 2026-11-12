import { parseDate, parseMoney } from "./tbs";

/** Explicit allowlist: no contactInfo column is ever selected or accessed. */
export const columns = {
  contractNumber: "contractNumber-numeroContrat",
  amendmentNumber: "amendmentNumber-numeroModification",
  amendmentDate: "amendmentDate-dateModification",
  contractAwardDate: "contractAwardDate-dateAttributionContrat",
  referenceNumber: "referenceNumber-numeroReference",
  solicitationNumber: "solicitationNumber-numeroSollicitation",
  procurementNumber: "procurementNumber-numeroApprovisionnement",
  contractAmount: "contractAmount-montantContrat",
  totalContractValue: "totalContractValue-valeurTotaleContrat",
  currency: "contractCurrency-contratMonnaie",
  status: "contractStatus-statutContrat-eng",
  instrumentType: "instrumentType-typeInstrument-eng",
  amendmentType: "amendmentType-typeModification-eng",
  title: "title-titre-eng",
  contractStartDate: "contractStartDate-contratDateDebut",
  contractEndDate: "contractEndDate-dateFinContrat",
  supplierLegalName: "supplierLegalName-nomLegalFournisseur-eng",
  supplierOperatingName: "supplierOperatingName-nomCommercialFournisseur-eng",
  supplierPostal: "supplierAddressPostalCode-fournisseurAdresseCodePostal",
  supplierProvince: "supplierAddressProvince-fournisseurAdresseProvince-eng",
  supplierCountry: "supplierAddressCountry-fournisseurAdressePays-eng",
  contractingEntityName: "contractingEntityName-nomEntitContractante-eng",
  endUserEntitiesName: "endUserEntitiesName-nomEntitesUtilisateurFinal-eng",
} as const;
const allowedColumns = new Set<string>(Object.values(columns));
export function selectColumn(header: string): boolean {
  return allowedColumns.has(header);
}
export function validateHeader(headers: string[]): void {
  const required = [
    columns.contractNumber,
    columns.amendmentNumber,
    columns.supplierLegalName,
    columns.totalContractValue,
    columns.contractingEntityName,
  ];
  const missing = required.filter((column) => !headers.includes(column));
  if (missing.length)
    throw new Error(`canadabuys: missing required columns: ${missing.join(", ")}`);
}
const textFields = [
  "contractNumber",
  "referenceNumber",
  "solicitationNumber",
  "procurementNumber",
  "status",
  "instrumentType",
  "amendmentType",
  "title",
  "supplierOperatingName",
  "supplierPostal",
  "supplierProvince",
  "supplierCountry",
  "contractingEntityName",
  "endUserEntitiesName",
] as const;
const dateFields = [
  "amendmentDate",
  "contractAwardDate",
  "contractStartDate",
  "contractEndDate",
] as const;
const moneyFields = ["contractAmount", "totalContractValue"] as const;
export type CanadaBuysRow = Record<(typeof textFields)[number], string> &
  Record<(typeof dateFields)[number] | (typeof moneyFields)[number], string | null> & {
    supplierLegalName: string;
    amendmentNumber: number;
    currency: string;
    currencyDefaulted: boolean;
  };
export function toCanadaBuysRow(record: Record<string, string>): CanadaBuysRow {
  const rawAmendment = (record[columns.amendmentNumber] ?? "").trim();
  const amendmentNumber = Number(rawAmendment);
  if (!/^\d+$/.test(rawAmendment) || !Number.isSafeInteger(amendmentNumber))
    throw new Error(`Invalid amendmentNumber: ${rawAmendment}`);
  const currency = (record[columns.currency] ?? "").trim().toUpperCase();
  return {
    ...(Object.fromEntries(
      textFields.map((key) => [key, (record[columns[key]] ?? "").trim()]),
    ) as Record<(typeof textFields)[number], string>),
    ...(Object.fromEntries(
      dateFields.map((key) => [key, parseDate(record[columns[key]] ?? "")]),
    ) as Record<(typeof dateFields)[number], string | null>),
    ...(Object.fromEntries(
      moneyFields.map((key) => [key, parseMoney(record[columns[key]] ?? "", columns[key])]),
    ) as Record<(typeof moneyFields)[number], string | null>),
    // Preserve the legal name exactly as stated for the prime party's reportedName.
    supplierLegalName: record[columns.supplierLegalName] ?? "",
    amendmentNumber,
    currency: currency || "CAD",
    currencyDefaulted: !currency,
  };
}
