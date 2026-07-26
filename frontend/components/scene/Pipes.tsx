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

// Pump discharge (top stub) arcs over and into the filter's upper union,
// which faces the pool (west).
const pumpToFilter: Point[] = [
  [6.3, 0.52, 3.53],
  [6.15, 0.46, 3.2],
  [5.85, 0.36, 2.7],
  [5.92, 0.32, 2.48],
  [6.07, 0.32, 2.4],
];

// Filter's lower union wraps AROUND the heater (behind it, along the deck
// edge) and enters from its pool face — the schematic's around-the-outside
// run.
const filterToHeater: Point[] = [
  [6.07, 0.18, 2.4],
  [5.95, 0.14, 2.2],
  [6.3, 0.1, 2.0],
  [6.85, 0.1, 1.8],
  [6.85, 0.1, 0.85],
  [6.4, 0.12, 0.7],
  [6.08, 0.16, 0.95],
  [6.02, 0.18, 1.15],
];

// Out of the heater's pool face (next to the inlet) into the cell, which
// sits between the heater and the pool.
const heaterToCell: Point[] = [
  [6.02, 0.18, 1.6],
  [5.82, 0.15, 1.42],
  [5.62, 0.2, 1.15],
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
