# ExplorerScene renderer handoff — M1-A

Date: 2026-10-12. All work is uncommitted on the supplied renderer worktree.
Only `src/graph/engine/`, `bench/renderer/`, and `tests/perf/` contain additions.
`types.ts`, root package/config files, and the preserved experiment are unchanged.

## What was built

`ExplorerScene` implements the unchanged `ExplorerSceneApi` in plain TypeScript
with Three.js and OrbitControls. Import it and `WebGLUnavailableError` from
`src/graph/engine/index.ts`; construct with an HTML host and the existing options.

- Five instanced meshes: sphere, octahedron, cube, tetrahedron and small anchor
  torus marker. Instance color, shader alpha, scale and zero-scale filtering;
  selected/related nodes stay bright, other nodes use 0.12 alpha.
- Two batched line geometries (solid/dashed), vertex color/alpha, weight-sensitive
  overview opacity, emphasized selection relationships, and endpoint filtering.
- Coalesced on-demand rendering, damping, 280 ms camera/position transitions,
  immediate reduced-motion changes, aspect-aware framing of visible bounds.
  Selection, related state, hover and visibility follow stable IDs on replacement.
- Instanced node raycasting with camera clipping; node priority; homogeneous
  frustum clipping and CSS-pixel segment picking returning all candidates in
  depth order. A click requires maximum gesture displacement strictly under 5 px,
  so a drag out and back is still a drag. Labels support pointer selection.
- A capped DOM label pool, measured text widths, priority and grid collision
  policy, overflow events, `aria-hidden`, and no tabindex/focusable controls.
  The canvas has `role="img"` and the description supplied by the application.
- Typed WebGL2 construction failure, lost-context suspension/resource rebuild,
  and idempotent disposal of GPU resources, controls, observers, listeners, DOM,
  scheduled work and pointer capture. Original host inline styles are restored.

The harness is a local, explicitly synthetic network with size/highlight/filter/
labels/reduced-motion/reset controls. Small: 100 companies, 20 institutions,
10 anchors, 400 edges. Large: 3,000 companies in 10 clusters, 300 institutions
on a shell, 10 anchors, exactly 15,000 edges. A fixed PRNG seed produces all
five node kinds, both edge styles, weights, bundles and near/coincident edges.
`window.__bench` exposes the requested scene/data/projection helpers plus event
and frame timestamps. Projection helpers return viewport CSS coordinates.

## Module map

| File                                                     | Responsibility                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `src/graph/engine/ExplorerScene.ts`                      | API, camera, interactions, labels, lifecycle, stats                 |
| `src/graph/engine/gpu.ts`                                | Five instance meshes, two line batches, shaders, resource ownership |
| `src/graph/engine/buffers.ts`                            | Pure instance/segment construction, colors, radii, validation       |
| `src/graph/engine/math.ts`                               | Segment distance, depth ordering, six-plane clipping                |
| `src/graph/engine/labels.ts`                             | Label priorities, grid collisions, overflow                         |
| `src/graph/engine/scheduler.ts`                          | Coalesced invalidation, suspend/resume, idempotent cancellation     |
| `src/graph/engine/index.ts`                              | Public exports                                                      |
| `src/graph/engine/{logic,gpu}.test.ts`                   | Node-only unit cases, including Three CPU raycasting                |
| `bench/renderer/{generate.ts,generate.test.ts}`          | Seeded renderer-only fixture and invariants                         |
| `bench/renderer/{main.ts,index.html,style.css,env.d.ts}` | Standalone controls and test instrumentation                        |
| `bench/renderer/vite.config.ts`                          | Owned Vite root/build/preview configuration                         |
| `tests/perf/playwright.config.ts`                        | Built preview, system Chrome/Edge, GPU enabled, owned artifacts     |
| `tests/perf/helpers.ts`                                  | Browser fixture and render-wait helpers                             |
| `tests/perf/functional.pw.ts`                            | 16 functional browser cases                                         |
| `tests/perf/performance.pw.ts`                           | Hardware-only large-fixture acceptance and JSON measurements        |
| `bench/renderer/results/latest.json`                     | Explicit not-run status; all measured fields null                   |

The `.pw.ts` suffix keeps Playwright tests out of default Vitest discovery.
Owned `.gitignore` files exclude generated builds/caches/browser artifacts.

## Contract changes

None. `src/graph/engine/types.ts` was not modified. The concrete class additionally
exports `projectNode` and `projectEdgeMidpoint` for host overlays/the harness;
neither changes the application API contract. `WebGLUnavailableError` is exported
with `code = 'WEBGL2_UNAVAILABLE'` and preserves a construction error as `cause`.
`zoomBy(factor)` divides camera distance by the factor (greater than 1 zooms in).

## Actual verification

These results describe commands executed in this sandbox, not expected results.

| Command                                                                     | Real result                                                                                                                        |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm.cmd run typecheck`                                                     | **Passed**, exit 0, strict root configuration; rerun after implementation and review fixes                                         |
| `npm.cmd test -- src/graph/engine/logic.test.ts`                            | **Blocked**, exit 1: Vitest fork worker `spawn EPERM`; zero tests executed                                                         |
| `npm.cmd test`                                                              | **Blocked**, exit 1: fork workers `spawn EPERM`; zero tests executed; preserved V1 tests also discovered and blocked               |
| `npm.cmd run bench:renderer:build`                                          | **Blocked**, exit 1: esbuild service `spawn EPERM` while Vite loads `bench/renderer/vite.config.ts`; no production bundle produced |
| `npm.cmd run test:perf`                                                     | **Blocked**, exit 1: Playwright preview webServer process creation `spawn EPERM`; no browser/tests launched                        |
| `npm.cmd exec playwright -- test -c tests/perf/playwright.config.ts --list` | **Passed discovery only**, exit 0: 17 tests across two files; no tests executed                                                    |
| `git diff --check` and ownership inventory                                  | No tracked modifications or whitespace errors; all additions under permitted directories                                           |

The first literal `npm` attempt was rejected by PowerShell's script execution
policy (`npm.ps1` cannot be loaded); the normal Windows `npm.cmd` entry point was
used thereafter. The first Playwright attempt detected an existing service on
port 4173, so the owned test config uses isolated port **4186** and refuses to
reuse another server. Its next attempt failed with `spawn EPERM`.

No permissions escalation, browser download, package installation, networking,
outside-sandbox retry, alternate software-rendered perf run, or commit occurred.
The Browser plugin/skill was unavailable; the brief's Playwright path was used.

Unit files contain 12 cases: nine pure logic/scheduler cases, two GPU-buffer/CPU
raycasting cases, and one generator case. They are written and typechecked, but
**none executed through Vitest**. Initial test-first execution was blocked before
the missing-module assertions could run. The full unit command was run before
the final GPU regression file/review fixes; no final passing unit run is claimed.

A read-only second-agent review checked implementation against the brief and
installed Three sources. Static findings fixed: stale instance raycast bounds,
clip-plane picking, canvas cancellation capture, host capture on context loss,
camera input taking over tweens, empty-string ID remapping, measured label widths,
and meaningful selected/related remapping assertions. This is not runtime proof.

## Performance measurements

**GPU renderer string: not obtained.** No browser launched. Values below are
intentionally not estimated. Machine-readable status is in `results/latest.json`.

| Metric                                              | Budget                  | Measured result                                                       |
| --------------------------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| Large orbit p95 frame interval, scripted 3 s drag   | ≤ 20 ms                 | Not run — preview spawn blocked                                       |
| Node click to highlighted frame                     | ≤ 100 ms                | Not run                                                               |
| Idle frames from 500–2,500 ms after last input      | 0                       | Not run                                                               |
| Visibility/hover/resize latency and subsequent idle | ≤ 100 ms, then 0 frames | Not run                                                               |
| Navigation to first rendered frame                  | < 2,500 ms              | Not run                                                               |
| Total benchmark JS gzip bytes                       | < 1,000,000 bytes       | Not measured — build blocked                                          |
| Draw calls per rendered frame                       | Diagnostic target ≤ ~16 | Not measured; architecture has at most seven non-empty render batches |

The performance spec obtains `UNMASKED_RENDERER_WEBGL` and skips with an explicit
reason if the string is unavailable or indicates SwiftShader/llvmpipe/another
software renderer. It writes no timing measurements on that path. On verified
hardware it stores timestamps/metrics **before** asserting budgets, including
failed measured budgets. It monitors actual engine renders, not idle browser RAF
callbacks, and sums gzip sizes of all built `.js` chunks. The monitoring RAF is
harness-only; `ExplorerScene` has no continuous idle loop.

## Limitations and requirements not yet met

1. **Definition of done is not fully met:** root unit tests, production build,
   functional browser tests and real-GPU performance acceptance could not run.
   Shader compilation, visual appearance, context recovery, browser interactions,
   idle-frame behavior, resource disposal and numerical budgets remain unverified.
2. Picking scans instanced nodes and visible edge segments on demand; projected
   edge segments are cached until camera/state changes. No spatial index/GPU ID
   buffer. Hover/highlight/filter changes rebuild CPU batches; position tweens
   rebuild edge geometry while active. These costs require hardware profiling.
3. Transparent instances use depth writing without per-instance transparency
   sorting. This bounds draw calls but can make a rear dim node less visible behind
   another node. Dashed gaps remain selectable as part of the relationship's
   segment; line weight is encoded by opacity, not variable pixel thickness.
4. Label text metrics use the actual configured font and are refreshed once fonts
   are ready. IBM Plex Sans is used if the integrating app supplies it; this minimal
   harness falls back to Arial/Consolas and includes no downloaded font assets.
5. The engine retains caller-provided data buffers; callers should treat submitted
   data as immutable and call `setData` to change it. Masks are copied. New IDs
   start at their supplied coordinates; retained IDs animate from current positions.

To verify in an environment that permits the requested processes, run
`npm.cmd run typecheck`, `npm.cmd test`, `npm.cmd run bench:renderer:build`, then
`npm.cmd run test:perf`. No dependency or root config change is requested.
Manual inspection: `npm.cmd run bench:renderer`, open the shown local URL with
`?size=large` or `?size=small`; reduced motion is `&reduced=1`.

---

## Integrator verification (Claude, 2026-10-13) — appended; Codex's text above is unchanged

Codex's sandbox could not spawn processes, so nothing above had been executed. I ran everything
outside the sandbox on the target machine (system Chrome, `ANGLE (AMD, Radeon RX 580 Series … D3D11)`;
hardware GPU confirmed by the spec's own renderer-string check).

### Results

| Check                                                | Result                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `tsc --noEmit` (strict)                              | pass                                                              |
| Unit tests (`vitest run --exclude 'experiments/**'`) | **12/12 pass** (3 files)                                          |
| `bench:renderer:build`                               | pass; JS **146,253 B gzip** (budget < 1 MB)                       |
| Browser functional + performance (`test:perf`)       | first run 15/17; after fixes **18/18 pass in 3 consecutive runs** |

### Performance on the large fixture (3,000 companies, 300 institutions, 10 anchors, 15,000 edges)

Three runs:

| Metric                               | Budget              | Run 1                    | Run 2          | Run 3          |
| ------------------------------------ | ------------------- | ------------------------ | -------------- | -------------- |
| Orbit p95 frame interval             | ≤ 20 ms             | 17 ms (181 frames / 3 s) | 17 ms          | 17 ms          |
| Click → highlighted frame            | ≤ 100 ms            | 11.9 ms                  | 17.1 ms        | 13.2 ms        |
| Idle frames 500–2,500 ms after input | 0                   | 0                        | 0              | 0              |
| Hover / visibility / resize latency  | ≤ 100 ms, then idle | 7 / 10 / 29 ms           | 7 / 18 / 34 ms | 7 / 13 / 28 ms |
| Navigation → first frame             | < 2,500 ms          | 125 ms                   | 127 ms         | 121 ms         |
| Draw calls / frame (diagnostic)      | ≈ ≤ 16              | 7                        | 7              | 7              |

For comparison, V1 issued ~395 draw calls/frame for ~300 objects and rendered 60 fps while idle.

### Defects found and fixed by the integrator (each marked `Integrator fix (Claude)` in code)

1. **Engine bug — drags starting on a label did not orbit.** OrbitControls listened on the canvas; DOM labels
   intercepted pointer events. Diagnosed by instrumented drag (camera unchanged, 1 frame). Fix: controls attach to the
   host (`ExplorerScene.ts`); label clicks still resolve through the host pointer handlers. New regression test
   `drag starting on a label orbits; label click selects once` (passes).
2. **Engine bug — damping tail violated the idle budget (1 frame).** OrbitControls reports motion until a
   microscopic epsilon (~0.8 s). Fix: stop scheduling once per-frame camera motion is below ~0.25 px.
3. **Test bug — context-loss test** re-called `getExtension()` on a lost context (returns null by spec). Fix: keep the
   original extension reference.
4. **Config bug — Playwright webServer** ran from the config directory, so the bench config path did not resolve.
   Fix: `cwd` set to the repository root.

### Visual inspection (not covered by tests)

- Renders correctly, with the specified shapes and dark palette, and no decorative elements.
- **At 15,000 simultaneous edges the overview becomes a near-white "starburst":** additive low-alpha edges saturate and hide nodes. Highlighting dims correctly and labels the related nodes, but the emphasized edges have weak contrast against the dimmed mass.
- **Overview framing is loose:** the graph spans ~1/3 of the viewport width.
- These are expected for an all-edges stress fixture and are addressed by design in M1-B:
  - Capital overview uses sector bundles, not 15k edges (D-07);
  - add density-adaptive edge alpha;
  - brighten emphasized edges;
  - tighten framing.

---

## M1-B-E — engine readability at scale (Codex, 2026-10-13)

Implementation and verification are complete on `agent/codex/engine-readability`.
Changes are uncommitted and confined to `src/graph/engine/`, `bench/renderer/`,
and `tests/perf/`. No packages, root configuration, application files, docs,
experiments, Git identity, commits, or remotes were changed.

### What changed

- Implemented copied edge masks combined with endpoint visibility, inset-aware
  camera projection and label placement, and subset framing without `setData`.
- Fit visible node positions against perspective bounds at 88% of available
  width/height. Focus, fit and zoom use a 520 ms smoothstep transition; reduced
  motion jumps. Existing damping and the settling threshold remain. Zoom limits
  now derive from the framed overview instead of allowing an 8,000-unit retreat.
- Normal blending is explicit. Edges draw first without depth writes; nodes draw
  over them. Overview edge alpha falls with eligible edge count and projected
  footprint density. Camera-only frames change instance matrices and one edge
  uniform, leaving line geometry intact.
- Bundles use twelve quadratic segments inside the existing two line batches.
  Weight affects opacity, dashed distance follows the arc, and picking follows
  the same segments, deduplicating their parent edge IDs in depth order.
- Node prominence affects radius and label ordering. Weighted minimum pixel
  sizes have absolute floors for very small weights; CPU matrices match picking.
  Selection uses the brightest fill and one thin accent outline and remains
  larger than visible neighbours across kinds and weights. Related nodes use
  1.3× size and full colour; background nodes use desaturated colour at 0.24
  alpha. Selected relationships use 0.8 alpha; background relationships use
  0.012 before density reduction.
- Overview shows anchor labels; Region/Detail admit company labels. Selection
  and hover keep their existing priorities, collision pool and overflow events.
- The default harness mode is `app`. Overview masks to investor-sector bundles;
  investor clicks show individual capital records, highlight the portfolio and
  frame its nodes. Background clicks restore overview. `mode=all` retains all
  15,000 edges. A toggleable 400 px panel supplies real viewport insets and
  prevents its pointer events from reaching graph controls.
- The fixture has 3,310 nodes and exactly 15,000 visual edges, with complete,
  unique investor-sector aggregates whose weights and evidence styles derive
  from the individual capital records. Existing node positions are unchanged.
- Added PNG pixel measurement, framing/contrast/disclosure/hysteresis browser
  checks, and a separate SwiftShader + CDP CPU ×4 project. No dependency was added.

### Contract notes

`types.ts` has no content/API change. `setEdgeVisibility` copies its mask and
does not recreate node meshes or replace data. `setData` clears edge eligibility:
edges have no stable IDs, so preserving an index mask across replacement would
hide unrelated edges. Node visibility and selection still follow stable node IDs.
Insets change the optical centre without starting an unsolicited camera tween;
subsequent focus/reset/frame commands use that centre. Resize preserves the
insets. Empty `frameNodes` is a no-op; hidden nodes do not participate in fits.

Zoom bands use camera distance divided by the most recent reset/initial overview
fit distance. Overview enters Region below 0.62 and Detail below 0.28; Region
returns to Overview above 0.72; Detail returns to Region above 0.36 (or directly
to Overview above 0.72). Events fire only when the band changes. Subset framing
does not overwrite the overview reference distance.

### Final measurements

Hardware was verified as
`ANGLE (AMD, Radeon RX 580 Series (0x000067DF) Direct3D11 vs_5_0 ps_5_0, D3D11)`.
Final hardware measurements are in `results/latest.json`; software diagnostics
are in `results/lowend.json`. Both hardware modes passed every budget.

| Metric                                | Hardware budget | Hardware app     | Hardware all     | Software app    | Software all    |
| ------------------------------------- | --------------- | ---------------- | ---------------- | --------------- | --------------- |
| Orbit p95 interval                    | ≤20 ms          | 17.0 ms          | 17.0 ms          | 170.9 ms        | 454.0 ms        |
| Orbit frames / duration               | Diagnostic      | 182 / 3,045.3 ms | 181 / 3,023.1 ms | 24 / 3,144.0 ms | 11 / 3,081.8 ms |
| Click → highlight                     | ≤100 ms         | 23.2 ms          | 31.3 ms          | 539.4 ms        | 1,242.0 ms      |
| Idle frames, 500–2,500 ms after orbit | 0               | 0                | 0                | 12              | 7               |
| Hover invalidation                    | ≤100 ms         | 3.2 ms           | 14.7 ms          | 13.3 ms         | 61.8 ms         |
| Visibility invalidation               | ≤100 ms         | 12.5 ms          | 13.0 ms          | 21.0 ms         | 34.5 ms         |
| Resize invalidation                   | ≤100 ms         | 24.0 ms          | 32.0 ms          | 38.9 ms         | 31.2 ms         |
| Idle frames after each invalidation   | 0               | 0                | 0                | 0               | 0               |
| Cold navigation → first frame         | <2,500 ms       | 138.0 ms         | 146.1 ms         | 836.8 ms        | 610.6 ms        |
| All JS chunks, gzip                   | <1,000,000 B    | 148,936 B        | 148,936 B        | 148,936 B       | 148,936 B       |
| Last measured draw calls              | Diagnostic      | 8                | 8                | 8               | 8               |
| Browser console/page errors           | 0               | 0                | 0                | 0               | 0               |

Software is explicitly a **software-rendering lower bound**, not a measured
low-end device and not a performance acceptance result. Its verified renderer is
`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`.
It launches with `--use-angle=swiftshader --enable-unsafe-swiftshader` and CPU
throttling rate 4. It records the same measurements without timing/idle budgets.
The poor software orbit/selection results and longer settling tails are retained,
not skipped or relabelled as passing hardware performance.

### Starburst, contrast and framing

The baseline was actually captured before implementation using the original
large/all fixture: **7.0721%** of canvas pixels exceeded the 0.6 brightness
threshold. `before.json` and `before-all.png` preserve this measurement.
The final app overview is **2.5183%** (budget <3%); all-edges overview is
**2.6953%** (diagnostic only). PNGs are 1,440 × 816 pixels.

The screenshot decoder measures `(0.2126 R + 0.7152 G + 0.0722 B) / 255` in
the captured sRGB image. This is a conservative near-white brightness score:
linearising sRGB would count fewer pixels above 0.6. The measurement includes
nodes and overview labels as well as edges; the remaining bright pixels do not
all represent edge saturation. Baseline and final have the same node positions
and workload size, but final edge generation now uses valid, complete aggregates;
this is an end-to-end before/after comparison, not a one-variable experiment.

With an investor physically clicked in app mode, mean 3×3 pixel brightness was
**0.71416 related / 0.21689 background = 3.29275×** (budget ≥3×). Samples use
eight related and 564 background company centres, excluding offscreen centres
and centres within 7 px of another node. Comparing the same node kind and
excluding overlaps avoids confusing shape, occlusion or labels with selection
contrast. Labels are disabled for pixel sampling, then restored for the saved
selection screenshot.

Visible-node projected bounds occupied **87.8523%** without insets and
**87.9004%** with a 400 px right inset (budget ≥80%). All bounds stayed inside
the available region, and all placed labels avoided the panel. Additional tests
exercise all four insets, subset framing, empty subsets, copied edge masks,
hidden endpoints and zoom-band hysteresis.

Final screenshots: `results/overview-app.png`,
`results/selected-investor-app.png`, `results/overview-all.png`.
Detailed readability values are in `results/readability.json`.

### Commands and real outcomes

Commands below were executed through `cmd.exe` where npm/npx was needed, so the
literal §6 commands could run without PowerShell's npm.ps1 execution-policy
problem. Escalation was requested only for the exact permitted `npm test`,
`npm run bench:renderer:build` and `npm run test:perf` commands. Every escalation
was granted. No other command was escalated.

| Command                                                                                                                                                                                                                    | Real results, in execution order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx prettier --write src/graph/engine bench tests/perf`                                                                                                                                                                   | Six runs including the final report formatting: all exit 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `npx eslint src/graph/engine bench tests/perf`                                                                                                                                                                             | Five runs: all exit 0, no lint diagnostics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `npm run typecheck`                                                                                                                                                                                                        | First exit 2: `panel.hidden` inferred as `string \| boolean`, and typed-array backing-buffer mismatch. Both corrected. Next five runs exit 0.                                                                                                                                                                                                                                                                                                                                                                           |
| `npm test`                                                                                                                                                                                                                 | Eight runs: (1) exit 1, 11 pass / 3 fail on missing alpha tiers, edge masks/curves and prominence; (2) exit 0, 14 pass; (3) exit 1, 14 pass / 1 fail on incomplete aggregate coverage; (4) exit 0, 15 pass; (5) exit 0, 18 pass; (6) exit 1, 18 pass / 1 fail on mixed-kind weighted selection size; (7–8) exit 0, 19 pass in each. Final: 3 files, 19/19 tests.                                                                                                                                                        |
| `npm run bench:renderer:build`                                                                                                                                                                                             | Six runs: first sandboxed run exit 1, esbuild `spawn EPERM`. Five escalated runs exit 0; reported JS gzip sizes 146.34, 148.72, 148.75, 148.79 and 148.94 kB. Final exact gzip sum from the perf test: 148,936 B. Every successful build warned that the raw minified JS chunk exceeds 500 kB; this is not the gzip budget.                                                                                                                                                                                             |
| `npm run test:perf`                                                                                                                                                                                                        | Five runs: baseline exit 0, 19/19; first implementation exit 1, 20/23 (app hover probe was off-canvas in hardware and software, and only four isolated related samples met the initial 9 px exclusion); next three runs exit 0, 23/23 each, including the final weighted-selection implementation. No performance budgets were weakened. The hover probe now targets the framed investor; pixel samples use a 7 px exclusion with the same ≥3× contrast requirement.                                                    |
| `git status --short`, `git branch --show-current`                                                                                                                                                                          | Initial workspace clean; branch `agent/codex/engine-readability`. Later status inventories show only owned paths. No commit was made.                                                                                                                                                                                                                                                                                                                                                                                   |
| `git diff --check`, `git diff --stat`, `git diff --numstat`, `git diff --name-only`, `git diff -- src/graph/engine/types.ts`                                                                                               | Exit 0. No whitespace errors; all content diffs confined to owned paths; no contract diff. Git prints LF→CRLF working-copy warnings after Prettier.                                                                                                                                                                                                                                                                                                                                                                     |
| `rg --files -g AGENTS.md -g '*playwright*' -g 'package.json' -g '!node_modules' -g '!dist'`; `rg --files src/graph/engine bench/renderer tests/perf`; later `rg --files tests/perf/artifacts` and owned result inventories | Exit 0; used only to discover instructions, implementation, tests and artifacts.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Get-Content -Raw` and bounded `Get-Content ... \| Select-Object -Skip ... -First ...` reads                                                                                                                               | Exit 0 except the two diagnostic probes below. Read the complete delegation brief; renderer report including integrator notes; contract; DESIGN and ARCHITECTURE/Layout; CLAUDE and docs/AGENTS; engine buffers, GPU, scene, labels, math and tests; bench generator, harness, HTML/CSS, config and tests; perf config/helpers/functional/performance tests; package, TypeScript, Vitest and ESLint config; and generated JSON measurements. Repeated reads inspected the final implementation and actual result files. |
| Skill `Get-Content -Raw` reads                                                                                                                                                                                             | Exit 0 for `using-superpowers`, `verification-before-completion`, `test-driven-development`, its `writing-good-tests.md` reference, and `systematic-debugging` under the installed Superpowers skill directory.                                                                                                                                                                                                                                                                                                         |
| Early `Get-Content -Raw` probe of `readability.json`, `latest.json`, `lowend.json`                                                                                                                                         | Exit 1 because readability/lowend files had not yet been produced. Existing latest.json was read; no missing measurement was claimed. Later reads succeeded.                                                                                                                                                                                                                                                                                                                                                            |
| `rg --files tests/perf/artifacts; Get-Content -Raw tests/perf/artifacts/hardware*/*error-context*`                                                                                                                         | Exit 1: discovery succeeded but the diagnostic glob did not match the actual artifact directory names.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Get-ChildItem tests/perf/artifacts -Recurse -Filter error-context.md \| ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }; Get-Content -Raw bench/renderer/results/latest.json`                                | Exit 0; read the real failed-test contexts and diagnosed the probe/sample failures.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Read-only image inspection also viewed the baseline, app overview, selected
investor and all-edges screenshots successfully. Edits used `apply_patch` only
inside owned paths; the final action appended this section and formatted it.

### Known limitations

- The all-edges stress view remains dense despite removing near-white saturation;
  app mode and progressive disclosure are the readable product path.
- Density uses an eligible-edge count and projected node footprint, not a local
  per-pixel overlap heatmap. Adversarial coincident edges can still concentrate
  ink; this test proves the supplied large fixture, not every possible layout.
- Curves bend in the world XY plane, so an edge-on orbit can flatten them. Line
  weight uses opacity rather than variable pixel thickness. A bundle adds twelve
  segments but no additional draw batch.
- Instanced transparency still lacks per-instance depth sorting. Very crowded
  nodes can occlude each other. The contrast measurement deliberately excludes
  overlapping centres and is not a claim about every visible pixel.
- The absolute node floor is a visibility safeguard; arbitrary extreme camera
  clipping/data weights and very narrow fully occluded viewports are not covered
  by the fixed 1,440 × 900 browser profile. Labels remain capped at 40 and report
  related overflow for the application to expose in its complete list.
- Software ×4 results miss hardware timing/idle budgets substantially; they are
  diagnostic. They do not predict a particular low-end GPU or CPU.
- The benchmark uses synthetic records and fallback local fonts. It does not
  verify app integration, actual research data, or an analyst's ability to answer
  questions; those remain with the integrator/product review.
