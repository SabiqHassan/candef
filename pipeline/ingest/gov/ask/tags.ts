/**
 * Keyword taxonomy for the leads index and the leads search. Plain word lists, no model: a tag is
 * attached to a company only when one of its terms appears in a specific government row (title,
 * description, contract category or programme), and the row is stored as the tag's evidence.
 *
 * Term syntax: lowercase; a trailing `*` means "any word ending" (robot* matches robotics, robots).
 * The same lists give the synonym expansion used by the search (drone also finds UAS, UAV, RPAS).
 *
 * Leads only: a tag is a search aid, never a verified fact.
 */
import type { ProfileLine } from "./profiles";

import { TAG_IDS, type TagId } from "../../../../src/domain/leads/vocabulary";

export { TAG_IDS, type TagId };

export interface TagDef {
  label: string;
  /** Terms (see the syntax above). A phrase of several words matches as a phrase. */
  terms: string[];
  /** True for tags that describe an ordinary supplier rather than a technology area. */
  supplier?: boolean;
}

export const TAGS: Record<TagId, TagDef> = {
  uas_drones: {
    label: "Drones and uncrewed systems",
    terms: [
      "drone*",
      "uas",
      "uav*",
      "rpas",
      "uncrewed",
      "unmanned",
      "uninhabited",
      "quadcopter*",
      "multirotor*",
      "multi-rotor",
      "remotely piloted",
      "counter-uas",
      "counter-drone*",
      "counter uas",
      "c-uas",
      "aerial vehicle*",
    ],
  },
  space: {
    label: "Space",
    terms: [
      "satellite*",
      "spacecraft",
      "space agency",
      "space technology",
      "space-based",
      "space based",
      "space systems",
      "space sector",
      "space industry",
      "space exploration",
      "space robotics",
      "space flight",
      "spaceflight",
      "outer space",
      "smallsat*",
      "cubesat*",
      "nanosat*",
      "earth observation",
      "launch vehicle*",
      "launch services",
      "rocket*",
      "orbit*",
      "ground station*",
      "lunar",
      "planetary",
    ],
  },
  cyber: {
    label: "Cybersecurity",
    terms: [
      "cyber*",
      "information security",
      "network security",
      "encryption",
      "cryptograph*",
      "cryptolog*",
      "zero trust",
      "penetration test*",
      "threat detection",
      "malware",
      "secure communication*",
      "post-quantum",
      "quantum key",
      "quantum-safe",
      "intrusion detection",
    ],
  },
  robotics_autonomy: {
    label: "Robotics and autonomy",
    terms: [
      "robot*",
      "autonomous",
      "autonomy",
      "cobot*",
      "self-driving",
      "automated guided",
      "autonomous vehicle*",
      "unmanned ground",
      "exoskeleton*",
    ],
  },
  aerospace_aviation: {
    label: "Aerospace and aviation",
    terms: [
      "aerospace",
      "aircraft",
      "airframe*",
      "avionics",
      "aviation",
      "helicopter*",
      "gas turbine*",
      "jet engine*",
      "rotorcraft",
      "rotary wing",
      "fixed wing",
      "landing gear",
      "airworth*",
    ],
  },
  maritime_naval: {
    label: "Maritime and underwater",
    terms: [
      "naval",
      "ship*",
      "vessel*",
      "marine",
      "maritime",
      "underwater",
      "subsea",
      "submarine*",
      "sonar",
      "hydrograph*",
      "auv",
      "rov",
      "hydroacoustic*",
      "ocean technology",
    ],
  },
  land_vehicles: {
    label: "Land vehicles",
    terms: [
      "armoured vehicle*",
      "armored vehicle*",
      "combat vehicle*",
      "tactical vehicle*",
      "military vehicle*",
      "tracked vehicle*",
      "wheeled vehicle*",
      "land vehicle*",
      "all terrain",
      "all-terrain",
      "road motor vehicles-military",
      "road motor vehicles - military",
      "combat, assault",
    ],
  },
  weapons_munitions: {
    label: "Weapons and munitions",
    terms: [
      "weapon*",
      "ammunition",
      "munition*",
      "ordnance",
      "armament*",
      "missile*",
      "explosive*",
      "fire control",
      "bomb*",
      "firearm*",
      "small arms",
      "propellant*",
      "gun",
      "guns",
      "torpedo*",
    ],
  },
  sensors_optics_radar: {
    label: "Sensors, optics and radar",
    terms: [
      "radar",
      "sonar",
      "lidar",
      "sensor*",
      "optic*",
      "night vision",
      "infrared",
      "thermal imag*",
      "electro-optic*",
      "sighting",
      "hyperspectral",
      "imaging",
      "camera*",
      "photonic*",
      "spectromet*",
    ],
  },
  comms_electronics: {
    label: "Communications and electronics",
    terms: [
      "communications equipment",
      "communications/networking",
      "networking equipment",
      "radio",
      "antenna*",
      "satcom",
      "microwave",
      "amplifier*",
      "oscilloscope*",
      "wireless",
      "electronic*",
      "electrical and electronic",
      "tactical communication*",
      "telecommunication*",
      "5g",
    ],
  },
  ai_software: {
    label: "AI and software",
    terms: [
      "artificial intelligence",
      "machine learning",
      "deep learning",
      "computer vision",
      "data analytics",
      "large language",
      "software",
      "algorithm*",
      "neural network*",
    ],
  },
  simulation_training: {
    label: "Simulation and training",
    terms: [
      "simulat*",
      "training device*",
      "training aids",
      "virtual reality",
      "synthetic environment*",
      "wargam*",
      "digital twin*",
    ],
  },
  cbrn_medical: {
    label: "CBRN and defence medical",
    terms: [
      "cbrn",
      "chemical warfare",
      "chemical/biological",
      "chemical, biological",
      "radiological",
      "decontamination",
      "countermeasure*",
      "biodefence",
      "biodefense",
      "protective equipment",
      "medical (r&d)",
    ],
  },
  energy_power: {
    label: "Energy and power",
    terms: [
      "batter*",
      "power system*",
      "fuel cell*",
      "hydrogen",
      "energy storage",
      "generator*",
      "power generation",
      "microgrid*",
      "power electronics",
    ],
  },
  materials_manufacturing: {
    label: "Materials and manufacturing",
    terms: [
      "advanced material*",
      "composite*",
      "additive manufacturing",
      "3d print*",
      "alloy*",
      "machining",
      "fabrication",
      "ballistic*",
      "armour",
      "armor",
      "ceramic*",
      "metal*",
    ],
  },
  security_services: {
    label: "Security and surveillance",
    terms: [
      "protection services",
      "security services",
      "security control",
      "physical security",
      "access control",
      "surveillance",
      "border security",
      "perimeter",
      "guard services",
      "biometric*",
      "emanation control",
    ],
  },
  construction_facilities: {
    label: "Construction and facilities",
    terms: [
      "construction",
      "buildings",
      "building",
      "facilities",
      "engineering works",
      "architectural",
      "plumbing",
      "heating",
      "cleaning",
      "waste disposal",
    ],
    supplier: true,
  },
  logistics_supply: {
    label: "Logistics and supply",
    terms: [
      "logistics",
      "transportation of things",
      "supply chain",
      "warehous*",
      "freight",
      "courier*",
      "fuel",
      "furniture",
      "office supplies",
      "stationer*",
    ],
    supplier: true,
  },
  food_hospitality: {
    label: "Food and hospitality",
    terms: ["food", "hospitality", "catering", "ration*", "hotel*", "restaurant*", "beverage*"],
    supplier: true,
  },
  professional_services: {
    label: "Professional services",
    terms: [
      "management consulting",
      "professional services",
      "consultant*",
      "translation",
      "legal services",
      "scientific services",
      "engineering services",
      "engineering and technical",
      "advertising",
      "temporary help",
      "research contracts",
    ],
    supplier: true,
  },
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Compile one term (with the trailing-* convention) to a regex source fragment. */
export function termSource(term: string): string {
  const stem = term.endsWith("*") ? term.slice(0, -1) : term;
  const body = escapeRe(stem).replace(/\s+/g, "\\s+");
  // `\b` is wrong around terms that start or end in a non-word character such as "(r&d)".
  const lead = /^\w/.test(stem) ? "\\b" : "";
  const trail = term.endsWith("*") ? "\\w*" : /\w$/.test(stem) ? "\\b" : "";
  return `${lead}${body}${trail}`;
}

const compiled: Record<TagId, RegExp> = Object.fromEntries(
  TAG_IDS.map((id) => [id, new RegExp(TAGS[id].terms.map(termSource).join("|"), "i")]),
) as Record<TagId, RegExp>;

/** The text of one government row that a tag may match: title, description/category, programme. */
export function lineText(l: ProfileLine): string {
  return [l.title, l.description, l.programme].filter(Boolean).join(" | ");
}

/** The tags one row carries on its own (same rules as tagLines). */
export function lineTagIds(l: ProfileLine): TagId[] {
  const primary =
    l.kind === "grant" ? [l.title, l.programme].filter(Boolean).join(" | ") : l.description;
  const secondary = l.kind === "grant" ? l.description : "";
  const fromSecondary = secondary ? TAG_IDS.filter((id) => compiled[id].test(secondary)) : [];
  const useSecondary = fromSecondary.length <= GENERIC_DESCRIPTION_TAGS;
  return TAG_IDS.filter(
    (id) => compiled[id].test(primary) || (useSecondary && fromSecondary.includes(id)),
  );
}

export interface TagEvidence {
  tag: TagId;
  /** Index into the company's profile lines. */
  line: number;
  /** The matched text. */
  term: string;
}

/**
 * A grant description that names this many different topics is a call-for-proposals text shared by
 * every awardee of a challenge (an IDEaS challenge lists quantum, autonomy, counter-UAS, Arctic
 * mobility and energy), not a description of one company's project. Its words are not used as tags.
 */
export const GENERIC_DESCRIPTION_TAGS = 3;

/**
 * Tags for one company with the first matching row of each as evidence. A grant matches on its
 * title and programme first; its description counts too unless it is a generic call text. A
 * contract matches on its category.
 */
export function tagLines(lines: readonly ProfileLine[]): TagEvidence[] {
  const rows = lines.map((l) => {
    const primary =
      l.kind === "grant" ? [l.title, l.programme].filter(Boolean).join(" | ") : l.description;
    const secondary = l.kind === "grant" ? l.description : "";
    const distinct = secondary ? TAG_IDS.filter((id) => compiled[id].test(secondary)).length : 0;
    return { primary, secondary: distinct > GENERIC_DESCRIPTION_TAGS ? "" : secondary };
  });
  const out: TagEvidence[] = [];
  for (const id of TAG_IDS) {
    const re = compiled[id];
    for (let i = 0; i < rows.length; i++) {
      const m =
        re.exec(rows[i]!.primary) ?? (rows[i]!.secondary ? re.exec(rows[i]!.secondary) : null);
      if (m) {
        out.push({ tag: id, line: i, term: m[0].toLowerCase() });
        break;
      }
    }
  }
  return out;
}

export { SYNONYM_GROUPS } from "../../../../src/domain/leads/vocabulary";

/** The single-word terms of a tag, for matching a tag name typed as a query word. */
export function tagTermsForWord(word: string): TagId[] {
  const w = word.toLowerCase();
  return TAG_IDS.filter((id) => {
    if (id === w || TAGS[id].label.toLowerCase().includes(w)) return w.length > 3;
    return TAGS[id].terms.some((t) => !t.includes(" ") && t.replace(/\*$/, "") === w);
  });
}

const DEFENCE_WORDS = new RegExp(
  [
    String.raw`(?<!self[- ])(?<!non[- ])\b(?:defen[cs]e|military)\b`,
    String.raw`canadian armed forces`,
    String.raw`\buncrewed\b`,
    String.raw`\bunmanned\b`,
    String.raw`counter[- ]?(?:uas|drone)`,
    String.raw`\bdrones?\b`,
    String.raw`\bsatellites?\b`,
    String.raw`\bspacecraft\b`,
    String.raw`\bspace (?:agency|technology|systems?|industry|sector|exploration|robotics|based|flight)\b`,
    String.raw`\bspace-based\b`,
    String.raw`\baerospace\b`,
    String.raw`\bradar\b`,
    String.raw`\bsonar\b`,
    String.raw`\bcyber[- ]?(?:security|defen[cs]e|threats?|attacks?)\b`,
    String.raw`(?<!disease |public health |epidemiological |health )\bsurveillance\b`,
    String.raw`\barmou?r(?:ed)?\b`,
    String.raw`\bballistic\b`,
    String.raw`\bmunitions?\b`,
    String.raw`\bborder security\b`,
    String.raw`\btactical\b`,
    String.raw`\bdual[- ]use\b`,
  ].join("|"),
  "i",
);
/** Acronyms are matched case-sensitively: "IDEaS" is a programme, "ideas" is a word. */
const DEFENCE_ACRONYMS = /\b(?:DND|CAF|NATO|IDEaS|DIANA|ISR|UAS|UAV|RPAS|UGV|CBRN|C-UAS)\b/;

/**
 * Defence, security and space words in project text (tier A rule 4). "non-military", "self-defence"
 * and health "surveillance" are excluded. Returns the matched text, or null.
 */
export function defenceTextMatch(text: string): string | null {
  const m = DEFENCE_WORDS.exec(text) ?? DEFENCE_ACRONYMS.exec(text);
  return m ? m[0].toLowerCase() : null;
}
