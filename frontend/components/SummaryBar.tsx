// The summary bar: the dashboard's single at-a-glance strip. Holds every live
// reading (Pool / Spa / Air / Solar / Heater), the "On now" chips, and a
// freeze/service safety alert. Read-only — safe to re-render on every poll
// (it never holds an edit). Cards below own controls, not readings.
import type { Status } from "../types";
import { temp } from "../lib/format";
import { Badge } from "./ui/badge";

function Stat({
  label,
  children,
  sm,
}: {
  label: string;
  children: React.ReactNode;
  sm?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-3">
      <div className="text-[11px] text-muted-foreground tracking-[0.04em] uppercase">
        {label}
      </div>
      <div
        className={
          sm
            ? "text-sm font-medium mt-1.5"
            : "text-[22px] font-medium mt-0.5 tracking-tight"
        }
      >
        {children}
      </div>
    </div>
  );
}

export function SummaryBar({ status }: { status?: Status | null }) {
  if (!status) {
    return (
      <section className="grid gap-2.5 mb-[18px] grid-cols-[repeat(auto-fit,minmax(124px,1fr))]">
        <Stat label="Status" sm>
          waiting…
        </Stat>
      </section>
    );
  }
  const u = status.unit || "F";
  const names = status.circuit_names || [];
  return (
    <section className="grid gap-2.5 mb-[18px] grid-cols-[repeat(auto-fit,minmax(124px,1fr))]">
      <Stat label="Pool">{temp(status.pool_temp, u)}</Stat>
      <Stat label="Spa">{temp(status.spa_temp, u)}</Stat>
      <Stat label="Air">{temp(status.air_temp, u)}</Stat>
      {status.solar_temp != null ? (
        <Stat label="Solar">{temp(status.solar_temp, u)}</Stat>
      ) : null}
      <Stat label="Heater" sm>
        {status.heater_on ? "On" : "Off"}
      </Stat>
      {status.freeze || status.service ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-3">
          <div className="text-[11px] text-destructive tracking-[0.04em] uppercase">
            Alert
          </div>
          <div className="text-sm font-medium mt-1.5 text-destructive">
            {[
              status.freeze ? "Freeze protect" : null,
              status.service ? "Service mode" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      ) : null}
      <div className="rounded-lg border border-border bg-card px-3.5 py-3">
        <div className="text-[11px] text-muted-foreground tracking-[0.04em] uppercase">
          On now
        </div>
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {names.length ? (
            names.map((n) => (
              <span
                key={n}
                className="text-[11px] text-primary bg-primary/15 border border-primary/25 rounded-full px-2 py-0.5"
              >
                {n}
              </span>
            ))
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              all off
            </Badge>
          )}
        </div>
      </div>
    </section>
  );
}
