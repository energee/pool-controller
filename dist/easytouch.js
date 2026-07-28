#!/usr/bin/env node

// server/bus.ts
import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Socket } from "node:net";

// server/constants.ts
var Address = {
  CHLORINATOR: 2,
  BROADCAST: 15,
  MAIN: 16,
  SECONDARY: 17,
  REMOTE: 32,
  WIRELESS: 34,
  PUMP1: 96,
  PUMP2: 97,
  PUMP3: 98,
  PUMP4: 99,
  INTELLICHEM: 144
};
var ADDRESS_NAMES = {
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
  [Address.INTELLICHEM]: "IntelliChem"
};
function isPump(addr) {
  return addr >= 96 && addr <= 111;
}
function addressName(addr) {
  if (addr in ADDRESS_NAMES)
    return ADDRESS_NAMES[addr];
  if (isPump(addr))
    return `Pump ${addr - 95}`;
  return "0x" + addr.toString(16).padStart(2, "0");
}
var Action = {
  ACK: 1,
  CONTROLLER_STATUS: 2,
  DATE_TIME: 5,
  PUMP_STATUS: 7,
  HEAT_STATUS: 8,
  CUSTOM_NAMES: 10,
  CIRCUIT_NAMES: 11,
  SCHEDULE: 17,
  INTELLICHEM: 18,
  INTELLICHLOR_STATUS: 25,
  VALVE_STATUS: 29,
  SET_COLOR: 96,
  SET_DATETIME: 133,
  SET_CIRCUIT: 134,
  SET_HEAT: 136,
  SET_SCHEDULE: 145,
  GET_STATUS: 194,
  GET_HEAT: 200,
  GET_SCHEDULE: 209,
  SW_VERSION: 252,
  GET_VERSION: 253
};
var ACTION_NAMES = {
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
  253: "Get SW Version"
};
var PUMP_ACTION_NAMES = {
  1: "Write",
  4: "Remote Control",
  5: "Set Mode",
  6: "Set Run",
  7: "Status"
};
function actionName(cfi, pump = false) {
  const table = pump ? PUMP_ACTION_NAMES : ACTION_NAMES;
  return table[cfi] ?? `CFI ${cfi}`;
}
var DEFAULT_CIRCUITS = {
  1: "spa",
  2: "aux1",
  3: "aux2",
  4: "aux3",
  5: "aux4",
  6: "pool",
  7: "feature1",
  8: "feature2",
  9: "feature3",
  10: "feature4"
};
var CIRCUIT_NUMBERS = Object.fromEntries(Object.entries(DEFAULT_CIRCUITS).map(([num, name]) => [name, Number(num)]));
function circuitLabel(number) {
  return DEFAULT_CIRCUITS[number] ?? `circuit${number}`;
}
var HEAT_MODES = {
  0: "Off",
  1: "Heater",
  2: "Solar Pref",
  3: "Solar Only"
};
var RUNMODE_SERVICE = 1;
var RUNMODE_CELSIUS = 4;
var RUNMODE_FREEZE = 8;
var LIGHT_COMMANDS = {
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
  magenta: 197
};
function resolveLightCommand(nameOrCode) {
  const key = String(nameOrCode).trim().toLowerCase().replace(/[-\s]/g, "_");
  if (key in LIGHT_COMMANDS)
    return LIGHT_COMMANDS[key];
  const code = key === "" ? NaN : Number(key);
  if (!Number.isFinite(code))
    throw new Error(`unknown light command: ${nameOrCode}`);
  return code & 255;
}

// server/protocol.ts
var IDLE = 255;
var START = Buffer.from([0, 255]);
var A5 = 165;
var HEADER_LEN = 6;
var MIN_BODY = HEADER_LEN + 2;
function checksum(body) {
  let sum = 0;
  for (const byte of body)
    sum += byte;
  return sum & 65535;
}

class ChecksumError extends Error {
}

class Packet {
  sub;
  dst;
  src;
  cfi;
  data;
  constructor(sub, dst, src, cfi, data = Buffer.alloc(0)) {
    this.sub = sub;
    this.dst = dst;
    this.src = src;
    this.cfi = cfi;
    this.data = data;
  }
  get length() {
    return this.data.length;
  }
  get isPump() {
    return isPump(this.src) || isPump(this.dst);
  }
  body() {
    return Buffer.concat([
      Buffer.from([A5, this.sub, this.dst, this.src, this.cfi, this.length]),
      this.data
    ]);
  }
  toBytes(idle = 2) {
    const body = this.body();
    const ck = checksum(body);
    return Buffer.concat([
      Buffer.alloc(idle, IDLE),
      START,
      body,
      Buffer.from([ck >> 8, ck & 255])
    ]);
  }
  toString() {
    return `${addressName(this.src)}->${addressName(this.dst)} ` + `[${actionName(this.cfi, this.isPump)}] ` + `len=${this.length} data=${this.data.toString("hex")}`;
  }
}
function parseFrame(frame) {
  const a5 = frame.indexOf(A5);
  if (a5 < 0)
    throw new Error("no 0xA5 start byte in frame");
  const rest = frame.subarray(a5);
  if (rest.length < MIN_BODY)
    throw new Error("frame too short for an A5 packet");
  const end = HEADER_LEN + rest[5];
  if (rest.length < end + 2)
    throw new Error("frame shorter than declared data length + checksum");
  const body = rest.subarray(0, end);
  const got = rest[end] << 8 | rest[end + 1];
  const want = checksum(body);
  if (got !== want)
    throw new ChecksumError(`checksum mismatch: frame=${got} computed=${want}`);
  return new Packet(rest[1], rest[2], rest[3], rest[4], Buffer.from(rest.subarray(HEADER_LEN, end)));
}

// server/reader.ts
var MARKER = Buffer.from([0, 255, A5]);

class PacketReader {
  maxBuffer;
  buf = Buffer.alloc(0);
  constructor(maxBuffer = 4096) {
    this.maxBuffer = maxBuffer;
  }
  feed(chunk) {
    if (chunk.length)
      this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;; ) {
      const marker = this.buf.indexOf(MARKER);
      if (marker < 0) {
        if (this.buf.length > this.maxBuffer)
          this.buf = this.buf.subarray(-2);
        return out;
      }
      const a5 = marker + 2;
      if (this.buf.length < a5 + HEADER_LEN) {
        this.buf = this.buf.subarray(marker);
        return out;
      }
      const length = this.buf[a5 + 5];
      const end = a5 + HEADER_LEN + length;
      if (this.buf.length < end + 2) {
        this.buf = this.buf.subarray(marker);
        return out;
      }
      const body = this.buf.subarray(a5, end);
      const got = this.buf[end] << 8 | this.buf[end + 1];
      if (got === checksum(body)) {
        out.push(new Packet(body[1], body[2], body[3], body[4], Buffer.from(body.subarray(HEADER_LEN))));
        this.buf = this.buf.subarray(end + 2);
      } else {
        this.buf = this.buf.subarray(a5);
      }
    }
  }
  reset() {
    this.buf = Buffer.alloc(0);
  }
}

// server/bus.ts
var DEFAULT_PORT = "/dev/ttyUSB0";
var DEFAULT_BAUD = 9600;
function parseHhmm(text) {
  const parts = String(text).trim().split(":");
  if (parts.length !== 2)
    throw new Error(`invalid time ${text}, expected HH:MM`);
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute))
    throw new Error(`invalid time ${text}, expected HH:MM`);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
    throw new Error(`time out of range: ${text}`);
  return [hour, minute];
}
function datetimeFields(when, autoDst = true) {
  const d = when ?? new Date;
  const dow = 1 << d.getDay();
  return [
    d.getHours(),
    d.getMinutes(),
    dow,
    d.getDate(),
    d.getMonth() + 1,
    d.getFullYear() % 100,
    autoDst ? 1 : 0
  ];
}
function resolveCircuit(nameOrNumber) {
  const key = String(nameOrNumber).trim().toLowerCase();
  if (key in CIRCUIT_NUMBERS)
    return CIRCUIT_NUMBERS[key];
  const num = key === "" ? NaN : Number(key);
  if (!Number.isFinite(num))
    throw new Error(`unknown circuit: ${nameOrNumber}`);
  return num;
}

class BufferedLink {
  out;
  closeFn;
  chunks = [];
  err = null;
  constructor(out, closeFn) {
    this.out = out;
    this.closeFn = closeFn;
  }
  onData = (chunk) => {
    this.chunks.push(chunk);
  };
  onError = (exc) => {
    this.err = String(exc.message ?? exc);
  };
  onClose = () => {
    this.err ??= "connection closed";
  };
  take() {
    if (!this.chunks.length)
      return Buffer.alloc(0);
    const buf = Buffer.concat(this.chunks);
    this.chunks = [];
    return buf;
  }
  write(data) {
    this.out.write(data);
  }
  close() {
    try {
      this.closeFn();
    } catch {}
  }
  failure() {
    return this.err;
  }
}
function openSocket(url) {
  const target = url.replace(/^tcp:\/\//, "socket://").slice("socket://".length);
  const idx = target.lastIndexOf(":");
  if (idx < 0)
    throw new Error(`invalid socket URL: ${url} (want socket://HOST:PORT)`);
  const host = target.slice(0, idx);
  const port = Number(target.slice(idx + 1));
  if (!Number.isInteger(port))
    throw new Error(`invalid port in ${url}`);
  const sock = new Socket;
  const link = new BufferedLink(sock, () => sock.destroy());
  sock.on("data", link.onData);
  sock.on("error", link.onError);
  sock.on("close", link.onClose);
  sock.connect(port, host);
  return link;
}
function openDevice(path, baud) {
  const flag = process.platform === "linux" ? "-F" : "-f";
  try {
    execFileSync("stty", [flag, path, String(baud), "cs8", "-cstopb", "-parenb", "raw", "-echo"], {
      stdio: "ignore"
    });
  } catch (exc) {
    throw new Error(`stty failed for ${path}: ${exc.message}`);
  }
  const reader = createReadStream(path);
  const writer = createWriteStream(path);
  const link = new BufferedLink(writer, () => {
    reader.destroy();
    writer.destroy();
  });
  reader.on("data", (c) => link.onData(Buffer.from(c)));
  reader.on("error", link.onError);
  reader.on("close", link.onClose);
  writer.on("error", link.onError);
  return link;
}

class Bus {
  portName;
  baud;
  address;
  link = null;
  reader = new PacketReader;
  controllerSub;
  constructor(portName = DEFAULT_PORT, baud = DEFAULT_BAUD, address = Address.REMOTE, defaultSub = 1) {
    this.portName = portName;
    this.baud = baud;
    this.address = address;
    this.controllerSub = defaultSub;
  }
  open() {
    if (this.link)
      return this;
    this.link = this.portName.includes("://") ? openSocket(this.portName) : openDevice(this.portName, this.baud);
    return this;
  }
  close() {
    this.link?.close();
    this.link = null;
    this.reader.reset();
  }
  attach(link) {
    this.link = link;
    return this;
  }
  get active() {
    if (!this.link)
      throw new Error("port is not open; call open() first");
    return this.link;
  }
  failure() {
    return this.link?.failure() ?? null;
  }
  read() {
    return this.active.take();
  }
  feed(chunk) {
    const pkts = this.reader.feed(chunk);
    for (const pkt of pkts) {
      if (pkt.src === Address.MAIN)
        this.controllerSub = pkt.sub;
    }
    return pkts;
  }
  send(pkt, idle = 4) {
    this.active.write(pkt.toBytes(idle));
  }
  sendRaw(data) {
    this.active.write(data);
  }
  command(cfi, ...data) {
    return new Packet(this.controllerSub, Address.MAIN, this.address, cfi, Buffer.from(data));
  }
  buildSetCircuit(circuit, on) {
    return this.command(Action.SET_CIRCUIT, circuit, on ? 1 : 0);
  }
  buildGetHeat() {
    return this.command(Action.GET_HEAT, 0);
  }
  buildSetHeat(poolSp, spaSp, heatMode) {
    return this.command(Action.SET_HEAT, poolSp & 255, spaSp & 255, heatMode & 255, 0);
  }
  buildGetSchedules(scheduleId = 1) {
    return this.command(Action.GET_SCHEDULE, scheduleId);
  }
  buildSetSchedule(scheduleId, circuit, start, end, daysMask) {
    const [sh, sm] = parseHhmm(start);
    const [eh, em] = parseHhmm(end);
    return this.command(Action.SET_SCHEDULE, scheduleId, circuit, sh, sm, eh, em, daysMask & 255);
  }
  buildSetDatetime(hour, minute, dow, day, month, year, autoDst = 1) {
    return this.command(Action.SET_DATETIME, hour & 255, minute & 255, dow & 255, day & 255, month & 255, year & 255, autoDst ? 1 : 0);
  }
  buildGetVersion() {
    return this.command(Action.GET_VERSION, 0);
  }
  buildSetLight(command) {
    return this.command(Action.SET_COLOR, command & 255);
  }
  pumpCommand(pump, cfi, ...data) {
    return new Packet(this.controllerSub, Address.PUMP1 + (pump - 1), this.address, cfi, Buffer.from(data));
  }
  buildPumpRemoteControl(pump, enable = true) {
    return this.pumpCommand(pump, 4, enable ? 255 : 0);
  }
  buildSetPumpSpeed(pump, rpm) {
    return this.pumpCommand(pump, 1, 2, 196, rpm >> 8 & 255, rpm & 255);
  }
}

// server/api.ts
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// server/decode.ts
function specReader(pkt) {
  const body = pkt.body();
  return (i) => i < body.length ? body[i] : 0;
}
var pad2 = (n) => String(n).padStart(2, "0");
function equipCircuits(equip1, equip2, equip3) {
  const on = [];
  [equip1, equip2, equip3].forEach((value, byteIndex) => {
    for (let bit = 0;bit < 8; bit++) {
      if (value & 1 << bit)
        on.push(byteIndex * 8 + bit + 1);
    }
  });
  return on;
}
function heatModes(byte) {
  return [HEAT_MODES[byte & 3] ?? "?", HEAT_MODES[byte >> 2 & 3] ?? "?"];
}
function mergeHeatMode(currentRaw, poolMode, spaMode) {
  let mode = currentRaw;
  if (poolMode != null)
    mode = mode & ~3 | poolMode & 3;
  if (spaMode != null)
    mode = mode & ~12 | (spaMode & 3) << 2;
  return mode;
}
var DAY_BITS = [
  ["Sun", 1],
  ["Mon", 2],
  ["Tue", 4],
  ["Wed", 8],
  ["Thu", 16],
  ["Fri", 32],
  ["Sat", 64]
];
var ALL_DAYS = 127;
var DAY_ALIASES = {
  sunday: 1,
  sun: 1,
  monday: 2,
  mon: 2,
  tuesday: 4,
  tue: 4,
  wednesday: 8,
  wed: 8,
  thursday: 16,
  thu: 16,
  friday: 32,
  fri: 32,
  saturday: 64,
  sat: 64
};
function decodeDays(mask) {
  if ((mask & ALL_DAYS) === ALL_DAYS)
    return ["Every day"];
  return DAY_BITS.filter(([, bit]) => mask & bit).map(([name]) => name);
}
function encodeDays(tokens) {
  if (typeof tokens === "number")
    return tokens;
  const list = typeof tokens === "string" ? tokens.replace(/,/g, " ").split(/\s+/) : tokens;
  let mask = 0;
  for (const token of list) {
    const key = token.trim().toLowerCase();
    if (!key)
      continue;
    if (["every", "everyday", "all", "daily"].includes(key))
      return ALL_DAYS;
    if (key === "weekdays")
      mask |= 62;
    else if (key === "weekends")
      mask |= 65;
    else if (key in DAY_ALIASES)
      mask |= DAY_ALIASES[key];
    else
      throw new Error(`unknown day: ${token}`);
  }
  return mask;
}
function decodeControllerStatus(pkt) {
  const b = specReader(pkt);
  const equip = [b(8), b(9), b(10)];
  const circuits = equipCircuits(...equip);
  const runmode = b(15);
  const [poolMode, spaMode] = heatModes(b(28));
  const celsius = Boolean(runmode & RUNMODE_CELSIUS);
  return {
    clock: `${pad2(b(6))}:${pad2(b(7))}`,
    circuits_on: circuits,
    circuit_names: circuits.map((c) => circuitLabel(c)),
    pool_temp: b(20),
    spa_temp: b(21),
    air_temp: b(24),
    solar_temp: b(25),
    heater_on: b(22) !== 0,
    pool_heat_mode: poolMode,
    spa_heat_mode: spaMode,
    celsius,
    service: Boolean(runmode & RUNMODE_SERVICE),
    freeze: Boolean(runmode & RUNMODE_FREEZE),
    valve: b(16),
    delay: b(18),
    auto_dst: Boolean(b(32) & 1),
    raw_equip: equip,
    unit: celsius ? "C" : "F"
  };
}
function decodeDatetime(pkt) {
  const b = specReader(pkt);
  const [hour, minute, dow, day, month, year] = [b(6), b(7), b(8), b(9), b(10), b(11)];
  return {
    hour,
    minute,
    day,
    month,
    year,
    dow,
    iso: `${2000 + year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`
  };
}
function decodePumpStatus(pkt) {
  const b = specReader(pkt);
  return {
    pump: isPump(pkt.src) ? pkt.src - Address.PUMP1 + 1 : 0,
    cmd: b(6),
    mode: b(7),
    drive_state: b(8),
    watts: b(9) << 8 | b(10),
    rpm: b(11) << 8 | b(12),
    gpm: b(13),
    ppc: b(14),
    error: b(15),
    run_minutes: b(19) * 60 + b(20)
  };
}
function decodeSchedule(pkt) {
  const b = specReader(pkt);
  const circuit = b(7);
  const mask = b(12);
  return {
    id: b(6),
    circuit,
    circuit_name: circuit ? circuitLabel(circuit) : "(unused)",
    start: `${pad2(b(8))}:${pad2(b(9))}`,
    end: `${pad2(b(10))}:${pad2(b(11))}`,
    days_mask: mask,
    days: decodeDays(mask),
    active: circuit !== 0
  };
}
function decodeHeatStatus(pkt) {
  const b = specReader(pkt);
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
    cool_setpoint: b(15)
  };
}
function decodeVersion(pkt) {
  const b = specReader(pkt);
  const [major, minor] = [b(6), b(7)];
  return {
    version: `${major}.${String(minor).padStart(3, "0")}`,
    major,
    minor,
    raw: pkt.data.toString("hex")
  };
}
function decodeValve(pkt) {
  return { valves: [...pkt.data], raw: pkt.data.toString("hex") };
}
function decodeIntellichem(pkt) {
  const b = specReader(pkt);
  const u16 = (i) => b(i) << 8 | b(i + 1);
  return {
    ph: u16(6) / 100,
    orp: u16(8),
    ph_setpoint: u16(10) / 100,
    orp_setpoint: u16(12),
    raw: pkt.data.toString("hex")
  };
}
function decodeCircuitNames(pkt) {
  const b = specReader(pkt);
  return { circuit: b(6), function: b(7), name_id: b(8), raw: pkt.data.toString("hex") };
}
function decode(pkt) {
  const fromMain = pkt.src === Address.MAIN;
  if (pkt.cfi === Action.CONTROLLER_STATUS && fromMain)
    return { kind: "status", value: decodeControllerStatus(pkt) };
  if (pkt.cfi === Action.DATE_TIME && fromMain)
    return { kind: "datetime", value: decodeDatetime(pkt) };
  if (pkt.cfi === Action.HEAT_STATUS && fromMain)
    return { kind: "heat", value: decodeHeatStatus(pkt) };
  if (pkt.cfi === Action.SCHEDULE && fromMain)
    return { kind: "schedule", value: decodeSchedule(pkt) };
  if (pkt.cfi === Action.PUMP_STATUS && isPump(pkt.src))
    return { kind: "pump", value: decodePumpStatus(pkt) };
  if (pkt.cfi === Action.SW_VERSION && fromMain)
    return { kind: "version", value: decodeVersion(pkt) };
  if (pkt.cfi === Action.VALVE_STATUS && fromMain)
    return { kind: "valves", value: decodeValve(pkt) };
  if (pkt.cfi === Action.INTELLICHEM && (pkt.src === Address.INTELLICHEM || pkt.src === Address.MAIN))
    return { kind: "intellichem", value: decodeIntellichem(pkt) };
  if (pkt.cfi === Action.CIRCUIT_NAMES && fromMain)
    return { kind: "names", value: decodeCircuitNames(pkt) };
  return { kind: "unknown", value: pkt };
}

// server/intellichlor.ts
var DLE = 16;
var STX = 2;
var ETX = 3;
var IC_START = Buffer.from([DLE, STX]);
var IC_END = Buffer.from([DLE, ETX]);
var SALT_UNIT_PPM = 50;
var ICAddress = {
  CONTROLLER: 0,
  CHLORINATOR: 80
};
var ICCommand = {
  SET_OUTPUT: 17,
  STATUS: 18
};
var IC_DESTS = new Set([ICAddress.CONTROLLER, ICAddress.CHLORINATOR]);
var IC_COMMANDS = new Set([ICCommand.SET_OUTPUT, ICCommand.STATUS]);
function icChecksum(headerAndData) {
  let sum = 0;
  for (const byte of headerAndData)
    sum += byte;
  return sum & 255;
}

class ChlorinatorReader {
  maxBuffer;
  buf = Buffer.alloc(0);
  constructor(maxBuffer = 512) {
    this.maxBuffer = maxBuffer;
  }
  feed(chunk) {
    if (chunk.length)
      this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;; ) {
      const start = this.buf.indexOf(IC_START);
      if (start < 0) {
        if (this.buf.length > this.maxBuffer)
          this.buf = this.buf.subarray(-1);
        break;
      }
      if (start > 0)
        this.buf = this.buf.subarray(start);
      if (this.buf.length < 4)
        break;
      if (!IC_DESTS.has(this.buf[2]) || !IC_COMMANDS.has(this.buf[3])) {
        this.buf = this.buf.subarray(2);
        continue;
      }
      const end = this.buf.indexOf(IC_END, 2);
      if (end < 0) {
        if (this.buf.length > this.maxBuffer) {
          this.buf = this.buf.subarray(2);
          continue;
        }
        break;
      }
      const inner = this.buf.subarray(2, end);
      if (inner.length >= 3) {
        const chk = inner[inner.length - 1];
        const body = this.buf.subarray(0, end - 1);
        if (icChecksum(body) === chk) {
          out.push({
            dest: inner[0],
            cmd: inner[1],
            data: Buffer.from(inner.subarray(2, inner.length - 1))
          });
          this.buf = this.buf.subarray(end + 2);
          continue;
        }
      }
      this.buf = this.buf.subarray(2);
    }
    return out;
  }
  reset() {
    this.buf = Buffer.alloc(0);
  }
}
function clampPercent(percent) {
  return Math.max(0, Math.min(100, Math.trunc(percent)));
}
function buildSetOutput(percent, dest = ICAddress.CHLORINATOR) {
  const pct = clampPercent(percent);
  const body = Buffer.from([DLE, STX, dest, ICCommand.SET_OUTPUT, pct]);
  return Buffer.concat([body, Buffer.from([icChecksum(body)]), IC_END]);
}
function decodeIc(frame) {
  if (frame.cmd === ICCommand.STATUS && frame.data.length >= 2) {
    return {
      kind: "status",
      value: { salt_ppm: frame.data[0] * SALT_UNIT_PPM, status_flags: frame.data[1] }
    };
  }
  if (frame.cmd === ICCommand.SET_OUTPUT && frame.data.length >= 1) {
    return { kind: "set_output", value: { output_percent: frame.data[0] } };
  }
  return null;
}

// server/monitor.ts
var SCHEDULE_SLOTS = 12;
var POLL_INTERVAL_MS = 300;
var STALE_AFTER_S = 30;
var RECONNECT_GAP_MS = 2000;

class BusMonitor {
  refreshInterval;
  bus;
  status = null;
  heat = null;
  datetime = null;
  version = null;
  valves = null;
  intellichem = null;
  pumps = {};
  schedules = {};
  names = {};
  raw = {};
  chlorReader = new ChlorinatorReader;
  chlor = {};
  chlorTs = null;
  cmdQueue = [];
  connected = false;
  lastPacketTs = null;
  error = null;
  timer = null;
  nextRefresh = 0;
  primed = false;
  heatReread = 0;
  schedReread = 0;
  schedRereadId = 1;
  schedScan = [];
  nextSchedReq = 0;
  schedReqGap = 1000;
  staleDeadline = Infinity;
  constructor(port, baud = DEFAULT_BAUD, address = Address.REMOTE, refreshInterval = 15000) {
    this.refreshInterval = refreshInterval;
    this.bus = new Bus(port, baud, address);
  }
  start() {
    if (this.timer)
      return this;
    try {
      this.bus.open();
      this.connected = true;
      this.staleDeadline = performance.now() + STALE_AFTER_S * 1000;
    } catch (exc) {
      this.error = String(exc.message ?? exc);
      this.connected = false;
    }
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    return this;
  }
  stop() {
    if (this.timer)
      clearInterval(this.timer);
    this.timer = null;
    this.bus.close();
  }
  tick() {
    let ok = false;
    try {
      ok = this.pollOnce();
    } catch (exc) {
      this.error = String(exc.message ?? exc);
      this.connected = false;
    }
    if (!ok)
      this.reconnect();
  }
  nextReconnect = 0;
  reconnect() {
    const now = performance.now();
    if (now < this.nextReconnect)
      return;
    this.nextReconnect = now + RECONNECT_GAP_MS;
    try {
      this.bus.close();
      this.bus.open();
      this.connected = true;
      this.error = null;
      this.staleDeadline = performance.now() + STALE_AFTER_S * 1000;
    } catch (exc) {
      this.error = String(exc.message ?? exc);
      this.connected = false;
    }
  }
  pollOnce() {
    let chunk;
    try {
      chunk = this.bus.read();
    } catch (exc) {
      this.connected = false;
      this.error = String(exc.message ?? exc);
      return false;
    }
    const failure = this.bus.failure();
    if (failure) {
      this.connected = false;
      this.error = failure;
      return false;
    }
    this.connected = true;
    this.error = null;
    const pkts = this.bus.feed(chunk);
    for (const pkt of pkts)
      this.ingest(pkt);
    const frames = this.chlorReader.feed(chunk);
    for (const frame of frames)
      this.ingestIc(frame);
    if (pkts.length || frames.length) {
      this.staleDeadline = performance.now() + STALE_AFTER_S * 1000;
    } else if (performance.now() > this.staleDeadline) {
      this.connected = false;
      this.error = `no bus traffic for ${STALE_AFTER_S}s; reconnecting`;
      return false;
    }
    this.maybeRefresh();
    this.serviceSchedScan();
    this.serviceRereads();
    this.drainCommands();
    return true;
  }
  serviceRereads() {
    if (!this.primed)
      return;
    if (this.heatReread > 0) {
      this.heatReread -= 1;
      this.cmdQueue.push(this.bus.buildGetHeat());
    }
    if (this.schedReread > 0) {
      this.schedReread -= 1;
      this.cmdQueue.push(this.bus.buildGetSchedules(this.schedRereadId));
    }
  }
  serviceSchedScan() {
    if (!this.primed || !this.schedScan.length)
      return;
    const now = performance.now();
    if (now < this.nextSchedReq)
      return;
    this.nextSchedReq = now + this.schedReqGap;
    this.cmdQueue.push(this.bus.buildGetSchedules(this.schedScan.shift()));
  }
  ingest(pkt) {
    const obj = decode(pkt);
    switch (obj.kind) {
      case "status":
        this.status = obj.value;
        break;
      case "heat":
        this.heat = obj.value;
        break;
      case "datetime":
        this.datetime = obj.value;
        break;
      case "version":
        this.version = obj.value;
        break;
      case "valves":
        this.valves = obj.value;
        break;
      case "intellichem":
        this.intellichem = obj.value;
        break;
      case "pump":
        this.pumps[obj.value.pump] = obj.value;
        break;
      case "schedule":
        this.schedules[obj.value.id] = obj.value;
        break;
      case "names":
        this.names[obj.value.circuit] = obj.value;
        break;
      default:
        break;
    }
    this.raw[pkt.cfi] = pkt.toBytes(0).toString("hex");
    this.lastPacketTs = Date.now() / 1000;
    if (pkt.src === Address.MAIN) {
      this.primed = true;
    }
  }
  ingestIc(frame) {
    const obj = decodeIc(frame);
    if (!obj)
      return;
    if (obj.kind === "status") {
      this.chlor.salt_ppm = obj.value.salt_ppm;
      this.chlor.status_flags = obj.value.status_flags;
    } else {
      this.chlor.output_percent = obj.value.output_percent;
    }
    const now = Date.now() / 1000;
    this.chlorTs = now;
    this.lastPacketTs = now;
  }
  maybeRefresh() {
    if (!this.primed)
      return;
    const now = performance.now();
    if (now < this.nextRefresh)
      return;
    this.nextRefresh = now + this.refreshInterval;
    this.cmdQueue.push(this.bus.buildGetHeat());
    if (this.version == null)
      this.cmdQueue.push(this.bus.buildGetVersion());
    this.schedScan = Array.from({ length: SCHEDULE_SLOTS }, (_, i) => i + 1);
    this.nextSchedReq = now + this.schedReqGap;
  }
  drainCommands() {
    while (this.cmdQueue.length) {
      const cmd = this.cmdQueue.shift();
      try {
        if (Buffer.isBuffer(cmd))
          this.bus.sendRaw(cmd);
        else
          this.bus.send(cmd);
      } catch (exc) {
        this.error = String(exc.message ?? exc);
      }
    }
  }
  getState() {
    const now = Date.now() / 1000;
    const chlor = Object.keys(this.chlor).length ? { ...this.chlor } : null;
    if (chlor) {
      chlor.last_seen_ts = this.chlorTs;
      chlor.age = this.chlorTs === null ? null : now - this.chlorTs;
    }
    return {
      connected: this.connected,
      error: this.error,
      last_packet_ts: this.lastPacketTs,
      age: this.lastPacketTs === null ? null : now - this.lastPacketTs,
      status: this.status,
      heat: this.heat,
      datetime: this.datetime,
      version: this.version,
      valves: this.valves,
      intellichem: this.intellichem,
      names: { ...this.names },
      pumps: { ...this.pumps },
      schedules: { ...this.schedules },
      chlorinator: chlor,
      raw: { ...this.raw }
    };
  }
  async flush(timeoutMs = 5000) {
    const deadline = performance.now() + timeoutMs;
    while (this.cmdQueue.length && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
  async waitFor(predicate, timeoutMs = 6000, intervalMs = 100) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const st2 = this.getState();
      if (predicate(st2))
        return st2;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const st = this.getState();
    return predicate(st) ? st : null;
  }
  setCircuit(circuit, on) {
    this.cmdQueue.push(this.bus.buildSetCircuit(circuit, on));
  }
  setChlorinatorOutput(percent) {
    const pct = clampPercent(percent);
    this.cmdQueue.push(buildSetOutput(pct));
    this.chlor.output_percent = pct;
    return pct;
  }
  setDatetime(when, autoDst = true) {
    const [h, m, dow, day, mon, yr, dst] = datetimeFields(when, autoDst);
    this.cmdQueue.push(this.bus.buildSetDatetime(h, m, dow, day, mon, yr, dst));
    return { hour: h, minute: m, dow, day, month: mon, year: 2000 + yr, auto_dst: Boolean(dst) };
  }
  setLight(command) {
    const code = resolveLightCommand(command);
    this.cmdQueue.push(this.bus.buildSetLight(code));
    return code;
  }
  setPumpSpeed(pump, rpm) {
    this.cmdQueue.push(this.bus.buildPumpRemoteControl(pump, true));
    this.cmdQueue.push(this.bus.buildSetPumpSpeed(pump, rpm));
    return { pump, rpm, experimental: true };
  }
  setHeat(poolSetpoint, spaSetpoint, poolMode, spaMode) {
    const cur = this.heat;
    if (!cur)
      throw new Error("no heat status cached yet; try again shortly");
    const psp = poolSetpoint ?? cur.pool_setpoint;
    const ssp = spaSetpoint ?? cur.spa_setpoint;
    const mode = mergeHeatMode(cur.heat_mode_raw, poolMode, spaMode);
    this.cmdQueue.push(this.bus.buildSetHeat(psp, ssp, mode));
    this.heatReread = 20;
    return { pool_setpoint: psp, spa_setpoint: ssp, heat_mode: mode };
  }
  setSchedule(scheduleId, circuit, start, end, days) {
    const mask = typeof days === "number" ? days : encodeDays(days);
    this.cmdQueue.push(this.bus.buildSetSchedule(scheduleId, circuit, start, end, mask));
    this.schedReread = 12;
    this.schedRereadId = scheduleId;
  }
}
var confirmed = {
  circuit: (circuit, on) => (s) => s.status?.circuits_on.includes(circuit) === on,
  heat: (res) => (s) => s.heat != null && s.heat.pool_setpoint === res.pool_setpoint && s.heat.spa_setpoint === res.spa_setpoint && s.heat.heat_mode_raw === res.heat_mode,
  schedule: (sid) => (s) => (sid in s.schedules),
  datetime: (res) => (s) => {
    const d = s.datetime;
    return d != null && d.hour === res.hour && d.day === res.day && d.month === res.month;
  }
};

// server/api.ts
var CONFIRM_TIMEOUT_MS = 6000;
var STATIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "easytouch", "static");
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

class BadRequest extends Error {
}

class NotReady extends Error {
}
var staticCache = new Map;
function readStatic(name) {
  const path = resolve(join(STATIC_DIR, name));
  const stat = statSync(path, { throwIfNoEntry: false });
  if (dirname(path) !== STATIC_DIR || !stat?.isFile()) {
    throw new Error(`not found: ${name}`);
  }
  let entry = staticCache.get(path);
  if (entry?.mtimeMs !== stat.mtimeMs) {
    entry = { mtimeMs: stat.mtimeMs, body: readFileSync(path) };
    staticCache.set(path, entry);
  }
  const etag = `W/"${entry.mtimeMs}-${entry.body.length}"`;
  return [entry.body, CONTENT_TYPES[extname(path)] ?? "application/octet-stream", etag];
}
var SUBSETS = [
  "status",
  "heat",
  "datetime",
  "pumps",
  "schedules",
  "chlorinator",
  "version",
  "valves",
  "intellichem",
  "names",
  "raw"
];
var ENDPOINTS = {
  "GET /": "the dashboard (HTML)",
  "GET /api": "this endpoint index (JSON)",
  "GET /state": "full cached snapshot",
  "GET /{status,heat,datetime,pumps,schedules,chlorinator,version,valves,intellichem,names,raw}": "decoded subsets",
  "GET /circuit/<name-or-num>/<on|off>": "set a circuit",
  "GET /heat/pool/<temp>": "set pool setpoint",
  "GET /heat/spa/<temp>": "set spa setpoint",
  "GET /chlorinator/output/<pct>": "set chlorinator output %",
  "GET /light/<command>": "IntelliBrite light command (party, blue, on, off, ...)",
  "POST /circuit": "{circuit, on}",
  "POST /heat": "{pool_setpoint, spa_setpoint, pool_mode, spa_mode}",
  "POST /schedule": "{id, circuit, start, end, days}",
  "POST /chlorinator": "{output}",
  "POST /datetime": "{iso?} set clock (default now)",
  "POST /light": "{command}",
  "POST /pump": "{pump, rpm} (EXPERIMENTAL, unverified)"
};
var json = (code, obj) => ({ code, json: obj });
function intArg(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n))
    throw new BadRequest(`${what}, got ${JSON.stringify(value)}`);
  return n;
}
function makeServer(monitor, confirmTimeout = CONFIRM_TIMEOUT_MS) {
  const api = new PoolApi(monitor, confirmTimeout);
  return createServer((req, res) => void handle(api, req, res));
}
async function handle(api, req, res) {
  let reply;
  try {
    const parts = (req.url ?? "/").split("?")[0].split("/").filter(Boolean);
    reply = req.method === "POST" ? await api.routePost(parts, await readJson(req)) : await api.routeGet(parts);
  } catch (exc) {
    const message = String(exc.message ?? exc);
    const code = exc instanceof BadRequest ? 400 : exc instanceof NotReady ? 503 : 500;
    reply = json(code, { error: message });
  }
  if ("json" in reply) {
    const body = Buffer.from(JSON.stringify(reply.json, null, 2) + `
`);
    res.writeHead(reply.code, {
      "Content-Type": "application/json",
      "Content-Length": String(body.length)
    });
    res.end(body);
  } else if (reply.etag && req.headers["if-none-match"] === reply.etag) {
    res.writeHead(304, { ETag: reply.etag });
    res.end();
  } else {
    res.writeHead(reply.code, {
      "Content-Type": reply.contentType,
      "Content-Length": String(reply.body.length),
      ...reply.etag ? { ETag: reply.etag } : {}
    });
    res.end(reply.body);
  }
}
function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString().trim();
      if (!raw)
        return resolveBody({});
      try {
        resolveBody(JSON.parse(raw));
      } catch (exc) {
        reject(new BadRequest(`invalid JSON body: ${exc.message}`));
      }
    });
  });
}

class PoolApi {
  monitor;
  confirmTimeout;
  constructor(monitor, confirmTimeout = CONFIRM_TIMEOUT_MS) {
    this.monitor = monitor;
    this.confirmTimeout = confirmTimeout;
  }
  async routeGet(parts) {
    if (!parts.length) {
      const [body, contentType, etag] = readStatic("index.html");
      return { code: 200, body, contentType, etag };
    }
    const head = parts[0];
    if (head === "static" && parts.length === 2) {
      try {
        const [body, contentType, etag] = readStatic(parts[1]);
        return { code: 200, body, contentType, etag };
      } catch {
        return json(404, { error: "not found" });
      }
    }
    if (head === "api" && parts.length === 1)
      return json(200, { endpoints: ENDPOINTS });
    if (head === "state" && parts.length === 1)
      return json(200, this.monitor.getState());
    if (SUBSETS.includes(head) && parts.length === 1) {
      return json(200, this.monitor.getState()[head]);
    }
    if (head === "circuit" && parts.length === 3)
      return this.circuit(parts[1], parts[2]);
    if (head === "heat" && parts.length === 3 && (parts[1] === "pool" || parts[1] === "spa")) {
      const temp = intArg(parts[2], "temperature must be an integer");
      return this.setHeat({ [`${parts[1]}_setpoint`]: temp });
    }
    if (head === "chlorinator" && parts.length === 3 && parts[1] === "output") {
      return this.setChlor(intArg(parts[2], "output must be an integer 0-100"));
    }
    if (head === "light" && parts.length === 2)
      return this.setLight(parts[1]);
    return json(404, { error: `no such path: /${parts.join("/")}` });
  }
  async routePost(parts, body) {
    const path = parts.join("/");
    if (path === "circuit") {
      if (!("circuit" in body))
        throw new BadRequest("body must include 'circuit'");
      return this.circuit(String(body.circuit), body.on ? "on" : "off");
    }
    if (path === "heat") {
      const kwargs = {};
      for (const key of ["pool_setpoint", "spa_setpoint", "pool_mode", "spa_mode"]) {
        if (body[key] != null)
          kwargs[key] = intArg(body[key], `${key} must be an integer`);
      }
      if (!Object.keys(kwargs).length)
        throw new BadRequest("body must include at least one heat field");
      return this.setHeat(kwargs);
    }
    if (path === "schedule") {
      for (const key of ["id", "circuit", "start", "end"]) {
        if (!(key in body))
          throw new BadRequest(`body must include '${key}'`);
      }
      return this.setSchedule(body);
    }
    if (path === "chlorinator") {
      const value = body.output ?? body.percent;
      if (value == null)
        throw new BadRequest("body must include 'output' (0-100)");
      return this.setChlor(intArg(value, "output must be an integer 0-100"));
    }
    if (path === "datetime")
      return this.setDatetime(body);
    if (path === "light")
      return this.setLight(body.command);
    if (path === "pump")
      return this.setPump(body);
    return json(404, { error: `no such path: /${path}` });
  }
  async circuit(nameOrNum, action) {
    let circuit;
    try {
      circuit = resolveCircuit(nameOrNum);
    } catch (exc) {
      throw new BadRequest(String(exc.message));
    }
    const flag = { on: true, "1": true, off: false, "0": false }[action.toLowerCase()];
    if (flag === undefined)
      throw new BadRequest("circuit action must be on/off");
    this.monitor.setCircuit(circuit, flag);
    const st = await this.monitor.waitFor(confirmed.circuit(circuit, flag), this.confirmTimeout);
    if (st === null)
      return json(202, { accepted: true, circuit, on: flag });
    return json(200, { confirmed: true, circuit, on: flag, status: st.status });
  }
  async setHeat(kwargs) {
    let res;
    try {
      res = this.monitor.setHeat(kwargs.pool_setpoint, kwargs.spa_setpoint, kwargs.pool_mode, kwargs.spa_mode);
    } catch (exc) {
      throw new NotReady(String(exc.message));
    }
    const st = await this.monitor.waitFor(confirmed.heat(res), this.confirmTimeout);
    if (st === null)
      return json(202, { accepted: true, requested: res });
    return json(200, { confirmed: true, heat: st.heat });
  }
  async setSchedule(body) {
    const sid = intArg(body.id, "schedule id must be an integer");
    let circuit;
    try {
      circuit = resolveCircuit(String(body.circuit));
    } catch (exc) {
      throw new BadRequest(String(exc.message));
    }
    try {
      this.monitor.setSchedule(sid, circuit, String(body.start), String(body.end), body.days ?? "every");
    } catch (exc) {
      throw new BadRequest(String(exc.message));
    }
    const st = await this.monitor.waitFor(confirmed.schedule(sid), this.confirmTimeout);
    if (st === null)
      return json(202, { accepted: true, id: sid });
    return json(200, { confirmed: true, schedule: st.schedules[sid] });
  }
  setChlor(value) {
    return json(200, { sent: true, output_percent: this.monitor.setChlorinatorOutput(value) });
  }
  async setDatetime(body) {
    let when = null;
    if (body.iso) {
      when = new Date(String(body.iso));
      if (Number.isNaN(when.getTime()))
        throw new BadRequest(`invalid iso datetime: ${body.iso}`);
    }
    const res = this.monitor.setDatetime(when);
    const st = await this.monitor.waitFor(confirmed.datetime(res), this.confirmTimeout);
    if (st === null)
      return json(202, { accepted: true, requested: res });
    return json(200, { confirmed: true, datetime: st.datetime });
  }
  setLight(command) {
    if (command == null)
      throw new BadRequest("body must include 'command'");
    let code;
    try {
      code = this.monitor.setLight(command);
    } catch (exc) {
      throw new BadRequest(String(exc.message));
    }
    return json(200, { sent: true, command, code });
  }
  setPump(body) {
    if (body.pump == null || body.rpm == null)
      throw new BadRequest("body must include 'pump' and 'rpm'");
    const res = this.monitor.setPumpSpeed(intArg(body.pump, "pump must be an integer"), intArg(body.rpm, "rpm must be an integer"));
    return json(200, { sent: true, ...res });
  }
}
function serve(opts) {
  const httpHost = opts.httpHost ?? "0.0.0.0";
  const httpPort = opts.httpPort ?? 8080;
  const monitor = new BusMonitor(opts.port, opts.baud, opts.address, opts.refreshInterval ?? 15000).start();
  const server = makeServer(monitor);
  server.listen(httpPort, httpHost, () => {
    console.log(`easytouch API on http://${httpHost}:${httpPort}  (bus: ${opts.port})`);
  });
  const shutdown = () => {
    server.close();
    monitor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return { server, monitor };
}

// server/cli.ts
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0;i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--"))
      flags[arg.slice(2)] = argv[++i] ?? "";
    else
      rest.push(arg);
  }
  const cmd = rest.shift() ?? "status";
  return {
    cmd,
    opts: {
      port: flags.port ?? process.env.EASYTOUCH_PORT ?? DEFAULT_PORT,
      baud: Number(flags.baud ?? DEFAULT_BAUD),
      seconds: Number(flags.seconds ?? 0),
      httpHost: flags["http-host"] ?? "0.0.0.0",
      httpPort: Number(flags["http-port"] ?? 8080),
      rest,
      flags
    }
  };
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withMonitor(opts, fn) {
  const mon = new BusMonitor(opts.port, opts.baud, Address.REMOTE).start();
  try {
    return await fn(mon);
  } finally {
    mon.stop();
  }
}
async function firstOf(mon, key, timeout = 1e4) {
  const st = await mon.waitFor((s) => s[key] != null, timeout);
  if (!st)
    throw new Error(`no ${String(key)} within ${timeout / 1000}s`);
  return st;
}
function printStatus(s) {
  const circuits = s.circuit_names.length ? s.circuit_names.join(", ") : "(all off)";
  console.log(`  Clock        : ${s.clock}`);
  console.log(`  Circuits on  : ${circuits}  [${s.circuits_on}]`);
  console.log(`  Pool temp    : ${s.pool_temp}°${s.unit}`);
  console.log(`  Spa temp     : ${s.spa_temp}°${s.unit}`);
  console.log(`  Air temp     : ${s.air_temp}°${s.unit}`);
  console.log(`  Solar temp   : ${s.solar_temp}°${s.unit}`);
  console.log(`  Heater       : ${s.heater_on ? "ON" : "off"}`);
  console.log(`  Heat mode    : pool=${s.pool_heat_mode}  spa=${s.spa_heat_mode}`);
  if (s.service)
    console.log("  Mode         : SERVICE");
  if (s.freeze)
    console.log("  Freeze       : ACTIVE");
}
async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  if (cmd === "serve") {
    serve({
      port: opts.port,
      baud: opts.baud,
      httpHost: opts.httpHost,
      httpPort: opts.httpPort
    });
    return -1;
  }
  if (cmd === "status") {
    return withMonitor(opts, async (mon) => {
      console.log(`EasyTouch status @ ${opts.port}:`);
      printStatus((await firstOf(mon, "status")).status);
      return 0;
    });
  }
  if (cmd === "json") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      await sleep(2000);
      console.log(JSON.stringify(mon.getState(), null, 2));
      return 0;
    });
  }
  if (cmd === "monitor" || cmd === "raw") {
    return withMonitor(opts, async (mon) => {
      console.log(`Monitoring ${opts.port} (Ctrl-C to stop)...`);
      const seen = new Set;
      const deadline = opts.seconds ? Date.now() + opts.seconds * 1000 : Infinity;
      while (Date.now() < deadline) {
        for (const [cfi, hex] of Object.entries(mon.getState().raw)) {
          const key = `${cfi}:${hex}`;
          if (seen.has(key))
            continue;
          seen.add(key);
          const ts = new Date().toTimeString().slice(0, 8);
          if (cmd === "raw")
            console.log(`[${ts}] ${hex}`);
          else {
            try {
              const pkt = parseFrame(Buffer.from(hex, "hex"));
              console.log(`[${ts}] ${String(decode(pkt).kind)} ${String(pkt)}`);
            } catch {
              console.log(`[${ts}] ${hex}`);
            }
          }
        }
        await sleep(300);
      }
      return 0;
    });
  }
  if (cmd === "on" || cmd === "off") {
    const circuit = resolveCircuit(opts.rest[0] ?? "");
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      mon.setCircuit(circuit, cmd === "on");
      const st = await mon.waitFor(confirmed.circuit(circuit, cmd === "on"), 8000);
      console.log(st ? `circuit ${circuit} is ${cmd}` : `circuit ${circuit} not confirmed`);
      if (st?.status)
        printStatus(st.status);
      return st ? 0 : 1;
    });
  }
  if (cmd === "heat") {
    return withMonitor(opts, async (mon) => {
      const h = (await firstOf(mon, "heat", 12000)).heat;
      console.log(`  Pool  : ${h.pool_temp}° (set ${h.pool_setpoint}°)  ${h.pool_heat_mode}`);
      console.log(`  Spa   : ${h.spa_temp}° (set ${h.spa_setpoint}°)  ${h.spa_heat_mode}`);
      console.log(`  Air   : ${h.air_temp}°`);
      return 0;
    });
  }
  if (cmd === "set-heat") {
    const num = (k) => opts.flags[k] == null ? undefined : Number(opts.flags[k]);
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "heat", 12000);
      const res = mon.setHeat(num("pool"), num("spa"), num("pool-mode"), num("spa-mode"));
      const st = await mon.waitFor(confirmed.heat(res), 8000);
      console.log(st ? `confirmed: ${JSON.stringify(st.heat)}` : `sent (unconfirmed): ${JSON.stringify(res)}`);
      return st ? 0 : 1;
    });
  }
  if (cmd === "schedules") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      await sleep((SCHEDULE_SLOTS + 3) * mon.schedReqGap);
      const scheds = Object.values(mon.getState().schedules).filter((s) => s.active);
      if (!scheds.length) {
        console.log("no schedules programmed");
        return 0;
      }
      for (const s of scheds.sort((a, b) => a.id - b.id)) {
        console.log(`  ${s.id}: ${s.circuit_name.padEnd(8)} ${s.start}-${s.end}  ${s.days.join(",")}`);
      }
      return 0;
    });
  }
  if (cmd === "set-schedule") {
    const { flags } = opts;
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const id = Number(flags.id);
      mon.setSchedule(id, resolveCircuit(flags.circuit ?? ""), flags.start ?? "", flags.end ?? "", flags.days ?? "every");
      const st = await mon.waitFor(confirmed.schedule(id), 15000);
      console.log(st ? `confirmed: ${JSON.stringify(st.schedules[id])}` : "sent (unconfirmed)");
      return st ? 0 : 1;
    });
  }
  if (cmd === "set-chlor") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const pct = mon.setChlorinatorOutput(Number(opts.flags.percent));
      await mon.flush();
      console.log(`sent: output ${pct}% (best-effort; the controller may override)`);
      return 0;
    });
  }
  if (cmd === "set-clock") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const res = mon.setDatetime(opts.flags.when ? new Date(opts.flags.when) : null);
      const st = await mon.waitFor(confirmed.datetime(res), 8000);
      console.log(st ? `confirmed: ${JSON.stringify(st.datetime)}` : `sent (unconfirmed): ${JSON.stringify(res)}`);
      return st ? 0 : 1;
    });
  }
  if (cmd === "light") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const code = mon.setLight(opts.rest[0] ?? "");
      await mon.flush();
      console.log(`sent light command ${opts.rest[0]} (code ${code}) — no status to confirm against`);
      return 0;
    });
  }
  if (cmd === "set-pump") {
    return withMonitor(opts, async (mon) => {
      await firstOf(mon, "status");
      const res = mon.setPumpSpeed(Number(opts.flags.pump ?? 1), Number(opts.flags.rpm));
      await mon.flush();
      console.log(`sent (EXPERIMENTAL, unverified): ${JSON.stringify(res)}`);
      return 0;
    });
  }
  console.error(`unknown command: ${cmd}
run with one of: serve status json monitor raw on off ` + `heat set-heat schedules set-schedule set-chlor set-clock light set-pump`);
  return 2;
}
var code = await main();
if (code >= 0)
  process.exit(code);
