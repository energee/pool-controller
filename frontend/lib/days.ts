// Round-trip between the controller's day representation and the editor chips.
// decode_days emits ["Every day"] or ["Mon","Wed",...]; the /schedule encoder
// accepts a comma list of abbrevs ("mon,wed") or "every". DAYS holds the tokens.
import { DAYS } from "./constants";

// Day list (as decoded) -> set of selected tokens for the chip UI.
export function daysToSet(days?: string[]): Set<string> {
  const s = new Set<string>();
  if (!days || !days.length) return s;
  if (days.some((d) => d.toLowerCase().startsWith("every"))) {
    DAYS.forEach(([tok]) => s.add(tok));
    return s;
  }
  DAYS.forEach(([tok]) => {
    if (days.some((d) => d.toLowerCase().startsWith(tok))) s.add(tok);
  });
  return s;
}

// Selected token set -> the string /schedule expects ("every" when all 7).
export function setToDays(s: Set<string>): string {
  if (s.size === DAYS.length) return "every";
  return DAYS.filter(([tok]) => s.has(tok))
    .map(([tok]) => tok)
    .join(",");
}
