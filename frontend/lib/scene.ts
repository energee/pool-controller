// SceneState is the compact, presentation-ready input for the 3D pool card.
// This pure mapping is the card's only tested seam and has no rendering imports.
import { CIRCUIT_NUMBERS } from "./constants";
import type { State } from "../types";

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

  return {
    poolOn,
    spaOn,
    flow,
    rpm: pump?.rpm ?? null,
    gpm: pump?.gpm ?? null,
    watts: pump?.watts ?? null,
    heaterOn: state.status?.heater_on === true,
    chlorPct: state.chlorinator?.output_percent ?? 0,
    saltPpm: state.chlorinator?.salt_ppm ?? null,
    poolTemp: state.status?.pool_temp ?? null,
    stale: !connected || (state.age != null && state.age > 60),
  };
}
