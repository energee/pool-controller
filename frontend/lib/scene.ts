// SceneState is the compact, presentation-ready input for the 3D pool card.
// This pure mapping is the card's only tested seam and has no rendering imports.
import { CIRCUIT_NUMBERS } from "./constants";
import type { Heat, State, Status } from "../types";

/**
 * Is `body` ("pool" | "spa") actually being heated right now?
 *
 * `status.heater_on` (status byte 22) is NOT "this body's heater is firing".
 * Read live off a real EasyTouch it sat true while the pool was 5F ABOVE its
 * set-point with `pool_heat_mode: "Off"` and only the SPA in Heater mode — so
 * taken alone it reports heating for water that nothing is heating. Treat it as
 * necessary but not sufficient: the body's own mode must be on, and the body
 * must be below its set-point.
 *
 * Set-points ride a different frame than the status bit, so a missing set-point
 * or temp falls back to the mode gate rather than flapping on an absent field.
 */
export function isHeating(
  status: Status | null | undefined,
  heat: Heat | null | undefined,
  body: "pool" | "spa",
): boolean {
  if (status?.heater_on !== true) return false;
  if (status[`${body}_heat_mode`] === "Off") return false;
  const temp = status[`${body}_temp`];
  const setpoint = heat?.[`${body}_setpoint`];
  return temp == null || setpoint == null ? true : temp < setpoint;
}

export interface SceneState {
  poolOn: boolean;
  spaOn: boolean;
  flow: number;
  rpm: number | null;
  gpm: number | null;
  watts: number | null;
  heaterOn: boolean;
  chlorPct: number;
  saltPpm: number | null;
  poolTemp: number | null;
  stale: boolean;
}

export function deriveSceneState(
  state: State | null,
  connected: boolean,
): SceneState {
  if (state === null) {
    return {
      poolOn: false,
      spaOn: false,
      flow: 0,
      rpm: null,
      gpm: null,
      watts: null,
      heaterOn: false,
      chlorPct: 0,
      saltPpm: null,
      poolTemp: null,
      stale: true,
    };
  }

  const circuitsOn = state.status?.circuits_on ?? [];
  const poolOn = circuitsOn.includes(CIRCUIT_NUMBERS.pool);
  const spaOn = circuitsOn.includes(CIRCUIT_NUMBERS.spa);
  const pumps = Object.values(state.pumps ?? {});
  const pump =
    pumps.find((entry) => (entry.rpm ?? 0) > 0 || (entry.watts ?? 0) > 0) ??
    pumps[0] ??
    null;

  // Prefer measured GPM, but a pump in RPM mode can report gpm 0 while
  // spinning — treat 0 as "no reading" and derive flow from RPM instead.
  let flow: number;
  if (pump) {
    if (pump.gpm) flow = Math.min(pump.gpm / 100, 1);
    else if (pump.rpm) flow = Math.min(pump.rpm / 3450, 1);
    else flow = 0;
  } else {
    flow = poolOn || spaOn ? 0.5 : 0;
  }

  // Only the circulating body can be heated; spa wins when both are on, since
  // spa mode diverts flow to the spa.
  const heaterOn =
    (poolOn || spaOn) &&
    isHeating(state.status, state.heat, spaOn ? "spa" : "pool");

  return {
    poolOn,
    spaOn,
    flow,
    rpm: pump?.rpm ?? null,
    gpm: pump?.gpm ?? null,
    watts: pump?.watts ?? null,
    heaterOn,
    chlorPct: state.chlorinator?.output_percent ?? 0,
    saltPpm: state.chlorinator?.salt_ppm ?? null,
    poolTemp: state.status?.pool_temp ?? null,
    stale: !connected || (state.age != null && state.age > 60),
  };
}
