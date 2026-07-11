// IntelliChem card (experimental). Renders null when no IntelliChem controller is
// present (the absent-data case), matching the old '' return.
import type { Intellichem } from "../../types";
import { DashCard, Grid2, Row, Tile } from "../primitives";

export function IntelliChemCard({ chem }: { chem?: Intellichem | null }) {
  if (!chem) return null; // only shown when an IntelliChem controller is present
  return (
    <DashCard title="IntelliChem" experimental>
      <Grid2>
        <Tile k="pH">{chem.ph == null ? "—" : chem.ph}</Tile>
        <Tile k="ORP">{chem.orp == null ? "—" : chem.orp + " mV"}</Tile>
      </Grid2>
      <Row k="pH setpoint">{chem.ph_setpoint ?? ""}</Row>
      <Row k="ORP setpoint">{(chem.orp_setpoint ?? "") + " mV"}</Row>
    </DashCard>
  );
}
