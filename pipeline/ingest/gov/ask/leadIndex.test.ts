// Fictional companies only. No network, no key. The spot-check acceptance test reads local files
// under research-cache/ and is skipped when they are absent.
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import {
  assignTier,
  buildIndex,
  buildLeadRow,
  isStrongCategory,
  mediumGroup,
  type TriageInfo,
} from "./leadIndex";
import type { CompanyProfile, ProfileLine } from "./profiles";
import { TAG_IDS, defenceTextMatch, tagLines } from "./tags";

const line = (o: Partial<ProfileLine>): ProfileLine => ({
  kind: "contract",
  date: "2024-05-01",
  department: "National Defence",
  ownerOrg: "dnd-mdn",
  programme: "",
  title: "",
  description: "Office furniture and furnishings, including parts",
  value: 10_000,
  ref: "C-1",
  ...o,
});

const profile = (lines: ProfileLine[], o: Partial<CompanyProfile> = {}): CompanyProfile => {
  const contracts = lines.filter((l) => l.kind === "contract");
  const grants = lines.filter((l) => l.kind === "grant");
  return {
    key: "n:ACME|",
    name: "Acme Fictional Ltd.",
    otherNames: [],
    businessNumber: null,
    cities: [],
    provinces: [],
    areas: [],
    grantCount: grants.length,
    contractCount: contracts.length,
    grantValue: grants.reduce((s, l) => s + l.value, 0),
    contractValue: contracts.reduce((s, l) => s + l.value, 0),
    dndContractValue: contracts
      .filter((l) => l.ownerOrg === "dnd-mdn")
      .reduce((s, l) => s + l.value, 0),
    firstDate: lines.map((l) => l.date).sort()[0] ?? null,
    lastDate:
      lines
        .map((l) => l.date)
        .sort()
        .at(-1) ?? null,
    lines,
    ...o,
  };
};

const judge = (verdict: TriageInfo["verdict"]): TriageInfo => ({
  verdict,
  reason: "r",
  judge: "manual",
  status: verdict === "no" ? "out" : "in",
});
const rules = (p: CompanyProfile, t: TriageInfo | null = judge("no"), known?: Set<string>) =>
  assignTier(p, t, known ? { businessNumbers: known } : undefined);
const grant = (o: Partial<ProfileLine> = {}) =>
  line({ kind: "grant", ownerOrg: "ic", department: "ISED", description: "A project", ...o });

describe("tier A rules", () => {
  it("rule 1: National Defence grant, defence programme, Space Agency grant, CANDEF organization", () => {
    expect(rules(profile([grant({ ownerOrg: "dnd-mdn" })])).evidence[0]!.rule).toBe(
      "1:national-defence-grant",
    );
    expect(
      rules(
        profile([grant({ programme: "Innovation for Defence Excellence and Security (IDEaS)" })]),
      ).evidence[0]!.rule,
    ).toBe("1:defence-programme");
    expect(rules(profile([grant({ ownerOrg: "csa-asc" })])).tier).toBe("A");
    const p = profile([grant()], { businessNumber: "123456789" });
    expect(rules(p, judge("yes"), new Set(["123456789"])).evidence[0]).toEqual({
      rule: "1:candef-organization",
      line: null,
    });
  });

  it("rule 1 does not fire for a plain National Defence contract or a Space Agency contract", () => {
    expect(rules(profile([line({})])).tier).toBe("B");
    expect(
      rules(profile([line({ ownerOrg: "csa-asc", department: "Canadian Space Agency" })])).tier,
    ).toBe("B");
  });

  it("rule 2: a STRONG category from any department (weapons only from a defence or police buyer)", () => {
    for (const c of [
      "Radar equipment and parts",
      "Military (R&D)",
      "Satellite and spacecraft acquisition and parts",
      "Aircraft parts",
      "Night vision equipment, emitted and reflected radiation",
    ]) {
      const p = profile([line({ ownerOrg: "pc", department: "Parks Canada", description: c })]);
      expect(rules(p).tier, c).toBe("A");
      expect(rules(p).evidence[0]!.rule).toBe("2:strong-category");
    }
    for (const c of [
      "Ammunition",
      "Weapons (including parts)",
      "Explosives, pyrotechnic products",
    ]) {
      const police = profile([line({ ownerOrg: "rcmp-grc", department: "RCMP", description: c })]);
      expect(rules(police).tier, c).toBe("A");
      const lab = profile([
        line({ ownerOrg: "dfo-mpo", department: "Fisheries and Oceans", description: c }),
      ]);
      expect(rules(lab).tier, `${c} from a civilian buyer`).toBe("out");
    }
  });

  it("rule 2 ignores look-alike categories", () => {
    for (const c of [
      "Rental of aircraft",
      "Road motor vehicles - non-military",
      "Engine fuel system components, non-aircraft",
      "Space and water heating equipment",
      "Conference space and facilities",
      "Office furniture and furnishings, including parts",
    ])
      expect(isStrongCategory(c), c).toBe(false);
  });

  it("rule 3: MEDIUM category needs National Defence/Space Agency and size or breadth", () => {
    const radio = (value: number, ownerOrg = "dnd-mdn") =>
      line({
        ownerOrg,
        description: "Communications/Networking equipment (analog, digital)",
        value,
      });
    expect(rules(profile([radio(99_000)])).tier).toBe("B");
    expect(rules(profile([radio(100_000)])).tier).toBe("A");
    expect(rules(profile([radio(500_000, "pc")])).tier).toBe("out");
    const two = profile([
      radio(5_000),
      line({ description: "Navigation and instruments", value: 5_000 }),
    ]);
    expect(rules(two).tier).toBe("A");
    // Two lines of the same group are one group.
    expect(rules(profile([radio(5_000), radio(6_000)])).tier).toBe("B");
  });

  it("rule 4: defence text in a grant or contract row", () => {
    const p = profile([grant({ title: "Counter-UAS detection for defence customers" })]);
    expect(rules(p).tier).toBe("A");
    expect(rules(p).evidence.every((e) => e.rule === "4:defence-text")).toBe(true);
    expect(defenceTextMatch("new ideas for a bakery")).toBeNull();
    expect(defenceTextMatch("IDEaS sandbox project")).toBe("ideas");
    expect(defenceTextMatch("self-defence classes for youth")).toBeNull();
    expect(defenceTextMatch("non-military vehicle")).toBeNull();
    expect(defenceTextMatch("disease surveillance program")).toBeNull();
    expect(defenceTextMatch("open-plan office space")).toBeNull();
  });

  it("rule 5: a very large total of National Defence contracts", () => {
    const big = profile([line({ value: 12_000_000 })]);
    expect(rules(big).evidence.map((e) => e.rule)).toContain("5:large-defence-total");
    expect(rules(profile([line({ value: 9_000_000 })])).tier).toBe("B");
  });

  it("never subtracts: an A company the judge said no to is still A and is marked", () => {
    const r = rules(profile([grant({ ownerOrg: "dnd-mdn" })]), judge("no"));
    expect(r.tier).toBe("A");
    expect(r.judgeSaidNo).toBe(true);
    expect(rules(profile([grant({ ownerOrg: "dnd-mdn" })]), judge("yes")).judgeSaidNo).toBe(false);
  });

  it("every piece of evidence cites a stored line", () => {
    const p = profile([
      grant({ title: "drone project" }),
      line({ description: "Radar equipment and parts" }),
    ]);
    for (const e of rules(p).evidence)
      if (e.line !== null) expect(e.line).toBeLessThan(p.lines.length);
  });
});

describe("tiers B, C, D and out", () => {
  const rcmp = line({
    ownerOrg: "rcmp-grc",
    department: "Royal Canadian Mounted Police",
    description: "Furniture",
  });
  it("B: National Defence supplier with no A rule, whatever the judge said", () => {
    expect(rules(profile([line({})]), judge("no")).tier).toBe("B");
    expect(rules(profile([line({})]), judge("yes")).tier).toBe("B");
  });
  it("B also when the National Defence contracts are only in the profile total", () => {
    expect(rules(profile([grant()], { dndContractValue: 5000 })).tier).toBe("B");
  });
  it("C: judge yes or unsure and only public-safety contracts", () => {
    expect(rules(profile([rcmp]), judge("yes")).tier).toBe("C");
    expect(rules(profile([rcmp]), judge("unsure")).tier).toBe("C");
    expect(rules(profile([rcmp]), judge("no")).tier).toBe("out");
  });
  it("C loses to B and A", () => {
    expect(rules(profile([rcmp, line({})]), judge("yes")).tier).toBe("B");
    expect(rules(profile([rcmp, line({ description: "Ammunition" })]), judge("yes")).tier).toBe(
      "A",
    );
  });
  it("D: judge-only with no rule evidence; out otherwise", () => {
    const quiet = profile([grant({ title: "bakery oven" })]);
    expect(rules(quiet, judge("yes")).tier).toBe("D");
    expect(rules(quiet, judge("unsure")).tier).toBe("D");
    expect(rules(quiet, judge("no")).tier).toBe("out");
    expect(rules(quiet, null).tier).toBe("out");
  });
});

describe("tags", () => {
  it("tags a row and stores the row as evidence", () => {
    const lines = [
      grant({ title: "Robotic arm for welding" }),
      grant({ title: "UAV flight controller" }),
    ];
    const ev = tagLines(lines);
    expect(ev.find((e) => e.tag === "robotics_autonomy")).toMatchObject({ line: 0 });
    expect(ev.find((e) => e.tag === "uas_drones")).toMatchObject({ line: 1, term: "uav" });
  });
  it("matches synonyms and stems, not substrings", () => {
    expect(tagLines([grant({ title: "Drones for mapping" })]).map((e) => e.tag)).toContain(
      "uas_drones",
    );
    expect(tagLines([grant({ title: "Rpas operator training" })]).map((e) => e.tag)).toContain(
      "uas_drones",
    );
    expect(tagLines([grant({ title: "Uncrewed surface vessel" })]).map((e) => e.tag)).toEqual(
      expect.arrayContaining(["uas_drones", "maritime_naval"]),
    );
    expect(tagLines([grant({ title: "Cobot cells" })]).map((e) => e.tag)).toContain(
      "robotics_autonomy",
    );
    expect(tagLines([grant({ title: "Bakery" })])).toEqual([]);
  });
  it("ignores a generic call-for-proposals description but keeps the title's tags", () => {
    const callText =
      "Challenge areas: quantum technologies; autonomous systems; counter-UAS drones; satellite navigation; cybersecurity; naval vessels.";
    const tags = tagLines([
      grant({ title: "Ruggedized docking system", description: callText }),
    ]).map((e) => e.tag);
    expect(tags).not.toContain("uas_drones");
    expect(tags).not.toContain("cyber");
    const titled = tagLines([grant({ title: "Counter-UAS radar", description: callText })]).map(
      (e) => e.tag,
    );
    expect(titled).toContain("uas_drones");
    expect(titled).toContain("sensors_optics_radar");
    // A short project description with few topics still counts.
    expect(
      tagLines([grant({ title: "Project", description: "We build a robot arm." })]).map(
        (e) => e.tag,
      ),
    ).toContain("robotics_autonomy");
  });
  it("covers every tag id with a definition", () => {
    expect(TAG_IDS.length).toBe(20);
  });
});

describe("lead rows", () => {
  it("fills the fields, flags first-time grant recipients and cites lines", () => {
    const p = profile(
      [grant({ date: "2025-02-01", ref: "G1#0", title: "Drone navigation", value: 40_000 })],
      { key: "bn:1", cities: ["Ottawa"], provinces: ["ON"] },
    );
    const r = buildLeadRow(p, judge("yes"), undefined, { profileOffset: 0, profileLength: 10 });
    expect(r).toMatchObject({
      tier: "A",
      firstTimeGrantRecipient: true,
      grantAgreements: 1,
      firstGrantDate: "2025-02-01",
      provinces: ["ON"],
      sourceLines: [0],
    });
    expect(r.tags).toContain("uas_drones");
  });
  it("is not a first-time recipient with two agreements", () => {
    const p = profile([grant({ ref: "G1#0" }), grant({ ref: "G2#0" })]);
    expect(
      buildLeadRow(p, judge("yes"), undefined, { profileOffset: 0, profileLength: 1 })
        .firstTimeGrantRecipient,
    ).toBe(false);
  });
  it("leaves the first grant date unknown when stored rows may be incomplete", () => {
    const p = profile([grant({ date: "2025-01-01" }), line({ date: "2020-01-01" })], {
      grantCount: 3,
    });
    expect(
      buildLeadRow(p, judge("yes"), undefined, { profileOffset: 0, profileLength: 1 })
        .firstGrantDate,
    ).toBeNull();
  });
  it("sums Space Agency money from stored rows", () => {
    const p = profile([grant({ ownerOrg: "csa-asc", value: 70_000 }), grant({ value: 5 })]);
    expect(
      buildLeadRow(p, judge("yes"), undefined, { profileOffset: 0, profileLength: 1 }).csaValue,
    ).toBe(70_000);
  });
});

describe("categories", () => {
  it("classifies MEDIUM groups", () => {
    expect(mediumGroup("Radio and television communications equipment")).toBe("comms");
    expect(mediumGroup("0430 Scientific services, excluding consultants")).toBe("scientific");
    expect(mediumGroup("Engineering Consultants - Construction")).toBeNull();
    expect(mediumGroup("Information technology and telecommunications consultants")).toBeNull();
  });
});

describe("buildIndex", () => {
  it("is deterministic, writes all rows and offsets that read the profile back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "leads-"));
    const ps = [
      profile([grant({ title: "drone", ref: "G#0" })], { key: "k1", name: "One" }),
      profile([line({})], { key: "k2", name: "Two" }),
      profile([grant({ title: "bakery" })], { key: "k3", name: "Three" }),
    ];
    const pfile = join(dir, "profiles.jsonl");
    await writeFile(pfile, ps.map((p) => JSON.stringify(p)).join("\n") + "\n");
    const tfile = join(dir, "triage.jsonl");
    await writeFile(
      tfile,
      ["k1", "k2", "k3"]
        .map((k) =>
          JSON.stringify({ key: k, verdict: "no", reason: "x", status: "out", judge: "manual" }),
        )
        .join("\n") + "\n",
    );
    const s1 = await buildIndex({ profilesPath: pfile, triagePath: tfile, outDir: join(dir, "a") });
    const s2 = await buildIndex({ profilesPath: pfile, triagePath: tfile, outDir: join(dir, "b") });
    expect(s1).toEqual(s2);
    expect(await readFile(join(dir, "a", "leads.jsonl"), "utf8")).toBe(
      await readFile(join(dir, "b", "leads.jsonl"), "utf8"),
    );
    expect(s1.byTier).toMatchObject({ A: 1, B: 1, out: 1 });
    const rows = (await readFile(join(dir, "a", "leads.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const buf = Buffer.from(await readFile(pfile));
    for (const [i, r] of rows.entries())
      expect(
        JSON.parse(
          buf.subarray(r.profileOffset, r.profileOffset + r.profileLength).toString("utf8"),
        ).key,
      ).toBe(ps[i]!.key);
    const search = (await readFile(join(dir, "a", "search.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(search).toHaveLength(2); // the "out" company is not in the search file
  });
});

// ---- Acceptance test against the owner's blind spot-check (Opus's own labels) -----------------

const ASK = "research-cache/grant-ask";
const haveSpot =
  existsSync(`${ASK}/spotcheck/key-10.json`) && existsSync(`${ASK}/full/profiles.jsonl`);

async function profilesByKey(keys: Set<string>): Promise<Map<string, CompanyProfile>> {
  const out = new Map<string, CompanyProfile>();
  const rl = createInterface({ input: createReadStream(`${ASK}/full/profiles.jsonl`, "utf8") });
  for await (const l of rl) {
    const m = /^\{"key":"((?:[^"\\]|\\.)*)"/.exec(l);
    if (m && keys.has(JSON.parse(`"${m[1]}"`) as string)) {
      const p = JSON.parse(l) as CompanyProfile;
      out.set(p.key, p);
    }
  }
  return out;
}

describe.skipIf(!haveSpot)("spot-check acceptance (500 blind-labelled companies)", () => {
  it("tiers agree with the labels", async () => {
    type K = {
      n: number;
      key: string;
      name: string;
      verdict: TriageInfo["verdict"];
      reason: string;
      status: string;
    };
    const items: { k: K; mine: { v: string; r: string } }[] = [];
    for (let s = 1; s <= 10; s++) {
      const id = String(s).padStart(2, "0");
      const key = JSON.parse(readFileSync(`${ASK}/spotcheck/key-${id}.json`, "utf8")) as K[];
      const mine = new Map<number, { v: string; r: string }>();
      for (const l of readFileSync(`${ASK}/spotcheck/mine-${id}.txt`, "utf8").split("\n")) {
        const m = /^(\d+)\s*\|\s*(yes|no|unsure)\s*\|\s*(.*)$/.exec(l.trim());
        if (m) mine.set(Number(m[1]), { v: m[2]!, r: m[3]! });
      }
      for (const k of key) if (mine.has(k.n)) items.push({ k, mine: mine.get(k.n)! });
    }
    const profiles = await profilesByKey(new Set(items.map((i) => i.k.key)));
    const tier = (i: (typeof items)[number]) =>
      assignTier(profiles.get(i.k.key)!, {
        verdict: i.k.verdict,
        reason: i.k.reason,
        judge: "manual",
        status: i.k.status,
      }).tier;

    const yes = items.filter((i) => i.mine.v === "yes");
    const supplier = yes.filter((i) => /^S\b/.test(i.mine.r));
    const real = yes.filter((i) => !/^S\b/.test(i.mine.r));
    const realA = real.filter((i) => tier(i) === "A");
    const suppA = supplier.filter((i) => tier(i) === "A");
    const safety = items.filter(
      (i) =>
        i.k.verdict !== "no" &&
        i.mine.v === "no" &&
        profiles
          .get(i.k.key)!
          .lines.some((l) => ["rcmp-grc", "csc-scc", "cbsa-asfc", "ps-sp"].includes(l.ownerOrg)),
    );
    const safetyOk = safety.filter((i) => ["C", "out"].includes(tier(i)));
    console.log(
      `spot-check: non-supplier yes in A ${realA.length}/${real.length}; supplier-only yes in A ${suppA.length}/${supplier.length}; public-safety disagreements in C or out ${safetyOk.length}/${safety.length}`,
    );
    expect(realA.length / real.length).toBeGreaterThanOrEqual(0.8);
    expect(suppA.length / supplier.length).toBeLessThanOrEqual(0.15);
    expect(safetyOk.length / safety.length).toBeGreaterThanOrEqual(0.85);
  }, 120_000);
});
