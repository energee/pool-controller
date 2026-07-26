// Turn raw packets into meaningful state. Ported from easytouch/decode.py.
//
// Field offsets below are quoted relative to the full packet body with 0xA5 at
// index 0 (matching PACKET_SPEC.txt and the nodejs-poolController field maps), so
// they read directly against the once-built body accessor returned by
// `specReader`. Data byte *n* of the payload is therefore body offset `n + 6`.
//
// Only the well-understood, field-validated packets are decoded into typed
// structures; everything else is returned as `unknown` so monitoring never
// silently drops a frame.
//
// Each decoder returns a plain object whose keys are exactly the JSON the HTTP
// API serves (snake_case, including the computed `unit` / `iso` / `active`
// fields), so `decode()` wraps them in a `{kind, value}` tag rather than adding a
// discriminant field that would leak into the wire format.

import * as C from "./constants.js";
import type { Packet } from "./protocol.js";

/**
 * Safe spec-offset byte accessor over `pkt`'s body, built once.
 *
 * The full packet body (0xA5 at index 0) is constructed a single time; the
 * returned `b(i)` reads byte *i* and yields 0 for offsets past the end — so a
 * decoder reads documented offsets without rebuilding the body per access or
 * bounds-checking short frames itself.
 */
function specReader(pkt: Packet): (i: number) => number {
  const body = pkt.body();
  return (i) => (i < body.length ? body[i]! : 0);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Decode the 3 equipment bitmask bytes into a list of ON circuit numbers.
 * Bit *i* (LSB first) of equip1 is circuit `i+1`; equip2 covers circuits 9-16
 * and equip3 covers 17-24.
 */
export function equipCircuits(equip1: number, equip2: number, equip3: number): number[] {
  const on: number[] = [];
  [equip1, equip2, equip3].forEach((value, byteIndex) => {
    for (let bit = 0; bit < 8; bit++) {
      if (value & (1 << bit)) on.push(byteIndex * 8 + bit + 1);
    }
  });
  return on;
}

/**
 * Decode the packed heat-mode byte into `[poolMode, spaMode]` names.
 * The byte packs pool mode in bits 0-1 and spa mode in bits 2-3 (see
 * `HEAT_MODES`); shared by every decoder that reports heat mode.
 */
export function heatModes(byte: number): [string, string] {
  return [C.HEAT_MODES[byte & 0x03] ?? "?", C.HEAT_MODES[(byte >> 2) & 0x03] ?? "?"];
}

/**
 * Apply optional pool/spa mode changes onto the packed heat-mode byte.
 *
 * Pool mode occupies bits 0-1 and spa mode bits 2-3; a null/undefined mode leaves
 * its bits untouched. Shared by every Set-Heat read-modify-write (the bus client
 * and the BusMonitor) so the bit-packing lives in exactly one place.
 */
export function mergeHeatMode(
  currentRaw: number,
  poolMode?: number | null,
  spaMode?: number | null
): number {
  let mode = currentRaw;
  if (poolMode != null) mode = (mode & ~0x03) | (poolMode & 0x03);
  if (spaMode != null) mode = (mode & ~0x0c) | ((spaMode & 0x03) << 2);
  return mode;
}

/** Decoded `Action.CONTROLLER_STATUS` (CFI 2) broadcast. */
export interface ControllerStatus {
  clock: string; // "HH:MM"
  circuits_on: number[]; // physical circuit numbers currently on
  circuit_names: string[]; // convenience names for circuits_on
  pool_temp: number;
  spa_temp: number;
  air_temp: number;
  solar_temp: number;
  heater_on: boolean;
  pool_heat_mode: string;
  spa_heat_mode: string;
  celsius: boolean;
  service: boolean;
  freeze: boolean;
  valve: number; // body 16: valve actuator state (raw byte)
  delay: number; // body 18: 0 = none; 65-135 = the circuit currently delayed
  auto_dst: boolean; // body 32 bit 0: auto-adjust daylight saving time
  raw_equip: [number, number, number];
  unit: string; // "C" | "F", derived from `celsius`
}

/** Decoded `Action.DATE_TIME` (CFI 5) broadcast. */
export interface DateTimeStatus {
  hour: number;
  minute: number;
  day: number;
  month: number;
  year: number;
  dow: number;
  iso: string;
}

/**
 * Decoded IntelliFlo pump status (CFI 7 from a pump).
 *
 * Fields follow `pumpPacketFields`; the body offset of each is in its per-field
 * comment below. `mode`, `drive_state` and `error` are raw controller codes —
 * deliberately left unmapped (no named lookup yet, unlike heat modes or circuit
 * names) until their value tables are reverse-engineered.
 */
export interface PumpStatus {
  pump: number; // 1-based pump number
  cmd: number; // body 6: controller command to the pump
  mode: number; // body 7: pump program/mode
  drive_state: number; // body 8: drive state
  watts: number;
  rpm: number;
  gpm: number;
  ppc: number; // body 14: pump-to-pump comms / priming-cycle counter
  error: number; // body 15: error code (0 = ok)
  run_minutes: number; // body 19*60 + body 20: elapsed run-time clock, in minutes
}

/**
 * Decoded `Action.HEAT_STATUS` (CFI 8) — temps and heat set-points.
 *
 * Payload layout (validated against live hardware):
 * `[poolTemp, spaTemp, airTemp, poolSetpoint, spaSetpoint, heatMode, ...]`.
 * Payload idx 9 (body 15) carries the cool set-point used by cooling-capable
 * heaters (heat-pump / UltraTemp); it reads 100 when no chill is configured.
 */
export interface HeatStatus {
  pool_temp: number;
  spa_temp: number;
  air_temp: number;
  pool_setpoint: number;
  spa_setpoint: number;
  pool_heat_mode: string;
  spa_heat_mode: string;
  heat_mode_raw: number;
  cool_setpoint: number; // body 15: heat-pump/UltraTemp chill set-point (100 = parked)
}

/**
 * Decoded `Action.SW_VERSION` (CFI 252) — controller firmware version.
 *
 * Note: the exact field layout is **not confirmed** against this hardware (no CFI
 * 252 frame was captured). `version` is a best-effort read of the first two
 * payload bytes as major.minor; `raw` (the full payload hex) is the authoritative
 * value until the layout is verified on a live controller.
 */
export interface SoftwareVersion {
  version: string; // best-effort "major.minor"
  major: number;
  minor: number;
  raw: string; // hex of the full payload
}

/**
 * Decoded `Action.VALVE_STATUS` (CFI 29) — valve actuator assignments.
 *
 * Note: per-byte meanings are **not confirmed** against this hardware (no CFI 29
 * frame captured). `valves` is the raw per-position payload and `raw` the full
 * payload hex — surfaced typed (instead of only under `/raw`) so a live capture
 * can be matched against it later.
 */
export interface ValveStatus {
  valves: number[];
  raw: string;
}

/**
 * Decoded `Action.INTELLICHEM` (CFI 18) — water-chemistry controller status.
 *
 * Note: offsets follow the nodejs-poolController / reference field map and are
 * **not confirmed** against this hardware (this system may have no IntelliChem).
 * The four high-confidence readings below (pH / ORP and their setpoints) are
 * decoded; tank levels, water balance and alarms stay in `raw` until a live CFI 18
 * frame is captured. `raw` is authoritative.
 */
export interface IntelliChem {
  ph: number; // pH reading        (payload [0:2] / 100)
  orp: number; // ORP reading, mV   (payload [2:4])
  ph_setpoint: number; // pH setpoint       (payload [4:6] / 100)
  orp_setpoint: number; // ORP setpoint, mV  (payload [6:8])
  raw: string; // hex of the full payload
}

/**
 * Decoded `Action.CIRCUIT_NAMES` (CFI 11) — one circuit's configuration.
 *
 * Note: layout is **not confirmed** against this hardware (no CFI 11 capture). The
 * controller gives each circuit a `function`/type and a `name_id` that indexes a
 * built-in name table (plus custom names from CFI 10); mapping `name_id` → display
 * text needs a live capture, so only the structured ids and `raw` are exposed and
 * `DEFAULT_CIRCUITS` stays the display fallback. `raw` is authoritative.
 */
export interface CircuitNames {
  circuit: number;
  function: number;
  name_id: number;
  raw: string;
}

/**
 * Decoded `Action.SCHEDULE` (CFI 17) entry.
 *
 * A schedule with `circuit === 0` is an unused/empty slot. Start/stop are 24-hour
 * "HH:MM" strings; controllers encode "egg-timer" run-for-duration schedules with
 * out-of-range hours, so the raw day mask is kept available.
 */
export interface Schedule {
  id: number;
  circuit: number;
  circuit_name: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  days_mask: number;
  days: string[];
  active: boolean;
}

// --- Schedules --------------------------------------------------------------
// Day-of-week bitmask, per the nodejs-poolController convention. The raw byte is
// always exposed alongside the decoded names in case a controller orders the bits
// differently.
export const DAY_BITS: [string, number][] = [
  ["Sun", 0x01],
  ["Mon", 0x02],
  ["Tue", 0x04],
  ["Wed", 0x08],
  ["Thu", 0x10],
  ["Fri", 0x20],
  ["Sat", 0x40],
];
export const ALL_DAYS = 0x7f; // every day

const DAY_ALIASES: Record<string, number> = {
  sunday: 0x01, sun: 0x01,
  monday: 0x02, mon: 0x02,
  tuesday: 0x04, tue: 0x04,
  wednesday: 0x08, wed: 0x08,
  thursday: 0x10, thu: 0x10,
  friday: 0x20, fri: 0x20,
  saturday: 0x40, sat: 0x40,
};

/** Decode a day bitmask into a list of day names (`["Every day"]` if all). */
export function decodeDays(mask: number): string[] {
  if ((mask & ALL_DAYS) === ALL_DAYS) return ["Every day"];
  return DAY_BITS.filter(([, bit]) => mask & bit).map(([name]) => name);
}

/**
 * Build a day bitmask from tokens like `mon`, `tuesday`, `weekdays`.
 *
 * Accepts day names/abbreviations plus the shortcuts `every`/`all`/`daily`,
 * `weekdays` (Mon-Fri) and `weekends` (Sat+Sun). `tokens` may be an array of
 * tokens *or* a single comma/space-separated string (e.g. "mon,wed,fri" or
 * "every") — the form the HTTP API / webapp send.
 */
export function encodeDays(tokens: string | string[] | number): number {
  if (typeof tokens === "number") return tokens;
  const list = typeof tokens === "string" ? tokens.replace(/,/g, " ").split(/\s+/) : tokens;
  let mask = 0;
  for (const token of list) {
    const key = token.trim().toLowerCase();
    if (!key) continue;
    if (["every", "everyday", "all", "daily"].includes(key)) return ALL_DAYS;
    if (key === "weekdays") mask |= 0x3e; // Mon..Fri
    else if (key === "weekends") mask |= 0x41; // Sun + Sat
    else if (key in DAY_ALIASES) mask |= DAY_ALIASES[key]!;
    else throw new Error(`unknown day: ${token}`);
  }
  return mask;
}

export function decodeControllerStatus(pkt: Packet): ControllerStatus {
  const b = specReader(pkt);
  const equip: [number, number, number] = [b(8), b(9), b(10)];
  const circuits = equipCircuits(...equip);
  const runmode = b(15);
  const [poolMode, spaMode] = heatModes(b(28));
  const celsius = Boolean(runmode & C.RUNMODE_CELSIUS);
  return {
    clock: `${pad2(b(6))}:${pad2(b(7))}`,
    circuits_on: circuits,
    circuit_names: circuits.map((c) => C.circuitLabel(c)),
    pool_temp: b(20),
    spa_temp: b(21),
    air_temp: b(24),
    solar_temp: b(25),
    heater_on: b(22) !== 0,
    pool_heat_mode: poolMode,
    spa_heat_mode: spaMode,
    celsius,
    service: Boolean(runmode & C.RUNMODE_SERVICE),
    freeze: Boolean(runmode & C.RUNMODE_FREEZE),
    valve: b(16),
    delay: b(18),
    auto_dst: Boolean(b(32) & 0x01),
    raw_equip: equip,
    unit: celsius ? "C" : "F",
  };
}

export function decodeDatetime(pkt: Packet): DateTimeStatus {
  const b = specReader(pkt);
  // data: hour, minute, dow, day, month, year, ...
  const [hour, minute, dow, day, month, year] = [b(6), b(7), b(8), b(9), b(10), b(11)];
  return {
    hour, minute, day, month, year, dow,
    iso: `${2000 + year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`,
  };
}

export function decodePumpStatus(pkt: Packet): PumpStatus {
  const b = specReader(pkt);
  return {
    pump: C.isPump(pkt.src) ? pkt.src - C.Address.PUMP1 + 1 : 0,
    cmd: b(6),
    mode: b(7),
    drive_state: b(8),
    watts: (b(9) << 8) | b(10),
    rpm: (b(11) << 8) | b(12),
    gpm: b(13),
    ppc: b(14),
    error: b(15),
    run_minutes: b(19) * 60 + b(20),
  };
}

export function decodeSchedule(pkt: Packet): Schedule {
  const b = specReader(pkt);
  const circuit = b(7);
  const mask = b(12);
  return {
    id: b(6),
    circuit,
    circuit_name: circuit ? C.circuitLabel(circuit) : "(unused)",
    start: `${pad2(b(8))}:${pad2(b(9))}`,
    end: `${pad2(b(10))}:${pad2(b(11))}`,
    days_mask: mask,
    days: decodeDays(mask),
    active: circuit !== 0,
  };
}

export function decodeHeatStatus(pkt: Packet): HeatStatus {
  const b = specReader(pkt);
  // data: poolTemp, spaTemp, airTemp, poolSetpoint, spaSetpoint, heatMode, ...
  const mode = b(11);
  const [poolMode, spaMode] = heatModes(mode);
  return {
    pool_temp: b(6),
    spa_temp: b(7),
    air_temp: b(8),
    pool_setpoint: b(9),
    spa_setpoint: b(10),
    pool_heat_mode: poolMode,
    spa_heat_mode: spaMode,
    heat_mode_raw: mode,
    cool_setpoint: b(15),
  };
}

export function decodeVersion(pkt: Packet): SoftwareVersion {
  const b = specReader(pkt);
  const [major, minor] = [b(6), b(7)];
  return {
    version: `${major}.${String(minor).padStart(3, "0")}`,
    major,
    minor,
    raw: pkt.data.toString("hex"),
  };
}

export function decodeValve(pkt: Packet): ValveStatus {
  return { valves: [...pkt.data], raw: pkt.data.toString("hex") };
}

export function decodeIntellichem(pkt: Packet): IntelliChem {
  const b = specReader(pkt);
  const u16 = (i: number) => (b(i) << 8) | b(i + 1); // payload idx n -> body n+6
  return {
    ph: u16(6) / 100, // payload [0:2]
    orp: u16(8), // payload [2:4]
    ph_setpoint: u16(10) / 100, // payload [4:6]
    orp_setpoint: u16(12), // payload [6:8]
    raw: pkt.data.toString("hex"),
  };
}

export function decodeCircuitNames(pkt: Packet): CircuitNames {
  const b = specReader(pkt);
  return { circuit: b(6), function: b(7), name_id: b(8), raw: pkt.data.toString("hex") };
}

/** Everything `decode()` can return, tagged so callers can switch exhaustively. */
export type Decoded =
  | { kind: "status"; value: ControllerStatus }
  | { kind: "datetime"; value: DateTimeStatus }
  | { kind: "heat"; value: HeatStatus }
  | { kind: "schedule"; value: Schedule }
  | { kind: "pump"; value: PumpStatus }
  | { kind: "version"; value: SoftwareVersion }
  | { kind: "valves"; value: ValveStatus }
  | { kind: "intellichem"; value: IntelliChem }
  | { kind: "names"; value: CircuitNames }
  | { kind: "unknown"; value: Packet };

/** Dispatch a packet to the most specific decoder available. */
export function decode(pkt: Packet): Decoded {
  const fromMain = pkt.src === C.Address.MAIN;
  if (pkt.cfi === C.Action.CONTROLLER_STATUS && fromMain)
    return { kind: "status", value: decodeControllerStatus(pkt) };
  if (pkt.cfi === C.Action.DATE_TIME && fromMain)
    return { kind: "datetime", value: decodeDatetime(pkt) };
  if (pkt.cfi === C.Action.HEAT_STATUS && fromMain)
    return { kind: "heat", value: decodeHeatStatus(pkt) };
  if (pkt.cfi === C.Action.SCHEDULE && fromMain)
    return { kind: "schedule", value: decodeSchedule(pkt) };
  if (pkt.cfi === C.Action.PUMP_STATUS && C.isPump(pkt.src))
    return { kind: "pump", value: decodePumpStatus(pkt) };
  if (pkt.cfi === C.Action.SW_VERSION && fromMain)
    return { kind: "version", value: decodeVersion(pkt) };
  if (pkt.cfi === C.Action.VALVE_STATUS && fromMain)
    return { kind: "valves", value: decodeValve(pkt) };
  if (
    pkt.cfi === C.Action.INTELLICHEM &&
    (pkt.src === C.Address.INTELLICHEM || pkt.src === C.Address.MAIN)
  )
    return { kind: "intellichem", value: decodeIntellichem(pkt) };
  if (pkt.cfi === C.Action.CIRCUIT_NAMES && fromMain)
    return { kind: "names", value: decodeCircuitNames(pkt) };
  return { kind: "unknown", value: pkt };
}
