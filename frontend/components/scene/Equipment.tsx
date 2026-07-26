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
  const lcdMaterial = React.useRef<THREE.MeshStandardMaterial>(null);
  const heaterMaterial = React.useRef<THREE.MeshStandardMaterial>(null);
  const chlorMaterial = React.useRef<THREE.MeshStandardMaterial>(null);
  useCursor(hovered !== null);

  useFrame((_, dt) => {
    if (impeller.current && scene.flow > 0) {
      impeller.current.rotation.y += dt * (2 + 10 * scene.flow);
    }
    if (lcdMaterial.current) {
      lcdMaterial.current.emissiveIntensity = THREE.MathUtils.lerp(
        lcdMaterial.current.emissiveIntensity,
        scene.flow > 0 ? 1.2 : 0,
        Math.min(dt * 4, 1),
      );
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
      {/* Pentair SuperFlo VS: almond strainer pot (clear lid, basket spinning
          when running) + volute, white PVC suction/discharge stubs, finned
          motor, and the VS drive box whose LCD lights with flow. Suction
          enters from the west (-x), the motor points east toward the pad. */}
      <group position={[3.6, 0, -2.2]} {...hover("pump")}>
        <mesh position={[0, 0.05, 0]}>
          <boxGeometry args={[0.88, 0.07, 0.34]} />
          <meshStandardMaterial color="#cfc7b2" roughness={0.85} />
        </mesh>
        {/* strainer pot + lobed clamp ring + clear lid */}
        <mesh position={[-0.28, 0.23, 0]}>
          <cylinderGeometry args={[0.155, 0.145, 0.3, 20]} />
          <meshStandardMaterial color="#e9e1cc" roughness={0.75} />
        </mesh>
        <mesh position={[-0.28, 0.39, 0]}>
          <cylinderGeometry args={[0.195, 0.195, 0.05, 8]} />
          <meshStandardMaterial color="#ded5bf" roughness={0.75} />
        </mesh>
        <group ref={impeller} position={[-0.28, 0.36, 0]}>
          {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((rotation) => (
            <mesh key={rotation} rotation={[0, rotation, 0]} position={[0, 0, 0.06]}>
              <boxGeometry args={[0.05, 0.03, 0.11]} />
              <meshStandardMaterial color="#c9bfa6" />
            </mesh>
          ))}
        </group>
        <mesh position={[-0.28, 0.425, 0]}>
          <cylinderGeometry args={[0.125, 0.125, 0.025, 20]} />
          <meshStandardMaterial
            color="#b7cdd6"
            roughness={0.15}
            transparent
            opacity={0.45}
          />
        </mesh>
        {/* white PVC suction stub into the pot */}
        <mesh position={[-0.47, 0.23, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.055, 0.055, 0.16, 12]} />
          <meshStandardMaterial color="#f2f2ee" roughness={0.4} />
        </mesh>
        {/* volute body linking pot to motor */}
        <mesh position={[-0.03, 0.22, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.13, 0.13, 0.28, 16]} />
          <meshStandardMaterial color="#e9e1cc" roughness={0.75} />
        </mesh>
        {/* vertical discharge: union nut + white pipe stub */}
        <mesh position={[-0.03, 0.38, 0]}>
          <cylinderGeometry args={[0.075, 0.075, 0.06, 12]} />
          <meshStandardMaterial color="#ded5bf" roughness={0.75} />
        </mesh>
        <mesh position={[-0.03, 0.49, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 0.16, 12]} />
          <meshStandardMaterial color="#f2f2ee" roughness={0.4} />
        </mesh>
        {/* finned motor can */}
        <mesh position={[0.27, 0.22, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.135, 0.135, 0.36, 20]} />
          <meshStandardMaterial color="#ddd4bf" roughness={0.6} />
        </mesh>
        {/* VS drive box with black keypad + LCD (lit when running) */}
        <mesh position={[0.27, 0.45, 0]}>
          <boxGeometry args={[0.26, 0.18, 0.24]} />
          <meshStandardMaterial color="#e9e1cc" roughness={0.75} />
        </mesh>
        <mesh position={[0.27, 0.545, 0]}>
          <boxGeometry args={[0.15, 0.012, 0.15]} />
          <meshStandardMaterial color="#1c1e20" roughness={0.5} />
        </mesh>
        <mesh position={[0.24, 0.554, -0.03]}>
          <boxGeometry args={[0.06, 0.006, 0.035]} />
          <meshStandardMaterial
            ref={lcdMaterial}
            color="#2a3d47"
            emissive="#7fc4e8"
            emissiveIntensity={0}
          />
        </mesh>
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
