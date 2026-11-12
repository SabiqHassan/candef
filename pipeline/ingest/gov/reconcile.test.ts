import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as outputWriter from "./output";
import { runReconcile } from "./reconcile-cli";
import { groupContracts } from "./group";
import { toContractRow } from "./tbs";
import {
  createMigrationBundle,
  applyMigrationBundle,
  changedProtectedRecords,
  defaultsChanged,
  protectedRecords,
} from "./reconcile";
import * as loadModule from "../../research/load";
import { acceptGovProposals } from "../../research/govImport";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "candef-fictional-migration-"));
  roots.push(root);
  const research = join(root, "research"),
    imported = join(root, "research-cache", "import"),
    output = join(root, "research-cache", "plan");
  await mkdir(join(research, "orgs"), { recursive: true });
  await mkdir(join(research, "sources"));
  await mkdir(imported, { recursive: true });
  const match = {
    status: "confirmed" as const,
    orgId: "org_fictional",
    candidates: ["org_fictional"],
    method: "name+postal",
  };
  const grouped = groupContracts(
    [
      {
        row: toContractRow({
          owner_org: "fictional",
          owner_org_title: "Fictional Buyer",
          procurement_id: "fictional-p",
          reference_number: "fictional-batch",
          vendor_name: "Fictional Orbit",
          contract_value: "100",
          instrument_type: "C",
          reporting_period: "2025-2026-Q1",
        }),
        match,
      },
    ],
    { bodies: { fictional: "org_fictional_buyer" }, sourceId: "src_fictional", date: "2026-10-14" },
  );
  await writeFile(join(imported, "all-agreements.json"), JSON.stringify(grouped.agreements));
  await writeFile(join(imported, "proposed-agreements.json"), JSON.stringify(grouped.agreements));
  await writeFile(
    join(imported, "linkage.json"),
    JSON.stringify({ version: 1, identities: grouped.identities, decisions: [], warnings: [] }),
  );
  await writeFile(
    join(research, "sources", "src_fictional.yaml"),
    JSON.stringify({
      kind: "gov_dataset",
      tier: "T1",
      publisher: "Fictional Treasury",
      title: "Fictional dataset",
      url: "https://example.invalid/fictional",
      publishedOn: null,
      retrievedAt: "2026-10-14",
      originGroup: "fictional",
      textSha256: null,
    }),
  );
  for (const [slug, id, kind] of [
    ["orbit", "org_fictional", "company"],
    ["buyer", "org_fictional_buyer", "government_body"],
  ])
    await writeFile(
      join(research, "orgs", `${slug}.yaml`),
      JSON.stringify({
        org: { id, slug, kind, name: `Fictional ${slug}` },
        defaults: { createdBy: "test:fictional" },
        agreements: [],
      }),
    );
  return { root, research, imported, output, agreement: grouped.agreements[0]! };
}
const { loadResearchCorpus } = loadModule;
/** Adds a reviewed, unrelated agreement to the recipient's file (the owner approved it earlier). */
async function withReviewedNeighbour(f: Awaited<ReturnType<typeof fixture>>) {
  const file = join(f.research, "orgs", "orbit.yaml");
  const doc = JSON.parse(await readFile(file, "utf8"));
  doc.agreements = [
    {
      ...f.agreement,
      id: "agr_fictional_unrelated",
      externalIds: [],
      evidence: [],
      review: { by: "fictional owner", at: "2026-01-01", hash: "sentinel" },
    },
  ];
  await writeFile(file, JSON.stringify(doc));
  return file;
}
describe("migration filesystem boundary", () => {
  it("refuses a linked history directory before writing research data", async () => {
    const f = await fixture();
    const file = join(f.research, "orgs", "orbit.yaml");
    const before = await readFile(file, "utf8");
    const bundle = await createMigrationBundle(f.research, f.imported);
    await mkdir(f.output, { recursive: true });
    await symlink(
      f.research,
      join(f.output, "history"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(applyMigrationBundle(bundle, bundle.hash, f.output)).rejects.toThrow(
      /research|linked/i,
    );
    expect(await readFile(file, "utf8")).toBe(before);
  });
  it("writes a reviewable CLI dry run and requires explicit apply plus its hash", async () => {
    const f = await fixture();
    const b = await runReconcile([
      "--research",
      f.research,
      "--imported",
      f.imported,
      "--out",
      f.output,
    ]);
    expect(await readFile(join(f.output, "migration.md"), "utf8")).toContain(b.hash);
    expect(JSON.parse(await readFile(join(f.output, "migration.json"), "utf8")).hash).toBe(b.hash);
    await expect(runReconcile(["--apply", "--out", f.output])).rejects.toThrow(/expect-hash/);
    expect((await createMigrationBundle(f.research, f.imported)).hash).toBe(b.hash);
  });
  it("rolls back earlier files when a later write fails and keeps immutable history", async () => {
    const f = await fixture();
    const file = join(f.research, "orgs", "orbit.yaml");
    const before = await readFile(file, "utf8");
    const bundle = await createMigrationBundle(f.research, f.imported);
    const actual = outputWriter.writeReviewOutputs;
    let calls = 0;
    vi.spyOn(outputWriter, "writeReviewOutputs").mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("Fictional disk failure");
      return actual(...args);
    });
    await expect(applyMigrationBundle(bundle, bundle.hash, f.output)).rejects.toThrow(
      /disk failure/,
    );
    expect(await readFile(file, "utf8")).toBe(before);
    expect(
      await readFile(join(f.output, "history", bundle.hash, "orgs", "orbit.yaml"), "utf8"),
    ).toBe(before);
    await expect(readFile(join(f.research, ".gov-linkage.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(applyMigrationBundle(bundle, bundle.hash, f.output)).rejects.toThrow();
  });
  it("refuses changed import files, dangling aliases and concurrent migration locks", async () => {
    const f = await fixture();
    const bundle = await createMigrationBundle(f.research, f.imported);
    const file = join(f.imported, "all-agreements.json");
    const before = await readFile(file, "utf8");
    await writeFile(file, before + "\n");
    await expect(applyMigrationBundle(bundle, bundle.hash, f.output)).rejects.toThrow(/stale/i);
    await writeFile(file, before);
    await writeFile(join(f.research, ".gov-linkage.lock"), "fictional concurrent operation");
    await expect(applyMigrationBundle(bundle, bundle.hash, f.output)).rejects.toThrow();
    await rm(join(f.research, ".gov-linkage.lock"));
    await writeFile(
      join(f.research, "_gov-linkage-aliases.json"),
      JSON.stringify({
        version: 1,
        aliases: [
          {
            from: "agr_fictional_missing",
            to: ["agr_fictional_absent"],
            reason: "fictional dangling alias",
          },
        ],
      }),
    );
    const dangling = await createMigrationBundle(f.research, f.imported);
    await expect(applyMigrationBundle(dangling, dangling.hash, f.output)).rejects.toThrow(
      /dangling/i,
    );
  });
  it("refuses re-accepting a superseded alias or an existing scoped identity", async () => {
    const f = await fixture();
    const proposals = join(f.imported, "proposed-agreements.json");
    acceptGovProposals(f.research, proposals, [f.agreement.id]);
    const renamed = { ...f.agreement, id: "agr_fictional_superseded" };
    await writeFile(proposals, JSON.stringify([renamed]));
    expect(() => acceptGovProposals(f.research, proposals, [renamed.id])).toThrow(
      /already in research/,
    );
    await writeFile(
      join(f.research, "_gov-linkage-aliases.json"),
      JSON.stringify({
        version: 1,
        aliases: [{ from: renamed.id, to: [f.agreement.id], reason: "fictional prior migration" }],
      }),
    );
    await writeFile(proposals, JSON.stringify([{ ...renamed, externalIds: [] }]));
    expect(() => acceptGovProposals(f.research, proposals, [renamed.id])).toThrow(
      /already in research/,
    );
  });
  it("refuses duplicate selections before writing", async () => {
    const f = await fixture();
    expect(() =>
      acceptGovProposals(f.research, join(f.imported, "proposed-agreements.json"), [
        f.agreement.id,
        f.agreement.id,
      ]),
    ).toThrow(/duplicate/i);
    expect((await createMigrationBundle(f.research, f.imported)).plan.changes[0]?.action).toBe(
      "new",
    );
  });
  it("dry run is read-only; explicit apply keeps history and is idempotent", async () => {
    const f = await fixture();
    const file = join(f.research, "orgs", "orbit.yaml");
    const before = await readFile(file, "utf8");
    const bundle = await createMigrationBundle(f.research, f.imported);
    expect(await readFile(file, "utf8")).toBe(before);
    await applyMigrationBundle(bundle, bundle.hash, f.output);
    expect(
      await readFile(join(f.output, "history", bundle.hash, "orgs", "orbit.yaml"), "utf8"),
    ).toBe(before);
    const after = await readFile(file, "utf8");
    const again = await createMigrationBundle(f.research, f.imported);
    expect(again.plan.changes[0]?.action).toBe("unchanged");
    await applyMigrationBundle(again, again.hash, f.output);
    expect(await readFile(file, "utf8")).toBe(after);
    expect(() =>
      acceptGovProposals(f.research, join(f.imported, "proposed-agreements.json"), [
        f.agreement.id,
      ]),
    ).toThrow(/already in research/);
  });
  it("refuses stale files, wrong hashes, and output inside research without any write", async () => {
    const f = await fixture();
    const bundle = await createMigrationBundle(f.research, f.imported);
    await expect(applyMigrationBundle(bundle, "wrong", f.output)).rejects.toThrow(/hash/);
    await expect(
      applyMigrationBundle(bundle, bundle.hash, join(f.research, "plan")),
    ).rejects.toThrow(/research/);
    const file = join(f.research, "orgs", "orbit.yaml");
    await writeFile(file, (await readFile(file, "utf8")) + "\n");
    await expect(applyMigrationBundle(bundle, bundle.hash, f.output)).rejects.toThrow(/stale/i);
  });
  it("applies beside an unrelated reviewed record and leaves that record exactly as it was", async () => {
    const f = await fixture();
    const file = await withReviewedNeighbour(f);
    const before = loadResearchCorpus(f.research).corpus!;
    const bundle = await createMigrationBundle(f.research, f.imported);
    await applyMigrationBundle(bundle, bundle.hash, f.output);
    const after = loadResearchCorpus(f.research).corpus!;
    expect(after.agreements.map((a) => a.id).sort()).toEqual(
      [f.agreement.id, "agr_fictional_unrelated"].sort(),
    );
    expect(changedProtectedRecords(before, after)).toEqual([]);
    expect(await readFile(file, "utf8")).toContain(f.agreement.id);
  });
  it("rolls the whole apply back if a reviewed record would change", async () => {
    const f = await fixture();
    const file = await withReviewedNeighbour(f);
    const original = await readFile(file, "utf8");
    const actual = loadModule.loadResearchCorpus;
    vi.spyOn(loadModule, "loadResearchCorpus").mockImplementation((root, options) => {
      const result = actual(root, options);
      // Simulate a write that altered the reviewed neighbour (e.g. a serialisation change).
      if (result.corpus && readFileSync(file, "utf8").includes(f.agreement.id))
        result.corpus.agreements.find((a) => a.id === "agr_fictional_unrelated")!.title =
          "Fictional altered title";
      return result;
    });
    const bundle = await createMigrationBundle(f.research, f.imported);
    await expect(applyMigrationBundle(bundle, bundle.hash, f.output)).rejects.toThrow(
      /reviewed records: agreement:agr_fictional_unrelated/,
    );
    expect(await readFile(file, "utf8")).toBe(original);
    await expect(readFile(join(f.research, ".gov-linkage.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("reviewed-record guard helpers", () => {
  const corpus = (agreements: Record<string, unknown>[]) =>
    ({ assertions: [], rounds: [], acquisitions: [], agreements }) as unknown as Parameters<
      typeof protectedRecords
    >[0];
  it("protects reviewed or non-proposed records and reports any change or removal", () => {
    const reviewed = { id: "agr_a", review: { by: "owner" }, verification: "verified", title: "A" };
    const plain = { id: "agr_b", review: null, verification: "proposed", title: "B" };
    expect([...protectedRecords(corpus([reviewed, plain])).keys()]).toEqual(["agreement:agr_a"]);
    const before = corpus([reviewed, plain]);
    expect(changedProtectedRecords(before, corpus([reviewed, { ...plain, title: "B2" }]))).toEqual(
      [],
    );
    expect(changedProtectedRecords(before, corpus([{ ...reviewed, title: "A2" }, plain]))).toEqual([
      "agreement:agr_a",
    ]);
    expect(changedProtectedRecords(before, corpus([plain]))).toEqual(["agreement:agr_a"]);
  });
  it("detects a changed defaults block, not reformatting", () => {
    const text = ['defaults: { createdBy: "agent:test" }', "agreements: []", ""].join("\n");
    const reformatted = ["defaults:", '  createdBy: "agent:test"', "agreements: [x]", ""].join(
      "\n",
    );
    expect(defaultsChanged(text, reformatted)).toBe(false);
    expect(defaultsChanged(text, 'defaults: { createdBy: "agent:other" }')).toBe(true);
  });
});
