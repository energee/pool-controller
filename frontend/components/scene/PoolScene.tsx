// The scene graph for the pool system card: lighting, deck slab, and (in later
// tasks) basins, equipment, and pipes. Pure presentation of a SceneState.
import { Html, Sparkles } from "@react-three/drei";

import type { SceneState } from "../../lib/scene";
import { Equipment } from "./Equipment";
import { Water } from "./Water";

export function PoolScene({ scene }: { scene: SceneState }) {
  return (
    <group position={[0, -0.6, 0]}>
      <ambientLight intensity={0.75} />
      <directionalLight position={[5, 10, 3]} intensity={1.2} />
      {/* deck slab the whole system sits on */}
      <mesh position={[0, -0.125, 0]}>
        <boxGeometry args={[13, 0.25, 7.4]} />
        <meshStandardMaterial color="#9aa6b2" />
      </mesh>
      <mesh position={[-2.6, 0.45, 1.1]}>
        <boxGeometry args={[6.6, 0.9, 3.8]} />
        <meshStandardMaterial color="#155e86" />
      </mesh>
      <Water
        shape="rect"
        size={[6.2, 3.4]}
        flow={scene.poolOn ? scene.flow : 0}
        position={[-2.6, 0.82, 1.1]}
      />
      <mesh position={[2.6, 0.55, 2.0]}>
        <cylinderGeometry args={[1.15, 1.15, 1.1, 48]} />
        <meshStandardMaterial color="#155e86" />
      </mesh>
      <Water
        shape="round"
        size={[1.0, 0]}
        flow={scene.spaOn ? scene.flow : 0}
        position={[2.6, 1.02, 2.0]}
      />
      <Equipment scene={scene} />
      {scene.spaOn && scene.flow > 0 ? (
        <Sparkles
          count={30}
          size={2.5}
          color="#cfeefb"
          speed={0.6 + scene.flow}
          scale={[1.6, 0.9, 1.6]}
          position={[2.6, 1.15, 2.0]}
        />
      ) : null}
      {scene.poolTemp == null ? null : (
        <Html center position={[-2.6, 1.6, 1.1]}>
          <div className="text-sm font-medium text-foreground/85">
            {Math.round(scene.poolTemp)}°
          </div>
        </Html>
      )}
      {scene.spaTemp == null ? null : (
        <Html center position={[2.6, 1.9, 2.0]}>
          <div className="text-sm font-medium text-foreground/85">
            {Math.round(scene.spaTemp)}°
          </div>
        </Html>
      )}
    </group>
  );
}
