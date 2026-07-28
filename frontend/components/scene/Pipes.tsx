// Schematic pool-system plumbing as real 3D tubes: PVC-gray pipe runs with a
// striped overlay tube whose texture scrolls to show water moving from the
// pool suction through the equipment and back to the return inlet.
import * as React from "react";
import { Sparkles } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { SceneState } from "../../lib/scene";
import { PAD } from "./layout";

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
  // hot/cold swaps rebuild the texture — release the old one, or a dashboard
  // left open leaks a GL texture per heater cycle.
  React.useEffect(() => () => texture.dispose(), [texture]);

  useFrame((_, dt) => {
    if (stripes.current?.map) stripes.current.map.offset.x -= dt * 2.5 * flow;
  });

  return (
    <group>
      <mesh renderOrder={ghost ? 5 : 0}>
        <tubeGeometry args={[curve, 24, 0.06, 6, false]} />
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
        <tubeGeometry args={[curve, 24, 0.09, 6, false]} />
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
// The pump faces motor-to-pool, so its pot/suction port sits on the filter
// side: the buried line runs past the pump and rises at z 2.75 to meet it.
const suctionPool: Point[] = [
  [6.3, -0.12, 2.75],
  [6.3, 0.23, 2.75],
  [6.3, 0.23, 3.01],
];

// Underground (ghosted): front-RIGHT skimmer across to the pump riser.
const undergroundSuction: Point[] = [
  [1.7, -0.05, 4.1],
  [1.7, -0.45, 4.15],
  [1.7, -0.45, 4.3],
  [6.75, -0.45, 4.25],
  [6.75, -0.45, 2.75],
  [6.3, -0.45, 2.75],
  [6.3, -0.12, 2.75],
];

// Underground (ghosted): from the cell's drop, around the pool's east end and
// along the front of the deck to the jet inlet at the pool's FRONT-LEFT.
const undergroundReturn: Point[] = [
  [5.05, -0.12, 1.35],
  [5.05, -0.45, 1.5],
  [5.05, -0.45, 3.9],
  [-5.33, -0.45, 3.95],
  [-5.33, -0.45, 3.55],
  [-5.33, -0.2, 3.4],
];

// Pump discharge: up, over, along, and down into the filter's upper union.
const pumpToFilter: Point[] = [
  [6.3, 0.52, 3.47],
  [6.3, 0.66, 3.47],
  [5.8, 0.66, 3.47],
  [5.8, 0.66, 2.4],
  [5.8, 0.32, 2.4],
  [6.06, 0.32, 2.4],
];

// Filter's lower union runs down the pad's east edge and enters the heater's
// EAST face — the side its front panel already faces. Keeping this leg east of
// the heater leaves the west lane (x ~5.85) free for the salt cell.
const filterToHeater: Point[] = [
  [6.06, 0.18, 2.4],
  [5.85, 0.18, 2.4],
  [5.85, 0.1, 2.15],
  [6.85, 0.1, 2.15],
  [6.85, 0.1, 1.32],
  [6.62, 0.18, 1.32],
];

// Straight out of the heater's west face into the cell's EAST union — the two
// sit inline, so this is a coupling, not a run. It starts inside the heater
// body so the tube reads as emerging from it rather than floating.
const heaterToCell: Point[] = [
  [6.12, 0.22, 1.35],
  [5.91, 0.22, 1.35],
];

// Out of the cell's WEST union and straight down off the pad's edge
// (continues as the ghosted return run to the front-left jet).
const returnPool: Point[] = [
  [5.19, 0.22, 1.35],
  [5.05, 0.22, 1.35],
  [5.05, -0.12, 1.35],
];

export function Pipes({ scene }: { scene: SceneState }) {
  // Every run carries pool flow; only ghost/hot vary.
  const run = { active: scene.poolOn, flow: scene.flow };
  return (
    <group>
      <PipeRun points={suctionPool} {...run} />
      <PipeRun
        points={undergroundSuction}
        {...run}
        ghost
      />
      <PipeRun
        points={undergroundReturn}
        {...run}
        ghost
        hot={scene.heaterOn}
      />
      <PipeRun points={pumpToFilter} {...run} />
      <PipeRun points={filterToHeater} {...run} />
      <PipeRun points={heaterToCell} {...run} hot={scene.heaterOn} />
      <PipeRun points={returnPool} {...run} hot={scene.heaterOn} />

      {scene.chlorPct > 0 && scene.flow > 0 ? (
        <Sparkles
          count={10}
          size={1.5}
          color="#5eead4"
          scale={[0.5, 0.4, 1.6]}
          position={[PAD.cell[0], 0.35, PAD.cell[1]]}
        />
      ) : null}
    </group>
  );
}
