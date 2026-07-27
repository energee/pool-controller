// Small formatting helpers ported from the former dom.ts.

// Temperature with a degree suffix; em-dash when absent.
export function temp(t: number | null | undefined, u?: string): string {
  return t == null ? "—" : t + "°" + (u || "F");
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

const DAY_MS = 86_400_000;
const midnight = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// Render the controller's dated clock ("2026-07-26 10:13") the way someone would
// say it: "Today 10:13 AM". The date is only worth spelling out when it *isn't*
// today — and a controller whose clock has drifted a day reads much clearer as
// "Yesterday 11:58 PM" than as a raw ISO date. `now` is injectable for tests.
// Falls back to time12() for a bare "HH:MM" or anything unparseable.
export function clock12(
  iso: string | null | undefined,
  now: Date = new Date()
): string {
  // The clock is one group so time12() owns the 12-hour rule for both callers.
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}:\d{2})/.exec(iso ?? "");
  if (!m) return time12(iso);
  const midnightOf = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = Math.round((midnightOf.getTime() - midnight(now)) / DAY_MS);
  const day =
    days === 0 ? "Today"
    : days === -1 ? "Yesterday"
    : days === 1 ? "Tomorrow"
    : midnightOf.toLocaleDateString(undefined, {
        weekday: "short", month: "short", day: "numeric",
      });
  return day + " " + time12(m[4]);
}
