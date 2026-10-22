/**
 * Text normalisation for search and intent detection (pure). Case- and diacritic-insensitive for
 * Latin script; for Urdu script it removes vowel marks (harakat), folds Arabic letter forms to the
 * Urdu ones (ي/ى → ی, ك → ک, ه → ہ) and Urdu digits to ASCII. Punctuation becomes a space.
 */
const FOLD = new Map<string, string>([
  ["ي", "ی"], // Arabic yeh → Farsi/Urdu yeh
  ["ى", "ی"], // alef maksura → Urdu yeh
  ["ك", "ک"], // Arabic kaf → keheh
  ["ه", "ہ"], // Arabic heh → heh goal
  ["ۀ", "ہ"], // heh with yeh above (decomposes anyway) → heh goal
]);

export function normalizeText(s: string): string {
  const decomposed = s.normalize("NFKD").replace(/\p{M}/gu, "");
  let out = "";
  for (const ch of decomposed.toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code >= 0x200b && code <= 0x200f) || code === 0x0640) continue; // zero-width marks and tatweel
    if (code >= 0x06f0 && code <= 0x06f9) out += String.fromCodePoint(code - 0x06f0 + 0x30);
    else if (code >= 0x0660 && code <= 0x0669) out += String.fromCodePoint(code - 0x0660 + 0x30);
    else out += FOLD.get(ch) ?? ch;
  }
  return out
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * True when `kw` (already normalised) occurs in `text` (already normalised) at a word start and ends
 * at a word end or at most `slack` letters before it ("rent" matches "rents", not "parent").
 */
export function hasWord(text: string, kw: string, slack = 3): boolean {
  if (kw.length === 0) return false;
  const hay = ` ${text} `;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(` ${kw}`, from);
    if (i < 0) return false;
    const end = i + 1 + kw.length;
    const next = hay.indexOf(" ", end);
    if (next - end <= slack) return true;
    from = i + 1;
  }
}
