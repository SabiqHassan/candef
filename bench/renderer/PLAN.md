# ExplorerScene implementation plan

Goal: implement the unchanged ExplorerSceneApi and the delegated benchmark.
Spec: docs/delegations/2026-10-12-renderer-brief.md.

Constraints: edit only engine/, bench/renderer/ and tests/perf/; no installs,
downloads, commits or package/config edits outside these directories.

1. Pure logic (engine/math.ts, labels.ts, buffers.ts, scheduler.ts): write unit
   cases for clipped/depth-aware segment picking, label ordering/collision/
   overflow, visibility and highlight buffers, and coalesced idle scheduling.
   Run the missing-module tests, implement, rerun npm test.
2. GPU batches and ExplorerScene: five instance meshes, two line batches,
   on-demand OrbitControls/tweens, stable-ID updates, DOM pool, picking,
   accessibility and context lifecycle. Add browser assertions before building.
3. Harness: seeded 130/3,310-node data, 400/15,000 edges, controls, projection
   helpers and event/frame diagnostics. Build with the owned Vite config.
4. Browser verification: use built preview, system Chrome (Edge fallback),
   functional tests and hardware-only perf assertions. Store all artifacts
   under owned paths and document actual results and incomplete requirements.

Review focus: near-plane crossing edges; hidden/zero-size instances; data
replacement with reordered IDs; host resizing; disposal during context loss.
Each is covered by the unit or browser tests alongside the main contract.

Execution: inline as requested; no commit or approval handoff. The user's
file ownership and execute instruction override skill default artifact paths.
