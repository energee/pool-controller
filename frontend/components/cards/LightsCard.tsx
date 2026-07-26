// Lights (IntelliBrite) card (experimental). Each button POSTs /light {command}.
// Codes are the documented reference mapping (unconfirmed on this hardware).
// No refresh after sending: /light replies before the frame reaches the bus and
// there is no light state to read back, so a refetch would be pure waste.
import { postJSON } from "../../lib/api";
import { LIGHT_CMDS } from "../../lib/constants";
import { DashCard } from "../primitives";
import { Button } from "../ui/button";

export function LightsCard() {
  const send = (cmd: string) => void postJSON("/light", { command: cmd });
  return (
    <DashCard
      title="Lights (IntelliBrite)"
      experimental
      collapsible
      className="col-span-full"
    >
      <div className="flex flex-wrap gap-1.5">
        {LIGHT_CMDS.map((cmd) => (
          <Button
            key={cmd}
            variant="outline"
            size="sm"
            onClick={() => send(cmd)}
          >
            {cmd.replace("_", " ")}
          </Button>
        ))}
      </div>
    </DashCard>
  );
}
