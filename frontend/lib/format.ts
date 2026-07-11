// Small formatting helpers ported from the former dom.ts.

// Temperature with a degree suffix; em-dash when absent.
export function temp(t: number | null | undefined, u?: string): string {
  return t == null ? "—" : t + "°" + (u || "F");
}

// Coerce a possibly-null/undefined value to a display string.
export function disp(v: unknown): string {
  return v == null ? "" : String(v);
}

// Convert an embedded 24h "HH:MM" (as the controller reports) to "h:MM AM/PM".
// Works on a bare clock ("17:00") or a dated one ("2026-06-17 14:30"); the date
// has no colon so only the time matches. Empty/unmatched input is unchanged.
// Editor <input type="time"> values stay 24h — only read-only display converts.
export function time12(t: string | null | undefined): string {
  if (!t) return "";
  return t.replace(/(\d{1,2}):(\d{2})/, (_, h, m) => {
    const n = Number(h);
    return (n % 12 || 12) + ":" + m + " " + (n < 12 ? "AM" : "PM");
  });
}
