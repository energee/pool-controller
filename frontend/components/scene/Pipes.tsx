// Schematic pool-system plumbing as real 3D tubes: PVC-gray pipe runs with a
// striped overlay tube whose texture scrolls to show water moving from the
// pool suction through the equipment and back to the return inlet.
import * as React from "react";
import { Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { SceneState } from "../../lib/scene";

type Point = [number, number, number];

// 8x1 texture: half colored, half transparent -> repeating dashes along the
// tube. Cool cyan for water, warm red past a firing heater.
function makeStripeTexture(rgb: [number, number, number]): THREE.DataTexture {
  const data = new Uint8Array(8 * 4);
  for (let i = 0; i < 8; i++) {
    const on = i < 4;
    data.set(on ? [...rgb, 255] : [0, 0, 0, 0], i * 4);
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
  ghost = false, // underground: drawn x-ray style through the deck
  hot = false, // downstream of a firing heater: red pipe, warm dashes
}: {
  points: Point[];
  active: boolean;
  flow: number;
  ghost?: boolean;
  hot?: boolean;
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
    const t = makeStripeTexture(hot ? [235, 55, 40] : [79, 195, 247]);
    t.repeat.set(length / 0.7, 1); // one dash+gap every ~0.7 world units
    return t;
  }, [length, hot]);

  useFrame((_, dt) => {
    if (stripes.current?.map) stripes.current.map.offset.x -= dt * 2.5 * flow;
  });

  return (
    <group>
      <mesh renderOrder={ghost ? 5 : 0}>
        <tubeGeometry args={[curve, 48, 0.06, 10, false]} />
        {ghost ? (
          <meshBasicMaterial
            color={hot ? "#c23327" : "#9aa2ac"}
            transparent
            opacity={0.3}
            depthTest={false}
            depthWrite={false}
          />
        ) : (
          <meshStandardMaterial color={hot ? "#c23327" : "#aab2bb"} roughness={0.6} />
        )}
      </mesh>
      <mesh visible={active && flow > 0} renderOrder={ghost ? 6 : 0}>
        <tubeGeometry args={[curve, 48, 0.09, 10, false]} />
        <meshBasicMaterial
          ref={stripes}
          map={texture}
          transparent
          opacity={ghost ? 0.55 : 1}
          depthTest={!ghost}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

// The pool runs are buried: only the equipment-pad piping is visible. Runs
// are routed Manhattan-style (axis-aligned segments, right-angle elbows) to
// match the owner's schematic. Flow: pool -> pump -> filter -> heater ->
// cell -> underground to the front-right jet.
const suctionPool: Point[] = [
  [6.3, -0.12, 4.25],
  [6.3, 0.23, 4.25],
  [6.3, 0.23, 3.99],
];

// Underground (ghosted): front-RIGHT skimmer across to the pump riser.
const undergroundSuction: Point[] = [
  [1.7, -0.05, 3.7],
  [1.7, -0.45, 3.75],
  [1.7, -0.45, 4.25],
  [6.3, -0.45, 4.25],
  [6.3, -0.12, 4.25],
];

// Underground (ghosted): from the cell's drop, around the pool's east end and
// along the front of the deck to the jet inlet at the pool's FRONT-LEFT.
const undergroundReturn: Point[] = [
  [5.55, -0.12, 0.75],
  [5.55, -0.45, 0.9],
  [5.55, -0.45, 3.9],
  [-5.33, -0.45, 3.9],
  [-5.33, -0.45, 2.85],
  [-5.33, -0.2, 2.7],
];

// Pump discharge: up, over, along, and down into the filter's upper union.
const pumpToFilter: Point[] = [
  [6.3, 0.52, 3.53],
  [6.3, 0.66, 3.53],
  [5.8, 0.66, 3.53],
  [5.8, 0.66, 2.4],
  [5.8, 0.32, 2.4],
  [6.06, 0.32, 2.4],
];

// Filter's lower union wraps around the heater in a rectangle along the deck
// edge and enters its pool face — the schematic's around-the-outside run.
const filterToHeater: Point[] = [
  [6.06, 0.18, 2.4],
  [5.85, 0.18, 2.4],
  [5.85, 0.1, 2.15],
  [6.85, 0.1, 2.15],
  [6.85, 0.1, 0.7],
  [5.8, 0.1, 0.7],
  [5.8, 0.14, 1.15],
  [6.0, 0.18, 1.15],
];

// Out of the heater's pool face, square around into the cell's front union.
const heaterToCell: Point[] = [
  [6.0, 0.18, 1.6],
  [5.9, 0.18, 1.6],
  [5.9, 0.18, 1.95],
  [5.55, 0.18, 1.95],
  [5.55, 0.22, 1.73],
];

// Out of the cell's back union, straight down underground (continues as the
// ghosted return run to the front-left jet).
const returnPool: Point[] = [
  [5.55, 0.22, 0.99],
  [5.55, 0.22, 0.75],
  [5.55, -0.12, 0.75],
];

export function Pipes({ scene }: { scene: SceneState }) {
  return (
    <group>
      <PipeRun points={suctionPool} active={scene.poolOn} flow={scene.flow} />
      <PipeRun
        points={undergroundSuction}
        active={scene.poolOn}
        flow={scene.flow}
        ghost
      />
      <PipeRun
        points={undergroundReturn}
        active={scene.poolOn}
        flow={scene.flow}
        ghost
        hot={scene.heaterOn}
      />
      <PipeRun points={pumpToFilter} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={filterToHeater} active={scene.poolOn} flow={scene.flow} />
      <PipeRun points={heaterToCell} active={scene.poolOn} flow={scene.flow} hot={scene.heaterOn} />
      <PipeRun points={returnPool} active={scene.poolOn} flow={scene.flow} hot={scene.heaterOn} />

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
