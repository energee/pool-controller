// Lights (IntelliBrite) card (experimental). Each button POSTs /light {command}.
// Codes are the documented reference mapping (unconfirmed on this hardware).
import { postJSON } from "../../lib/api";
import { LIGHT_CMDS } from "../../lib/constants";
import { DashCard } from "../primitives";
import { Button } from "../ui/button";

export function LightsCard({ refresh }: { refresh: () => Promise<void> }) {
  const send = async (cmd: string) => {
    await postJSON("/light", { command: cmd });
    await refresh();
  };
  return (
    <DashCard title="Lights (IntelliBrite)" experimental>
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
