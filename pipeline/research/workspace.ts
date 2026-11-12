/**
 * The owner's review workspace (docs/REVIEW_WORKSPACE.md): one self-contained HTML page listing
 * every proposed record as a review unit, with its citations, checks and approve / reject controls.
 * Decisions stay in the browser until the owner exports them; only `candef apply-decisions`, run by
 * the owner in their own terminal, writes anything to research/. Building the page is read-only.
 */
import { resolve } from "node:path";
import type {
  Acquisition,
  Agreement,
  Assertion,
  Corpus,
  FinancingRound,
} from "../../src/domain/schema/corpus";
import { PREDICATE_LABEL } from "../compile/compile";
import { FactIndex } from "../compile/facts";
import { reviewUnits, workspaceFingerprint, type ReviewUnit } from "./decisions";
import { govCheckHtml, readGovCheck } from "./govCheck";
import { loadResearchCorpus } from "./load";
import { esc, evidenceList, needlesFor } from "./report";
import { summaryOf } from "./workspaceSummary";
import type { TierRecord } from "./tiers/rules";
import type { TiersFile } from "./tiers/run";

/** A value written out in full for checking (no truncation: the owner reviews the exact value). */
function show(value: unknown): string {
  if (value === null || value === undefined) return `<i>none</i>`;
  if (typeof value !== "object") return esc(value);
  if (Array.isArray(value)) return value.map(show).join(", ");
  return `<dl class="kv">${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${show(v)}</dd>`)
    .join("")}</dl>`;
}

function claimOf(
  unit: ReviewUnit,
  corpus: Corpus,
  facts: FactIndex,
  name: (id: string) => string,
): { title: string; body: string; evidence: Assertion["evidence"]; needles: string[] } {
  switch (unit.kind) {
    case "assertion": {
      const a = corpus.assertions.find((x) => x.id === unit.id)!;
      const current = facts.fact(a.subjectId, a.predicate);
      const now =
        current.state === "verified"
          ? `Currently published: ${show(current.value)}`
          : `Currently published: <i>nothing (${esc(current.state.replace("_", " "))})</i>`;
      return {
        title: `${PREDICATE_LABEL[a.predicate] ?? a.predicate}${a.epistemic === "analyst_interpretation" ? ' <span class="tag">Analyst interpretation</span>' : ""}`,
        body: `<div class="value">${show(a.value)}</div><p class="muted">${now}${a.supersedes ? ` · replaces <code>${esc(a.supersedes)}</code>` : ""}</p>`,
        evidence: a.evidence,
        needles: needlesFor(a.value),
      };
    }
    case "round": {
      const r = corpus.rounds.find((x) => x.id === unit.id)! as FinancingRound;
      return {
        title: `Financing round: ${esc(r.roundLabelAsStated ?? r.stage ?? "unlabelled")} (${esc(r.eventState)})`,
        body: `<p class="muted">Approving or rejecting the round includes its disclosures and participants.</p><h4>Disclosures</h4><ul>${r.disclosures
          .map(
            (d) =>
              `<li>${esc(d.date)}, ${esc(d.kind)}: <b>${esc(d.amount.asStated)}</b> (${esc(d.amount.currency)}, ${esc(d.amountBasis)})</li>`,
          )
          .join("")}</ul><h4>Participants</h4><ul>${r.participations
          .map(
            (p) =>
              `<li>${esc(p.reportedName)} (${esc(p.role)})${p.investorId ? ` → ${esc(name(p.investorId))}` : ""}</li>`,
          )
          .join("")}</ul>`,
        evidence: r.evidence,
        needles: [
          ...(r.roundLabelAsStated ? [r.roundLabelAsStated] : []),
          ...r.disclosures.map((d) => d.amount.asStated).filter((t) => /\d/.test(t)),
        ],
      };
    }
    case "agreement": {
      const g = corpus.agreements.find((x) => x.id === unit.id)! as Agreement;
      const program = g.externalIds.find((x) => x.system === "tbs-grants:program")?.value;
      return {
        title: `${
          (
            {
              procurement: "Procurement contract",
              grant_contribution: "Grant or contribution",
              other_transfer: "Other transfer payment",
              partnership: "Partnership",
            } as const
          )[g.family]
        }: ${esc(g.title)}`,
        body: `${program ? `<p>Program: <b>${esc(program)}</b></p>` : ""}${g.sourceClassification ? `<p>Source classification: <b>${esc(g.sourceClassification.label)}</b> (${esc(g.sourceClassification.code)}). This is not a grant, contribution or purchase; the value is a stated agreement amount, not a confirmed payment.</p>` : ""}<h4>Parties</h4><ul>${g.parties
          .map(
            (p) =>
              `<li>${esc(p.role)}: ${esc(p.reportedName)} → ${esc(name(p.orgId))} (${esc(p.evidenceStrength.replace(/_/g, " "))})</li>`,
          )
          .join(
            "",
          )}</ul><h4>Disclosure rows (cumulative, ${esc(g.currency)})</h4><ul>${g.disclosureRows
          .map(
            (row) =>
              `<li>${esc(row.reportingPeriod)} ${esc(row.instrument)}: total <b>${esc(row.totalValue ?? "not stated")}</b>${row.amendmentValue ? ` (change ${esc(row.amendmentValue)})` : ""}</li>`,
          )
          .join("")}</ul>`,
        evidence: g.evidence,
        needles: [],
      };
    }
    case "acquisition": {
      const q = corpus.acquisitions.find((x) => x.id === unit.id)! as Acquisition;
      return {
        title: `Acquisition: ${esc(name(q.targetId))} by ${esc(name(q.acquirerId))}`,
        body: `<div class="value">${show({ history: q.history, consideration: q.consideration })}</div>`,
        evidence: q.evidence,
        needles: [],
      };
    }
  }
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b2430;--muted:#5b6672;--line:#d7dde4;--card:#f6f8fa;--ok:#1d6b35;--bad:#a8231c;--warn:#8a5a00;--accent:#1f5fbf}
@media (prefers-color-scheme:dark){:root{--bg:#11161c;--fg:#e3e8ee;--muted:#9aa5b1;--line:#2c3540;--card:#18202a;--ok:#5fc27e;--bad:#f07a72;--warn:#e0b25a;--accent:#7fb0ff}}
*{box-sizing:border-box}body{font:14px/1.5 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
header.top{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px}
header.top h1{font-size:18px;margin:0 0 6px}.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bar select,.bar input,.bar button{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
.bar button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
main{max-width:1100px;margin:0 auto;padding:16px}
.warning{border:1px solid var(--warn);border-radius:8px;padding:10px 12px;margin:12px 0}
h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
section.unit{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:10px 0;background:var(--card);content-visibility:auto;contain-intrinsic-size:auto 420px}
section.unit[data-state=approve]{border-left:4px solid var(--ok)}section.unit[data-state=reject]{border-left:4px solid var(--bad)}
section.unit h3{font-size:15px;margin:0 0 4px}h4{font-size:13px;margin:10px 0 2px}
.muted{color:var(--muted)}.ok{color:var(--ok)}.bad{color:var(--bad);font-weight:600}.warn{color:var(--warn)}
.tag{font-size:11px;border:1px solid var(--line);border-radius:3px;padding:0 4px;color:var(--muted)}
code{font:12px ui-monospace,monospace}.value{margin:6px 0}.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin:0}.kv dt{color:var(--muted)}.kv dd{margin:0}
.ev{margin:4px 0;padding-left:18px}.ev a{color:var(--accent)}
fieldset{border:0;padding:0;margin:10px 0 0;display:flex;flex-wrap:wrap;gap:14px;align-items:center}
fieldset label{display:inline-flex;gap:6px;align-items:center;min-height:32px}
textarea{width:100%;font:inherit;min-height:56px;margin-top:6px;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.verify{margin:6px 0 8px;padding:8px 10px;border-left:4px solid var(--accent);background:var(--bg);font-size:14px}.opened{font-size:12px}[hidden]{display:none!important}
.rowcheck{margin:8px 0;padding:8px 10px;border:1px dashed var(--line);border-radius:6px}.rowcheck h4{margin:0 0 4px}.rowtable{border-collapse:collapse;font-size:12px;width:100%}.rowtable th,.rowtable td{border:1px solid var(--line);padding:2px 6px;text-align:left;vertical-align:top}
`;

/** Runs in the owner's browser. Decisions live in localStorage until exported; nothing is sent anywhere. */
const SCRIPT = String.raw`
(() => {
  const meta = JSON.parse(document.getElementById("ws-meta").textContent);
  const key = "candef-ws-" + meta.fingerprint;
  let state = {};
  try { state = JSON.parse(localStorage.getItem(key) || "{}"); } catch (e) { state = {}; }
  const save = () => { try { localStorage.setItem(key, JSON.stringify(state)); } catch (e) {} };
  const units = [...document.querySelectorAll("section.unit")];
  const byId = new Map(units.map((u) => [u.dataset.id, u]));

  function render(u) {
    const s = state[u.dataset.id] || {};
    u.dataset.state = s.decision || "";
    for (const r of u.querySelectorAll("input[type=radio]")) r.checked = r.value === (s.decision || "skip");
    const reason = u.querySelector("textarea");
    reason.hidden = s.decision !== "reject" && s.decision !== "wrong";
    if (reason.value !== (s.reason || "")) reason.value = s.reason || "";
    u.querySelector(".opened").textContent = s.opened ? "Source opened" : "Source not opened yet";
  }
  function progress() {
    const d = Object.values(state);
    const a = d.filter((x) => x.decision === "approve" || x.decision === "confirm").length;
    const r = d.filter((x) => x.decision === "reject" || x.decision === "wrong").length;
    document.getElementById("progress").textContent =
      a + " approve · " + r + " reject · " + (units.length - a - r) + " undecided of " + units.length;
  }
  // Search text is lower-cased once per unit, on first use: rebuilding it for every unit on every
  // keystroke cost seconds at a few thousand claims (bench/stress/probe-workspace-browser.ts).
  const haystack = new Array(units.length);
  const text = (i) => (haystack[i] ??= units[i].textContent.toLowerCase());
  const headings = [...document.querySelectorAll("h2[data-org]")];
  function filter() {
    const org = document.getElementById("f-org").value;
    const st = document.getElementById("f-state").value;
    const q = document.getElementById("f-q").value.trim().toLowerCase();
    const shownOrgs = new Set();
    units.forEach((u, i) => {
      const s = (state[u.dataset.id] || {}).decision || "undecided";
      const hide = !!((org && u.dataset.org !== org) || (st && st !== s) || (q && !text(i).includes(q)));
      if (u.hidden !== hide) u.hidden = hide;
      if (!hide) shownOrgs.add(u.dataset.org);
    });
    for (const h of headings) {
      const hide = !shownOrgs.has(h.dataset.org);
      if (h.hidden !== hide) h.hidden = hide;
    }
  }
  // One listener per kind of event on the page, not four per claim: the workspace can hold
  // thousands of claims. Each handler finds the claim the event came from.
  const unitOf = (e) => e.target.closest && e.target.closest("section.unit");
  const noteOpened = (e) => {
    const u = unitOf(e);
    if (u && e.target.closest(".ev a")) { (state[u.dataset.id] = state[u.dataset.id] || {}).opened = true; save(); render(u); }
  };
  const main = document.querySelector("main");
  main.addEventListener("change", (e) => {
    const u = unitOf(e); if (!u) return;
    const s = (state[u.dataset.id] = state[u.dataset.id] || {});
    if (e.target.type === "radio") s.decision = e.target.value === "skip" ? undefined : e.target.value;
    if (e.target.tagName === "TEXTAREA") s.reason = e.target.value;
    save(); render(u); progress();
  });
  main.addEventListener("input", (e) => {
    const u = unitOf(e);
    if (u && e.target.tagName === "TEXTAREA") { (state[u.dataset.id] = state[u.dataset.id] || {}).reason = e.target.value; save(); }
  });
  // Opening any source or capture link counts as having looked at the evidence.
  main.addEventListener("click", noteOpened);
  main.addEventListener("auxclick", noteOpened);
  // Only claims with a saved decision differ from the page as generated.
  for (const u of units) if (state[u.dataset.id]) render(u);
  document.getElementById("f-org").addEventListener("input", filter);
  document.getElementById("f-state").addEventListener("input", filter);
  let searching = 0;
  document.getElementById("f-q").addEventListener("input", () => { clearTimeout(searching); searching = setTimeout(filter, 120); });

  document.getElementById("export").addEventListener("click", () => {
    const decisions = [];
    const missing = [];
    for (const u of units) {
      const s = state[u.dataset.id];
      if (!s || !s.decision) continue;
      if ((s.decision === "reject" || s.decision === "wrong") && !(s.reason || "").trim()) { missing.push(u); continue; }
      decisions.push({
        id: u.dataset.id, kind: u.dataset.kind, hash: u.dataset.hash, decision: s.decision,
        ...(s.decision === "reject" || s.decision === "wrong" ? { reason: s.reason.trim().slice(0, 500) } : {}),
        sourceOpened: !!s.opened,
      });
    }
    if (missing.length) {
      alert(missing.length + " rejection(s) have no reason. Add a reason before exporting.");
      missing[0].scrollIntoView({ block: "center" }); missing[0].querySelector("textarea").focus();
      return;
    }
    const base = { format: "candef-review-decisions",
      workspace: { fingerprint: meta.fingerprint, generatedAt: meta.generatedAt },
      exportedAt: new Date().toISOString() };
    // With a tiers batch (version 2), audit verdicts travel separately from decisions.
    const file = meta.batch
      ? { ...base, version: 2, tiers: { batch: meta.batch },
          decisions: decisions.filter((d) => byId.get(d.id).dataset.section !== "audit"),
          audit: decisions.filter((d) => byId.get(d.id).dataset.section === "audit").map((d) => ({
            id: d.id, hash: d.hash, verdict: d.decision,
            ...(d.reason ? { reason: d.reason } : {}), sourceOpened: d.sourceOpened })) }
      : { ...base, version: 1, decisions };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    a.download = "candef-decisions-" + meta.generatedAt + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.getElementById("import").addEventListener("change", async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const file = JSON.parse(await f.text());
      let restored = 0, changed = 0;
      const audit = (file.audit || []).map((x) => ({ id: x.id, hash: x.hash, decision: x.verdict, reason: x.reason, sourceOpened: x.sourceOpened }));
      for (const d of [...(file.decisions || []), ...audit]) {
        const u = byId.get(d.id);
        if (!u || u.dataset.hash !== d.hash) { changed++; continue; }
        state[d.id] = { decision: d.decision, reason: d.reason, opened: d.sourceOpened };
        render(u); restored++;
      }
      save(); progress(); filter();
      alert(restored + " decision(s) restored; " + changed + " skipped because the record changed or is no longer proposed.");
    } catch (err) { alert("That file could not be read as a decisions file."); }
    e.target.value = "";
  });
  progress();
})();
`;

/** Tier result block shown on a unit when the workspace is built from a tiers batch. */
function tierHtml(t: TierRecord): string {
  const rules = t.rules
    .map(
      (r) =>
        `<li><b>${esc(r.rule)}</b> <span class="${r.result === "pass" ? "ok" : r.result === "fail" ? "bad" : "warn"}">${esc(r.result)}</span>: ${esc(r.reason)}</li>`,
    )
    .join("");
  const values = t.values
    .map(
      (v) =>
        `<li>${esc(v.part)} <code>${esc(v.value)}</code>: ${v.found ? `<span class="ok">found</span> in <code>${esc(v.sourceId)}@${esc(v.captureId)}</code> at offset ${esc(v.offset)}` : '<span class="bad">not found</span>'}</li>`,
    )
    .join("");
  return `<div class="rowcheck"><h4>Tier ${t.tier}: ${esc(t.status)} (${esc(t.route)})</h4>${rules ? `<ul>${rules}</ul>` : ""}${values ? `<h4>Values in saved copies</h4><ul>${values}</ul>` : ""}${t.dependsOn.length ? `<p class="muted">Depends on anchors: ${t.dependsOn.map((d) => `<code>${esc(d)}</code>`).join(", ")}</p>` : ""}${t.projected ? `<p class="muted">After the reviewed migration: ${esc(t.projected.status)}</p>` : ""}</div>`;
}

export function buildWorkspace(
  root: string,
  options: { today: string; cacheDir: string; tiers?: TiersFile },
): string {
  const cacheDir = resolve(options.cacheDir);
  const loaded = loadResearchCorpus(root);
  if (!loaded.corpus)
    throw new Error(
      `research/ does not load: ${loaded.issues.map((i) => `${i.file}: ${i.message}`).join("; ")}`,
    );
  const corpus = loaded.corpus;
  const facts = new FactIndex(corpus, options.today);
  const sources = new Map(corpus.sources.map((s) => [s.id, s]));
  const orgName = new Map(corpus.organizations.map((o) => [o.id, o.name]));
  const name = (id: string) => orgName.get(id) ?? id;
  // Department names for row locators, from recorded tbs-owner-org identifiers (display only).
  const departmentNames = new Map<string, string>();
  for (const a of corpus.assertions) {
    const v = a.value as { system?: string; value?: string } | null;
    if (a.predicate === "registry_id" && v?.system === "tbs-owner-org" && v.value)
      departmentNames.set(v.value, name(a.subjectId));
  }
  const departments = (code: string) => departmentNames.get(code);
  const tiers = options.tiers;
  const tierOf = new Map((tiers?.records ?? []).map((r) => [r.id, r]));
  const sampled = new Set(tiers?.audit ?? []);
  /** With a tiers batch, only tier 3 items, exceptions and the audit sample need the owner. */
  const sectionOf = (id: string): "tier3" | "exception" | "audit" | null => {
    if (!tiers) return null;
    if (sampled.has(id)) return "audit";
    const t = tierOf.get(id);
    return t?.status === "judgement" ? "tier3" : t?.status === "exception" ? "exception" : null;
  };
  const allUnits = reviewUnits(corpus, options.today);
  const units = tiers ? allUnits.filter((u) => sectionOf(u.id) !== null) : allUnits;
  const govCheck = readGovCheck(cacheDir);
  const fingerprint = workspaceFingerprint(units, options.today);
  const meta = JSON.stringify({
    fingerprint,
    generatedAt: options.today,
    ...(tiers ? { batch: tiers.batch } : {}),
  }).replace(/</g, "\\u003c");

  const byOrg = new Map<string, ReviewUnit[]>();
  for (const u of units) byOrg.set(u.orgId, [...(byOrg.get(u.orgId) ?? []), u]);
  // Companies whose eligibility record says "excluded" are never published, so approving their
  // claims changes nothing the public sees: they go last and are marked, saving review time.
  const excluded = new Set(
    corpus.assertions
      .filter(
        (x) =>
          x.predicate === "eligibility" &&
          (x.value as { decision?: string } | null)?.decision === "excluded",
      )
      .map((x) => x.subjectId),
  );
  const orgs = [...byOrg.keys()].sort(
    (a, b) => Number(excluded.has(a)) - Number(excluded.has(b)) || name(a).localeCompare(name(b)),
  );

  const body: string[] = [];
  const SECTIONS: readonly (readonly [ReturnType<typeof sectionOf>, string, string])[] = tiers
    ? [
        [
          "tier3",
          "Owner judgement (tier 3)",
          "Assessments, identity anchors, corporate structure, analyst interpretations and records resting on T3/T4 sources. Decide each one.",
        ],
        [
          "exception",
          "Exceptions (tiers 1 and 2)",
          "A fixed rule failed. The failed rule and its reason are shown; approve only after checking the source yourself.",
        ],
        [
          "audit",
          "Audit sample",
          "Randomly drawn from the records that passed, seeded by the batch hash. Check each against its source: one wrong record refuses the whole batch.",
        ],
      ]
    : [[null, "", ""]];
  for (const [section, title, help] of SECTIONS) {
    if (section)
      body.push(
        `<h2 class="section">${esc(title)} <small class="muted">${units.filter((u) => sectionOf(u.id) === section).length}</small></h2><p class="muted">${esc(help)}</p>`,
      );
    for (const orgId of orgs) {
      const list = byOrg.get(orgId)!.filter((u) => sectionOf(u.id) === section);
      if (!list.length) continue;
      body.push(
        `<h2 data-org="${esc(orgId)}">${esc(name(orgId))} <small class="muted">${list.length} claim(s)</small>${excluded.has(orgId) ? ' <small class="warn">Excluded from the dataset: approving these claims publishes nothing; review last</small>' : ""}</h2>`,
      );
      for (const u of list) {
        const c = claimOf(u, corpus, facts, name);
        body.push(`<section class="unit" data-id="${esc(u.id)}" data-kind="${esc(u.kind)}" data-hash="${esc(u.hash)}" data-org="${esc(orgId)}"${sectionOf(u.id) ? ` data-section="${sectionOf(u.id)}"` : ""}>
<h3>${c.title}</h3>${summaryOf(u, corpus, name) ? `<p class="verify"><b>You are verifying:</b> ${esc(summaryOf(u, corpus, name)!)}</p>` : ""}${c.body}
<h4>Evidence</h4>${evidenceList(c.evidence, sources, cacheDir, c.needles, departments)}${u.kind === "agreement" ? govCheckHtml(govCheck, u.id) : ""}
<p>${u.approvable ? '<span class="ok">Evidence rule passes</span>' : '<span class="bad">Fails its evidence rule: it can be rejected, not approved</span>'} · <span class="opened muted">Source not opened yet</span> · <code>${esc(u.id)}</code></p>
${tierOf.has(u.id) ? tierHtml(tierOf.get(u.id)!) : ""}
<fieldset><legend class="visually-hidden">Decision for ${esc(u.id)}</legend>
${
  sectionOf(u.id) === "audit"
    ? `<label><input type="radio" name="d-${esc(u.id)}" value="confirm"> Correct: matches the source</label>
<label><input type="radio" name="d-${esc(u.id)}" value="wrong"> Wrong</label>`
    : `<label><input type="radio" name="d-${esc(u.id)}" value="approve"${u.approvable ? "" : " disabled"}> Approve</label>
<label><input type="radio" name="d-${esc(u.id)}" value="reject"> Reject</label>`
}
<label><input type="radio" name="d-${esc(u.id)}" value="skip" checked> Decide later</label></fieldset>
<textarea hidden maxlength="500" aria-label="Reason for rejecting ${esc(u.id)}" placeholder="Why is this claim wrong or unsupported? (required, kept with the record)"></textarea>
</section>`);
      }
    }
  }
  const passes = tiers
    ? tiers.records.filter(
        (r) => (r.status === "pass" || r.status === "conditional") && !sampled.has(r.id),
      ).length
    : 0;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CANDEF review workspace ${esc(options.today)}</title><style>${STYLE}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style></head><body>
<header class="top"><h1>CANDEF review workspace, ${esc(options.today)}</h1>
<div class="bar"><label>Organization <select id="f-org"><option value="">All</option>${orgs.map((o) => `<option value="${esc(o)}">${esc(name(o))}</option>`).join("")}</select></label>
<label>Show <select id="f-state"><option value="">All claims</option><option value="undecided">Undecided</option><option value="approve">Marked approve</option><option value="reject">Marked reject</option></select></label>
<input id="f-q" type="search" placeholder="Search claims" aria-label="Search claims">
<span id="progress" class="muted" role="status"></span>
<button id="export" class="primary" type="button">Export decisions</button>
<label>Resume from a file <input id="import" type="file" accept="application/json,.json"></label></div></header>
<main>${tiers ? `<p class="warning"><b>Tiers batch <code>${esc(tiers.batch.slice(0, 12))}</code> (${esc(tiers.rules)}).</b> ${passes} record(s) passed tiers 1 or 2 and are not shown; they are applied with the batch only if every audit record below is confirmed. Export, then run <code>npm run candef -- apply-tiers &lt;tiers-file&gt; --decisions &lt;file&gt;</code> in <b>your own terminal</b>.</p>` : ""}<p class="warning"><b>Nothing here is approved yet.</b> Open each claim's source or capture and check the value at the locator. Export your decisions, then run <code>npm run candef -- apply-decisions &lt;file&gt;</code> in <b>your own terminal</b>. A decision for a record that changes after ${esc(options.today)} is refused at that step. ${units.length} proposed claim(s) across ${orgs.length} organization(s). Workspace <code>${fingerprint.slice(0, 12)}</code>.</p>
${body.join("\n")}</main>
<script type="application/json" id="ws-meta">${meta}</script><script>${SCRIPT}</script></body></html>`;
}
