// Pumps & clock card. Lists reporting pumps + controller clock/firmware; an
// inline sync icon on the clock row (POST /datetime {}) spins amber while the
// round-trip confirms. An EXPERIMENTAL direct pump RPM control (POST /pump
// {pump, rpm}) with edit-guarded local state sits behind a disclosure.
import * as React from "react";
import { RefreshCw } from "lucide-react";

import { postJSON } from "../../lib/api";
import { clock12 } from "../../lib/format";
import type { Pump, State } from "../../types";
import { cn } from "../../lib/utils";
import { DashCard, Disclosure, Grid2, Muted, Row } from "../primitives";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PumpsCard({
  pumps,
  datetime,
  version,
  refresh,
}: {
  pumps?: Record<string, Pump>;
  datetime?: { iso?: string } | null;
  version?: State["version"];
  refresh: () => Promise<void>;
}) {
  const map = pumps || {};
  const keys = Object.keys(map);

  const [pumpN, setPumpN] = React.useState("1");
  const [pumpRpm, setPumpRpm] = React.useState("2400");

  // Amber pulse on the clock value while the sync round-trips.
  const [syncing, setSyncing] = React.useState(false);
  const setClock = async () => {
    setSyncing(true);
    try {
      await postJSON("/datetime", {});
      await refresh();
    } finally {
      setSyncing(false);
    }
  };
  // No refresh after: /pump replies before the frame even reaches the bus, so a
  // refetch is guaranteed pre-command state — the 3s poll surfaces any change.
  const setPump = () =>
    void postJSON("/pump", { pump: Number(pumpN), rpm: Number(pumpRpm) });

  // Full-width band: pumps, clock/firmware, and the Pump Speed disclosure sit
  // side by side on wide screens and stack on phones.
  return (
    <DashCard title="Pumps & clock" className="col-span-full">
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          {!keys.length ? (
            <Muted>no pumps reporting</Muted>
          ) : (
            keys.map((k) => {
              const p = map[k];
              return (
                <div key={k} className="mb-2">
                  <div className="text-muted-foreground text-[13px]">
                    Pump {p.pump ?? k}
                  </div>
                  <Row k="Watts">{p.watts ?? ""}</Row>
                  <Row k="RPM">{p.rpm ?? ""}</Row>
                  <Row k="GPM">{p.gpm ?? ""}</Row>
                </div>
              );
            })
          )}
        </div>
        <div>
          {datetime ? (
            <Row k="Controller clock">
              <span className="inline-flex items-center gap-1.5">
                <span className={cn(syncing && "text-warning animate-pulse")}>
                  {clock12(datetime.iso)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground"
                  aria-label="Sync controller clock to now"
                  title="Sync clock to now"
                  disabled={syncing}
                  onClick={setClock}
                >
                  <RefreshCw className={cn(syncing && "animate-spin")} />
                </Button>
              </span>
            </Row>
          ) : null}
          {version ? <Row k="Firmware">{version.version ?? ""}</Row> : null}
        </div>

        {/* EXPERIMENTAL: direct pump RPM (unverified; may contend with controller). */}
        <Disclosure title="Pump Speed" experimental className="mt-3 lg:mt-0">
          <div className="mt-1.5 space-y-1.5">
            <Grid2>
              <Input
                id="pump_n"
                type="number"
                min={1}
                max={4}
                aria-label="Pump number"
                value={pumpN}
                onChange={(e) => setPumpN(e.target.value)}
              />
              <Input
                id="pump_rpm"
                type="number"
                aria-label="Pump RPM"
                value={pumpRpm}
                onChange={(e) => setPumpRpm(e.target.value)}
              />
            </Grid2>
            <Button variant="outline" className="mt-1" onClick={setPump}>
              Set RPM (experimental)
            </Button>
          </div>
        </Disclosure>
      </div>
    </DashCard>
  );
}
