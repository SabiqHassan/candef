/**
 * Links to sources come from research files. Only web addresses may become links: a `javascript:`,
 * `data:` or `file:` address in a source record must never turn into something a click can run.
 * Used by the corpus schema (research that contains one fails to load) and by every place that
 * renders a source link (defence in depth: a snapshot is also a file that could be edited).
 */
export function isHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The address if it is safe to link to, otherwise null (render the text, not a link). */
export const safeHref = (raw: unknown): string | null => (isHttpUrl(raw) ? raw : null);
