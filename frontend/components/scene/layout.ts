// The scene's shared geometry: every dimension that more than one file needs
// lives here, so resizing the pool can't leave the water, liner, plumbing, or
// stairs behind. World units are ~2.54 ft (see FT).

/** World units per foot — the scene's scale, used to state real dimensions. */
export const FT = 1 / 2.54;

/** Sun/key-light position; the water's glints and caustics key off the same
 *  vector as the scene's directionalLight. */
export const SUN: [number, number, number] = [6, 10, 4];

// Pool footprint: a 16x32 ft (2:1) rounded rect, centred on the deck so it
// nearly fills the ground like the real enclosure.
export const POOL_POS: [number, number] = [-2.5, 0.2];
export const POOL_SIZE: [number, number] = [12.6, 6.3];
export const POOL_RADIUS = 1.2;

/** Waterline, in the scene group's frame (the deck top is 0). */
export const WATER_Y = -0.1;

/** Basin wall height, from the floor up to the deck. */
export const WALL_DEPTH = 2.1;

/** Stair bay protruding from the pool's west end: [depth outward, width]. */
export const BAY: [number, number] = [1.4, 3.4];
/** World x of the bay's outer (west) face. */
export const BAY_X = POOL_POS[0] - POOL_SIZE[0] / 2 - BAY[0];

/** Return-jet nozzle, as an offset from the pool's centre: near the front-left
 *  corner, just inside the front wall. Water converts this to sim UV and Pipes
 *  runs its buried return to the same spot. */
export const JET: [number, number] = [-2.84, 2.84];

/** Skimmer (suction) fitting on the deck at the pool's front-right. */
export const SKIMMER: [number, number] = [1.7, 4.1];

/** Equipment pad anchors, world XZ — the meshes stand here and the pipe runs
 *  connect to them. */
export const PAD = {
  pump: [6.3, 3.5] as [number, number],
  filter: [6.3, 2.4] as [number, number],
  heater: [6.3, 1.4] as [number, number],
  cell: [5.55, 1.35] as [number, number],
};
