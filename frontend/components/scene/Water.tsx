// Shared rippling water surface for the pool and spa; wave amplitude is driven
// by normalized live flow and eases between each polled value.
import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const vertexShader = `
  uniform float uTime; uniform float uFlow;
  varying vec2 vUv; varying float vWave;
  void main() {
    vUv = uv;
    vec3 p = position;
    float amp = 0.015 + 0.045 * uFlow;
    float w = sin(p.x * 3.1 + uTime * 1.7) * 0.6
            + sin((p.x + p.y) * 2.3 - uTime * 1.1) * 0.4;
    p.z += w * amp;
    vWave = w;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = `
  precision mediump float;
  uniform float uFlow;
  varying vec2 vUv; varying float vWave;
  void main() {
    vec3 deep = vec3(0.10, 0.42, 0.60);
    vec3 shallow = vec3(0.35, 0.75, 0.90);
    vec3 c = mix(deep, shallow, clamp(vUv.y * 0.5 + vWave * 0.5 + 0.25, 0.0, 1.0));
    float sparkle = smoothstep(0.85, 1.0, vWave) * (0.2 + 0.5 * uFlow);
    gl_FragColor = vec4(c + sparkle, 0.92);
  }
`;

export function Water({
  shape,
  size,
  flow,
  position,
}: {
  shape: "rect" | "round";
  size: [number, number];
  flow: number;
  position: [number, number, number];
}) {
  const material = React.useRef<THREE.ShaderMaterial>(null);
  const uniforms = React.useMemo(
    () => ({
      uTime: { value: 0 },
      uFlow: { value: flow },
    }),
    [],
  );

  useFrame((_, dt) => {
    if (!material.current) return;
    material.current.uniforms.uTime.value += dt;
    material.current.uniforms.uFlow.value = THREE.MathUtils.lerp(
      material.current.uniforms.uFlow.value,
      flow,
      Math.min(dt * 2, 1),
    );
  });

  return (
    <mesh position={position} rotation={[-Math.PI / 2, 0, 0]}>
      {shape === "rect" ? (
        <planeGeometry args={[size[0], size[1], 48, 32]} />
      ) : (
        <circleGeometry args={[size[0], 48]} />
      )}
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
      />
    </mesh>
  );
}
