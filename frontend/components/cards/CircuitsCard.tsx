// Equipment card: every circuit is a tap-anywhere tile (the tile *is* the
// switch — state shown as a color + verb, amber pulse while the bus confirms).
// Pool and Spa lead with their temps; the aux/feature circuits are the same
// tile, just with nothing extra to say. A heating pool shows its verb in red.
// Toggling calls GET /circuit/<n>/<on|off>; command() blocks until the server
// confirms (or 202s), which is exactly the window the pending style covers. A
// 202 -- sent, never confirmed by the controller -- holds the tile amber and
// static instead of letting the next poll silently snap it back.
import * as React from "react";

import { command } from "../../lib/api";
import { CIRCUITS, CIRCUIT_NUMBERS } from "../../lib/constants";
import { temp as fmtTemp } from "../../lib/format";
import type { Status } from "../../types";
import { cn } from "../../lib/utils";
import { DashCard } from "../primitives";

const SPA = CIRCUIT_NUMBERS.spa;
const POOL = CIRCUIT_NUMBERS.pool;

export function CircuitsCard({
  status,
  refresh,
}: {
  status?: Status | null;
  refresh: () => Promise<void>;
}) {
  const on = (status && status.circuits_on) || [];
  const [pending, setPending] = React.useState<number | null>(null);
  // Last command the controller never confirmed (202), with the state it asked
  // for. Without this the tile just snaps back on the next poll and the only
  // explanation is a toast that has already faded.
  const [unconfirmed, setUnconfirmed] = React.useState<{
    num: number;
    want: boolean;
  } | null>(null);

  // Derived, not stored: the moment a later poll shows the circuit did reach the
  // requested state, the command landed late and the mark clears itself.
  const stuck =
    unconfirmed && on.includes(unconfirmed.num) !== unconfirmed.want
      ? unconfirmed.num
      : null;

  const toggle = async (num: number) => {
    const next = !on.includes(num); // a toggle always requests the opposite state
    setPending(num);
    setUnconfirmed(null);
    try {
      // Circuits are binary here: 200 {confirmed} or 202 {accepted}, nothing
      // in between (server/api.ts circuit()), so absence of confirmed is real.
      const verdict = await command(
        "/circuit/" + num + "/" + (next ? "on" : "off")
      );
      await refresh();
      if (!verdict?.confirmed) setUnconfirmed({ num, want: next });
    } finally {
      setPending(null);
    }
  };

  const unit = status?.unit || "F";
  // Full-width band: two rows flowing column-by-column (Pool over Spa first),
  // so the tall tile stack no longer sets the page grid's first-row height.
  // Phones keep the old two-column stack — ten tiles across two rows would be
  // unreadably narrow there.
  return (
    <DashCard title="Equipment" className="col-span-full">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-flow-col sm:grid-rows-2 sm:auto-cols-fr">
        <Tile
          label="Pool"
          temp={status?.pool_temp}
          unit={unit}
          on={on.includes(POOL)}
          verb={on.includes(POOL) ? (status?.heater_on ? "Heating" : "Filtering") : "Off"}
          hot={Boolean(on.includes(POOL) && status?.heater_on)}
          pending={pending === POOL}
          unconfirmed={stuck === POOL}
          onToggle={() => toggle(POOL)}
        />
        <Tile
          label="Spa"
          temp={status?.spa_temp}
          unit={unit}
          on={on.includes(SPA)}
          verb={on.includes(SPA) ? "Running" : "Off"}
          pending={pending === SPA}
          unconfirmed={stuck === SPA}
          onToggle={() => toggle(SPA)}
        />
        {/* Everything that isn't pool/spa: same tile, nothing extra to say. */}
        {CIRCUITS.filter(([num]) => num !== POOL && num !== SPA).map(
          ([num, name]) => (
            <Tile
              key={num}
              label={name}
              unit={unit}
              on={on.includes(num)}
              verb={on.includes(num) ? "On" : "Off"}
              pending={pending === num}
              unconfirmed={stuck === num}
              onToggle={() => toggle(num)}
            />
          )
        )}
      </div>
    </DashCard>
  );
}

function Tile({
  label,
  temp,
  unit,
  on,
  verb,
  hot,
  pending,
  unconfirmed,
  onToggle,
}: {
  label: string;
  temp?: number | null;
  unit: string;
  on: boolean;
  verb: string;
  /** Actively heating — the verb reads in red instead of the accent color. */
  hot?: boolean;
  pending: boolean;
  /** Controller never confirmed the last command — held amber, no pulse. */
  unconfirmed?: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="switch"
      aria-checked={on}
      // aria-label wins over the tile's text, so the mark has to be said here
      // too or it is sighted-only.
      aria-label={unconfirmed ? label + " — last command not confirmed" : label}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      className={cn(
        "rounded-lg px-3 py-2 cursor-pointer select-none transition-colors",
        pending
          ? "bg-warning/15 animate-pulse"
          : unconfirmed
            ? // Same amber as pending but static and outlined: the round trip is
              // over, the tile just does not agree with what was asked for.
              "bg-warning/15 ring-1 ring-warning/40 hover:bg-warning/25"
            : on
              ? "bg-success/15 hover:bg-success/25" // on = green, matching the pill dot
              : "bg-popover hover:bg-accent"
      )}
    >
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="text-lg font-medium tracking-tight">
          {temp != null ? fmtTemp(temp, unit) : ""}
        </span>
      </div>
      <div
        className={cn(
          "mt-0.5 text-[12px]",
          unconfirmed
            ? "text-warning"
            : pending || !on
              ? "text-muted-foreground"
              : hot
                ? "text-destructive" // "Heating" stays red — red always means heat
                : "text-success"
        )}
      >
        {pending ? "confirming…" : unconfirmed ? "not confirmed" : verb}
      </div>
    </div>
  );
}
