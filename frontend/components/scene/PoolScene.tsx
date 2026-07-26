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

// Pool footprint: a 16x32 ft (2:1) rounded rect at ~3.33 ft/wu, centred at
// [-1.9, 0.6] with the long axis on X.
const POOL_POS: [number, number] = [-1.9, 0.6];
const POOL_SIZE: [number, number] = [9.6, 4.8];
const POOL_RADIUS = 1.2;
const CAM_POS: [number, number, number] = [7.9, 6.7, 11.3];
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
      enablePan={false}
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

// Basin walls: a thin vertical ring from under the deck down past the deepest
// point of the 4'-5'-4' floor (the opaque floor hides the excess at the ends).
function wallsGeometry(): THREE.ExtrudeGeometry {
  const outer = rrAt(0, 0, POOL_SIZE[0], POOL_SIZE[1], POOL_RADIUS);
  outer.holes.push(
    rrAt(0, 0, POOL_SIZE[0] - 0.12, POOL_SIZE[1] - 0.12, POOL_RADIUS - 0.06),
  );
  return new THREE.ExtrudeGeometry(outer, { depth: 1.26, bevelEnabled: false });
}

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
      {/* plaster basin walls from the deck underside down to the tile floor */}
      <mesh
        geometry={walls}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[POOL_POS[0], -1.51, POOL_POS[1]]}
      >
        <meshStandardMaterial color="#b9d4d9" roughness={0.9} />
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

      {/* skimmer lid on the deck at the pool's front-left — the suction line
          runs underground from here to the pump */}
      <mesh position={[-5.6, 0.02, 3.75]}>
        <cylinderGeometry args={[0.22, 0.22, 0.035, 20]} />
        <meshStandardMaterial color="#d8d0bc" roughness={0.9} />
      </mesh>
      <mesh position={[-5.6, 0.04, 3.75]}>
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
