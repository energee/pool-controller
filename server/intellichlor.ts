// The IntelliChlor salt-chlorinator's *native* protocol. Ported from
// easytouch/intellichlor.py.
//
// The chlorinator does **not** speak the A5 protocol the rest of this package
// decodes. It uses its own DLE-framed messages on the same RS-485 wire:
//
//     10 02 <dest> <cmd> <data...> <chk> 10 03
//     │  │   │      │     │         │     │
//     │  │   │      │     │         │     └ DLE/ETX terminator
//     │  │   │      │     │         └ checksum: sum(0x10 .. last data byte) & 0xFF
//     │  │   │      │     └ command payload
//     │  │   │      └ command (0x11 set-output, 0x12 status)
//     │  │   └ destination (0x00 controller, 0x50 chlorinator)
//     │  └ DLE/STX
//     └ DLE
//
// Because the A5 `PacketReader` only frames `00 ff a5` packets, it silently
// discards every chlorinator frame — which is why salt level never appears in A5
// decode or under `/raw`. `ChlorinatorReader` is a second, independent framer over
// the same byte stream.
//
// Checksum and field offsets were confirmed against live captures from the
// controller at socket://192.168.4.70:4000 (see intellichlor.test.ts): a real
// Set-Output frame `10 02 50 11 1e 91 10 03` validates the checksum rule, and a
// Salt-Status frame `10 02 00 12 37 80 …` decodes to 2750 ppm.
//
// Note: frame boundaries are found by the `10 02` / `10 03` markers and validated
// first by the address/command (dest must be a real IC address and cmd a known
// command — this rejects A5 `10 02 1d …` look-alikes outright) and then by
// checksum. We do not un-stuff doubled 0x10 data bytes; a rare 0x10 payload byte
// would simply fail the checksum and be resynced past — state is never corrupted,
// only that one frame is skipped.

export const DLE = 0x10;
export const STX = 0x02;
export const ETX = 0x03;
export const IC_START = Buffer.from([DLE, STX]); // 10 02
export const IC_END = Buffer.from([DLE, ETX]); // 10 03

export const SALT_UNIT_PPM = 50; // the salt byte is reported in units of 50 ppm

export const ICAddress = {
  CONTROLLER: 0x00, // messages addressed to the main controller
  CHLORINATOR: 0x50, // messages addressed to the chlorinator
} as const;

export const ICCommand = {
  SET_OUTPUT: 0x11, // controller -> chlorinator: set generation %
  STATUS: 0x12, // chlorinator -> controller: salt level + status
} as const;

// Valid IntelliChlor frame headers. Used to reject A5 "10 02 …" byte look-alikes
// (A5 frames embed 0x10 0x02 as src 0x10 = MAIN + cfi 0x02 = status) at the start
// marker, before a false latch can consume bytes from a following real IC frame.
const IC_DESTS = new Set<number>([ICAddress.CONTROLLER, ICAddress.CHLORINATOR]); // 0x00, 0x50
const IC_COMMANDS = new Set<number>([ICCommand.SET_OUTPUT, ICCommand.STATUS]); // 0x11, 0x12

/** IntelliChlor checksum: sum of 0x10 through the last data byte, mod 256. */
export function icChecksum(headerAndData: Uint8Array): number {
  let sum = 0;
  for (const byte of headerAndData) sum += byte;
  return sum & 0xff;
}

/** A validated raw IntelliChlor frame (one `10 02 … 10 03` message). */
export interface ICFrame {
  dest: number;
  cmd: number;
  data: Buffer;
}

/**
 * Decoded `ICCommand.STATUS` (cmd 0x12): salt reading + raw status byte.
 *
 * `status_flags` is kept raw — the IntelliChlor status-bit meanings are not
 * reliably reverse-engineered for every cell model, so we expose the byte rather
 * than assert fault semantics we cannot verify.
 */
export interface ChlorinatorStatus {
  salt_ppm: number;
  status_flags: number;
}

/** Decoded `ICCommand.SET_OUTPUT` (cmd 0x11): requested generation percent. */
export interface ChlorinatorSetOutput {
  output_percent: number;
}

export type ICDecoded =
  | { kind: "status"; value: ChlorinatorStatus }
  | { kind: "set_output"; value: ChlorinatorSetOutput };

/**
 * Streaming framer for the IntelliChlor protocol, with resync + checksum.
 * Mirrors `PacketReader`: feed arbitrary byte chunks and get back the complete,
 * checksum-valid frames now available.
 */
export class ChlorinatorReader {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBuffer = 512) {}

  /** Add bytes and return any complete, validated frames now available. */
  feed(chunk: Uint8Array): ICFrame[] {
    if (chunk.length) this.buf = Buffer.concat([this.buf, chunk]);
    const out: ICFrame[] = [];
    for (;;) {
      const start = this.buf.indexOf(IC_START);
      if (start < 0) {
        // No start marker; keep only a trailing 0x10 that might begin one.
        if (this.buf.length > this.maxBuffer) this.buf = this.buf.subarray(-1);
        break;
      }
      if (start > 0) this.buf = this.buf.subarray(start); // drop noise; buf starts 10 02
      if (this.buf.length < 4) break; // need dest+cmd to validate; await bytes
      if (!IC_DESTS.has(this.buf[2]!) || !IC_COMMANDS.has(this.buf[3]!)) {
        this.buf = this.buf.subarray(2); // A5 "10 02 …" look-alike — not IC; resync
        continue;
      }
      const end = this.buf.indexOf(IC_END, 2); // terminator after the start marker
      if (end < 0) {
        if (this.buf.length > this.maxBuffer) {
          this.buf = this.buf.subarray(2); // runaway: drop this start, resync
          continue;
        }
        break; // incomplete; wait for more bytes
      }
      const inner = this.buf.subarray(2, end); // dest, cmd, data..., chk
      if (inner.length >= 3) {
        const chk = inner[inner.length - 1]!;
        const body = this.buf.subarray(0, end - 1); // 0x10 .. last data byte (excl. chk)
        if (icChecksum(body) === chk) {
          out.push({
            dest: inner[0]!,
            cmd: inner[1]!,
            data: Buffer.from(inner.subarray(2, inner.length - 1)),
          });
          this.buf = this.buf.subarray(end + 2);
          continue;
        }
      }
      this.buf = this.buf.subarray(2); // bad/short frame: drop start, resync
    }
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}

/**
 * Build an IntelliChlor Set-Output frame: `10 02 <dest> 11 <pct> <chk> 10 03`.
 *
 * `percent` is the chlorine-generation level 0–100 (clamped). Returns the raw
 * on-wire bytes: the chlorinator speaks its native protocol, not A5, so this is
 * written to the bus verbatim rather than wrapped in a `Packet`. Byte-for-byte
 * matches the real captured frame `10 02 50 11 1e 91 10 03` (30%).
 *
 * Note: on a system with a *present* EasyTouch controller the controller also
 * drives the cell and may overwrite a directly-injected output on its next cycle,
 * so treat this as best-effort (see HANDOFF for the override caveat).
 */
export function buildSetOutput(percent: number, dest: number = ICAddress.CHLORINATOR): Buffer {
  const pct = Math.max(0, Math.min(100, Math.trunc(percent)));
  const body = Buffer.from([DLE, STX, dest, ICCommand.SET_OUTPUT, pct]);
  return Buffer.concat([body, Buffer.from([icChecksum(body)]), IC_END]);
}

/** Decode a validated `ICFrame` into a tagged value, or `null`. */
export function decodeIc(frame: ICFrame): ICDecoded | null {
  if (frame.cmd === ICCommand.STATUS && frame.data.length >= 2) {
    return {
      kind: "status",
      value: { salt_ppm: frame.data[0]! * SALT_UNIT_PPM, status_flags: frame.data[1]! },
    };
  }
  if (frame.cmd === ICCommand.SET_OUTPUT && frame.data.length >= 1) {
    return { kind: "set_output", value: { output_percent: frame.data[0]! } };
  }
  return null;
}
