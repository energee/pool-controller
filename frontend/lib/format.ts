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
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(iso ?? "");
  if (!m) return time12(iso);
  const [y, mo, d, h, min] = m.slice(1).map(Number) as [
    number, number, number, number, number,
  ];
  const when = new Date(y, mo - 1, d, h, min);
  const clock = (h % 12 || 12) + ":" + String(min).padStart(2, "0") +
    (h < 12 ? " AM" : " PM");
  const days = Math.round((midnight(when) - midnight(now)) / DAY_MS);
  const day =
    days === 0 ? "Today"
    : days === -1 ? "Yesterday"
    : days === 1 ? "Tomorrow"
    : when.toLocaleDateString(undefined, {
        weekday: "short", month: "short", day: "numeric",
      });
  return day + " " + clock;
}
