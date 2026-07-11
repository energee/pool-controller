// Circuits card: the 10 controllable circuits as Switches. Toggling a switch
// calls GET /circuit/<n>/<on|off> then refreshes.
import { command } from "../../lib/api";
import { CIRCUITS } from "../../lib/constants";
import type { Status } from "../../types";
import { DashCard } from "../primitives";
import { Switch } from "../ui/switch";

export function CircuitsCard({
  status,
  refresh,
}: {
  status?: Status | null;
  refresh: () => Promise<void>;
}) {
  const on = (status && status.circuits_on) || [];
  const toggle = async (num: number, checked: boolean) => {
    await command("/circuit/" + num + "/" + (checked ? "on" : "off"));
    await refresh();
  };
  return (
    <DashCard title="Circuits">
      <div className="grid grid-cols-2 gap-2">
        {CIRCUITS.map(([num, name]) => (
          <label
            key={num}
            className="switch justify-between gap-2 rounded-md border border-border bg-popover px-2.5 py-2 text-[13px] cursor-pointer hover:border-input"
          >
            <span>{name}</span>
            <Switch
              checked={on.indexOf(num) >= 0}
              onCheckedChange={(c) => toggle(num, c)}
            />
          </label>
        ))}
      </div>
    </DashCard>
  );
}
