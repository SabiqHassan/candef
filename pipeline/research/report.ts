/**
 * Semantic review report (M3-B4): one self-contained HTML page per review session, written to
 * research-cache/reports/ (never Git). It shows every PROPOSED record by entity with its value,
 * evidence (source tier, publisher, link, locator, local capture), automated checks, and the exact
 * `candef review` ID to approve it. Excerpts are not copied in: the reviewer opens the capture.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import type { Corpus, Evidence, Provenance, Source } from "../../src/domain/schema/corpus";
import { decodeGovLocator, type DepartmentLookup } from "../../src/domain/locator";
import { compile } from "../compile/compile";
import { FactIndex } from "../compile/facts";
import { researchBuildGates } from "./gates";
import { visibleText } from "./capture";
import { loadResearchCorpus } from "./load";
import { approvableIds } from "./review";
import { readTakedowns, takedownFailures } from "./takedown";

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const short = (v: unknown) => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > 220 ? `${t.slice(0, 220)}…` : t;
};

const normalize = (t: string) =>
  t
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
const captureText = new Map<string, string | null>();
/** Normalized visible text of a capture in research-cache/, or null if unreadable. */
function readCapture(path: string): string | null {
  if (!captureText.has(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      captureText.set(path, normalize(/\.html?$/i.test(path) ? visibleText(raw) : raw));
    } catch {
      captureText.set(path, null);
    }
  }
  return captureText.get(path)!;
}

/** Strings a reviewer would expect to see in the source for this value. */
export function needlesFor(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.city === "string") return [v.city];
    if (typeof v.value === "string") return [v.value];
  }
  return [];
}

export function evidenceList(
  ev: Evidence[],
  sources: Map<string, Source>,
  cacheDir: string,
  needles: string[] = [],
  departments?: DepartmentLookup,
): string {
  if (!ev.length) return `<span class="bad">no evidence</span>`;
  // Government row locators read as labelled fields; the stored locator text is unchanged.
  const locatorHtml = (locator: string) => {
    const d = decodeGovLocator(locator, departments);
    if (!d) return `locator “${esc(locator)}”`;
    const fields = d.fields.map((f) => `${esc(f.label)}: <b>${esc(f.value)}</b>`).join(" · ");
    const sha = d.fingerprint
      ? ` <details style="display:inline"><summary>row fingerprint</summary><code>${esc(d.fingerprint)}</code></details>`
      : "";
    return `row ${fields}${sha}`;
  };
  return `<ul class="ev">${ev
    .map((e) => {
      const s = sources.get(e.sourceId);
      if (!s) return `<li class="bad">unknown source ${esc(e.sourceId)}</li>`;
      const cap =
        (e.captureId ? s.captures?.find((c) => c.id === e.captureId) : undefined) ??
        s.captures?.at(-1);
      let found = "";
      if (cap && needles.length) {
        const text = readCapture(join(cacheDir, cap.path));
        const wanted = needles.filter((n) => n.trim().length >= 2);
        if (text === null) found = ` · <span class="warn">capture unreadable</span>`;
        else if (wanted.length)
          found = wanted.every((n) => text.includes(normalize(n)))
            ? ` · <span class="ok">value found in capture</span>`
            : ` · <span class="bad">value NOT found in capture: check the locator</span>`;
      }
      const capLink = cap
        ? ` · <a href="${esc(pathToFileURL(join(cacheDir, cap.path)).href)}">capture ${esc(cap.retrievedAt.slice(0, 10))}</a>${found}`
        : ` · <span class="warn">no capture</span>`;
      return `<li><b>${esc(s.tier)}</b> ${esc(s.publisher)}: <a href="${esc(s.url)}">${esc(s.title)}</a> · ${locatorHtml(e.locator)} (${esc(e.locatorQuality ?? "body")})${capLink}</li>`;
    })
    .join("")}</ul>`;
}

const isProposed = (r: Provenance) => r.verification === "proposed";

export function buildReviewReport(
  root: string,
  options: { today: string; cacheDir: string },
): string {
  const cacheDir = resolve(options.cacheDir);
  const loaded = loadResearchCorpus(root);
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CANDEF review report ${esc(options.today)}</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:24px;color:#1b2430;background:#fff}
h1{font-size:22px}h2{font-size:18px;margin-top:32px;border-bottom:1px solid #ccd3db}h3{font-size:15px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;margin:6px 0}td,th{border:1px solid #dde2e8;padding:6px 8px;vertical-align:top;text-align:left}th{background:#f3f5f8}
code{font:12px ui-monospace,monospace;background:#f3f5f8;padding:1px 4px;border-radius:3px}.ev{margin:0;padding-left:16px}
.bad{color:#a8231c;font-weight:600}.warn{color:#8a5a00}.ok{color:#1d6b35}.note{background:#fff8e6;border:1px solid #ecd9a6;padding:10px 12px;border-radius:6px}
</style></head><body>`;
  if (!loaded.corpus)
    return `${head}<h1>Review report: corpus does not load</h1><ul>${loaded.issues
      .map((i) => `<li><code>${esc(i.file)}:${esc(i.path)}</code> ${esc(i.message)}</li>`)
      .join("")}</ul></body></html>`;

  const corpus: Corpus = loaded.corpus;
  const facts = new FactIndex(corpus, options.today);
  const sources = new Map(corpus.sources.map((s) => [s.id, s]));
  const result = compile(corpus, { today: options.today });
  const gates = [
    ...researchBuildGates(corpus),
    ...takedownFailures(corpus, readTakedowns(root)),
    ...result.failures,
  ];
  const proposedCount =
    corpus.assertions.filter(isProposed).length +
    corpus.rounds.filter(isProposed).length +
    corpus.agreements.filter(isProposed).length +
    corpus.acquisitions.filter(isProposed).length;

  const parts: string[] = [
    head,
    `<h1>CANDEF review report, ${esc(options.today)}</h1>`,
    `<p class="note">Nothing on this page is approved. Approve a record only after opening its source or capture and confirming the value at the locator. Approve with <code>npm run candef -- review &lt;id&gt;</code> in your own terminal (owner only).</p>`,
    `<p>${corpus.organizations.length} organizations · ${corpus.sources.length} sources · <b>${proposedCount}</b> proposed records · ${result.snapshot?.coverage.inUniverse ?? 0} companies currently published.</p>`,
    `<h2>Build gates</h2>`,
    gates.length
      ? `<ul>${gates.map((g) => `<li class="bad">[${esc(g.gate)}] ${esc(g.message)}: ${esc(g.ids.join(", "))}</li>`).join("")}</ul>`
      : `<p class="ok">All gates pass.</p>`,
    `<h2>Data-quality flags</h2>`,
    result.quality.length
      ? `<ul>${result.quality.map((q) => `<li class="warn">[${esc(q.check)}] ${esc(q.message)}: ${esc(q.ids.join(", "))}</li>`).join("")}</ul>`
      : `<p class="ok">None.</p>`,
  ];

  for (const org of [...corpus.organizations].sort((a, b) => a.name.localeCompare(b.name))) {
    const orgFacts = corpus.assertions.filter((a) => a.subjectId === org.id && isProposed(a));
    const rounds = corpus.rounds.filter((r) => r.companyId === org.id && isProposed(r));
    const agreements = corpus.agreements.filter(
      (g) =>
        isProposed(g) &&
        g.parties.some((p) => p.orgId === org.id && p.role !== "buyer" && p.role !== "funder"),
    );
    if (!orgFacts.length && !rounds.length && !agreements.length) continue;
    const origin = loaded.origins.get(org.id);
    parts.push(
      `<h2>${esc(org.name)} <small>(${esc(org.kind)}, <code>${esc(org.id)}</code>, ${esc(origin?.file)})</small></h2>`,
      (() => {
        const ids = approvableIds(corpus, org.id, options.today);
        return ids.length
          ? `<p class="note">After checking every record below against its source: <code>npm run candef -- review --org ${esc(org.slug)}</code> (approves the ${ids.length} record(s) that pass their evidence rule: ${esc(ids.join(", "))}).</p>`
          : `<p class="warn">No record here can be approved as it stands (missing evidence or failing evidence rules).</p>`;
      })(),
    );
    if (orgFacts.length)
      parts.push(
        `<h3>Facts</h3><table><tr><th>Field</th><th>Currently published</th><th>Proposed value</th><th>Evidence</th><th>Checks</th><th>Approve</th></tr>${orgFacts
          .map((a) => {
            const ok = facts.meetsEvidenceRule(a);
            // Before → after: the value a reader sees today for this field, if any.
            const current = facts.fact(a.subjectId, a.predicate);
            const before =
              current.state === "verified"
                ? esc(short(current.value))
                : current.state === "disputed"
                  ? `<span class="warn">disputed: ${esc((current.alternatives ?? []).map((x) => short(x.value)).join(" | "))}</span>`
                  : `<small>${esc(current.state.replace("_", " "))}</small>`;
            return `<tr><td>${esc(a.predicate)}${a.supersedes ? `<br><small>supersedes ${esc(a.supersedes)}</small>` : ""}</td><td>${before}</td><td>${esc(short(a.value))}</td><td>${evidenceList(a.evidence, sources, cacheDir, needlesFor(a.value))}</td><td>${ok ? '<span class="ok">evidence rule passes</span>' : '<span class="bad">fails evidence rule: approval would publish nothing</span>'}</td><td><code>${esc(a.id)}</code></td></tr>`;
          })
          .join("")}</table>`,
      );
    for (const r of rounds)
      parts.push(
        `<h3>Round: ${esc(r.roundLabelAsStated ?? r.stage ?? "unlabelled")} (${esc(r.eventState)})</h3><table><tr><th>Disclosures</th><th>Participants</th><th>Evidence</th><th>Approve</th></tr><tr><td><ul class="ev">${r.disclosures
          .map(
            (d) =>
              `<li>${esc(d.date)} ${esc(d.kind)}: ${esc(d.amount.asStated)} (${esc(d.amount.currency)}, ${esc(d.amountBasis)})</li>`,
          )
          .join("")}</ul></td><td><ul class="ev">${r.participations
          .map((p) => `<li>${esc(p.reportedName)} (${esc(p.role)})</li>`)
          .join(
            "",
          )}</ul></td><td>${evidenceList(r.evidence, sources, cacheDir, [...(r.roundLabelAsStated ? [r.roundLabelAsStated] : []), ...r.disclosures.map((d) => d.amount.asStated).filter((t) => /\d/.test(t))])}</td><td><code>${esc(r.id)}</code><br><small>includes its disclosures and participants</small></td></tr></table>`,
      );
    for (const g of agreements)
      parts.push(
        `<h3>${esc(g.family)}: ${esc(g.title)}</h3><table><tr><th>Parties</th><th>Disclosure rows (cumulative)</th><th>Evidence</th><th>Approve</th></tr><tr><td><ul class="ev">${g.parties
          .map(
            (p) => `<li>${esc(p.role)}: ${esc(p.reportedName)} (${esc(p.evidenceStrength)})</li>`,
          )
          .join("")}</ul></td><td><ul class="ev">${g.disclosureRows
          .map(
            (row) =>
              `<li>${esc(row.reportingPeriod)}: total ${esc(row.totalValue ?? "not stated")}${row.amendmentValue ? ` (Δ ${esc(row.amendmentValue)})` : ""}</li>`,
          )
          .join(
            "",
          )}</ul></td><td>${evidenceList(g.evidence, sources, cacheDir)}</td><td><code>${esc(g.id)}</code></td></tr></table>`,
      );
  }

  parts.push(
    `<h2>Sources and recorded permissions</h2><p>unknown = denied. Only a human records permissions, after reading the site's terms.</p><table><tr><th>Source</th><th>Tier</th><th>capture</th><th>quote</th><th>redistribute</th><th>automated</th><th>Captures</th><th>Availability</th></tr>${corpus.sources
      .map(
        (s) =>
          `<tr><td><a href="${esc(s.url)}">${esc(s.title)}</a><br><code>${esc(s.id)}</code></td><td>${esc(s.tier)}</td><td>${esc(s.permissions?.capture ?? "unknown")}</td><td>${esc(s.permissions?.quoteInternal ?? "unknown")}</td><td>${esc(s.permissions?.redistributeExcerpt ?? "unknown")}</td><td>${esc(s.permissions?.automatedCollection ?? "unknown")}</td><td>${s.captures?.length ?? 0}</td><td>${esc(s.availability ?? "unknown")}</td></tr>`,
      )
      .join("")}</table></body></html>`,
  );
  return parts.join("\n");
}
