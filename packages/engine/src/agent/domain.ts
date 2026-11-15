import { domainToUnicode } from "node:url";

/**
 * Sender-domain comparison for R-DOM / R-SRC: IDNA (punycode) decoding, then a confusables skeleton in the spirit of
 * Unicode UTS #39 (a curated subset covering the Latin lookalikes that matter for vendor domains: Cyrillic and Greek
 * homoglyphs, digit-for-letter swaps, and "rn"→"m"), then Levenshtein distance.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "а": "a", "в": "b", "с": "c", "ԁ": "d", "е": "e", "һ": "h", "і": "i", "ј": "j", "к": "k", "ӏ": "l", "м": "m",
  "о": "o", "р": "p", "ԛ": "q", "ѕ": "s", "т": "t", "ս": "u", "ѵ": "v", "ԝ": "w", "х": "x", "у": "y", "ү": "y",
  // Greek
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  // digits and look-alike Latin
  "0": "o", "1": "l", "3": "e", "5": "s", "ı": "i", "ł": "l", "ⅼ": "l", "|": "l",
};

export function skeleton(domain: string): string {
  let d = domain.trim().toLowerCase().replace(/\.$/, "");
  const uni = domainToUnicode(d);
  if (uni) d = uni;
  d = d.normalize("NFKC");
  let out = "";
  for (const ch of d) out += CONFUSABLES[ch] ?? ch;
  return out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/i/g, "l");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

export const domainOf = (addr: string): string => (addr.split("@")[1] ?? addr).trim().toLowerCase();

/** A lookalike: not the vendor's exact domain, but within skeleton distance ≤ 2 of it (distance 0 counts). */
export function isLookalike(sender: string, vendorDomain: string): boolean {
  const s = sender.trim().toLowerCase();
  const v = vendorDomain.trim().toLowerCase();
  if (s === v) return false;
  return levenshtein(skeleton(s), skeleton(v)) <= 2;
}

/** Retrieval match: exact or lookalike. */
export const isNearDomain = (sender: string, vendorDomain: string): boolean =>
  sender.trim().toLowerCase() === vendorDomain.trim().toLowerCase() || isLookalike(sender, vendorDomain);
