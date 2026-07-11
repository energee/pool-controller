// Valves card (experimental). Renders null until a valve-status frame (CFI 29)
// has arrived, matching the old '' return.
import type { Valves } from "../../types";
import { DashCard, Grid2, Muted, Row, Tile } from "../primitives";

export function ValvesCard({ valves }: { valves?: Valves | null }) {
  if (!valves) return null; // shown only once a valve-status frame has arrived
  const vals = valves.valves || [];
  return (
    <DashCard title="Valves" experimental>
      {vals.length ? (
        <Grid2>
          {vals.map((b, i) => (
            <Tile key={i} k={"Valve " + (i + 1)}>
              {b}
            </Tile>
          ))}
        </Grid2>
      ) : (
        <Muted>no valve positions</Muted>
      )}
      <Row k="Raw">
        <span className="text-muted-foreground break-all">
          {valves.raw ?? ""}
        </span>
      </Row>
    </DashCard>
  );
}
