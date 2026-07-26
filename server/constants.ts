// Pentair RS-485 protocol vocabulary: address map, action (CFI) codes,
// circuit/feature names, heat modes and run-mode bit flags for the "A5" bus
// protocol used by EasyTouch / IntelliTouch controllers and IntelliFlo pumps.
//
// Ported 1:1 from easytouch/constants.py — the reverse-engineering references are
// michaelusner/pentair-pool-controler PACKET_SPEC.txt and the
// tagyoureit/nodejs-poolController field maps embedded in it.

// --- Bus addresses ----------------------------------------------------------
// High nibble identifies the device class:
//   0x0f  broadcast    0x1x main controllers    0x2x remotes    0x6x pumps
export const Address = {
  CHLORINATOR: 0x02,
  BROADCAST: 0x0f,
  MAIN: 0x10, // IntelliTouch / EasyTouch main controller
  SECONDARY: 0x11,
  REMOTE: 0x20, // a remote / wireless controller (we impersonate one)
  WIRELESS: 0x22,
  PUMP1: 0x60,
  PUMP2: 0x61,
  PUMP3: 0x62,
  PUMP4: 0x63,
  INTELLICHEM: 0x90,
} as const;

const ADDRESS_NAMES: Record<number, string> = {
  [Address.CHLORINATOR]: "Chlorinator",
  [Address.BROADCAST]: "Broadcast",
  [Address.MAIN]: "Main",
  [Address.SECONDARY]: "Secondary",
  [Address.REMOTE]: "Remote",
  [Address.WIRELESS]: "Wireless",
  [Address.PUMP1]: "Pump 1",
  [Address.PUMP2]: "Pump 2",
  [Address.PUMP3]: "Pump 3",
  [Address.PUMP4]: "Pump 4",
  [Address.INTELLICHEM]: "IntelliChem",
};

/** True if `addr` is an IntelliFlo pump address (0x60-0x6F). */
export function isPump(addr: number): boolean {
  return addr >= 0x60 && addr <= 0x6f;
}

/** Human-readable name for a bus address (falls back to hex). */
export function addressName(addr: number): string {
  if (addr in ADDRESS_NAMES) return ADDRESS_NAMES[addr]!;
  if (isPump(addr)) return `Pump ${addr - 0x5f}`;
  return "0x" + addr.toString(16).padStart(2, "0");
}

// --- Action / command (CFI) codes ------------------------------------------
export const Action = {
  ACK: 1,
  CONTROLLER_STATUS: 2, // unsolicited system status broadcast
  DATE_TIME: 5,
  PUMP_STATUS: 7,
  HEAT_STATUS: 8,
  CUSTOM_NAMES: 10,
  CIRCUIT_NAMES: 11,
  SCHEDULE: 17, // schedule details (broadcast / response to GET_SCHEDULE)
  INTELLICHEM: 18, // IntelliChem chemistry controller status
  INTELLICHLOR_STATUS: 25,
  VALVE_STATUS: 29,
  SET_COLOR: 96, // 0x60 IntelliBrite light command
  SET_DATETIME: 133, // 0x85 set the controller clock
  SET_CIRCUIT: 134, // 0x86 set a circuit on/off
  SET_HEAT: 136, // 0x88 set heat set-points / mode
  SET_SCHEDULE: 145, // 0x91 write a schedule
  GET_STATUS: 194,
  GET_HEAT: 200, // 0xc8 request heat/temperature status
  GET_SCHEDULE: 209, // 0xd1 request schedule(s)
  SW_VERSION: 252, // software version info
  GET_VERSION: 253, // 0xfd request software version
} as const;

// Controller action names (the meaning of CFI depends on the destination; this
// table covers messages to/from a controller, which is the common case).
const ACTION_NAMES: Record<number, string> = {
  1: "Ack",
  2: "Controller Status",
  5: "Date/Time",
  7: "Pump Status",
  8: "Heat/Temp Status",
  10: "Custom Names",
  11: "Circuit Names",
  16: "Heat Pump Status",
  17: "Schedule",
  18: "IntelliChem",
  25: "IntelliChlor Status",
  29: "Valve Status",
  96: "Set Color",
  133: "Set Date/Time",
  134: "Set Circuit",
  136: "Set Heat/Temp",
  145: "Set Schedule",
  194: "Get Status",
  197: "Get Date/Time",
  200: "Get Heat/Temp",
  209: "Get Schedule",
  252: "SW Version",
  253: "Get SW Version",
};

// Pump action codes (CFI when src/dst is a pump).
const PUMP_ACTION_NAMES: Record<number, string> = {
  1: "Write",
  4: "Remote Control",
  5: "Set Mode",
  6: "Set Run",
  7: "Status",
};

export function actionName(cfi: number, pump = false): string {
  const table = pump ? PUMP_ACTION_NAMES : ACTION_NAMES;
  return table[cfi] ?? `CFI ${cfi}`;
}

// --- Circuits ---------------------------------------------------------------
// EasyTouch default physical circuit numbers. The controller can rename these
// (delivered via Action.CIRCUIT_NAMES), so treat this as a convenience default
// that the caller may override.
export const DEFAULT_CIRCUITS: Record<number, string> = {
  1: "spa",
  2: "aux1",
  3: "aux2",
  4: "aux3",
  5: "aux4",
  6: "pool",
  7: "feature1",
  8: "feature2",
  9: "feature3",
  10: "feature4",
};

export const CIRCUIT_NUMBERS: Record<string, number> = Object.fromEntries(
  Object.entries(DEFAULT_CIRCUITS).map(([num, name]) => [name, Number(num)])
);

export function circuitLabel(number: number): string {
  return DEFAULT_CIRCUITS[number] ?? `circuit${number}`;
}

// --- Heat modes -------------------------------------------------------------
// The heat-mode byte packs spa (bits 2-3) and pool (bits 0-1) modes.
export const HEAT_MODES: Record<number, string> = {
  0: "Off",
  1: "Heater",
  2: "Solar Pref",
  3: "Solar Only",
};

// --- Run-mode / unit-of-measure bit flags (controller status byte 15) ------
export const RUNMODE_SERVICE = 0x01;
export const RUNMODE_CELSIUS = 0x04;
export const RUNMODE_FREEZE = 0x08;

// --- IntelliBrite light commands -------------------------------------------
// Data byte for Action.SET_COLOR (CFI 96): on/off, the color-mode controls, the
// seven light shows, and the five fixed colors. This is the documented
// IntelliTouch/EasyTouch mapping (per nodejs-poolController); the command is
// global to the configured light group. NOT yet confirmed on this hardware.
export const LIGHT_COMMANDS: Record<string, number> = {
  off: 0,
  on: 1,
  color_sync: 128,
  color_swim: 144,
  color_set: 160,
  party: 177,
  romance: 178,
  caribbean: 179,
  american: 180,
  sunset: 181,
  royal: 182,
  save: 190,
  recall: 191,
  blue: 193,
  green: 194,
  red: 195,
  white: 196,
  magenta: 197,
};

/**
 * Map an IntelliBrite command name (`party`, `blue`, `color-sync`…) or a raw
 * 0-255 code to its command byte. Names accept `-`/` ` for `_`.
 */
export function resolveLightCommand(nameOrCode: string | number): number {
  const key = String(nameOrCode).trim().toLowerCase().replace(/[-\s]/g, "_");
  if (key in LIGHT_COMMANDS) return LIGHT_COMMANDS[key]!;
  // Python's int(x, 0) accepts 0x/0o/0b prefixes and plain decimal; Number() does
  // the same for those forms, and rejects the empty string via the isFinite check.
  const code = key === "" ? NaN : Number(key);
  if (!Number.isFinite(code)) throw new Error(`unknown light command: ${nameOrCode}`);
  return code & 0xff;
}
