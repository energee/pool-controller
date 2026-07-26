// Full-width dashboard card hosting the live 3D system scene. Owns the WebGL
// guard, the r3f Canvas (perspective camera seeded by PoolScene's CameraRig,
// then user-orbitable via drag/wheel), and the stale overlay; all live-state
// interpretation happens in deriveSceneState.
import * as React from "react";
import { Canvas } from "@react-three/fiber";

import { deriveSceneState } from "../../lib/scene";
import type { State } from "../../types";
import { DashCard } from "../primitives";
import { PoolScene } from "./PoolScene";

function webglAvailable(): boolean {
  try {
    return !!document.createElement("canvas").getContext("webgl2");
  } catch {
    return false;
  }
}

export function PoolSceneCard({
  state,
  connected,
}: {
  state: State | null;
  connected: boolean;
}) {
  const [webgl] = React.useState(webglAvailable);
  if (!webgl) return null;
  const scene = deriveSceneState(state, connected);
  return (
    <DashCard title="System" className="col-span-full">
      <div className="relative h-[380px]">
        {/* perspective camera for the photo-like view; CameraRig aims it */}
        <Canvas
          camera={{ fov: 34, near: 0.1, far: 100 }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: true }}
          frameloop={scene.stale ? "demand" : "always"}
        >
          <PoolScene scene={scene} />
        </Canvas>
        {scene.stale ? (
          <>
            <div className="pointer-events-none absolute inset-0 backdrop-saturate-[.25]" />
            <span className="absolute right-2 top-2 rounded-md bg-popover px-2 py-0.5 text-[11px] text-muted-foreground">
              stale
            </span>
          </>
        ) : null}
      </div>
    </DashCard>
  );
}
