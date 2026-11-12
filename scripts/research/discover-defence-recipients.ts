/**
 * Candidate discovery for the next research batch, from T1 government data only (never from search
 * results). Streams the local TBS grants and contracts files once and writes, per organization, the
 * defence-relevant evidence found, so a human or agent can choose whom to research next.
 *
 *   npx tsx scripts/research/discover-defence-recipients.ts [--data research-cache/gov-data/<date>]
 *
 * Writes research-cache/discovery/defence-recipients-<date>.json (gitignored). Read-only; it reads
 * the CSV with the importer's reader and changes nothing in research/ or in the importer.
 *
 * Evidence counted per recipient (grouped by business number when the rows have one, else by exact
 * name plus postal area, which is the project's identity rule):
 *   - defence-program contributions: program names containing "defence", IDEaS or RDII;
 *   - National Defence contracts (owner_org dnd-mdn) with a vendor postal area.
 * Individuals (recipient_type P) and government bodies are skipped.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { readCsv } from "../../pipeline/ingest/gov/csv";

const root = process.cwd();
const cache = join(root, "research-cache", "gov-data");
const at = process.argv.indexOf("--data");
const newest = existsSync(cache)
  ? readdirSync(cache)
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && statSync(join(cache, n)).isDirectory())
      .sort()
      .at(-1)
  : undefined;
const data = at > 0 ? resolve(process.argv[at + 1]!) : newest ? join(cache, newest) : null;
if (!data || !existsSync(data)) {
  console.error("Government dataset folder not found.");
  process.exit(1);
}

interface Group {
  names: Record<string, number>;
  bn: string | null;
  postal: Set<string>;
  cities: Set<string>;
  provinces: Set<string>;
  defenceGrants: { ref: string; program: string; value: number; start: string; dept: string }[];
  dndContracts: { ref: string; value: number; date: string; desc: string }[];
}
const groups = new Map<string, Group>();
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const first = (s: string) => (s ?? "").split("|")[0]!.trim();
function group(key: string, init: () => Group): Group {
  let g = groups.get(key);
  if (!g) groups.set(key, (g = init()));
  return g;
}
const blank = (bn: string | null): Group => ({
  names: {},
  bn,
  postal: new Set(),
  cities: new Set(),
  provinces: new Set(),
  defenceGrants: [],
  dndContracts: [],
});

// Grants: defence programs.
{
  const stream = createReadStream(join(data, "grants.csv"));
  const DEFENCE = /defence|defense|ideas|rdii|dnd/i;
  for await (const r of readCsv(stream)) {
    const program = r.prog_name_en ?? "";
    if (!DEFENCE.test(program)) continue;
    if ((r.recipient_type ?? "") === "P" || (r.recipient_type ?? "") === "G") continue;
    const name = first(r.recipient_legal_name ?? "");
    if (!name) continue;
    const bn = (r.recipient_business_number ?? "").replace(/\D/g, "").slice(0, 9) || null;
    const postal = first(r.recipient_postal_code ?? "")
      .replace(/\s/g, "")
      .slice(0, 3)
      .toUpperCase();
    const g = group(bn ? `bn:${bn}` : `n:${norm(name)}|${postal}`, () => blank(bn));
    g.names[name] = (g.names[name] ?? 0) + 1;
    if (postal) g.postal.add(postal);
    const city = first(r.recipient_city ?? "");
    if (city) g.cities.add(city);
    const prov = first(r.recipient_province ?? "");
    if (prov) g.provinces.add(prov);
    g.defenceGrants.push({
      ref: `${r.ref_number};amendment_number=${r.amendment_number}`,
      program,
      value: Number(r.agreement_value || 0),
      start: r.agreement_start_date ?? "",
      dept: r.owner_org ?? "",
    });
  }
  stream.destroy();
}

// Contracts: National Defence vendors with a postal area.
{
  const stream = createReadStream(join(data, "contracts.csv"));
  for await (const r of readCsv(stream)) {
    if ((r.owner_org ?? "") !== "dnd-mdn") continue;
    const name = (r.vendor_name ?? "").trim();
    const postal = (r.vendor_postal_code ?? "").replace(/\s/g, "").slice(0, 3).toUpperCase();
    if (!name || !/^[A-Z]\d[A-Z]$/.test(postal)) continue;
    const g = group(`n:${norm(name)}|${postal}`, () => blank(null));
    g.names[name] = (g.names[name] ?? 0) + 1;
    g.postal.add(postal);
    g.dndContracts.push({
      ref: r.reference_number ?? "",
      value: Number(r.contract_value || 0),
      date: r.contract_date ?? "",
      desc: (r.description_en ?? "").trim().slice(0, 60),
    });
  }
  stream.destroy();
}

// Companies already in research/ (by BN and by normalised name), so they are not proposed twice.
const known = { bn: new Set<string>(), names: new Set<string>() };
for (const f of readdirSync(join(root, "research", "orgs"))) {
  const text = readFileSync(join(root, "research", "orgs", f), "utf8");
  for (const m of text.matchAll(/value:\s*\{\s*system:\s*cra-bn,\s*value:\s*"?(\d{9})/g))
    known.bn.add(m[1]!);
  for (const m of text.matchAll(/^\s+name:\s*"?([^"\n]+)"?/gm)) known.names.add(norm(m[1]!));
  for (const m of text.matchAll(/predicate: legal_name\s*\n\s+value:\s*"?([^"\n]+)"?/g))
    known.names.add(norm(m[1]!));
}
const stripSuffix = (s: string) =>
  norm(s)
    .replace(/\b(inc|ltd|limited|corp|corporation|incorporated|ltee)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
const knownStripped = new Set([...known.names].map(stripSuffix));

const out = [...groups.entries()]
  .map(([key, g]) => {
    const name = Object.entries(g.names).sort((a, b) => b[1] - a[1])[0]![0];
    const isKnown = (g.bn && known.bn.has(g.bn)) || knownStripped.has(stripSuffix(name));
    return {
      key,
      name,
      businessNumber: g.bn,
      postalAreas: [...g.postal],
      cities: [...g.cities].slice(0, 3),
      provinces: [...g.provinces],
      alreadyInResearch: !!isKnown,
      defenceGrantCount: g.defenceGrants.length,
      defenceGrantTotal: Math.round(g.defenceGrants.reduce((s, x) => s + x.value, 0)),
      dndContractCount: g.dndContracts.length,
      dndContractTotal: Math.round(g.dndContracts.reduce((s, x) => s + x.value, 0)),
      defenceGrants: g.defenceGrants.slice(0, 6),
      dndContracts: g.dndContracts.slice(0, 6),
    };
  })
  .filter((x) => x.defenceGrantCount + x.dndContractCount > 0);

const dir = join(root, "research-cache", "discovery");
mkdirSync(dir, { recursive: true });
const file = join(dir, `defence-recipients-${data.split(/[\\/]/).at(-1)}.json`);
writeFileSync(file, JSON.stringify(out));
const fresh = out.filter((x) => !x.alreadyInResearch);
console.log(
  `${out.length} organizations with defence-program grants or National Defence contracts; ${fresh.length} not yet in research/ → ${file}`,
);
