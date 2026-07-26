// GPU height-field water simulation (the Evan Wallace / jeantimex scheme,
// adapted from jeantimex/threejs-water): two ping-pong half-float render
// targets hold R=height, G=velocity, BA=normal.xz. Each frame runs one batched
// drop pass (Hann-window bumps whose rate/strength scale with pump flow),
// fixed-timestep wave-equation updates (120/s) with flow-driven damping and a
// rounded-rect absorbing boundary, then a normal pass. Drops replace the
// demo's mouse interaction.
import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const MAX_DROPS = 8;

const SIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  // Fullscreen pass: PlaneGeometry(2,2) positions span [-1,1]; map to UV [0,1].
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Batched Hann-window drop injection: up to MAX_DROPS bumps in one pass.
const DROP_FRAG = /* glsl */ `
uniform sampler2D uPrev;
uniform int uCount;
uniform vec4 uDrops[${MAX_DROPS}]; // xy = center (sim UV), z = radius (wu), w = strength
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
void main() {
  vec4 info = texture2D(uPrev, vUv);
  vec2 dx = vec2(uDelta.x, 0.0);
  vec2 dy = vec2(0.0, uDelta.y);
  float avg = (texture2D(uPrev, vUv + dx).r + texture2D(uPrev, vUv - dx).r +
               texture2D(uPrev, vUv + dy).r + texture2D(uPrev, vUv - dy).r) * 0.25;
  info.g += (avg - info.r) * 2.0; // acceleration at the CFL stability edge
  info.g *= uDamping;
  info.r += info.g;
  // Soft absorbing band at the actual rounded-rect wall — clamp-to-edge alone
  // would reflect ripples off the invisible texture rectangle, not the corners.
  vec2 p = (vUv - 0.5) * 2.0 * uHalf;
  vec2 q = abs(p) - (uHalf - vec2(uRadius));
  float d = length(max(q, vec2(0.0))) - uRadius;
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

export const HEIGHT_SCALE = 1.6; // sim height units -> world y, shared with the surface shader

export interface WaterSimConfig {
  res: [number, number]; // aspect-matched so world texels are ~square
  worldSize: [number, number];
  radius: number;
  flow: number; // raw 0..1; smoothed internally
  jets: [number, number][]; // drop cluster sites in sim UV
  dropRadius: [number, number]; // base + random spread, world units (>= ~7 texels)
  rateScale?: number;
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
  const { res, worldSize, radius, jets, dropRadius, rateScale = 1 } = cfg;
  const simRef = React.useRef<THREE.Texture | null>(null);
  const flowRef = React.useRef(0);
  const flowProp = React.useRef(cfg.flow);
  flowProp.current = cfg.flow;
  const acc = React.useRef(0);
  const stepAcc = React.useRef(0);

  const sim = React.useMemo(() => {
    const targets = [makeTarget(res), makeTarget(res)];
    const delta = new THREE.Vector2(1 / res[0], 1 / res[1]);
    const half = new THREE.Vector2(worldSize[0] / 2, worldSize[1] / 2);
    const world = new THREE.Vector2(worldSize[0], worldSize[1]);
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: SIM_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    const drop = mk(DROP_FRAG, {
      uPrev: { value: null },
      uCount: { value: 0 },
      uDrops: { value: Array.from({ length: MAX_DROPS }, () => new THREE.Vector4()) },
      uWorldSize: { value: world },
    });
    const update = mk(UPDATE_FRAG, {
      uPrev: { value: null },
      uDelta: { value: delta },
      uDamping: { value: 0.99 },
      uHalf: { value: half },
      uRadius: { value: radius },
    });
    const normal = mk(NORMAL_FRAG, {
      uPrev: { value: null },
      uDelta: { value: delta },
      uWorldSize: { value: world },
      uHeightScale: { value: HEIGHT_SCALE },
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
      const px = (u - 0.5) * w;
      const py = (v - 0.5) * h;
      const qx = Math.abs(px) - (w / 2 - radius);
      const qy = Math.abs(py) - (h / 2 - radius);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
      if (d < -0.3) return [u, v];
    }
    return [0.5, 0.5];
  };

  useFrame(({ gl }, dt) => {
    if (dt > 1) return; // resumed tab: skip the huge step, don't explode
    const flow = (flowRef.current +=
      (flowProp.current - flowRef.current) * Math.min(dt * 2, 1));

    // Drop scheduler: jets churn with flow; near-still water gets rare ambient rings.
    const rate = (flow < 0.02 ? 0.15 : 1.5 + 16 * flow) * rateScale;
    acc.current += dt * rate;
    let count = 0;
    const drops = sim.drop.uniforms.uDrops.value as THREE.Vector4[];
    while (acc.current >= 1 && count < MAX_DROPS) {
      acc.current -= 1;
      let u: number, v: number;
      if (Math.random() < 0.65 && jets.length > 0) {
        const jet = jets[Math.floor(Math.random() * jets.length)];
        u = jet[0] + (Math.random() - 0.5) * 0.12;
        v = jet[1] + (Math.random() - 0.5) * 0.12;
      } else {
        [u, v] = randomSite();
      }
      const r = dropRadius[0] + dropRadius[1] * Math.random();
      const sign = Math.random() < 0.65 ? -1 : 1; // impacts read better than bulges
      drops[count].set(u, v, r, sign * (0.005 + 0.014 * flow));
      count++;
    }

    const pass = (material: THREE.ShaderMaterial) => {
      material.uniforms.uPrev.value = sim.targets[sim.read].texture;
      sim.quad.material = material;
      gl.setRenderTarget(sim.targets[1 - sim.read]);
      gl.render(sim.scene, sim.camera);
      sim.read = 1 - sim.read;
    };

    if (count > 0) {
      sim.drop.uniforms.uCount.value = count;
      pass(sim.drop);
    }
    sim.update.uniforms.uDamping.value = THREE.MathUtils.lerp(0.986, 0.997, flow);
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
