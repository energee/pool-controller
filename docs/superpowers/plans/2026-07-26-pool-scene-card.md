# Pool Scene Card Implementation Plan

> **For agentic workers:** Work through tasks strictly in order. Check off (`- [x]`) each step in this file as you complete it. Commit after every task with the given message. Run every validation command shown and do not proceed past a failure.

**Goal:** A live 3D visualization card at the top of the dashboard: an isometric scene of the pool system (pool, spa, pump, filter, heater, IntelliChlor, pipes) where water flow, ripples, and equipment effects animate from the live `/state` snapshot.

**Architecture:** A pure function `deriveSceneState()` maps the polled `State` to a small `SceneState` (the only unit-tested part). A full-width `PoolSceneCard` renders a react-three-fiber `<Canvas>`; scene components read `SceneState` via props and drive animation in `useFrame`. No new polling — the Dashboard already fetches `/state` every 3s and passes it down.

**Tech Stack:** React 19, TypeScript (strict), Bun (bundler + test runner), Tailwind v4 tokens, three + @react-three/fiber v9 + @react-three/drei v10 (already installed — see Task 0).

## Global Constraints

- Executor: **codex exec** running in the git worktree `/Users/tedslesinski/Repos/pool/.claude/worktrees/pool-viz`, branch `worktree-pool-viz`. Never `cd` elsewhere, never push, never use `git stash`.
- After every task: `bun run typecheck` (tsc --noEmit) must be clean and `bun test` must pass (81 existing tests + new ones).
- No dependencies beyond what Task 0 installed: `three`, `@react-three/fiber`, `@react-three/drei`, `@types/three`. **No network access is available** — do not run `bun add`/`bun install`.
- Every new file starts with a short module-level comment explaining its purpose (repo convention — see any existing file).
- Follow existing component conventions: PascalCase component files, `DashCard` wrapper from `frontend/components/primitives.tsx`, Tailwind theme tokens (`bg-popover`, `text-muted-foreground`, …) for any DOM/Html elements so light/dark themes both work.
- The scene is **read-only**: no controls, no clicks that mutate state. Hover tooltips only.
- Canvas is transparent (`alpha: true`, no scene background) so the card surface shows through; use mid-tone colors that read on both light and dark card surfaces.
- Do not modify anything under `server/` or `easytouch/` except the committed build output produced by `bun run build` in the final task.

## Design Summary (approved)

- Fixed isometric orthographic camera, no orbit controls. Low-poly stylized look.
- Bodies of water: large rounded pool basin + small raised round spa, each with a shader-rippled water plane. Ripple amplitude scales with flow; near-glassy when off.
- Equipment pad along the back: pump (spinning impeller), filter tank, heater, IntelliChlor cell, connected by schematic pipes: {pool, spa} suction → pump → filter → heater → chlorinator → return → {pool, spa}.
- Flow: animated dashed lines along the pipes, speed ∝ flow; only the active branch (pool vs spa) flows.
- `heater_on`: heater glows warm + faint steam. Chlorinator output > 0 (with flow): cell glows teal + sparkle on the return. Spa circuit on: bubbles in the spa.
- Hover equipment → tooltip with live numbers (RPM/GPM/W, salt ppm, output %). Water temps float over each basin.
- Disconnected or stale (age > 60s): animation freezes, scene desaturates via CSS overlay, "stale" chip.

## File Map

| File | Responsibility |
|---|---|
| `frontend/lib/scene.ts` | `SceneState` + `deriveSceneState()` — pure mapping, no three imports |
| `frontend/lib/scene.test.ts` | bun tests for the mapping |
| `frontend/components/scene/PoolSceneCard.tsx` | DashCard shell, WebGL guard, `<Canvas>`, stale overlay |
| `frontend/components/scene/PoolScene.tsx` | scene graph: lights, deck, composes Basins/Equipment/Pipes |
| `frontend/components/scene/Water.tsx` | reusable rippling water surface (ShaderMaterial) |
| `frontend/components/scene/Equipment.tsx` | pump/filter/heater/chlorinator meshes, effects, hover tooltips |
| `frontend/components/scene/Pipes.tsx` | pipe polylines + animated dashed flow lines |
| `frontend/components/Dashboard.tsx` | mount the card (modify) |

---

### Task 0: Dependencies — ALREADY DONE by the orchestrating session

`three`, `@react-three/fiber`, `@react-three/drei`, `@types/three` are installed and committed. Verify only:

- [x] **Step 1: Verify deps resolve**

Run: `bun run typecheck`
Expected: clean (exit 0). If `three` or r3f types are missing, STOP and report — do not install anything.

---

### Task 1: `deriveSceneState()` — pure state mapping (TDD)

**Files:**
- Create: `frontend/lib/scene.ts`
- Test: `frontend/lib/scene.test.ts`

**Interfaces:**
- Consumes: `State` from `frontend/types.ts`, `CIRCUIT_NUMBERS` from `frontend/lib/constants.ts` (pool = 6, spa = 1).
- Produces (later tasks rely on these exact names/types):

```ts
export interface SceneState {
  poolOn: boolean;      // circuit 6 in status.circuits_on
  spaOn: boolean;       // circuit 1 in status.circuits_on
  flow: number;         // 0..1 normalized flow driving all animation speeds
  rpm: number | null;   // from the reporting pump, for tooltips
  gpm: number | null;
  watts: number | null;
  heaterOn: boolean;
  chlorPct: number;     // 0..100, chlorinator.output_percent ?? 0
  saltPpm: number | null;
  poolTemp: number | null;
  spaTemp: number | null;
  stale: boolean;       // !connected || age > 60
}
export function deriveSceneState(state: State | null, connected: boolean): SceneState;
```

**Mapping rules (implement exactly):**
- `poolOn`/`spaOn` from `state.status?.circuits_on` (default `[]`).
- Pump: pick the first entry of `state.pumps` (object insertion order) whose `rpm` or `watts` is > 0; else the first entry; else null. Expose its `rpm`/`gpm`/`watts` (each `?? null`).
- `flow`: if a pump entry exists → `gpm != null ? min(gpm / 100, 1) : rpm != null ? min(rpm / 3450, 1) : 0`. If **no pump data at all** (missing/empty `pumps`) → fall back to circuits: `poolOn || spaOn ? 0.5 : 0`.
- `heaterOn = state.status?.heater_on === true`.
- `chlorPct = state.chlorinator?.output_percent ?? 0`; `saltPpm = state.chlorinator?.salt_ppm ?? null`.
- `poolTemp`/`spaTemp` from `state.status` (`?? null`).
- `stale = !connected || (state?.age != null && state.age > 60)`. Null/absent age with connected=true is NOT stale.
- `state === null` → all-off: flows 0, everything null/false, `stale: true`.

- [x] **Step 1: Write the failing tests** — create `frontend/lib/scene.test.ts`:

```ts
// Tests for deriveSceneState: the pure State -> SceneState mapping that drives
// the 3D pool scene. Covers pump-derived flow, circuit fallback, and staleness.
import { describe, expect, test } from "bun:test";

import { deriveSceneState } from "./scene";
import type { State } from "../types";

const base: State = {
  age: 2,
  status: { circuits_on: [6], pool_temp: 84, spa_temp: 96, heater_on: false },
  pumps: { "1": { pump: 1, watts: 1350, rpm: 2400, gpm: 65 } },
  chlorinator: { salt_ppm: 3200, output_percent: 40 },
};

describe("deriveSceneState", () => {
  test("null state is inert and stale", () => {
    const s = deriveSceneState(null, false);
    expect(s.flow).toBe(0);
    expect(s.poolOn).toBe(false);
    expect(s.stale).toBe(true);
    expect(s.poolTemp).toBeNull();
  });

  test("pool running with pump gpm", () => {
    const s = deriveSceneState(base, true);
    expect(s.poolOn).toBe(true);
    expect(s.spaOn).toBe(false);
    expect(s.flow).toBeCloseTo(0.65);
    expect(s.rpm).toBe(2400);
    expect(s.chlorPct).toBe(40);
    expect(s.saltPpm).toBe(3200);
    expect(s.stale).toBe(false);
  });

  test("rpm fallback when gpm missing", () => {
    const s = deriveSceneState(
      { ...base, pumps: { "1": { pump: 1, rpm: 1725, watts: 800 } } },
      true,
    );
    expect(s.flow).toBeCloseTo(0.5);
    expect(s.gpm).toBeNull();
  });

  test("circuit fallback when no pump data", () => {
    const s = deriveSceneState({ ...base, pumps: {} }, true);
    expect(s.flow).toBe(0.5);
    const off = deriveSceneState(
      { ...base, pumps: {}, status: { ...base.status, circuits_on: [] } },
      true,
    );
    expect(off.flow).toBe(0);
  });

  test("idle pump means no flow even with circuit on", () => {
    const s = deriveSceneState(
      { ...base, pumps: { "1": { pump: 1, rpm: 0, watts: 0 } } },
      true,
    );
    expect(s.flow).toBe(0);
  });

  test("stale on old age or disconnect", () => {
    expect(deriveSceneState({ ...base, age: 120 }, true).stale).toBe(true);
    expect(deriveSceneState(base, false).stale).toBe(true);
    expect(deriveSceneState({ ...base, age: null }, true).stale).toBe(false);
  });
});
```

- [x] **Step 2: Run to verify failure**

Run: `bun test frontend/lib/scene.test.ts`
Expected: FAIL — cannot resolve `./scene`.

- [x] **Step 3: Implement `frontend/lib/scene.ts`** per the mapping rules above (module comment: what SceneState is and that it is the only tested seam of the 3D card). No three/react imports here.

- [x] **Step 4: Verify green**

Run: `bun test frontend/lib/scene.test.ts` then `bun test` and `bun run typecheck`
Expected: new tests PASS, full suite passes, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add frontend/lib/scene.ts frontend/lib/scene.test.ts
git commit -m "feat(scene): deriveSceneState maps /state to scene inputs"
```

---

### Task 2: Card shell, Canvas, Dashboard wiring

**Files:**
- Create: `frontend/components/scene/PoolSceneCard.tsx`
- Create: `frontend/components/scene/PoolScene.tsx` (placeholder deck + lights this task)
- Modify: `frontend/components/Dashboard.tsx`

**Interfaces:**
- Consumes: `deriveSceneState`, `SceneState` from `frontend/lib/scene.ts`; `DashCard` from `../primitives`; `Dashboard`'s existing `state`/`connected`.
- Produces: `export function PoolSceneCard({ state, connected }: { state: State | null; connected: boolean })` and `export function PoolScene({ scene }: { scene: SceneState })`.

- [x] **Step 1: `PoolSceneCard.tsx`**

```tsx
// Full-width dashboard card hosting the live 3D system scene. Owns the WebGL
// guard, the r3f Canvas (fixed isometric ortho camera), and the stale overlay;
// all live-state interpretation happens in deriveSceneState.
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
  if (!webgl) return null; // hide like other data-absent cards
  const scene = deriveSceneState(state, connected);
  return (
    <DashCard title="System" className="col-span-full">
      <div className="relative h-[380px]">
        <Canvas
          orthographic
          camera={{ position: [10, 10, 10], zoom: 46, near: 0.1, far: 100 }}
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
```

- [x] **Step 2: `PoolScene.tsx`** — lights + deck only for now:

```tsx
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
```

(`scene` is unused this task — prefix-destructure or reference it in a comment-free way that keeps tsc happy, e.g. accept the prop and ignore via `void scene;` is NOT needed: unused function params are fine under this tsconfig; verify with typecheck.)

- [x] **Step 3: Mount in `Dashboard.tsx`** — import `PoolSceneCard`, render it as the first child of `<main className={GRID}>`, passing `state={state}` and `connected={connected}` (both already in scope from `useDashboard()`). Update the card-order comment at the top of the file to mention the scene card.

- [x] **Step 4: Validate**

Run: `bun run typecheck && bun test`
Expected: clean / all pass.

- [x] **Step 5: Commit**

```bash
git add frontend/components/scene frontend/components/Dashboard.tsx
git commit -m "feat(scene): PoolSceneCard shell with Canvas and stale overlay"
```

---

### Task 3: Water surfaces and basins

**Files:**
- Create: `frontend/components/scene/Water.tsx`
- Modify: `frontend/components/scene/PoolScene.tsx`

**Interfaces:**
- Produces: `export function Water({ shape, size, flow, position }: { shape: "rect" | "round"; size: [number, number]; flow: number; position: [number, number, number] })` — for `round`, `size[0]` is the radius and `size[1]` ignored.

- [ ] **Step 1: `Water.tsx`** — a plane (rect: `planeGeometry` 48×32 segments; round: `circleGeometry` radius, 48 segments) rotated `-Math.PI / 2` about X, with this ShaderMaterial (uniforms `uTime`, `uFlow`; update both in `useFrame`, lerping `uFlow` toward the `flow` prop at ~2/s so poll jumps ease in):

```glsl
// vertex
uniform float uTime; uniform float uFlow;
varying vec2 vUv; varying float vWave;
void main() {
  vUv = uv;
  vec3 p = position;
  float amp = 0.015 + 0.045 * uFlow;
  float w = sin(p.x * 3.1 + uTime * 1.7) * 0.6
          + sin((p.x + p.y) * 2.3 - uTime * 1.1) * 0.4;
  p.z += w * amp; // plane is X-rotated, local z is world up
  vWave = w;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
// fragment
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
```

`transparent: true`. Module comment: shared rippling water surface; amplitude driven by normalized flow.

- [ ] **Step 2: Basins in `PoolScene.tsx`** — starting blueprint (adjust ±10% for composition, keep the layout):
  - Pool basin: box `[6.6, 0.9, 3.8]` at `[-2.6, 0.45, 1.1]`, color `#155e86`; `Water shape="rect" size={[6.2, 3.4]}` at `[-2.6, 0.82, 1.1]` with `flow={scene.poolOn ? scene.flow : 0}`.
  - Spa: cylinder radius 1.15, height 1.1 at `[2.6, 0.55, 2.0]`, color `#155e86`; `Water shape="round" size={[1.0, 0]}` at `[2.6, 1.02, 2.0]` with `flow={scene.spaOn ? scene.flow : 0}`.

- [ ] **Step 3: Validate + visual sanity** — `bun run typecheck && bun test`. Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/scene
git commit -m "feat(scene): pool and spa basins with shader-rippled water"
```

---

### Task 4: Equipment, effects, hover tooltips

**Files:**
- Create: `frontend/components/scene/Equipment.tsx`
- Modify: `frontend/components/scene/PoolScene.tsx`

**Interfaces:**
- Produces: `export function Equipment({ scene }: { scene: SceneState })` rendering all four units on the pad at z = −2.3.

- [ ] **Step 1: Build the four units** (positions on the pad, y = base height above deck):
  - **Pump** at `[0.6, 0, -2.3]`: cylinder body r=0.35 h=0.5 + a flat 4-blade impeller cap (4 thin boxes in a group) on top; in `useFrame` rotate the cap `y += dt * (2 + 10 * flow)` only when `scene.flow > 0`.
  - **Filter** at `[2.0, 0, -2.3]`: capsule/cylinder tank r=0.42 h=0.9, neutral `#aab4be`.
  - **Heater** at `[3.5, 0, -2.3]`: box `[1.0, 0.7, 0.8]`; `meshStandardMaterial` with `emissive="#ff7a45"`, `emissiveIntensity` lerped toward `scene.heaterOn ? 0.9 : 0`; when `heaterOn`, add drei `<Sparkles count={12} size={2} scale={[0.8, 1.2, 0.8]} color="#e8edf2" speed={0.4}>` above it as steam.
  - **Chlorinator** at `[4.8, 0, -2.3]`: small horizontal capsule r=0.18 length 0.7 inline with the return pipe; emissive `#2dd4bf` with intensity lerped toward `scene.chlorPct > 0 && scene.flow > 0 ? 0.2 + 0.7 * (scene.chlorPct / 100) : 0`.
  - Labels: drei `<Html center distanceFactor={14}>` under each unit with a `text-[10px] text-muted-foreground` div: PUMP / FILTER / HEATER / CHLORINATOR.
- [ ] **Step 2: Hover tooltips** — `onPointerOver`/`onPointerOut` per unit sets a `hovered` string state; drei `useCursor(hovered !== null)`; when hovered, render an Html tooltip (`bg-popover border rounded-md px-2.5 py-1.5 text-xs shadow-md`) above that unit:
  - Pump: `{rpm} RPM · {gpm} GPM · {watts} W` (skip null fields; "no data" if all null)
  - Heater: `Heater {heaterOn ? "ON" : "off"}`
  - Chlorinator: `{chlorPct}% output · {saltPpm} ppm salt` (salt line only when non-null)
  - Filter: `Filter` (static)
- [ ] **Step 3: Spa bubbles + floating temps** in `PoolScene.tsx`:
  - When `scene.spaOn && scene.flow > 0`: `<Sparkles count={30} size={2.5} color="#cfeefb" speed={0.6 + scene.flow} scale={[1.6, 0.9, 1.6]} position={[2.6, 1.15, 2.0]} />`.
  - Over each basin, when its temp is non-null: `<Html center>` with `text-sm font-medium text-foreground/85` showing `{Math.round(temp)}°`, positioned above pool `[-2.6, 1.6, 1.1]` and spa `[2.6, 1.9, 2.0]`.
- [ ] **Step 4: Validate** — `bun run typecheck && bun test`. Expected: clean.
- [ ] **Step 5: Commit**

```bash
git add frontend/components/scene
git commit -m "feat(scene): equipment pad with live effects and hover tooltips"
```

---

### Task 5: Pipes and animated flow

**Files:**
- Create: `frontend/components/scene/Pipes.tsx`
- Modify: `frontend/components/scene/PoolScene.tsx`

**Interfaces:**
- Produces: `export function Pipes({ scene }: { scene: SceneState })`.

- [ ] **Step 1: Pipe rendering approach** — each pipe run is a polyline drawn twice with drei `<Line>`: a solid underlay (`lineWidth 6`, color `#77808c`, no dash) and a flow overlay (`lineWidth 2.5`, color `#4fc3f7`, `dashed dashSize={0.18} gapSize={0.16}`). Animate flow by decrementing the overlay's `LineMaterial.dashOffset` in `useFrame` by `dt * 1.5 * scene.flow` (ref the material). Overlay `visible` only when its branch is active and `scene.flow > 0`.
- [ ] **Step 2: Pipe runs** (y = 0.12 everywhere; waypoints are a starting blueprint):
  - `suctionPool` (active when `poolOn`): `[-2.6, 0.12, -0.8] → [-2.6, 0.12, -1.6] → [0.2, 0.12, -1.6] → [0.6, 0.12, -2.0]`
  - `suctionSpa` (active when `spaOn`): `[2.6, 0.12, 0.85] → [2.6, 0.12, -1.2] → [1.0, 0.12, -1.2] → [0.6, 0.12, -2.0]`
  - `mainRun` (active when `poolOn || spaOn`): pump → filter → heater → chlorinator: `[0.6, 0.12, -2.3] → [4.8, 0.12, -2.3]` routed through each unit's position.
  - `returnPool` (active when `poolOn`): `[4.8, 0.12, -2.0] → [5.3, 0.12, -1.4] → [-4.5, 0.12, -1.4]... → [-4.5, 0.12, -0.8]` — bring it back along the front of the pad and into the pool's west edge.
  - `returnSpa` (active when `spaOn`): `[4.8, 0.12, -2.0] → [3.6, 0.12, -0.4] → [2.6, 0.12, 0.85]`
  - Small valve tees: dark cylinders (r=0.12, h=0.2) at the two junction points where suction lines merge and returns split.
  - Chlorinator sparkle: when `chlorPct > 0 && flow > 0`, `<Sparkles count={10} size={1.5} color="#5eead4">` along the first segment of the active return.
- [ ] **Step 3: Flow direction check** — dashOffset must move dashes *from* suction *toward* the returns (reverse a polyline's point order if its dashes march backwards; verify visually in Task 6).
- [ ] **Step 4: Validate** — `bun run typecheck && bun test`. Expected: clean.
- [ ] **Step 5: Commit**

```bash
git add frontend/components/scene
git commit -m "feat(scene): schematic pipes with state-driven dashed flow"
```

---

### Task 6: Build, docs, final validation

**Files:**
- Modify: `README.md` (dashboard feature list — one bullet for the live 3D scene card)
- Modify: `easytouch/static/*` (regenerated by the build)

- [ ] **Step 1: Full validation**

Run: `bun run typecheck && bun test`
Expected: clean; all tests (81 + new) pass.

- [ ] **Step 2: Production build**

Run: `bun run build`
Expected: exits 0; `easytouch/static/app.js` and `style.css` regenerate. (Bundle grows ~1 MB from three — expected, note it in the commit body.)

- [ ] **Step 3: README** — add a bullet under the dashboard/frontend feature description: live 3D system scene (pool/spa water, pump/filter/heater/chlorinator, animated flow) driven by the `/state` poll.

- [ ] **Step 4: Commit**

```bash
git add README.md easytouch/static package.json
git commit -m "feat(scene): build static bundle and document the 3D system card"
```

---

## Self-Review Notes

- Spec coverage: placement/data-flow → Tasks 1–2; scene bodies/water → Task 3; equipment + effects + tooltips + temps → Task 4; pipes/flow/valves/chlor sparkle → Task 5; stale overlay + frameloop pause → Task 2; WebGL guard → Task 2; perf (dpr cap, no shadows, ortho) → Tasks 2–5; docs/build → Task 6.
- Deliberate cut (ponytail): no per-component 3D unit tests — `deriveSceneState` is the tested seam; the scene is verified visually by the orchestrator against the mock bus after codex finishes.
- Type consistency: `SceneState` field names in Tasks 3–5 match the Task 1 interface verbatim.
