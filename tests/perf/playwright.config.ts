import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const chromePaths = [
  `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`,
  `${process.env["ProgramFiles(x86)"]}/Google/Chrome/Application/chrome.exe`,
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
];
const channel = chromePaths.some(existsSync) ? "chrome" : "msedge";
export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "**/*.pw.ts",
  outputDir: fileURLToPath(new URL("./artifacts", import.meta.url)),
  reporter: [
    ["list"],
    ["json", { outputFile: fileURLToPath(new URL("./artifacts/results.json", import.meta.url)) }],
  ],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30000,
  projects: [
    { name: "hardware" },
    {
      name: "lowend",
      testMatch: "**/performance.pw.ts",
      timeout: 120000,
      use: { launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } },
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:4186",
    channel,
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ["--enable-gpu"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm.cmd exec vite -- preview --config bench/renderer/vite.config.ts --port 4186",
    // Integrator fix (Claude): Playwright runs webServer from this config's directory; run from the repo root.
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: "http://127.0.0.1:4186",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
