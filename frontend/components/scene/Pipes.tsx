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

// Waypoints (y=0.1 ground runs), matching the real equipment room: heater on
// the west end of the pad, filter center, pump east; the IntelliChlor lies
// low in front near the heater. Flow: pool -> pump -> filter -> heater ->
// cell -> return inlet.
const suctionPool: Point[] = [
  [3.05, 0.1, 1.9],
  [3.6, 0.1, 2.5],
  [4.6, 0.1, 2.9],
  [5.45, 0.1, 3.15],
  [5.63, 0.23, 3.3],
];

// Pump discharge (top stub) runs high back west to the filter's upper union.
const pumpToFilter: Point[] = [
  [6.07, 0.52, 3.3],
  [5.8, 0.47, 3.4],
  [5.45, 0.34, 3.34],
  [5.23, 0.32, 3.3],
];

// Filter's lower union drops to a floor run past the heater's front and into
// the cell's east union.
const filterToCell: Point[] = [
  [5.23, 0.18, 3.3],
  [5.42, 0.12, 3.5],
  [4.9, 0.1, 3.64],
  [4.05, 0.1, 3.64],
  [3.82, 0.14, 3.6],
  [3.66, 0.22, 3.55],
];

// Out of the cell's west union and along the deck edge to the return inlet.
const returnPool: Point[] = [
  [2.94, 0.22, 3.55],
  [2.4, 0.14, 3.95],
  [1.5, 0.1, 4.15],
  [0.9, 0.1, 3.9],
  [0.9, 0.1, 3.15],
];

export function Pipes({ scene }: { scene: SceneState }) {
  return (
    <group>
      <PipeRun points={suctionPool} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={pumpToFilter} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={filterToCell} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={returnPool} active={scene.poolOn} flow={scene.flow} />

      {scene.chlorPct > 0 && scene.flow > 0 ? (
        <Sparkles
          count={10}
          size={1.5}
          color="#5eead4"
          scale={[0.5, 0.4, 1.6]}
          position={[3.1, 0.35, 3.6]}
        />
      ) : null}
    </group>
  );
}
