/**
 * Lead cards: the reader-facing view of one company. Every claim carries the government rows (or web
 * pages) behind it, so the card can be checked line by line. Facts the data does not give are listed
 * as unknowns, never filled in. Rendering to Markdown lives here too.
 */
import type { LeadRow, TierEvidence } from "../leadIndex";
import type { ProfileLine } from "../profiles";
import { TAGS, type TagId } from "../tags";
import {
  LEAD_LABEL,
  type Answer,
  type Claim,
  type GovSource,
  type LeadCard,
  type Source,
  type UnknownField,
} from "./schema";

export const money = (n: number) => `CA$${Math.round(n).toLocaleString("en-CA")}`;

/** The government row at `line` as a citable source. */
export function govSource(key: string, line: number, l: ProfileLine): GovSource {
  return l.kind === "grant"
    ? {
        kind: "gov_grant",
        key,
        line,
        date: l.date,
        department: l.department,
        programme: l.programme,
        value: l.value,
        ref: l.ref,
      }
    : {
        kind: "gov_contract",
        key,
        line,
        date: l.date,
        department: l.department,
        category: l.description,
        value: l.value,
        ref: l.ref,
      };
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One plain sentence for a government row. */
export function describeLine(l: ProfileLine): string {
  const when = l.date || "undated";
  if (l.kind === "contract")
    return `${l.department} contract (${when}, ${money(l.value)}) in the category "${clip(l.description, 90)}"`;
  const what = l.title ? `, "${clip(l.title, 90)}"` : "";
  return `${l.department} grant (${when}, ${money(l.value)}) under ${clip(l.programme || "an unnamed programme", 80)}${what}`;
}

const RULE_TEXT: Record<string, string> = {
  "1:candef-organization": "is already a CANDEF organization",
  "1:national-defence-grant": "received a National Defence grant or contribution",
  "1:space-agency-grant": "received a Canadian Space Agency grant",
  "1:defence-programme": "received funding under a defence programme",
  "2:strong-category": "has a contract in a defence, space or security equipment category",
  "2:defence-buyer-category":
    "has a National Defence or Space Agency contract for defence-type equipment",
  "3:medium-category": "has National Defence or Space Agency contracts in technical categories",
  "4:defence-text":
    "has a project or contract whose own text mentions a defence, security or space term",
  "B:defence-supplier": "supplies National Defence or the Space Agency (no stronger link found)",
  "C:public-safety-supplier":
    "supplies a public-safety department (RCMP, Correctional Service, CBSA, Public Safety)",
  "D:judge-only": "was judged a possible lead by the triage reader but has no rule evidence",
};

export function ruleText(e: TierEvidence): string {
  return RULE_TEXT[e.rule] ?? e.rule;
}

export interface CardInput {
  row: LeadRow;
  lines: readonly ProfileLine[];
  matchedOn: LeadCard["matchedOn"];
  score: number;
}

/** Build a card. Claims are limited to what the stored rows support. */
export function buildCard({ row, lines, matchedOn, score }: CardInput): LeadCard {
  const src = (i: number): GovSource => govSource(row.key, i, lines[i]!);
  const claims: Claim[] = [];

  // Why it is on the list: one claim per distinct rule, citing up to three rows.
  const byRule = new Map<string, number[]>();
  for (const e of row.tierEvidence)
    if (e.line !== null && e.line < lines.length) {
      const arr = byRule.get(e.rule) ?? [];
      if (!arr.includes(e.line)) arr.push(e.line);
      byRule.set(e.rule, arr);
    }
  for (const [rule, ls] of byRule) {
    const first = lines[ls[0]!]!;
    const extra =
      ls.length > 1 ? ` (and ${ls.length - 1} more row${ls.length > 2 ? "s" : ""})` : "";
    claims.push({
      text: `${ruleText({ rule, line: ls[0]! })}: ${describeLine(first)}${extra}`,
      sources: ls.slice(0, 3).map(src),
    });
  }
  if (row.tierEvidence.some((e) => e.rule === "5:large-defence-total")) {
    const dnd = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.ownerOrg === "dnd-mdn");
    if (dnd.length)
      claims.push({
        text: `National Defence contracts total ${money(row.dndContractValue)} across ${row.contractCount} contract rows (stored rows shown)`,
        sources: dnd.slice(0, 3).map(({ i }) => src(i)),
      });
  }
  // Topic tags: the row where the tag's word appeared.
  for (const t of row.tagEvidence.slice(0, 6)) {
    if (t.line >= lines.length) continue;
    claims.push({
      text: `Topic "${TAGS[t.tag as TagId]?.label ?? t.tag}": the word "${t.term}" appears in this row`,
      sources: [src(t.line)],
    });
  }
  // First appearance and money.
  if (lines.length) {
    const dated = lines
      .map((l, i) => ({ d: l.date, i }))
      .filter((x) => x.d)
      .sort((a, b) => (a.d < b.d ? -1 : 1));
    if (dated.length)
      claims.push({
        text: `Earliest government row held for this company is dated ${dated[0]!.d}${
          row.firstDate && row.firstDate !== dated[0]!.d
            ? ` (the full record starts ${row.firstDate})`
            : ""
        }; this is the first appearance in the data, not the founding date`,
        sources: [src(dated[0]!.i)],
      });
    const grants = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.kind === "grant");
    if (grants.length)
      claims.push({
        text: `${row.grantAgreements} grant agreement${row.grantAgreements === 1 ? "" : "s"} totalling ${money(row.grantValue)}${row.firstTimeGrantRecipient ? " (first-time recipient)" : ""}; ${grants.length} row${grants.length === 1 ? "" : "s"} shown`,
        sources: grants.slice(0, 3).map(({ i }) => src(i)),
      });
    const contracts = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.kind === "contract");
    if (contracts.length)
      claims.push({
        text: `${row.contractCount} government contract${row.contractCount === 1 ? "" : "s"} totalling ${money(row.contractValue)}; ${contracts.length} row${contracts.length === 1 ? "" : "s"} shown`,
        sources: contracts.slice(0, 3).map(({ i }) => src(i)),
      });
  }

  const unknowns: UnknownField[] = [
    { field: "founding year", state: "not_researched" },
    { field: "what the company makes (beyond project titles)", state: "not_researched" },
    { field: "ownership and headquarters", state: "not_researched" },
  ];
  if (!row.provinces.length)
    unknowns.push({
      field: "province",
      state: "unknown",
      note: "contract-only vendor: contract rows carry no address in this data",
    });
  if (row.grantAgreements > 0 && row.firstGrantDate === null)
    unknowns.push({
      field: "first grant date",
      state: "unknown",
      note: "more rows than the profile stores",
    });

  return {
    key: row.key,
    name: row.name,
    location:
      [dedupeCities(row.cities).join(", "), row.provinces.join(", ")].filter(Boolean).join(" ") ||
      "location not in the data",
    tier: row.tier as "A" | "B" | "C" | "D",
    tierRules: [...new Set(row.tierEvidence.map((e) => e.rule))],
    tags: row.tags,
    firstSeen: row.firstDate,
    firstGrantDate: row.firstGrantDate,
    firstTimeGrantRecipient: row.firstTimeGrantRecipient,
    totals: {
      grantCount: row.grantCount,
      contractCount: row.contractCount,
      grantValue: row.grantValue,
      contractValue: row.contractValue,
      dndContractValue: row.dndContractValue,
      csaValue: row.csaValue,
    },
    triage: { verdict: row.verdict, reason: row.reason, judgeSaidNo: row.judgeSaidNo },
    matchedOn,
    score: Math.round(score * 1000) / 1000,
    claims,
    unknowns,
    label: LEAD_LABEL,
  };
}

const sourceMd = (s: Source): string =>
  s.kind === "web"
    ? `[web: ${s.title}](${s.url}) (accessed ${s.accessed})`
    : `${s.kind === "gov_grant" ? "grant" : "contract"} \`${s.key}\` line ${s.line} (${s.date}, ${s.department}, ${s.kind === "gov_grant" ? s.programme || "no programme" : s.category}, ${money(s.value)}, ref ${s.ref})`;

export function claimMd(c: Claim): string {
  return `- ${c.text}\n${c.sources.map((s) => `  - source: ${sourceMd(s)}`).join("\n")}`;
}

export function unknownsMd(u: UnknownField[]): string {
  if (!u.length) return "";
  const word = {
    unknown: "unknown",
    not_found: "not found",
    not_researched: "not researched",
  } as const;
  return `Unknown: ${u.map((x) => `${x.field} (${word[x.state]}${x.note ? `: ${x.note}` : ""})`).join("; ")}`;
}

export function cardMd(c: LeadCard): string {
  const t = c.totals;
  return [
    `### ${c.name} — tier ${c.tier}`,
    `*${LEAD_LABEL}.* ${c.location}. Key \`${c.key}\`.`,
    `First seen in government data: ${c.firstSeen ?? "unknown"}${c.firstTimeGrantRecipient ? "; first-time grant recipient" : ""}. Grants ${money(t.grantValue)} (${t.grantCount}), contracts ${money(t.contractValue)} (${t.contractCount}).${c.tags.length ? ` Tags: ${c.tags.join(", ")}.` : ""}`,
    c.triage.verdict
      ? `Triage reader (an AI opinion, not evidence): ${c.triage.verdict}${c.triage.reason ? ` — ${c.triage.reason}` : ""}${c.triage.judgeSaidNo ? " (the reader said no; kept because of the rule evidence)" : ""}.`
      : "",
    "",
    ...c.claims.map(claimMd),
    "",
    unknownsMd(c.unknowns),
  ]
    .filter((x) => x !== "")
    .join("\n");
}

export function answerMd(a: Answer): string {
  return [
    `## ${a.question}`,
    `*${LEAD_LABEL}.*`,
    "",
    a.summary,
    "",
    ...a.leads.flatMap((l) => [
      `### ${l.name} — tier ${l.tier}`,
      `Key \`${l.key}\`. ${l.whyMatched}`,
      "",
      ...l.claims.map(claimMd),
      "",
      unknownsMd(l.unknowns),
      "",
    ]),
    ...(a.notes.length ? ["### Notes and limits", ...a.notes.map((n) => `- ${n}`), ""] : []),
    ...(a.searchesRun.length
      ? ["### Searches run", ...a.searchesRun.map((s) => `- \`${s}\``), ""]
      : []),
  ].join("\n");
}

/** City names that differ only in case or accents are one city (MONTRÉAL, Montreal). */
function dedupeCities(cities: string[]): string[] {
  const seen = new Set<string>();
  return cities.filter((c) => {
    const k = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
