// Schematic pool-system plumbing as real 3D tubes: PVC-gray pipe runs with a
// striped overlay tube whose texture scrolls to show water moving from the
// active suction branch through the equipment and back to the returns.
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

// Waypoints (y=0.1 ground runs). Pool sits around [-1.2, z 0.6]; the spa tub at
// [3.6, z 2.3]; the equipment pad along z=-2.2 east of the pool.
const suctionPool: Point[] = [
  [1.8, 0.1, -1.5],
  [2.4, 0.1, -1.9],
  [3.2, 0.1, -2.2],
  [3.6, 0.1, -2.2],
];

const suctionSpa: Point[] = [
  [4.3, 0.1, 1.35],
  [3.6, 0.1, 0.2],
  [3.3, 0.1, -1.6],
  [3.6, 0.1, -2.2],
];

const mainRun: Point[] = [
  [3.6, 0.1, -2.2],
  [3.9, 0.1, -1.9],
  [6.3, 0.1, -1.9],
  [6.7, 0.1, -2.2],
];

const returnPool: Point[] = [
  [6.7, 0.1, -2.2],
  [7.1, 0.1, -1.2],
  [7.1, 0.1, 3.9],
  [1.0, 0.1, 3.9],
  [0.2, 0.1, 2.85],
];

const returnSpa: Point[] = [
  [7.1, 0.1, 2.5],
  [6.2, 0.1, 2.5],
  [5.5, 0.1, 2.5],
];

export function Pipes({ scene }: { scene: SceneState }) {
  return (
    <group>
      <PipeRun points={suctionPool} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={suctionSpa} active={scene.spaOn} flow={scene.flow} />
      <PipeRun
        points={mainRun}
        active={scene.poolOn || scene.spaOn}
        flow={scene.flow}
      />
      <PipeRun points={returnPool} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={returnSpa} active={scene.spaOn} flow={scene.flow} />

      {/* valve tees: suction merge at the pump, return split off the main */}
      <mesh position={[3.6, 0.1, -2.2]}>
        <cylinderGeometry args={[0.13, 0.13, 0.22, 16]} />
        <meshStandardMaterial color="#5b636d" />
      </mesh>
      <mesh position={[7.1, 0.1, 2.5]}>
        <cylinderGeometry args={[0.13, 0.13, 0.22, 16]} />
        <meshStandardMaterial color="#5b636d" />
      </mesh>

      {scene.chlorPct > 0 && scene.flow > 0 ? (
        <Sparkles
          count={10}
          size={1.5}
          color="#5eead4"
          scale={[0.5, 0.4, 1.6]}
          position={[7.1, 0.3, -0.5]}
        />
      ) : null}
    </group>
  );
}
