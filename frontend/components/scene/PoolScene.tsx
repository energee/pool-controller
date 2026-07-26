// The scene graph for the pool system card: lighting, deck slab, and (in later
// tasks) basins, equipment, and pipes. Pure presentation of a SceneState.
import type { SceneState } from "../../lib/scene";

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
    </group>
  );
}
