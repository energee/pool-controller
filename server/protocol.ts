// Pentair "A5" frame encode/decode. Ported from easytouch/protocol.py.
//
// Wire format of an A5 packet (the dominant Pentair RS-485 protocol):
//
//     [idle 0xFF ...] 0x00 0xFF | 0xA5 sub dst src cfi len <data...> ckh ckl
//
// * The frame is preceded by one or more idle 0xFF bytes and a 0x00 0xFF start
//   sequence.
// * The packet body starts at 0xA5 and is: sub-version, destination address,
//   source address, command/function (CFI), data length, then `len` data bytes.
// * The checksum is the 16-bit unsigned sum of every body byte (0xA5 through the
//   last data byte), transmitted big-endian (high byte first).
//
// This module is transport-agnostic: it only turns bytes into `Packet` objects
// and back. See reader.ts for streaming/resync and bus.ts for the I/O client.

import { actionName, addressName, isPump } from "./constants.js";

// Frame markers.
export const IDLE = 0xff; // idle/preamble byte
export const START = Buffer.from([0x00, 0xff]); // start-of-frame sequence preceding 0xA5
export const A5 = 0xa5; // leading packet byte (body start)

/** Offset of the first data byte within the full body (A5 sub dst src cfi len). */
export const HEADER_LEN = 6;
/** Minimum on-wire body: header (6) + checksum (2); data length may be 0. */
export const MIN_BODY = HEADER_LEN + 2;

/** 16-bit checksum: unsigned sum of all body bytes (0xA5 .. last data). */
export function checksum(body: Uint8Array): number {
  let sum = 0;
  for (const byte of body) sum += byte;
  return sum & 0xffff;
}

/** Thrown when a frame's trailing checksum does not match its body. */
export class ChecksumError extends Error {}

/**
 * A decoded Pentair A5 packet.
 *
 * Fields mirror the on-wire header. `data` holds only the payload bytes
 * (excluding the 6-byte header and 2-byte checksum). Field offsets quoted
 * elsewhere in this project are relative to the full body (0xA5 at index 0);
 * `body()` returns that full body for spec-offset indexing.
 */
export class Packet {
  constructor(
    readonly sub: number,
    readonly dst: number,
    readonly src: number,
    readonly cfi: number,
    readonly data: Buffer = Buffer.alloc(0)
  ) {}

  get length(): number {
    return this.data.length;
  }

  /** True if either endpoint is a pump (CFI semantics differ for pumps). */
  get isPump(): boolean {
    return isPump(this.src) || isPump(this.dst);
  }

  /** The checksummed body: header + data (no preamble, no checksum). */
  body(): Buffer {
    return Buffer.concat([
      Buffer.from([A5, this.sub, this.dst, this.src, this.cfi, this.length]),
      this.data,
    ]);
  }

  /** Serialize to the full on-wire frame, prefixed by `idle` 0xFF bytes. */
  toBytes(idle = 2): Buffer {
    const body = this.body();
    const ck = checksum(body);
    return Buffer.concat([
      Buffer.alloc(idle, IDLE),
      START,
      body,
      Buffer.from([ck >> 8, ck & 0xff]),
    ]);
  }

  toString(): string {
    return (
      `${addressName(this.src)}->${addressName(this.dst)} ` +
      `[${actionName(this.cfi, this.isPump)}] ` +
      `len=${this.length} data=${this.data.toString("hex")}`
    );
  }
}

/**
 * Decode a single A5 frame into a `Packet`.
 *
 * `frame` may include leading idle/preamble bytes; everything before the first
 * 0xA5 is ignored. Throws `Error`/`ChecksumError` on malformed input. (Named
 * `parseFrame` to distinguish it from decode.ts's `decode()`, which turns a
 * `Packet` into state.)
 */
export function parseFrame(frame: Buffer): Packet {
  const a5 = frame.indexOf(A5);
  if (a5 < 0) throw new Error("no 0xA5 start byte in frame");
  const rest = frame.subarray(a5);
  if (rest.length < MIN_BODY) throw new Error("frame too short for an A5 packet");
  const [, sub, dst, src, cfi, length] = rest as unknown as number[];
  const end = HEADER_LEN + length!;
  if (rest.length < end + 2) throw new Error("frame shorter than declared data length + checksum");
  const body = rest.subarray(0, end);
  const got = (rest[end]! << 8) | rest[end + 1]!;
  const want = checksum(body);
  if (got !== want) throw new ChecksumError(`checksum mismatch: frame=${got} computed=${want}`);
  return new Packet(sub!, dst!, src!, cfi!, Buffer.from(rest.subarray(HEADER_LEN, end)));
}
