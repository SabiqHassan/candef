/**
 * Builds the UX-review bundle: screenshots of the FICTIONAL DEMO build plus the approved brief.
 *
 *   npx tsx scripts/ux-review/capture.ts [--id <bundle id>]
 *
 * Output: research-cache/ux-review/<id>/ (gitignored)
 *   screenshots/*.png   demo-data screenshots only
 *   brief.md            copy of docs/ux-review/brief.md (the only text that is ever sent)
 *   manifest.json       file list with SHA-256, build mode, and the demo-data check result
 *
 * Safety: the demo app is built into its own folder, and every capture is preceded by a check that
 * the loaded snapshot is the fictional demo (meta.isDemo === true). Nothing from research/ is read.
 * This script never contacts Antigravity; scripts/ux-review/run.ts does, after validating the bundle.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "../..");
const PORT = 4192;
const BASE = `http://127.0.0.1:${PORT}`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = arg("--id") ?? new Date().toISOString().slice(0, 10);
const out = join(ROOT, "research-cache", "ux-review", id);
const dist = join(ROOT, "research-cache", "ux-review", "dist-demo");

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

async function waitFor(url: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not start: ${url}`);
}

async function assertDemo(page: Page) {
  const isDemo = await page.evaluate(async () => {
    const manifest = await (await fetch("/data/demo/manifest.json")).json();
    const snap = await (await fetch(`/data/demo/${manifest.current}`)).json();
    return snap.meta.isDemo === true;
  });
  if (!isDemo)
    throw new Error("Refusing to capture: the loaded snapshot is not the fictional demo");
}

interface Shot {
  name: string;
  viewport: { width: number; height: number };
  path: (ctx: Ctx) => string;
  settle?: (page: Page) => Promise<void>;
  fullPage?: boolean;
}
interface Ctx {
  slug: string;
  orgId: string;
  name: string;
}

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const SHOTS: Shot[] = [
  { name: "01-explorer-capital-desktop", viewport: DESKTOP, path: () => "/" },
  { name: "02-explorer-government-desktop", viewport: DESKTOP, path: () => "/?lens=contracts" },
  { name: "03-explorer-industry-desktop", viewport: DESKTOP, path: () => "/?lens=industry" },
  {
    name: "04-explorer-selection-card-desktop",
    viewport: DESKTOP,
    path: (c) => `/?sel=${c.orgId}`,
  },
  { name: "05-explorer-list-view-desktop", viewport: DESKTOP, path: () => "/?view=list" },
  { name: "06-dossier-top-desktop", viewport: DESKTOP, path: (c) => `/company/${c.slug}` },
  {
    name: "07-dossier-full-desktop",
    viewport: DESKTOP,
    path: (c) => `/company/${c.slug}`,
    fullPage: true,
  },
  {
    name: "08-dossier-citation-popover-desktop",
    viewport: DESKTOP,
    path: (c) => `/company/${c.slug}`,
    settle: async (page) => {
      const chip = page.locator("[data-source-chip]").first();
      await chip.hover();
      await page.waitForTimeout(250);
    },
  },
  { name: "09-methodology-desktop", viewport: DESKTOP, path: () => "/methodology", fullPage: true },
  { name: "10-explorer-capital-mobile", viewport: MOBILE, path: () => "/" },
  { name: "11-explorer-list-mobile", viewport: MOBILE, path: () => "/?view=list" },
  {
    name: "12-dossier-mobile",
    viewport: MOBILE,
    path: (c) => `/company/${c.slug}`,
    fullPage: true,
  },
  { name: "13-methodology-mobile", viewport: MOBILE, path: () => "/methodology", fullPage: true },
];

async function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "screenshots"), { recursive: true });

  // 1. Demo data + a demo-only production build in a private folder.
  run("npm", ["run", "data:demo"]);
  run("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"]);

  let server: ChildProcess | undefined;
  const files: { file: string; sha256: string }[] = [];
  try {
    server = spawn(
      "npx",
      [
        "vite",
        "preview",
        "--outDir",
        dist,
        "--port",
        String(PORT),
        "--strictPort",
        "--host",
        "127.0.0.1",
      ],
      { cwd: ROOT, stdio: "ignore", shell: process.platform === "win32" },
    );
    await waitFor(BASE);

    const channel = existsSync(`${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`)
      ? "chrome"
      : "msedge";
    const browser = await chromium.launch({ channel, headless: true, args: ["--enable-gpu"] });
    const page = await browser.newPage({ viewport: DESKTOP });
    await page.goto(BASE);
    await assertDemo(page);

    // Pick a company with several rounds and agreements from the demo snapshot.
    const ctx: Ctx = await page.evaluate(async () => {
      const manifest = await (await fetch("/data/demo/manifest.json")).json();
      const snap = await (await fetch(`/data/demo/${manifest.current}`)).json();
      const ranked = snap.organizations
        .filter((o: { scope: string }) => o.scope === "universe")
        .map(
          (o: {
            id: string;
            slug: string;
            name: string;
            financing?: { roundsKnown?: number };
          }) => ({
            o,
            n:
              (o.financing?.roundsKnown ?? 0) +
              snap.agreements.filter((a: { parties: { orgId: string }[] }) =>
                a.parties.some((p) => p.orgId === o.id),
              ).length,
          }),
        )
        .sort((a: { n: number }, b: { n: number }) => b.n - a.n);
      const best = ranked[0].o;
      return { orgId: best.id, slug: best.slug, name: best.name };
    });

    for (const shot of SHOTS) {
      // The app shell scrolls inside its own container, so a full-page shot is a tall viewport.
      await page.setViewportSize(
        shot.fullPage ? { width: shot.viewport.width, height: 3400 } : shot.viewport,
      );
      await page.goto(`${BASE}${shot.path(ctx)}`);
      await assertDemo(page);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1200); // let the 3D scene settle
      if (shot.settle) await shot.settle(page);
      const file = join(out, "screenshots", `${shot.name}.png`);
      await page.screenshot({ path: file });
      console.log("captured", shot.name);
    }
    await browser.close();
  } finally {
    server?.kill();
  }

  // 2. The approved brief is copied verbatim; it is the only text bundled.
  copyFileSync(join(ROOT, "docs/ux-review/brief.md"), join(out, "brief.md"));

  for (const f of [
    ...readdirSync(join(out, "screenshots")).map((n) => `screenshots/${n}`),
    "brief.md",
  ]) {
    const sha256 = createHash("sha256")
      .update(readFileSync(join(out, f)))
      .digest("hex");
    files.push({ file: f, sha256 });
  }
  writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify(
      { id, dataMode: "demo-fictional", createdAt: new Date().toISOString(), files },
      null,
      2,
    ),
  );
  console.log(`bundle ready: ${out} (${files.length} files)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
