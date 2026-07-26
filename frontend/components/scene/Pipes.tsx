// Schematic pool-system plumbing: solid pipe runs with state-gated dashed
// overlays that animate water from active suction branches toward the returns.
import * as React from "react";
import { Line, Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import type { Line2, LineMaterial, LineSegments2 } from "three-stdlib";

import type { SceneState } from "../../lib/scene";

type Point = [number, number, number];

function PipeRun({
  points,
  active,
  flow,
}: {
  points: Point[];
  active: boolean;
  flow: number;
}) {
  const overlay = React.useRef<Line2 | LineSegments2>(null);

  useFrame((_, dt) => {
    const material = overlay.current?.material as LineMaterial | undefined;
    if (material) material.dashOffset -= dt * 1.5 * flow;
  });

  return (
    <>
      <Line points={points} lineWidth={6} color="#77808c" />
      <Line
        ref={overlay}
        points={points}
        lineWidth={2.5}
        color="#4fc3f7"
        dashed
        dashSize={0.18}
        gapSize={0.16}
        visible={active && flow > 0}
      />
    </>
  );
}

const suctionPool: Point[] = [
  [-2.6, 0.12, -0.8],
  [-2.6, 0.12, -1.6],
  [0.2, 0.12, -1.6],
  [0.6, 0.12, -2.0],
];

const suctionSpa: Point[] = [
  [2.6, 0.12, 0.85],
  [2.6, 0.12, -1.2],
  [1.0, 0.12, -1.2],
  [0.6, 0.12, -2.0],
];

const mainRun: Point[] = [
  [0.6, 0.12, -2.3],
  [2.0, 0.12, -2.3],
  [3.5, 0.12, -2.3],
  [4.8, 0.12, -2.3],
];

const returnPool: Point[] = [
  [4.8, 0.12, -2.0],
  [5.3, 0.12, -1.4],
  [-5.4, 0.12, -1.4],
  [-5.4, 0.12, -0.8],
  [-4.5, 0.12, -0.8],
];

const returnSpa: Point[] = [
  [4.8, 0.12, -2.0],
  [3.6, 0.12, -0.4],
  [2.6, 0.12, 0.85],
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

      <mesh position={[0.6, 0.12, -2.0]}>
        <cylinderGeometry args={[0.12, 0.12, 0.2, 16]} />
        <meshStandardMaterial color="#48515c" />
      </mesh>
      <mesh position={[4.8, 0.12, -2.0]}>
        <cylinderGeometry args={[0.12, 0.12, 0.2, 16]} />
        <meshStandardMaterial color="#48515c" />
      </mesh>

      {scene.chlorPct > 0 && scene.flow > 0 ? (
        <Sparkles
          count={10}
          size={1.5}
          color="#5eead4"
          scale={[1.2, 0.4, 0.7]}
          position={[4.9, 0.35, -1.9]}
        />
      ) : null}
    </group>
  );
}
