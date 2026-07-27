// GPU height-field water simulation (the Evan Wallace / jeantimex scheme,
// adapted from jeantimex/threejs-water): two ping-pong half-float render
// targets hold R=height, G=velocity, BA=normal.xz. Each frame runs one
// forcing pass (pressurized return JETS — oscillating directional sources
// that imprint a traveling wave train marching downstream from each nozzle —
// plus occasional ambient Hann-window drops), fixed-timestep wave-equation
// updates (120/s) with flow-driven damping and a rounded-rect absorbing
// boundary, then a normal pass.
import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { POOL_SDF_GLSL } from "./glsl";

const MAX_DROPS = 8;
const MAX_JETS = 4;

const SIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  // Fullscreen pass: PlaneGeometry(2,2) positions span [-1,1]; map to UV [0,1].
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Forcing pass: pressurized jets + ambient drops in one fullscreen pass.
// Jets force the VELOCITY field with sin(k*s - phase) along the jet axis —
// a sustained traveling-wave source, so waves visibly push downstream from
// the nozzle instead of raining randomly. Drops add Hann bumps to height.
const DROP_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform int uCount;
uniform vec4 uDrops[${MAX_DROPS}]; // xy = center (sim UV), z = radius (wu), w = strength
uniform int uJetCount;
uniform vec2 uJetPos[${MAX_JETS}]; // nozzle in sim UV
uniform vec2 uJetDir[${MAX_JETS}]; // unit direction, plane-local frame
uniform float uJetAmp;             // velocity forcing amplitude (flow-scaled)
uniform float uJetLen;             // plume length in world units (flow-scaled)
uniform float uJetPhase;           // advancing phase, wrapped at 2*PI
uniform float uJetK;               // wave number, rad per world unit
uniform vec2 uWorldSize;
varying vec2 vUv;
const float PI = 3.141592653589793;
void main() {
  vec4 info = texture2D(uPrev, vUv);
  for (int i = 0; i < ${MAX_DROPS}; i++) {
    if (i >= uCount) break;
    // distance in WORLD units so drops stay round on the non-square texture
    vec2 d = (vUv - uDrops[i].xy) * uWorldSize;
    float t = max(0.0, 1.0 - length(d) / uDrops[i].z);
    t = 0.5 - 0.5 * cos(t * PI); // Hann profile: smooth peak and edge
    info.r += t * uDrops[i].w;
  }
  for (int j = 0; j < ${MAX_JETS}; j++) {
    if (j >= uJetCount) break;
    vec2 rel = (vUv - uJetPos[j]) * uWorldSize; // plane-local world units
    vec2 dir = uJetDir[j];
    float s = dot(rel, dir);                    // distance downstream
    float lat = abs(rel.x * dir.y - rel.y * dir.x);
    // Plume envelope: widens downstream, fades in at the nozzle, dies at uJetLen.
    float sigma = 0.10 + 0.22 * max(s, 0.0);
    float env = exp(-lat * lat / (2.0 * sigma * sigma))
              * smoothstep(-0.15, 0.05, s)
              * (1.0 - smoothstep(uJetLen * 0.55, uJetLen, s));
    info.g += uJetAmp * env * sin(uJetK * s - uJetPhase);
  }
  gl_FragColor = info;
}
`;

// Wave-equation step (run at a fixed 120 steps/s — the demo's 2-per-frame
// cadence at 60Hz). The sim texture is aspect-matched to the footprint so
// world texels are square and the classic isotropic Laplacian applies.
const UPDATE_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform vec2 uDelta;
uniform float uDamping;
uniform vec2 uHalf;
uniform float uRadius;
varying vec2 vUv;
${POOL_SDF_GLSL}
void main() {
  vec4 info = texture2D(uPrev, vUv);
  vec2 dx = vec2(uDelta.x, 0.0);
  vec2 dy = vec2(0.0, uDelta.y);
  float avg = (texture2D(uPrev, vUv + dx).r + texture2D(uPrev, vUv - dx).r +
               texture2D(uPrev, vUv + dy).r + texture2D(uPrev, vUv - dy).r) * 0.25;
  info.g += (avg - info.r) * 2.0; // acceleration at the CFL stability edge
  info.g *= uDamping;
  info.r += info.g;
  // Soft absorbing band at the actual pool wall (rounded rect + stair bay) —
  // clamp-to-edge alone would reflect off the invisible texture rectangle.
  float d = poolSDF((vUv - 0.5) * 2.0 * uHalf);
  float wall = smoothstep(-0.18, 0.0, d);
  info.rg *= 1.0 - 0.5 * wall;
  gl_FragColor = info;
}
`;

// Normal pass (once per frame): forward-difference tangents in world units.
// Heights are pre-scaled so stored slopes match the amplified displacement.
const NORMAL_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform vec2 uDelta;
uniform vec2 uWorldSize;
uniform float uHeightScale;
varying vec2 vUv;
void main() {
  vec4 info = texture2D(uPrev, vUv);
  float hx = texture2D(uPrev, vec2(vUv.x + uDelta.x, vUv.y)).r - info.r;
  float hy = texture2D(uPrev, vec2(vUv.x, vUv.y + uDelta.y)).r - info.r;
  vec3 dx = vec3(uDelta.x * uWorldSize.x, hx * uHeightScale, 0.0);
  vec3 dy = vec3(0.0, hy * uHeightScale, uDelta.y * uWorldSize.y);
  info.ba = normalize(cross(dy, dx)).xz;
  gl_FragColor = info;
}
`;

export interface Jet {
  pos: [number, number]; // nozzle in sim UV
  dir: [number, number]; // downstream direction, plane-local frame (normalized internally)
}

export interface WaterSimConfig {
  res: [number, number]; // aspect-matched so world texels are ~square
  worldSize: [number, number];
  rr: [number, number]; // rounded-rect half extents (SDF)
  rrOff: [number, number];
  bayC: [number, number];
  bayH: [number, number]; // x<=0 disables the bay
  radius: number;
  flow: number; // raw 0..1; smoothed internally
  heightScale: number; // sim height -> world y; must match the surface shader's
  jets: Jet[]; // pressurized return jets (max 4): sustained wave-train sources
  jetLen: [number, number]; // plume length = base + perFlow * flow, world units
  jetK: number; // wave number (rad/wu): higher = shorter, choppier waves
  jetOmega: number; // phase speed (rad/s): train travels at omega/k wu/s
  jetAmp: number; // velocity forcing amplitude at flow 1
  damping: [number, number]; // per-step, lerped by flow — lower max = faster decay
  dropRadius: [number, number]; // ambient drops: base + random spread, world units
}

export interface WaterSim {
  /** Latest sim texture — read in useFrame (it swaps every frame). */
  simRef: React.RefObject<THREE.Texture | null>;
  /** Flow smoothed at ~2/s, shared so damping, drops, and shading agree. */
  flowRef: React.RefObject<number>;
}

function makeTarget(res: [number, number]): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(res[0], res[1], {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

export function useWaterSim(cfg: WaterSimConfig): WaterSim {
  const {
    res, worldSize, rr, rrOff, bayC, bayH, radius, heightScale, jets, jetLen,
    jetK, jetOmega, jetAmp, damping, dropRadius,
  } = cfg;
  const simRef = React.useRef<THREE.Texture | null>(null);
  const flowRef = React.useRef(0);
  const flowProp = React.useRef(cfg.flow);
  flowProp.current = cfg.flow;
  const acc = React.useRef(0);
  const stepAcc = React.useRef(0);
  const phase = React.useRef(0);
  const settleAge = React.useRef(0);

  const sim = React.useMemo(() => {
    const targets = [makeTarget(res), makeTarget(res)];
    const delta = new THREE.Vector2(1 / res[0], 1 / res[1]);
    const half = new THREE.Vector2(worldSize[0] / 2, worldSize[1] / 2);
    const world = new THREE.Vector2(worldSize[0], worldSize[1]);
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: SIM_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    const jetCount = Math.min(jets.length, MAX_JETS);
    const drop = mk(DROP_FRAG, {
      uPrev: { value: null },
      uCount: { value: 0 },
      uDrops: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) },
      uJetCount: { value: jetCount },
      uJetPos: {
        value: Array.from({ length: MAX_JETS }, (_, i) =>
          new THREE.Vector2(...(jets[i]?.pos ?? [0, 0])),
        ),
      },
      uJetDir: {
        value: Array.from({ length: MAX_JETS }, (_, i) =>
          new THREE.Vector2(...(jets[i]?.dir ?? [0, 1])).normalize(),
        ),
      },
      uJetAmp: { value: 0 },
      uJetLen: { value: jetLen[0] },
      uJetPhase: { value: 0 },
      uJetK: { value: jetK },
      uWorldSize: { value: world },
    });
    const update = mk(UPDATE_FRAG, {
      uPrev: { value: null },
      uDelta: { value: delta },
      uDamping: { value: 0.99 },
      uHalf: { value: half },
      uRadius: { value: radius },
      uRR: { value: new THREE.Vector2(...rr) },
      uRROff: { value: new THREE.Vector2(...rrOff) },
      uBayC: { value: new THREE.Vector2(...bayC) },
      uBayH: { value: new THREE.Vector2(...bayH) },
    });
    const normal = mk(NORMAL_FRAG, {
      uPrev: { value: null },
      uDelta: { value: delta },
      uWorldSize: { value: world },
      uHeightScale: { value: heightScale },
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), drop);
    quad.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(quad);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    return { targets, drop, update, normal, quad, scene, camera, read: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- static per mount
  }, []);

  React.useEffect(() => {
    return () => {
      sim.targets.forEach((t) => t.dispose());
      [sim.drop, sim.update, sim.normal].forEach((m) => m.dispose());
      sim.quad.geometry.dispose();
    };
  }, [sim]);

  // Inside the pool, inset from the wall — rejection-sampled uniform position.
  const randomSite = (): [number, number] => {
    const [w, h] = worldSize;
    for (let i = 0; i < 8; i++) {
      const u = Math.random();
      const v = Math.random();
      const px = (u - 0.5) * w - rrOff[0];
      const py = (v - 0.5) * h;
      const qx = Math.abs(px) - (rr[0] - radius);
      const qy = Math.abs(py) - (rr[1] - radius);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
      if (d < -0.3) return [u, v];
    }
    return [0.5, 0.5];
  };

  useFrame(({ gl }, dt) => {
    if (dt > 1) return; // resumed tab: skip the huge step, don't explode
    const flow = (flowRef.current +=
      (flowProp.current - flowRef.current) * Math.min(dt * 2, 1));

    // Ambient drops carry the *whole-surface* chop; the jet only ever energizes
    // its own ~2wu plume, and damping kills that wave train (0.36x/s at half
    // flow) long before it crosses a 14wu pool, so a running pool driven by the
    // jet alone reads dead flat everywhere else. Rate and strength therefore
    // ramp hard with flow: a rare ring when still, a continuous stipple running.
    const rate = flow < 0.02 ? 0.15 : 4 + 26 * flow;
    acc.current += dt * rate;
    let count = 0;
    const drops = sim.drop.uniforms.uDrops.value as THREE.Vector4[];
    while (acc.current >= 1 && count < MAX_DROPS) {
      acc.current -= 1;
      const [u, v] = randomSite();
      const r = dropRadius[0] + dropRadius[1] * Math.random();
      const sign = Math.random() < 0.65 ? -1 : 1; // impacts read better than bulges
      drops[count].set(u, v, r, sign * (0.004 + 0.030 * flow));
      count++;
    }

    const pass = (material: THREE.ShaderMaterial) => {
      material.uniforms.uPrev.value = sim.targets[sim.read].texture;
      sim.quad.material = material;
      gl.setRenderTarget(sim.targets[1 - sim.read]);
      gl.render(sim.scene, sim.camera);
      sim.read = 1 - sim.read;
    };

    // Forcing pass runs whenever there is anything to inject: queued drops or
    // live jets. Jet phase advances in real time (wrapped — sin is periodic).
    const jetsLive = flow > 0.02 && jets.length > 0;
    // Nothing injected for a few seconds means the damped field has decayed to
    // nothing, so the passes would just churn zeros — skip them. The surface's
    // procedural idle swell keeps the water alive meanwhile.
    settleAge.current = count > 0 || jetsLive ? 0 : settleAge.current + dt;
    if (settleAge.current > 3) return;
    if (count > 0 || jetsLive) {
      phase.current = (phase.current + dt * jetOmega) % (2 * Math.PI);
      sim.drop.uniforms.uCount.value = count;
      sim.drop.uniforms.uJetAmp.value = jetsLive ? jetAmp * flow : 0;
      sim.drop.uniforms.uJetLen.value = jetLen[0] + jetLen[1] * flow;
      sim.drop.uniforms.uJetPhase.value = phase.current;
      pass(sim.drop);
    }
    sim.update.uniforms.uDamping.value = THREE.MathUtils.lerp(damping[0], damping[1], flow);
    // Fixed-timestep updates (120 steps/s = the tuned 2-per-frame at 60Hz),
    // so wave speed doesn't double on 120Hz displays; cap bounds slow frames.
    stepAcc.current = Math.min(stepAcc.current + dt * 120, 4);
    const steps = Math.floor(stepAcc.current);
    stepAcc.current -= steps;
    for (let i = 0; i < steps; i++) pass(sim.update);
    pass(sim.normal);
    gl.setRenderTarget(null);
    simRef.current = sim.targets[sim.read].texture;
  }, -1); // before the main render, so the surface reads this frame's state

  return { simRef, flowRef };
}
