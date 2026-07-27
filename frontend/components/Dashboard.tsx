// The dashboard root: drives the 3s poll via useDashboard and lays out a
// freeze/service alert banner (only when active), then one card per control
// surface — the live system scene first, then primary controls (Equipment,
// Heat, Chlorinator, Schedules), system details (Pumps & clock), and Lights.
// There is no separate summary strip: the Equipment tiles and thermostat *are*
// the at-a-glance readings (temps, what's running, heater state), so nothing is
// shown twice. The unverified reverse-engineering surfaces (IntelliChem, Valves,
// Names — shown only when their data exists — plus Raw frames) live behind a
// collapsed Diagnostics disclosure so a pool owner sees ~5 cards, not 10.
import { useDashboard } from "../hooks/useDashboard";
import { Header } from "./Header";
import { Disclosure } from "./primitives";
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
import { PoolSceneCard } from "./scene/PoolSceneCard";

const GRID = "grid gap-x-6 gap-y-5 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]";

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
        <main className={GRID}>
          <PoolSceneCard state={state} connected={connected} />
          <CircuitsCard status={s.status} refresh={refresh} />
          <HeatCard heat={s.heat} refresh={refresh} />
          <ChlorinatorCard chlor={s.chlorinator} refresh={refresh} />
          <SchedulesCard schedules={s.schedules} refresh={refresh} />
          {/* Both full-width bands: Lights sits right under Pumps & clock. */}
          <PumpsCard
            pumps={s.pumps}
            datetime={s.datetime}
            version={s.version}
            refresh={refresh}
          />
          <LightsCard />
          <Disclosure title="Diagnostics" className="col-span-full">
            {/* Each card hides itself while its data is absent — no guards here. */}
            <div className={`mt-3.5 ${GRID}`}>
              <IntelliChemCard chem={s.intellichem} />
              <ValvesCard valves={s.valves} />
              <NamesCard names={s.names} />
              <RawCard raw={s.raw} />
            </div>
          </Disclosure>
        </main>
      </div>
    </>
  );
}
