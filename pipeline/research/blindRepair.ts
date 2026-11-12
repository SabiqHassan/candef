/**
 * Repairs a researcher package whose markdown export lost its underscores (Perplexity batch-2 files
 * read `cardid`, `packageversion`, `notresearched` where the schema has `card_id`, `package_version`,
 * `not_researched`). Only schema vocabulary is restored: object keys that equal a schema key with
 * the underscores removed, and enum values on enum-typed fields. Free text, URLs and locators are
 * never touched, and a key or value that matches two schema words is left alone and reported.
 * The original file is never changed: callers write the repaired copy beside it.
 */

type Json = unknown;
interface Vocabulary {
  keys: Map<string, string[]>; // stripped -> canonical keys
  enums: Map<string, Map<string, string[]>>; // canonical key -> stripped value -> canonical values
}

const strip = (s: string) => s.replace(/_/g, "");

/** Collects property names and enum values from a JSON Schema produced by `z.toJSONSchema`. */
export function vocabularyOf(schema: Json): Vocabulary {
  const keys = new Map<string, string[]>();
  const enums = new Map<string, Map<string, string[]>>();
  const add = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const list = m.get(k) ?? [];
    if (!list.includes(v)) list.push(v);
    m.set(k, list);
  };
  const enumValues = (node: Record<string, unknown>): string[] => {
    const own = Array.isArray(node.enum) ? node.enum.filter((v) => typeof v === "string") : [];
    const nested = [node.anyOf, node.oneOf]
      .flatMap((x) => (Array.isArray(x) ? x : []))
      .flatMap((n) => (n && typeof n === "object" ? enumValues(n as Record<string, unknown>) : []));
    return [...(own as string[]), ...nested];
  };
  const walk = (node: Json) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    const props = obj.properties as Record<string, Json> | undefined;
    if (props)
      for (const [k, v] of Object.entries(props)) {
        add(keys, strip(k), k);
        if (v && typeof v === "object") {
          const values = enumValues(v as Record<string, unknown>);
          if (values.length) {
            const byStripped = enums.get(k) ?? new Map<string, string[]>();
            for (const value of values) add(byStripped, strip(value), value);
            enums.set(k, byStripped);
          }
        }
      }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(schema);
  return { keys, enums };
}

export interface Repair {
  value: Json;
  /** What was restored, e.g. `key card_id (1)`, for the log. */
  notes: string[];
  /** Words that matched more than one schema word and were left as they were. */
  ambiguous: string[];
}

/** True when the package looks stripped: no `package_version` but a `packageversion`. */
export function looksStripped(raw: Json): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    !("package_version" in raw) &&
    "packageversion" in (raw as object)
  );
}

export function repairStripped(raw: Json, vocab: Vocabulary): Repair {
  const counts = new Map<string, number>();
  const ambiguous = new Set<string>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  const canonicalKey = (k: string): string => {
    if (vocab.keys.get(k)?.includes(k)) return k; // already a schema key
    const hits = vocab.keys.get(strip(k));
    if (!hits || strip(k) !== k) return k;
    if (hits.length > 1) {
      ambiguous.add(`key ${k}`);
      return k;
    }
    if (hits[0] !== k) bump(`key ${hits[0]}`);
    return hits[0]!;
  };
  const walk = (node: Json, parentKey: string | null): Json => {
    if (Array.isArray(node)) return node.map((x) => walk(x, parentKey));
    if (node && typeof node === "object") {
      const out: Record<string, Json> = {};
      for (const [k, v] of Object.entries(node as Record<string, Json>)) {
        const key = canonicalKey(k);
        out[key] = walk(v, key);
      }
      return out;
    }
    if (typeof node === "string" && parentKey && vocab.enums.has(parentKey)) {
      const table = vocab.enums.get(parentKey)!;
      if ([...table.values()].some((vals) => vals.includes(node))) return node; // already valid
      const hits = table.get(node);
      if (hits && hits.length === 1) {
        bump(`value ${parentKey}=${hits[0]}`);
        return hits[0]!;
      }
      if (hits && hits.length > 1) ambiguous.add(`value ${parentKey}=${node}`);
    }
    return node;
  };
  const value = walk(raw, null);
  return {
    value,
    notes: [...counts].map(([k, n]) => `${k} (${n})`),
    ambiguous: [...ambiguous],
  };
}
