// Rippling water surface for the pool and spa, styled after a real backyard
// pool: a rounded-rect (or round, radius = half size) sheet of turquoise with
// a depth gradient, a lighter waterline ring, and sun glints computed from the
// analytic wave normals. Wave amplitude/speed ease toward the live flow value;
// a small idle swell keeps the water alive even when the pump is off.
import * as React from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const vertexShader = `
  uniform float uTime; uniform float uFlow;
  varying vec2 vPos; varying vec3 vNormal;
  void main() {
    vPos = position.xy;
    float amp = 0.01 + 0.03 * uFlow;
    float x = position.x, y = position.y, t = uTime;
    float w = 0.50 * amp * sin(1.8 * x + 1.4 * y + t * 1.1)
            + 0.35 * amp * sin(2.6 * x - 1.9 * y - t * 1.7)
            + 0.15 * amp * sin(4.5 * x + 3.2 * y + t * 2.3);
    float dwdx = 0.50 * amp * 1.8 * cos(1.8 * x + 1.4 * y + t * 1.1)
               + 0.35 * amp * 2.6 * cos(2.6 * x - 1.9 * y - t * 1.7)
               + 0.15 * amp * 4.5 * cos(4.5 * x + 3.2 * y + t * 2.3);
    float dwdy = 0.50 * amp * 1.4 * cos(1.8 * x + 1.4 * y + t * 1.1)
               - 0.35 * amp * 1.9 * cos(2.6 * x - 1.9 * y - t * 1.7)
               + 0.15 * amp * 3.2 * cos(4.5 * x + 3.2 * y + t * 2.3);
    // plane is rotated -PI/2 about X, so local +z is world up
    vNormal = normalize(vec3(-dwdx, 1.0, dwdy));
    vec3 p = vec3(x, y, w);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// No precision pragma: three injects one, and an explicit mediump here would
// mismatch the vertex stage's highp uFlow and fail program validation.
const fragmentShader = `
  uniform float uFlow; uniform vec2 uHalf; uniform float uRadius;
  uniform vec3 uShallow; uniform vec3 uDeep;
  varying vec2 vPos; varying vec3 vNormal;
  void main() {
    // rounded-rect SDF clips the subdivided plane to the pool footprint
    vec2 q = abs(vPos) - (uHalf - vec2(uRadius));
    float d = length(max(q, 0.0)) - uRadius;
    if (d > 0.0) discard;
    // deeper toward -x (the far end), lighter near the waterline
    float along = clamp((vPos.x + uHalf.x) / (2.0 * uHalf.x), 0.0, 1.0);
    float edge = smoothstep(-0.45, 0.0, d);
    vec3 c = mix(uDeep, uShallow, 0.30 + 0.45 * along + 0.25 * edge);
    // sun glints off the wave normals (fixed sun + view half-vector)
    vec3 h = normalize(vec3(0.45, 1.1, 0.55));
    float spec = pow(max(dot(vNormal, h), 0.0), 90.0) * (0.35 + 0.65 * uFlow);
    gl_FragColor = vec4(c + spec, 0.96);
  }
`;

export function Water({
  size,
  radius,
  flow,
  position,
  shallow = "#8fdcec",
  deep = "#1f86b4",
}: {
  size: [number, number];
  radius: number; // corner radius; use half the size for a round surface
  flow: number;
  position: [number, number, number];
  shallow?: string;
  deep?: string;
}) {
  const material = React.useRef<THREE.ShaderMaterial>(null);
  const uniforms = React.useMemo(
    () => ({
      uTime: { value: 0 },
      uFlow: { value: flow },
      uHalf: { value: new THREE.Vector2(size[0] / 2, size[1] / 2) },
      uRadius: { value: radius },
      uShallow: { value: new THREE.Color(shallow) },
      uDeep: { value: new THREE.Color(deep) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- static per mount
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
      <planeGeometry args={[size[0], size[1], 96, 64]} />
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
