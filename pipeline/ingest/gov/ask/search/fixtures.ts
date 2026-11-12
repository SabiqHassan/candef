// Fictional companies for the search tests. Never real data.
import { buildLeadRow, type TriageInfo } from "../leadIndex";
import type { CompanyProfile, ProfileLine } from "../profiles";
import { LeadStore, type SearchDoc } from "./index";

export const line = (o: Partial<ProfileLine>): ProfileLine => ({
  kind: "grant",
  date: "2024-05-01",
  department: "National Research Council Canada",
  ownerOrg: "nrc-cnrc",
  programme: "Industrial Research Assistance Program",
  title: "A project",
  description: "A project description",
  value: 50_000,
  ref: "G-1#0",
  ...o,
});
export const contract = (o: Partial<ProfileLine>): ProfileLine =>
  line({
    kind: "contract",
    department: "National Defence",
    ownerOrg: "dnd-mdn",
    programme: "",
    title: "",
    description: "Ammunition",
    ref: "C-1",
    ...o,
  });

export function company(
  key: string,
  name: string,
  lines: ProfileLine[],
  o: Partial<CompanyProfile> = {},
  verdict: TriageInfo["verdict"] = "yes",
): SearchDoc {
  const grants = lines.filter((l) => l.kind === "grant");
  const contracts = lines.filter((l) => l.kind === "contract");
  const dates = lines.map((l) => l.date).sort();
  const p: CompanyProfile = {
    key,
    name,
    otherNames: [],
    businessNumber: null,
    cities: ["Halifax"],
    provinces: ["NS"],
    areas: [],
    grantCount: grants.length,
    contractCount: contracts.length,
    grantValue: grants.reduce((s, l) => s + l.value, 0),
    contractValue: contracts.reduce((s, l) => s + l.value, 0),
    dndContractValue: contracts
      .filter((l) => l.ownerOrg === "dnd-mdn")
      .reduce((s, l) => s + l.value, 0),
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    lines,
    ...o,
  };
  const row = buildLeadRow(
    p,
    { verdict, reason: "reason text", judge: "manual", status: "in" },
    undefined,
    {
      profileOffset: 0,
      profileLength: 0,
    },
  );
  return { ...row, lines };
}

export const fixtures = (): SearchDoc[] => [
  company("k-drone", "Northern Drone Works", [
    line({
      title: "UAV flight controller",
      programme: "Innovation for Defence Excellence and Security (IDEaS)",
      date: "2023-03-01",
      ref: "G-10#0",
      department: "National Defence",
      ownerOrg: "dnd-mdn",
    }),
  ]),
  company(
    "k-robot",
    "Maple Robotics",
    [line({ title: "Autonomous robot arm", date: "2024-09-01", ref: "G-11#0" })],
    { provinces: ["ON"], cities: ["Ottawa"] },
  ),
  company(
    "k-space",
    "Aurora Orbit Inc",
    [
      line({
        title: "Satellite imaging payload",
        programme: "Space Technology Development",
        department: "Canadian Space Agency",
        ownerOrg: "csa-asc",
        date: "2019-01-01",
        ref: "G-12#0",
        value: 200_000,
      }),
      line({
        title: "Orbit software",
        programme: "Space Technology Development",
        department: "Canadian Space Agency",
        ownerOrg: "csa-asc",
        date: "2021-01-01",
        ref: "G-13#0",
      }),
    ],
    { provinces: ["QC"], cities: ["Montreal"] },
  ),
  company("k-ammo", "Prairie Munitions Ltd", [contract({ date: "2020-06-01", value: 900_000 })], {
    provinces: ["AB"],
    cities: [],
  }),
  company(
    "k-supplier",
    "Atlantic Office Supply",
    [contract({ description: "Office furniture", date: "2021-02-01", value: 20_000 })],
    { provinces: ["NB"] },
  ),
  company("k-text", "Quiet Holdings", [
    line({ title: "Study of defence readiness", date: "2024-01-01", ref: "G-14#0" }),
  ]),
  company("k-no", "Sleepy Bakery", [line({ title: "Oven upgrade", ref: "G-15#0" })], {}, "no"),
];

export const store = () => LeadStore.fromDocs(fixtures());
