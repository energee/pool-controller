# Plan — equipment-coverage: close the feature gap vs other Pentair projects

**Branch:** `feat/equipment-coverage` · **Base:** `54418ca` (checkpoint of prior
uncommitted work, 87 tests green) · **Status:** PHASE 1 (plan) — awaiting approval.

Goal: add the 7 capabilities the gap analysis found missing vs
`tagyoureit/nodejs-poolController`, on the existing A5 + IntelliChlor architecture.
No new runtime deps (stdlib + pyserial only).

## Conventions (apply to every task)

- **TDD.** Write a failing test against a real or reference frame *first*, then
  implement. Mirror the existing test style (`tests/test_*.py`, synthetic/captured
  hex frames, `stub_serial.StubSerial`).
- **Validate decoders against bytes**, not assumptions. Where a protocol constant
  is not yet confirmed for *this* hardware it is marked **(confirm)** below — the
  build step must verify it against the reference spec (`michaelusner` PACKET_SPEC,
  `nodejs-poolController` field maps) and/or live capture before asserting it.
- **Live-verify** writes against `socket://192.168.4.70:4000` where reachable, and
  **restore every changed value** (known baselines: pool setpoint 84).
- **Validation command:** `./.venv/bin/python -m pytest -q` after each task.
- **Docs in the same commit** (README "Decoded fields" + endpoint tables; module
  docstrings; HANDOFF note). One commit per feature.

## Risk tiers (read before approving)

- **Low (decode-only / reversible writes):** set-clock, IntelliChem decode,
  version decode, valve/cover decode. High confidence.
- **Medium:** lights (frame shape known, **command-code table needs confirm**),
  chlorinator set-output (**frame known; whether a *present* EasyTouch controller
  honors a direct injection vs overriding it is unverified**).
- **High:** pump speed control. Directly commanding a pump (addr 0x60+) while the
  EasyTouch controller is also driving it causes contention and needs a keep-alive;
  reliable speed-setting in a controller-present system may instead require setting
  the pump *circuit* config via the controller. Treated as experimental + may be
  split into read-completeness now / speed-set after live investigation.

---

## Tasks

### 1. Chlorinator set-output  *(medium · do first — frame already proven)*
- **Files:** `easytouch/intellichlor.py` (+ `build_set_output`), `state.py`
  (`set_chlorinator_output`), `api.py` (`POST /chlorinator`, `GET
  /chlorinator/output/<pct>`), `web.py` (output control on the salt card),
  `cli.py` (`set-chlor`), `__init__.py`, `tests/test_intellichlor.py`.
- **Protocol:** controller→chlorinator `10 02 50 11 <pct> <chk> 10 03` (dest 0x50,
  cmd 0x11). Reuse `ic_checksum`. Proven capture: `10 02 50 11 1e 91 10 03` = 30%.
- **Acceptance:** `build_set_output(30)` byte-equals the captured frame; pct clamps
  0–100; round-trips through `ChlorinatorReader`. Live: set output, read back.
- **Risk/confirm:** whether the EasyTouch controller overrides a direct injection.
  If so, document and investigate an A5 SWG-setpoint path. Deps: none.

### 2. Set controller clock — CFI 133  *(low)*
- **Files:** `constants.py` (`Action.SET_DATETIME = 133`), `controller.py`
  (`build_set_datetime`, `set_datetime`), `state.py`, `api.py` (`POST /datetime`),
  `cli.py` (`set-clock`), `__init__.py`, `tests/test_decode.py` or new
  `tests/test_datetime.py`.
- **Protocol:** action 133 payload mirrors CFI 5 decode order:
  `[hour, minute, dow, day, month, year, auto_dst]` **(confirm** byte order &
  whether auto_dst trails — cross-check decode_datetime + PACKET_SPEC**)**.
- **Acceptance:** build→`decode_datetime` round-trips a known time; CLI sets, reads
  back, restores. Deps: none.

### 3. Version decode — CFI 252  *(low)*
- **Files:** `constants.py`, `decode.py` (`SoftwareVersion` + `decode_version`,
  add to `decode()` dispatch), `controller.py` (`get_version`), `state.py` ingest,
  `api.py` (`/version` already-free via `/state`), `__init__.py`, `tests/test_decode.py`.
- **Protocol:** CFI 252 carries firmware version bytes **(confirm** exact layout —
  typically major/minor + name**)**.
- **Acceptance:** decode a reference frame → version string. Deps: none.

### 4. Valve / cover decode — CFI 29 + status bits  *(low)*
- **Files:** `decode.py` (`ValveStatus` + `decode_valve`; cover field on
  `ControllerStatus` **(confirm** which CFI 2 byte/bit**)**), dispatch, `state.py`,
  `web.py` (raw→typed card), `tests/test_decode.py`.
- **Acceptance:** decode reference CFI 29 frame → valve assignments; cover bit
  decodes from a crafted status. Deps: none.

### 5. IntelliChem decode — CFI 18  *(low–medium · decode only)*
- **Files:** `constants.py`, `decode.py` (`IntelliChem` + `decode_intellichem`,
  dispatch), `state.py` ingest, `api.py` (`/intellichem`), `web.py` card,
  `__init__.py`, `tests/test_intellichem.py` (new).
- **Protocol (from nodejs-poolController field map — confirm offsets):** pH &
  ORP readings + setpoints (16-bit, pH/100), tank levels, water-balance/LSI,
  CYA/CH/ALK/salt, alarm/warning flags.
- **Acceptance:** decode a reference CFI 18 payload → pH/ORP/setpoints/tanks.
  **Note:** if this system has no IntelliChem, this is tested against reference
  bytes only and surfaces live only when present (log that, don't fake it). Deps: none.

### 6. IntelliBrite light/color — CFI 96  *(medium)*
- **Files:** `constants.py` (`Action.SET_COLOR = 96` already named; add
  `LIGHT_COMMANDS` name↔code table **(confirm codes)**), `controller.py`
  (`build_set_light`, `set_light(circuit, command)`), `state.py`
  (`set_light`), `api.py` (`POST /light`, `GET /light/<circuit>/<command>`),
  `web.py` (light card: theme/color buttons), `cli.py` (`light`), `__init__.py`,
  `tests/test_light.py` (new).
- **Protocol:** action 96 with a light-command byte. Candidate table to **confirm**
  against reference/live (IntelliTouch convention): off/on, color sync/swim/set,
  party/romance/caribbean/american/sunset/royal, blue/green/red/white/magenta,
  hold/recall, save/recall. Exact numeric codes verified before asserting.
- **Acceptance:** `build_set_light` emits a checksum-valid action-96 frame with the
  mapped code; name resolver rejects unknown commands. Live: trigger a theme,
  observe change, restore. Deps: prefer real circuit names (task 7) for UX but not
  blocking.

### 7. Real circuit names — CFI 11 (+ CFI 10 custom)  *(medium)*
- **Files:** `constants.py` (built-in EasyTouch name table), `decode.py`
  (`decode_circuit_names`, `decode_custom_names`; name resolution), `controller.py`
  (`get_circuit_names` request/decode), `state.py` (cache names; expose via
  `circuit_names`), `api.py`/`web.py` (use real names; fall back to
  `DEFAULT_CIRCUITS`), `tests/test_names.py` (new).
- **Protocol:** CFI 11 = per-circuit function + name id; name id resolves against a
  built-in name list plus custom names (CFI 10) **(confirm** layout & name table**)**.
- **Acceptance:** decode a reference CFI 11 set → `{circuit: name}`; unknown ids
  fall back gracefully. Deps: none (other features keep working with defaults).

### 8. Pump speed control  *(HIGH risk — see tier note; may be staged)*
- **Files:** `constants.py` (pump actions: remote 0x04, write 0x01 **(confirm
  registers/sequence)**), `controller.py` (`pump_remote_control`,
  `set_pump_speed`, keep-alive helper), `state.py`, `api.py` (`POST /pump`),
  `cli.py` (`set-pump`), `tests/test_pump.py` (new).
- **Protocol:** address pump directly (0x60+): take remote control, write speed,
  refresh periodically or it reverts; **contends with the controller's own pump
  programs**. Confirm the exact write sequence against nodejs-poolController.
- **Acceptance:** frame builders emit the confirmed sequence (unit-tested). Live
  speed-set is **best-effort** and clearly labeled experimental; if the controller
  overrides it, document and recommend the controller-config path instead.
- **Proposed staging:** implement + unit-test the builders now; gate live
  speed-setting behind an explicit flag and a HANDOFF note until verified.

### 9. Cross-cutting wiring + docs  *(after each feature; not a separate pass)*
- `decode.decode()` dispatch, `state.BusMonitor._ingest`/refresh requests,
  `api` routes + `/` dashboard, `__init__` exports, README endpoint/field tables,
  HANDOFF "what's decoded vs raw" update — done **within each feature's commit**,
  not deferred (per repo docs rule).

---

## Ordering & parallelism

- **Sequential, low-risk first to bank wins:** 1 (chlor set) → 2 (clock) → 3
  (version) → 4 (valve/cover) → 5 (IntelliChem) → 6 (lights) → 7 (names) → 8 (pump).
- Tasks 2–7 are mutually independent at the protocol level; they're sequenced only
  to keep one green commit at a time and avoid churning shared files (`decode.py`,
  `state.py`, `api.py`, `web.py`) concurrently. No parallel subagents — the shared
  files would collide (the exact failure we just spent this session avoiding).

## Open questions for you (optional — sensible defaults chosen otherwise)

1. **Pump control depth:** ship builders + unit tests now and defer live
   speed-setting behind a flag (default), or attempt full live pump control now?
2. **Chlorinator override:** if the controller overrides direct set-output, do you
   want me to chase the A5 SWG-setpoint path this round, or document and stop there?
3. **No IntelliChem/lights hardware?** If a feature's equipment isn't on your
   system, I'll land it tested-against-reference-bytes and surfaced-when-present,
   rather than fabricate live confirmation. OK?

On approval I start at Task 1 (TDD), one commit per feature, reporting after each.
