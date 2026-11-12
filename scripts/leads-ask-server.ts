/**
 * Local "ask the grants database" page (MVP). Serves one page on http://localhost:4300 and a POST /api/ask
 * that runs the same checked agent as `npm run leads -- ask`. The key never reaches the browser: it is read
 * on the server from the environment or research-cache/grant-ask/keys.env (see docs/LEADS_SEARCH.md).
 *
 *   npx tsx scripts/leads-ask-server.ts [--port 4300]
 *
 * Every answer is an unverified lead from public government data; citations are checked against the
 * stored rows before an answer is shown (the agent falls back to a plain search otherwise).
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  modelFromConfig,
  NoKeyError,
  runAgent,
  SearchProviders,
} from "../pipeline/ingest/gov/ask/search/agent";
import { answerMd } from "../pipeline/ingest/gov/ask/search/card";
import { defaultPaths, LeadStore } from "../pipeline/ingest/gov/ask/search/index";

const root = process.cwd();
const portAt = process.argv.indexOf("--port");
const port = portAt >= 0 ? Number(process.argv[portAt + 1]) : 4300;
const store = new LeadStore(defaultPaths(root));
const dir = join(root, "research-cache", "grant-ask");

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grants search</title>
<style>
:root{--bg:#fff;--fg:#1a1d21;--mut:#5b6470;--line:#d9dde3;--acc:#1f5fbf;--card:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e8eaed;--mut:#9aa3ad;--line:#2b3036;--acc:#6ea8fe;--card:#1b1f23}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0 0 4px}p.sub{color:var(--mut);margin:0 0 16px}
form{display:flex;gap:8px}textarea{flex:1;min-height:64px;padding:10px;font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px}
button{padding:0 18px;font:inherit;background:var(--acc);color:#fff;border:0;border-radius:6px;cursor:pointer}button:disabled{opacity:.5}
.ex{margin:10px 0 0;display:flex;flex-wrap:wrap;gap:6px}.ex button{background:var(--card);color:var(--fg);border:1px solid var(--line);padding:4px 10px;font-size:.85rem}
#out{margin-top:20px;white-space:pre-wrap;word-wrap:break-word;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px;display:none}
.note{color:var(--mut);font-size:.85rem;margin-top:8px}
</style></head><body><main>
<h1>Grants and contracts search</h1>
<p class="sub">Ask in plain language. Results are unverified leads from public Government of Canada grants and contracts data, with the source rows cited.</p>
<form id="f"><textarea id="q" placeholder="e.g. Drone companies with IDEaS funding" aria-label="Your question"></textarea><button id="go">Ask</button></form>
<div class="ex" id="ex"></div>
<div id="out" role="region" aria-live="polite"></div>
<p class="note" id="note"></p>
<script>
const ex=["Drone or UAS companies with IDEaS funding","Space companies in Quebec with Canadian Space Agency contracts or grants","Cybersecurity companies that received IRAP funding since 2023","Companies with FCIA-DIANA funding","New robotics companies that are first-time grant recipients"];
const q=document.getElementById("q"),out=document.getElementById("out"),go=document.getElementById("go"),note=document.getElementById("note");
for(const t of ex){const b=document.createElement("button");b.type="button";b.textContent=t;b.onclick=()=>{q.value=t;ask()};document.getElementById("ex").append(b)}
async function ask(){const text=q.value.trim();if(!text)return;go.disabled=true;out.style.display="block";out.textContent="Searching...";note.textContent="";
try{const r=await fetch("/api/ask",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question:text})});const j=await r.json();out.textContent=j.answer||j.error||"No answer.";note.textContent=j.note||""}
catch(e){out.textContent="Request failed: "+e}finally{go.disabled=false}}
document.getElementById("f").onsubmit=e=>{e.preventDefault();ask()};
</script></main></body></html>`;

async function answer(
  question: string,
): Promise<{ answer?: string; error?: string; note?: string }> {
  const cfgFile = join(dir, "search-providers.json");
  if (!existsSync(cfgFile))
    return { error: `Missing ${cfgFile}. See docs/LEADS_SEARCH.md ("Adding a key").` };
  const cfg = SearchProviders.parse(JSON.parse(await readFile(cfgFile, "utf8")));
  const keysFile = join(dir, "keys.env");
  const keysText = existsSync(keysFile) ? await readFile(keysFile, "utf8") : "";
  try {
    const { model, maxOutputTokens } = modelFromConfig(cfg, undefined, keysText);
    const r = await runAgent({
      model,
      question,
      store,
      limits: maxOutputTokens ? { maxOutputTokens } : undefined,
    });
    return {
      answer: answerMd(r.answer),
      note:
        r.source === "model"
          ? `Model answer; citations checked against the stored rows (${r.requests} request(s)).`
          : `Plain search fallback: ${r.note}`,
    };
  } catch (e) {
    if (e instanceof NoKeyError) return { error: e.message };
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
    return;
  }
  if (req.method === "POST" && req.url === "/api/ask") {
    let body = "";
    for await (const c of req) {
      body += c;
      if (body.length > 20_000) break;
    }
    let question = "";
    try {
      question = String(JSON.parse(body).question ?? "").slice(0, 1000);
    } catch {
      // handled below
    }
    const out = question ? await answer(question) : { error: "Empty question." };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    return;
  }
  res.writeHead(404).end("not found");
}).listen(port, "127.0.0.1", () => console.log(`Grants search on http://localhost:${port}`));
