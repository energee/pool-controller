// BusMonitor tests, ported from tests/test_state.py. The monitor is driven
// synchronously through `pollOnce()` against a scripted Link — the same seam
// StubSerial gave the Python suite — so no timers or real bus are involved.
import { describe, expect, test } from "bun:test";

import type { Link } from "./bus.js";
import { BusMonitor } from "./monitor.js";
import { Packet } from "./protocol.js";

/** In-memory stand-in for a bus connection: scripted reads, captured writes. */
class StubLink implements Link {
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

// Real controller-status frame (CFI 2) captured from the bus, sub 0x27.
const STATUS_FRAME = Buffer.from(
  "00ffa5270f10021d0b0120000000000000200c000004535320005200000005000097a6030d03d0",
  "hex"
);
const HEAT_FRAME = new Packet(
  0x27, 0x0f, 0x10, 8,
  Buffer.from([83, 83, 82, 85, 102, 5, 0, 0, 0, 100])
).toBytes(0);
const SCHEDULE_FRAME = new Packet(
  0x27, 0x0f, 0x10, 17, Buffer.from([1, 6, 8, 0, 17, 0, 0x7f])
).toBytes(0);
const SALT_FRAME = Buffer.from("100200123780db1003", "hex");

/** A monitor wired to a scripted link, with schedule pacing disabled. */
function monitorWith(...chunks: Buffer[]): { mon: BusMonitor; link: StubLink } {
  const mon = new BusMonitor("stub://");
  const link = new StubLink(...chunks);
  mon.bus.attach(link);
  mon.schedReqGap = 0;
  return { mon, link };
}

/** All A5 command frames the monitor has written, decoded to [cfi, ...data]. */
function sentCommands(link: StubLink): number[][] {
  return link.writes
    .filter((w) => w.includes(Buffer.from([0x00, 0xff, 0xa5])))
    .map((w) => {
      const a5 = w.indexOf(0xa5);
      return [w[a5 + 4]!, ...w.subarray(a5 + 6, a5 + 6 + w[a5 + 5]!)];
    });
}

describe("ingest", () => {
  test("caches controller status", () => {
    const { mon } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    const st = mon.getState();
    expect(st.status?.circuits_on).toEqual([6]);
    expect(st.status?.pool_temp).toBe(83);
    expect(st.connected).toBe(true);
    expect(st.age).not.toBeNull();
  });

  test("caches heat and schedule", () => {
    const { mon } = monitorWith(Buffer.concat([HEAT_FRAME, SCHEDULE_FRAME]));
    mon.pollOnce();
    const st = mon.getState();
    expect(st.heat?.pool_setpoint).toBe(85);
    expect(st.schedules[1]?.circuit_name).toBe("pool");
    expect(st.schedules[1]?.start).toBe("08:00");
  });

  test("caches chlorinator salt from the non-A5 framer", () => {
    const { mon } = monitorWith(SALT_FRAME);
    mon.pollOnce();
    expect(mon.getState().chlorinator?.salt_ppm).toBe(2750);
  });

  test("stamps chlorinator staleness for the UI", () => {
    const { mon } = monitorWith(SALT_FRAME);
    mon.pollOnce();
    const chlor = mon.getState().chlorinator!;
    expect(chlor.last_seen_ts).toBeNumber();
    expect(chlor.age as number).toBeLessThan(1);
  });

  test("omits chlorinator entirely when only A5 traffic is seen", () => {
    const { mon } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    expect(mon.getState().chlorinator).toBeNull();
  });

  test("keeps every frame's raw hex, decoded or not", () => {
    const { mon } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    expect(mon.getState().raw[2]).toContain("a5270f1002");
  });

  test("state is JSON-serializable", () => {
    const { mon } = monitorWith(Buffer.concat([STATUS_FRAME, HEAT_FRAME, SALT_FRAME]));
    mon.pollOnce();
    expect(() => JSON.stringify(mon.getState())).not.toThrow();
  });
});

describe("commands", () => {
  test("set-circuit is enqueued and sent on the next poll", () => {
    const { mon, link } = monitorWith(STATUS_FRAME);
    mon.pollOnce(); // learn the controller sub
    mon.setCircuit(6, true);
    expect(link.writes.length).toBeGreaterThan(0); // refresh requests may precede
    const before = link.writes.length;
    mon.setCircuit(1, false);
    expect(link.writes.length).toBe(before); // queued, not sent yet
    mon.pollOnce();
    const cmds = sentCommands(link);
    expect(cmds).toContainEqual([134, 6, 1]);
    expect(cmds).toContainEqual([134, 1, 0]);
  });

  test("outgoing frames carry the learned controller sub", () => {
    const { mon, link } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    mon.setCircuit(6, true);
    mon.pollOnce();
    const frame = link.writes.find((w) => w.includes(Buffer.from([0x86])))!;
    const a5 = frame.indexOf(0xa5);
    expect(frame[a5 + 1]).toBe(0x27); // sub learned from the controller, not 0x01
  });

  test("set-heat read-modify-writes from the cached heat status", () => {
    const { mon, link } = monitorWith(Buffer.concat([STATUS_FRAME, HEAT_FRAME]));
    mon.pollOnce();
    const res = mon.setHeat(88, null, null, null);
    expect(res).toEqual({ pool_setpoint: 88, spa_setpoint: 102, heat_mode: 5 });
    mon.pollOnce();
    expect(sentCommands(link)).toContainEqual([136, 88, 102, 5, 0]);
  });

  test("set-heat also re-requests heat across the confirm window", () => {
    const { mon, link } = monitorWith(Buffer.concat([STATUS_FRAME, HEAT_FRAME]));
    mon.pollOnce();
    mon.setHeat(88);
    for (let i = 0; i < 3; i++) mon.pollOnce();
    // CFI 200 (Get-Heat) re-requested on each poll, not just once.
    expect(sentCommands(link).filter(([cfi]) => cfi === 200).length).toBeGreaterThan(1);
  });

  test("set-heat without cached heat throws", () => {
    const { mon } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    expect(() => mon.setHeat(88)).toThrow(/no heat status cached/);
  });

  test("set-schedule accepts the string days the HTTP API sends", () => {
    const { mon, link } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    mon.setSchedule(2, 1, "18:00", "21:30", "weekends");
    mon.pollOnce();
    expect(sentCommands(link)).toContainEqual([145, 2, 1, 18, 0, 21, 30, 0x41]);
  });

  test("set-chlorinator-output enqueues a raw IC frame and caches the request", () => {
    const { mon, link } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    expect(mon.setChlorinatorOutput(150)).toBe(100); // clamped
    mon.pollOnce();
    // 10 02 50 11 64 <chk> 10 03, chk = 0x10+0x02+0x50+0x11+0x64 = 0xd7
    expect(link.writes.some((w) => w.equals(Buffer.from("1002501164d71003", "hex")))).toBe(true);
    expect(mon.getState().chlorinator?.output_percent).toBe(100);
  });

  test("set-light resolves a name to its command byte", () => {
    const { mon, link } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    expect(mon.setLight("party")).toBe(177);
    mon.pollOnce();
    expect(sentCommands(link)).toContainEqual([96, 177]);
  });

  test("set-pump-speed enqueues remote-control then set-speed", () => {
    const { mon, link } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    expect(mon.setPumpSpeed(1, 2400)).toEqual({ pump: 1, rpm: 2400, experimental: true });
    mon.pollOnce();
    const toPump = link.writes.filter((w) => w[w.indexOf(0xa5) + 2] === 0x60);
    expect(toPump.length).toBe(2);
  });

  test("set-datetime enqueues the clock write", () => {
    const { mon, link } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    const res = mon.setDatetime(new Date(2026, 5, 14, 11, 5)); // Sun 14 Jun 2026
    expect(res).toMatchObject({ hour: 11, minute: 5, day: 14, month: 6, year: 2026, dow: 0x01 });
    mon.pollOnce();
    expect(sentCommands(link)).toContainEqual([133, 11, 5, 0x01, 14, 6, 26, 1]);
  });
});

describe("refresh", () => {
  test("waits until the controller sub is learned", () => {
    // A pump-only frame never teaches us the controller's sub, so no requests go out.
    const pumpFrame = new Packet(0x00, 0x10, 0x60, 7, Buffer.alloc(15)).toBytes(0);
    const { mon, link } = monitorWith(pumpFrame);
    mon.pollOnce();
    expect(link.writes.length).toBe(0);
  });

  test("scans every schedule slot one at a time", () => {
    const { mon, link } = monitorWith(STATUS_FRAME);
    for (let i = 0; i < 20; i++) mon.pollOnce();
    const slots = sentCommands(link)
      .filter(([cfi]) => cfi === 209)
      .map(([, id]) => id);
    expect(slots).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  test("requests version until one is seen", () => {
    const { mon, link } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    expect(sentCommands(link).some(([cfi]) => cfi === 253)).toBe(true);
  });
});

describe("waitFor", () => {
  test("returns the state once the predicate holds", async () => {
    const { mon } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    const st = await mon.waitFor((s) => s.status?.circuits_on?.includes(6) ?? false, 500);
    expect(st).not.toBeNull();
  });

  test("times out to null", async () => {
    const { mon } = monitorWith(STATUS_FRAME);
    mon.pollOnce();
    expect(await mon.waitFor(() => false, 150, 20)).toBeNull();
  });
});
