// Shared constant tables ported from the former cards.ts.

// The ten controllable circuits, [number, default-name].
export const CIRCUITS: [number, string][] = [
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
];

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
