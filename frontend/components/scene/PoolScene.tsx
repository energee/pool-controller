// The scene graph for the pool system card, styled after a real backyard pool:
// a rounded-rect turquoise pool sunk into a light concrete deck with white
// coping, a dark hot-tub spa, and the equipment pad + plumbing beside them.
// Pure presentation of a SceneState; the camera rig fixes the photo-like view.
import * as React from "react";
import { Html, RoundedBox, Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
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

// Pin the camera every frame: the Canvas camera prop gets re-applied on each
// poll-driven re-render, which would otherwise undo a one-shot lookAt.
function CameraRig() {
  useFrame(({ camera }) => {
    camera.position.set(...CAM_POS);
    camera.lookAt(...CAM_TARGET);
  });
  return null;
}

// Flat rounded-rect ring (outer minus inner) used for the pool coping.
function copingGeometry(): THREE.ExtrudeGeometry {
  const rr = (w: number, h: number, r: number) => {
    const s = new THREE.Shape();
    const x = -w / 2,
      y = -h / 2;
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
  };
  const outer = rr(POOL_SIZE[0] + 0.7, POOL_SIZE[1] + 0.7, POOL_RADIUS + 0.3);
  outer.holes.push(rr(POOL_SIZE[0], POOL_SIZE[1], POOL_RADIUS));
  return new THREE.ExtrudeGeometry(outer, { depth: 0.07, bevelEnabled: false });
}

export function PoolScene({ scene }: { scene: SceneState }) {
  const coping = React.useMemo(copingGeometry, []);
  return (
    <group position={[0, -0.6, 0]}>
      <CameraRig />
      <hemisphereLight args={["#cfe8f5", "#e8e0d0", 0.75]} />
      <directionalLight position={[6, 10, 4]} intensity={1.5} color="#fff4e4" />

      {/* concrete deck */}
      <RoundedBox args={[16, 0.25, 9.6]} radius={0.12} position={[0, -0.125, 0]}>
        <meshStandardMaterial color="#e0dcd3" roughness={0.95} />
      </RoundedBox>

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

      {/* spa: dark hot tub on the deck with its own round water surface */}
      <group position={[SPA_POS[0], 0, SPA_POS[1]]}>
        <mesh position={[0, 0.39, 0]}>
          <cylinderGeometry args={[1.08, 1.02, 0.78, 24]} />
          <meshStandardMaterial color="#4a5058" roughness={0.7} />
        </mesh>
        <mesh position={[0, 0.78, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[1.0, 0.08, 10, 32]} />
          <meshStandardMaterial color="#5d646d" roughness={0.6} />
        </mesh>
        <Water
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
