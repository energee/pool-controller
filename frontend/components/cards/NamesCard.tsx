// Circuit config / names card (experimental). Renders null until circuit-name
// config (CFI 11) arrives, matching the old '' return.
import type { NameEntry } from "../../types";
import { DashCard, Muted, Row } from "../primitives";

export function NamesCard({
  names,
}: {
  names?: Record<string, NameEntry>;
}) {
  const map = names || {};
  const keys = Object.keys(map).sort((a, b) => Number(a) - Number(b));
  if (!keys.length) return null; // shown only once circuit-name config arrives
  return (
    <DashCard title="Circuit config / names" experimental>
      {keys.map((k) => {
        const n = map[k];
        return (
          <Row key={k} k={"Circuit " + n.circuit}>
            {"fn " + n.function + " · name id " + n.name_id}
          </Row>
        );
      })}
      <Muted className="mt-2">
        name id → text needs a live capture; display names use the built-in
        defaults.
      </Muted>
    </DashCard>
  );
}
