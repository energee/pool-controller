// The scene graph for the pool system card, styled after a real backyard pool:
// a 16x32 ft rounded-rect turquoise pool sunk into a light concrete deck with
// white coping, and the equipment pad + plumbing beside it.
// Pure presentation of a SceneState; drag/wheel orbits around the pool.
import * as React from "react";
import { Html, OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

import type { SceneState } from "../../lib/scene";
import { Equipment } from "./Equipment";
import { Pipes } from "./Pipes";
import { Water } from "./Water";

// Pool footprint: a 16x32 ft (2:1) rounded rect at ~2.9 ft/wu, centred at
// [-2.0, 0.3] with the long axis on X.
const POOL_POS: [number, number] = [-2.0, 0.3];
const POOL_SIZE: [number, number] = [11.0, 5.5];
const POOL_RADIUS = 1.2;
const CAM_POS: [number, number, number] = [8.3, 7.0, 11.9];
const CAM_TARGET: [number, number, number] = [0.1, -1.1, 0.1];

// Seed the camera's starting pose once; OrbitControls owns it from there
// (and, unlike a one-shot lookAt, keeps re-aiming it every frame, so the
// poll-driven camera-prop re-application can't knock the view askew).
function CameraRig() {
  const camera = useThree((s) => s.camera);
  React.useEffect(() => {
    camera.position.set(...CAM_POS);
  }, [camera]);
  return (
    <OrbitControls
      makeDefault
      target={CAM_TARGET}
      // right-drag (two-finger click on a trackpad) pans; drag rotates
      enablePan
      screenSpacePanning={false}
      minDistance={5}
      maxDistance={22}
      // stay above the deck and never quite top-down
      minPolarAngle={0.15}
      maxPolarAngle={1.35}
      enableDamping
      dampingFactor={0.08}
    />
  );
}

// Rounded-rect path centred at (cx, cy) in shape space. NOTE: these shapes are
// rendered rotated -PI/2 about X, which maps shape +y to world -z — so a hole
// at world z = +Z is built at cy = -Z.
function rrAt(cx: number, cy: number, w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = cx - w / 2,
    y = cy - h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2, false);
  return s;
}

// Flat rounded-rect ring (outer minus inner) used for the pool coping.
function copingGeometry(): THREE.ExtrudeGeometry {
  const outer = rrAt(0, 0, POOL_SIZE[0] + 0.7, POOL_SIZE[1] + 0.7, POOL_RADIUS + 0.3);
  outer.holes.push(rrAt(0, 0, POOL_SIZE[0], POOL_SIZE[1], POOL_RADIUS));
  return new THREE.ExtrudeGeometry(outer, { depth: 0.07, bevelEnabled: false });
}

// Deck slab with the pool cut out, so the sunken tile floor is visible
// through the water. Material group 0 = top/bottom faces, 1 = extrude sides.
function deckGeometry(): THREE.ExtrudeGeometry {
  const outer = rrAt(0, 0, 16, 9.6, 0.4);
  outer.holes.push(
    rrAt(POOL_POS[0], -POOL_POS[1], POOL_SIZE[0], POOL_SIZE[1], POOL_RADIUS),
  );
  return new THREE.ExtrudeGeometry(outer, { depth: 0.25, bevelEnabled: false });
}

// Basin walls: a vertical ring from the waterline down past the deepest point
// of the 4'-5'-4' floor (the opaque floor hides the excess at the ends). Inset
// a hair inside the deck cutout so the liner faces never z-fight the deck.
function wallsGeometry(): THREE.ExtrudeGeometry {
  const outer = rrAt(0, 0, POOL_SIZE[0] - 0.02, POOL_SIZE[1] - 0.02, POOL_RADIUS - 0.01);
  outer.holes.push(
    rrAt(0, 0, POOL_SIZE[0] - 0.16, POOL_SIZE[1] - 0.16, POOL_RADIUS - 0.08),
  );
  return new THREE.ExtrudeGeometry(outer, { depth: 1.8, bevelEnabled: false });
}

// The walls carry the same procedural tile liner as the floor: tiling plane
// picked per-fragment by the dominant wall direction, darkening with depth.
const WALL_VERT = /* glsl */ `
varying vec3 vPos;
varying vec3 vNorm;
void main() {
  vPos = position;
  vNorm = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WALL_FRAG = /* glsl */ `
varying vec3 vPos;
varying vec3 vNorm;
float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
void main() {
  // shape space: x/y are plan coords, z runs bottom (0) to waterline (1.8)
  vec2 tp = (abs(vNorm.x) > abs(vNorm.y)
    ? vec2(vPos.y, vPos.z)
    : vec2(vPos.x, vPos.z)) / 0.42;
  vec2 cell = floor(tp);
  vec2 f = abs(fract(tp) - 0.5);
  vec3 tile = mix(vec3(0.75, 0.88, 0.90), vec3(0.56, 0.76, 0.81), hash21(cell) * 0.7);
  vec2 aa = fwidth(tp) * 1.2;
  vec2 gs = smoothstep(vec2(0.465) - aa, vec2(0.465), f);
  vec3 base = mix(tile, vec3(0.90, 0.93, 0.94), max(gs.x, gs.y));
  float depth = clamp(1.0 - vPos.z / 1.8, 0.0, 1.0);
  vec3 color = base * vec3(0.62, 0.88, 0.98);
  color *= mix(1.0, 0.6, depth);
  gl_FragColor = vec4(color, 1.0);
}
`;

export function PoolScene({ scene }: { scene: SceneState }) {
  const coping = React.useMemo(copingGeometry, []);
  const deck = React.useMemo(deckGeometry, []);
  const walls = React.useMemo(wallsGeometry, []);
  const deckMats = React.useMemo(
    () => [
      new THREE.MeshStandardMaterial({ color: "#e0dcd3", roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: "#b9d4d9", roughness: 0.9 }),
    ],
    [],
  );
  return (
    <group position={[0, -0.6, 0]}>
      <CameraRig />
      <hemisphereLight args={["#cfe8f5", "#e8e0d0", 0.75]} />
      <directionalLight position={[6, 10, 4]} intensity={1.5} color="#fff4e4" />

      {/* concrete deck with the pool basin cut out */}
      <mesh
        geometry={deck}
        material={deckMats}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.25, 0]}
      />
      {/* tile-linered basin walls from the waterline down to the floor */}
      <mesh
        geometry={walls}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[POOL_POS[0], -1.75, POOL_POS[1]]}
      >
        <shaderMaterial vertexShader={WALL_VERT} fragmentShader={WALL_FRAG} />
      </mesh>

      {/* pool: white coping ring around the sunken water sheet */}
      <mesh
        geometry={coping}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[POOL_POS[0], 0.005, POOL_POS[1]]}
      >
        <meshStandardMaterial color="#efece3" roughness={0.9} />
      </mesh>
      <Water
        size={POOL_SIZE}
        radius={POOL_RADIUS}
        flow={scene.poolOn ? scene.flow : 0}
        position={[POOL_POS[0], 0.055, POOL_POS[1]]}
      />

      {/* equipment pad slab */}
      <mesh position={[6.15, 0.04, 2.45]}>
        <boxGeometry args={[1.9, 0.08, 4.0]} />
        <meshStandardMaterial color="#d6d2c8" roughness={0.95} />
      </mesh>

      {/* skimmer mouth in the pool wall at the waterline, below the lid */}
      <mesh position={[1.7, -0.02, POOL_POS[1] + POOL_SIZE[1] / 2 - 0.02]}>
        <boxGeometry args={[0.5, 0.14, 0.08]} />
        <meshStandardMaterial color="#2e3a40" roughness={0.8} />
      </mesh>
      {/* skimmer lid on the deck at the pool's front-right — the suction line
          runs underground from here to the pump */}
      <mesh position={[1.7, 0.02, 3.7]}>
        <cylinderGeometry args={[0.22, 0.22, 0.035, 20]} />
        <meshStandardMaterial color="#d8d0bc" roughness={0.9} />
      </mesh>
      <mesh position={[1.7, 0.04, 3.7]}>
        <cylinderGeometry args={[0.15, 0.15, 0.01, 20]} />
        <meshStandardMaterial color="#c2b9a3" roughness={0.9} />
      </mesh>

      <Pipes scene={scene} />
      <Equipment scene={scene} />

      {scene.poolTemp == null ? null : (
        <Html center position={[POOL_POS[0], 0.55, POOL_POS[1]]}>
          <div className="text-sm font-medium text-white/90 drop-shadow-sm">
            {Math.round(scene.poolTemp)}°
          </div>
        </Html>
      )}
    </group>
  );
}
