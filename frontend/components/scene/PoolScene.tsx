// The scene graph for the pool system card, styled after a real backyard pool:
// a 16x32 ft vinyl-lined pool sunk flush into a concrete deck, with a molded
// stair bay at its west end and the equipment pad + plumbing beside it.
// Pure presentation of a SceneState; drag/wheel orbits around the pool.
import * as React from "react";
import { Html, OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

import type { SceneState } from "../../lib/scene";
import { Equipment } from "./Equipment";
import { LINER_GLSL } from "./glsl";
import {
  BAY,
  BAY_X,
  POOL_POS,
  POOL_RADIUS,
  POOL_SIZE,
  SKIMMER,
  SUN,
  WALL_DEPTH,
  WATER_Y,
} from "./layout";
import { Pipes } from "./Pipes";
import { Water } from "./Water";

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
  return new THREE.ExtrudeGeometry(outer, { depth: WALL_DEPTH, bevelEnabled: false });
}

// The walls carry the same speckled liner as the floor (tiling plane picked
// per-fragment by the dominant wall direction, darkening with depth), except
// inside the stair bay, which is molded white fiberglass.
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
uniform float uBayEdgeX; // walls west of this are the stair bay's shell
uniform float uDepth;    // wall height: z runs bottom (0) to waterline (uDepth)
varying vec3 vPos;
varying vec3 vNorm;
${LINER_GLSL}
void main() {
  float depth = clamp(1.0 - vPos.z / uDepth, 0.0, 1.0);
  if (vPos.x < uBayEdgeX) {
    // Stair bay: molded white fiberglass shell, no liner.
    gl_FragColor = vec4(vec3(0.95, 0.94, 0.91) * mix(1.0, 0.82, depth), 1.0);
    return;
  }
  // shape space: x/y are plan coords, z runs bottom to the waterline
  vec2 tp = abs(vNorm.x) > abs(vNorm.y)
    ? vec2(vPos.y, vPos.z)
    : vec2(vPos.x, vPos.z);
  vec3 base = linerColor(tp);
  // decorative border band at the waterline: navy with a light diamond motif
  float bandTop = uDepth - 0.26;
  float band = smoothstep(bandTop - 0.06, bandTop, vPos.z);
  float dia = smoothstep(0.55, 0.35,
    abs(fract(tp.x * 2.2) - 0.5) + abs(fract((vPos.z - bandTop) * 3.2) - 0.5));
  vec3 border = mix(vec3(0.16, 0.35, 0.55), vec3(0.78, 0.88, 0.94), dia * 0.8);
  base = mix(base, border, band);
  vec3 color = base * vec3(0.72, 0.92, 1.0);
  color *= mix(1.0, 0.62, depth);
  gl_FragColor = vec4(color, 1.0);
}
`;

// Wall shader constants derived from the geometry, so a resize can't strand
// the bay's white region or the depth gradient.
const WALL_UNIFORMS = {
  uBayEdgeX: { value: -POOL_SIZE[0] / 2 + 0.2 },
  uDepth: { value: WALL_DEPTH },
};

// The stair unit: four treads descending east out of the bay, flanked by
// sidewalls, with a back panel hiding the bay's liner. All positioned off
// BAY_X so the unit follows the alcove if the pool is resized.
const TREADS = 4;
const TREAD_W = 0.45;
const STAIR_TOP = -0.12; // top tread just under the waterline
const STAIR_BOTTOM = -1.87; // treads/shell extend below the deepest step

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
  // R3F only auto-disposes what it created; geometries and materials passed in
  // as props are ours to release.
  React.useEffect(
    () => () => {
      deck.dispose();
      walls.dispose();
      deckMats.forEach((m) => m.dispose());
    },
    [deck, walls, deckMats],
  );
  return (
    <group position={[0, -0.6, 0]}>
      <CameraRig />
      <hemisphereLight args={["#cfe8f5", "#e8e0d0", 0.75]} />
      <directionalLight position={SUN} intensity={1.5} color="#fff4e4" />

      {/* concrete deck with the pool basin cut out */}
      <mesh
        geometry={deck}
        material={deckMats}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -2.2, 0]}
      />
      {/* molded white stair unit filling the bay: four treads descending from
          the alcove back into the pool, flanked by fiberglass sidewalls */}
      {Array.from({ length: TREADS }, (_, i) => {
        const top = STAIR_TOP - 0.34 * i;
        const h = top - STAIR_BOTTOM;
        return (
          <mesh
            key={i}
            position={[
              BAY_X + TREAD_W * (i + 0.5) + 0.2,
              top - h / 2,
              POOL_POS[1],
            ]}
          >
            <boxGeometry args={[TREAD_W, h, BAY[1] - 0.4]} />
            <meshStandardMaterial color="#f4f3ee" roughness={0.8} />
          </mesh>
        );
      })}
      {[1, -1].map((side) => (
        <mesh
          key={side}
          position={[
            BAY_X + 1.0,
            (STAIR_TOP + STAIR_BOTTOM) / 2,
            POOL_POS[1] + side * (BAY[1] / 2 - 0.18),
          ]}
        >
          <boxGeometry args={[1.64, STAIR_TOP - STAIR_BOTTOM, 0.12]} />
          <meshStandardMaterial color="#f4f3ee" roughness={0.8} />
        </mesh>
      ))}
      {/* white back panel — the fiberglass shell covers the bay's liner */}
      <mesh
        position={[BAY_X + 0.21, (STAIR_TOP + STAIR_BOTTOM) / 2, POOL_POS[1]]}
      >
        <boxGeometry args={[0.14, STAIR_TOP - STAIR_BOTTOM, BAY[1] - 0.24]} />
        <meshStandardMaterial color="#f4f3ee" roughness={0.8} />
      </mesh>

      {/* vinyl-lined basin walls from the waterline down to the floor */}
      <mesh
        geometry={walls}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[POOL_POS[0], -WALL_DEPTH, POOL_POS[1]]}
      >
        <shaderMaterial
          uniforms={WALL_UNIFORMS}
          vertexShader={WALL_VERT}
          fragmentShader={WALL_FRAG}
        />
      </mesh>

      <Water
        size={POOL_SIZE}
        radius={POOL_RADIUS}
        bay={BAY}
        flow={scene.poolOn ? scene.flow : 0}
        position={[POOL_POS[0], WATER_Y, POOL_POS[1]]}
      />

      {/* equipment pad slab */}
      <mesh position={[6.15, 0.04, 2.45]}>
        <boxGeometry args={[1.9, 0.08, 4.0]} />
        <meshStandardMaterial color="#d6d2c8" roughness={0.95} />
      </mesh>

      {/* skimmer mouth in the pool wall at the waterline, below the lid */}
      <mesh position={[SKIMMER[0], -0.12, POOL_POS[1] + POOL_SIZE[1] / 2 - 0.02]}>
        <boxGeometry args={[0.5, 0.14, 0.08]} />
        <meshStandardMaterial color="#2e3a40" roughness={0.8} />
      </mesh>
      {/* skimmer lid on the deck at the pool's front-right — the suction line
          runs underground from here to the pump */}
      <mesh position={[SKIMMER[0], 0.02, SKIMMER[1]]}>
        <cylinderGeometry args={[0.22, 0.22, 0.035, 20]} />
        <meshStandardMaterial color="#d8d0bc" roughness={0.9} />
      </mesh>
      <mesh position={[SKIMMER[0], 0.04, SKIMMER[1]]}>
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
