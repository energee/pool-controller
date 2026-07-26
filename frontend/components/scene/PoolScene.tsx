// The scene graph for the pool system card, styled after a real backyard pool:
// a rounded-rect turquoise pool sunk into a light concrete deck with white
// coping, a dark hot-tub spa, and the equipment pad + plumbing beside them.
// Pure presentation of a SceneState; drag/wheel orbits around the pool.
import * as React from "react";
import { Html, OrbitControls, Sparkles } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

import type { SceneState } from "../../lib/scene";
import { Equipment } from "./Equipment";
import { Pipes } from "./Pipes";
import { Water } from "./Water";

// Pool footprint: rounded rect centred at [-1.2, 0.6], long axis X.
const POOL_POS: [number, number] = [-1.2, 0.6];
const POOL_SIZE: [number, number] = [7.6, 3.9];
const POOL_RADIUS = 1.2;
const SPA_POS: [number, number] = [4.3, 2.5];
const CAM_POS: [number, number, number] = [6.4, 5.4, 9.4];
const CAM_TARGET: [number, number, number] = [0.3, -0.85, 0.2];

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

// Basin walls: a thin vertical ring from under the deck down to the floor.
function wallsGeometry(): THREE.ExtrudeGeometry {
  const outer = rrAt(0, 0, POOL_SIZE[0], POOL_SIZE[1], POOL_RADIUS);
  outer.holes.push(
    rrAt(0, 0, POOL_SIZE[0] - 0.12, POOL_SIZE[1] - 0.12, POOL_RADIUS - 0.06),
  );
  return new THREE.ExtrudeGeometry(outer, { depth: 0.62, bevelEnabled: false });
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
        position={[POOL_POS[0], -0.87, POOL_POS[1]]}
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

      {/* spa: hollow dark hot tub — an open double-sided shell so the water
          surface has a lit interior floor (Water's floor mesh) beneath it */}
      <group position={[SPA_POS[0], 0, SPA_POS[1]]}>
        <mesh position={[0, 0.39, 0]}>
          <cylinderGeometry args={[1.08, 1.02, 0.78, 24, 1, true]} />
          <meshStandardMaterial
            color="#4a5058"
            roughness={0.7}
            side={THREE.DoubleSide}
          />
        </mesh>
        <mesh position={[0, 0.78, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.0, 0.08, 10, 32]} />
          <meshStandardMaterial color="#5d646d" roughness={0.6} />
        </mesh>
        {/* four inlet nozzles on the wall (matching the sim's jet sites) and
            the floor-drain exit at the bottom center */}
        {[1, 3, 5, 7].map((n) => (
          <group key={n} rotation={[0, (n * Math.PI) / 4, 0]}>
            <mesh position={[0.85, 0.66, 0]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.055, 0.055, 0.16, 12]} />
              <meshStandardMaterial color="#cfd6db" roughness={0.5} />
            </mesh>
          </group>
        ))}
        <mesh position={[0, 0.486, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.15, 24]} />
          <meshStandardMaterial color="#7d949c" roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.488, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.1, 24]} />
          <meshStandardMaterial color="#3f565e" roughness={0.7} />
        </mesh>
        <Water
          variant="spa"
          size={[1.9, 1.9]}
          radius={0.95}
          flow={scene.spaOn ? scene.flow : 0}
          position={[0, 0.83, 0]}
          shallow="#7fcfe0"
          deep="#1d7391"
        />
        {scene.spaOn && scene.flow > 0 ? (
          <Sparkles
            count={30}
            size={2.5}
            color="#cfeefb"
            speed={0.6 + scene.flow}
            scale={[1.5, 0.7, 1.5]}
            position={[0, 0.95, 0]}
          />
        ) : null}
      </group>

      {/* equipment pad slab */}
      <mesh position={[5.15, 0.04, -2.2]}>
        <boxGeometry args={[4.4, 0.08, 1.6]} />
        <meshStandardMaterial color="#d6d2c8" roughness={0.95} />
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
      {scene.spaTemp == null ? null : (
        <Html center position={[SPA_POS[0], 1.35, SPA_POS[1]]}>
          <div className="text-sm font-medium text-white/90 drop-shadow-sm">
            {Math.round(scene.spaTemp)}°
          </div>
        </Html>
      )}
    </group>
  );
}
