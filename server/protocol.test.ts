// Frame encode/decode and streaming-reader tests, ported from tests/test_protocol.py.
// The hex blobs here are real frames captured from the live bus, so these tests
// double as a regression guard against protocol drift.
import { describe, expect, test } from "bun:test";

import { ChecksumError, Packet, checksum, parseFrame } from "./protocol.js";
import { PacketReader } from "./reader.js";
// The shared frame includes the 00 FF preamble and trailing 2-byte checksum (03d0).
import { STATUS_FRAME as REAL_STATUS } from "./testing.js";


describe("protocol", () => {
  test("checksum matches the trailing bytes of a real frame", () => {
    const body = REAL_STATUS.subarray(2, -2); // 0xA5 .. last data byte
    const n = REAL_STATUS.length;
    const trailing = (REAL_STATUS[n - 2]! << 8) | REAL_STATUS[n - 1]!;
    expect(checksum(body)).toBe(trailing);
    expect(trailing).toBe(0x03d0);
  });

  test("decodes the real frame header", () => {
    const pkt = parseFrame(REAL_STATUS);
    expect(pkt.sub).toBe(0x27);
    expect(pkt.dst).toBe(0x0f); // broadcast
    expect(pkt.src).toBe(0x10); // main controller
    expect(pkt.cfi).toBe(2); // controller status
    expect(pkt.length).toBe(0x1d);
    expect(pkt.data.length).toBe(0x1d);
  });

  test("round-trips back to the captured bytes", () => {
    // Re-encode with the same 00FF start and 0 leading idles; body+checksum must match.
    expect(parseFrame(REAL_STATUS).toBytes(0)).toEqual(REAL_STATUS);
  });

  test("rejects a bad checksum", () => {
    const corrupt = Buffer.from(REAL_STATUS);
    corrupt[corrupt.length - 1] ^= 0xff;
    expect(() => parseFrame(corrupt)).toThrow(ChecksumError);
  });

  test("set-circuit frame checksum is valid", () => {
    const pkt = new Packet(0x01, 0x10, 0x20, 134, Buffer.from([6, 1]));
    // Round-trips cleanly through the decoder => checksum is correct.
    const again = parseFrame(pkt.toBytes(2));
    expect(again.cfi).toBe(134);
    expect(again.data).toEqual(Buffer.from([6, 1]));
  });
});

describe("PacketReader", () => {
  test("extracts a packet split across chunks", () => {
    const reader = new PacketReader();
    const split = 10; // mid-payload, to exercise buffering/resync
    expect(reader.feed(REAL_STATUS.subarray(0, split))).toEqual([]);
    const pkts = reader.feed(REAL_STATUS.subarray(split));
    expect(pkts.length).toBe(1);
    expect(pkts[0]!.cfi).toBe(2);
    expect(pkts[0]!.src).toBe(0x10);
  });

  test("skips leading garbage and reads back-to-back frames", () => {
    const reader = new PacketReader();
    const stream = Buffer.concat([
      Buffer.from([0x12, 0x34, 0xff, 0xff]),
      REAL_STATUS,
      REAL_STATUS,
    ]);
    const pkts = reader.feed(stream);
    expect(pkts.length).toBe(2);
    expect(pkts.every((p) => p.cfi === 2)).toBe(true);
  });

  test("resyncs after a corrupt frame", () => {
    const reader = new PacketReader();
    const bad = Buffer.from(REAL_STATUS);
    bad[bad.length - 1] ^= 0xff; // break the checksum of the first frame
    // The corrupt frame is dropped; the following good frame is still found.
    const pkts = reader.feed(Buffer.concat([bad, REAL_STATUS]));
    expect(pkts.length).toBe(1);
    expect(pkts[0]!.cfi).toBe(2);
  });

  test("emits one packet per feed byte-at-a-time", () => {
    const reader = new PacketReader();
    const out = [...REAL_STATUS].flatMap((byte) => reader.feed(Buffer.from([byte])));
    expect(out.length).toBe(1);
    expect(out[0]!.cfi).toBe(2);
  });
});
