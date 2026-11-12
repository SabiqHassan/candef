import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

type Dataset = "demo" | "research" | "stress";

/**
 * Vite copies the public folder into the build. Each build must ship exactly one dataset: a
 * research (real) build never contains fixture or synthetic data, and a demo or stress build never
 * contains real research data. Every other dataset folder is removed after the build.
 */
function datasetIsolation(dataset: Dataset): Plugin {
  let outDir = "dist";
  return {
    name: "candef-dataset-isolation",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      for (const other of ["demo", "research", "stress"] as const)
        if (other !== dataset)
          rmSync(resolve(outDir, "data", other), { recursive: true, force: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const dataset: Dataset =
    env.VITE_DATASET === "research"
      ? "research"
      : env.VITE_DATASET === "stress"
        ? "stress"
        : "demo";
  return {
    // GitHub Pages serves a project site under /<repo>/: set VITE_BASE=/<repo>/ for that build.
    base: env.VITE_BASE || "/",
    plugins: [react(), datasetIsolation(dataset)],
    // The synthetic stress dataset never lives in public/: only the stress mode serves it. The local
    // preview of simulated approvals lives only in .preview/ (gitignored) and builds there too.
    publicDir:
      mode === "localpreview"
        ? ".preview/public"
        : dataset === "stress"
          ? ".stress/public"
          : "public",
    server: {
      host: "127.0.0.1",
      port: 5180,
      strictPort: true,
      proxy: { "/api": "http://127.0.0.1:4300" },
    },
    preview: {
      host: "127.0.0.1",
      port: 4190,
      strictPort: true,
      proxy: { "/api": "http://127.0.0.1:4300" },
    },
    build: {
      ...(mode === "localpreview" ? { outDir: ".preview/site" } : {}),
      rollupOptions: {
        output: {
          // Keep the renderer vendor chunk separate for caching.
          manualChunks: { three: ["three"] },
        },
      },
    },
  };
});
