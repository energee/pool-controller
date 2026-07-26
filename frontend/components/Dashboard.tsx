// The dashboard root: drives the 3s poll via useDashboard and lays out a
// freeze/service alert banner (only when active), then one card per control
// surface — primary controls first (Equipment, Heat, Chlorinator, Schedules),
// then system (Pumps & clock) and Lights. There is no separate summary strip:
// the Equipment tiles and thermostat *are* the at-a-glance readings (temps,
// what's running, heater state), so nothing is shown twice. The unverified
// reverse-engineering surfaces (IntelliChem, Valves, Names — shown only when
// their data exists — plus Raw frames) live behind a collapsed Diagnostics
// disclosure so a pool owner sees ~5 cards, not 10.
import { useDashboard } from "../hooks/useDashboard";
import { Header } from "./Header";
import { ChlorinatorCard } from "./cards/ChlorinatorCard";
import { CircuitsCard } from "./cards/CircuitsCard";
import { HeatCard } from "./cards/HeatCard";
import { IntelliChemCard } from "./cards/IntelliChemCard";
import { LightsCard } from "./cards/LightsCard";
import { NamesCard } from "./cards/NamesCard";
import { PumpsCard } from "./cards/PumpsCard";
import { RawCard } from "./cards/RawCard";
import { SchedulesCard } from "./cards/SchedulesCard";
import { ValvesCard } from "./cards/ValvesCard";

export function Dashboard() {
  const { state, connected, error, age, refresh } = useDashboard();
  const s = state || {};

  return (
    <>
      <Header
        reachable={connected}
        busConnected={state?.connected ?? false}
        age={age}
        error={error}
        logoTreatment="invert" // "invert" | "brand" | "chip" — see Header.tsx
      />
      <div className="max-w-[1080px] mx-auto p-5">
        {s.status?.freeze || s.status?.service ? (
          <div className="mb-3.5 rounded-lg bg-destructive/15 px-3.5 py-2.5 text-sm font-medium text-destructive">
            {[
              s.status.freeze ? "Freeze protect active" : null,
              s.status.service ? "Service mode" : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        ) : null}
        <main className="grid gap-x-6 gap-y-5 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
          <CircuitsCard status={s.status} refresh={refresh} />
          <HeatCard heat={s.heat} refresh={refresh} />
          <ChlorinatorCard chlor={s.chlorinator} refresh={refresh} />
          <SchedulesCard schedules={s.schedules} refresh={refresh} />
          <PumpsCard
            pumps={s.pumps}
            datetime={s.datetime}
            version={s.version}
            refresh={refresh}
          />
          <LightsCard refresh={refresh} />
          {/* Native <details>: open/closed survives the 3s re-render because React
              never touches the attribute after mount. */}
          <details className="col-span-full">
            <summary className="cursor-pointer py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground list-none hover:text-foreground">
              Diagnostics ▸
            </summary>
            <div className="mt-3.5 grid gap-x-6 gap-y-5 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
              {s.intellichem ? <IntelliChemCard chem={s.intellichem} /> : null}
              {s.valves ? <ValvesCard valves={s.valves} /> : null}
              {s.names && Object.keys(s.names).length ? (
                <NamesCard names={s.names} />
              ) : null}
              <RawCard raw={s.raw} />
            </div>
          </details>
        </main>
      </div>
    </>
  );
}
