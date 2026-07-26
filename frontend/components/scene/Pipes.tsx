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

// Waypoints (y=0.1 ground runs). Pool sits around [-1.9, z 0.6]; the
// equipment pad sits front-right at z=3.3.
// Suction from the pool's east corner rises into the pump's white inlet stub.
const suctionPool: Point[] = [
  [3.05, 0.1, 1.9],
  [3.3, 0.1, 2.6],
  [3.38, 0.1, 3.3],
  [3.54, 0.23, 3.3],
];

// Pump discharge (top stub) over to the filter's upper inlet union.
const pumpToFilter: Point[] = [
  [3.97, 0.52, 3.3],
  [4.15, 0.45, 3.38],
  [4.5, 0.32, 3.32],
  [4.73, 0.32, 3.3],
];

// Filter's lower outlet union down and along the pool side of the pad to the
// heater and chlorinator.
const filterToChlor: Point[] = [
  [4.73, 0.18, 3.3],
  [4.55, 0.14, 3.12],
  [4.9, 0.1, 2.95],
  [6.45, 0.1, 2.95],
  [6.58, 0.16, 3.16],
  [6.74, 0.22, 3.3],
];

// Behind the pad and back west to the return inlet on the front edge.
const returnPool: Point[] = [
  [7.46, 0.22, 3.3],
  [7.6, 0.14, 3.75],
  [6.8, 0.1, 4.35],
  [1.6, 0.1, 4.35],
  [0.9, 0.1, 3.9],
  [0.9, 0.1, 3.15],
];

export function Pipes({ scene }: { scene: SceneState }) {
  return (
    <group>
      <PipeRun points={suctionPool} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={pumpToFilter} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={filterToChlor} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={returnPool} active={scene.poolOn} flow={scene.flow} />

      {scene.chlorPct > 0 && scene.flow > 0 ? (
        <Sparkles
          count={10}
          size={1.5}
          color="#5eead4"
          scale={[0.5, 0.4, 1.6]}
          position={[7.25, 0.3, 3.7]}
        />
      ) : null}
    </group>
  );
}
