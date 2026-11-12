# Synthetic stress testing

Fictional data for scale and robustness testing. **Nothing here is real, nothing here is ever
published.** The generator (`pipeline/synthetic/stress.ts`) builds on the demo generator, so every
organization and source is fictional, sources use `example.invalid`, the corpus is flagged `isDemo`,
and its approvals are fixture reviews that the compiler refuses outside demo builds.

Isolation:

- the snapshot is written to the gitignored `.stress/public/data/stress/`, never to `public/`;
- only `vite build --mode stress` (reads `.env.stress`) serves that folder, into `dist-stress/`;
- every build removes any dataset folder other than its own (`vite.config.ts`);
- the beta release audit refuses `data/demo` and `data/stress` (`pipeline/release/beta.ts`).

## Commands

```
npm run stress:build -- --companies 3000          # build the snapshot only, print metrics
STRESS_COMPANIES=3000 npm run test:stress          # build, serve and measure the real app
npx tsx bench/stress/probe-compile.ts 380,1000,3000 # compile time and snapshot size by scale
npx tsx bench/stress/probe-size.ts 3000            # which parts of the snapshot are large
npx tsx bench/stress/probe-stress.ts 1000          # hard cases and publication-boundary check
npx tsx bench/stress/probe-phases.ts 4000,8000     # generation vs compile time
npx tsx bench/stress/probe-fields.ts               # field sizes in the last built stress snapshot
npx tsx bench/stress/probe-profile.ts 8000 out.cpuprofile   # CPU profile of compile() only
npx tsx bench/stress/summarize-profile.ts out.cpuprofile    # hotspots by self and inclusive time
npx tsx bench/stress/probe-hash.ts 8000            # cost of the canonical snapshot hash
npx tsx bench/stress/probe-layout.ts 380,3000      # cluster separation of the layout by scale
npx tsx bench/stress/probe-loader.ts 1000          # YAML research loader at scale (writes .stress/research)
npx tsx bench/stress/probe-workspace.ts        # owner review workspace built from .stress/research (read-only)
npx tsx bench/stress/probe-workspace-browser.ts # opens it in Chrome and times load, filters, search, export
npx tsx bench/stress/probe-search.ts 10000       # company search latency vs the previous rule
npx tsx bench/stress/profile-loader.ts out.cpuprofile  # CPU profile of that load; summarize with summarize-profile.ts
```

Results are merged into `results/<companies>.json`; `results/baseline/` holds the measurements taken
before the 2026-10-14 improvements. Findings and before/after numbers:
`docs/reports/scalability-2026-10-14.md`.
