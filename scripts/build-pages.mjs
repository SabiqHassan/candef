// Builds the GitHub Pages edition into pages-dist/: the real (approved-only) research data, the
// base path for /<repo>/, and the bring-your-own-key ask box.
//   node scripts/build-pages.mjs <repo-name>      (default: candef)
import { copyFileSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const repo = process.argv[2] || "candef";
const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
rmSync("pages-dist", { recursive: true, force: true });
run("npm", ["run", "data:research"]);
run("npx", ["vite", "build", "--mode", "research", "--outDir", "pages-dist"], {
  VITE_BASE: `/${repo}/`,
  VITE_ASK_MODE: "browser",
});
// Ship only the snapshot the manifest points at (older ones are leftovers from earlier builds).
const dataDir = `pages-dist/data/research`;
const current = JSON.parse(readFileSync(`${dataDir}/manifest.json`, "utf8")).current;
for (const f of readdirSync(dataDir))
  if (/^snapshot..*.json$/.test(f) && f !== current) rmSync(`${dataDir}/${f}`);
copyFileSync("pages-dist/index.html", "pages-dist/404.html"); // single-page routing on GitHub Pages
writeFileSync("pages-dist/.nojekyll", "");
console.log(`Built pages-dist/ for https://<account>.github.io/${repo}/`);
