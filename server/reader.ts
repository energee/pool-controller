// Streaming frame extractor with resynchronization. Ported from easytouch/reader.py.
//
// The RS-485 bus is byte-oriented with no framing layer, so a reader must scan a
// continuous byte stream for the 0x00 0xFF 0xA5 start marker, validate the length
// and checksum, and resynchronize on garbage. `PacketReader` keeps an internal
// buffer and returns complete `Packet` objects as bytes arrive.

import { A5, HEADER_LEN, Packet, checksum } from "./protocol.js";

// 3-byte start marker: the 0x00 0xFF preamble end followed by the 0xA5 body byte.
const MARKER = Buffer.from([0x00, 0xff, A5]);

/**
 * Accumulates bytes and emits validated packets.
 *
 *     const reader = new PacketReader();
 *     for (const pkt of reader.feed(chunk)) console.log(String(pkt));
 */
export class PacketReader {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBuffer = 4096) {}

  /** Add bytes and return any complete packets now available. */
  feed(chunk: Uint8Array): Packet[] {
    if (chunk.length) this.buf = Buffer.concat([this.buf, chunk]);
    const out: Packet[] = [];
    for (;;) {
      const marker = this.buf.indexOf(MARKER);
      if (marker < 0) {
        // Keep only a possible partial marker (last 2 bytes) to bound memory.
        if (this.buf.length > this.maxBuffer) this.buf = this.buf.subarray(-2);
        return out;
      }
      const a5 = marker + 2; // index of the 0xA5 body start
      // Need at least the header to read the declared length.
      if (this.buf.length < a5 + HEADER_LEN) {
        this.buf = this.buf.subarray(marker); // drop leading noise, wait for more bytes
        return out;
      }
      const length = this.buf[a5 + 5]!;
      const end = a5 + HEADER_LEN + length; // one past last data byte
      if (this.buf.length < end + 2) {
        // data + 2 checksum bytes
        this.buf = this.buf.subarray(marker);
        return out;
      }
      const body = this.buf.subarray(a5, end);
      const got = (this.buf[end]! << 8) | this.buf[end + 1]!;
      if (got === checksum(body)) {
        out.push(
          new Packet(
            body[1]!,
            body[2]!,
            body[3]!,
            body[4]!,
            Buffer.from(body.subarray(HEADER_LEN))
          )
        );
        this.buf = this.buf.subarray(end + 2);
      } else {
        // Bad checksum: skip this marker and resync on the next one.
        this.buf = this.buf.subarray(a5);
      }
    }
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
