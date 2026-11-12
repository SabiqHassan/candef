/**
 * The exception queue (policy section 8): one self-contained HTML page with only the decisions the
 * owner needs to make, grouped by underlying question, each with the system's recommendation, the
 * evidence for each reading, and links to the original sources. Below them: the audit sample, then
 * (collapsed) what the system cleared, holds and is still working on, so every outcome is visible.
 *
 * The page keeps choices in the browser (localStorage, per batch) and exports them as a file;
 * the owner applies that file with `candef apply-clearance` in their own terminal (P-60).
 */
import type { Corpus } from "../../../src/domain/schema/corpus";
import { CLASS_LABEL, GROUP_LABEL, HOMEWORK, STATE_LABEL, type GroupKind } from "./policy";
import { RELATION_LABEL } from "./relate";
import { evidenceOf, type ClearanceRecord, type DecisionGroup } from "./route";
import type { ClearanceFile } from "./run";

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b2430;--muted:#5b6672;--line:#d7dde4;--card:#f6f8fa;--ok:#1d6b35;--bad:#a8231c;--warn:#8a5a00;--accent:#1f5fbf;--rec:#eef4fc}
@media (prefers-color-scheme:dark){:root{--bg:#11161c;--fg:#e3e8ee;--muted:#9aa5b1;--line:#2c3540;--card:#18202a;--ok:#5fc27e;--bad:#f07a72;--warn:#e0b25a;--accent:#7fb0ff;--rec:#162232}}
*{box-sizing:border-box}
body{font:15px/1.55 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px;z-index:2}
header h1{font-size:18px;margin:0 0 4px}
.status{display:flex;flex-wrap:wrap;gap:12px;align-items:center;color:var(--muted)}
main{max-width:860px;margin:0 auto;padding:16px}
.note{border-left:3px solid var(--warn);padding:8px 12px;background:var(--card);margin:0 0 16px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:0 0 24px}
.summary div{border:1px solid var(--line);padding:8px 10px}
.summary strong{display:block;font-size:22px;font-variant-numeric:tabular-nums}
h2{font-size:16px;margin:32px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}
.decision{border:1px solid var(--line);padding:14px 16px;margin:0 0 14px}
.decision[data-done="1"]{border-color:var(--ok)}
.decision h3{font-size:15px;margin:0 0 2px}
.org{color:var(--muted);font-size:13px;margin:0 0 8px}
.rec{background:var(--rec);padding:8px 12px;margin:8px 0}
.flag{color:var(--bad);margin:6px 0}
.ev{margin:8px 0 0;padding:0;list-style:none}
.ev>li{border-top:1px solid var(--line);padding:8px 0}
.claim{font-weight:600;margin:0}
.src{font-size:13px;color:var(--muted);margin:2px 0;overflow-wrap:anywhere}
.src a{color:var(--accent)}
.rel{font-size:13px;margin:2px 0 0}
.r-supports,.r-judgement_agrees{color:var(--ok)}
.r-contradicts,.r-judgement_differs{color:var(--bad)}
.r-other_entity,.r-other_period{color:var(--warn)}
fieldset{border:0;padding:0;margin:10px 0 0;display:flex;flex-wrap:wrap;gap:6px 14px}
legend{font-size:13px;color:var(--muted);margin-bottom:4px}
label{cursor:pointer}
textarea{width:100%;min-height:44px;margin-top:6px;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);padding:6px}
button{font:inherit;padding:6px 12px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
details{border:1px solid var(--line);padding:8px 12px;margin:0 0 10px}
summary{cursor:pointer;font-weight:600}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border-top:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
.muted{color:var(--muted)}
`;

function sourceLine(corpus: Corpus, r: { kind: ClearanceRecord["kind"]; id: string }): string {
  const sources = new Map(corpus.sources.map((s) => [s.id, s]));
  const seen = new Set<string>();
  return evidenceOf(r, corpus)
    .filter((e) => {
      const k = e.sourceId + e.locator;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 4)
    .map((e) => {
      const s = sources.get(e.sourceId);
      const link = s
        ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher)}: ${esc(s.title)}</a> (${esc(s.tier)})`
        : esc(e.sourceId);
      return `<p class="src">${link}, at ${esc(e.locator.slice(0, 140))}</p>`;
    })
    .join("");
}

function valueOf(corpus: Corpus, r: ClearanceRecord): string {
  if (r.kind === "assertion") {
    const a = corpus.assertions.find((x) => x.id === r.id);
    if (!a) return r.id;
    const v = a.value as Record<string, unknown> | string | number | null;
    if (typeof v !== "object" || v === null) return `${a.predicate}: ${String(v)}`;
    if (a.predicate === "eligibility")
      return `eligibility: ${String(v.decision)}. ${String(v.rationale ?? "").slice(0, 400)}`;
    if (a.predicate === "registry_id") return `${String(v.system)}: ${String(v.value)}`;
    if ("city" in v)
      return `${a.predicate}: ${[v.city, v.province, v.postalCode].filter(Boolean).join(", ")}`;
    return `${a.predicate}: ${JSON.stringify(v).slice(0, 200)}`;
  }
  if (r.kind === "round") {
    const x = corpus.rounds.find((y) => y.id === r.id);
    const d = x?.disclosures
      .map((y) => `${y.date} ${y.amount.asStated || y.amount.amount || "undisclosed"}`)
      .join("; ");
    return `round "${x?.roundLabelAsStated ?? r.id}": ${d ?? ""}`;
  }
  if (r.kind === "agreement") {
    const g = corpus.agreements.find((y) => y.id === r.id) as { title?: string | null } | undefined;
    return `agreement ${r.id}${g?.title ? `: ${g.title}` : ""}`;
  }
  return `acquisition ${r.id}`;
}

function relations(r: ClearanceRecord): string {
  const rel = r.relations.filter((x) => x.relation !== "no_finding");
  if (!rel.length)
    return `<p class="rel muted">No independent researcher finding for this claim.</p>`;
  return rel
    .slice(0, 6)
    .map(
      (x) =>
        `<p class="rel"><span class="r-${x.relation}">${esc(x.researcher)} ${esc(RELATION_LABEL[x.relation])}</span>: “${esc(x.claim.slice(0, 220))}”</p>`,
    )
    .join("");
}

const ACCEPT_LABEL = {
  approve: "approved",
  reject: "rejected",
  leave: "stays proposed",
} as const;

const ACTIONS: [string, string][] = [
  ["accept", "Accept the recommendation"],
  ["alternative", "Choose another reading (say which below)"],
  ["research", "Request more research"],
  ["unresolved", "Leave unresolved (held)"],
  ["reject", "Reject the claim"],
];

function decisionCard(
  g: DecisionGroup,
  records: Map<string, ClearanceRecord>,
  corpus: Corpus,
): string {
  const list = g.records.map((id) => records.get(id)).filter((r): r is ClearanceRecord => !!r);
  return `<section class="decision" data-key="${esc(g.key)}" data-n="${g.decisions}" data-bulk="${g.bulkAcceptable ? 1 : 0}">
<h3>${esc(g.question)}</h3>
<p class="org">${esc(g.orgName)}: ${g.decisions} decision(s) covering ${list.length} record(s)${g.unlocks ? `; confirming clears ${g.unlocks} government row(s)` : ""}</p>
<p class="rec"><b>Recommended:</b> ${esc(g.recommendation)}${g.support.length ? `<br><span class="muted">Checked by code: ${esc(g.support.join("; "))}</span>` : ""}</p>
${g.flags.map((f) => `<p class="flag"><b>Why this needs you:</b> ${esc(f)}</p>`).join("")}
<ul class="ev">${list
    .map(
      (r) =>
        `<li><p class="claim">${esc(valueOf(corpus, r))} <span class="muted">(if you accept: ${esc(ACCEPT_LABEL[g.actions.find((x) => x.id === r.id)?.onAccept ?? "leave"])})</span></p>${sourceLine(corpus, r)}${relations(r)}<p class="src">Escalated because: ${esc(r.basis)}</p></li>`,
    )
    .join("")}</ul>
<fieldset><legend>Your decision</legend>${ACTIONS.map(
    ([v, l]) => `<label><input type="radio" name="d-${esc(g.key)}" value="${v}"> ${esc(l)}</label>`,
  ).join("")}</fieldset>
<textarea aria-label="Note for ${esc(g.orgName)}" placeholder="Reason or alternative (optional for accept)"></textarea>
</section>`;
}

function auditCard(r: ClearanceRecord, reasons: string[], corpus: Corpus): string {
  const passed = r.checks
    .filter((c) => c.result === "pass" || c.result === "waived")
    .map((c) => `${c.id} (${c.reason})`)
    .join("; ")
    .slice(0, 600);
  return `<section class="decision" data-key="qc:${esc(r.id)}" data-n="1">
<h3>${esc(valueOf(corpus, r))}</h3>
<p class="org">${esc(r.orgName)}: ${esc(CLASS_LABEL[r.cls])}; drawn because ${esc(reasons.join(", "))}</p>
${sourceLine(corpus, r)}
<p class="src">Cleared on: ${esc(passed || r.basis)}</p>
${relations(r)}
<fieldset><legend>Open the source. Is the claim right?</legend><label><input type="radio" name="d-qc:${esc(r.id)}" value="correct"> Correct</label><label><input type="radio" name="d-qc:${esc(r.id)}" value="wrong"> Wrong (say what)</label></fieldset>
<textarea aria-label="Audit note" placeholder="What is wrong, if anything"></textarea>
</section>`;
}

const SCRIPT = String.raw`
const KEY = "candef-clearance-" + document.body.dataset.batch;
const cards = [...document.querySelectorAll(".decision")];
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { state = {}; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
function render() {
  let done = 0, total = 0;
  for (const c of cards) {
    const k = c.dataset.key, n = Number(c.dataset.n), s = state[k];
    total += n;
    c.dataset.done = s && s.choice ? "1" : "0";
    if (s && s.choice) done += n;
    if (s) {
      const r = c.querySelector('input[value="' + s.choice + '"]');
      if (r) r.checked = true;
      c.querySelector("textarea").value = s.note || "";
    }
  }
  document.getElementById("progress").textContent = done + " of " + total + " answered";
}
for (const c of cards) {
  c.addEventListener("change", (e) => {
    if (e.target.type !== "radio") return;
    state[c.dataset.key] = Object.assign({}, state[c.dataset.key], { choice: e.target.value });
    save(); render();
  });
  c.querySelector("textarea").addEventListener("input", (e) => {
    state[c.dataset.key] = Object.assign({}, state[c.dataset.key], { note: e.target.value });
    save();
  });
}
document.getElementById("bulk").addEventListener("click", () => {
  const open = cards.filter((c) => c.dataset.bulk === "1" && !(state[c.dataset.key] && state[c.dataset.key].choice));
  if (!open.length) return;
  if (!confirm("Accept the recommendation on " + open.length + " unflagged card(s)? You can still change any of them.")) return;
  for (const c of open) state[c.dataset.key] = Object.assign({}, state[c.dataset.key], { choice: "accept", bulk: true });
  save(); render();
});
document.getElementById("export").addEventListener("click", () => {
  const body = { format: "candef-clearance-review", batch: document.body.dataset.batch,
    policy: document.body.dataset.policy, exportedAt: new Date().toISOString(), answers: state };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  a.download = "candef-clearance-review-" + document.body.dataset.batch.slice(0, 8) + ".json";
  a.click();
});
render();
`;

export function buildQueue(file: ClearanceFile, corpus: Corpus): string {
  const records = new Map(file.records.map((r) => [r.id, r]));
  const byKind = new Map<GroupKind, DecisionGroup[]>();
  for (const g of file.groups) byKind.set(g.kind, [...(byKind.get(g.kind) ?? []), g]);
  const count = (s: string) => file.counts[`state_${s}`] ?? 0;
  const cleared = file.records.filter((r) => r.state === "cleared" || r.state === "cleared_qc");
  const held = file.records.filter(
    (r) => ["insufficient", "incorrect", "contradictory"].includes(r.state) && !r.group,
  );
  const homework = file.records.filter((r) => r.state === "homework");
  const w = file.workload;
  const sections = [...byKind.entries()]
    .map(
      ([kind, groups]) =>
        `<h2>${esc(GROUP_LABEL[kind])}</h2>${groups.map((g) => decisionCard(g, records, corpus)).join("")}`,
    )
    .join("");
  const audit = file.qc
    .map((q) => records.get(q.id))
    .map((r, i) => (r ? auditCard(r, file.qc[i]!.reasons, corpus) : ""))
    .join("");
  const row = (r: ClearanceRecord, extra: string) =>
    `<tr><td>${esc(r.orgName)}</td><td>${esc(valueOf(corpus, r).slice(0, 120))}</td><td>${esc(extra)}</td></tr>`;
  const leads = file.completeness.flatMap((c) =>
    c.categories
      .filter((x) => x.leads.length)
      .map(
        (x) =>
          `<tr><td>${esc(c.card)}</td><td>${esc(x.category)}</td><td>${x.leads.length} lead(s): ${esc(
            x.leads
              .slice(0, 3)
              .map((l) => l.claim.slice(0, 90))
              .join(" | "),
          )}</td></tr>`,
      ),
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CANDEF exception queue ${esc(file.today)}</title><style>${STYLE}</style></head>
<body data-batch="${esc(file.batch)}" data-policy="${esc(file.policy)}">
<header><h1>Exception queue, ${esc(file.cohort[0])} to ${esc(file.cohort.at(-1))}</h1>
<div class="status"><span id="progress" role="status"></span><button id="bulk" type="button">Accept all unflagged recommendations</button><button id="export" type="button">Export my answers</button></div></header>
<main>
<p class="note"><b>Nothing on this page approves anything by itself (policy ${esc(file.policy)}, P-60).</b> Answer every card and every audit record, press <b>Export my answers</b>, then in <b>your own terminal</b> run <code>npm.cmd run candef -- apply-clearance research-cache/clearance/${esc(file.fileName ?? "clearance-…json")} --answers &lt;your export&gt;</code>. It re-checks everything and refuses if anything changed.</p>
<div class="summary">
<div><strong>${w.now.decisions}</strong>decisions for you (${w.now.groups} groups)</div>
<div><strong>${w.now.audit}</strong>audit checks</div>
<div><strong>${count("cleared") + count("cleared_qc")}</strong>cleared by the policy (${file.counts.cleared_conditional ?? 0} once you confirm identities)</div>
<div><strong>${count("homework")}</strong>still being worked on by the system</div>
<div><strong>${count("insufficient") + count("incorrect") + count("contradictory")}</strong>held, not published</div>
<div><strong>${w.old.cards}</strong>cards on the old page</div>
</div>
${sections}
<h2>${esc(GROUP_LABEL.qc)}</h2>
<p class="muted">These records passed every check. A random and risk-weighted sample is checked by you, so a broken rule cannot go unnoticed. One wrong record holds every cleared record of its class in this batch.</p>
${audit}
<h2>What the system settled without you</h2>
<details><summary>Cleared (${cleared.length})</summary><div class="scroll"><table><tr><th>Company</th><th>Claim</th><th>Why it cleared</th></tr>${cleared.map((r) => row(r, `${CLASS_LABEL[r.cls]}: ${r.basis}`)).join("")}</table></div></details>
<details><summary>Still being worked on, not your job (${homework.length})</summary><div class="scroll"><table><tr><th>Company</th><th>Claim</th><th>Next automated step</th></tr>${homework.map((r) => row(r, r.homework.map((h) => `${HOMEWORK[h.kind].label} [${HOMEWORK[h.kind].whoRuns}]`).join("; "))).join("")}</table></div></details>
<details><summary>Held without a decision (${held.length})</summary><div class="scroll"><table><tr><th>Company</th><th>Claim</th><th>State</th></tr>${held.map((r) => row(r, `${STATE_LABEL[r.state]}: ${r.basis}`)).join("")}</table></div></details>
<details><summary>Possible missing events (${leads.length} categories with leads)</summary><p class="muted">Events an independent researcher listed and CANDEF does not have. Each becomes a targeted check by the system; none is a decision for you.</p><div class="scroll"><table><tr><th>Card</th><th>Category</th><th>Leads</th></tr>${leads.join("")}</table></div></details>
</main><script>${SCRIPT}</script></body></html>`;
}
