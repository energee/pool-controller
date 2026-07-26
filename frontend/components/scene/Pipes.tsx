// Schematic pool-system plumbing as real 3D tubes: PVC-gray pipe runs with a
// striped overlay tube whose texture scrolls to show water moving from the
// pool suction through the equipment and back to the return inlet.
import * as React from "react";
import { Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { SceneState } from "../../lib/scene";

type Point = [number, number, number];

// 8x1 texture: half cyan, half transparent -> repeating dashes along the tube.
function makeStripeTexture(): THREE.DataTexture {
  const data = new Uint8Array(8 * 4);
  for (let i = 0; i < 8; i++) {
    const on = i < 4;
    data.set(on ? [79, 195, 247, 255] : [0, 0, 0, 0], i * 4);
  }
  const tex = new THREE.DataTexture(data, 8, 1);
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function PipeRun({
  points,
  active,
  flow,
}: {
  points: Point[];
  active: boolean;
  flow: number;
}) {
  const stripes = React.useRef<THREE.MeshBasicMaterial>(null);
  const { curve, length } = React.useMemo(() => {
    const c = new THREE.CatmullRomCurve3(
      points.map((p) => new THREE.Vector3(...p)),
      false,
      "catmullrom",
      0.05, // low tension: soft elbows without ballooning between waypoints
    );
    return { curve: c, length: c.getLength() };
  }, [points]);
  const texture = React.useMemo(() => {
    const t = makeStripeTexture();
    t.repeat.set(length / 0.7, 1); // one dash+gap every ~0.7 world units
    return t;
  }, [length]);

  useFrame((_, dt) => {
    if (stripes.current?.map) stripes.current.map.offset.x -= dt * 2.5 * flow;
  });

  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 48, 0.06, 10, false]} />
        <meshStandardMaterial color="#aab2bb" roughness={0.6} />
      </mesh>
      <mesh visible={active && flow > 0}>
        <tubeGeometry args={[curve, 48, 0.09, 10, false]} />
        <meshBasicMaterial
          ref={stripes}
          map={texture}
          transparent
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

// The pool runs are buried: only the equipment-pad piping is visible, plus a
// short riser where the suction emerges from the ground into the pump and a
// short drop where the return dives back under the deck after the cell. The
// pool ends are underground — suction from the front-left skimmer, jet inlet
// at the front-right (see Water.tsx / PoolScene.tsx).
const suctionPool: Point[] = [
  [6.3, -0.12, 4.18],
  [6.3, 0.05, 4.12],
  [6.3, 0.24, 4.0],
];

// Pump discharge (top stub) runs back along the pad to the filter's unions.
const pumpToFilter: Point[] = [
  [6.3, 0.52, 3.53],
  [6.4, 0.46, 3.25],
  [6.35, 0.35, 2.82],
  [6.3, 0.32, 2.63],
];

// Filter's lower union drops and runs along the pad's east side into the
// heater (per the owner's schematic: filter feeds the heater directly).
const filterToHeater: Point[] = [
  [6.3, 0.18, 2.63],
  [6.52, 0.12, 2.45],
  [6.74, 0.1, 2.0],
  [6.6, 0.13, 1.75],
  [6.45, 0.18, 1.6],
];

// Out of the heater's pool side into the cell, which sits between the heater
// and the pool.
const heaterToCell: Point[] = [
  [6.02, 0.18, 1.35],
  [5.8, 0.15, 1.1],
  [5.55, 0.22, 0.99],
];

// Out of the cell's front union and underground toward the pool's
// front-right jet inlet.
const returnPool: Point[] = [
  [5.55, 0.22, 1.71],
  [5.5, 0.05, 1.9],
  [5.45, -0.12, 2.0],
];

export function Pipes({ scene }: { scene: SceneState }) {
  return (
    <group>
      <PipeRun points={suctionPool} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={pumpToFilter} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={filterToHeater} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={heaterToCell} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={returnPool} active={scene.poolOn} flow={scene.flow} />

      {scene.chlorPct > 0 && scene.flow > 0 ? (
        <Sparkles
          count={10}
          size={1.5}
          color="#5eead4"
          scale={[0.5, 0.4, 1.6]}
          position={[5.55, 0.35, 1.35]}
        />
      ) : null}
    </group>
  );
}
