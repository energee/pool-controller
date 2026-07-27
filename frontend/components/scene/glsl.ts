// GLSL chunks shared by the scene's shader programs. GLSL has no #include, so
// these are interpolated into each program's source — the point is that the
// pool's footprint and its liner are defined once, not re-typed per shader.

/** Signed distance to the pool footprint (rounded rect ∪ stair bay), in plane-
 *  local units. Requires the uniforms declared in POOL_SDF_UNIFORMS plus
 *  `uRadius`. Negative inside the water. */
export const POOL_SDF_GLSL = /* glsl */ `
uniform vec2 uRR;    // rounded-rect half extents
uniform vec2 uRROff; // rr center offset within the (wider) plane
uniform vec2 uBayC;  // stair-bay rect center (local)
uniform vec2 uBayH;  // stair-bay half extents; x<=0 disables
float poolSDF(vec2 p) {
  vec2 q = abs(p - uRROff) - (uRR - vec2(uRadius));
  float d = length(max(q, vec2(0.0))) - uRadius;
  if (uBayH.x > 0.0) {
    vec2 b = abs(p - uBayC) - uBayH;
    float db = length(max(b, vec2(0.0))) + min(max(b.x, b.y), 0.0);
    d = min(d, db);
  }
  return d;
}
`;

/** Speckled blue vinyl liner, shared by the pool floor and the basin walls so
 *  they can't drift apart. `p` is a world-scale 2D coordinate. */
export const LINER_GLSL = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
vec3 linerColor(vec2 p) {
  vec2 cell = floor(p * 22.0);
  float sp = hash21(cell);
  float fleck = step(0.82, hash21(cell + 7.3));
  vec3 base = mix(vec3(0.62, 0.82, 0.90), vec3(0.42, 0.68, 0.82), 0.35 * sp);
  return mix(base, vec3(0.30, 0.55, 0.72), fleck * 0.6);
}
`;
