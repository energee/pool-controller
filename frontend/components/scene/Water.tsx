// Simulation-driven water styled after jeantimex/threejs-water: the surface
// displaces by the GPU height field (see waterSim.ts), reflects a procedural
// sky by fresnel, and composites over an opaque procedural-tile floor whose
// shader wobbles the tiles by surface slope (fake refraction) and lights them
// with a cheap caustic derived from the height-field's normal divergence.
// The rounded-rect footprint is clipped by SDF in both fragment shaders.
import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { useWaterSim, type Jet } from "./waterSim";

const SURFACE_VERT = /* glsl */ `
uniform sampler2D uSim;
uniform vec2 uHalf;
uniform float uHeightScale;
uniform float uTime;
uniform float uFlow;
varying vec2 vPos;
varying vec3 vWorld;
void main() {
  vPos = position.xy;
  vec2 uv = position.xy / (2.0 * uHalf) + 0.5;
  vec4 info = texture2D(uSim, uv);
  // Tiny procedural idle swell so flow 0 is calm but not a dead freeze-frame.
  float idle = 0.004 * sin(1.8 * position.x + 1.4 * position.y + uTime * 0.9)
             + 0.003 * sin(2.7 * position.x - 2.1 * position.y - uTime * 1.3);
  float h = info.r * uHeightScale + idle * (0.3 + 0.7 * uFlow);
  vec4 wp = modelMatrix * vec4(position.x, position.y, h, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// No precision pragma — three injects one; an explicit mediump would break
// program validation against the highp vertex uniforms (known pitfall here).
const SURFACE_FRAG = /* glsl */ `
uniform sampler2D uSim;
uniform vec2 uHalf;
uniform float uRadius;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform float uFlow;
uniform vec3 uLight;
uniform vec2 uAlphaRange;
varying vec2 vPos;
varying vec3 vWorld;

// Only ever seen AS A REFLECTION, so it reads as outdoor daylight over the
// transparent-canvas dark card without any skybox mesh.
vec3 skyColor(vec3 ray) {
  float t = clamp(ray.y, 0.0, 1.0);
  vec3 sky = mix(vec3(0.82, 0.90, 0.97), vec3(0.22, 0.48, 0.78), pow(t, 0.6));
  float sun = pow(max(dot(ray, uLight), 0.0), 600.0);
  return sky + sun * vec3(2.6, 2.1, 1.4);
}

void main() {
  vec2 q = abs(vPos) - (uHalf - vec2(uRadius));
  float d = length(max(q, vec2(0.0))) - uRadius;
  if (d > 0.0) discard;

  vec2 uv = vPos / (2.0 * uHalf) + 0.5;
  vec4 info = texture2D(uSim, uv);
  vec2 slope = clamp(info.ba, vec2(-0.999), vec2(0.999));
  float s2 = min(dot(slope, slope), 0.999);
  // The plane's -PI/2 X rotation maps sim v to world -z, so the stored
  // v-slope must be negated to build the WORLD normal (the demo swizzles
  // position.xzy instead of rotating and never hits this mirror).
  vec3 normal = normalize(vec3(slope.x, sqrt(1.0 - s2), -slope.y));

  vec3 ray = normalize(vWorld - cameraPosition);
  vec3 refl = reflect(ray, normal);
  refl.y = abs(refl.y); // never sample "below horizon" — keeps reflections sky-like

  // Schlick-style fresnel; F0 lower than the demo so the floor tiles stay
  // visible through the middle from our high fixed camera.
  float fres = mix(0.12, 1.0, pow(1.0 - max(dot(normal, -ray), 0.0), 3.0));

  float along = clamp((vPos.x + uHalf.x) / (2.0 * uHalf.x), 0.0, 1.0);
  float edge = smoothstep(-0.45, 0.0, d);
  vec3 body = mix(uDeep, uShallow, 0.25 + 0.40 * along + 0.30 * edge);

  vec3 color = mix(body, skyColor(refl), fres);

  // Crisp sun glints off the sim normals.
  vec3 hv = normalize(uLight - ray);
  color += vec3(1.0, 0.95, 0.85) * pow(max(dot(normal, hv), 0.0), 240.0) * (0.6 + 1.4 * uFlow);

  // Fresnel-driven alpha is the "refraction": the opaque floor shows through
  // at low incidence, grazing edges go opaque sky-mirror.
  gl_FragColor = vec4(color, mix(uAlphaRange.x, uAlphaRange.y, fres));
}
`;

const FLOOR_VERT = /* glsl */ `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FLOOR_FRAG = /* glsl */ `
uniform sampler2D uSim;
uniform vec2 uHalf;
uniform float uRadius;
uniform vec2 uDelta;
uniform vec3 uLight;
uniform float uDepth;
uniform float uTileSize;
varying vec2 vPos;

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

void main() {
  vec2 q = abs(vPos) - (uHalf - vec2(uRadius));
  float d = length(max(q, vec2(0.0))) - uRadius;
  if (d > 0.0) discard;

  vec2 uv = vPos / (2.0 * uHalf) + 0.5;
  vec4 above = texture2D(uSim, uv);

  // Cheap caustic: shear along the refracted sun by pool depth, then take the
  // divergence of the stored normal.xz (≈ -laplacian of height) — bright under
  // crests (converging lens), dark under troughs. 3 extra taps, no extra pass.
  vec3 refr = refract(-uLight, vec3(0.0, 1.0, 0.0), 0.750);
  // sim v maps to world -z (rotated plane), so the world-z shear flips sign
  vec2 cuv = uv + vec2(refr.x, -refr.z) / refr.y * uDepth / (2.0 * uHalf);
  vec4 infoC = texture2D(uSim, cuv);
  float nxE = texture2D(uSim, cuv + vec2(uDelta.x, 0.0)).b;
  float nzN = texture2D(uSim, cuv + vec2(0.0, uDelta.y)).a;
  float div = (nxE - infoC.b) + (nzN - infoC.a);
  float caustic = 0.68 + 2.2 * pow(clamp(0.5 + 6.0 * div, 0.0, 1.0), 3.0);

  // Procedural tiles with fake refraction: offset the lookup by surface slope
  // times depth (first-order stand-in for the demo's ray-box refraction).
  vec2 tp = (vPos + above.ba * (uDepth * 0.6)) / uTileSize;
  vec2 cell = floor(tp);
  vec2 f = abs(fract(tp) - 0.5);
  vec3 tile = mix(vec3(0.75, 0.88, 0.90), vec3(0.56, 0.76, 0.81), hash21(cell) * 0.7);
  vec2 aa = fwidth(tp) * 1.2;
  vec2 gs = smoothstep(vec2(0.465) - aa, vec2(0.465), f);
  vec3 base = mix(tile, vec3(0.90, 0.93, 0.94), max(gs.x, gs.y));

  // Depth tint, deep-end falloff, and a wall-shadow band near the SDF edge.
  float along = clamp((vPos.x + uHalf.x) / (2.0 * uHalf.x), 0.0, 1.0);
  float wall = smoothstep(-0.55, -0.02, d);
  vec3 color = base * caustic * vec3(0.62, 0.88, 0.98);
  color *= mix(0.80, 1.0, along);
  color *= mix(1.0, 0.55, wall);
  gl_FragColor = vec4(color, 1.0);
}
`;

const LIGHT_DIR = new THREE.Vector3(6, 10, 4).normalize(); // matches the scene's directionalLight

interface Variant {
  res: [number, number];
  segments: [number, number];
  depth: number;
  floor: boolean;
  alphaRange: [number, number];
  tileSize: number;
  heightScale: number;
  jets: Jet[];
  jetLen: [number, number];
  jetK: number;
  jetOmega: number;
  jetAmp: number;
  damping: [number, number];
  dropRadius: [number, number];
  rateScale: number;
}

// Sim texels stay ~square and ~0.03wu in both variants.
const VARIANTS: Record<"pool" | "spa", Variant> = {
  pool: {
    res: [256, 128],
    segments: [96, 64],
    depth: 0.9,
    floor: true,
    alphaRange: [0.42, 0.9],
    tileSize: 0.42,
    heightScale: 1.6,
    // One pressurized return jet at the pipe inlet on the north edge (sim UV
    // (0.68, 0.05) — see PoolScene's returnPool endpoint), aimed into the pool
    // and slightly west like a real eyeball fitting, driving circulation.
    jets: [{ pos: [0.68, 0.05], dir: [-0.25, 0.95] }],
    jetLen: [0.8, 1.4],
    jetK: 10.5,
    jetOmega: 7.5,
    jetAmp: 0.009,
    damping: [0.986, 0.997],
    dropRadius: [0.22, 0.18],
    rateScale: 1,
  },
  spa: {
    // The tub is hollow (open shell in PoolScene) — this floor is the spa's
    // interior bottom, so the water has something lit to refract onto.
    res: [64, 64],
    segments: [32, 32],
    depth: 0.35,
    floor: true,
    alphaRange: [0.55, 0.95],
    tileSize: 0.28,
    // Small amplitude + short fast waves + strong decay: choppy spa boil, not
    // the pool's long swells (which read as jelly at tub scale).
    heightScale: 0.8,
    // Four wall inlets aimed inward-tangential (matching the nozzle fittings
    // in PoolScene) — the classic spa swirl. Exit is the floor drain.
    jets: [
      { pos: [0.779, 0.779], dir: [-0.99, 0.141] },
      { pos: [0.221, 0.779], dir: [-0.141, -0.99] },
      { pos: [0.221, 0.221], dir: [0.99, -0.141] },
      { pos: [0.779, 0.221], dir: [0.141, 0.99] },
    ],
    jetLen: [0.22, 0.28],
    jetK: 22,
    jetOmega: 12,
    jetAmp: 0.005,
    damping: [0.986, 0.992],
    dropRadius: [0.12, 0.08],
    rateScale: 0.5,
  },
};

export function Water({
  variant = "pool",
  size,
  radius,
  flow,
  position,
  shallow = "#8fdcec",
  deep = "#1f86b4",
}: {
  variant?: "pool" | "spa";
  size: [number, number];
  radius: number; // corner radius; use half the size for a round surface
  flow: number;
  position: [number, number, number];
  shallow?: string;
  deep?: string;
}) {
  const v = VARIANTS[variant];
  const { simRef, flowRef } = useWaterSim({
    res: v.res,
    worldSize: size,
    radius,
    flow,
    heightScale: v.heightScale,
    jets: v.jets,
    jetLen: v.jetLen,
    jetK: v.jetK,
    jetOmega: v.jetOmega,
    jetAmp: v.jetAmp,
    damping: v.damping,
    dropRadius: v.dropRadius,
    rateScale: v.rateScale,
  });

  const surface = React.useRef<THREE.ShaderMaterial>(null);
  const floor = React.useRef<THREE.ShaderMaterial>(null);
  const uniforms = React.useMemo(() => {
    const half = new THREE.Vector2(size[0] / 2, size[1] / 2);
    return {
      surface: {
        uSim: { value: null as THREE.Texture | null },
        uHalf: { value: half },
        uRadius: { value: radius },
        uHeightScale: { value: v.heightScale },
        uTime: { value: 0 },
        uFlow: { value: 0 },
        uShallow: { value: new THREE.Color(shallow) },
        uDeep: { value: new THREE.Color(deep) },
        uLight: { value: LIGHT_DIR },
        uAlphaRange: { value: new THREE.Vector2(...v.alphaRange) },
      },
      floor: {
        uSim: { value: null as THREE.Texture | null },
        uHalf: { value: half },
        uRadius: { value: radius },
        uDelta: { value: new THREE.Vector2(1 / v.res[0], 1 / v.res[1]) },
        uLight: { value: LIGHT_DIR },
        uDepth: { value: v.depth },
        uTileSize: { value: v.tileSize },
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- static per mount
  }, []);

  useFrame(({ clock }) => {
    const tex = simRef.current;
    if (surface.current) {
      surface.current.uniforms.uSim.value = tex;
      // Wrap at 20π — a common period of the 0.9/1.3 rad/s swell frequencies —
      // so float32 sin() stays precise on a dashboard left open for days.
      surface.current.uniforms.uTime.value = clock.elapsedTime % (20 * Math.PI);
      surface.current.uniforms.uFlow.value = flowRef.current ?? 0;
    }
    if (floor.current) floor.current.uniforms.uSim.value = tex;
  });

  return (
    <group position={position}>
      {v.floor ? (
        <mesh position={[0, -v.depth, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[size[0], size[1], 1, 1]} />
          <shaderMaterial
            ref={floor}
            uniforms={uniforms.floor}
            vertexShader={FLOOR_VERT}
            fragmentShader={FLOOR_FRAG}
          />
        </mesh>
      ) : null}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size[0], size[1], ...v.segments]} />
        <shaderMaterial
          ref={surface}
          uniforms={uniforms.surface}
          vertexShader={SURFACE_VERT}
          fragmentShader={SURFACE_FRAG}
          transparent
        />
      </mesh>
    </group>
  );
}
