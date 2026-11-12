import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Scale and reliability measurements on the SYNTHETIC stress dataset (fictional; never published).
 *
 *   STRESS_COMPANIES=3000 npx playwright test -c tests/stress/playwright.config.ts
 *
 * Builds `.stress/` (gitignored) and a stress-mode app into `dist-stress/`, then measures the real
 * application in system Chrome. Results go to `bench/stress/results/<companies>.json`.
 */
const chrome = [
  `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`,
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
].some(existsSync);
const companies = process.env.STRESS_COMPANIES ?? "3000";

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "**/*.pw.ts",
  outputDir: fileURLToPath(new URL("./artifacts", import.meta.url)),
  reporter: [["list"]],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 180_000,
  use: {
    baseURL: "http://127.0.0.1:4193",
    channel: chrome ? "chrome" : "msedge",
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ["--enable-gpu", "--enable-precise-memory-info"] },
  },
  webServer: {
    command: `npx tsx bench/stress/build.ts --companies ${companies} && npx vite build --mode stress --outDir dist-stress && npx vite preview --mode stress --outDir dist-stress --port 4193 --strictPort`,
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: "http://127.0.0.1:4193",
    reuseExistingServer: false,
    timeout: 600_000,
  },
});
