import { describe, expect, it } from "vitest";
import type { AgreementView, GraphEdgeView, RoundView, TimelineEntry } from "./schema/snapshot";
import {
  agreementEnd,
  agreementEntry,
  applyTimeFilter,
  entryStatus,
  roundEntry,
  timeExtent,
  yearOf,
} from "./time";

const entry = (over: Partial<TimelineEntry>): TimelineEntry => ({
  recordId: "r1",
  companyId: "c1",
  start: "2019-05",
  end: null,
  kind: "event",
  style: "solid",
  valueCad: null,
  ...over,
});

const edge = (over: Partial<GraphEdgeView>): GraphEdgeView => ({
  id: "e1",
  source: "inv",
  target: "c1",
  kind: "capital",
  recordIds: ["r1"],
  style: "solid",
  weight: 1,
  valueCad: null,
  ...over,
});

describe("yearOf", () => {
  it("reads the year of any partial ISO date and nothing else", () => {
    expect(yearOf("2019")).toBe(2019);
    expect(yearOf("2019-05")).toBe(2019);
    expect(yearOf("2019-05-14")).toBe(2019);
    expect(yearOf(null)).toBeNull();
    expect(yearOf("")).toBeNull();
    expect(yearOf("19")).toBeNull();
    expect(yearOf("20190")).toBeNull();
    expect(yearOf("May 2019")).toBeNull();
  });
});

describe("timeline entries from records", () => {
  const round = {
    id: "fin_x",
    companyId: "c1",
    disclosures: [
      { id: "d1", date: "2020-06-01" },
      { id: "d2", date: "2020-09-22" },
    ],
    participants: [
      { investorId: "lead", disclosureIds: ["d1"] },
      { investorId: "late", disclosureIds: ["d2"] },
      { investorId: "unlinked" },
    ],
  } as unknown as RoundView;

  it("dates an investor to the tranche it joined, not to the first close", () => {
    expect(roundEntry(round, "late", "solid").start).toBe("2020-09-22");
    expect(roundEntry(round, "lead", "solid").start).toBe("2020-06-01");
  });
  it("falls back to the round's first disclosure when no tranche is linked", () => {
    expect(roundEntry(round, "unlinked", "dashed")).toMatchObject({
      start: "2020-06-01",
      end: null,
      kind: "event",
      style: "dashed",
    });
  });
  it("leaves a round with no dated disclosure undated", () => {
    const undated = { ...round, disclosures: [] } as unknown as RoundView;
    expect(roundEntry(undated, "lead", "solid").start).toBeNull();
  });

  it("runs an agreement from its earliest recorded start to its latest disclosed end", () => {
    const g = {
      id: "agr_1",
      family: "procurement",
      startOn: "2022-11-30",
      announcedOn: null,
      thresholdValueCad: 1500000,
      rows: [
        { endOnAsStated: "2025-06-25" },
        { endOnAsStated: "2027-12-31" },
        { endOnAsStated: null },
      ],
    } as unknown as AgreementView;
    expect(agreementEntry(g, "c1", "solid")).toMatchObject({
      start: "2022-11-30",
      end: "2027-12-31",
      kind: "period",
      valueCad: 1500000,
    });
    expect(agreementEnd([{ endOnAsStated: null }])).toBeNull();
  });
  it("uses the announcement when no start is disclosed, and carries no value for grants", () => {
    const g = {
      id: "agr_2",
      family: "grant_contribution",
      startOn: null,
      announcedOn: "2025-05",
      thresholdValueCad: null,
      rows: [],
    } as unknown as AgreementView;
    expect(agreementEntry(g, "c1", "solid")).toMatchObject({
      start: "2025-05",
      end: null,
      valueCad: null,
    });
  });
});

describe("entry status", () => {
  it("'began by' includes everything that started in or before the year, ended or not", () => {
    const f = { mode: "began" as const, year: 2020 };
    expect(entryStatus(entry({ start: "2020-12-31" }), f)).toBe("in");
    expect(entryStatus(entry({ start: "2015", kind: "period", end: "2016" }), f)).toBe("in");
    expect(entryStatus(entry({ start: "2021-01-01" }), f)).toBe("out");
    expect(entryStatus(entry({ start: null }), f)).toBe("undated");
  });
  it("'active during' counts a round only in its own year", () => {
    const f = { mode: "active" as const, year: 2020 };
    expect(entryStatus(entry({ start: "2020-03" }), f)).toBe("in");
    expect(entryStatus(entry({ start: "2019-12" }), f)).toBe("out");
  });
  it("'active during' needs an agreement to span the year, and never guesses a missing end", () => {
    const f = { mode: "active" as const, year: 2024 };
    const period = (start: string | null, end: string | null) =>
      entryStatus(entry({ kind: "period", start, end }), f);
    expect(period("2022-11-30", "2027-12-31")).toBe("in");
    expect(period("2024-12-31", "2025")).toBe("in");
    expect(period("2020", "2024-01-01")).toBe("in");
    expect(period("2020", "2023-12-31")).toBe("out");
    expect(period("2025", "2026")).toBe("out");
    expect(period("2020", null)).toBe("no_end");
    expect(period("2025", null)).toBe("out");
    expect(period(null, "2026")).toBe("undated");
  });
});

describe("filtering relationship lines", () => {
  const lines: GraphEdgeView[] = [
    edge({
      id: "cap:a|c1",
      recordIds: ["r1", "r2"],
      weight: 2,
      style: "dashed",
      timeline: [
        entry({ recordId: "r1", start: "2018", style: "solid" }),
        entry({ recordId: "r2", start: "2022", style: "dashed" }),
      ],
    }),
    edge({
      id: "cap:a|c2",
      target: "c2",
      recordIds: ["r3"],
      timeline: [entry({ recordId: "r3", companyId: "c2", start: null })],
    }),
    edge({
      id: "cap:b|c1",
      source: "b",
      recordIds: ["r2"],
      timeline: [entry({ recordId: "r2", start: "2019" })],
    }),
    edge({ id: "legacy", source: "z", recordIds: ["r9"] }),
    edge({
      id: "bun:a|sec",
      kind: "bundle",
      family: "capital",
      target: "anchor:sec",
      recordIds: ["r1", "r2", "r3"],
      weight: 2,
      memberEdgeIds: ["cap:a|c1", "cap:a|c2"],
    }),
  ];

  it("returns the lines untouched when no filter is set", () => {
    const out = applyTimeFilter(lines, null);
    expect(out.edges).toBe(lines);
    expect(out.stats).toBeNull();
  });

  it("keeps only records in range, recomputing weight, style and bundles", () => {
    const { edges, stats } = applyTimeFilter(lines, { mode: "began", year: 2019 });
    expect(edges.map((e) => e.id)).toEqual(["cap:a|c1", "cap:b|c1", "bun:a|sec"]);
    const a = edges[0]!;
    expect(a).toMatchObject({ recordIds: ["r1"], weight: 1, style: "solid" });
    // The bundle now summarizes one company (c2's only record is undated), not two.
    expect(edges[2]).toMatchObject({ weight: 1, recordIds: ["r1"] });
    // r2 is shown (via investor b in 2019) even though investor a only joined it in 2022.
    expect(stats).toEqual({ shown: 2, undated: 2, noEnd: 0, outside: 0 });
  });

  it("drops a bundle whose members all fall outside the time", () => {
    const { edges } = applyTimeFilter(lines, { mode: "began", year: 2010 });
    expect(edges.find((e) => e.kind === "bundle")).toBeUndefined();
    expect(edges).toEqual([]);
  });

  it("recomputes the procurement threshold value from in-range records only", () => {
    const procurement = edge({
      id: "agr:p",
      kind: "procurement",
      valueCad: 900000,
      recordIds: ["g1", "g2"],
      timeline: [
        entry({ recordId: "g1", kind: "period", start: "2015", end: "2016", valueCad: 900000 }),
        entry({ recordId: "g2", kind: "period", start: "2023", end: "2026", valueCad: 40000 }),
      ],
    });
    const { edges } = applyTimeFilter([procurement], { mode: "active", year: 2024 });
    expect(edges[0]).toMatchObject({ recordIds: ["g2"], valueCad: 40000 });
  });

  it("does not count grant records when grants are hidden", () => {
    const grant = edge({
      id: "agr:g",
      kind: "grant",
      recordIds: ["g9"],
      timeline: [entry({ recordId: "g9", kind: "period", start: "2018", end: "2020" })],
    });
    const f = { mode: "began" as const, year: 2019 };
    expect(applyTimeFilter([grant], f).stats?.shown).toBe(1);
    expect(applyTimeFilter([grant], f, false).stats?.shown).toBe(0);
    // The line itself stays in the scene; the grants toggle hides it at draw time.
    expect(applyTimeFilter([grant], f, false).edges).toHaveLength(1);
  });

  it("is deterministic and preserves line order", () => {
    const f = { mode: "began" as const, year: 2030 };
    expect(applyTimeFilter(lines, f)).toEqual(applyTimeFilter(lines, f));
    expect(applyTimeFilter(lines, f).edges.map((e) => e.id)).toEqual([
      "cap:a|c1",
      "cap:b|c1",
      "bun:a|sec",
    ]);
  });
});

describe("time extent", () => {
  it("spans the earliest dated record to the later of the last record and the build year", () => {
    const lines = [
      edge({ timeline: [entry({ start: "2014" }), entry({ start: null })] }),
      edge({ timeline: [entry({ start: "2021-02" })] }),
    ];
    expect(timeExtent(lines, "2026-10-14T00:00:00Z")).toEqual({ min: 2014, max: 2026 });
    expect(timeExtent([edge({})], "2026-10-14T00:00:00Z")).toBeNull();
  });
});
