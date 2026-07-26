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

  // Both ends are the 4' shallows, the middle is the 5' deep — mirror the
  // floor's depth profile in the body color.
  float ends = pow(clamp(abs(vPos.x) / uHalf.x, 0.0, 1.0), 2.0);
  float edge = smoothstep(-0.45, 0.0, d);
  vec3 body = mix(uDeep, uShallow, 0.20 + 0.35 * ends + 0.30 * edge);

  vec3 color = mix(body, skyColor(refl), fres);

  // Crisp sun glints off the sim normals.
  vec3 hv = normalize(uLight - ray);
  color += vec3(1.0, 0.95, 0.85) * pow(max(dot(normal, hv), 0.0), 240.0) * (0.6 + 1.4 * uFlow);

  // Fresnel-driven alpha is the "refraction": the opaque floor shows through
  // at low incidence, grazing edges go opaque sky-mirror.
  gl_FragColor = vec4(color, mix(uAlphaRange.x, uAlphaRange.y, fres));
}
`;

// The floor carries the pool's depth profile: 4' at both ends, 5' in the
// middle (1.2/1.5 wu), blended parabolically along the long axis. The mesh
// sits at water level and each vertex is pushed down by its local depth.
const FLOOR_VERT = /* glsl */ `
uniform vec2 uHalf;
uniform float uDepthEnds;
uniform float uDepthMid;
varying vec2 vPos;
varying float vDepth;
void main() {
  vPos = position.xy;
  float t = clamp(abs(position.x) / uHalf.x, 0.0, 1.0);
  vDepth = uDepthMid - (uDepthMid - uDepthEnds) * t * t;
  gl_Position = projectionMatrix * modelViewMatrix
    * vec4(position.x, position.y, -vDepth, 1.0);
}
`;

const FLOOR_FRAG = /* glsl */ `
uniform sampler2D uSim;
uniform vec2 uHalf;
uniform float uRadius;
uniform vec2 uDelta;
uniform vec3 uLight;
uniform float uDepthEnds;
uniform float uDepthMid;
uniform float uTileSize;
varying vec2 vPos;
varying float vDepth;

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
  vec2 cuv = uv + vec2(refr.x, -refr.z) / refr.y * vDepth / (2.0 * uHalf);
  vec4 infoC = texture2D(uSim, cuv);
  float nxE = texture2D(uSim, cuv + vec2(uDelta.x, 0.0)).b;
  float nzN = texture2D(uSim, cuv + vec2(0.0, uDelta.y)).a;
  float div = (nxE - infoC.b) + (nzN - infoC.a);
  float caustic = 0.68 + 2.2 * pow(clamp(0.5 + 6.0 * div, 0.0, 1.0), 3.0);

  // Speckled vinyl liner (like the real pool) with fake refraction: offset the
  // lookup by surface slope times depth.
  vec2 tp = vPos + above.ba * (vDepth * 0.6);
  float sp = hash21(floor(tp * 22.0));
  float fleck = step(0.82, hash21(floor(tp * 22.0) + 7.3));
  vec3 base = mix(vec3(0.62, 0.82, 0.90), vec3(0.42, 0.68, 0.82), 0.35 * sp);
  base = mix(base, vec3(0.30, 0.55, 0.72), fleck * 0.6);

  // Depth tint (deeper middle sits dimmer) + a wall-shadow band at the edge.
  float dn = (vDepth - uDepthEnds) / max(uDepthMid - uDepthEnds, 0.001);
  float wall = smoothstep(-0.55, -0.02, d);
  vec3 color = base * caustic * vec3(0.62, 0.88, 0.98);
  color *= mix(1.0, 0.80, clamp(dn, 0.0, 1.0));
  color *= mix(1.0, 0.55, wall);
  gl_FragColor = vec4(color, 1.0);
}
`;

const LIGHT_DIR = new THREE.Vector3(6, 10, 4).normalize(); // matches the scene's directionalLight

// 16x32 ft pool at ~2.54 ft per world unit. Sim texels stay ~square (~0.049wu).
const POOL = {
  res: [256, 128] as [number, number],
  segments: [96, 64] as [number, number],
  depthEnds: 1.58, // 4 ft
  depthMid: 1.97, // 5 ft
  alphaRange: [0.42, 0.9] as [number, number],
  tileSize: 0.42,
  heightScale: 1.6,
  // One pressurized return jet entering at the pool's FRONT-LEFT (sim UV
  // v=0 is the front edge; the run from the cell is underground), firing
  // STRAIGHT into the pool, perpendicular to the wall.
  jets: [{ pos: [0.275, 0.05], dir: [0, 1] }] as Jet[],
  jetLen: [1.0, 1.8] as [number, number],
  jetK: 10.5,
  jetOmega: 7.5,
  jetAmp: 0.009,
  damping: [0.986, 0.997] as [number, number],
  dropRadius: [0.22, 0.18] as [number, number],
  rateScale: 1,
};

export function Water({
  size,
  radius,
  flow,
  position,
  shallow = "#8fdcec",
  deep = "#1f86b4",
}: {
  size: [number, number];
  radius: number; // corner radius; use half the size for a round surface
  flow: number;
  position: [number, number, number];
  shallow?: string;
  deep?: string;
}) {
  const v = POOL;
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
        uDepthEnds: { value: v.depthEnds },
        uDepthMid: { value: v.depthMid },
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
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[size[0], size[1], 48, 1]} />
        <shaderMaterial
          ref={floor}
          uniforms={uniforms.floor}
          vertexShader={FLOOR_VERT}
          fragmentShader={FLOOR_FRAG}
        />
      </mesh>
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
