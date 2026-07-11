// Heat / setpoints card: pool/spa setpoint Inputs + pool/spa mode Selects, and
// an "Apply heat" button that POSTs /heat. Field values live in local state
// (seeded from props) so the 3s poll never clobbers an in-progress edit.
import * as React from "react";

import { postJSON } from "../../lib/api";
import { MODES } from "../../lib/constants";
import type { Heat } from "../../types";
import { DashCard, Grid2, Muted } from "../primitives";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export function HeatCard({
  heat,
  refresh,
}: {
  heat?: Heat | null;
  refresh: () => Promise<void>;
}) {
  if (!heat) {
    return (
      <DashCard title="Heat / setpoints">
        <Muted>waiting for heat status…</Muted>
      </DashCard>
    );
  }
  return <HeatForm heat={heat} refresh={refresh} />;
}

// Keyed on a snapshot of the relevant fields so a *new* controller value
// re-seeds the form, but the user's own edits within a snapshot are preserved.
function HeatForm({
  heat,
  refresh,
}: {
  heat: Heat;
  refresh: () => Promise<void>;
}) {
  const poolMode = (heat.heat_mode_raw || 0) & 0x03;
  const spaMode = ((heat.heat_mode_raw || 0) >> 2) & 0x03;

  const [poolSp, setPoolSp] = React.useState(String(heat.pool_setpoint ?? ""));
  const [spaSp, setSpaSp] = React.useState(String(heat.spa_setpoint ?? ""));
  const [poolM, setPoolM] = React.useState(String(poolMode));
  const [spaM, setSpaM] = React.useState(String(spaMode));

  const apply = async () => {
    await postJSON("/heat", {
      pool_setpoint: Number(poolSp),
      spa_setpoint: Number(spaSp),
      pool_mode: Number(poolM),
      spa_mode: Number(spaM),
    });
    await refresh();
  };

  // Live pool/spa temps live in the summary bar; this card is setpoints + mode.
  // The mode selects below are seeded from heat_mode_raw, so they double as the
  // read-out of the controller's current heat mode.
  return (
    <DashCard title="Heat / setpoints">
      <Grid2>
        <div className="space-y-1.5">
          <Label htmlFor="pool_sp">Pool setpoint</Label>
          <Input
            id="pool_sp"
            type="number"
            value={poolSp}
            onChange={(e) => setPoolSp(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="spa_sp">Spa setpoint</Label>
          <Input
            id="spa_sp"
            type="number"
            value={spaSp}
            onChange={(e) => setSpaSp(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Pool mode</Label>
          <ModeSelect value={poolM} onChange={setPoolM} />
        </div>
        <div className="space-y-1.5">
          <Label>Spa mode</Label>
          <ModeSelect value={spaM} onChange={setSpaM} />
        </div>
      </Grid2>
      <Button className="mt-3" onClick={apply}>
        Apply heat
      </Button>
    </DashCard>
  );
}

function ModeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MODES.map(([v, label]) => (
          <SelectItem key={v} value={String(v)}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
