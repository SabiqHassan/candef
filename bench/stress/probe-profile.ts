import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { compile } from "../../pipeline/compile/compile";
import { generateStressCorpus } from "../../pipeline/synthetic/stress";
// Profiles compile() only (not corpus generation): npx tsx bench/stress/probe-profile.ts 8000 out.cpuprofile
const n = Number(process.argv[2] ?? 8000);
const out = process.argv[3] ?? "compile.cpuprofile";
const { corpus } = generateStressCorpus({ companies: n });
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.start");
const t = performance.now();
compile(corpus, { today: "2026-10-13" });
const ms = Math.round(performance.now() - t);
const { profile } = await session.post("Profiler.stop");
writeFileSync(out, JSON.stringify(profile));
console.log("compileMs", ms);
