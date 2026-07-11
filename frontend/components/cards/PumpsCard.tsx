// Pumps & clock card. Lists reporting pumps + controller clock/firmware, a
// "Set clock to now" button (POST /datetime {}), and an EXPERIMENTAL direct pump
// RPM control (POST /pump {pump, rpm}) whose fields are edit-guarded local state.
import * as React from "react";

import { postJSON } from "../../lib/api";
import { time12 } from "../../lib/format";
import type { Pump, State } from "../../types";
import { DashCard, ExperimentalBadge, Grid2, Muted, Row } from "../primitives";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

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

  const setClock = async () => {
    await postJSON("/datetime", {});
    await refresh();
  };
  const setPump = async () => {
    await postJSON("/pump", { pump: Number(pumpN), rpm: Number(pumpRpm) });
    await refresh();
  };

  return (
    <DashCard title="Pumps & clock">
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
      {datetime ? <Row k="Controller clock">{time12(datetime.iso)}</Row> : null}
      {version ? <Row k="Firmware">{version.version ?? ""}</Row> : null}
      <Button variant="outline" className="mt-2.5" onClick={setClock}>
        Set clock to now
      </Button>

      {/* EXPERIMENTAL: direct pump RPM (unverified; may contend with controller). */}
      <div className="mt-3 space-y-1.5">
        <Label className="flex items-center">
          Pump # / RPM
          <ExperimentalBadge />
        </Label>
        <Grid2>
          <Input
            id="pump_n"
            type="number"
            min={1}
            max={4}
            value={pumpN}
            onChange={(e) => setPumpN(e.target.value)}
          />
          <Input
            id="pump_rpm"
            type="number"
            value={pumpRpm}
            onChange={(e) => setPumpRpm(e.target.value)}
          />
        </Grid2>
      </div>
      <Button variant="outline" className="mt-2.5" onClick={setPump}>
        Set RPM (experimental)
      </Button>
    </DashCard>
  );
}
