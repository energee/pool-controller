// Tests for deriveSceneState: the pure State -> SceneState mapping that drives
// the 3D pool scene. Covers pump-derived flow, circuit fallback, and staleness.
import { describe, expect, test } from "bun:test";

import { deriveSceneState } from "./scene";
import type { State } from "../types";

const base: State = {
  age: 2,
  status: { circuits_on: [6], pool_temp: 84, spa_temp: 96, heater_on: false },
  pumps: { "1": { pump: 1, watts: 1350, rpm: 2400, gpm: 65 } },
  chlorinator: { salt_ppm: 3200, output_percent: 40 },
};

describe("deriveSceneState", () => {
  test("null state is inert and stale", () => {
    const s = deriveSceneState(null, false);
    expect(s.flow).toBe(0);
    expect(s.poolOn).toBe(false);
    expect(s.stale).toBe(true);
    expect(s.poolTemp).toBeNull();
  });

  test("pool running with pump gpm", () => {
    const s = deriveSceneState(base, true);
    expect(s.poolOn).toBe(true);
    expect(s.spaOn).toBe(false);
    expect(s.flow).toBeCloseTo(0.65);
    expect(s.rpm).toBe(2400);
    expect(s.chlorPct).toBe(40);
    expect(s.saltPpm).toBe(3200);
    expect(s.stale).toBe(false);
  });

  test("rpm fallback when gpm missing", () => {
    const s = deriveSceneState(
      { ...base, pumps: { "1": { pump: 1, rpm: 1725, watts: 800 } } },
      true,
    );
    expect(s.flow).toBeCloseTo(0.5);
    expect(s.gpm).toBeNull();
  });

  test("circuit fallback when no pump data", () => {
    const s = deriveSceneState({ ...base, pumps: {} }, true);
    expect(s.flow).toBe(0.5);
    const off = deriveSceneState(
      { ...base, pumps: {}, status: { ...base.status, circuits_on: [] } },
      true,
    );
    expect(off.flow).toBe(0);
  });

  test("idle pump means no flow even with circuit on", () => {
    const s = deriveSceneState(
      { ...base, pumps: { "1": { pump: 1, rpm: 0, watts: 0 } } },
      true,
    );
    expect(s.flow).toBe(0);
  });

  test("stale on old age or disconnect", () => {
    expect(deriveSceneState({ ...base, age: 120 }, true).stale).toBe(true);
    expect(deriveSceneState(base, false).stale).toBe(true);
    expect(deriveSceneState({ ...base, age: null }, true).stale).toBe(false);
  });
});

// The controller's `heater_on` bit is not "this body's heater is firing": read
// live off a real EasyTouch, it sat true while the pool was 5F ABOVE set-point
// with pool_heat_mode "Off" and only the SPA in Heater mode. Driving the scene's
// hot pipes straight off it showed the pool being heated when nothing was.
describe("heaterOn tracks real heat demand, not the raw bit", () => {
  const heating: State = {
    age: 2,
    status: {
      circuits_on: [6],
      pool_temp: 70,
      spa_temp: 70,
      heater_on: true,
      pool_heat_mode: "Heater",
      spa_heat_mode: "Off",
    },
    heat: { pool_setpoint: 80, spa_setpoint: 100 },
  };

  test("pool below set-point in Heater mode is calling for heat", () => {
    expect(deriveSceneState(heating, true).heaterOn).toBe(true);
  });

  test("pool at or above set-point is not calling for heat", () => {
    const at = { ...heating, status: { ...heating.status, pool_temp: 80 } };
    const above = { ...heating, status: { ...heating.status, pool_temp: 84 } };
    expect(deriveSceneState(at, true).heaterOn).toBe(false);
    expect(deriveSceneState(above, true).heaterOn).toBe(false);
  });

  // The live reading that prompted this.
  test("pool heat mode Off never heats, even with the raw bit set", () => {
    const live: State = {
      age: 2,
      status: {
        circuits_on: [6],
        pool_temp: 80,
        spa_temp: 80,
        heater_on: true,
        pool_heat_mode: "Off",
        spa_heat_mode: "Heater",
      },
      heat: { pool_setpoint: 75, spa_setpoint: 70 },
    };
    expect(deriveSceneState(live, true).heaterOn).toBe(false);
  });

  test("the raw bit clear means no heat regardless of set-points", () => {
    const cold = { ...heating, status: { ...heating.status, heater_on: false } };
    expect(deriveSceneState(cold, true).heaterOn).toBe(false);
  });

  test("spa running reads the spa's mode and set-point, not the pool's", () => {
    const spa: State = {
      age: 2,
      status: {
        circuits_on: [1],
        pool_temp: 70,
        spa_temp: 95,
        heater_on: true,
        pool_heat_mode: "Heater", // pool would call for heat; spa is the live body
        spa_heat_mode: "Heater",
      },
      heat: { pool_setpoint: 80, spa_setpoint: 100 },
    };
    expect(deriveSceneState(spa, true).heaterOn).toBe(true);
    const satisfied = { ...spa, status: { ...spa.status, spa_temp: 101 } };
    expect(deriveSceneState(satisfied, true).heaterOn).toBe(false);
  });

  test("no body running means nothing is being heated", () => {
    const off = { ...heating, status: { ...heating.status, circuits_on: [] } };
    expect(deriveSceneState(off, true).heaterOn).toBe(false);
  });

  // Set-points arrive in a separate frame than the status bit; until they do,
  // fall back to the mode gate rather than flapping the viz on a missing field.
  test("missing set-point falls back to the mode gate", () => {
    const noHeat = { ...heating, heat: null };
    expect(deriveSceneState(noHeat, true).heaterOn).toBe(true);
    const modeOff = {
      ...noHeat,
      status: { ...heating.status, pool_heat_mode: "Off" },
    };
    expect(deriveSceneState(modeOff, true).heaterOn).toBe(false);
  });
});

// Real pumps sometimes report gpm 0 while running in RPM mode (the mock bus
// does too) — a zero GPM must fall back to RPM instead of reading as no flow.
test("zero gpm with live rpm falls back to rpm", () => {
  const s = deriveSceneState(
    {
      age: 2,
      status: { circuits_on: [6] },
      pumps: { "1": { pump: 1, watts: 1250, rpm: 2750, gpm: 0 } },
    },
    true,
  );
  expect(s.flow).toBeCloseTo(2750 / 3450);
});
