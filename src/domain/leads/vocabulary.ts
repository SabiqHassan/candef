/**
 * Vocabulary shared by the lead index (pipeline) and the lead search page (site): topic tag IDs and
 * their labels, and the synonym groups the search expands a typed word with. Pure data, no imports,
 * so both sides can use it. The keyword lists that attach tags to companies stay in the pipeline
 * (`pipeline/ingest/gov/ask/tags.ts`); a test keeps the labels in step.
 */
export const TAG_IDS = [
  "uas_drones",
  "space",
  "cyber",
  "robotics_autonomy",
  "aerospace_aviation",
  "maritime_naval",
  "land_vehicles",
  "weapons_munitions",
  "sensors_optics_radar",
  "comms_electronics",
  "ai_software",
  "simulation_training",
  "cbrn_medical",
  "energy_power",
  "materials_manufacturing",
  "security_services",
  "construction_facilities",
  "logistics_supply",
  "food_hospitality",
  "professional_services",
] as const;
export type TagId = (typeof TAG_IDS)[number];

export const TAG_LABELS: Record<TagId, string> = {
  uas_drones: "Drones and uncrewed systems",
  space: "Space",
  cyber: "Cybersecurity",
  robotics_autonomy: "Robotics and autonomy",
  aerospace_aviation: "Aerospace and aviation",
  maritime_naval: "Maritime and underwater",
  land_vehicles: "Land vehicles",
  weapons_munitions: "Weapons and munitions",
  sensors_optics_radar: "Sensors, optics and radar",
  comms_electronics: "Communications and electronics",
  ai_software: "AI and software",
  simulation_training: "Simulation and training",
  cbrn_medical: "CBRN and defence medical",
  energy_power: "Energy and power",
  materials_manufacturing: "Materials and manufacturing",
  security_services: "Security and surveillance",
  construction_facilities: "Construction and facilities",
  logistics_supply: "Logistics and supply",
  food_hospitality: "Food and hospitality",
  professional_services: "Professional services",
};

/**
 * Synonym groups for search: a query word that belongs to a group also matches the group's other
 * words. Built from the tag terms (stems only, no phrases) plus a few everyday words.
 */
export const SYNONYM_GROUPS: string[][] = [
  [
    "drone",
    "uas",
    "uav",
    "rpas",
    "uncrewed",
    "unmanned",
    "uninhabited",
    "quadcopter",
    "multirotor",
  ],
  ["robot", "robotic", "robotics", "autonomous", "autonomy", "cobot"],
  ["satellite", "spacecraft", "smallsat", "cubesat", "space", "orbit"],
  ["cyber", "cybersecurity", "encryption", "cryptography", "infosec"],
  ["radar", "sonar", "lidar", "sensor", "sensing"],
  ["ammunition", "munition", "munitions", "ordnance", "ammo"],
  ["weapon", "weapons", "armament", "armaments", "firearm"],
  ["ship", "vessel", "naval", "marine", "maritime", "boat"],
  ["underwater", "subsea", "submarine", "undersea"],
  ["aircraft", "aerospace", "aviation", "airframe", "avionics"],
  ["surveillance", "isr", "reconnaissance"],
  ["ai", "artificial", "ml"],
  ["defence", "defense", "military", "dnd"],
];
