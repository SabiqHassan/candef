/**
 * Snapshot indexes and analytical selectors used across the UI. Pure functions over the snapshot;
 * nothing here invents data.
 */
import type { AgreementView, OrgView, RoundView, Snapshot } from "./schema/snapshot";
import { parseQuery, scoreOrg } from "./search";

export { parseQuery, scoreOrg } from "./search";

export interface SnapshotIndex {
  snap: Snapshot;
  org: Map<string, OrgView>;
  bySlug: Map<string, OrgView>;
  companies: OrgView[];
  roundsByCompany: Map<string, RoundView[]>;
  roundsByInvestor: Map<string, RoundView[]>;
  agreementsByOrg: Map<string, AgreementView[]>;
  /** investor → set of portfolio company ids (verified rounds only). */
  portfolio: Map<string, Set<string>>;
  sectors: { id: string; label: string }[];
  provinces: string[];
}

/** Name order that reads naturally: "Unit 2" before "Unit 10", case and accents ignored. */
export const compareNames: (a: string, b: string) => number = new Intl.Collator("en-CA", {
  numeric: true,
  sensitivity: "base",
}).compare;

// Appends in place: copying the list on every insert was quadratic for hub organizations (a
// department with thousands of agreements; bench/stress, 2026-10-14).
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

export function indexSnapshot(snap: Snapshot): SnapshotIndex {
  const org = new Map(snap.organizations.map((o) => [o.id, o]));
  const bySlug = new Map(snap.organizations.map((o) => [o.slug, o]));
  const companies = snap.organizations
    .filter((o) => o.scope === "universe")
    .sort((a, b) => compareNames(a.name, b.name));
  const roundsByCompany = new Map<string, RoundView[]>();
  const roundsByInvestor = new Map<string, RoundView[]>();
  const portfolio = new Map<string, Set<string>>();
  for (const r of snap.rounds) {
    push(roundsByCompany, r.companyId, r);
    if (r.verification !== "verified") continue;
    for (const p of r.participants) {
      push(roundsByInvestor, p.investorId, r);
      const set = portfolio.get(p.investorId) ?? new Set<string>();
      set.add(r.companyId);
      portfolio.set(p.investorId, set);
    }
  }
  for (const list of roundsByCompany.values())
    list.sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? 1 : -1));
  const agreementsByOrg = new Map<string, AgreementView[]>();
  for (const g of snap.agreements) {
    const ids = new Set(g.parties.map((p) => p.orgId));
    for (const id of ids) push(agreementsByOrg, id, g);
  }
  const sectors = snap.taxonomy
    .filter((t) => t.parentId === null)
    .map((t) => ({ id: t.id, label: t.label }));
  const provinces = [
    ...new Set(companies.map((c) => c.hq.value?.province).filter((p): p is string => !!p)),
  ].sort();
  return {
    snap,
    org,
    bySlug,
    companies,
    roundsByCompany,
    roundsByInvestor,
    agreementsByOrg,
    portfolio,
    sectors,
    provinces,
  };
}

/** Co-investors ranked by number of shared portfolio companies (Capital lens analysis). */
export function coInvestors(ix: SnapshotIndex, investorId: string) {
  const mine = ix.portfolio.get(investorId) ?? new Set<string>();
  const shared = new Map<string, string[]>();
  for (const [other, companies] of ix.portfolio) {
    if (other === investorId) continue;
    const overlap = [...companies].filter((c) => mine.has(c));
    if (overlap.length) shared.set(other, overlap);
  }
  return [...shared.entries()]
    .map(([id, companyIds]) => ({ id, companyIds }))
    .sort((a, b) => b.companyIds.length - a.companyIds.length);
}

/** Sector exposure of an institution's related companies. */
export function sectorExposure(ix: SnapshotIndex, companyIds: Iterable<string>) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const id of companyIds) {
    const s = ix.org.get(id)?.segment.value?.sectorLabel;
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
    total++;
  }
  return [...counts.entries()]
    .map(([label, n]) => ({ label, n, share: total ? n / total : 0 }))
    .sort((a, b) => b.n - a.n);
}

export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

export type MarketFilter = "" | "public" | "private";

export interface CompanyFilters {
  q: string;
  sector: string;
  province: string;
  stage: string;
  market: MarketFilter;
}

export const emptyFilters: CompanyFilters = {
  q: "",
  sector: "",
  province: "",
  stage: "",
  market: "",
};

/** Filtered companies; with a search text, best match first (ties stay in name order). */
export function filterCompanies(ix: SnapshotIndex, f: CompanyFilters): OrgView[] {
  const query = parseQuery(f.q);
  const scores = query.tokens.length ? new Map<OrgView, number>() : null;
  const out = ix.companies.filter((c) => {
    if (f.sector && c.segment.value?.sectorId !== f.sector) return false;
    if (f.province && c.hq.value?.province !== f.province) return false;
    if (f.market && c.marketStatus !== f.market) return false;
    if (f.stage) {
      const latest = (ix.roundsByCompany.get(c.id) ?? []).find(
        (r) => r.verification === "verified",
      );
      if (latest?.stage !== f.stage) return false;
    }
    if (scores) {
      const score = scoreOrg(c, query);
      if (!score) return false;
      scores.set(c, score);
    }
    return true;
  });
  return scores ? out.sort((a, b) => scores.get(b)! - scores.get(a)!) : out;
}

export function institutionLabel(o: OrgView): string {
  switch (o.kind) {
    case "investor_firm":
      return "Investment firm";
    case "fund":
      return "Fund";
    case "government_body":
      return "Government body";
    case "research_institution":
      return "Research institution";
    case "corporate":
      return "Corporation";
    default:
      return "Organization";
  }
}
