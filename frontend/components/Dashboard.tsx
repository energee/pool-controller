// The dashboard root: drives the 3s poll via useDashboard and lays out the
// at-a-glance summary bar (all live readings + alerts), then one card per
// control surface — primary controls first (Circuits, Heat, Chlorinator,
// Schedules), then system (Pumps & clock), then the experimental/conditional
// cards (IntelliChem, Lights, Valves, Names), and finally the collapsed Raw card.
// Live readings live only in the summary bar; cards carry controls + their own
// private readings (salt, pH, watts), so nothing is shown twice.
import { useDashboard } from "../hooks/useDashboard";
import { Header } from "./Header";
import { SummaryBar } from "./SummaryBar";
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
        refresh={refresh}
      />
      <div className="max-w-[1080px] mx-auto p-5">
        <SummaryBar status={s.status} />
        <main className="grid gap-3.5 grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
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
          <IntelliChemCard chem={s.intellichem} />
          <LightsCard refresh={refresh} />
          <ValvesCard valves={s.valves} />
          <NamesCard names={s.names} />
          <RawCard raw={s.raw} />
        </main>
      </div>
    </>
  );
}
