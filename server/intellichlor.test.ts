// IntelliChlor (salt chlorinator) framer/decoder tests, ported from
// tests/test_intellichlor.py.
//
// Salt level does **not** ride the A5 protocol: the chlorinator uses its own
// DLE-framed messages — `10 02 <dest> <cmd> <data...> <chk> 10 03` — which the A5
// PacketReader drops as garbage. The frames below were captured live from the
// controller at socket://192.168.4.70:4000; the checksum rule (sum of 0x10 through
// the last data byte, mod 256) was confirmed against the real Set-Output frame.
import { describe, expect, test } from "bun:test";

import { ChlorinatorReader, buildSetOutput, decodeIc, icChecksum } from "./intellichlor.js";
import { Packet } from "./protocol.js";

// Real, checksum-valid Set-Output frame captured from the bus: chlorinator (0x50),
// cmd 0x11, output 0x1e = 30%, checksum 0x91.
const SET_OUTPUT = Buffer.from("100250111e911003", "hex");
// Salt status: real device bytes (salt 0x37 = 55 -> 2750 ppm, status 0x80) captured
// from the bus; checksum 0xdb is computed by the rule the Set-Output frame confirms.
const SALT_STATUS = Buffer.from("100200123780db1003", "hex");

describe("checksum", () => {
  test("matches the byte the controller put on the wire", () => {
    // 10 02 50 11 1e  ->  0x91
    expect(icChecksum(Buffer.from("100250111e", "hex"))).toBe(0x91);
  });
});

describe("ChlorinatorReader", () => {
  test("decodes salt status", () => {
    const frames = new ChlorinatorReader().feed(SALT_STATUS);
    expect(frames.length).toBe(1);
    const obj = decodeIc(frames[0]!);
    expect(obj?.kind).toBe("status");
    expect(obj?.value).toEqual({ salt_ppm: 2750, status_flags: 0x80 });
  });

  test("decodes set-output", () => {
    const obj = decodeIc(new ChlorinatorReader().feed(SET_OUTPUT)[0]!);
    expect(obj?.kind).toBe("set_output");
    expect(obj?.value).toEqual({ output_percent: 30 });
  });

  test("resyncs past garbage and idle bytes", () => {
    const frames = new ChlorinatorReader().feed(
      Buffer.concat([Buffer.from([0xff, 0xff, 0xff]), SALT_STATUS, Buffer.from([0xff, 0xff])])
    );
    expect(frames.map((f) => decodeIc(f)!.value)).toEqual([{ salt_ppm: 2750, status_flags: 0x80 }]);
  });

  test("rejects a bad checksum", () => {
    const bad = Buffer.from(SALT_STATUS);
    bad[bad.length - 3] ^= 0xff; // corrupt the checksum byte
    expect(new ChlorinatorReader().feed(bad)).toEqual([]);
  });

  test("ignores non-IC addresses and commands", () => {
    // A5 traffic embeds the bytes 10 02 (src 0x10 MAIN + cfi 0x02), and such a run
    // can even carry a checksum that validates. Without an address/command check the
    // framer would emit a bogus ICFrame; dest 0x1d is not a real IC address, so it
    // must be rejected outright (sum 0x10+0x02+0x1d+0x11 = 0x40 = the chk byte).
    expect(new ChlorinatorReader().feed(Buffer.from("10021d11401003", "hex"))).toEqual([]);
  });

  test("skips an A5 look-alike but keeps the following salt frame", () => {
    const a5 = new Packet(
      0x27, 0x0f, 0x10, 0x02,
      Buffer.from("14370000000000000000008fa0030d03d6", "hex")
    ).toBytes(2);
    expect(a5.includes(Buffer.from([0x10, 0x02]))).toBe(true); // contains the IC start bytes
    const frames = new ChlorinatorReader().feed(Buffer.concat([a5, SALT_STATUS]));
    expect(frames.every((f) => [0x00, 0x50].includes(f.dest) && [0x11, 0x12].includes(f.cmd)))
      .toBe(true);
    expect(frames.map((f) => (decodeIc(f)!.value as { salt_ppm: number }).salt_ppm)).toEqual([2750]);
  });

  test("reassembles a split frame", () => {
    const r = new ChlorinatorReader();
    expect(r.feed(SALT_STATUS.subarray(0, 4))).toEqual([]); // no complete frame yet
    const frames = r.feed(SALT_STATUS.subarray(4)); // remainder arrives
    expect(frames.length).toBe(1);
    expect((decodeIc(frames[0]!)!.value as { salt_ppm: number }).salt_ppm).toBe(2750);
  });
});

describe("buildSetOutput", () => {
  test("matches the real captured frame byte-for-byte", () => {
    expect(buildSetOutput(30)).toEqual(SET_OUTPUT);
  });

  test("clamps and round-trips", () => {
    const pct = (n: number) =>
      (decodeIc(new ChlorinatorReader().feed(buildSetOutput(n))[0]!)!.value as {
        output_percent: number;
      }).output_percent;
    expect(pct(45)).toBe(45);
    expect(pct(150)).toBe(100);
    expect(pct(-5)).toBe(0);
  });
});
