// Transport + frame builders for a Pentair EasyTouch on RS-485.
// Ported from easytouch/controller.py, minus the blocking request/confirm loops
// (those were CLI-only; the HTTP path confirms via BusMonitor.waitFor).
//
// `Bus` owns one connection and provides:
//   * `read()` / `feed()` — bytes in, decoded packets out, learning the
//     controller's protocol sub-version from observed traffic so injected
//     commands match the live bus
//   * `send()` / `sendRaw()` — bytes out
//   * `build*()` — pure frame builders, unit-testable without a connection
//
// Two transports, no dependencies:
//   * `socket://HOST:PORT` (or the `tcp://` alias) -> node:net
//   * a device path like /dev/ttyUSB0 -> node:fs, with the line configured by
//     `stty`. On Linux a serial port is just a character device; termios setup is
//     the only thing a native binding would add, and stty already does it. This is
//     what keeps the Pi install free of node-gyp / prebuilt ARM binaries.

import { execFileSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Socket } from "node:net";

import * as C from "./constants.js";
import { Packet } from "./protocol.js";
import { PacketReader } from "./reader.js";

export const DEFAULT_PORT = "/dev/ttyUSB0";
export const DEFAULT_BAUD = 9600;

/** Parse an `HH:MM` (or `H:MM`) time string into [hour, minute]. */
export function parseHhmm(text: string): [number, number] {
  const parts = String(text).trim().split(":");
  if (parts.length !== 2) throw new Error(`invalid time ${text}, expected HH:MM`);
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute))
    throw new Error(`invalid time ${text}, expected HH:MM`);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
    throw new Error(`time out of range: ${text}`);
  return [hour, minute];
}

/**
 * Build the Set-Date/Time field tuple for a date (defaults to *now*).
 * Returns `[hour, minute, dow, day, month, year, autoDst]` where `dow` is the
 * Pentair weekday bit (Sun=0x01 … Sat=0x40) and `year` is two digits.
 */
export function datetimeFields(
  when?: Date | null,
  autoDst = true
): [number, number, number, number, number, number, number] {
  const d = when ?? new Date();
  const dow = 1 << d.getDay(); // getDay(): Sun=0 -> bit 0, matching the Pentair mask
  return [
    d.getHours(), d.getMinutes(), dow, d.getDate(), d.getMonth() + 1,
    d.getFullYear() % 100, autoDst ? 1 : 0,
  ];
}

/** Map a circuit name (e.g. `pool`) or numeric string to a circuit number. */
export function resolveCircuit(nameOrNumber: string | number): number {
  const key = String(nameOrNumber).trim().toLowerCase();
  if (key in C.CIRCUIT_NUMBERS) return C.CIRCUIT_NUMBERS[key]!;
  const num = key === "" ? NaN : Number(key);
  if (!Number.isFinite(num)) throw new Error(`unknown circuit: ${nameOrNumber}`);
  return num;
}

/** The transport half of a connection — a byte pipe, however it is carried.
 *  Exported so tests can `attach()` a scripted stand-in (see monitor.test.ts). */
export interface Link {
  /** Bytes received since the last call (empty if the line was idle). */
  take(): Buffer;
  write(data: Buffer): void;
  close(): void;
  /** Set once the link fails; the monitor reconnects on it. */
  failure(): string | null;
}

/** Buffers incoming data from a stream/socket until the poll loop drains it. */
class BufferedLink implements Link {
  private chunks: Buffer[] = [];
  private err: string | null = null;

  constructor(
    private readonly out: { write(b: Buffer): unknown },
    private readonly closeFn: () => void
  ) {}

  onData = (chunk: Buffer): void => {
    this.chunks.push(chunk);
  };

  onError = (exc: Error): void => {
    this.err = String(exc.message ?? exc);
  };

  onClose = (): void => {
    this.err ??= "connection closed";
  };

  take(): Buffer {
    if (!this.chunks.length) return Buffer.alloc(0);
    const buf = Buffer.concat(this.chunks);
    this.chunks = [];
    return buf;
  }

  write(data: Buffer): void {
    this.out.write(data);
  }

  close(): void {
    try {
      this.closeFn();
    } catch {
      /* already gone */
    }
  }

  failure(): string | null {
    return this.err;
  }
}

function openSocket(url: string): BufferedLink {
  // socket://HOST:PORT (pyserial's URL form) or the tcp:// alias.
  const target = url.replace(/^tcp:\/\//, "socket://").slice("socket://".length);
  const idx = target.lastIndexOf(":");
  if (idx < 0) throw new Error(`invalid socket URL: ${url} (want socket://HOST:PORT)`);
  const host = target.slice(0, idx);
  const port = Number(target.slice(idx + 1));
  if (!Number.isInteger(port)) throw new Error(`invalid port in ${url}`);
  const sock = new Socket();
  const link = new BufferedLink(sock, () => sock.destroy());
  sock.on("data", link.onData);
  sock.on("error", link.onError);
  sock.on("close", link.onClose);
  sock.connect(port, host);
  return link;
}

function openDevice(path: string, baud: number): BufferedLink {
  // Configure the line the way pyserial would (9600 8N1, no echo, raw), then treat
  // the device as an ordinary character-device file. `-F` is GNU stty (Linux, the
  // Pi); macOS/BSD spells it `-f` — the flag is fixed per platform, so pick it
  // once instead of paying a failing spawn on every open.
  const flag = process.platform === "linux" ? "-F" : "-f";
  try {
    execFileSync("stty", [flag, path, String(baud), "cs8", "-cstopb", "-parenb", "raw", "-echo"], {
      stdio: "ignore",
    });
  } catch (exc) {
    throw new Error(`stty failed for ${path}: ${(exc as Error).message}`);
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

/** Connection to a Pentair controller on an RS-485 bus. */
export class Bus {
  private link: Link | null = null;
  private reader = new PacketReader();
  /**
   * Protocol sub/version byte to use for outgoing frames. Updated from the bus as
   * soon as we see the controller talk; falls back to `defaultSub`.
   */
  controllerSub: number;

  constructor(
    readonly portName: string = DEFAULT_PORT,
    readonly baud: number = DEFAULT_BAUD,
    readonly address: number = C.Address.REMOTE, // the address we send *from*
    defaultSub = 0x01
  ) {
    this.controllerSub = defaultSub;
  }

  // --- lifecycle ---------------------------------------------------------
  open(): this {
    if (this.link) return this;
    this.link = this.portName.includes("://")
      ? openSocket(this.portName)
      : openDevice(this.portName, this.baud);
    return this;
  }

  close(): void {
    this.link?.close();
    this.link = null;
    this.reader.reset();
  }

  /** Test seam: run against a scripted `Link` instead of a real port. */
  attach(link: Link): this {
    this.link = link;
    return this;
  }

  private get active(): Link {
    if (!this.link) throw new Error("port is not open; call open() first");
    return this.link;
  }

  /** Non-null once the link has failed — the monitor reopens on it. */
  failure(): string | null {
    return this.link?.failure() ?? null;
  }

  // --- receive -----------------------------------------------------------
  /** Bytes buffered since the last call (empty when the line is idle). */
  read(): Buffer {
    return this.active.take();
  }

  /** Decode a chunk, learning the controller sub-version as packets arrive. */
  feed(chunk: Uint8Array): Packet[] {
    const pkts = this.reader.feed(chunk);
    for (const pkt of pkts) {
      if (pkt.src === C.Address.MAIN) this.controllerSub = pkt.sub;
    }
    return pkts;
  }

  // --- transmit ----------------------------------------------------------
  /** Write a packet to the bus (with leading idle bytes to settle the line). */
  send(pkt: Packet, idle = 4): void {
    this.active.write(pkt.toBytes(idle));
  }

  /**
   * Write raw bytes to the bus (e.g. an IntelliChlor native-protocol frame).
   * The chlorinator does not speak A5, so its frames are pre-built byte strings
   * (see `buildSetOutput`) sent verbatim rather than encoded from a `Packet`.
   */
  sendRaw(data: Buffer): void {
    this.active.write(data);
  }

  // --- frame builders (pure; no connection needed) -----------------------
  /** A command/request from us (`address`) to the main controller, stamped with
   *  the learned protocol sub-version. */
  private command(cfi: number, ...data: number[]): Packet {
    return new Packet(this.controllerSub, C.Address.MAIN, this.address, cfi, Buffer.from(data));
  }

  /** Set-Circuit (CFI 134). */
  buildSetCircuit(circuit: number, on: boolean): Packet {
    return this.command(C.Action.SET_CIRCUIT, circuit, on ? 1 : 0);
  }

  /** Get-Heat (CFI 200) request. */
  buildGetHeat(): Packet {
    return this.command(C.Action.GET_HEAT, 0);
  }

  /** Set-Heat (CFI 136): `[poolSP, spaSP, heatMode, 0]`. */
  buildSetHeat(poolSp: number, spaSp: number, heatMode: number): Packet {
    return this.command(C.Action.SET_HEAT, poolSp & 0xff, spaSp & 0xff, heatMode & 0xff, 0);
  }

  /**
   * Get-Schedule (CFI 209) request for one slot.
   * Note: this controller does **not** treat `scheduleId = 0` as "all" — slot 0
   * always answers empty. Real schedules occupy slots 1..12 and must be requested
   * individually.
   */
  buildGetSchedules(scheduleId = 1): Packet {
    return this.command(C.Action.GET_SCHEDULE, scheduleId);
  }

  /** Set-Schedule (CFI 145) from HH:MM strings + a day mask. */
  buildSetSchedule(
    scheduleId: number,
    circuit: number,
    start: string,
    end: string,
    daysMask: number
  ): Packet {
    const [sh, sm] = parseHhmm(start);
    const [eh, em] = parseHhmm(end);
    return this.command(C.Action.SET_SCHEDULE, scheduleId, circuit, sh, sm, eh, em, daysMask & 0xff);
  }

  /**
   * Set-Date/Time (CFI 133). The payload mirrors the CFI 5 broadcast field order:
   * `[hour, minute, dow, day, month, year, autoDst]`. `dow` is the Pentair weekday
   * *bit* (Sun=0x01 … Sat=0x40); `year` is two digits (year - 2000).
   */
  buildSetDatetime(
    hour: number, minute: number, dow: number, day: number,
    month: number, year: number, autoDst = 1
  ): Packet {
    return this.command(
      C.Action.SET_DATETIME, hour & 0xff, minute & 0xff, dow & 0xff,
      day & 0xff, month & 0xff, year & 0xff, autoDst ? 1 : 0
    );
  }

  /** Get-Version (CFI 253) request. */
  buildGetVersion(): Packet {
    return this.command(C.Action.GET_VERSION, 0);
  }

  /**
   * Set-Color / IntelliBrite (CFI 96) command (one command byte).
   * The command is global to the configured light group.
   */
  buildSetLight(command: number): Packet {
    return this.command(C.Action.SET_COLOR, command & 0xff);
  }

  /** A frame addressed to a pump (`0x60 + (pump-1)`), pump 1-based. */
  private pumpCommand(pump: number, cfi: number, ...data: number[]): Packet {
    return new Packet(
      this.controllerSub, C.Address.PUMP1 + (pump - 1), this.address, cfi, Buffer.from(data)
    );
  }

  /** Pump Remote-Control frame (pump action 4): take/release control. */
  buildPumpRemoteControl(pump: number, enable = true): Packet {
    return this.pumpCommand(pump, 4, enable ? 0xff : 0x00);
  }

  /**
   * Pump Set-Speed frame (pump action 1) writing the RPM register.
   * Writes IntelliFlo register 0x02C4 with a big-endian RPM. The register and
   * sequence are the documented reference and are **not** verified here.
   */
  buildSetPumpSpeed(pump: number, rpm: number): Packet {
    return this.pumpCommand(pump, 1, 0x02, 0xc4, (rpm >> 8) & 0xff, rpm & 0xff);
  }
}
