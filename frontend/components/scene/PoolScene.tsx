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

// Pool footprint: a 16x32 ft (2:1) rounded rect at ~2.54 ft/wu, centred at
// [-2.5, 0.2] — the pool nearly fills the deck, like the real enclosure.
const POOL_POS: [number, number] = [-2.5, 0.2];
const POOL_SIZE: [number, number] = [12.6, 6.3];
const POOL_RADIUS = 1.2;
// Stair bay jutting out of the pool's west end (like the real fiberglass
// step alcove): [depth outward, width along the end].
const BAY: [number, number] = [1.4, 3.4];
const CAM_POS: [number, number, number] = [8.8, 7.6, 12.6];
const CAM_TARGET: [number, number, number] = [-0.8, -1.15, 0.1];

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

// Rounded-rect path centred at (cx, cy) in shape space, optionally with a
// rectangular stair bay protruding from the west (-x) edge (bay = [depth,
// width]). NOTE: these shapes are rendered rotated -PI/2 about X, which maps
// shape +y to world -z — so a hole at world z = +Z is built at cy = -Z.
function rrAt(
  cx: number,
  cy: number,
  w: number,
  h: number,
  r: number,
  bay?: [number, number],
): THREE.Shape {
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
  if (bay) {
    // descend the west edge, detouring around the protruding bay
    const [bd, bw] = bay;
    s.lineTo(x, cy + bw / 2);
    s.lineTo(x - bd, cy + bw / 2);
    s.lineTo(x - bd, cy - bw / 2);
    s.lineTo(x, cy - bw / 2);
  }
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, (3 * Math.PI) / 2, false);
  return s;
}

// Deck slab with the pool cut out, so the sunken tile floor is visible
// through the water. Material group 0 = top/bottom faces, 1 = extrude sides.
function deckGeometry(): THREE.ExtrudeGeometry {
  // Extra ground west of the pool (stairs side): deck spans x -11..8.
  const outer = rrAt(-1.5, 0, 19, 9.6, 0.4);
  outer.holes.push(
    rrAt(POOL_POS[0], -POOL_POS[1], POOL_SIZE[0], POOL_SIZE[1], POOL_RADIUS, BAY),
  );
  return new THREE.ExtrudeGeometry(outer, { depth: 2.2, bevelEnabled: false });
}

// Basin walls: a vertical ring from the waterline down past the deepest point
// of the 4'-5'-4' floor (the opaque floor hides the excess at the ends). Inset
// a hair inside the deck cutout so the liner faces never z-fight the deck.
function wallsGeometry(): THREE.ExtrudeGeometry {
  // 0.03+ clearance from the deck's cut faces on the outside and from the
  // white stair shell on the inside — near-parallel faces any closer shimmer.
  const outer = rrAt(0, 0, POOL_SIZE[0] - 0.06, POOL_SIZE[1] - 0.06, POOL_RADIUS - 0.03, [
    BAY[0] - 0.03,
    BAY[1] - 0.06,
  ]);
  outer.holes.push(
    rrAt(0, 0, POOL_SIZE[0] - 0.2, POOL_SIZE[1] - 0.2, POOL_RADIUS - 0.1, [
      BAY[0] - 0.1,
      BAY[1] - 0.2,
    ]),
  );
  return new THREE.ExtrudeGeometry(outer, { depth: 2.1, bevelEnabled: false });
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
  // Stair bay (west of the pool proper): white fiberglass shell, no liner.
  // -6.1 = pool half-width 6.3 minus the wall inset margin.
  if (vPos.x < -6.1) {
    float dpt = clamp(1.0 - vPos.z / 2.1, 0.0, 1.0);
    gl_FragColor = vec4(vec3(0.95, 0.94, 0.91) * mix(1.0, 0.82, dpt), 1.0);
    return;
  }
  // shape space: x/y are plan coords, z runs bottom (0) to waterline (2.1)
  vec2 tp = abs(vNorm.x) > abs(vNorm.y)
    ? vec2(vPos.y, vPos.z)
    : vec2(vPos.x, vPos.z);
  // speckled vinyl liner, matching the floor
  float sp = hash21(floor(tp * 22.0));
  float fleck = step(0.82, hash21(floor(tp * 22.0) + 7.3));
  vec3 base = mix(vec3(0.62, 0.82, 0.90), vec3(0.42, 0.68, 0.82), 0.35 * sp);
  base = mix(base, vec3(0.30, 0.55, 0.72), fleck * 0.6);
  // decorative border band at the waterline: navy with a light diamond motif
  float band = smoothstep(1.78, 1.84, vPos.z);
  float dia = smoothstep(0.55, 0.35,
    abs(fract(tp.x * 2.2) - 0.5) + abs(fract((vPos.z - 1.84) * 3.2) - 0.5));
  vec3 border = mix(vec3(0.16, 0.35, 0.55), vec3(0.78, 0.88, 0.94), dia * 0.8);
  base = mix(base, border, band);
  float depth = clamp(1.0 - vPos.z / 2.1, 0.0, 1.0);
  vec3 color = base * vec3(0.72, 0.92, 1.0);
  color *= mix(1.0, 0.62, depth);
  gl_FragColor = vec4(color, 1.0);
}
`;

export function PoolScene({ scene }: { scene: SceneState }) {
  const deck = React.useMemo(deckGeometry, []);
  const walls = React.useMemo(wallsGeometry, []);
  const deckMats = React.useMemo(
    () => [
      new THREE.MeshStandardMaterial({ color: "#d9cfbd", roughness: 0.95 }),
      new THREE.MeshStandardMaterial({ color: "#c4b9a5", roughness: 0.9 }),
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
        position={[0, -2.2, 0]}
      />
      {/* molded white stair unit filling the bay: four treads descending from
          the alcove back into the pool, flanked by fiberglass sidewalls */}
      {[0, 1, 2, 3].map((i) => {
        const top = -0.22 - 0.34 * i;
        const h = top + 1.65;
        return (
          <mesh key={i} position={[-9.775 + 0.45 * i, top - h / 2, POOL_POS[1]]}>
            <boxGeometry args={[0.45, h, 3.0]} />
            <meshStandardMaterial color="#f4f3ee" roughness={0.8} />
          </mesh>
        );
      })}
      {[1, -1].map((side) => (
        <mesh key={side} position={[-9.2, -0.83, POOL_POS[1] + side * 1.52]}>
          <boxGeometry args={[1.64, 1.66, 0.12]} />
          <meshStandardMaterial color="#f4f3ee" roughness={0.8} />
        </mesh>
      ))}
      {/* white back panel — the fiberglass shell covers the bay's liner */}
      <mesh position={[-9.99, -0.83, POOL_POS[1]]}>
        <boxGeometry args={[0.14, 1.66, 3.16]} />
        <meshStandardMaterial color="#f4f3ee" roughness={0.8} />
      </mesh>

      {/* tile-linered basin walls from the waterline down to the floor */}
      <mesh
        geometry={walls}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[POOL_POS[0], -2.1, POOL_POS[1]]}
      >
        <shaderMaterial vertexShader={WALL_VERT} fragmentShader={WALL_FRAG} />
      </mesh>

      <Water
        size={POOL_SIZE}
        radius={POOL_RADIUS}
        bay={BAY}
        flow={scene.poolOn ? scene.flow : 0}
        position={[POOL_POS[0], -0.1, POOL_POS[1]]}
      />

      {/* equipment pad slab */}
      <mesh position={[6.15, 0.04, 2.45]}>
        <boxGeometry args={[1.9, 0.08, 4.0]} />
        <meshStandardMaterial color="#d6d2c8" roughness={0.95} />
      </mesh>

      {/* skimmer mouth in the pool wall at the waterline, below the lid */}
      <mesh position={[1.7, -0.12, POOL_POS[1] + POOL_SIZE[1] / 2 - 0.02]}>
        <boxGeometry args={[0.5, 0.14, 0.08]} />
        <meshStandardMaterial color="#2e3a40" roughness={0.8} />
      </mesh>
      {/* skimmer lid on the deck at the pool's front-right — the suction line
          runs underground from here to the pump */}
      <mesh position={[1.7, 0.02, 4.1]}>
        <cylinderGeometry args={[0.22, 0.22, 0.035, 20]} />
        <meshStandardMaterial color="#d8d0bc" roughness={0.9} />
      </mesh>
      <mesh position={[1.7, 0.04, 4.1]}>
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
