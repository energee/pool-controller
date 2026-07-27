// HTTP routing/validation tests. PoolApi is exercised directly (no socket), the
// same way tests/test_web.py drove the Python handler through a stub monitor.
import { describe, expect, test } from "bun:test";

import { PoolApi } from "./api.js";
import { BusMonitor } from "./monitor.js";
import { STATUS_FRAME, StubLink } from "./testing.js";

/** An API over a monitor primed with one real status frame. Short confirm window
 *  so the "not confirmed" paths don't stall the suite. */
function api(): PoolApi {
  const mon = new BusMonitor("stub://");
  mon.bus.attach(new StubLink(STATUS_FRAME));
  mon.schedReqGap = 0;
  mon.pollOnce();
  return new PoolApi(mon, 150);
}

const body = (r: Awaited<ReturnType<PoolApi["routeGet"]>>) =>
  "json" in r ? (r.json as Record<string, any>) : null;

describe("GET", () => {
  test("/api lists the endpoints", async () => {
    const r = await api().routeGet(["api"]);
    expect(r.code).toBe(200);
    expect(body(r)!.endpoints["GET /state"]).toBeDefined();
  });

  test("/state carries the decoded snapshot", async () => {
    const r = await api().routeGet(["state"]);
    expect(body(r)!.status.circuits_on).toEqual([6]);
  });

  test("subset routes return just their slice", async () => {
    expect(body(await api().routeGet(["status"]))!.pool_temp).toBe(83);
    expect(body(await api().routeGet(["chlorinator"]))).toBeNull(); // no IC traffic seen
  });

  test("unknown paths 404", async () => {
    const r = await api().routeGet(["nope"]);
    expect(r.code).toBe(404);
    expect(body(r)!.error).toContain("no such path");
  });

  test("static traversal is refused", async () => {
    expect((await api().routeGet(["static", "../../etc/passwd"])).code).toBe(404);
  });

  test("circuit convenience route confirms against the cache", async () => {
    const a = api();
    // The stub never echoes the write back, so this exercises the 202 path.
    const r = await a.routeGet(["circuit", "spa", "on"]);
    expect(r.code).toBe(202);
    expect(body(r)).toMatchObject({ accepted: true, circuit: 1, on: true });
  });

  test("an unknown circuit name is a 400, not a 500", async () => {
    await expect(api().routeGet(["circuit", "jacuzzi", "on"])).rejects.toThrow(/unknown circuit/);
  });

  test("a non-integer setpoint is rejected", async () => {
    await expect(api().routeGet(["heat", "pool", "warm"])).rejects.toThrow(/must be an integer/);
  });

  test("chlorinator output reports what was sent (nothing to confirm)", async () => {
    const r = await api().routeGet(["chlorinator", "output", "60"]);
    expect(body(r)).toEqual({ sent: true, output_percent: 60 });
  });

  test("light resolves a theme name to its code", async () => {
    expect(body(await api().routeGet(["light", "party"]))).toMatchObject({ code: 177 });
  });

  test("an unknown light name is rejected", async () => {
    await expect(api().routeGet(["light", "disco"])).rejects.toThrow(/unknown light command/);
  });
});

describe("POST", () => {
  test("/circuit requires the field", async () => {
    await expect(api().routePost(["circuit"], {})).rejects.toThrow(/must include 'circuit'/);
  });

  test("/heat requires at least one field", async () => {
    await expect(api().routePost(["heat"], {})).rejects.toThrow(/at least one heat field/);
  });

  test("/heat before any heat frame is a 503, not a crash", async () => {
    await expect(api().routePost(["heat"], { pool_setpoint: 88 })).rejects.toThrow(
      /no heat status cached/
    );
  });

  test("/schedule names the missing field", async () => {
    await expect(api().routePost(["schedule"], { id: 1 })).rejects.toThrow(
      /must include 'circuit'/
    );
  });

  test("/schedule rejects a bad time", async () => {
    await expect(
      api().routePost(["schedule"], { id: 1, circuit: "pool", start: "8am", end: "17:00" })
    ).rejects.toThrow(/expected HH:MM/);
  });

  test("/pump requires both fields", async () => {
    await expect(api().routePost(["pump"], { pump: 1 })).rejects.toThrow(/'pump' and 'rpm'/);
  });

  test("/pump is flagged experimental in its reply", async () => {
    const r = await api().routePost(["pump"], { pump: 1, rpm: 2400 });
    expect(body(r)).toMatchObject({ sent: true, experimental: true, rpm: 2400 });
  });

  test("/datetime rejects an unparseable iso string", async () => {
    await expect(api().routePost(["datetime"], { iso: "yesterday" })).rejects.toThrow(/invalid iso/);
  });

  test("unknown POST paths 404", async () => {
    expect((await api().routePost(["nope"], {})).code).toBe(404);
  });
});
