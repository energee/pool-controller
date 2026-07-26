// Sticky header: the Pentair logo, the easytouch mark, and the connection pill
// (dot + status text). No manual Refresh button — the app polls every 3s, so the
// pill's freshness reading is the whole story. The logo is `frontend/pentair.svg`,
// copied into static/ by `bun run build` and served from /static/.
// Two independent facts drive the pill: `reachable` (the poll
// reached the backend) and `busConnected` (the backend is talking to the pool
// controller). Pill reads "connected · Ns ago" only when both hold, "disconnected"
// when the backend is up but the bus is down, and "unreachable" when the poll fails.
import { cn } from "../lib/utils";

export function Header({
  reachable,
  busConnected,
  age,
  error,
}: {
  reachable: boolean;
  busConnected: boolean;
  age: number | null;
  error: string | null;
}) {
  // Green only when the bus is connected AND the snapshot is fresh (<30s).
  const live = reachable && busConnected && (age == null || age < 30);
  const ageText = age == null ? "no packets yet" : Math.round(age) + "s";
  const text = !reachable
    ? "unreachable" + (error ? ": " + error : "")
    : busConnected
      ? "connected · " + ageText + (error ? " · " + error : "")
      : "disconnected" + (error ? ": " + error : "");

  return (
    <header className="sticky top-0 z-10 flex flex-col items-center gap-1.5 px-5 py-3 bg-background/70 backdrop-blur">
      {/* The mark's fills are hardcoded navy/green — near-invisible on this dark
          theme — so knock it out to solid white. */}
      <img
        src="/static/pentair.svg"
        alt="Pentair"
        className="h-5 w-auto shrink-0 brightness-0 invert"
      />
      <span className="text-[15px] font-semibold tracking-tight leading-none">
        easytouch
      </span>
      {/* min-w-0 + truncate: long error strings shorten instead of wrapping the
          pill onto two lines; tabular-nums keeps "12s" from jittering the width. */}
      <span className="inline-flex min-w-0 items-center gap-2 text-[13px] font-medium leading-none text-foreground/85 bg-accent rounded-full px-3 py-1.5">
        <span
          className={cn(
            "w-[7px] h-[7px] shrink-0 rounded-full",
            live
              ? "bg-success shadow-[0_0_0_3px_rgba(76,195,138,0.16)]"
              : "bg-destructive shadow-[0_0_0_3px_rgba(229,83,75,0.16)]"
          )}
        />
        <span className="truncate whitespace-nowrap tabular-nums">{text}</span>
      </span>
    </header>
  );
}
