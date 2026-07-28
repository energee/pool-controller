// Tests for waterPlane: the footprint the water surface and floor are laid out
// on. The invariant that matters is where its edges land in the world -- a
// plane that is the right size but the wrong center leaves a gap at the stairs
// and an overhang past the far wall, and neither shows up in a type check.
import { describe, expect, test } from "bun:test";

import { BAY, BAY_X, POOL_POS, POOL_SIZE, waterPlane } from "./layout";

describe("waterPlane", () => {
  test("spans the bay's west face to the pool's east wall", () => {
    const { plane, offset } = waterPlane(POOL_SIZE, BAY);
    // Meshes sit at the rounded rect's center shifted west by offset.
    const center = POOL_POS[0] - offset;
    expect(center - plane[0] / 2).toBeCloseTo(BAY_X); // reaches the stairs
    expect(center + plane[0] / 2).toBeCloseTo(POOL_POS[0] + POOL_SIZE[0] / 2);
    expect(plane[1]).toBe(POOL_SIZE[1]); // the bay only widens the x axis
  });

  test("no bay leaves the rounded rect centered and unwidened", () => {
    const { plane, offset } = waterPlane(POOL_SIZE);
    expect(offset).toBe(0);
    expect(plane).toEqual(POOL_SIZE);
  });
});
