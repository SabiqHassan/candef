/**
 * FICTIONAL demonstration leads for the demo build and the end-to-end tests. Every company, number,
 * reference and project here is invented; none points at a real record. The leads page shows the
 * demo banner for these, never links them to the open-data portal, and the research build never
 * contains them (dataset isolation, vite.config.ts).
 */
import {
  LEADS_FILE_VERSION,
  LEADS_LABEL,
  type LeadsFile,
  type SiteLead,
  type SiteLine,
} from "../../../../src/domain/leads/siteTypes";
import { LeadsFileSchema } from "../../../../src/domain/leads/siteData";
import { LICENCE, SOURCES } from "./siteExport";

const line = (l: Partial<SiteLine> & Pick<SiteLine, "kind" | "date" | "title">): SiteLine => ({
  department: "National Defence",
  ownerOrg: "dnd-mdn",
  programme: "",
  description: "",
  value: 0,
  ref: "DEMO-0000",
  tags: [],
  ...l,
});

const lead = (
  l: Partial<SiteLead> & Pick<SiteLead, "key" | "name" | "lines" | "tags" | "reason">,
): SiteLead => {
  const grants = l.lines.filter((x) => x.kind === "grant");
  const contracts = l.lines.filter((x) => x.kind === "contract");
  const sum = (xs: SiteLine[]) => xs.reduce((n, x) => n + x.value, 0);
  const dates = l.lines.map((x) => x.date).sort();
  return {
    otherNames: [],
    businessNumber: null,
    cities: [],
    provinces: [],
    tier: "A",
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    firstGrantDate: grants.map((x) => x.date).sort()[0] ?? null,
    firstTimeGrantRecipient: new Set(grants.map((x) => x.ref)).size === 1,
    grantAgreements: new Set(grants.map((x) => x.ref)).size,
    grantCount: grants.length,
    contractCount: contracts.length,
    grantValue: sum(grants),
    contractValue: sum(contracts),
    dndContractValue: sum(contracts.filter((x) => x.ownerOrg === "dnd-mdn")),
    csaValue: sum(l.lines.filter((x) => x.ownerOrg === "csa-asc")),
    judgeSaidNo: false,
    tierEvidence: [{ rule: "4:defence-text", line: 0 }],
    ...l,
  };
};

export function demoLeadsFile(): LeadsFile {
  const leads: SiteLead[] = [
    lead({
      key: "demo:alder-ridge",
      name: "Alder Ridge Robotics (fictional)",
      cities: ["Fictionville"],
      provinces: ["ON"],
      tags: ["robotics_autonomy", "uas_drones"],
      reason: "Funded for uncrewed ground and air vehicle projects",
      tierEvidence: [{ rule: "1:defence-programme", line: 0 }],
      lines: [
        line({
          kind: "grant",
          date: "2025-04-01",
          programme: "Innovation for Defence Excellence and Security Program",
          title: "Cooperative uncrewed ground vehicle swarm navigation (demo)",
          description:
            "Invented project: coordinated navigation for small uncrewed ground vehicles.",
          value: 250000,
          ref: "DEMO-G-0001",
          tags: ["robotics_autonomy", "uas_drones"],
        }),
      ],
    }),
    lead({
      key: "demo:northwind-optics",
      name: "Northwind Optics Ltd. (fictional)",
      cities: ["Sampletown"],
      provinces: ["QC"],
      tags: ["sensors_optics_radar"],
      reason: "Optical instruments sold to National Defence",
      tierEvidence: [{ rule: "2:strong-category", line: 0 }],
      lines: [
        line({
          kind: "contract",
          date: "2024-11-15",
          title: "",
          description: "Optical sighting and ranging instruments",
          value: 480000,
          ref: "DEMO-C-0002",
          tags: ["sensors_optics_radar"],
        }),
        line({
          kind: "contract",
          date: "2023-06-02",
          title: "",
          description: "Night vision equipment and parts",
          value: 120000,
          ref: "DEMO-C-0003",
          tags: ["sensors_optics_radar"],
        }),
      ],
    }),
    lead({
      key: "demo:harbour-sonar",
      name: "Harbour Light Sonar Inc. (fictional)",
      cities: ["Portsmouth Bay"],
      provinces: ["NS"],
      tags: ["maritime_naval", "sensors_optics_radar"],
      reason: "Underwater sensing work for naval and coast guard users",
      tierEvidence: [{ rule: "1:defence-programme", line: 0 }],
      lines: [
        line({
          kind: "grant",
          date: "2024-09-10",
          department: "Atlantic Canada Opportunities Agency",
          ownerOrg: "acoa-apeca",
          programme: "Regional Defence Investment Initiative (RDII)",
          title: "Compact sonar array for small vessels (demo)",
          description:
            "Invented project: a compact sonar array for small crewed and uncrewed vessels.",
          value: 600000,
          ref: "DEMO-G-0004",
          tags: ["maritime_naval", "sensors_optics_radar"],
        }),
      ],
    }),
    lead({
      key: "demo:orbit-line",
      name: "Orbit Line Space Systems (fictional)",
      cities: ["Fictionville"],
      provinces: ["QC"],
      tags: ["space"],
      reason: "Space Agency funded small satellite subsystems",
      tierEvidence: [{ rule: "1:space-agency-grant", line: 0 }],
      lines: [
        line({
          kind: "grant",
          date: "2025-02-20",
          department: "Canadian Space Agency",
          ownerOrg: "csa-asc",
          programme: "Smallsat component development",
          title: "Radiation-tolerant power board for small satellites (demo)",
          description: "Invented project: a radiation-tolerant power board for small satellites.",
          value: 310000,
          ref: "DEMO-G-0005",
          tags: ["space"],
        }),
      ],
    }),
    lead({
      key: "demo:cipher-mesh",
      name: "Cipher Mesh Security (fictional)",
      cities: ["Sampletown"],
      provinces: ["ON"],
      tags: ["cyber", "comms_electronics"],
      reason: "Secure communications research funded through IRAP",
      lines: [
        line({
          kind: "grant",
          date: "2024-03-12",
          department: "National Research Council Canada",
          ownerOrg: "nrc-cnrc",
          programme: "Industrial Research Assistance Program",
          title: "Encrypted mesh radio for field teams (demo)",
          description:
            "Invented project: encrypted mesh radio for security and defence field teams.",
          value: 95000,
          ref: "DEMO-G-0006",
          tags: ["cyber", "comms_electronics"],
        }),
      ],
    }),
    lead({
      key: "demo:prairie-airframes",
      name: "Prairie Airframes Ltd. (fictional)",
      cities: ["Fiction Falls"],
      provinces: ["AB"],
      tags: ["aerospace_aviation"],
      reason: "Aircraft components for National Defence",
      tierEvidence: [{ rule: "2:strong-category", line: 0 }],
      lines: [
        line({
          kind: "contract",
          date: "2022-08-30",
          title: "",
          description: "Aircraft components and accessories",
          value: 2100000,
          ref: "DEMO-C-0007",
          tags: ["aerospace_aviation"],
        }),
      ],
    }),
    lead({
      key: "demo:tidewater-uas",
      name: "Tidewater UAS Labs (fictional)",
      cities: ["Portsmouth Bay"],
      provinces: ["NB"],
      tags: ["uas_drones"],
      reason: "Drone payload delivery work with defence funding",
      tierEvidence: [{ rule: "1:defence-programme", line: 0 }],
      lines: [
        line({
          kind: "grant",
          date: "2025-05-05",
          programme: "Innovation for Defence Excellence and Security Program",
          title: "Precision payload drop for uncrewed aircraft (demo)",
          description:
            "Invented project: a precision payload release system for uncrewed aircraft.",
          value: 180000,
          ref: "DEMO-G-0008",
          tags: ["uas_drones"],
        }),
      ],
    }),
  ];
  return LeadsFileSchema.parse({
    format: "candef-leads",
    version: LEADS_FILE_VERSION,
    label: LEADS_LABEL,
    meta: {
      dataDate: "2026-10-13",
      generatedAt: "2026-10-13T00:00:00.000Z",
      tiers: ["A"],
      count: leads.length,
      isDemo: true,
      sources: SOURCES,
      licence: LICENCE,
    },
    leads,
  });
}
