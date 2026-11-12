/**
 * candef: research workflow CLI (M3-B). Usage: npm run candef -- <command> …
 *
 *   new <kind> <name> [--slug s] [--by who]        mint an organization (refuses duplicates)
 *   source add <url> --kind k --tier T2 --publisher p --title t [--published YYYY-MM]
 *   capture <sourceId>                             polite, permitted capture into research-cache/
 *   capture <sourceId> --file <path> --method browser|manual [--text <path>] [--retrieved ISO]
 *                                                  register a file saved inside research-cache/ as a capture
 *   fingerprint <sourceId>                         hashes only, no bytes kept (terms silent or no copy allowed)
 *   ledger <slug> <topic> <outcome> --searched "a;b" [--next YYYY-MM] [--at YYYY-MM-DD] [--by who]
 *   validate                                       load + gates + compile; nothing is published
 *   coverage                                       claim-level citation coverage of all of research/ (exit 1 on any gap)
 *   status                                         pilot progress per company (eligibility, topics, proposed, published)
 *   report [--out file]                            semantic review report (HTML, research-cache/)
 *   review <id…> | review --org <slug>             OWNER ONLY: interactive terminal + typed confirmation
 *   workspace [--out file]                         owner review workspace (HTML, research-cache/review/; read-only)
 *   tiers [--skip-gov-rows] [--plan file] [--companies cards.json]  tiered verification (D-21): research-cache/tiers/; read-only
 *   apply-tiers <tiers-file> --decisions <file>    OWNER ONLY: apply a tiers batch (docs/VERIFICATION_TIERS.md)
 *   apply-clearance <clearance-file> --answers <file>  OWNER ONLY: apply the exception queue's answers (P-60)
 *   apply-decisions <file>                         OWNER ONLY: apply exported workspace decisions (docs/REVIEW_WORKSPACE.md)
 *   gov-index [--out dir]                          importer index (entities.json, bodies.json) from research/
 *   gov-accept <proposed-agreements.json> <id…>    copy selected import proposals into research/ (still proposed)
 *   retract <id…> --reason "…"                     OWNER ONLY: takedown/correction, logged in research/takedowns.yaml
 *   backup --to <folder> [--encrypt] [--exclude prefix]  verified private backup; exclusions repeatable (D-15)
 *   backup-verify --from <folder>                  check stored hashes; decrypt too when passphrase is set
 *   restore --from <folder> --to <dir>             verified restore into an empty or missing directory
 *   check-links [sourceId…]                        update availability (robots-aware, polite, no content stored)
 *
 * Common options: --dir <research dir> (default research), --cache <dir> (default research-cache).
 * Authorship: --by, or the CANDEF_AUTHOR environment variable.
 * Encryption: CANDEF_BACKUP_PASSPHRASE only (at least 16 characters); never a CLI option.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { compile } from "../compile/compile";
import { ZodError } from "zod";
import { AuthoringError, addSource, appendLedger, localDate, newOrg } from "../research/authoring";
import { backupCache } from "../research/backup";
import { captureSource, fingerprintSource, registerLocalCapture } from "../research/capture";
import { researchBuildGates } from "../research/gates";
import { checkLinks } from "../research/links";
import { citationCoverage, formatCoverage } from "../research/coverage";
import { loadResearchCorpus, loadResearchCorpusUncached } from "../research/load";
import { proposedRecordCount } from "../research/counts";
import { acceptGovProposals, buildGovIndex } from "../research/govImport";
import {
  applyDecisions,
  planDecisions,
  readDecisionsFile,
  readTierDecisionsFile,
} from "../research/decisions";
import { buildReviewReport } from "../research/report";
import { buildWorkspace } from "../research/workspace";
import type { BlindCard } from "../research/blind";
import { runTiers, tiersMarkdown, type TiersFile } from "../research/tiers/run";
import { applyTierPlan, planTierApply } from "../research/tiers/apply";
import { planClearanceApply, readAnswersFile } from "../research/clearance/apply";
import { runClearance, type ClearanceFile } from "../research/clearance/run";
import { formatStatus, pilotStatus } from "../research/status";
import { approvableIds, reviewRecords } from "../research/review";
import { readTakedowns, retractRecords, takedownFailures } from "../research/takedown";

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith("--")) flags.set(a.slice(2), argv[++i] ?? "");
  else positional.push(a);
}
const flag = (name: string) => flags.get(name);
/** `--companies <cards.json>`: the organization slugs of a blind-verification cards file. */
const scopeFlag = (path: string | undefined): string[] | undefined =>
  path
    ? (JSON.parse(readFileSync(resolve(path), "utf8")) as { orgSlugs: string[] }[]).flatMap(
        (c) => c.orgSlugs,
      )
    : undefined;
const dir = resolve(flag("dir") ?? "research");
const cache = resolve(flag("cache") ?? "research-cache");
const today = localDate();
const author = () => {
  const by = flag("by") ?? process.env.CANDEF_AUTHOR;
  if (!by) throw new AuthoringError("say who is writing: --by <name> or CANDEF_AUTHOR");
  return by;
};
const need = (name: string) => {
  const v = flag(name);
  if (!v) throw new AuthoringError(`--${name} is required`);
  return v;
};

async function main(): Promise<number> {
  const [cmd, ...rest] = positional;
  switch (cmd) {
    case "new": {
      const [kind, name] = rest;
      if (!kind || !name) throw new AuthoringError("usage: new <kind> <name>");
      const r = newOrg(dir, { kind, name, slug: flag("slug"), by: author() });
      console.log(`created ${r.id} → ${r.file}`);
      return 0;
    }
    case "source": {
      if (rest[0] !== "add" || !rest[1]) throw new AuthoringError("usage: source add <url> …");
      const r = addSource(dir, {
        url: rest[1],
        kind: need("kind"),
        tier: need("tier"),
        publisher: need("publisher"),
        title: need("title"),
        publishedOn: flag("published") ?? null,
      });
      console.log(
        `created ${r.id} → ${r.file}\npermissions are "unknown" (= denied) until you record them from the site's terms`,
      );
      return 0;
    }
    case "capture": {
      if (!rest[0])
        throw new AuthoringError("usage: capture <sourceId> [--file <path> --method m]");
      const file = flag("file");
      const method = flag("method");
      if (file && method !== "browser" && method !== "manual")
        throw new AuthoringError("--method browser|manual is required with --file");
      const c = file
        ? await registerLocalCapture(dir, rest[0], file, {
            cacheDir: cache,
            method: method as "browser" | "manual",
            textFile: flag("text"),
            retrievedAt: flag("retrieved"),
          })
        : await captureSource(dir, rest[0], { cacheDir: cache });
      console.log(
        `captured ${c.id}: HTTP ${c.httpStatus}, ${c.path} (sha256 ${c.rawSha256.slice(0, 12)}…)`,
      );
      return 0;
    }
    case "fingerprint": {
      if (!rest[0]) throw new AuthoringError("usage: fingerprint <sourceId>");
      const f = await fingerprintSource(dir, rest[0], {});
      console.log(
        `fingerprinted ${f.id}: HTTP ${f.httpStatus} (text sha256 ${f.textSha256?.slice(0, 12) ?? "n/a"}…); no bytes kept`,
      );
      return 0;
    }
    case "ledger": {
      const [slug, topic, outcome] = rest;
      if (!slug || !topic || !outcome)
        throw new AuthoringError("usage: ledger <slug> <topic> <outcome>");
      appendLedger(dir, slug, {
        topic,
        outcome,
        sourcesSearched: need("searched")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean),
        by: author(),
        at: flag("at"),
        nextReview: flag("next") ?? null,
      });
      console.log(`ledger entry added to orgs/${slug}.yaml`);
      return 0;
    }
    case "validate": {
      const loaded = loadResearchCorpus(dir);
      for (const i of loaded.issues) console.error(`${i.file}:${i.path}: ${i.message}`);
      if (!loaded.corpus) return 1;
      const gates = [
        ...researchBuildGates(loaded.corpus),
        ...takedownFailures(loaded.corpus, readTakedowns(dir)),
      ];
      const result = compile(loaded.corpus, { today });
      for (const f of [...gates, ...result.failures])
        console.error(`GATE [${f.gate}] ${f.message}: ${f.ids.join(", ")}`);
      for (const q of result.quality)
        console.warn(`quality [${q.check}] ${q.message}: ${q.ids.join(", ")}`);
      const c = loaded.corpus;
      const proposed = proposedRecordCount(c);
      // CI runs `prettier --check .`; report the same here so it is caught before a commit.
      // Loaded here only: Prettier is slow to import and no other command needs it.
      const { unformattedFiles } = await import("../research/format");
      const unformatted = await unformattedFiles(dir);
      for (const f of unformatted)
        console.error(
          `FORMAT ${f}: not Prettier-formatted (run: npx prettier --write ${relative(process.cwd(), dir) || "."})`,
        );
      const cites = citationCoverage(c);
      for (const p of cites.problems.slice(0, 20))
        console.error(`CITATION [${p.kind}] ${p.claim}: ${p.problem}`);
      console.log(
        `${loaded.files} files · ${c.organizations.length} organizations · ${proposed} proposed records · ${result.snapshot?.coverage.inUniverse ?? 0} companies would be published · ${cites.cited}/${cites.total} claims cited`,
      );
      return gates.length || !result.ok || unformatted.length || cites.problems.length ? 1 : 0;
    }
    case "coverage": {
      const loaded = loadResearchCorpus(dir);
      for (const i of loaded.issues) console.error(`${i.file}:${i.path}: ${i.message}`);
      if (!loaded.corpus) return 1;
      const cites = citationCoverage(loaded.corpus);
      console.log(formatCoverage(cites));
      return cites.problems.length ? 1 : 0;
    }
    case "status": {
      const loaded = loadResearchCorpus(dir);
      if (!loaded.corpus)
        throw new AuthoringError("research/ does not validate; run `candef validate`");
      const rows = pilotStatus(loaded.corpus, today);
      console.log(rows.length ? formatStatus(rows) : "no companies in research/ yet");
      return 0;
    }
    case "report": {
      const out = resolve(flag("out") ?? join(cache, "reports", `review-${today}.html`));
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, buildReviewReport(dir, { today, cacheDir: cache }));
      console.log(`review report → ${out}`);
      return 0;
    }
    case "workspace": {
      const out = resolve(flag("out") ?? join(cache, "review", `workspace-${today}.html`));
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, buildWorkspace(dir, { today, cacheDir: cache }));
      console.log(`review workspace → ${out}`);
      console.log(
        "Open it in a browser, export decisions, then run apply-decisions in your own terminal.",
      );
      return 0;
    }
    case "tiers": {
      // Read-only on research/ (VERIFICATION_TIERS.md section 6): agents may run it.
      const loaded = loadResearchCorpus(dir);
      if (!loaded.corpus)
        throw new AuthoringError("research/ does not validate; run `candef validate`");
      const cardsFile = resolve(flag("cards") ?? "docs/verification/blind-v2-internal/cards.json");
      const cards = existsSync(cardsFile)
        ? (JSON.parse(readFileSync(cardsFile, "utf8")) as BlindCard[])
        : [];
      const file = await runTiers(loaded.corpus, {
        cacheDir: cache,
        today,
        cards,
        skipGovRows: flags.has("skip-gov-rows"),
        planFile: flag("plan"),
        scope: scopeFlag(flag("companies")),
      });
      const outDir = join(cache, "tiers");
      mkdirSync(outDir, { recursive: true });
      const base = join(outDir, `tiers-${today}`);
      writeFileSync(`${base}.json`, JSON.stringify(file, null, 2));
      const orgName = new Map(loaded.corpus.organizations.map((o) => [o.id, o.name]));
      writeFileSync(
        `${base}.md`,
        tiersMarkdown(file, (id) => orgName.get(id) ?? id),
      );
      const ws = join(outDir, `workspace-${today}.html`);
      writeFileSync(ws, buildWorkspace(dir, { today, cacheDir: cache, tiers: file }));
      console.log(`tiers → ${base}.json (.md); workspace → ${ws}`);
      console.log(`batch ${file.batch}`);
      for (const [k, v] of Object.entries(file.counts)) console.log(`  ${k}: ${v}`);
      console.log(`audit sample: ${file.audit.length}`);
      return 0;
    }
    case "apply-decisions": {
      // Owner only, like review: an agent's shell has no interactive terminal, so this refuses
      // before reading anything.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          "candef apply-decisions is owner-only and needs an interactive terminal. Agents never approve or reject records.",
        );
        return 2;
      }
      const path = rest[0];
      if (!path) throw new AuthoringError("usage: apply-decisions <decisions file>");
      const file = readDecisionsFile(resolve(path));
      const loaded = loadResearchCorpus(dir);
      if (!loaded.corpus)
        throw new AuthoringError("research/ does not validate; run `candef validate`");
      const plan = planDecisions(loaded.corpus, file, today);
      const list = (label: string, ds: { id: string }[]) =>
        ds.length && console.log(`  ${label}: ${ds.length} (${ds.map((d) => d.id).join(", ")})`);
      console.log(
        `Decisions exported ${file.exportedAt} from workspace ${file.workspace.generatedAt}:`,
      );
      console.log(`  approve: ${plan.approve.length}`);
      console.log(`  reject: ${plan.reject.length}`);
      list("approve, but no source was opened in the workspace", plan.unopened);
      list("SKIPPED, record changed since the workspace was made (decide again)", plan.stale);
      list("SKIPPED, approval refused (fails its evidence rule)", plan.refused);
      list("SKIPPED, no longer proposed", plan.notProposed);
      list("SKIPPED, unknown record", plan.unknown);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const reviewer = (await rl.question("Your reviewer name (as you sign approvals): ")).trim();
      let includeUnopened = false;
      if (plan.unopened.length)
        includeUnopened =
          (
            await rl.question(
              `${plan.unopened.length} approval(s) were marked without opening a source. Type "checked" if you verified them another way; anything else leaves them proposed: `,
            )
          ).trim() === "checked";
      const total =
        plan.approve.length + (includeUnopened ? plan.unopened.length : 0) + plan.reject.length;
      const confirm = await rl.question(
        `Apply ${total} decision(s) as "${reviewer}"? This writes review blocks into research/. Type "apply": `,
      );
      rl.close();
      if (confirm.trim() !== "apply") {
        console.log("nothing applied");
        return 1;
      }
      const { approved, rejected } = applyDecisions(dir, file, {
        reviewer,
        at: today,
        includeUnopened,
      });
      console.log(`approved ${approved.length} record(s); rejected ${rejected.length}.`);
      console.log("Commit the changed research files yourself, as your own commit.");
      return 0;
    }
    case "apply-tiers": {
      // Owner only (VERIFICATION_TIERS.md section 6). An agent's shell has no interactive terminal,
      // so this refuses before reading anything.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          "candef apply-tiers is owner-only and needs an interactive terminal. Agents never approve or reject records.",
        );
        return 2;
      }
      const tiersPath = rest[0];
      const decisionsPath = flag("decisions");
      if (!tiersPath || !decisionsPath)
        throw new AuthoringError("usage: apply-tiers <tiers file> --decisions <file>");
      const tiers = JSON.parse(readFileSync(resolve(tiersPath), "utf8")) as TiersFile;
      if (tiers.format !== "candef-tiers") throw new AuthoringError("not a tiers file");
      const file = readTierDecisionsFile(resolve(decisionsPath));
      const loaded = loadResearchCorpusUncached(dir);
      if (!loaded.corpus)
        throw new AuthoringError("research/ does not validate; run `candef validate`");
      console.log("Re-running every rule (this reads the dataset captures; it can take minutes)…");
      const cardsFile = resolve(flag("cards") ?? "docs/verification/blind-v2-internal/cards.json");
      const fresh = await runTiers(loaded.corpus, {
        cacheDir: cache,
        today: tiers.today,
        cards: existsSync(cardsFile)
          ? (JSON.parse(readFileSync(cardsFile, "utf8")) as BlindCard[])
          : [],
        skipGovRows: !tiers.inputs.govRowsLoaded,
        planFile: tiers.inputs.plan?.file,
        scope: tiers.scope?.orgSlugs,
      });
      const plan = planTierApply(tiers, fresh, file);
      console.log(`Tiers batch ${tiers.batch.slice(0, 12)} (${tiers.rules}), audit confirmed:`);
      console.log(`  approved by the batch (tiers 1 and 2): ${plan.batch.length}`);
      console.log(`  your approvals (tier 3 and exceptions): ${plan.approve.length}`);
      console.log(`  your rejections: ${plan.reject.length}`);
      if (plan.waiting.length)
        console.log(`  left proposed, anchor not approved: ${plan.waiting.length}`);
      for (const s of plan.skipped) console.log(`  SKIPPED ${s.id}: ${s.why}`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const reviewer = (await rl.question("Your reviewer name (as you sign approvals): ")).trim();
      const total = plan.batch.length + plan.approve.length + plan.reject.length;
      const confirm = await rl.question(
        `Apply ${total} decision(s) as "${reviewer}"? This writes review blocks into research/. Type "apply": `,
      );
      rl.close();
      if (confirm.trim() !== "apply") {
        console.log("nothing applied");
        return 1;
      }
      const { approved, rejected } = applyTierPlan(dir, plan, { reviewer, at: today });
      console.log(`approved ${approved.length} record(s); rejected ${rejected.length}.`);
      console.log("Commit the changed research files yourself, as your own commit.");
      return 0;
    }
    case "apply-clearance": {
      // Owner only (P-60, docs/VERIFICATION_CLEARANCE.md). Refuses before reading anything when
      // there is no interactive terminal: agents never approve or reject records.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          "candef apply-clearance is owner-only and needs an interactive terminal. Agents never approve or reject records.",
        );
        return 2;
      }
      const clearancePath = rest[0];
      const answersPath = flag("answers");
      if (!clearancePath || !answersPath)
        throw new AuthoringError("usage: apply-clearance <clearance file> --answers <file>");
      const file = JSON.parse(readFileSync(resolve(clearancePath), "utf8")) as ClearanceFile;
      if (file.format !== "candef-clearance") throw new AuthoringError("not a clearance file");
      const answers = readAnswersFile(resolve(answersPath));
      const loaded = loadResearchCorpusUncached(dir);
      if (!loaded.corpus)
        throw new AuthoringError("research/ does not validate; run `candef validate`");
      if (!file.run.cardsFile || !existsSync(file.run.cardsFile))
        throw new AuthoringError("the clearance file does not name its cards file; run it again");
      console.log("Re-running the clearance (this reads the dataset captures; about 4 minutes)…");
      const fresh = await runClearance(loaded.corpus, {
        ...file.run,
        cardsFile: file.run.cardsFile,
        today: file.today,
        cards: JSON.parse(readFileSync(file.run.cardsFile, "utf8")) as BlindCard[],
      });
      const plan = planClearanceApply(file, fresh, answers);
      console.log(`Clearance batch ${file.batch.slice(0, 12)} (${file.policy}), audit answered:`);
      console.log(`  cleared by the policy, approved with the batch: ${plan.batch.length}`);
      console.log(`  your approvals (accepted recommendations): ${plan.approve.length}`);
      console.log(`  your rejections: ${plan.reject.length}`);
      if (plan.waiting.length)
        console.log(`  left proposed, identity not confirmed: ${plan.waiting.length}`);
      if (plan.held.length)
        console.log(
          `  HELD, an audit record of their class was wrong: ${plan.held.length} (${[...new Set(plan.held.map((h) => h.cls))].join(", ")})`,
        );
      for (const o of plan.open) console.log(`  left proposed (${o.choice}): ${o.key}`);
      for (const u of plan.unanswered) console.log(`  left proposed (no answer): ${u}`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const reviewer = (await rl.question("Your reviewer name (as you sign approvals): ")).trim();
      const total = plan.batch.length + plan.approve.length + plan.reject.length;
      const confirm = await rl.question(
        `Apply ${total} decision(s) as "${reviewer}"? This writes review blocks into research/. Type "apply": `,
      );
      rl.close();
      if (confirm.trim() !== "apply") {
        console.log("nothing applied");
        return 1;
      }
      const { approved, rejected } = applyTierPlan(dir, plan, { reviewer, at: today });
      console.log(`approved ${approved.length} record(s); rejected ${rejected.length}.`);
      console.log("Commit the changed research files yourself, as your own commit.");
      return 0;
    }
    case "review": {
      // Owner only. An agent's shell has no interactive terminal, so this refuses before reading anything.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(
          "candef review is owner-only and needs an interactive terminal. Agents never approve records.",
        );
        return 2;
      }
      let ids = rest;
      const orgSlug = flag("org");
      if (orgSlug) {
        const loaded = loadResearchCorpus(dir);
        if (!loaded.corpus)
          throw new AuthoringError("research/ does not validate; run `candef validate`");
        const org = loaded.corpus.organizations.find((o) => o.slug === orgSlug);
        if (!org) throw new AuthoringError(`no organization with slug ${orgSlug}`);
        ids = approvableIds(loaded.corpus, org.id, today);
        console.log(`${org.name}: ${ids.length} approvable record(s): ${ids.join(", ")}`);
      }
      if (!ids.length) throw new AuthoringError("usage: review <id…> | review --org <slug>");
      const selected = ids;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const reviewer = (await rl.question("Your reviewer name (as you sign approvals): ")).trim();
      const confirm = await rl.question(
        `Approve ${selected.length} record(s) as "${reviewer}" after checking each against its source? Type "approve": `,
      );
      rl.close();
      if (confirm.trim() !== "approve") {
        console.log("nothing approved");
        return 1;
      }
      const { reviewed } = reviewRecords(dir, { ids: selected, reviewer, at: today });
      console.log(`approved ${reviewed.length} record(s): ${reviewed.join(", ")}`);
      return 0;
    }
    case "retract": {
      // Owner only, like review: retracting changes what the public sees.
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("candef retract is owner-only and needs an interactive terminal.");
        return 2;
      }
      if (!rest.length) throw new AuthoringError('usage: retract <id…> --reason "…"');
      const reason = need("reason");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const by = (await rl.question("Your name (as you sign approvals): ")).trim();
      const confirm = await rl.question(
        `Retract ${rest.length} record(s) and log the takedown? Type "retract": `,
      );
      rl.close();
      if (confirm.trim() !== "retract") {
        console.log("nothing retracted");
        return 1;
      }
      const { retracted } = retractRecords(dir, { ids: rest, by, at: today, reason });
      console.log(
        `retracted ${retracted.length}; logged in research/takedowns.yaml. Rebuild and publish to take effect.`,
      );
      return 0;
    }
    case "backup":
    case "restore":
    case "backup-verify": {
      // Local parsing preserves the other commands' parser and supports boolean/repeated options.
      const options = new Map<string, string>();
      const exclude: string[] = [];
      let encrypt = false;
      const allowed =
        cmd === "backup"
          ? ["--to", "--cache", "--exclude"]
          : cmd === "restore"
            ? ["--from", "--to"]
            : ["--from"];
      for (let i = 1; i < argv.length; i++) {
        const option = argv[i]!;
        if (cmd === "backup" && option === "--encrypt") {
          encrypt = true;
          continue;
        }
        if (!allowed.includes(option))
          throw new AuthoringError("unsupported backup/restore option; see pipeline/cli/candef.ts");
        const value = argv[++i];
        if (!value || value.startsWith("--"))
          throw new AuthoringError(`${option} requires a value`);
        if (option === "--exclude") exclude.push(value);
        else options.set(option.slice(2), value);
      }
      const required = (name: string) => {
        const value = options.get(name);
        if (!value) throw new AuthoringError(`--${name} is required`);
        return value;
      };
      if (cmd === "backup-verify") {
        const { verifyBackup } = await import("../research/backup");
        const r = await verifyBackup(required("from"));
        console.log(JSON.stringify(r));
        return r.ok ? 0 : 1;
      }
      if (cmd === "restore") {
        const { restoreCache } = await import("../research/backup");
        const r = await restoreCache(required("from"), required("to"), process.cwd());
        console.log(JSON.stringify(r));
        return r.failed.length ? 1 : 0;
      }
      const r = await backupCache(
        resolve(options.get("cache") ?? "research-cache"),
        required("to"),
        process.cwd(),
        { encrypt, exclude },
      );
      console.log(
        `${r.files} files: ${r.copied} copied (verified), ${r.unchanged} unchanged, ${r.excluded} excluded${r.previous.length ? `, previous encrypted files kept: ${r.previous.join(", ")}` : ""}${r.conflicts.length ? `, ${r.conflicts.length} CONFLICTS kept side by side: ${r.conflicts.join(", ")}` : ""}`,
      );
      return r.conflicts.length ? 1 : 0;
    }
    case "check-links": {
      const results = await checkLinks(dir, { ids: rest.length ? rest : undefined });
      for (const r of results)
        console.log(`${r.availability.padEnd(11)} ${r.sourceId} ${r.detail}`);
      return 0;
    }
    case "gov-index": {
      const loaded = loadResearchCorpus(dir);
      if (!loaded.corpus)
        throw new AuthoringError("research/ does not validate; run `candef validate`");
      const out = resolve(flag("out") ?? join(cache, "imports", `index-${today}`));
      mkdirSync(out, { recursive: true });
      const { entities, bodies } = buildGovIndex(loaded.corpus);
      writeFileSync(join(out, "entities.json"), JSON.stringify(entities, null, 2));
      writeFileSync(join(out, "bodies.json"), JSON.stringify(bodies, null, 2));
      console.log(
        `${entities.length} companies, ${Object.keys(bodies).length} department keys → ${out}`,
      );
      return 0;
    }
    case "gov-accept": {
      const [file, ...ids] = rest;
      if (!file || !ids.length)
        throw new AuthoringError("usage: gov-accept <proposed-agreements.json> <id…>");
      const { accepted } = acceptGovProposals(dir, resolve(file), ids);
      console.log(`added ${accepted.length} proposed agreement(s); they await owner review`);
      return 0;
    }
    default:
      console.log(
        "commands: new, source add, capture, fingerprint, ledger, validate, status, report, workspace, review (owner only), apply-decisions (owner only), tiers, apply-tiers (owner only), gov-index, gov-accept, check-links, backup, retract (owner only). See pipeline/cli/candef.ts.",
      );
      return cmd ? 1 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    if (e instanceof ZodError)
      for (const i of e.issues)
        console.error(`candef: ${i.path.join(".") || "input"}: ${i.message}`);
    else console.error(e instanceof AuthoringError ? `candef: ${e.message}` : e);
    process.exit(1);
  },
);
