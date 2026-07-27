// High-level decoder tests against real captured frames, ported from
// tests/test_decode.py and the day-mask half of tests/test_schedule.py.
import { describe, expect, test } from "bun:test";

import {
  decode,
  decodeControllerStatus,
  decodeDatetime,
  decodeDays,
  decodeSchedule,
  encodeDays,
  equipCircuits,
  mergeHeatMode,
} from "./decode.js";
import { Packet, parseFrame } from "./protocol.js";
import { STATUS_FRAME as REAL_STATUS } from "./testing.js";

// Real date/time frame (CFI 5): hour=11 min=05 dow=01 day=14 month=06 year=26.
const REAL_DATETIME = new Packet(
  0x27, 0x0f, 0x10, 5,
  Buffer.from([0x0b, 0x05, 0x01, 0x0e, 0x06, 0x1a, 0x00, 0x01])
);

describe("equipment bitmask", () => {
  test("maps bits to circuit numbers", () => {
    // equip1 = 0x20 -> bit 5 set -> circuit 6 (Pool).
    expect(equipCircuits(0x20, 0x00, 0x00)).toEqual([6]);
    // bit 0 of equip1 -> circuit 1; bit 0 of equip2 -> circuit 9.
    expect(equipCircuits(0x01, 0x01, 0x00)).toEqual([1, 9]);
    expect(equipCircuits(0x00, 0x00, 0x80)).toEqual([24]);
  });
});

describe("controller status", () => {
  test("decodes the captured values", () => {
    const s = decodeControllerStatus(parseFrame(REAL_STATUS));
    expect(s.clock).toBe("11:01");
    expect(s.circuits_on).toEqual([6]);
    expect(s.circuit_names).toEqual(["pool"]);
    expect(s.pool_temp).toBe(83); // 0x53
    expect(s.spa_temp).toBe(83);
    expect(s.air_temp).toBe(82); // 0x52
    expect(s.unit).toBe("F");
    expect(s.heater_on).toBe(true); // byte 22 = 0x20
    expect(s.pool_heat_mode).toBe("Heater"); // heat byte 0x05 -> pool bits 01
    expect(s.spa_heat_mode).toBe("Heater"); // spa bits 01
  });

  test("decodes the extended CFI 2 fields (HANDOFF §13)", () => {
    //   body 16 (payload idx 10) = 0x0c -> valve actuator state.
    //   body 18 (payload idx 12) = 0x00 -> no circuit currently in delay.
    //   body 32 (payload idx 26), bit 0 = 0 -> auto-DST off (manual).
    const s = decodeControllerStatus(parseFrame(REAL_STATUS));
    expect(s.valve).toBe(12);
    expect(s.delay).toBe(0);
    expect(s.auto_dst).toBe(false);
  });
});

describe("date/time", () => {
  test("decodes the captured frame", () => {
    const dt = decodeDatetime(REAL_DATETIME);
    expect(dt.hour).toBe(11);
    expect(dt.minute).toBe(5);
    expect(dt.day).toBe(14);
    expect(dt.month).toBe(6);
    expect(dt.year).toBe(26);
    expect(dt.iso).toBe("2026-06-14 11:05");
  });
});

describe("heat mode packing", () => {
  test("merges pool and spa bits independently", () => {
    expect(mergeHeatMode(0x05, 0, null)).toBe(0x04); // pool -> Off, spa untouched
    expect(mergeHeatMode(0x05, null, 3)).toBe(0x0d); // spa -> Solar Only
    expect(mergeHeatMode(0x00, 1, 1)).toBe(0x05);
    expect(mergeHeatMode(0x05, undefined, undefined)).toBe(0x05);
  });
});

describe("days", () => {
  test("decodes basic masks", () => {
    expect(decodeDays(0x00)).toEqual([]);
    expect(decodeDays(0x02 | 0x08 | 0x20)).toEqual(["Mon", "Wed", "Fri"]);
    expect(decodeDays(0x7f)).toEqual(["Every day"]);
    expect(decodeDays(0xff)).toEqual(["Every day"]);
  });

  test("round-trips and honors shortcuts", () => {
    expect(encodeDays(["mon", "wed", "fri"])).toBe(0x2a);
    expect(decodeDays(encodeDays(["mon", "wed", "fri"]))).toEqual(["Mon", "Wed", "Fri"]);
    expect(encodeDays(["every"])).toBe(0x7f);
  });

  test("accepts the comma/space strings the HTTP API sends", () => {
    // The webapp sends `days` as a raw string, not a list. Previously a string
    // iterated per-character and raised "unknown day: 'm'" -> HTTP 400.
    expect(encodeDays("mon,wed,fri")).toBe(0x2a);
    expect(encodeDays("every")).toBe(0x7f);
    expect(encodeDays("mon wed fri")).toBe(0x2a);
    expect(encodeDays("")).toBe(0);
    expect(encodeDays(["weekdays"])).toBe(0x3e); // Mon..Fri
    expect(encodeDays(["weekends"])).toBe(0x41); // Sun + Sat
    expect(encodeDays(["Sunday", "Saturday"])).toBe(0x41);
  });

  test("rejects garbage", () => {
    expect(() => encodeDays(["funday"])).toThrow();
  });
});

describe("schedule", () => {
  const schedulePkt = (data: number[]) => new Packet(0x27, 0x0f, 0x10, 17, Buffer.from(data));

  test("decodes fields", () => {
    const s = decodeSchedule(schedulePkt([1, 6, 8, 30, 17, 0, 0x7f]));
    expect(s.id).toBe(1);
    expect(s.circuit).toBe(6);
    expect(s.circuit_name).toBe("pool");
    expect(s.start).toBe("08:30");
    expect(s.end).toBe("17:00");
    expect(s.days).toEqual(["Every day"]);
    expect(s.active).toBe(true);
  });

  test("marks an unused slot", () => {
    const s = decodeSchedule(schedulePkt([4, 0, 0, 0, 0, 0, 0]));
    expect(s.active).toBe(false);
    expect(s.circuit_name).toBe("(unused)");
  });

  test("round-trips through the wire format", () => {
    const pkt = schedulePkt([2, 1, 18, 0, 21, 30, 0x41]);
    const s = decodeSchedule(parseFrame(pkt.toBytes()));
    expect(s.start).toBe("18:00");
    expect(s.end).toBe("21:30");
    expect(s.days).toEqual(["Sun", "Sat"]);
  });
});

describe("dispatch", () => {
  test("routes each packet to its decoder", () => {
    expect(decode(parseFrame(REAL_STATUS)).kind).toBe("status");
    expect(decode(REAL_DATETIME).kind).toBe("datetime");
    expect(decode(new Packet(0x27, 0x0f, 0x10, 17, Buffer.from([1, 6, 8, 0, 17, 0, 0x7f]))).kind)
      .toBe("schedule");
    // CFI 7 only decodes as a pump when the source really is a pump address.
    expect(decode(new Packet(0x00, 0x10, 0x60, 7, Buffer.alloc(15))).kind).toBe("pump");
    expect(decode(new Packet(0x00, 0x10, 0x0f, 7, Buffer.alloc(15))).kind).toBe("unknown");
    // An unmapped CFI falls through to Unknown rather than being dropped.
    expect(decode(new Packet(0x27, 0x0f, 0x10, 99, Buffer.from([1]))).kind).toBe("unknown");
  });
});
