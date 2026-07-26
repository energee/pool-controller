// The scene's live equipment pad: pump, filter, heater, and chlorinator meshes
// with state-driven animation, effects, labels, and read-only hover tooltips.
import * as React from "react";
import { Html, Sparkles, useCursor } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { SceneState } from "../../lib/scene";

type Unit = "pump" | "filter" | "heater" | "chlorinator";

const labelClass = "text-[10px] text-muted-foreground whitespace-nowrap";
const tooltipClass =
  "whitespace-nowrap rounded-md border bg-popover px-2.5 py-1.5 text-xs text-foreground shadow-md";

export function Equipment({ scene }: { scene: SceneState }) {
  const [hovered, setHovered] = React.useState<Unit | null>(null);
  const impeller = React.useRef<THREE.Group>(null);
  const heaterMaterial = React.useRef<THREE.MeshStandardMaterial>(null);
  const chlorMaterial = React.useRef<THREE.MeshStandardMaterial>(null);
  useCursor(hovered !== null);

  useFrame((_, dt) => {
    if (impeller.current && scene.flow > 0) {
      impeller.current.rotation.y += dt * (2 + 10 * scene.flow);
    }
    if (heaterMaterial.current) {
      heaterMaterial.current.emissiveIntensity = THREE.MathUtils.lerp(
        heaterMaterial.current.emissiveIntensity,
        scene.heaterOn ? 0.3 : 0,
        Math.min(dt * 4, 1),
      );
    }
    if (chlorMaterial.current) {
      const target =
        scene.chlorPct > 0 && scene.flow > 0
          ? 0.2 + 0.7 * (scene.chlorPct / 100)
          : 0;
      chlorMaterial.current.emissiveIntensity = THREE.MathUtils.lerp(
        chlorMaterial.current.emissiveIntensity,
        target,
        Math.min(dt * 4, 1),
      );
    }
  });

  const pumpStats = [
    scene.rpm == null ? null : `${scene.rpm} RPM`,
    scene.gpm == null ? null : `${scene.gpm} GPM`,
    scene.watts == null ? null : `${scene.watts} W`,
  ].filter((value): value is string => value !== null);

  const hover = (unit: Unit) => ({
    onPointerOver: (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      setHovered(unit);
    },
    onPointerOut: (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      setHovered(null);
    },
  });

  return (
    <group>
      <group position={[3.6, 0, -2.2]} {...hover("pump")}>
        <mesh position={[0, 0.25, 0]}>
          <cylinderGeometry args={[0.35, 0.35, 0.5, 24]} />
          <meshStandardMaterial color="#637487" />
        </mesh>
        <group ref={impeller} position={[0, 0.54, 0]}>
          {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((rotation) => (
            <mesh key={rotation} rotation={[0, rotation, 0]} position={[0, 0, 0.13]}>
              <boxGeometry args={[0.1, 0.06, 0.3]} />
              <meshStandardMaterial color="#d2dae2" />
            </mesh>
          ))}
        </group>
        <Html center distanceFactor={14} position={[0, -0.16, 0]}>
          <div className={labelClass}>PUMP</div>
        </Html>
        {hovered === "pump" ? (
          <Html center position={[0, 1.05, 0]}>
            <div className={tooltipClass}>
              {pumpStats.length > 0 ? pumpStats.join(" · ") : "no data"}
            </div>
          </Html>
        ) : null}
      </group>

      <group position={[4.6, 0, -2.2]} {...hover("filter")}>
        <mesh position={[0, 0.45, 0]}>
          <cylinderGeometry args={[0.42, 0.42, 0.9, 24]} />
          <meshStandardMaterial color="#aab4be" />
        </mesh>
        <Html center distanceFactor={14} position={[0, -0.16, 0]}>
          <div className={labelClass}>FILTER</div>
        </Html>
        {hovered === "filter" ? (
          <Html center position={[0, 1.2, 0]}>
            <div className={tooltipClass}>Filter</div>
          </Html>
        ) : null}
      </group>

      <group position={[5.7, 0, -2.2]} {...hover("heater")}>
        <mesh position={[0, 0.35, 0]}>
          <boxGeometry args={[1.0, 0.7, 0.8]} />
          <meshStandardMaterial
            ref={heaterMaterial}
            color="#596574"
            emissive="#ff7a45"
            emissiveIntensity={0}
          />
        </mesh>
        {scene.heaterOn ? (
          <Sparkles
            count={8}
            size={1.4}
            scale={[0.5, 0.7, 0.5]}
            position={[0, 1.0, 0]}
            color="#e8edf2"
            speed={0.35}
          />
        ) : null}
        <Html center distanceFactor={14} position={[0, -0.16, 0]}>
          <div className={labelClass}>HEATER</div>
        </Html>
        {hovered === "heater" ? (
          <Html center position={[0, 1.25, 0]}>
            <div className={tooltipClass}>
              Heater {scene.heaterOn ? "ON" : "off"}
            </div>
          </Html>
        ) : null}
      </group>

      <group position={[6.7, 0, -2.2]} {...hover("chlorinator")}>
        <mesh position={[0, 0.3, 0]} rotation={[0, 0, Math.PI / 2]}>
          <capsuleGeometry args={[0.18, 0.7, 8, 16]} />
          <meshStandardMaterial
            ref={chlorMaterial}
            color="#547b7b"
            emissive="#2dd4bf"
            emissiveIntensity={0}
          />
        </mesh>
        <Html center distanceFactor={14} position={[0, -0.16, 0]}>
          <div className={labelClass}>CHLORINATOR</div>
        </Html>
        {hovered === "chlorinator" ? (
          <Html center position={[0, 0.95, 0]}>
            <div className={tooltipClass}>
              {scene.chlorPct}% output
              {scene.saltPpm == null ? "" : ` · ${scene.saltPpm} ppm salt`}
            </div>
          </Html>
        ) : null}
      </group>
    </group>
  );
}
