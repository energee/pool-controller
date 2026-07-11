// Sticky header: the easytouch mark, the connection pill (dot + status text),
// and a Refresh button. Two independent facts drive it: `reachable` (the poll
// reached the backend) and `busConnected` (the backend is talking to the pool
// controller). Pill reads "connected · Ns ago" only when both hold, "disconnected"
// when the backend is up but the bus is down, and "unreachable" when the poll fails.
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export function Header({
  reachable,
  busConnected,
  age,
  error,
  refresh,
}: {
  reachable: boolean;
  busConnected: boolean;
  age: number | null;
  error: string | null;
  refresh: () => Promise<void>;
}) {
  // Green only when the bus is connected AND the snapshot is fresh (<30s).
  const live = reachable && busConnected && (age == null || age < 30);
  const ageText =
    age == null ? "no packets yet" : Math.round(age) + "s ago";
  const text = !reachable
    ? "unreachable" + (error ? ": " + error : "")
    : busConnected
      ? "connected · " + ageText + (error ? " · " + error : "")
      : "disconnected" + (error ? ": " + error : "");

  return (
    <header className="sticky top-0 z-10 flex items-center gap-3 px-5 py-3 bg-background/70 backdrop-blur border-b border-border">
      <span className="text-[15px] font-semibold tracking-tight">easytouch</span>
      <span className="inline-flex items-center gap-2 text-xs text-muted-foreground bg-popover border border-border rounded-full px-2.5 py-1">
        <span
          className={cn(
            "w-[7px] h-[7px] rounded-full",
            live
              ? "bg-success shadow-[0_0_0_3px_rgba(76,195,138,0.16)]"
              : "bg-destructive shadow-[0_0_0_3px_rgba(229,83,75,0.16)]"
          )}
        />
        <span>{text}</span>
      </span>
      <span className="flex-1" />
      <Button variant="outline" size="sm" onClick={refresh}>
        Refresh
      </Button>
    </header>
  );
}
