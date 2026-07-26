// Heat card, thermostat-style: a Pool/Spa tab bar over one body at a time, each
// a "current → target" readout with −/+ steppers and a segmented mode control.
// There is no Apply button — stepper taps settle for 1.2s and then auto-send
// (the Nest model), mode taps send immediately. Both bodies' targets live in
// local state regardless of which tab shows, so switching tabs never drops an
// in-flight adjustment and the 3s poll never clobbers one; postJSON surfaces
// the controller's confirmed/accepted verdict as a toast.
import * as React from "react";
import { Minus, Plus } from "lucide-react";

import { postJSON } from "../../lib/api";
import { MODES } from "../../lib/constants";
import type { Heat } from "../../types";
import { cn } from "../../lib/utils";
import { DashCard, Muted } from "../primitives";
import { Button } from "../ui/button";

const SETPOINT_MIN = 40;
const SETPOINT_MAX = 104;
const SETTLE_MS = 1200; // send this long after the last stepper tap

export function HeatCard({
  heat,
  refresh,
}: {
  heat?: Heat | null;
  refresh: () => Promise<void>;
}) {
  if (!heat) {
    // Heat isn't broadcast unsolicited — the server has to request it, so on a
    // healthy bus it appears within one ~15s refresh cycle. If the bus itself is
    // down, the header pill (not this card) says so.
    return (
      <DashCard title="Heat">
        <Muted>requested from the controller — usually appears within ~15 s</Muted>
      </DashCard>
    );
  }
  return <Thermostat heat={heat} refresh={refresh} />;
}

function Thermostat({
  heat,
  refresh,
}: {
  heat: Heat;
  refresh: () => Promise<void>;
}) {
  const poolMode = (heat.heat_mode_raw || 0) & 0x03;
  const spaMode = ((heat.heat_mode_raw || 0) >> 2) & 0x03;

  const [tab, setTab] = React.useState<"pool" | "spa">("pool");
  const [poolSp, setPoolSp] = React.useState(heat.pool_setpoint ?? 0);
  const [spaSp, setSpaSp] = React.useState(heat.spa_setpoint ?? 0);
  const [dirty, setDirty] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // The debounce callback reads targets from a ref so it always sends the
  // latest taps, not the values captured when the timer was armed.
  const latest = React.useRef({ poolSp, spaSp });
  latest.current = { poolSp, spaSp };

  // Re-seed from the controller whenever we're not mid-adjustment.
  React.useEffect(() => {
    if (!dirty && !sending) {
      setPoolSp(heat.pool_setpoint ?? 0);
      setSpaSp(heat.spa_setpoint ?? 0);
    }
  }, [heat.pool_setpoint, heat.spa_setpoint, dirty, sending]);

  const send = React.useCallback(
    async (fields: Record<string, number>) => {
      setSending(true);
      try {
        await postJSON("/heat", fields);
        await refresh();
      } finally {
        setSending(false);
        setDirty(false);
      }
    },
    [refresh]
  );

  const nudge = (which: "pool" | "spa", delta: number) => {
    const set = which === "pool" ? setPoolSp : setSpaSp;
    set((v) => Math.min(SETPOINT_MAX, Math.max(SETPOINT_MIN, v + delta)));
    setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void send({
        pool_setpoint: latest.current.poolSp,
        spa_setpoint: latest.current.spaSp,
      });
    }, SETTLE_MS);
  };

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  // Mode taps send immediately — they're discrete choices, not a dial.
  const setMode = (which: "pool" | "spa", mode: number) =>
    void send({ [`${which}_mode`]: mode });

  return (
    <DashCard title="Heat">
      {/* Pool/Spa tabs; the hidden body's state (and any pending send) lives on. */}
      <div role="tablist" className="mb-2 grid grid-cols-2 gap-1 rounded-md bg-popover p-1">
        {(["pool", "spa"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded px-3 py-1.5 text-[13px] font-medium capitalize transition-colors",
              tab === t
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "pool" ? (
        <BodyRow
          label="Pool"
          current={heat.pool_temp}
          target={poolSp}
          mode={poolMode}
          pending={dirty || sending}
          onNudge={(d) => nudge("pool", d)}
          onMode={(m) => setMode("pool", m)}
        />
      ) : (
        <BodyRow
          label="Spa"
          current={heat.spa_temp}
          target={spaSp}
          mode={spaMode}
          pending={dirty || sending}
          onNudge={(d) => nudge("spa", d)}
          onMode={(m) => setMode("spa", m)}
        />
      )}
      {/* Air lives here since the summary bar is gone; it informs the heat call. */}
      {heat.air_temp != null ? (
        <Muted className="mt-2">Air {heat.air_temp}°</Muted>
      ) : null}
    </DashCard>
  );
}

function BodyRow({
  label,
  current,
  target,
  mode,
  pending,
  onNudge,
  onMode,
  className,
}: {
  label: string;
  current?: number | null;
  target: number;
  mode: number;
  pending: boolean;
  onNudge: (delta: number) => void;
  onMode: (mode: number) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[11px] text-muted-foreground tracking-[0.04em] uppercase">
            {label}
          </div>
          <div className="text-[22px] font-medium tracking-tight">
            {current ?? "–"}°
            <span className="text-muted-foreground text-sm font-normal">
              {" "}
              →{" "}
            </span>
            <span className={cn(pending && "text-destructive animate-pulse")}>
              {target}°
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            className="h-9 w-11 px-0"
            aria-label={label + " setpoint down"}
            onClick={() => onNudge(-1)}
          >
            <Minus />
          </Button>
          <Button
            variant="outline"
            className="h-9 w-11 px-0"
            aria-label={label + " setpoint up"}
            onClick={() => onNudge(+1)}
          >
            <Plus />
          </Button>
        </div>
      </div>
      {/* Segmented mode control: the selected segment doubles as the read-out.
          Heat is red — a selected heating mode fills warm; a selected "Off" stays
          neutral so red always means "making heat". */}
      <div className="mt-1.5 grid grid-cols-4 gap-1">
        {MODES.map(([v, name]) => (
          <Button
            key={v}
            variant="outline"
            size="sm"
            className={cn(
              "px-0 text-xs",
              v === mode &&
                (v === 0
                  ? "bg-[#22252b] text-foreground"
                  : "bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/80")
            )}
            onClick={() => v !== mode && onMode(v)}
          >
            {name}
          </Button>
        ))}
      </div>
    </div>
  );
}
