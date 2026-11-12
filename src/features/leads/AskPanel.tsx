import { useState } from "react";
import { AskError, ASK_MODELS, askInBrowser } from "./browserAsk";
import type { LeadsIndex } from "./leadsData";
import styles from "./leads.module.css";

const EXAMPLES = [
  "Drone companies that got their first grant in 2026",
  "Space companies in Quebec with Canadian Space Agency funding",
  "Cybersecurity companies that received IRAP funding since 2023",
];

interface AskReply {
  answer?: string;
  error?: string;
  note?: string;
}

/** "browser": the visitor pastes their own Anthropic key (GitHub Pages build). Otherwise the local service. */
const BROWSER_MODE = import.meta.env.VITE_ASK_MODE === "browser";

/**
 * Plain-language question box. Browser mode sends the visitor's own key only to api.anthropic.com and
 * keeps it in memory (not stored, gone on reload). Local mode posts to /api/ask, served by
 * `scripts/leads-ask-server.ts`, which holds the key and checks every citation against the stored rows.
 */
export function AskPanel({ index }: { index: LeadsIndex }) {
  const [question, setQuestion] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState<string>(ASK_MODELS[0].id);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<AskReply | null>(null);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    if (BROWSER_MODE && !apiKey.trim()) {
      setReply({ error: "Paste your own Anthropic API key first (it stays in this tab)." });
      return;
    }
    setBusy(true);
    setReply(null);
    try {
      if (BROWSER_MODE) {
        const answer = await askInBrowser({ apiKey: apiKey.trim(), model, question: q, index });
        setReply({
          answer,
          note: "Unverified leads from public government data. Answered by the model you chose, using only the loaded search results.",
        });
      } else {
        const r = await fetch("/api/ask", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: q }),
        });
        if (!r.ok) throw new Error(String(r.status));
        setReply((await r.json()) as AskReply);
      }
    } catch (e) {
      setReply({
        error:
          e instanceof AskError
            ? e.message
            : "The ask service is not running here. Start it with: npx tsx scripts/leads-ask-server.ts",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.ask} aria-labelledby="ask-title">
      <h2 id="ask-title">Ask in plain language</h2>
      {BROWSER_MODE ? (
        <div className={styles.askKey}>
          <label htmlFor="ask-key" className={styles.askLabel}>
            Your Anthropic API key. It is sent only to api.anthropic.com from this page, kept in
            this tab&rsquo;s memory, and cleared when you reload. Questions are billed to your own
            account.
          </label>
          <div className={styles.askRow}>
            <input
              id="ask-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              placeholder="sk-ant-…"
              onChange={(e) => setApiKey(e.target.value)}
            />
            <select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)}>
              {ASK_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <label htmlFor="ask-q" className={styles.askLabel}>
          Your question about the grants and contracts data
        </label>
        <div className={styles.askRow}>
          <textarea
            id="ask-q"
            rows={2}
            value={question}
            placeholder="e.g. Show me first-time grant recipients for drone companies in 2026"
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button type="submit" disabled={busy || !question.trim()}>
            {busy ? "Searching…" : "Ask"}
          </button>
        </div>
      </form>
      <div className={styles.askExamples}>
        {EXAMPLES.map((t) => (
          <button
            key={t}
            type="button"
            disabled={busy}
            onClick={() => {
              setQuestion(t);
              void ask(t);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <div className={styles.askOut} role="region" aria-live="polite" aria-label="Answer">
        {reply?.answer ?? reply?.error ?? (busy ? "Searching…" : "")}
      </div>
      {reply?.note ? <p className={styles.askNote}>{reply.note}</p> : null}
    </section>
  );
}
