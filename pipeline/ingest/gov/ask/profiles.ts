/**
 * Company profiles for the grant-ask tool: one profile per company, built from the Treasury Board
 * grants file and the contracts file. Plain bookkeeping, no judgement and no topic filter: every
 * for-profit recipient and every contract vendor becomes a profile, so nothing is hidden from the
 * triage stage by a keyword.
 *
 * Identity (the project's rule): grant rows group by business number root, else by normalized name
 * and postal area; a contract attaches to a grant company only by exact normalized name plus the
 * same three-character postal area. A contract whose name and area fit more than one company is left
 * unlinked and counted as ambiguous; a contract that fits no grant company starts a contract-only
 * profile. Amendments are collapsed to the latest row of each agreement.
 *
 * Leads only: nothing here writes under research/.
 */
import { businessNumberRoot, nameKey, postalFsa } from "../../../research/names";

export interface ProfileLine {
  kind: "grant" | "contract";
  date: string;
  department: string;
  ownerOrg: string;
  programme: string;
  title: string;
  description: string;
  value: number;
  ref: string;
}

export interface CompanyProfile {
  key: string;
  name: string;
  otherNames: string[];
  businessNumber: string | null;
  cities: string[];
  provinces: string[];
  areas: string[];
  grantCount: number;
  contractCount: number;
  grantValue: number;
  contractValue: number;
  /** Total of all National Defence contract rows, before any line cap. */
  dndContractValue: number;
  firstDate: string | null;
  lastDate: string | null;
  /** The most informative lines (defence rows first, then newest), at most `maxLines`. */
  lines: ProfileLine[];
}

export interface ProfileStats {
  grantRows: number;
  skippedNotCompany: number;
  contractRows: number;
  contractsLinked: number;
  contractsAmbiguous: number;
  contractOnlyCompanies: number;
}

export const DEFENCE_PROGRAMME =
  /defen[cs]e|ideas\b|diana|\brdii\b|strategic aerospace|\bsadi\b|space|aerospace/i;
export const DEFENCE_DEPARTMENTS = new Set(["dnd-mdn", "csa-asc"]);

const first = (s: string | undefined) => (s ?? "").split("|")[0]!.trim();
const num = (s: string | undefined) => {
  const n = Number((s ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Sort weight: defence-related rows first, then the newest. */
export function linePriority(l: ProfileLine): number {
  const defence =
    DEFENCE_DEPARTMENTS.has(l.ownerOrg) || DEFENCE_PROGRAMME.test(`${l.programme} ${l.title}`);
  return (defence ? 1_000_000_000 : 0) + (Date.parse(l.date || "1970-01-01") || 0) / 1000;
}

interface Acc {
  key: string;
  names: Set<string>;
  bn: string | null;
  cities: Set<string>;
  provinces: Set<string>;
  areas: Set<string>;
  grantRows: ProfileLine[];
  contractLines: ProfileLine[];
  contractCount: number;
  contractValue: number;
  dndContractValue: number;
}

export class ProfileBuilder {
  readonly stats: ProfileStats = {
    grantRows: 0,
    skippedNotCompany: 0,
    contractRows: 0,
    contractsLinked: 0,
    contractsAmbiguous: 0,
    contractOnlyCompanies: 0,
  };
  private readonly accs = new Map<string, Acc>();
  private nameIndex: Map<string, Set<string>> | null = null;
  private readonly seenContracts = new Set<string>();

  constructor(private readonly maxLines = 12) {}

  private acc(key: string): Acc {
    let a = this.accs.get(key);
    if (!a) {
      a = {
        key,
        names: new Set(),
        bn: null,
        cities: new Set(),
        provinces: new Set(),
        areas: new Set(),
        grantRows: [],
        contractLines: [],
        contractCount: 0,
        contractValue: 0,
        dndContractValue: 0,
      };
      this.accs.set(key, a);
    }
    return a;
  }

  /** One row of grants.csv. Individuals (recipient_type other than F) are skipped entirely. */
  addGrant(r: Record<string, string>): void {
    this.stats.grantRows++;
    if ((r.recipient_type ?? "").trim() !== "F") {
      this.stats.skippedNotCompany++;
      return;
    }
    const name = first(r.recipient_legal_name);
    if (!name) return;
    const bn = businessNumberRoot(first(r.recipient_business_number));
    const area = postalFsa(first(r.recipient_postal_code));
    const key = bn ? `bn:${bn}` : `n:${nameKey(name)}|${nameKey(first(r.recipient_city))}`;
    const a = this.acc(key);
    a.names.add(name);
    if (bn) a.bn = bn;
    const city = first(r.recipient_city);
    if (city) a.cities.add(city);
    const prov = first(r.recipient_province);
    if (prov) a.provinces.add(prov);
    if (area) a.areas.add(area);
    a.grantRows.push({
      kind: "grant",
      date: r.agreement_start_date ?? "",
      department: first(r.owner_org_title),
      ownerOrg: (r.owner_org ?? "").trim(),
      programme: first(r.prog_name_en),
      title: (r.agreement_title_en ?? "").trim(),
      description: (r.description_en ?? "").trim(),
      value: num(r.agreement_value),
      ref: `${r.ref_number ?? ""}#${r.amendment_number ?? "0"}`,
    });
  }

  private buildNameIndex(): Map<string, Set<string>> {
    const idx = new Map<string, Set<string>>();
    for (const a of this.accs.values())
      for (const n of a.names)
        for (const area of a.areas) {
          const k = `${nameKey(n)}|${area}`;
          let s = idx.get(k);
          if (!s) idx.set(k, (s = new Set()));
          s.add(a.key);
        }
    return idx;
  }

  /** One row of contracts.csv. Call after every grant row has been added. */
  addContract(r: Record<string, string>): void {
    this.stats.contractRows++;
    this.nameIndex ??= this.buildNameIndex();
    const name = first(r.vendor_name);
    if (!name) return;
    const area = postalFsa(first(r.vendor_postal_code));
    const nk = nameKey(name);
    const matches = area ? this.nameIndex.get(`${nk}|${area}`) : undefined;
    let key: string;
    if (matches && matches.size > 1) {
      this.stats.contractsAmbiguous++;
      return;
    }
    if (matches && matches.size === 1) {
      key = [...matches][0]!;
      this.stats.contractsLinked++;
    } else {
      key = `n:${nk}|${area ?? ""}`;
      if (!this.accs.has(key)) this.stats.contractOnlyCompanies++;
    }
    const line: ProfileLine = {
      kind: "contract",
      date: r.contract_date ?? "",
      department: first(r.owner_org_title),
      ownerOrg: (r.owner_org ?? "").trim(),
      programme: "",
      title: "",
      description: (r.description_en ?? "").trim(),
      value: num(r.contract_value),
      ref: r.reference_number ?? "",
    };
    // Contract files repeat an agreement in several years' files: count it once.
    const sig = `${key}|${line.date}|${line.value}|${line.description}|${line.ownerOrg}`;
    if (this.seenContracts.has(sig)) return;
    this.seenContracts.add(sig);
    const a = this.acc(key);
    a.names.add(name);
    if (area) a.areas.add(area);
    a.contractCount++;
    a.contractValue += line.value;
    if (line.ownerOrg === "dnd-mdn") a.dndContractValue += line.value;
    a.contractLines.push(line);
    if (a.contractLines.length > this.maxLines * 3) {
      a.contractLines.sort((x, y) => linePriority(y) - linePriority(x));
      a.contractLines.length = this.maxLines;
    }
  }

  finish(): CompanyProfile[] {
    const out: CompanyProfile[] = [];
    for (const a of this.accs.values()) {
      // Latest amendment of each agreement only.
      const byAgreement = new Map<string, ProfileLine>();
      for (const row of a.grantRows) {
        const [ref, amend] = row.ref.split("#");
        const cur = byAgreement.get(ref!);
        if (!cur || Number(amend) >= Number(cur.ref.split("#")[1])) byAgreement.set(ref!, row);
      }
      const grants = [...byAgreement.values()];
      const all = [...grants, ...a.contractLines];
      all.sort((x, y) => linePriority(y) - linePriority(x));
      const dates = [...grants, ...a.contractLines]
        .map((l) => l.date)
        .filter(Boolean)
        .sort();
      const names = [...a.names].sort((x, y) => x.length - y.length);
      out.push({
        key: a.key,
        name: names[0]!,
        otherNames: names.slice(1, 4),
        businessNumber: a.bn,
        cities: [...a.cities].slice(0, 3),
        provinces: [...a.provinces].slice(0, 2),
        areas: [...a.areas].slice(0, 3),
        grantCount: grants.length,
        contractCount: a.contractCount,
        grantValue: Math.round(grants.reduce((s, l) => s + l.value, 0)),
        contractValue: Math.round(a.contractValue),
        dndContractValue: Math.round(a.dndContractValue),
        firstDate: dates[0] ?? null,
        lastDate: dates.at(-1) ?? null,
        lines: all.slice(0, this.maxLines),
      });
    }
    out.sort((x, y) => (x.key < y.key ? -1 : 1));
    return out;
  }
}
