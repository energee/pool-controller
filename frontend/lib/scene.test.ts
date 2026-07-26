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
