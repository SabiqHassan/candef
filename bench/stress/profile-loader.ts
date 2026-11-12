import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadResearchCorpus } from "../../pipeline/research/load";
// Profiles loadResearchCorpus on the folder written by probe-loader.ts (.stress/research):
//   npx tsx bench/stress/probe-loader.ts 1000 && npx tsx bench/stress/profile-loader.ts out.cpuprofile
const out = process.argv[2] ?? "loader.cpuprofile";
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.start");
const t = performance.now();
const r = loadResearchCorpus(join(process.cwd(), ".stress", "research"));
const ms = Math.round(performance.now() - t);
const { profile } = await session.post("Profiler.stop");
writeFileSync(out, JSON.stringify(profile));
console.log("loadMs", ms, "files", r.files, "issues", r.issues.length);
