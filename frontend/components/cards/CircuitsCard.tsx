// Equipment card: every circuit is a tap-anywhere tile (the tile *is* the
// switch — state shown as a color + verb, amber pulse while the bus confirms).
// Pool and Spa lead with their temps; the aux/feature circuits are the same
// tile, just with nothing extra to say. A pool that is actually calling for
// heat (see isHeating — the raw heater_on bit alone is not enough) shows its
// verb in red; a pool merely circulating reads "Filtering".
// Toggling calls GET /circuit/<n>/<on|off>; command() blocks until the server
// confirms (or 202s), which is exactly the window the pending style covers.
import * as React from "react";

import { command } from "../../lib/api";
import { CIRCUITS, CIRCUIT_NUMBERS } from "../../lib/constants";
import { temp as fmtTemp } from "../../lib/format";
import { isHeating } from "../../lib/scene";
import type { Heat, Status } from "../../types";
import { cn } from "../../lib/utils";
import { DashCard } from "../primitives";

const SPA = CIRCUIT_NUMBERS.spa;
const POOL = CIRCUIT_NUMBERS.pool;

export function CircuitsCard({
  status,
  heat,
  refresh,
}: {
  status?: Status | null;
  /** Set-points, needed to tell "heater enabled" from "actually heating". */
  heat?: Heat | null;
  refresh: () => Promise<void>;
}) {
  const on = (status && status.circuits_on) || [];
  const [pending, setPending] = React.useState<number | null>(null);

  const toggle = async (num: number) => {
    const next = !on.includes(num); // a toggle always requests the opposite state
    setPending(num);
    try {
      await command("/circuit/" + num + "/" + (next ? "on" : "off"));
      await refresh();
    } finally {
      setPending(null);
    }
  };

  const unit = status?.unit || "F";
  // "Heating" means the burner is actually called for — not just that the
  // controller's heater bit is set (it also reads true for the spa's mode).
  const poolHeating = isHeating(status, heat, "pool");
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
          verb={on.includes(POOL) ? (poolHeating ? "Heating" : "Filtering") : "Off"}
          hot={Boolean(on.includes(POOL) && poolHeating)}
          pending={pending === POOL}
          onToggle={() => toggle(POOL)}
        />
        <Tile
          label="Spa"
          temp={status?.spa_temp}
          unit={unit}
          on={on.includes(SPA)}
          verb={on.includes(SPA) ? "Running" : "Off"}
          pending={pending === SPA}
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
  onToggle: () => void;
}) {
  return (
    <div
      role="switch"
      aria-checked={on}
      aria-label={label}
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
          pending || !on
            ? "text-muted-foreground"
            : hot
              ? "text-destructive" // "Heating" stays red — red always means heat
              : "text-success"
        )}
      >
        {pending ? "confirming…" : verb}
      </div>
    </div>
  );
}
