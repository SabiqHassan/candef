/**
 * Deterministic label-width estimate for 12 px IBM Plex Sans, used only to reserve room for names in
 * the 2D layout. The layout must not depend on font loading or the browser (the same input gives the
 * same positions in Node, in every browser and at compile time), so it never measures real text.
 * Calibrated against canvas measurements of every demo name (bench/network2d): the estimate is at or
 * above the real width for almost all names, so reserved boxes rarely clip.
 */
const NARROW = new Set("iljtfrI.,:;'!|()[] -/");
const WIDE = new Set("mwMW@%&");
const ACCENTED = /[À-ɏ]/;

/** Estimated advance of `text` in CSS pixels at `fontPx`. */
export function estimateTextWidth(text: string, fontPx = 12): number {
  let em = 0;
  for (const ch of text) {
    if (NARROW.has(ch)) em += 0.29;
    else if (WIDE.has(ch)) em += 0.86;
    else if (ch >= "A" && ch <= "Z") em += 0.66;
    else if (ch >= "0" && ch <= "9") em += 0.58;
    else if (ACCENTED.test(ch)) em += 0.6;
    else em += 0.56;
  }
  return Math.ceil(em * fontPx);
}
