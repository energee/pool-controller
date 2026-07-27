// Shared constant tables ported from the former cards.ts.

// The ten controllable circuits, [number, default-name].
export const CIRCUITS = [
  [1, "spa"],
  [2, "aux1"],
  [3, "aux2"],
  [4, "aux3"],
  [5, "aux4"],
  [6, "pool"],
  [7, "feature1"],
  [8, "feature2"],
  [9, "feature3"],
  [10, "feature4"],
] as const;

// Circuit name -> number, derived from CIRCUITS so "pool is 6" lives in one
// place (mirrors server/constants.ts CIRCUIT_NUMBERS). Keys are the literal
// names, so `CIRCUIT_NUMBERS.pool` type-checks and a typo is a compile error.
export const CIRCUIT_NUMBERS = Object.fromEntries(
  CIRCUITS.map(([num, name]) => [name, num])
) as Record<(typeof CIRCUITS)[number][1], number>;

// Stepper controls (heat setpoints, chlorinator output) send this long after
// the last −/+ tap — the Nest model, one constant for every card that uses it.
export const SETTLE_MS = 1200;

// Pentair IntelliChlor salt bands: operating range 3000–4500 ppm, low-salt
// warning under 3000, cell cutoff under 2600. Pure policy — the card maps the
// band word to theme colors.
export function saltBand(ppm: number): "very low" | "low" | "OK" | "high" {
  if (ppm < 2600) return "very low";
  if (ppm < 3000) return "low";
  if (ppm <= 4500) return "OK";
  return "high";
}

// Days of the week, [token-sent-to-/schedule, chip-label]. Sun-first to match
// the controller's day bitmask; decode_days emits "Sun".."Sat" / "Every day".
export const DAYS: [string, string][] = [
  ["sun", "Su"],
  ["mon", "Mo"],
  ["tue", "Tu"],
  ["wed", "We"],
  ["thu", "Th"],
  ["fri", "Fr"],
  ["sat", "Sa"],
];

// Heat modes, [value, label]. poolMode = raw & 0x03, spaMode = (raw>>2) & 0x03.
export const MODES: [number, string][] = [
  [0, "Off"],
  [1, "Heater"],
  [2, "Solar Pref"],
  [3, "Solar Only"],
];

// IntelliBrite light commands (global to the light group; experimental on hw).
export const LIGHT_CMDS: string[] = [
  "on",
  "off",
  "color_sync",
  "color_swim",
  "color_set",
  "party",
  "romance",
  "caribbean",
  "american",
  "sunset",
  "royal",
  "blue",
  "green",
  "red",
  "white",
  "magenta",
];

// CFI frame id -> human name, for the raw-frames table.
export const CFI_NAMES: Record<number, string> = {
  2: "Controller Status",
  5: "Date/Time",
  7: "Pump Status",
  8: "Heat Status",
  10: "Custom Names",
  11: "Circuit Names",
  17: "Schedule",
  18: "IntelliChem",
  25: "IntelliChlor",
  29: "Valve Status",
  252: "SW Version",
};
