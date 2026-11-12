/**
 * Owner review workspace at scale: builds the HTML page from the synthetic research folder written
 * by probe-loader.ts (`.stress/research`), read-only, and writes it to `.stress/workspace.html`.
 *   npx tsx bench/stress/probe-loader.ts 1000 && npx tsx bench/stress/probe-workspace.ts
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorkspace } from "../../pipeline/research/workspace";

const root = join(process.cwd(), ".stress", "research");
const cacheDir = join(process.cwd(), ".stress", "research-cache");
mkdirSync(cacheDir, { recursive: true });
const t = performance.now();
const html = buildWorkspace(root, { today: "2026-10-14", cacheDir });
const ms = Math.round(performance.now() - t);
const out = join(process.cwd(), ".stress", "workspace.html");
writeFileSync(out, html);
console.log(
  JSON.stringify({
    buildMs: ms,
    htmlMB: +(statSync(out).size / 1e6).toFixed(1),
    units: (html.match(/class="unit"/g) ?? []).length,
    orgs: (html.match(/<h2 data-org/g) ?? []).length,
  }),
);
