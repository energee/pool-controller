// Shared test doubles/fixtures for the server suite (the TS counterpart of
// tests/stub_serial.py). Not part of the runtime — only *.test.ts imports it.

import type { Link } from "./bus.js";

/** In-memory stand-in for a bus connection: scripted reads, captured writes. */
export class StubLink implements Link {
  writes: Buffer[] = [];
  private reads: Buffer[];

  constructor(...chunks: Buffer[]) {
    this.reads = chunks;
  }

  take(): Buffer {
    return this.reads.shift() ?? Buffer.alloc(0);
  }
  write(data: Buffer): void {
    this.writes.push(Buffer.from(data));
  }
  close(): void {}
  failure(): null {
    return null;
  }
}

/** A real controller-status frame (CFI 2) captured from the bus, sub 0x27. */
export const STATUS_FRAME = Buffer.from(
  "00ffa5270f10021d0b0120000000000000200c000004535320005200000005000097a6030d03d0",
  "hex"
);
