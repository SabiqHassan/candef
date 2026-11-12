/**
 * The lead page's filters as URL search parameters, so a search can be shared and the back button
 * works. Unknown or malformed values are ignored, never an error.
 */
import { TAG_IDS, type TagId } from "../../domain/leads/vocabulary";

export interface LeadsState {
  q: string;
  tags: TagId[];
  province: string;
  programme: string;
  /** Earliest first appearance in the data, as a year ("" = any). */
  since: string;
  /** Only companies with exactly one grant so far. */
  firstGrantOnly: boolean;
  /** Largest total of all government money, in CA$ (0 = any). */
  maxValue: number;
  selected: string;
}

export const EMPTY_STATE: LeadsState = {
  q: "",
  tags: [],
  province: "",
  programme: "",
  since: "",
  firstGrantOnly: false,
  maxValue: 0,
  selected: "",
};

export const PROGRAMME_CHOICES: { id: string; label: string }[] = [
  { id: "ideas", label: "IDEaS (Innovation for Defence Excellence and Security)" },
  { id: "rdii", label: "RDII (Regional Defence Investment Initiative)" },
  { id: "sadi", label: "SADI (Strategic Aerospace and Defence Initiative)" },
  { id: "diana", label: "DIANA (NATO Defence Innovation Accelerator)" },
  { id: "irap", label: "IRAP (Industrial Research Assistance Program)" },
];
export const SINCE_CHOICES = ["2024", "2022", "2020", "2018"];
export const VALUE_CHOICES: { value: number; label: string }[] = [
  { value: 100_000, label: "under CA$100K" },
  { value: 500_000, label: "under CA$500K" },
  { value: 2_000_000, label: "under CA$2M" },
  { value: 10_000_000, label: "under CA$10M" },
];
export const PROVINCE_CHOICES = [
  ["ON", "Ontario"],
  ["QC", "Quebec"],
  ["BC", "British Columbia"],
  ["AB", "Alberta"],
  ["NS", "Nova Scotia"],
  ["NB", "New Brunswick"],
  ["NL", "Newfoundland and Labrador"],
  ["MB", "Manitoba"],
  ["SK", "Saskatchewan"],
  ["PE", "Prince Edward Island"],
  ["YT", "Yukon"],
  ["NT", "Northwest Territories"],
  ["NU", "Nunavut"],
] as const;

export function parseState(params: URLSearchParams): LeadsState {
  const tags = (params.get("tag") ?? "")
    .split(",")
    .filter((t): t is TagId => (TAG_IDS as readonly string[]).includes(t));
  const province = params.get("prov") ?? "";
  const programme = params.get("prog") ?? "";
  const since = params.get("since") ?? "";
  const max = Number(params.get("max") ?? 0);
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    tags: [...new Set(tags)],
    province: PROVINCE_CHOICES.some(([c]) => c === province) ? province : "",
    programme: PROGRAMME_CHOICES.some((p) => p.id === programme) ? programme : "",
    since: SINCE_CHOICES.includes(since) ? since : "",
    firstGrantOnly: params.get("first") === "1",
    maxValue: VALUE_CHOICES.some((v) => v.value === max) ? max : 0,
    selected: (params.get("sel") ?? "").slice(0, 200),
  };
}

export function toParams(s: LeadsState): URLSearchParams {
  const p = new URLSearchParams();
  if (s.q.trim()) p.set("q", s.q);
  if (s.tags.length) p.set("tag", s.tags.join(","));
  if (s.province) p.set("prov", s.province);
  if (s.programme) p.set("prog", s.programme);
  if (s.since) p.set("since", s.since);
  if (s.firstGrantOnly) p.set("first", "1");
  if (s.maxValue) p.set("max", String(s.maxValue));
  if (s.selected) p.set("sel", s.selected);
  return p;
}

/** The state as a search query for the shared ranking (the selection is not a filter). */
export function toQuery(s: LeadsState) {
  return {
    ...(s.q.trim() ? { text: s.q.trim() } : {}),
    ...(s.tags.length ? { tags: s.tags } : {}),
    ...(s.province ? { provinces: [s.province] } : {}),
    ...(s.programme ? { programmes: [s.programme] } : {}),
    ...(s.since ? { firstSeenAfter: s.since } : {}),
    ...(s.firstGrantOnly ? { firstTimeGrantRecipient: true } : {}),
    ...(s.maxValue ? { maxTotalValue: s.maxValue } : {}),
  };
}

export const activeFilterCount = (s: LeadsState) =>
  s.tags.length +
  [s.province, s.programme, s.since].filter(Boolean).length +
  (s.firstGrantOnly ? 1 : 0) +
  (s.maxValue ? 1 : 0);
