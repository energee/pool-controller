// Equipment card: every circuit is a tap-anywhere tile (the tile *is* the
// switch — state shown as a color + verb, amber pulse while the bus confirms).
// Pool and Spa lead with their temps; the aux/feature circuits are the same
// tile, just with nothing extra to say. A heating pool shows its verb in red.
// Toggling calls GET /circuit/<n>/<on|off>; command() blocks until the server
// confirms (or 202s), which is exactly the window the pending style covers.
import * as React from "react";

import { command } from "../../lib/api";
import { CIRCUITS } from "../../lib/constants";
import type { Status } from "../../types";
import { cn } from "../../lib/utils";
import { DashCard } from "../primitives";

const SPA = 1;
const POOL = 6;

export function CircuitsCard({
  status,
  refresh,
}: {
  status?: Status | null;
  refresh: () => Promise<void>;
}) {
  const on = (status && status.circuits_on) || [];
  const [pending, setPending] = React.useState<number | null>(null);

  const toggle = async (num: number, checked: boolean) => {
    setPending(num);
    try {
      await command("/circuit/" + num + "/" + (checked ? "on" : "off"));
      await refresh();
    } finally {
      setPending(null);
    }
  };

  const unit = status?.unit || "F";
  return (
    <DashCard title="Equipment">
      <div className="grid grid-cols-2 gap-1.5">
        <Tile
          label="Pool"
          temp={status?.pool_temp}
          unit={unit}
          on={on.includes(POOL)}
          verb={on.includes(POOL) ? (status?.heater_on ? "Heating" : "Filtering") : "Off"}
          hot={Boolean(on.includes(POOL) && status?.heater_on)}
          pending={pending === POOL}
          onToggle={() => toggle(POOL, !on.includes(POOL))}
        />
        <Tile
          label="Spa"
          temp={status?.spa_temp}
          unit={unit}
          on={on.includes(SPA)}
          verb={on.includes(SPA) ? "Running" : "Off"}
          pending={pending === SPA}
          onToggle={() => toggle(SPA, !on.includes(SPA))}
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
              onToggle={() => toggle(num, !on.includes(num))}
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
          {temp != null ? temp + "°" + unit : ""}
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
