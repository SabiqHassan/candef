import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// System Chrome on Windows, Linux (including GitHub's Ubuntu runners) or macOS; else Edge.
const chrome = [
  `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`,
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].some(existsSync);

export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "**/*.spec.ts",
  outputDir: fileURLToPath(new URL("./artifacts", import.meta.url)),
  reporter: [["list"]],
  workers: 2,
  // One retry on CI only; Playwright still reports a retried pass as flaky.
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:4190",
    channel: chrome ? "chrome" : "msedge",
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ["--enable-gpu"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Production build of the app against the fictional demo snapshot.
    command: "npm run data:demo && npx vite build && npx vite preview",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: "http://127.0.0.1:4190",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
