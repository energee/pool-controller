// Salt / Chlorinator card. Salt rides the IntelliChlor native protocol; output %
// is editable (local state, edit-guarded) and POSTed to /chlorinator. status_flags
// shown raw; an age line flags staleness (the cell only reports while running).
import * as React from "react";

import { postJSON } from "../../lib/api";
import type { Chlor } from "../../types";
import { DashCard, Grid2, Muted, Row, Tile } from "../primitives";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export function ChlorinatorCard({
  chlor,
  refresh,
}: {
  chlor?: Chlor | null;
  refresh: () => Promise<void>;
}) {
  if (!chlor) {
    return (
      <DashCard title="Salt / Chlorinator">
        <Muted>
          no recent salt data — the chlorinator only reports while the pool is
          running.
        </Muted>
      </DashCard>
    );
  }
  return <ChlorForm chlor={chlor} refresh={refresh} />;
}

function ChlorForm({
  chlor,
  refresh,
}: {
  chlor: Chlor;
  refresh: () => Promise<void>;
}) {
  const [out, setOut] = React.useState(
    String(chlor.output_percent == null ? 0 : chlor.output_percent)
  );

  const salt = chlor.salt_ppm == null ? "—" : chlor.salt_ppm + " ppm";
  const outDisp = chlor.output_percent == null ? "—" : chlor.output_percent + "%";

  const apply = async () => {
    await postJSON("/chlorinator", { output: Number(out) });
    await refresh();
  };

  let ageLine: React.ReactNode = null;
  if (chlor.age != null) {
    const ago =
      chlor.age < 90
        ? Math.round(chlor.age) + "s"
        : Math.round(chlor.age / 60) + "m";
    ageLine = (
      <Muted className="mt-2">
        {(chlor.age > 120 ? "⚠ stale — last update " : "updated ") + ago + " ago"}
      </Muted>
    );
  }

  return (
    <DashCard title="Salt / Chlorinator">
      <Grid2>
        <Tile k="Salt">{salt}</Tile>
        <Tile k="Output">{outDisp}</Tile>
      </Grid2>
      <div className="space-y-1.5 mt-2.5">
        <Label htmlFor="chlor_out">Set output %</Label>
        <Input
          id="chlor_out"
          type="number"
          min={0}
          max={100}
          value={out}
          onChange={(e) => setOut(e.target.value)}
        />
      </div>
      <Button className="mt-2.5" onClick={apply}>
        Set output
      </Button>
      {chlor.status_flags != null ? (
        <div className="mt-2.5">
          <Row k="Status flags">
            0x{Number(chlor.status_flags).toString(16)}
          </Row>
        </div>
      ) : null}
      {ageLine}
    </DashCard>
  );
}
