// The scene's live equipment pad: pump, filter, heater, and chlorinator meshes
// with state-driven animation, effects, labels, and read-only hover tooltips.
import * as React from "react";
import { Html, Sparkles, useCursor } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import type { SceneState } from "../../lib/scene";
import { PAD } from "./layout";

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
    // Every glow eases toward its target at the same rate.
    const glow = (
      ref: React.RefObject<THREE.MeshStandardMaterial | null>,
      target: number,
    ) => {
      if (!ref.current) return;
      ref.current.emissiveIntensity = THREE.MathUtils.lerp(
        ref.current.emissiveIntensity,
        target,
        Math.min(dt * 4, 1),
      );
    };
    glow(lcdMaterial, scene.flow > 0 ? 1.2 : 0);
    glow(heaterMaterial, scene.heaterOn ? 0.3 : 0);
    glow(
      chlorMaterial,
      scene.chlorPct > 0 && scene.flow > 0
        ? 0.2 + 0.7 * (scene.chlorPct / 100)
        : 0,
    );
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
      <group position={[PAD.pump[0], 0, PAD.pump[1]]} rotation={[0, Math.PI / 2, 0]} {...hover("pump")}>
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

      {/* Pentair Clean & Clear Plus cartridge filter: tall almond tank with a
          domed lid, black band clamp at the seam, pressure gauge on top, and
          two black inlet/outlet unions facing the pump (the pipes plug in). */}
      <group position={[PAD.filter[0], 0, PAD.filter[1]]} rotation={[0, Math.PI, 0]} {...hover("filter")}>
        <mesh position={[0, 0.07, 0]}>
          <cylinderGeometry args={[0.16, 0.21, 0.14, 20]} />
          <meshStandardMaterial color="#ded5bf" roughness={0.8} />
        </mesh>
        <mesh position={[0, 0.4, 0]}>
          <cylinderGeometry args={[0.19, 0.19, 0.52, 24]} />
          <meshStandardMaterial color="#e9e1cc" roughness={0.75} />
        </mesh>
        <mesh position={[0, 0.66, 0]} scale={[1, 0.75, 1]}>
          <sphereGeometry args={[0.19, 24, 16]} />
          <meshStandardMaterial color="#e9e1cc" roughness={0.75} />
        </mesh>
        <mesh position={[0, 0.55, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.196, 0.028, 10, 28]} />
          <meshStandardMaterial color="#24262a" roughness={0.6} />
        </mesh>
        {/* air-relief stem + pressure gauge */}
        <mesh position={[0, 0.84, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 0.09, 8]} />
          <meshStandardMaterial color="#24262a" roughness={0.6} />
        </mesh>
        <mesh position={[0, 0.92, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.045, 0.045, 0.024, 16]} />
          <meshStandardMaterial color="#24262a" roughness={0.6} />
        </mesh>
        <mesh position={[0, 0.92, 0.014]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.034, 0.034, 0.005, 16]} />
          <meshStandardMaterial color="#eef0f0" roughness={0.4} />
        </mesh>
        {/* inlet (upper) and outlet (lower) unions, facing the pool (forward) */}
        <mesh position={[0.225, 0.32, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.05, 0.05, 0.13, 12]} />
          <meshStandardMaterial color="#1e2023" roughness={0.55} />
        </mesh>
        <mesh position={[0.225, 0.18, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.05, 0.05, 0.13, 12]} />
          <meshStandardMaterial color="#1e2023" roughness={0.55} />
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

      {/* Pentair MasterTemp 400: almond cube with a rounded lid, charcoal
          front panel (glows warm while firing), side louvers, black exhaust
          vent at the top corner, and foot pads. */}
      <group position={[PAD.heater[0], 0, PAD.heater[1]]} rotation={[0, Math.PI / 2, 0]} {...hover("heater")}>
        {[-0.18, 0.18].map((z) => (
          <mesh key={z} position={[0, 0.03, z]}>
            <boxGeometry args={[0.56, 0.06, 0.12]} />
            <meshStandardMaterial color="#ded5bf" roughness={0.85} />
          </mesh>
        ))}
        <mesh position={[0, 0.32, 0]}>
          <boxGeometry args={[0.56, 0.52, 0.56]} />
          <meshStandardMaterial color="#e9e1cc" roughness={0.75} />
        </mesh>
        <mesh position={[0, 0.61, 0]}>
          <boxGeometry args={[0.52, 0.1, 0.52]} />
          <meshStandardMaterial color="#e9e1cc" roughness={0.75} />
        </mesh>
        {/* charcoal front panel — the heaterMaterial emissive lives here */}
        <mesh position={[0, 0.32, 0.285]}>
          <boxGeometry args={[0.46, 0.44, 0.02]} />
          <meshStandardMaterial
            ref={heaterMaterial}
            color="#3c4046"
            emissive="#ff7a45"
            emissiveIntensity={0}
            roughness={0.6}
          />
        </mesh>
        {/* louvered side vent (suggested) */}
        <mesh position={[-0.285, 0.26, 0]}>
          <boxGeometry args={[0.02, 0.3, 0.4]} />
          <meshStandardMaterial color="#d8cfba" roughness={0.9} />
        </mesh>
        {/* black exhaust vent box at the top corner */}
        <mesh position={[-0.32, 0.58, -0.12]}>
          <boxGeometry args={[0.18, 0.18, 0.2]} />
          <meshStandardMaterial color="#202226" roughness={0.6} />
        </mesh>
        {scene.heaterOn ? (
          <Sparkles
            count={8}
            size={1.4}
            scale={[0.5, 0.7, 0.5]}
            position={[-0.32, 0.82, -0.12]}
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

      {/* Pentair IntelliChlor IC40: white ribbed inline cell with a tan label
          panel and black union nuts joining the pipe at both ends; the body
          glows teal while generating. */}
      <group position={[PAD.cell[0], 0, PAD.cell[1]]} rotation={[0, -Math.PI / 2, 0]} {...hover("chlorinator")}>
        <mesh position={[0, 0.22, 0]}>
          <boxGeometry args={[0.44, 0.2, 0.18]} />
          <meshStandardMaterial
            ref={chlorMaterial}
            color="#f0efe9"
            emissive="#2dd4bf"
            emissiveIntensity={0}
            roughness={0.6}
          />
        </mesh>
        <mesh position={[0, 0.33, 0]}>
          <boxGeometry args={[0.3, 0.022, 0.14]} />
          <meshStandardMaterial color="#cbbb9e" roughness={0.7} />
        </mesh>
        {[-0.28, 0.28].map((x) => (
          <mesh key={x} position={[x, 0.22, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.085, 0.085, 0.09, 12]} />
            <meshStandardMaterial color="#1e2023" roughness={0.55} />
          </mesh>
        ))}
        {[-0.36, 0.36].map((x) => (
          <mesh key={x} position={[x, 0.22, 0]} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.05, 0.05, 0.08, 12]} />
            <meshStandardMaterial color="#f2f2ee" roughness={0.4} />
          </mesh>
        ))}
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
